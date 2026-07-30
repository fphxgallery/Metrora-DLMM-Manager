import type { Logger } from "pino";
import type { DataApi } from "./meteora/datapi.js";
import type { MeteoraClient } from "./meteora/client.js";
import type { Store } from "./state.js";
import type { PnlSample, SampleLog } from "./history.js";

export interface SamplerDeps {
  store: Store;
  dataApi: DataApi;
  client: MeteoraClient;
  samples: SampleLog;
  log: Logger;
  intervalMs: number;
}

/**
 * Writes down what each managed position is worth, on a timer.
 *
 * This exists because the Data API has no historical endpoint — it answers "what
 * is this position worth now" and nothing else. A PnL chart is therefore only
 * possible from samples we take ourselves, and a window that was never sampled
 * can never be filled in afterwards.
 *
 * Driven from the engine tick rather than its own interval, so it inherits the
 * engine's single-flight behaviour and cannot pile up requests behind a slow RPC.
 * The tick runs far more often than the sample interval, so the cadence is
 * enforced here by looking at how long ago the last sample was written.
 */
export class Sampler {
  private lastTs = 0;
  /** Guards against a slow Data API letting a second sample start behind the first. */
  private inFlight = false;

  constructor(private readonly deps: SamplerDeps) {}

  /** Cheap to call every tick; does nothing until the interval has elapsed. */
  async maybeSample(now = Date.now()): Promise<void> {
    if (this.inFlight) return;
    if (this.lastTs === 0) {
      // Seed from the log so a restart does not sample immediately and then again
      // a quarter-hour later, bunching two readings together in the history.
      const rows = this.deps.samples.read(now - this.deps.intervalMs);
      this.lastTs = rows.length > 0 ? rows[rows.length - 1].ts : 0;
    }
    if (now - this.lastTs < this.deps.intervalMs) return;
    this.inFlight = true;
    try {
      await this.sample(now);
    } catch (e) {
      // A failed sample is a gap in a chart, never a reason to disturb the engine.
      this.deps.log.debug({ err: e instanceof Error ? e.message : String(e) }, "pnl sample failed");
    } finally {
      this.inFlight = false;
    }
  }

  private async sample(now: number): Promise<void> {
    const { store, dataApi, client, samples, log } = this.deps;
    const positions = store.positions();
    if (positions.length === 0) return;
    const wallet = client.wallet()?.publicKey.toBase58();
    if (!wallet) return;

    const out: PnlSample[] = [];
    // One shared timestamp across every position in this pass, so aggregating the
    // portfolio-wide figure is a group-by rather than a guess at which readings
    // belong together.
    for (const pool of new Set(positions.map((p) => p.poolAddress))) {
      const pnls = await dataApi.positionPnlSafe(pool, wallet);
      for (const pnl of pnls) {
        if (!positions.some((p) => p.positionPk === pnl.positionAddress)) continue;
        out.push({
          ts: now,
          positionPk: pnl.positionAddress,
          feesUsd: Number(pnl.allTimeFees?.total?.usd ?? 0),
          pnlUsd: Number(pnl.pnlUsd ?? 0),
        });
      }
    }

    if (out.length === 0) {
      // Managed positions the indexer does not know about yet. Recording zeroes
      // would draw a fake collapse to $0 on the chart, so write nothing and leave
      // a gap instead.
      log.debug({ managed: positions.length }, "pnl sample found no indexed positions");
      return;
    }
    samples.append(out);
    this.lastTs = now;
    log.debug({ positions: out.length, ts: now }, "pnl sampled");
  }
}

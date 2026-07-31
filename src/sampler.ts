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

  /**
   * How long after a rebalance the indexer's numbers are not to be trusted.
   *
   * `pnlUsd` is taken verbatim from the Data API, which is eventually
   * consistent. Measured on the live position 2026-07-30: a path-B rebalance
   * completed at 18:12:24 having moved 45.22 USDC out of the position and back;
   * the sample ten seconds later read -$43.56 against +$1.32 before and +$1.72
   * after. The swing of $44.88 is the withdrawn leg almost exactly — the indexer
   * had seen the withdraw and not yet the deposit, and the sampler faithfully
   * wrote down a number that was briefly wrong.
   *
   * Two minutes is generous next to the ten seconds observed, and costs at most
   * one skipped reading out of a 15-minute cadence.
   */
  private static readonly SETTLE_MS = 120_000;

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

    /**
     * Skipped as a WHOLE PASS, not per position, and `lastTs` is deliberately
     * left alone so the next tick tries again.
     *
     * Dropping just the unsettled position would break the invariant the shared
     * timestamp exists for: `aggregateByTs` sums every position at a ts, so a
     * timestamp missing one of them reports a portfolio total short by that
     * position's whole value — trading a spike on one line for a spike on the
     * aggregate. A skipped pass is a gap, which the chart already handles.
     */
    const settling = this.recentlyRebalanced(now);
    if (settling) {
      this.deps.log.debug(
        { positionPk: settling, sinceMs: now - (this.deps.store.position(settling)?.lastRebalanceAt ?? 0) },
        "pnl sample skipped — a rebalance just landed and the indexer has not caught up",
      );
      return;
    }

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

  /**
   * The first managed position that rebalanced too recently to sample, or null.
   *
   * Keyed off `lastRebalanceAt`, which `recordRebalance` stamps on COMPLETION —
   * so the window runs from when the funds finished moving, which is exactly
   * when the indexer starts catching up.
   */
  private recentlyRebalanced(now: number): string | null {
    for (const p of this.deps.store.positions()) {
      const last = p.lastRebalanceAt;
      if (last !== undefined && now - last < Sampler.SETTLE_MS) return p.positionPk;
    }
    return null;
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

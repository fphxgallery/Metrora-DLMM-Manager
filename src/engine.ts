import { PublicKey } from "@solana/web3.js";
import type { ManagedPosition } from "./state.js";
import type { Notifier } from "./notify.js";
import type { AppContext } from "./types.js";
import { isAutoRebalance, isDryRun } from "./types.js";
import {
  executeRebalance,
  planRebalance,
  resumeJournal,
  type RebalanceDeps,
  type RebalancePlan,
} from "./meteora/rebalance.js";
import { rangeStatus } from "./meteora/pricing.js";
import { TriggerRunner } from "./triggers.js";

/** How stale a pending journal entry must be before a tick retries it. */
const RESUME_RETRY_MS = 120_000;

export type Decision =
  | { act: false; reason: string; detail?: Record<string, unknown> }
  | { act: true; plan: RebalancePlan; reason: string; detail?: Record<string, unknown> };

/**
 * Polls every managed position and re-centres the ones that need it.
 *
 * Three guards stand between a price move and a transaction, and each logs the
 * numbers it decided on: a cooldown, an out-of-range/near-edge test, and a cost
 * check that refuses to spend more on the rebalance than the position can
 * plausibly earn before the next one. Churn is the failure mode that quietly
 * eats an LP's returns, so every skip is auditable after the fact.
 */
export class Engine {
  private timer?: NodeJS.Timeout;
  private busy = new Set<string>();
  private ticking = false;
  // Edge-triggered, not level-triggered: alert once on the way down, once on
  // the way back up. Without this a wallet parked below the reserve would page
  // every poll interval forever.
  private lowBalanceAlerted = false;
  private readonly triggers: TriggerRunner;

  constructor(
    private readonly ctx: AppContext,
    private readonly deps: RebalanceDeps,
    private readonly notifier: Notifier,
  ) {
    // RebalanceDeps is a superset of ZapOutDeps, so a fired stop loss closes the
    // position through exactly the machinery the ZAP OUT button uses.
    this.triggers = new TriggerRunner(ctx, deps, (pk) => this.busy.has(pk));
  }

  start(): void {
    if (this.timer) return;
    const ms = this.ctx.cfg.pollIntervalMs;
    this.timer = setInterval(() => void this.tick(), ms);
    this.ctx.log.info({ pollIntervalMs: ms }, "engine started");
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.ctx.log.info("engine stopped");
  }

  running(): boolean {
    return Boolean(this.timer);
  }

  /** True while a rebalance is in flight for this position. */
  isBusy(positionPk: string): boolean {
    return this.busy.has(positionPk);
  }

  async tick(): Promise<void> {
    // One tick at a time. A slow RPC round must not let the next interval start
    // a second evaluation of the same position.
    if (this.ticking) return;
    this.ticking = true;
    try {
      // Independent of whether anything is managed — a wallet can be under
      // the reserve before it ever holds a position, and this is the kind of
      // thing worth a push rather than only showing up in LOGS.
      await this.checkSolBalance();

      // Unfinished rebalances are settled BEFORE any new one is considered.
      // resumeJournal used to run only at boot, so a swap that failed mid-run
      // left its withdrawn funds in the wallet until someone restarted the
      // service — and meanwhile the position, now missing that side, looked
      // wildly unbalanced and kept triggering fresh path-B rebalances that
      // bought back what was already sitting in the wallet. Skipped while
      // anything is in flight, and rate-limited so a permanently stuck entry
      // is retried periodically rather than every tick.
      if (this.busy.size === 0 && this.ctx.store.pendingJournal().length > 0) {
        try {
          await resumeJournal(this.deps, { minAgeMs: RESUME_RETRY_MS });
        } catch (e) {
          this.ctx.log.error(
            { err: e instanceof Error ? e.message : String(e) },
            "journal resume from tick failed",
          );
        }
      }

      // Copied, not the store's live array: a fired trigger removes a position
      // mid-tick, and iterating a list that is being spliced skips entries.
      const positions = [...this.ctx.store.positions()];
      if (positions.length === 0) return;

      // Writes a PnL reading when the sample interval has elapsed, and returns
      // immediately otherwise. Ahead of the rebalance loop so a sample still lands
      // on a tick where evaluating a position throws.
      await this.ctx.sampler.maybeSample();

      /**
       * Stop loss and take profit, BEFORE the rebalance loop.
       *
       * Order matters both ways round. A position about to be closed must not
       * first be rebalanced — that would pay bin-array rent on a range it is
       * about to leave. And a position the trigger closed must not then be
       * evaluated at all, which is what the returned set is for: `positions` was
       * snapshotted above and still holds the ones that just ceased to exist.
       */
      const fired = await this.triggers.run();

      for (const managed of positions) {
        if (fired.has(managed.positionPk)) continue;
        try {
          await this.evaluateAndAct(managed);
        } catch (e) {
          this.ctx.log.error(
            { positionPk: managed.positionPk, err: e instanceof Error ? e.message : String(e) },
            "position evaluation failed",
          );
        }
      }
      this.ctx.store.flush();
    } finally {
      this.ticking = false;
    }
  }

  private async checkSolBalance(): Promise<void> {
    const wallet = this.deps.client.wallet();
    if (!wallet) return;

    let bal: number;
    try {
      bal = await this.deps.client.solBalance();
    } catch {
      return; // a transient RPC hiccup isn't worth alerting over
    }

    const low = bal < this.ctx.cfg.minSolBalance;
    if (low && !this.lowBalanceAlerted) {
      this.lowBalanceAlerted = true;
      this.notifier.notify(
        `🪫 SOL balance ${bal.toFixed(4)} is below MIN_SOL_BALANCE ${this.ctx.cfg.minSolBalance} — ` +
          "rebalances and other actions will be refused until it's funded",
      );
    } else if (!low && this.lowBalanceAlerted) {
      this.lowBalanceAlerted = false;
      this.notifier.notify(`🔋 SOL balance recovered: ${bal.toFixed(4)}`);
    }
  }

  private async evaluateAndAct(managed: ManagedPosition): Promise<void> {
    // The tick is the only caller that should contribute a poll sample.
    const decision = await this.evaluate(managed, { recordPoll: true });
    if (!decision.act) {
      this.ctx.log.debug(
        { positionPk: managed.positionPk, reason: decision.reason, ...decision.detail },
        "no rebalance",
      );
      return;
    }

    this.busy.add(managed.positionPk);
    // Stamped before execution, so a rebalance that fails still starts a
    // cooldown. recordRebalance only fires on success.
    this.ctx.store.patchPosition(managed.positionPk, { lastAttemptAt: Date.now() });
    try {
      const outcome = await executeRebalance(this.deps, decision.plan);
      if (!outcome.dryRun) {
        const p = decision.plan;
        this.notifier.notify(
          `🔄 Rebalanced ${managed.pairName ?? p.poolAddress.slice(0, 8)} — ${decision.reason}\n` +
            `range ${p.currentRange[0]}…${p.currentRange[1]} → ${p.targetRange[0]}…${p.targetRange[1]}` +
            (p.swap ? `\nswapped ~$${p.swap.valueUsd.toFixed(2)} ${p.swap.fromSymbol}→${p.swap.toSymbol}` : "") +
            `\ncost ≈ $${p.estCostUsd.toFixed(2)}`,
        );
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.notifier.notify(`⚠️ Rebalance FAILED for ${managed.pairName ?? managed.positionPk.slice(0, 8)}: ${message}`);
    } finally {
      this.busy.delete(managed.positionPk);
    }
  }

  /**
   * The trigger evaluation. Exposed separately so the manual "rebalance now"
   * button and the METRICS view can show exactly what the engine would decide.
   *
   * `recordPoll` is opt-IN because this is otherwise a read-only question, and
   * `GET /plan` asks it on demand. With recording on by default, every look at
   * the plan silently added a sample to the time-in-range metric — inflating a
   * number whose whole purpose is to describe what the *engine* observed on its
   * own schedule. A new caller should have to ask for the side effect.
   */
  async evaluate(managed: ManagedPosition, opts: { recordPoll?: boolean } = {}): Promise<Decision> {
    const { cfg, client, store } = this.ctx;

    if (this.busy.has(managed.positionPk)) return { act: false, reason: "busy: rebalance already in flight" };

    // An unresolved entry means some of this position's funds are sitting in the
    // wallet. Rebalancing around them reads the resulting lopsidedness as real
    // and tries to correct it by buying back what we already hold — the loop
    // observed on 2026-07-29. Settle the entry first; the tick above does that.
    const unfinished = store.pendingJournal().find((j) => j.positionPk === managed.positionPk);
    if (unfinished) {
      return {
        act: false,
        reason: "unfinished rebalance pending — resolving that first",
        detail: { journalId: unfinished.id, phase: unfinished.phase },
      };
    }

    const pool = await client.getPool(managed.poolAddress);
    let positionData;
    try {
      positionData = (await pool.getPosition(new PublicKey(managed.positionPk))).positionData;
    } catch {
      // Closed elsewhere (manual exit, another tool). Stop polling a ghost.
      store.removePosition(managed.positionPk);
      return { act: false, reason: "position no longer exists on chain — unmanaged" };
    }

    const activeBinId = pool.lbPair.activeId;
    const status = rangeStatus(activeBinId, positionData.lowerBinId, positionData.upperBinId);
    if (opts.recordPoll) store.recordPoll(managed.positionPk, status.inRange);

    if (!isAutoRebalance(this.ctx)) return { act: false, reason: "auto-rebalance is off globally" };
    if (!managed.auto) return { act: false, reason: "auto-rebalance is off for this position" };

    const cooldownMin = managed.cooldownMin ?? cfg.cooldownMin;
    const lastActivity = Math.max(managed.lastRebalanceAt ?? 0, managed.lastAttemptAt ?? 0);
    const sinceMin = lastActivity > 0 ? (Date.now() - lastActivity) / 60_000 : Infinity;
    if (sinceMin < cooldownMin) {
      return { act: false, reason: "cooldown", detail: { sinceMin: round1(sinceMin), cooldownMin } };
    }

    const edgeBuffer = managed.edgeBufferBins ?? cfg.edgeBufferBins;
    const outOfRange = !status.inRange;
    const nearEdge = status.binsToEdge <= edgeBuffer;
    if (!outOfRange && !nearEdge) {
      return {
        act: false,
        reason: "in range",
        detail: { activeBinId, binsToEdge: status.binsToEdge, edgeBuffer },
      };
    }

    const plan = await planRebalance(this.deps, {
      positionPk: managed.positionPk,
      poolAddress: managed.poolAddress,
      strategyType: managed.strategyType,
    });

    const guard = await this.costGuard(managed, plan);
    if (!guard.ok) return { act: false, reason: "cost guard", detail: guard.detail };

    const reason = status.inRange
      ? `active bin ${status.binsToEdge} from the edge`
      : `out of range by ${-status.binsToEdge} bins`;
    return { act: true, plan, reason, detail: { activeBinId, path: plan.path } };
  }

  /**
   * Refuses a rebalance that cannot pay for itself.
   *
   * The benefit is not the fees already accrued — an out-of-range position earns
   * nothing, so those would be a terrible reason to act or not act. It is what
   * the position can earn once it is back in range, over one cooldown window,
   * estimated from the pool's own 24h fee/TVL ratio. Fees already sitting
   * unclaimed count too, because the rebalance collects them on the way through.
   */
  private async costGuard(
    managed: ManagedPosition,
    plan: RebalancePlan,
  ): Promise<{ ok: boolean; detail: Record<string, unknown> }> {
    const { cfg, dataApi } = this.ctx;
    const cooldownMin = managed.cooldownMin ?? cfg.cooldownMin;

    const meta = await dataApi.pool(managed.poolAddress).catch(() => null);
    const dailyFeeRate = (meta?.fee_tvl_ratio?.["24h"] ?? 0) / 100;
    const windowDays = Math.max(cooldownMin, 1) / 1440;
    const projectedFeesUsd = plan.valueUsd * dailyFeeRate * windowDays;
    const benefitUsd = projectedFeesUsd + plan.unclaimedFeesUsd;
    const requiredUsd = plan.estCostUsd * cfg.minFeeCoverRatio;

    const detail = {
      benefitUsd: round2(benefitUsd),
      projectedFeesUsd: round2(projectedFeesUsd),
      unclaimedFeesUsd: round2(plan.unclaimedFeesUsd),
      estCostUsd: round2(plan.estCostUsd),
      minFeeCoverRatio: cfg.minFeeCoverRatio,
      requiredUsd: round2(requiredUsd),
      cooldownMin,
      dailyFeeRatePct: round2(dailyFeeRate * 100),
      path: plan.path,
    };

    // No price data means no honest comparison. Refusing would strand positions
    // whenever the indexer is down, so allow it and say so.
    if (plan.valueUsd <= 0 || plan.estCostUsd <= 0) {
      return { ok: true, detail: { ...detail, note: "no USD pricing available — cost guard skipped" } };
    }
    return { ok: benefitUsd >= requiredUsd, detail };
  }

  status(): { running: boolean; dryRun: boolean; autoRebalance: boolean; busy: string[] } {
    return {
      running: this.running(),
      dryRun: isDryRun(this.ctx),
      autoRebalance: isAutoRebalance(this.ctx),
      busy: [...this.busy],
    };
  }
}

function round1(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : n;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

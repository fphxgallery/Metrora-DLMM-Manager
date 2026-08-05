import type { Config, TriggerAction } from "./config.js";
import type { ManagedPosition, PositionTriggers } from "./state.js";
import type { AppContext } from "./types.js";
import { isDryRun } from "./types.js";
import { INDEXER_SETTLE_MS } from "./sampler.js";
import { exitPosition } from "./meteora/actions.js";
import { executeZapOut, type ZapOutDeps } from "./meteora/zapout.js";

/**
 * Stop loss and take profit for managed positions.
 *
 * The action is terminal in a way nothing else in this app is: a rebalance that
 * goes wrong can be retried, but a fired trigger closes the position and there
 * is no undo — reopening pays bin-array rent again, and that rent is never
 * recoverable. Everything here is shaped by that asymmetry. Positions opt in one
 * at a time; a threshold has to be crossed on several consecutive readings; and
 * the whole thing can be run in a mode that alerts without ever acting.
 *
 * The number being watched is the indexer's PnL, which includes impermanent
 * loss. A stop loss on it is not "fees went negative" — a position earning well
 * can still hit one because the pair diverged.
 */

/** Consecutive refusals before a position disarms itself. */
export const MAX_REFUSALS = 5;

/** Why a check did not fire. Codes are for control flow; `reason` is for humans. */
export type TriggerSkipCode =
  | "off"
  | "no-thresholds"
  | "busy"
  | "too-new"
  | "settling"
  | "not-due"
  | "needs-reading"
  | "within"
  | "confirming";

export type TriggerSide = "stop" | "target";

export type TriggerVerdict =
  | {
      fire: false;
      code: TriggerSkipCode;
      reason: string;
      streak: number;
      side?: TriggerSide;
      detail?: Record<string, unknown>;
    }
  | {
      fire: true;
      side: TriggerSide;
      action: TriggerAction;
      reading: number;
      threshold: number;
      streak: number;
    };

export interface EffectiveThresholds {
  stopLoss?: number;
  takeProfit?: number;
  onFire: TriggerAction;
}

type TriggerConfig = Pick<
  Config,
  | "stopLoss"
  | "takeProfit"
  | "triggerOnFire"
  | "triggerConfirmations"
  | "triggerCheckMin"
  | "triggerMinAgeMin"
  | "triggerMeasure"
>;

/**
 * The thresholds this position actually runs on: its own overrides, else the
 * globals. Same `?? cfg` fallback shape as `edgeBufferBins` and `cooldownMin`.
 */
export function thresholdsFor(cfg: TriggerConfig, t?: PositionTriggers): EffectiveThresholds {
  return {
    stopLoss: t?.stopLoss ?? cfg.stopLoss,
    takeProfit: t?.takeProfit ?? cfg.takeProfit,
    onFire: t?.onFire ?? cfg.triggerOnFire,
  };
}

export interface TriggerInput {
  now: number;
  /**
   * The PnL reading, in whatever unit `triggerMeasure` selects, or null when
   * none has been taken yet. Passing null is also how a caller asks "would this
   * position be checked at all right now" without paying for the fetch: every
   * guard that does not need a number runs first, and a `needs-reading` verdict
   * means the answer is yes.
   */
  reading: number | null;
  managed: ManagedPosition;
  cfg: TriggerConfig;
  /** A rebalance in flight, or an unresolved journal entry for this position. */
  busy: boolean;
}

/**
 * Decides whether a position's thresholds have fired. Pure — no chain, no clock,
 * no store — so the guards that stand between a bad number and a closed position
 * can be tested exhaustively.
 */
export function evaluateTrigger(input: TriggerInput): TriggerVerdict {
  const { now, reading, managed, cfg, busy } = input;
  const t = managed.triggers;
  const streak = t?.streak ?? 0;
  const side = t?.streakSide;
  const hold = (code: TriggerSkipCode, reason: string, detail?: Record<string, unknown>): TriggerVerdict => ({
    fire: false,
    code,
    reason,
    streak,
    side,
    detail,
  });

  if (!t?.on) return hold("off", "triggers are off for this position");

  const th = thresholdsFor(cfg, t);
  if (th.stopLoss === undefined && th.takeProfit === undefined) {
    return hold("no-thresholds", "no stop loss or take profit is set");
  }

  // An unresolved rebalance means some of this position's funds are sitting in
  // the wallet, so the indexer is looking at a position that is missing a leg.
  // That is the exact shape of the reading that must never close anything.
  if (busy) return hold("busy", "a rebalance is in flight or unresolved");

  const ageMin = (now - managed.openedAt) / 60_000;
  if (ageMin < cfg.triggerMinAgeMin) {
    return hold("too-new", "position is younger than the minimum trigger age", {
      ageMin: round1(ageMin),
      minAgeMin: cfg.triggerMinAgeMin,
    });
  }

  const last = managed.lastRebalanceAt;
  if (last !== undefined && now - last < INDEXER_SETTLE_MS) {
    return hold("settling", "a rebalance just landed and the indexer has not caught up", {
      sinceMs: now - last,
      settleMs: INDEXER_SETTLE_MS,
    });
  }

  if (t.lastCheckAt !== undefined && now - t.lastCheckAt < cfg.triggerCheckMin * 60_000) {
    return hold("not-due", "checked too recently", {
      sinceMin: round1((now - t.lastCheckAt) / 60_000),
      checkMin: cfg.triggerCheckMin,
    });
  }

  if (reading === null || !Number.isFinite(reading)) {
    return hold("needs-reading", "no PnL reading available for this position");
  }

  const crossed: TriggerSide | null =
    th.stopLoss !== undefined && reading <= th.stopLoss
      ? "stop"
      : th.takeProfit !== undefined && reading >= th.takeProfit
        ? "target"
        : null;

  if (!crossed) {
    // Reset, not decay. A reading back inside the thresholds means the previous
    // ones were either a move that recovered or an indexer blip, and in both
    // cases the count toward closing the position starts again from zero.
    return { fire: false, code: "within", reason: "within thresholds", streak: 0, detail: { reading } };
  }

  const next = side === crossed ? streak + 1 : 1;
  if (next < cfg.triggerConfirmations) {
    return {
      fire: false,
      code: "confirming",
      reason: `past the ${crossed === "stop" ? "stop loss" : "take profit"}, confirming`,
      streak: next,
      side: crossed,
      detail: { reading, confirmations: cfg.triggerConfirmations },
    };
  }

  return {
    fire: true,
    side: crossed,
    action: th.onFire,
    reading,
    threshold: (crossed === "stop" ? th.stopLoss : th.takeProfit)!,
    streak: next,
  };
}

export interface TriggerActions {
  zapOut(deps: ZapOutDeps, params: { positionPk: string; poolAddress: string; to: "x" | "y" }): Promise<unknown>;
  exit(deps: ZapOutDeps, params: { positionPk: string; poolAddress: string }): Promise<unknown>;
}

const REAL_ACTIONS: TriggerActions = { zapOut: executeZapOut, exit: exitPosition };

/**
 * Runs the triggers for every armed position, once per engine tick.
 *
 * Returns the positions it closed, so the caller can skip them for the rest of
 * the tick — evaluating a rebalance against a position that no longer exists is
 * at best a wasted RPC round and at worst a confusing error in the logs.
 */
export class TriggerRunner {
  constructor(
    private readonly ctx: AppContext,
    private readonly zap: ZapOutDeps,
    private readonly busy: (positionPk: string) => boolean,
    /**
     * The two ways a position can be closed, injectable so the guards above can
     * be tested without a chain. Nothing else about them is configurable — the
     * real implementations are the same ones the ZAP OUT and EXIT buttons call.
     */
    private readonly actions: TriggerActions = REAL_ACTIONS,
  ) {}

  async run(now = Date.now()): Promise<Set<string>> {
    const fired = new Set<string>();
    const { cfg, store, log } = this.ctx;

    const armed = store.positions().filter((p) => p.triggers?.on);
    if (armed.length === 0) return fired;
    const wallet = this.ctx.client.wallet()?.publicKey.toBase58();
    if (!wallet) return fired;

    // One PnL call per POOL, reused across every position in it. Snapshotted
    // because a fired position mutates the list this loop reads from.
    const byPool = new Map<string, Map<string, number>>();

    for (const managed of [...armed]) {
      try {
        await this.check(managed, now, wallet, byPool, fired);
      } catch (e) {
        log.error(
          { positionPk: managed.positionPk, err: e instanceof Error ? e.message : String(e) },
          "trigger check failed",
        );
      }
    }

    if (fired.size > 0) log.warn({ fired: [...fired], measure: cfg.triggerMeasure }, "triggers closed position(s)");
    return fired;
  }

  private async check(
    managed: ManagedPosition,
    now: number,
    wallet: string,
    byPool: Map<string, Map<string, number>>,
    fired: Set<string>,
  ): Promise<void> {
    const { cfg, store, log } = this.ctx;
    const busy = this.busy(managed.positionPk) || store.pendingJournal().some((j) => j.positionPk === managed.positionPk);

    // Everything that does not need a number, before paying for the number.
    const gate = evaluateTrigger({ now, reading: null, managed, cfg, busy });
    if (!gate.fire && gate.code !== "needs-reading") {
      this.persist(managed, gate);
      log.debug({ positionPk: managed.positionPk, reason: gate.reason, ...gate.detail }, "trigger skipped");
      return;
    }

    const reading = await this.reading(managed, wallet, byPool);
    const verdict = evaluateTrigger({ now, reading, managed, cfg, busy });

    // Stamped AFTER the verdict, never before: `managed` is the store's own
    // object, so writing lastCheckAt first would have the evaluation trip its
    // own "checked too recently" guard and no reading would ever count.
    // Stamped even when no reading came back, so a pool the indexer has nothing
    // for is retried on the check interval rather than on every 30-second tick.
    store.setTriggers(managed.positionPk, {
      lastCheckAt: now,
      ...(reading === null ? {} : { lastReading: reading }),
    });
    this.persist(managed, verdict);
    if (!verdict.fire) {
      log.debug(
        { positionPk: managed.positionPk, reading, reason: verdict.reason, streak: verdict.streak },
        "trigger held",
      );
      return;
    }

    await this.fire(managed, verdict, fired);
  }

  /** Writes back the confirmation streak a verdict leaves behind. */
  private persist(managed: ManagedPosition, verdict: TriggerVerdict): void {
    const { streak, side } = verdict;
    if (managed.triggers?.streak === streak && managed.triggers?.streakSide === side) return;
    this.ctx.store.setTriggers(managed.positionPk, { streak, streakSide: side });
  }

  /** This position's PnL in the configured unit, or null if the indexer has none. */
  private async reading(
    managed: ManagedPosition,
    wallet: string,
    byPool: Map<string, Map<string, number>>,
  ): Promise<number | null> {
    const { cfg, dataApi } = this.ctx;
    let pool = byPool.get(managed.poolAddress);
    if (!pool) {
      pool = new Map();
      for (const pnl of await dataApi.positionPnlSafe(managed.poolAddress, wallet)) {
        const value = cfg.triggerMeasure === "usd" ? Number(pnl.pnlUsd) : Number(pnl.pnlPctChange);
        if (Number.isFinite(value)) pool.set(pnl.positionAddress, value);
      }
      byPool.set(managed.poolAddress, pool);
    }
    return pool.get(managed.positionPk) ?? null;
  }

  private async fire(
    managed: ManagedPosition,
    verdict: Extract<TriggerVerdict, { fire: true }>,
    fired: Set<string>,
  ): Promise<void> {
    const { cfg, store, log, notifier } = this.ctx;
    const name = managed.pairName ?? managed.positionPk.slice(0, 8);
    const label = verdict.side === "stop" ? "Stop loss" : "Take profit";
    const shown = `${fmt(verdict.reading, cfg.triggerMeasure)} vs ${fmt(verdict.threshold, cfg.triggerMeasure)}`;

    // Not armed, or dry-run: say what would have happened and change nothing.
    // Dry-run is treated as unarmed rather than simulated on purpose — a
    // simulated zap out cannot exercise its swap leg, because the exit whose
    // proceeds it would sell never happened. A green simulation would be
    // evidence of nothing while looking like evidence of everything.
    const dry = isDryRun(this.ctx);
    if (!cfg.triggersArmed || dry) {
      // Only at the moment the streak first completes, or an unarmed position
      // past its threshold would page every check interval, indefinitely.
      if (verdict.streak === cfg.triggerConfirmations) {
        const why = dry ? "DRY-RUN" : "triggers are not armed";
        log.warn({ positionPk: managed.positionPk, reading: verdict.reading }, `${label} would fire — ${why}`);
        notifier.notify(`👀 ${label} WOULD fire on ${name} (${shown}) — ${why}, nothing was closed`);
      }
      return;
    }

    try {
      if (verdict.action === "exit") {
        await this.actions.exit(this.zap, { poolAddress: managed.poolAddress, positionPk: managed.positionPk });
      } else {
        await this.actions.zapOut(this.zap, {
          positionPk: managed.positionPk,
          poolAddress: managed.poolAddress,
          to: verdict.action === "zap-x" ? "x" : "y",
        });
      }
      // The position no longer exists on chain, so it stops being managed here
      // too. Left in the store it would be polled, fail `getPosition`, and be
      // removed on the next tick anyway — with a stray error line in between.
      store.removePosition(managed.positionPk);
      fired.add(managed.positionPk);
      log.warn({ positionPk: managed.positionPk, side: verdict.side, reading: verdict.reading }, `${label} fired`);
      notifier.notify(`🛑 ${label} FIRED on ${name} — ${shown}. Position closed.`);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      const refusals = (managed.triggers?.refusals ?? 0) + 1;

      // A refusal is usually a route Jupiter will not price acceptably, which
      // normally clears in minutes — so it retries. What it must not do is retry
      // forever: an illiquid pair would alert every check interval until the
      // alerts become noise, which is worse than a stop that stopped.
      if (refusals >= MAX_REFUSALS) {
        store.setTriggers(managed.positionPk, { on: false, refusals, disarmedReason: detail });
        log.error({ positionPk: managed.positionPk, refusals, err: detail }, `${label} disarmed after refusals`);
        notifier.notify(
          `⚠️ ${label} on ${name} was REFUSED ${refusals} times and is now DISARMED — the position is still ` +
            `open and no longer protected. Last reason: ${detail}`,
        );
        return;
      }

      store.setTriggers(managed.positionPk, { refusals });
      log.warn({ positionPk: managed.positionPk, refusals, err: detail }, `${label} refused — will retry`);
      notifier.notify(
        `⚠️ ${label} on ${name} could not close the position (attempt ${refusals}/${MAX_REFUSALS}): ${detail}`,
      );
    }
  }
}

function fmt(n: number, measure: Config["triggerMeasure"]): string {
  return measure === "usd" ? `$${n.toFixed(2)}` : `${n.toFixed(2)}%`;
}

function round1(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : n;
}

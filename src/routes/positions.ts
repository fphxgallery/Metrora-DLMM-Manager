import type { FastifyInstance, FastifyReply } from "fastify";
import { requireAuth } from "../auth.js";
import { listPositions, positionBins } from "../meteora/positions.js";
import { addLiquidity, claimFees, exitPosition, openPosition, type ActionDeps } from "../meteora/actions.js";
import { executeRebalance, planRebalance, type RebalanceDeps } from "../meteora/rebalance.js";
import { TxError } from "../tx/send.js";
import { STRATEGY_TYPES, TRIGGER_ACTIONS, type StrategyTypeName, type TriggerAction } from "../config.js";
import type { AppContext } from "../types.js";

export function registerPositionRoutes(app: FastifyInstance, ctx: AppContext, rebalanceDeps: RebalanceDeps): void {
  const { cfg, client, dataApi, sender, store, log } = ctx;
  const actions: ActionDeps = { cfg, client, dataApi, sender, store, log };

  app.get("/api/positions", async (_req, reply) => {
    try {
      const wallet = client.wallet();
      const positions = await listPositions({ cfg, client, dataApi, store, log });
      return {
        wallet: wallet?.publicKey.toBase58() ?? null,
        solBalance: await client.solBalance(),
        positions,
      };
    } catch (e) {
      log.warn({ err: msg(e) }, "position listing failed");
      return reply.code(502).send({ error: msg(e) });
    }
  });

  // ------------------------------------------------------------- actions ----
  //
  // Every one of these signs. They all run through TxSender, which simulates
  // first and — under DRY_RUN — reports the simulation and sends nothing.

  app.post("/api/positions/open", async (req, reply) => {
    if (!requireAuth(cfg, req, reply)) return;
    const body = (req.body ?? {}) as {
      poolAddress?: string;
      xAmount?: number;
      yAmount?: number;
      rangeBins?: number;
      strategyType?: string;
      auto?: boolean;
    };
    if (!body.poolAddress) return reply.code(400).send({ error: "poolAddress is required" });
    if (body.strategyType && !(STRATEGY_TYPES as readonly string[]).includes(body.strategyType)) {
      return reply.code(400).send({ error: `strategyType must be one of: ${STRATEGY_TYPES.join(", ")}` });
    }

    return run(reply, () =>
      openPosition(actions, {
        poolAddress: body.poolAddress!,
        xAmount: Number(body.xAmount ?? 0),
        yAmount: Number(body.yAmount ?? 0),
        rangeBins: numOrUndef(body.rangeBins),
        strategyType: body.strategyType as StrategyTypeName | undefined,
        auto: Boolean(body.auto),
      }),
    );
  });

  app.post("/api/positions/:pk/add", async (req, reply) => {
    if (!requireAuth(cfg, req, reply)) return;
    const { pk } = req.params as { pk: string };
    const body = (req.body ?? {}) as { poolAddress?: string; xAmount?: number; yAmount?: number };
    const poolAddress = body.poolAddress ?? store.position(pk)?.poolAddress;
    if (!poolAddress) return reply.code(400).send({ error: "poolAddress is required" });

    return run(reply, async () => ({
      results: await addLiquidity(actions, {
        poolAddress,
        positionPk: pk,
        xAmount: Number(body.xAmount ?? 0),
        yAmount: Number(body.yAmount ?? 0),
      }),
    }));
  });

  app.post("/api/positions/:pk/claim", async (req, reply) => {
    if (!requireAuth(cfg, req, reply)) return;
    const { pk } = req.params as { pk: string };
    const poolAddress = ((req.body ?? {}) as { poolAddress?: string }).poolAddress ?? store.position(pk)?.poolAddress;
    if (!poolAddress) return reply.code(400).send({ error: "poolAddress is required" });

    return run(reply, async () => ({ results: await claimFees(actions, { poolAddress, positionPk: pk }) }));
  });

  /**
   * Re-centres a position now, bypassing the cooldown / range / cost guards —
   * the operator asked for it explicitly. Uses exactly the same plan-and-execute
   * path the engine does, so a manual run is a faithful rehearsal of automation.
   */
  app.post("/api/positions/:pk/rebalance", async (req, reply) => {
    if (!requireAuth(cfg, req, reply)) return;
    const { pk } = req.params as { pk: string };
    const body = (req.body ?? {}) as { poolAddress?: string; strategyType?: string };
    const managed = store.position(pk);
    const poolAddress = body.poolAddress ?? managed?.poolAddress;
    if (!poolAddress) return reply.code(400).send({ error: "poolAddress is required" });
    if (ctx.engine?.isBusy(pk)) return reply.code(409).send({ error: "a rebalance is already in flight" });

    // The cooldown / range / cost guards above are POLICY — the operator is
    // entitled to overrule them. This one is CORRECTNESS, so it is not
    // overridable: an unresolved journal entry means withdrawn funds are
    // sitting in the wallet mid path-B, and starting a second rebalance would
    // open a SECOND entry against the same position. Resume attributes a leg by
    // the range change it caused, which cannot distinguish two entries on one
    // position — so with two pending, NEITHER is resumable from range evidence
    // and the funds stay stranded. Refusing here keeps the one entry resolvable.
    const unfinished = store.pendingJournal().find((j) => j.positionPk === pk);
    if (unfinished) {
      return reply.code(409).send({
        error:
          `unfinished rebalance ${unfinished.id} is pending at phase "${unfinished.phase}" — ` +
          `the engine retries it automatically about every 2 minutes, and a manual rebalance now ` +
          `would open a second entry that makes both unresolvable. Wait for it to clear (watch /api/journal).`,
        journalId: unfinished.id,
        phase: unfinished.phase,
      });
    }

    return run(reply, async () => {
      const plan = await planRebalance(rebalanceDeps, {
        positionPk: pk,
        poolAddress,
        strategyType: (body.strategyType as StrategyTypeName | undefined) ?? managed?.strategyType,
      });
      const outcome = await executeRebalance(rebalanceDeps, plan);
      return { plan: outcome.plan, journalId: outcome.journalId, results: outcome.results, dryRun: outcome.dryRun };
    });
  });

  // A read, not an action: the card fetches it only while it is expanded, which
  // is why it is not folded into /api/positions — that polls every 30 seconds
  // for positions whose bins are usually not on screen.
  app.get("/api/positions/:pk/bins", async (req, reply) => {
    const { pk } = req.params as { pk: string };
    const poolAddress = (req.query as { poolAddress?: string }).poolAddress ?? store.position(pk)?.poolAddress;
    if (!poolAddress) return reply.code(400).send({ error: "poolAddress is required" });

    return run(reply, () => positionBins({ client, dataApi }, { positionPk: pk, poolAddress }));
  });

  /** What the engine would decide right now, without doing anything. */
  app.get("/api/positions/:pk/plan", async (req, reply) => {
    const { pk } = req.params as { pk: string };
    const poolAddress = (req.query as { poolAddress?: string }).poolAddress ?? store.position(pk)?.poolAddress;
    if (!poolAddress) return reply.code(400).send({ error: "poolAddress is required" });

    return run(reply, async () => {
      const managed = store.position(pk);
      const plan = await planRebalance(rebalanceDeps, {
        positionPk: pk,
        poolAddress,
        strategyType: managed?.strategyType,
      });
      const decision = managed && ctx.engine ? await ctx.engine.evaluate(managed) : null;
      return {
        plan,
        wouldAct: decision?.act ?? null,
        reason: decision?.reason ?? "position is not managed — guards not evaluated",
        detail: decision?.detail ?? null,
      };
    });
  });

  app.post("/api/positions/:pk/exit", async (req, reply) => {
    if (!requireAuth(cfg, req, reply)) return;
    const { pk } = req.params as { pk: string };
    const poolAddress = ((req.body ?? {}) as { poolAddress?: string }).poolAddress ?? store.position(pk)?.poolAddress;
    if (!poolAddress) return reply.code(400).send({ error: "poolAddress is required" });

    return run(reply, async () => ({ results: await exitPosition(actions, { poolAddress, positionPk: pk }) }));
  });

  /**
   * Enrolls a position in (or removes it from) automatic rebalancing, with
   * optional per-position overrides of the global thresholds.
   *
   * Enrolling is deliberately explicit: the engine only ever touches positions
   * listed here, so a position opened elsewhere is never rebalanced by surprise.
   */
  app.post("/api/positions/:pk/manage", async (req, reply) => {
    if (!requireAuth(cfg, req, reply)) return;
    const { pk } = req.params as { pk: string };
    const body = (req.body ?? {}) as {
      auto?: boolean;
      poolAddress?: string;
      pairName?: string;
      rangeBins?: number | null;
      strategyType?: string | null;
      edgeBufferBins?: number | null;
      cooldownMin?: number | null;
    };

    const existing = store.position(pk);
    const poolAddress = body.poolAddress ?? existing?.poolAddress;
    if (!poolAddress) return reply.code(400).send({ error: "poolAddress is required the first time a position is managed" });

    if (body.strategyType != null && !(STRATEGY_TYPES as readonly string[]).includes(body.strategyType)) {
      return reply.code(400).send({ error: `strategyType must be one of: ${STRATEGY_TYPES.join(", ")}` });
    }

    // Per-position overrides get the same sanity check as the global config —
    // an edge buffer wider than the range would rebalance on every single poll.
    const rangeBins = numOrUndef(body.rangeBins) ?? existing?.rangeBins ?? cfg.rangeBins;
    const edgeBufferBins = numOrUndef(body.edgeBufferBins) ?? existing?.edgeBufferBins ?? cfg.edgeBufferBins;
    if (edgeBufferBins >= rangeBins) {
      return reply.code(400).send({
        error: `edgeBufferBins (${edgeBufferBins}) must be < rangeBins (${rangeBins}) — otherwise the position is always "near the edge"`,
      });
    }

    const saved = store.upsertPosition({
      positionPk: pk,
      poolAddress,
      pairName: body.pairName ?? existing?.pairName,
      auto: body.auto ?? existing?.auto ?? false,
      rangeBins: body.rangeBins === null ? undefined : numOrUndef(body.rangeBins) ?? existing?.rangeBins,
      strategyType:
        body.strategyType === null ? undefined : ((body.strategyType as StrategyTypeName) ?? existing?.strategyType),
      edgeBufferBins:
        body.edgeBufferBins === null ? undefined : numOrUndef(body.edgeBufferBins) ?? existing?.edgeBufferBins,
      cooldownMin: body.cooldownMin === null ? undefined : numOrUndef(body.cooldownMin) ?? existing?.cooldownMin,
      openedAt: existing?.openedAt ?? Date.now(),
      lastRebalanceAt: existing?.lastRebalanceAt,
      rebalanceCount: existing?.rebalanceCount ?? 0,
      pollsTotal: existing?.pollsTotal ?? 0,
      pollsInRange: existing?.pollsInRange ?? 0,
    });

    log.info({ positionPk: pk, auto: saved.auto }, "position management updated");
    return { ok: true, managed: saved };
  });

  /**
   * Arms or disarms this position's stop loss / take profit, with optional
   * per-position thresholds.
   *
   * Only reachable for a position this app already manages: the engine tick is
   * what evaluates triggers, and it only visits managed positions. Arming
   * something it never looks at would be a switch that silently does nothing.
   */
  app.post("/api/positions/:pk/triggers", async (req, reply) => {
    if (!requireAuth(cfg, req, reply)) return;
    const { pk } = req.params as { pk: string };
    const body = (req.body ?? {}) as {
      on?: boolean;
      stopLoss?: number | null;
      takeProfit?: number | null;
      onFire?: string | null;
    };

    const existing = store.position(pk);
    if (!existing) {
      return reply.code(400).send({
        error: "position is not managed — enable AUTO first, so the engine has a reason to look at it",
      });
    }

    // Same sign rule the global config enforces, and for the same reason: a
    // positive stop loss sits above a healthy position's PnL and would close it
    // on the first confirmed reading.
    const stopLoss = numOrUndef(body.stopLoss);
    const takeProfit = numOrUndef(body.takeProfit);
    if (stopLoss !== undefined && !(stopLoss < 0)) {
      return reply.code(400).send({ error: `stopLoss must be negative (got ${stopLoss}); send null to use the global value` });
    }
    if (takeProfit !== undefined && !(takeProfit > 0)) {
      return reply.code(400).send({ error: `takeProfit must be positive (got ${takeProfit}); send null to use the global value` });
    }
    if (body.onFire != null && !(TRIGGER_ACTIONS as readonly string[]).includes(body.onFire)) {
      return reply.code(400).send({ error: `onFire must be one of: ${TRIGGER_ACTIONS.join(", ")}` });
    }

    // Arming with nothing to fire on is the one combination worth refusing: the
    // UI would show it armed and it could never act.
    const effStop = stopLoss ?? (body.stopLoss === null ? undefined : existing.triggers?.stopLoss) ?? cfg.stopLoss;
    const effTarget =
      takeProfit ?? (body.takeProfit === null ? undefined : existing.triggers?.takeProfit) ?? cfg.takeProfit;
    if (body.on === true && effStop === undefined && effTarget === undefined) {
      return reply.code(400).send({
        error: "no stop loss or take profit to arm — set one here, or set a global default in SETTINGS",
      });
    }

    const saved = store.setTriggers(pk, {
      ...(body.on === undefined ? {} : { on: body.on }),
      ...(body.stopLoss === undefined ? {} : { stopLoss: body.stopLoss === null ? undefined : stopLoss }),
      ...(body.takeProfit === undefined ? {} : { takeProfit: body.takeProfit === null ? undefined : takeProfit }),
      ...(body.onFire === undefined ? {} : { onFire: body.onFire === null ? undefined : (body.onFire as TriggerAction) }),
      // Any edit clears the bookkeeping. A streak counted against the OLD
      // threshold is not evidence about the new one, and a refusal count that
      // survived a change of target token would disarm a route that now works.
      streak: 0,
      streakSide: undefined,
      refusals: 0,
      disarmedReason: undefined,
    });

    log.warn({ positionPk: pk, on: saved?.on, stopLoss: effStop, takeProfit: effTarget }, "position triggers updated");
    return { ok: true, triggers: saved };
  });

  /** Stops managing a position. Does not touch the position on chain. */
  app.post("/api/positions/:pk/unmanage", async (req, reply) => {
    if (!requireAuth(cfg, req, reply)) return;
    const { pk } = req.params as { pk: string };
    store.removePosition(pk);
    return { ok: true };
  });
}

/**
 * Wraps an action so a failed simulation comes back as a 400 with the program
 * logs attached. Those logs are usually the only place the real reason appears
 * ("custom program error: 0x1773"), so dropping them would make failures
 * undiagnosable from the dashboard.
 */
async function run<T>(reply: FastifyReply, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof TxError) {
      void reply.code(400).send({ error: e.message, logs: e.logs });
      return undefined;
    }
    void reply.code(400).send({ error: msg(e) });
    return undefined;
  }
}

function numOrUndef(v: number | null | undefined): number | undefined {
  if (v === null || v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

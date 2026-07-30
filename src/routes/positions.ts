import type { FastifyInstance, FastifyReply } from "fastify";
import { requireAuth } from "../auth.js";
import { listPositions } from "../meteora/positions.js";
import { addLiquidity, claimFees, exitPosition, openPosition, type ActionDeps } from "../meteora/actions.js";
import { executeRebalance, planRebalance, type RebalanceDeps } from "../meteora/rebalance.js";
import { TxError } from "../tx/send.js";
import { STRATEGY_TYPES, type StrategyTypeName } from "../config.js";
import type { AppContext } from "../types.js";

export function registerPositionRoutes(app: FastifyInstance, ctx: AppContext, rebalanceDeps: RebalanceDeps): void {
  const { cfg, client, dataApi, sender, store, samples, log } = ctx;
  const actions: ActionDeps = { cfg, client, dataApi, sender, store, log };

  app.get("/api/positions", async (_req, reply) => {
    try {
      const wallet = client.wallet();
      const positions = await listPositions({ cfg, client, dataApi, store, samples, log });
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

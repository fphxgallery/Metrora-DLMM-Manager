import type { FastifyInstance, FastifyReply } from "fastify";
import { requireAuth } from "../auth.js";
import { TxError } from "../tx/send.js";
import { executeZapOut, planZapOut, type ZapOutDeps, type ZapOutParams, type ZapSide } from "../meteora/zapout.js";

/**
 * Zap out: price it, then close and consolidate.
 *
 * Split like Ape, and more importantly than Ape. A zap out closes the position
 * before it swaps, so the preview is not a nicety — it is where an unroutable
 * position gets refused while it still exists. Confirming without it would mean
 * discovering the route is bad only after the position is gone.
 */
export function registerZapOutRoutes(app: FastifyInstance, deps: ZapOutDeps): void {
  const { cfg, store } = deps;

  app.post("/api/positions/:pk/zap-out/preview", async (req, reply) => {
    if (!requireAuth(cfg, req, reply)) return;
    const params = parse(req, reply, store);
    if (!params) return;
    return run(reply, () => planZapOut(deps, params));
  });

  app.post("/api/positions/:pk/zap-out", async (req, reply) => {
    if (!requireAuth(cfg, req, reply)) return;
    const params = parse(req, reply, store);
    if (!params) return;
    return run(reply, () => executeZapOut(deps, params));
  });
}

/** Shared body validation. Returns null once a 4xx has been sent. */
function parse(
  req: { params: unknown; body: unknown },
  reply: FastifyReply,
  store: ZapOutDeps["store"],
): ZapOutParams | null {
  const { pk } = req.params as { pk: string };
  const body = (req.body ?? {}) as { poolAddress?: string; to?: string };

  // Same fallback the other position routes use: a managed position already
  // knows its pool, so the caller only has to say which one when it doesn't.
  const poolAddress = body.poolAddress ?? store.position(pk)?.poolAddress;
  if (!poolAddress) {
    void reply.code(400).send({ error: "poolAddress is required" });
    return null;
  }
  if (body.to !== undefined && body.to !== "x" && body.to !== "y") {
    void reply.code(400).send({ error: 'to must be "x" (base) or "y" (quote)' });
    return null;
  }

  return { positionPk: pk, poolAddress, to: body.to as ZapSide | undefined };
}

async function run<T>(reply: FastifyReply, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof TxError) {
      void reply.code(400).send({ error: e.message, logs: e.logs });
      return undefined;
    }
    void reply.code(400).send({ error: e instanceof Error ? e.message : String(e) });
    return undefined;
  }
}

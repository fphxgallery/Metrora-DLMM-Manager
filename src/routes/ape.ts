import type { FastifyInstance, FastifyReply } from "fastify";
import { requireAuth } from "../auth.js";
import { TxError } from "../tx/send.js";
import { executeApe, planApe, type ApeDeps, type ApeParams, type ApeSide } from "../meteora/ape.js";
import { STRATEGY_TYPES, type StrategyTypeName } from "../config.js";

/**
 * Ape: quote it, then do it.
 *
 * Split in two deliberately. `/preview` costs a Jupiter quote and sends
 * nothing, so the confirm step in the UI shows real numbers — the swap it will
 * make, the range it will land in, what it will cost — rather than asking
 * someone to click through on faith. `/ape` re-quotes before it acts, because
 * the human in between took time to read.
 *
 * Both require auth even though the preview does not spend: it is a POST that
 * reaches an external API on the wallet's behalf, which belongs on the write
 * side of the line.
 */
export function registerApeRoutes(app: FastifyInstance, deps: ApeDeps): void {
  const { cfg } = deps;

  app.post("/api/positions/ape/preview", async (req, reply) => {
    if (!requireAuth(cfg, req, reply)) return;
    const params = parse(req.body, reply);
    if (!params) return;
    return run(reply, () => planApe(deps, params));
  });

  app.post("/api/positions/ape", async (req, reply) => {
    if (!requireAuth(cfg, req, reply)) return;
    const params = parse(req.body, reply);
    if (!params) return;
    return run(reply, () => executeApe(deps, params));
  });
}

/** Shared body validation. Returns null once a 400 has been sent. */
function parse(body: unknown, reply: FastifyReply): ApeParams | null {
  const b = (body ?? {}) as {
    poolAddress?: string;
    amount?: number | string;
    payWith?: string;
    rangeBins?: number;
    strategyType?: string;
    auto?: boolean;
  };

  if (!b.poolAddress) {
    void reply.code(400).send({ error: "poolAddress is required" });
    return null;
  }
  const amount = Number(b.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    void reply.code(400).send({ error: "amount must be a number greater than zero" });
    return null;
  }
  // Defaulting this would pick a side of someone's wallet for them.
  if (b.payWith !== "x" && b.payWith !== "y") {
    void reply.code(400).send({ error: 'payWith must be "x" or "y"' });
    return null;
  }
  if (b.strategyType && !(STRATEGY_TYPES as readonly string[]).includes(b.strategyType)) {
    void reply.code(400).send({ error: `strategyType must be one of: ${STRATEGY_TYPES.join(", ")}` });
    return null;
  }

  const rangeBins = Number(b.rangeBins);
  return {
    poolAddress: b.poolAddress,
    amount,
    payWith: b.payWith as ApeSide,
    rangeBins: Number.isFinite(rangeBins) && rangeBins > 0 ? rangeBins : undefined,
    strategyType: b.strategyType as StrategyTypeName | undefined,
    auto: typeof b.auto === "boolean" ? b.auto : undefined,
  };
}

/**
 * Same wrapper the position routes use: a failed simulation comes back as a 400
 * with the program logs attached, which is usually the only place the real
 * reason appears.
 */
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

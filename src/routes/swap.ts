import type { FastifyInstance, FastifyReply } from "fastify";
import { requireAuth } from "../auth.js";
import { TxError } from "../tx/send.js";
import { executeSwap, planSwap, type SwapDeps, type SwapParams } from "../swap/manual.js";
import { searchTokens } from "../wallet/tokens.js";

/**
 * Manual wallet swaps: price it, then send it.
 *
 * Split for the same reason Ape and Zap Out are. The preview is where the route,
 * the price impact and the minimum received become visible, and where every
 * refusal lands while nothing has been signed — so CONFIRM is only ever live on
 * a plan that has already passed the guards.
 */
export function registerSwapRoutes(app: FastifyInstance, deps: SwapDeps): void {
  const { cfg } = deps;

  app.post("/api/swap/preview", async (req, reply) => {
    if (!requireAuth(cfg, req, reply)) return;
    const params = parse(req, reply);
    if (!params) return;
    return run(reply, () => planSwap(deps, params));
  });

  app.post("/api/swap", async (req, reply) => {
    if (!requireAuth(cfg, req, reply)) return;
    const params = parse(req, reply);
    if (!params) return;
    return run(reply, () => executeSwap(deps, params));
  });

  /**
   * Token lookup for the buy side.
   *
   * Authenticated even though it only reads a public index: it is an outbound
   * request this server makes on the caller's behalf, and there is no reason to
   * let an unauthenticated client drive that.
   */
  app.get("/api/tokens/search", async (req, reply) => {
    if (!requireAuth(cfg, req, reply)) return;
    const q = String((req.query as { q?: string }).q ?? "").trim();
    if (q.length < 2) return { query: q, tokens: [] };
    return { query: q, tokens: await searchTokens(q) };
  });
}

function parse(req: { body: unknown }, reply: FastifyReply): SwapParams | null {
  const body = (req.body ?? {}) as { inputMint?: unknown; outputMint?: unknown; amount?: unknown };
  const inputMint = typeof body.inputMint === "string" ? body.inputMint.trim() : "";
  const outputMint = typeof body.outputMint === "string" ? body.outputMint.trim() : "";
  const amount = Number(body.amount);

  if (!inputMint || !outputMint) {
    void reply.code(400).send({ error: "inputMint and outputMint are required" });
    return null;
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    void reply.code(400).send({ error: "amount must be a number greater than zero" });
    return null;
  }
  return { inputMint, outputMint, amount };
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

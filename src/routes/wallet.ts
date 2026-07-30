import type { FastifyInstance } from "fastify";
import { PublicKey } from "@solana/web3.js";
import { requireAuth } from "../auth.js";
import { TxError } from "../tx/send.js";
import {
  buildTokenView,
  closeAccountIx,
  fetchTokenMeta,
  readTokenAccounts,
  reclaimableLamports,
  type TokenAccountView,
} from "../wallet/tokens.js";
import type { AppContext } from "../types.js";

/**
 * Mints the app itself depends on: both sides of every managed position's pool.
 *
 * Read from the pool client (cached), not from a static list, so a position
 * opened on a new pool protects its accounts immediately. On failure the pool
 * is skipped and its mints are simply not protected — so the caller treats an
 * empty set as "could not confirm" rather than "nothing is in use".
 */
async function inUseMints(ctx: AppContext): Promise<{ mints: Set<string>; complete: boolean }> {
  const pools = [...new Set(ctx.store.positions().map((p) => p.poolAddress))];
  const mints = new Set<string>();
  let complete = true;

  for (const address of pools) {
    try {
      const pool = await ctx.client.getPool(address);
      mints.add(pool.tokenX.publicKey.toBase58());
      mints.add(pool.tokenY.publicKey.toBase58());
    } catch (e) {
      complete = false;
      ctx.log.warn({ pool: address, err: msg(e) }, "could not read pool tokens for the wallet listing");
    }
  }
  return { mints, complete };
}

export function registerWalletTokenRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { cfg, client, dataApi, sender, log } = ctx;

  /** Everything the wallet holds, priced, with each token account's rent. */
  app.get("/api/wallet/tokens", async (_req, reply) => {
    const owner = client.wallet()?.publicKey;
    if (!owner) return { wallet: null, solBalance: 0, solPriceUsd: 0, totalUsd: 0, accounts: [], protectionComplete: true };

    try {
      const [raw, solBalance, solPriceUsd, inUse] = await Promise.all([
        readTokenAccounts(client.connection, owner),
        client.solBalance(),
        dataApi.solPriceUsd().catch(() => 0),
        inUseMints(ctx),
      ]);

      const meta = await fetchTokenMeta(raw.map((a) => a.mint));
      const accounts = raw
        .map((a) => buildTokenView(a, meta.get(a.mint), inUse.mints))
        .sort((a, b) => (b.usdValue ?? -1) - (a.usdValue ?? -1));

      const tokensUsd = accounts.reduce((sum, a) => sum + (a.usdValue ?? 0), 0);
      return {
        wallet: owner.toBase58(),
        solBalance,
        solPriceUsd,
        totalUsd: tokensUsd + solBalance * solPriceUsd,
        reclaimableLamports: reclaimableLamports(accounts),
        /**
         * False when a pool's tokens could not be read, so the UI can say the
         * in-use guard is incomplete rather than silently offering to close an
         * account the app still needs.
         */
        protectionComplete: inUse.complete,
        accounts,
      };
    } catch (e) {
      log.warn({ err: msg(e) }, "wallet token listing failed");
      return reply.code(502).send({ error: msg(e) });
    }
  });

  /**
   * Closes empty token accounts and returns their rent to the wallet.
   *
   * The client sends account addresses; every one is re-classified here against
   * a freshly read chain state before it is touched. A stale UI (or a crafted
   * request) must not be able to close an account that has since received a
   * balance or belongs to a position opened a moment ago.
   */
  app.post("/api/wallet/close-accounts", async (req, reply) => {
    if (!requireAuth(cfg, req, reply)) return;

    const body = (req.body ?? {}) as { accounts?: unknown };
    const wanted = Array.isArray(body.accounts) ? body.accounts.map(String) : [];
    if (wanted.length === 0) return reply.code(400).send({ error: "accounts must be a non-empty array" });

    const owner = client.wallet()?.publicKey;
    if (!owner) return reply.code(400).send({ error: `no keypair at ${cfg.keypairPath}` });

    try {
      const [raw, inUse] = await Promise.all([readTokenAccounts(client.connection, owner), inUseMints(ctx)]);
      const byPubkey = new Map<string, TokenAccountView>(
        raw.map((a) => [a.pubkey, buildTokenView(a, undefined, inUse.mints)]),
      );

      const targets: TokenAccountView[] = [];
      const refused: { pubkey: string; reason: string }[] = [];
      for (const pubkey of new Set(wanted)) {
        const view = byPubkey.get(pubkey);
        if (!view) {
          refused.push({ pubkey, reason: "not a token account of this wallet" });
        } else if (view.lockedReason) {
          refused.push({ pubkey, reason: view.lockedReason });
        } else {
          targets.push(view);
        }
      }
      if (targets.length === 0) {
        return reply.code(400).send({ error: "nothing closable in that selection", refused });
      }

      const ixs = targets.map((v) => closeAccountIx(v, owner));
      const result = await sender.sendInstructions(ixs, [client.requireWallet()], "close token accounts");

      const reclaimed = targets.reduce((sum, v) => sum + v.rentLamports, 0);
      if (!result.dryRun) {
        log.info({ closed: targets.length, reclaimed, signature: result.signature }, "closed token accounts");
        ctx.notifier.notify(
          `🧾 Closed ${targets.length} empty token account(s), reclaiming ${(reclaimed / 1e9).toFixed(5)} SOL`,
        );
      }

      return {
        ...result,
        closed: targets.map((v) => v.pubkey),
        reclaimedLamports: reclaimed,
        refused,
      };
    } catch (e) {
      const err = e instanceof TxError ? e : null;
      log.warn({ err: msg(e) }, "closing token accounts failed");
      return reply.code(502).send({ error: msg(e), logs: err?.logs });
    }
  });
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

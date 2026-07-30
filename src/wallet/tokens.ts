import { PublicKey, type Connection } from "@solana/web3.js";
import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createCloseAccountInstruction,
} from "@solana/spl-token";

/**
 * What the wallet actually holds, and which of those token accounts can be
 * closed to reclaim their rent.
 *
 * A Solana token account is not free: it holds a rent-exempt deposit (2,039,280
 * lamports for a standard SPL account, more for Token-2022 with extensions)
 * that is returned in full when the account is closed. Airdrops, one-off swaps
 * and closed positions leave empty accounts behind, and each one is a small
 * amount of SOL sitting idle.
 *
 * The rent figure here is never assumed from the constant — it is the account's
 * own lamport balance, which is what closing it actually returns.
 */

/** Raw shape read from the RPC, before prices or symbols are attached. */
export interface RawTokenAccount {
  /** The token account address, not the mint. */
  pubkey: string;
  mint: string;
  /** TOKEN_PROGRAM_ID or TOKEN_2022_PROGRAM_ID — needed to build a close ix. */
  programId: string;
  amountRaw: string;
  decimals: number;
  uiAmount: number;
  rentLamports: number;
}

export interface TokenMeta {
  symbol?: string;
  usdPrice?: number;
}

export interface TokenAccountView extends RawTokenAccount {
  symbol: string | null;
  usdPrice: number | null;
  usdValue: number | null;
  /** Null when the account can be closed; otherwise why it cannot. */
  lockedReason: string | null;
  /**
   * A managed position's own token account. Reported as a flag as well as a
   * reason because the UI hides these rows, and matching on the prose would
   * break silently the day the wording changes.
   */
  inUse: boolean;
  /** Closing this one returns its balance as native SOL, not just the rent. */
  unwrapsToSol: boolean;
}

export const IN_USE_REASON = "in use by a managed position";

/**
 * Why an account may not be closed, or null if it may.
 *
 * Order matters. The in-use check comes first and applies even to an EMPTY
 * account: the tokens of a managed position are exactly the accounts the
 * rebalance path re-creates, so closing one reclaims rent that the very next
 * rebalance pays again — plus a wasted instruction. That is a hard block in the
 * UI, not a warning.
 *
 * Wrapped SOL is the one case where a non-empty account is still closable:
 * closing it unwraps the balance to native SOL in the same wallet, so nothing
 * is lost. Left-over wSOL from an interrupted rebalance is recovered this way.
 */
export function lockReason(a: RawTokenAccount, inUseMints: ReadonlySet<string>): string | null {
  if (inUseMints.has(a.mint)) return IN_USE_REASON;
  if (a.mint === NATIVE_MINT.toBase58()) return null;
  if (a.uiAmount > 0) return "holds a balance";
  return null;
}

export function buildTokenView(a: RawTokenAccount, meta: TokenMeta | undefined, inUseMints: ReadonlySet<string>): TokenAccountView {
  const usdPrice = typeof meta?.usdPrice === "number" && Number.isFinite(meta.usdPrice) ? meta.usdPrice : null;
  return {
    ...a,
    symbol: meta?.symbol ?? null,
    usdPrice,
    usdValue: usdPrice === null ? null : a.uiAmount * usdPrice,
    lockedReason: lockReason(a, inUseMints),
    inUse: inUseMints.has(a.mint),
    unwrapsToSol: a.mint === NATIVE_MINT.toBase58() && a.uiAmount > 0,
  };
}

/** Rent recoverable right now, in lamports — only the accounts with no lock. */
export function reclaimableLamports(views: TokenAccountView[]): number {
  return views.filter((v) => v.lockedReason === null).reduce((sum, v) => sum + v.rentLamports, 0);
}

/**
 * The two token programs' accounts, merged.
 *
 * Token-2022 mints live under a different program id and are invisible to a
 * query for the classic one, so both are asked. The program id travels with
 * each account because closing it requires the program that owns it.
 */
export async function readTokenAccounts(connection: Connection, owner: PublicKey): Promise<RawTokenAccount[]> {
  const programs = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];
  const results = await Promise.all(
    programs.map((programId) => connection.getParsedTokenAccountsByOwner(owner, { programId })),
  );

  const out: RawTokenAccount[] = [];
  for (const res of results) {
    for (const { pubkey, account } of res.value) {
      const info = (account.data as { parsed?: { info?: Record<string, unknown> } }).parsed?.info;
      const amount = info?.tokenAmount as { amount?: string; decimals?: number; uiAmount?: number } | undefined;
      if (!info?.mint || !amount) continue;
      out.push({
        pubkey: pubkey.toBase58(),
        mint: String(info.mint),
        programId: account.owner.toBase58(),
        amountRaw: amount.amount ?? "0",
        decimals: amount.decimals ?? 0,
        uiAmount: Number(amount.uiAmount ?? 0),
        rentLamports: account.lamports,
      });
    }
  }
  return out;
}

/** Jupiter's token search takes a comma-separated list; this is its documented ceiling. */
const JUP_BATCH = 100;
const JUP_SEARCH_URL = "https://lite-api.jup.ag/tokens/v2/search";

/**
 * Symbols and USD prices for arbitrary mints, from Jupiter.
 *
 * The Meteora Data API prices only the tokens of a pool, so it cannot say what
 * a random airdrop sitting in the wallet is worth. Jupiter's token search
 * returns symbol and price together, keyed by mint, and simply omits mints it
 * does not know — so an unpriced token still lists, with its balance and no USD
 * figure. Never throws: a wallet listing must not fail because a price lookup did.
 */
export async function fetchTokenMeta(mints: string[], timeoutMs = 10_000): Promise<Map<string, TokenMeta>> {
  const out = new Map<string, TokenMeta>();
  const unique = [...new Set(mints)];

  for (let i = 0; i < unique.length; i += JUP_BATCH) {
    const batch = unique.slice(i, i + JUP_BATCH);
    try {
      const res = await fetch(`${JUP_SEARCH_URL}?query=${batch.join(",")}`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) continue;
      const rows = (await res.json()) as { id?: string; symbol?: string; usdPrice?: number }[];
      if (!Array.isArray(rows)) continue;
      // Keyed by id, not by position: the response order does not follow the query.
      for (const r of rows) {
        if (r?.id) out.set(r.id, { symbol: r.symbol, usdPrice: r.usdPrice });
      }
    } catch {
      // Leave this batch unpriced.
    }
  }
  return out;
}

export function closeAccountIx(view: TokenAccountView, owner: PublicKey) {
  return createCloseAccountInstruction(
    new PublicKey(view.pubkey),
    owner, // rent (and any unwrapped SOL) goes back to the wallet itself
    owner,
    [],
    new PublicKey(view.programId),
  );
}

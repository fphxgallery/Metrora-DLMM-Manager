import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  NATIVE_MINT,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import BN from "bn.js";
import { existsSync, statSync } from "node:fs";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import { loadKeypairFile } from "../wallet/keystore.js";
import { DLMM, type DlmmPool } from "./sdk.js";

/** How long a cached pool's on-chain state is considered fresh. */
const POOL_STATE_TTL_MS = 5_000;

/**
 * How hard to look for a transaction that has just confirmed.
 *
 * Confirmation and queryability are not the same thing — the RPC node answering
 * the lookup may still be catching up. Worth several seconds of patience, because
 * the alternative to an answer here is stranding the swap proceeds.
 */
const TX_LOOKUP_ATTEMPTS = 5;
const TX_LOOKUP_DELAY_MS = 1_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface CachedPool {
  pool: DlmmPool;
  refreshedAt: number;
  /** Guards against N concurrent callers all triggering refetchStates(). */
  refreshing?: Promise<void>;
}

/**
 * Owns the RPC connection, the signing keypair, and a cache of DLMM pool
 * clients. `DLMM.create` is expensive (pool + bitmap + reserves + mints +
 * transfer hooks + clock), so instances are kept and refreshed in place with
 * `refetchStates()` rather than rebuilt per request.
 */
export class MeteoraClient {
  readonly connection: Connection;
  private pools = new Map<string, CachedPool>();
  private keypair?: Keypair;
  private keypairMtimeMs = 0;
  /** mint -> owning token program. Immutable on chain, so cached for the process. */
  private tokenPrograms = new Map<string, PublicKey>();

  constructor(
    private readonly cfg: Config,
    private readonly log: Logger,
  ) {
    this.connection = new Connection(cfg.rpcEndpoint, "confirmed");
  }

  /**
   * The signing keypair, or null when none exists yet. Re-read when the file
   * changes on disk so a wallet created or imported from the UI takes effect
   * without a restart.
   */
  wallet(): Keypair | null {
    const path = this.cfg.keypairPath;
    if (!existsSync(path)) {
      this.keypair = undefined;
      this.keypairMtimeMs = 0;
      return null;
    }
    const mtime = statSync(path).mtimeMs;
    if (!this.keypair || mtime !== this.keypairMtimeMs) {
      this.keypair = loadKeypairFile(path);
      this.keypairMtimeMs = mtime;
      this.log.info({ publicKey: this.keypair.publicKey.toBase58() }, "wallet loaded");
    }
    return this.keypair;
  }

  /** Throws with an actionable message rather than returning null. */
  requireWallet(): Keypair {
    const kp = this.wallet();
    if (!kp) {
      throw new Error(
        `no keypair at ${this.cfg.keypairPath} — create or import one (SETTINGS tab, or \`npm run wallet -- create\`)`,
      );
    }
    return kp;
  }

  async solBalance(owner?: PublicKey): Promise<number> {
    const pk = owner ?? this.wallet()?.publicKey;
    if (!pk) return 0;
    return (await this.connection.getBalance(pk)) / LAMPORTS_PER_SOL;
  }

  /**
   * Refuses to act when SOL is too low to pay fees and position/bin-array rent.
   * Called before anything that signs — a half-executed rebalance that runs out
   * of SOL between the withdraw and the deposit is the expensive failure mode.
   */
  async assertSolFunded(): Promise<void> {
    const bal = await this.solBalance();
    if (bal < this.cfg.minSolBalance) {
      throw new Error(
        `SOL balance ${bal.toFixed(4)} is below MIN_SOL_BALANCE ${this.cfg.minSolBalance} — fund the wallet before transacting`,
      );
    }
  }

  /**
   * Which token program owns a mint, read from the mint account itself.
   *
   * The ATA address depends on the token program: `getAssociatedTokenAddressSync`
   * puts the program id in the derivation seeds, so a Token-2022 mint derived
   * against the legacy program yields a DIFFERENT address — one that does not
   * exist. Reading it does not error, it returns zero.
   *
   * That silence is what makes guessing dangerous, and it cost money. CATE is a
   * Token-2022 mint; the buffer guard read a legacy-derived address, saw zero on
   * every single check, and bought another $2 of CATE before every rebalance —
   * 23 times, into the real Token-2022 account, where it piled up as ~$48 of idle
   * balance while the guard kept reporting an empty buffer.
   *
   * Cached because a mint's owner cannot change. Falls back to the caller's hint,
   * then to whatever `getAssociatedTokenAddressSync` defaults to, so an RPC
   * hiccup degrades to the old behaviour rather than throwing on the signing path.
   */
  async tokenProgramOf(mint: PublicKey, hint?: PublicKey): Promise<PublicKey | undefined> {
    if (hint) return hint;
    const key = mint.toBase58();
    const cached = this.tokenPrograms.get(key);
    if (cached) return cached;
    try {
      const info = await this.connection.getAccountInfo(mint);
      if (!info) return undefined;
      this.tokenPrograms.set(key, info.owner);
      return info.owner;
    } catch (e) {
      this.log.debug({ mint: key, err: e instanceof Error ? e.message : String(e) }, "token program lookup failed");
      return undefined;
    }
  }

  /**
   * Spendable wallet balance of one mint, in raw base units.
   *
   * Native SOL counts toward wrapped SOL: the SDK wraps on demand when a pool
   * side is wSOL, so the deposit budget is the wSOL token account plus native
   * SOL above the MIN_SOL_BALANCE reserve — never the whole native balance, or
   * a deposit would leave nothing for fees and rent.
   */
  async tokenBalance(mint: PublicKey, tokenProgramId?: PublicKey): Promise<BN> {
    const owner = this.wallet()?.publicKey;
    if (!owner) return new BN(0);

    let raw = new BN(0);
    const ata = getAssociatedTokenAddressSync(mint, owner, true, await this.tokenProgramOf(mint, tokenProgramId));
    try {
      const bal = await this.connection.getTokenAccountBalance(ata);
      raw = new BN(bal.value.amount);
    } catch {
      // No ATA yet — the deposit builders create one.
    }

    if (mint.equals(NATIVE_MINT)) {
      const lamports = await this.connection.getBalance(owner);
      const reserve = Math.floor(this.cfg.minSolBalance * LAMPORTS_PER_SOL);
      raw = raw.add(new BN(Math.max(0, lamports - reserve)));
    }
    return raw;
  }

  /**
   * What the token ACCOUNT holds, in raw base units — no native-SOL fold.
   *
   * The difference from `tokenBalance` matters for exactly one caller, and it is
   * the difference between a rebalance landing and failing. `tokenBalance` counts
   * native SOL toward wSOL because the swap path wraps on demand, so for sizing a
   * deposit that fold is right. But Meteora's `RebalanceLiquidity` transfers wSOL
   * straight OUT of this account to settle the deposit half, and it cannot wrap:
   * an empty wSOL ATA fails the whole instruction with "insufficient funds" even
   * on a wallet holding plenty of native SOL. Anything asking "can this account
   * be debited on chain right now" must use this, not `tokenBalance`.
   */
  async ataBalance(mint: PublicKey, tokenProgramId?: PublicKey): Promise<BN> {
    const owner = this.wallet()?.publicKey;
    if (!owner) return new BN(0);
    const ata = getAssociatedTokenAddressSync(mint, owner, true, await this.tokenProgramOf(mint, tokenProgramId));
    try {
      const bal = await this.connection.getTokenAccountBalance(ata);
      return new BN(bal.value.amount);
    } catch {
      // No ATA at all, which is the case this exists to catch — it reads as zero
      // rather than throwing, so the caller tops it up instead of giving up.
      return new BN(0);
    }
  }

  /**
   * What a landed transaction actually delivered to this wallet, in raw base units.
   *
   * Differencing two balance reads either side of a send cannot answer this
   * reliably. `sendVersioned` returns on confirmation, but the follow-up read is a
   * separate RPC call that may be served by a node one slot behind, in which case
   * it returns the PRE-swap balance and the difference comes out at zero. On
   * 2026-08-07 that stranded 0.39 SOL: the swap delivered it, the read said
   * nothing arrived, the deposit was skipped and the whole input was booked as a
   * 100% swap loss. See `runSwapLeg`.
   *
   * The transaction's own `meta` has no such race. It is the ledger's record of
   * what moved, fixed at the slot the transaction landed in, and it is what a
   * block explorer shows.
   *
   * Returns null when the answer is UNKNOWN — transaction not visible yet, or the
   * RPC gave a shape we cannot read. Null is not zero, and callers must not treat
   * it as such: zero means the swap really produced nothing, null means we failed
   * to find out, and only one of those is safe to act on.
   */
  async receivedInTx(signature: string, mint: PublicKey, tokenProgramId?: PublicKey): Promise<BN | null> {
    const owner = this.wallet()?.publicKey;
    if (!owner) return null;
    const ownerStr = owner.toBase58();
    const mintStr = mint.toBase58();

    // A transaction is routinely not queryable for a moment after it confirms, so
    // a single miss is expected rather than an error.
    let tx = null;
    for (let attempt = 1; attempt <= TX_LOOKUP_ATTEMPTS; attempt++) {
      try {
        tx = await this.connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 });
      } catch {
        tx = null;
      }
      if (tx?.meta) break;
      if (attempt < TX_LOOKUP_ATTEMPTS) await sleep(TX_LOOKUP_DELAY_MS);
    }
    if (!tx?.meta || tx.meta.err) return null;

    const sum = (rows: typeof tx.meta.preTokenBalances) =>
      (rows ?? [])
        .filter((b) => b.owner === ownerStr && b.mint === mintStr)
        .reduce((a, b) => a.add(new BN(b.uiTokenAmount.amount)), new BN(0));
    let delta = sum(tx.meta.postTokenBalances).sub(sum(tx.meta.preTokenBalances));

    if (mint.equals(NATIVE_MINT)) {
      /**
       * A swap into SOL usually unwraps: the wSOL account is opened, filled and
       * closed inside the one transaction, so BOTH its token balances are absent
       * and the proceeds appear only as native lamports. Reading the token side
       * alone reports zero on exactly the case that matters.
       *
       * The transaction fee is deliberately NOT added back. It really did leave
       * the wallet, so the net figure is what can actually be deposited; adding it
       * back would overstate the balance by the fee and risk a deposit that cannot
       * settle. It costs the cost measurement a few thousand lamports of accuracy,
       * in the conservative direction.
       */
      const keys = tx.transaction.message.accountKeys;
      const i = keys.findIndex((k) => k.pubkey.toBase58() === ownerStr);
      if (i < 0) return null;
      const pre = tx.meta.preBalances[i];
      const post = tx.meta.postBalances[i];
      if (pre === undefined || post === undefined) return null;
      delta = delta.add(new BN(post).sub(new BN(pre)));
    }

    return delta;
  }

  /**
   * Instructions that move native SOL into the wallet's wSOL ATA.
   *
   * Creating the ATA is not funding it — `createAssociatedTokenAccountIdempotent`
   * leaves a zero balance — so the transfer and the `syncNative` that books it
   * are both required for the account to be spendable.
   */
  wrapSolIxs(lamports: number): TransactionInstruction[] {
    const owner = this.requireWallet().publicKey;
    const ata = getAssociatedTokenAddressSync(NATIVE_MINT, owner, true);
    return [
      createAssociatedTokenAccountIdempotentInstruction(owner, ata, owner, NATIVE_MINT),
      SystemProgram.transfer({ fromPubkey: owner, toPubkey: ata, lamports }),
      createSyncNativeInstruction(ata),
    ];
  }

  /**
   * Idempotent create instructions for the wallet's tokenX/Y ATAs of a pool.
   *
   * `rebalancePosition()` (unlike the open/deposit builders) does not create
   * these itself — and wSOL ATAs in particular are commonly wrapped, used, and
   * closed within a single deposit tx, so a position that just opened can
   * already have a missing tokenX ATA by the time it's rebalanced. Prepend
   * these to a rebalance tx rather than assuming the ATA still exists.
   */
  ataIxs(pool: DlmmPool): TransactionInstruction[] {
    const owner = this.requireWallet().publicKey;
    const sides: { mint: PublicKey; program: PublicKey }[] = [
      { mint: pool.tokenX.publicKey, program: pool.tokenX.owner },
      { mint: pool.tokenY.publicKey, program: pool.tokenY.owner },
    ];
    return sides.map(({ mint, program }) => {
      const ata = getAssociatedTokenAddressSync(mint, owner, true, program);
      return createAssociatedTokenAccountIdempotentInstruction(owner, ata, owner, mint, program);
    });
  }

  /** A pool client with on-chain state no older than POOL_STATE_TTL_MS. */
  async getPool(address: string | PublicKey, opts: { fresh?: boolean } = {}): Promise<DlmmPool> {
    const key = typeof address === "string" ? address : address.toBase58();
    const cached = this.pools.get(key);

    if (!cached) {
      const pool = await DLMM.create(this.connection, new PublicKey(key), { cluster: this.cfg.cluster });
      this.pools.set(key, { pool, refreshedAt: Date.now() });
      return pool;
    }

    const stale = opts.fresh || Date.now() - cached.refreshedAt > POOL_STATE_TTL_MS;
    if (stale) {
      if (!cached.refreshing) {
        cached.refreshing = cached.pool
          .refetchStates()
          .then(() => {
            cached.refreshedAt = Date.now();
          })
          .finally(() => {
            cached.refreshing = undefined;
          });
      }
      await cached.refreshing;
    }
    return cached.pool;
  }

  /** Drops a pool from the cache — use after a transaction that changed it. */
  invalidate(address: string | PublicKey): void {
    this.pools.delete(typeof address === "string" ? address : address.toBase58());
  }
}

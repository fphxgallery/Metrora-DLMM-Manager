import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { NATIVE_MINT, getAssociatedTokenAddressSync } from "@solana/spl-token";
import BN from "bn.js";
import { existsSync, statSync } from "node:fs";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import { loadKeypairFile } from "../wallet/keystore.js";
import { DLMM, type DlmmPool } from "./sdk.js";

/** How long a cached pool's on-chain state is considered fresh. */
const POOL_STATE_TTL_MS = 5_000;

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
    const ata = getAssociatedTokenAddressSync(mint, owner, true, tokenProgramId);
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

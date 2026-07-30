import type { Config } from "../config.js";
import type { Logger } from "../logger.js";

// ---------------------------------------------------------------- types ----

export interface DataApiToken {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  is_verified: boolean;
  price: number;
}

export interface DataApiPool {
  address: string;
  name: string;
  token_x: DataApiToken;
  token_y: DataApiToken;
  pool_config: {
    bin_step: number;
    base_fee_pct: number;
    max_fee_pct: number;
    protocol_fee_pct: number;
    collect_fee_mode: number;
  };
  dynamic_fee_pct: number;
  tvl: number;
  current_price: number;
  apr: number;
  apy: number;
  has_farm: boolean;
  farm_apr: number;
  farm_apy: number;
  volume: Record<string, number>;
  fees: Record<string, number>;
  fee_tvl_ratio: Record<string, number>;
  is_blacklisted: boolean;
  created_at: number;
  tags: string[];
}

export interface PoolsResponse {
  total: number;
  pages: number;
  current_page: number;
  page_size: number;
  data: DataApiPool[];
}

export interface TokenAmountWithUsd {
  amount: string;
  usd: string;
  amountSol: string;
}

export interface TokenPairWithTotal {
  tokenX: TokenAmountWithUsd;
  tokenY: TokenAmountWithUsd;
  total: { usd: string; sol: string };
}

export interface PositionPnL {
  positionAddress: string;
  lowerBinId: number;
  upperBinId: number;
  minPrice: string;
  maxPrice: string;
  pnlUsd: string;
  pnlPctChange: string;
  allTimeDeposits: TokenPairWithTotal;
  allTimeWithdrawals: TokenPairWithTotal;
  allTimeFees: TokenPairWithTotal;
  feePerTvl24h: string;
  isClosed: boolean;
  isOutOfRange?: boolean | null;
  createdAt?: number | null;
  closedAt?: number | null;
  poolActiveBinId?: number | null;
  poolActivePrice?: string | null;
}

export interface PositionPnLResponse {
  positions: PositionPnL[];
  /** True when more pages of this wallet's positions remain in this pool. */
  hasNext?: boolean;
  totalCount?: number;
  [k: string]: unknown;
}

// --------------------------------------------------------------- client ----

/**
 * The SOL/USDC reference pool is identified by MINT ADDRESS, never by name.
 * Pool names come from token metadata, which anyone can set: a `query=SOL-USDC`
 * name search returns ~123 pools, 13 of which are not SOL/USDC at all
 * ("USDT sol-USDC", "SOL-USDC-USDT", …) and price at 0.
 */
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** Cache entries kept before the oldest is dropped. */
const MAX_CACHE_ENTRIES = 200;
/** Stop paging PnL here, so a bad `hasNext` can never loop forever. */
const MAX_PNL_PAGES = 10;

interface CacheEntry {
  at: number;
  value: unknown;
}

/**
 * Read-only client for Meteora's indexed DLMM data.
 *
 * Two guards, because the documented budget is 30 req/s and the dashboard
 * polls: a short TTL cache keyed on the full path, and in-flight de-duplication
 * so N concurrent callers asking for the same path make one request.
 */
export class DataApi {
  private cache = new Map<string, CacheEntry>();
  private inflight = new Map<string, Promise<unknown>>();
  /** Last SOL price that passed the mint check — see solPriceUsd(). */
  private lastSolPriceUsd = 0;

  constructor(
    private readonly cfg: Config,
    private readonly log: Logger,
  ) {}

  private async fetchJson<T>(path: string, ttlMs: number): Promise<T> {
    const now = Date.now();
    const hit = this.cache.get(path);
    if (hit && now - hit.at < ttlMs) return hit.value as T;

    const pending = this.inflight.get(path);
    if (pending) return pending as Promise<T>;

    const url = `${this.cfg.dataApiUrl}${path}`;
    const p = (async () => {
      const res = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`data api ${res.status} for ${path}: ${body.slice(0, 200)}`);
      }
      const json = (await res.json()) as T;
      // delete-then-set so the key moves to the end: Map preserves insertion
      // order, and re-setting in place would leave a hot path looking like the
      // oldest entry and get it evicted first.
      this.cache.delete(path);
      this.cache.set(path, { at: Date.now(), value: json });
      // Keyed on the full path, including arbitrary pool-search query strings,
      // so this grows without bound in a long-running process otherwise.
      while (this.cache.size > MAX_CACHE_ENTRIES) {
        const oldest = this.cache.keys().next().value;
        if (oldest === undefined) break;
        this.cache.delete(oldest);
      }
      return json;
    })();

    this.inflight.set(path, p);
    try {
      return await p;
    } catch (e) {
      // Serve a stale hit rather than failing the page when the API blips.
      if (hit) {
        this.log.warn({ path, err: e instanceof Error ? e.message : String(e) }, "data api failed — serving stale cache");
        return hit.value as T;
      }
      throw e;
    } finally {
      this.inflight.delete(path);
    }
  }

  /**
   * Pool search. `sort_by` and `filter_by` are passed through to the API — see
   * its docs for the grammar (`volume_24h:desc`, `tvl>10000 && is_blacklisted=false`).
   */
  async pools(params: {
    query?: string;
    sortBy?: string;
    filterBy?: string;
    page?: number;
    pageSize?: number;
  }): Promise<PoolsResponse> {
    const qs = new URLSearchParams();
    if (params.query?.trim()) qs.set("query", params.query.trim());
    qs.set("sort_by", params.sortBy?.trim() || "volume_24h:desc");
    if (params.filterBy?.trim()) qs.set("filter_by", params.filterBy.trim());
    qs.set("page", String(Math.max(1, params.page ?? 1)));
    qs.set("page_size", String(Math.min(100, Math.max(1, params.pageSize ?? 25))));
    return this.fetchJson<PoolsResponse>(`/pools?${qs}`, this.cfg.dataApiCacheMs);
  }

  async pool(address: string): Promise<DataApiPool> {
    return this.fetchJson<DataApiPool>(`/pools/${address}`, this.cfg.dataApiCacheMs);
  }

  /**
   * PnL for a wallet's positions in one pool. Indexed from historical events, so
   * a position opened seconds ago may not appear yet — callers must treat a
   * missing entry as "no PnL data yet", not as "no position".
   */
  async positionPnl(poolAddress: string, user: string): Promise<PositionPnL[]> {
    const out: PositionPnL[] = [];
    // Pages rather than taking the first 100: a wallet with more positions than
    // that in one pool would silently lose the rest, and the caller reads a
    // missing entry as "not indexed yet" — indistinguishable from truncation.
    for (let page = 1; page <= MAX_PNL_PAGES; page++) {
      const qs = new URLSearchParams({ user, page: String(page), page_size: "100" });
      const res = await this.fetchJson<PositionPnLResponse>(
        `/positions/${poolAddress}/pnl?${qs}`,
        this.cfg.dataApiCacheMs,
      );
      const batch = Array.isArray(res.positions) ? res.positions : [];
      out.push(...batch);
      if (!res.hasNext || batch.length === 0) break;
      if (page === MAX_PNL_PAGES) {
        this.log.warn({ poolAddress, fetched: out.length }, "pnl paging hit its cap — results truncated");
      }
    }
    return out;
  }

  /**
   * SOL/USD, for turning lamport costs (fees, rent) into the same units as the
   * fee income they are weighed against. Read off the deepest real SOL-USDC pool
   * and cached for a minute — a cost guard does not need tick-level precision.
   *
   * Selected by mint address on both sides, and the mints are re-checked on the
   * response. `filter_by` returns an EMPTY SET for a field it does not
   * recognise rather than erroring, so an upstream rename would otherwise
   * silently degrade this to "whatever pool came back first".
   */
  async solPriceUsd(): Promise<number> {
    const qs = new URLSearchParams({
      filter_by: `token_x=${WSOL_MINT} && token_y=${USDC_MINT}`,
      sort_by: "tvl:desc",
      page_size: "5",
    });
    try {
      const res = await this.fetchJson<PoolsResponse>(`/pools?${qs}`, 60_000);
      const pool = res.data?.find(
        (p) => p.token_x.address === WSOL_MINT && p.token_y.address === USDC_MINT,
      );
      const price = pool?.token_x.price ?? 0;
      if (Number.isFinite(price) && price > 0) {
        this.lastSolPriceUsd = price;
        return price;
      }
      this.log.warn({ returned: res.data?.length ?? 0 }, "no verified SOL-USDC pool in the data api response");
    } catch (e) {
      this.log.warn({ err: e instanceof Error ? e.message : String(e) }, "sol price lookup failed");
    }
    // Returning 0 here would zero `estCostUsd`, which Engine.costGuard reads as
    // "no USD pricing available" and SKIPS — turning a data-api outage into
    // unlimited rebalancing. The last verified price is a far better guess; 0
    // only ever survives if a price was never once read (or on devnet, where
    // these mints don't exist and there are no real funds to protect).
    return this.lastSolPriceUsd;
  }

  /** Best-effort PnL lookup — never fails the caller, just returns nothing. */
  async positionPnlSafe(poolAddress: string, user: string): Promise<PositionPnL[]> {
    try {
      return await this.positionPnl(poolAddress, user);
    } catch (e) {
      this.log.debug({ poolAddress, err: e instanceof Error ? e.message : String(e) }, "pnl lookup failed");
      return [];
    }
  }
}

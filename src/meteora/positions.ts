import BN from "bn.js";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { ManagedPosition, Store } from "../state.js";
import type { DataApi, DataApiPool, PositionPnL } from "./datapi.js";
import type { MeteoraClient } from "./client.js";
import { DLMM, type DlmmPool, type PositionData } from "./sdk.js";
import { priceOfBin, rangeStatus, toUi, valuePosition } from "./pricing.js";
import { feeRateSeries, realizedFeeRate, sinceOpenFeeRate, type FeeRate } from "../metrics.js";
import type { PnlSample, SampleLog } from "../history.js";

/** Window the position fee rate is measured over when there is enough history. */
const RATE_WINDOW_MS = 86_400_000;
/** Trend bucket. Wider than the sample interval, or buckets alternate 1 sample / 0. */
const RATE_BUCKET_MS = 3_600_000;
/** Below this much sampled history the lifetime average is the better estimate. */
const MIN_REALIZED_HOURS = 1;

export interface PositionView {
  positionPk: string;
  poolAddress: string;
  pairName: string;
  binStep: number;
  tokenX: { mint: string; symbol: string; decimals: number; priceUsd: number };
  tokenY: { mint: string; symbol: string; decimals: number; priceUsd: number };

  lowerBinId: number;
  upperBinId: number;
  activeBinId: number;
  minPrice: number;
  maxPrice: number;
  activePrice: number;

  inRange: boolean;
  binsToEdge: number;
  pctThroughRange: number;
  widthBins: number;

  amountX: number;
  amountY: number;
  feeX: number;
  feeY: number;
  /** Position value (fees included) in token Y, and in USD. */
  valueInY: number;
  valueUsd: number;
  feesUsd: number;
  /** valueX / total, in bps. 0 or 10000 means fully drifted to one side. */
  ratioBps: number;

  managed: {
    auto: boolean;
    rangeBins?: number;
    strategyType?: string;
    edgeBufferBins?: number;
    cooldownMin?: number;
    rebalanceCount: number;
    lastRebalanceAt?: number;
    openedAt: number;
    timeInRangePct: number | null;
  } | null;

  pnl: {
    pnlUsd: number;
    pnlPctChange: number;
    allTimeFeesUsd: number;
  } | null;

  /**
   * Fee income as a rate, so it can be judged rather than just read.
   *
   * `position` is what this position earned; `poolPctPer24h` is the pool's own
   * `fee_tvl_ratio["24h"]` for the same measure. Below the pool means this position
   * is earning less than a passive LP in the same pool while still paying rebalance
   * costs — the failure mode that is otherwise invisible.
   */
  feeRate: {
    position: FeeRate | null;
    poolPctPer24h: number | null;
    /** Per-bucket rates for a trend line, oldest first. */
    trend: number[];
  };
}

/**
 * Reads every DLMM position the wallet owns and enriches it with pool metadata,
 * indexed PnL, and this app's own management record.
 *
 * On-chain state is the source of truth for what exists and where the bins are;
 * the Data API only supplies derived numbers (USD prices, PnL). A position that
 * the indexer has not caught up with still shows up, with `pnl: null`.
 */
export async function listPositions(deps: {
  cfg: Config;
  client: MeteoraClient;
  dataApi: DataApi;
  store: Store;
  samples: SampleLog;
  log: Logger;
}): Promise<PositionView[]> {
  const { cfg, client, dataApi, store, samples, log } = deps;
  const kp = client.wallet();
  if (!kp) return [];

  // One read for every position, rather than one per position: the log is parsed
  // and cached whole, but filtering it per position is cheap.
  const now = Date.now();
  const sampleRows = samples.read(now - RATE_WINDOW_MS);

  const byPool = await DLMM.getAllLbPairPositionsByUser(client.connection, kp.publicKey, {
    cluster: cfg.cluster,
  });

  const views: PositionView[] = [];
  for (const [poolAddress, info] of byPool) {
    if (info.lbPairPositionsData.length === 0) continue;

    // Pool metadata and PnL are per-pool; fetch once and reuse for every
    // position in that pool. Both are best-effort — a pool missing from the
    // indexer must not hide a real on-chain position.
    const [meta, pnls] = await Promise.all([
      dataApi.pool(poolAddress).catch((e) => {
        log.debug({ poolAddress, err: String(e) }, "pool metadata lookup failed");
        return null;
      }),
      dataApi.positionPnlSafe(poolAddress, kp.publicKey.toBase58()),
    ]);

    const pool = await client.getPool(poolAddress);
    const activeBinId = pool.lbPair.activeId;

    for (const p of info.lbPairPositionsData) {
      views.push(
        buildView({
          poolAddress,
          pool,
          meta,
          pnl: pnls.find((x) => x.positionAddress === p.publicKey.toBase58()) ?? null,
          positionPk: p.publicKey.toBase58(),
          data: p.positionData,
          activeBinId,
          managed: store.position(p.publicKey.toBase58()) ?? null,
          samples: sampleRows.filter((s) => s.positionPk === p.publicKey.toBase58()),
          now,
        }),
      );
    }
  }

  // Out-of-range first: those are the ones earning nothing and needing action.
  views.sort((a, b) => Number(a.inRange) - Number(b.inRange) || b.valueUsd - a.valueUsd);
  return views;
}

function buildView(args: {
  poolAddress: string;
  pool: DlmmPool;
  meta: DataApiPool | null;
  pnl: PositionPnL | null;
  positionPk: string;
  data: PositionData;
  activeBinId: number;
  managed: ManagedPosition | null;
  samples: PnlSample[];
  now: number;
}): PositionView {
  const { pool, meta, data, activeBinId, managed, pnl, samples, now } = args;

  const decimalsX = pool.tokenX.mint.decimals;
  const decimalsY = pool.tokenY.mint.decimals;
  const activePrice = priceOfBin(pool, activeBinId);

  // Fees are part of what a rebalance redeposits, so value the position with
  // them included — the trigger's cost/benefit check compares against this.
  const amountXRaw = new BN(data.totalXAmount).add(data.feeX);
  const amountYRaw = new BN(data.totalYAmount).add(data.feeY);
  const value = valuePosition({
    amountXRaw,
    amountYRaw,
    decimalsX,
    decimalsY,
    priceXinY: activePrice,
  });

  const priceUsdX = meta?.token_x.price ?? 0;
  const priceUsdY = meta?.token_y.price ?? 0;
  const feeX = toUi(data.feeX, decimalsX);
  const feeY = toUi(data.feeY, decimalsY);
  const status = rangeStatus(activeBinId, data.lowerBinId, data.upperBinId);

  return {
    positionPk: args.positionPk,
    poolAddress: args.poolAddress,
    pairName: meta?.name ?? `${pool.tokenX.publicKey.toBase58().slice(0, 4)}…`,
    binStep: pool.lbPair.binStep,
    tokenX: {
      mint: pool.tokenX.publicKey.toBase58(),
      symbol: meta?.token_x.symbol ?? "X",
      decimals: decimalsX,
      priceUsd: priceUsdX,
    },
    tokenY: {
      mint: pool.tokenY.publicKey.toBase58(),
      symbol: meta?.token_y.symbol ?? "Y",
      decimals: decimalsY,
      priceUsd: priceUsdY,
    },

    lowerBinId: data.lowerBinId,
    upperBinId: data.upperBinId,
    activeBinId,
    minPrice: priceOfBin(pool, data.lowerBinId),
    maxPrice: priceOfBin(pool, data.upperBinId),
    activePrice,

    inRange: status.inRange,
    binsToEdge: status.binsToEdge,
    pctThroughRange: status.pctThroughRange,
    widthBins: status.width,

    amountX: value.amountX,
    amountY: value.amountY,
    feeX,
    feeY,
    valueInY: value.total,
    valueUsd: value.amountX * priceUsdX + value.amountY * priceUsdY,
    feesUsd: feeX * priceUsdX + feeY * priceUsdY,
    ratioBps: value.ratioBps,

    managed: managed
      ? {
          auto: managed.auto,
          rangeBins: managed.rangeBins,
          strategyType: managed.strategyType,
          edgeBufferBins: managed.edgeBufferBins,
          cooldownMin: managed.cooldownMin,
          rebalanceCount: managed.rebalanceCount,
          lastRebalanceAt: managed.lastRebalanceAt,
          openedAt: managed.openedAt,
          timeInRangePct:
            managed.pollsTotal > 0 ? (managed.pollsInRange / managed.pollsTotal) * 100 : null,
        }
      : null,

    pnl: pnl
      ? {
          pnlUsd: Number(pnl.pnlUsd),
          pnlPctChange: Number(pnl.pnlPctChange),
          allTimeFeesUsd: Number(pnl.allTimeFees?.total?.usd ?? 0),
        }
      : null,

    feeRate: buildFeeRate({
      samples,
      valueUsd: value.amountX * priceUsdX + value.amountY * priceUsdY,
      allTimeFeesUsd: Number(pnl?.allTimeFees?.total?.usd ?? 0),
      openedAt: managed?.openedAt,
      meta,
      now,
    }),
  };
}

/**
 * Prefers what the position actually earned over what it earned on average.
 *
 * The realized figure needs sampled history, which a fresh install does not have —
 * the Data API has no historical endpoint, so nothing can backfill it. Until then
 * the lifetime average from the indexer's all-time fees stands in, labelled as such
 * so a reading measured over three days is never presented as a 24h rate.
 */
function buildFeeRate(args: {
  samples: PnlSample[];
  valueUsd: number;
  allTimeFeesUsd: number;
  openedAt?: number;
  meta: DataApiPool | null;
  now: number;
}): PositionView["feeRate"] {
  const { samples, valueUsd, allTimeFeesUsd, openedAt, meta, now } = args;
  const windowed = samples.filter((s) => s.ts >= now - RATE_WINDOW_MS);
  const realized = realizedFeeRate(windowed, valueUsd);
  const position =
    realized && realized.hours >= MIN_REALIZED_HOURS
      ? realized
      : openedAt !== undefined
        ? sinceOpenFeeRate(allTimeFeesUsd, valueUsd, openedAt, now)
        : realized;

  // Verified against a live response: fees["24h"] / tvl reproduces this exactly, so
  // it is already a PERCENT per 24 hours and directly comparable to the above.
  const poolRatio = meta?.fee_tvl_ratio?.["24h"];

  return {
    position,
    poolPctPer24h: typeof poolRatio === "number" && Number.isFinite(poolRatio) ? poolRatio : null,
    trend: feeRateSeries(windowed, valueUsd, RATE_BUCKET_MS),
  };
}

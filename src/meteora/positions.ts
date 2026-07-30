import BN from "bn.js";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { ManagedPosition, Store } from "../state.js";
import type { DataApi, DataApiPool, PositionPnL } from "./datapi.js";
import type { MeteoraClient } from "./client.js";
import { DLMM, type DlmmPool, type PositionData } from "./sdk.js";
import { priceOfBin, rangeStatus, toUi, valuePosition } from "./pricing.js";
import { positionFeeTvlPct, sinceOpenFeeRate } from "../metrics.js";

/**
 * How far the lifetime average may diverge from the indexer's rate before it is
 * worth a log line. They measure different windows, so they will never agree
 * closely — this is a tripwire for the indexer's field changing meaning, not a
 * consistency check.
 */
const RATE_DISAGREEMENT_FACTOR = 5;

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
   * Both figures are percent of value per 24h. `positionPctPer24h` is the indexer's
   * `feePerTvl24h` for this position; `poolPctPer24h` is the pool's own
   * `fee_tvl_ratio["24h"]`. Below the pool means this position is earning less than
   * a passive LP in the same pool while still paying rebalance costs — the failure
   * mode that is otherwise invisible.
   */
  feeRate: {
    positionPctPer24h: number | null;
    poolPctPer24h: number | null;
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
  log: Logger;
}): Promise<PositionView[]> {
  const { cfg, client, dataApi, store, log } = deps;
  const kp = client.wallet();
  if (!kp) return [];

  const now = Date.now();

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
          now,
          log,
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
  now: number;
  log: Logger;
}): PositionView {
  const { pool, meta, data, activeBinId, managed, pnl, now, log } = args;

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
      pnl,
      valueUsd: value.amountX * priceUsdX + value.amountY * priceUsdY,
      openedAt: managed?.openedAt,
      meta,
      now,
      log,
      positionPk: args.positionPk,
    }),
  };
}

/**
 * The indexer's per-position rate, beside the pool's own.
 *
 * Both are percent of value per 24h. The pool figure was verified against a live
 * response: `fees["24h"] / tvl` reproduces `fee_tvl_ratio["24h"]` exactly, so it is
 * already a percent and directly comparable.
 */
function buildFeeRate(args: {
  pnl: PositionPnL | null;
  valueUsd: number;
  openedAt?: number;
  meta: DataApiPool | null;
  now: number;
  log: Logger;
  positionPk: string;
}): PositionView["feeRate"] {
  const { pnl, valueUsd, openedAt, meta, now, log, positionPk } = args;
  const positionPctPer24h = positionFeeTvlPct(pnl?.feePerTvl24h);
  const poolRatio = meta?.fee_tvl_ratio?.["24h"];

  // Cross-check, logged and never shown. The lifetime average is computed from a
  // different field over a different window, so it cannot validate the indexer's
  // rate — but an order-of-magnitude divergence would catch feePerTvl24h changing
  // units or meaning, which is how this codebase has been bitten before.
  if (positionPctPer24h != null && openedAt !== undefined) {
    const lifetime = sinceOpenFeeRate(
      Number(pnl?.allTimeFees?.total?.usd ?? 0),
      valueUsd,
      openedAt,
      now,
    );
    if (lifetime && lifetime.pctPer24h > 0) {
      const factor = positionPctPer24h / lifetime.pctPer24h;
      if (factor > RATE_DISAGREEMENT_FACTOR || factor < 1 / RATE_DISAGREEMENT_FACTOR) {
        log.debug(
          { positionPk, feePerTvl24h: positionPctPer24h, lifetimePct: lifetime.pctPer24h, factor },
          "position fee rate disagrees with the lifetime average by more than an order of magnitude",
        );
      }
    }
  }

  return {
    positionPctPer24h,
    poolPctPer24h: typeof poolRatio === "number" && Number.isFinite(poolRatio) ? poolRatio : null,
  };
}

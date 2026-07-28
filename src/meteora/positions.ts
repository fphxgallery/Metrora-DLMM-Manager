import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { ManagedPosition, Store } from "../state.js";
import type { DataApi, DataApiPool, PositionPnL } from "./datapi.js";
import type { MeteoraClient } from "./client.js";
import { DLMM, type DlmmPool, type PositionData } from "./sdk.js";
import { priceOfBin, rangeStatus, toUi, valuePosition } from "./pricing.js";

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
    timeInRangePct: number | null;
  } | null;

  pnl: {
    pnlUsd: number;
    pnlPctChange: number;
    allTimeFeesUsd: number;
    createdAt?: number | null;
  } | null;
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
        }),
      );
    }
  }

  // Out-of-range first: those are the ones earning nothing and needing action.
  views.sort((a, b) => Number(a.inRange) - Number(b.inRange) || b.valueUsd - a.valueUsd);
  return views;
}

/** Reads one position by pubkey. Needs its pool address (positions are per-pool). */
export async function getPositionView(
  deps: { cfg: Config; client: MeteoraClient; dataApi: DataApi; store: Store; log: Logger },
  poolAddress: string,
  positionPk: string,
): Promise<PositionView | null> {
  const { client, dataApi, store, log } = deps;
  const kp = client.wallet();
  if (!kp) return null;

  const pool = await client.getPool(poolAddress, { fresh: true });
  let data: PositionData;
  try {
    data = (await pool.getPosition(new PublicKey(positionPk))).positionData;
  } catch (e) {
    log.debug({ positionPk, err: String(e) }, "position not found on chain");
    return null;
  }

  const [meta, pnls] = await Promise.all([
    dataApi.pool(poolAddress).catch(() => null),
    dataApi.positionPnlSafe(poolAddress, kp.publicKey.toBase58()),
  ]);

  return buildView({
    poolAddress,
    pool,
    meta,
    pnl: pnls.find((x) => x.positionAddress === positionPk) ?? null,
    positionPk,
    data,
    activeBinId: pool.lbPair.activeId,
    managed: store.position(positionPk) ?? null,
  });
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
}): PositionView {
  const { pool, meta, data, activeBinId, managed, pnl } = args;

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
          timeInRangePct:
            managed.pollsTotal > 0 ? (managed.pollsInRange / managed.pollsTotal) * 100 : null,
        }
      : null,

    pnl: pnl
      ? {
          pnlUsd: Number(pnl.pnlUsd),
          pnlPctChange: Number(pnl.pnlPctChange),
          allTimeFeesUsd: Number(pnl.allTimeFees?.total ?? 0),
          createdAt: pnl.createdAt,
        }
      : null,
  };
}

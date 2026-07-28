import BN from "bn.js";
import type { DlmmPool } from "./sdk.js";
import { getPriceOfBinByBinId } from "./sdk.js";

/** Raw base units -> human units. */
export function toUi(raw: BN | string | number, decimals: number): number {
  const s = typeof raw === "object" ? raw.toString() : String(raw);
  return Number(s) / 10 ** decimals;
}

/** Human units -> raw base units, truncated (never rounds up past the balance). */
export function toRaw(ui: number, decimals: number): BN {
  if (!Number.isFinite(ui) || ui <= 0) return new BN(0);
  // Via a fixed-point string: `ui * 10**decimals` loses precision for 9-decimal
  // mints at realistic sizes, and Number->BN would then be silently wrong.
  //
  // Format with spare digits and cut, rather than toFixed(decimals) — that
  // ROUNDS, so a value one unit under the wallet balance would round up to more
  // than the wallet holds and the deposit would fail at simulation.
  const [whole, frac = ""] = ui.toFixed(decimals + 3).split(".");
  return new BN(whole + frac.slice(0, decimals).padEnd(decimals, "0"));
}

/** UI price of token X in token Y, for a bin id. */
export function priceOfBin(pool: DlmmPool, binId: number): number {
  const perLamport = getPriceOfBinByBinId(binId, pool.lbPair.binStep);
  return Number(pool.fromPricePerLamport(Number(perLamport)));
}

/** Half-width in bins -> [min, max] around the active bin. */
export function rangeAround(activeBinId: number, rangeBins: number): { minBinId: number; maxBinId: number } {
  return { minBinId: activeBinId - rangeBins, maxBinId: activeBinId + rangeBins };
}

export interface PositionValue {
  /** Human-unit token amounts, fees included. */
  amountX: number;
  amountY: number;
  /** Value of each side denominated in token Y. */
  valueX: number;
  valueY: number;
  total: number;
  /** valueX / total, in bps. 5000 = a balanced two-sided position. */
  ratioBps: number;
}

/**
 * Values a position in token-Y terms at the given price. Used to decide whether
 * a rebalance needs a swap leg: a position that has drifted fully through its
 * range holds only one token, so its ratio sits at 0 or 10000 bps.
 */
export function valuePosition(args: {
  amountXRaw: BN | string;
  amountYRaw: BN | string;
  decimalsX: number;
  decimalsY: number;
  priceXinY: number;
}): PositionValue {
  const amountX = toUi(args.amountXRaw, args.decimalsX);
  const amountY = toUi(args.amountYRaw, args.decimalsY);
  const valueX = amountX * args.priceXinY;
  const valueY = amountY;
  const total = valueX + valueY;
  const ratioBps = total > 0 ? Math.round((valueX / total) * 10_000) : 5_000;
  return { amountX, amountY, valueX, valueY, total, ratioBps };
}

/**
 * How far the active bin sits inside a position's range.
 *
 * `binsToEdge` is negative once the active bin has left the range, which is what
 * the out-of-range trigger keys on; `pctThroughRange` is 0 at the lower edge and
 * 100 at the upper edge, for the UI's range bar.
 */
export function rangeStatus(activeBinId: number, minBinId: number, maxBinId: number) {
  const inRange = activeBinId >= minBinId && activeBinId <= maxBinId;
  const binsToEdge = Math.min(activeBinId - minBinId, maxBinId - activeBinId);
  const width = Math.max(1, maxBinId - minBinId);
  const pctThroughRange = ((activeBinId - minBinId) / width) * 100;
  return { inRange, binsToEdge, pctThroughRange, width: width + 1 };
}

import type { ManagedPosition, RebalanceRecord } from "./state.js";

/**
 * Splits the cost ledger into positions still managed and positions since closed.
 *
 * The "does the automation pay?" comparison is only meaningful if cost and fee
 * income describe the SAME positions. Fee income can only be read for a position
 * we still manage — the indexer has nothing to say about one that no longer
 * exists — while the ledger keeps every record forever. Summing all of it against
 * fees from the current position compared a closed position's spending with a new
 * position's earnings, which made NET read negative before the new position had
 * rebalanced even once.
 *
 * Retired records are returned rather than dropped: closing a position must not
 * quietly erase what it cost.
 */
export function partitionRebalances(
  all: RebalanceRecord[],
  positions: Pick<ManagedPosition, "positionPk">[],
): { managed: RebalanceRecord[]; retired: RebalanceRecord[] } {
  const pks = new Set(positions.map((p) => p.positionPk));
  const managed: RebalanceRecord[] = [];
  const retired: RebalanceRecord[] = [];
  for (const r of all) (pks.has(r.positionPk) ? managed : retired).push(r);
  return { managed, retired };
}

/**
 * The shortest cooldown in force across the managed positions.
 *
 * Churn is a position rebalancing as soon as it is permitted to, so judging a gap
 * as "short" only means anything relative to the cooldown that gap was subject to
 * — against a fixed number the same reading is alarming on a 60-minute cooldown
 * and unremarkable on a 5-minute one. Per-position overrides win over the global
 * default, and the smallest is taken because it is the most permissive.
 */
export function cooldownFloor(
  positions: Pick<ManagedPosition, "cooldownMin">[],
  globalCooldownMin: number,
): number {
  const each = positions.map((p) => p.cooldownMin ?? globalCooldownMin);
  return each.length > 0 ? Math.min(...each) : globalCooldownMin;
}

/**
 * Whether the rebalance cadence looks like churn.
 *
 * True when the median gap is at or under 1.5x the cooldown: the position is
 * re-centring about as fast as it is allowed to, which means the cooldown is the
 * only thing holding it back and the range itself is too tight. The 5-minute floor
 * covers `COOLDOWN_MIN=0`, where every gap would otherwise qualify.
 */
export function isChurning(medianGapMin: number | null, cooldownMin: number): boolean {
  if (medianGapMin == null) return false;
  return medianGapMin <= Math.max(cooldownMin * 1.5, 5);
}

/**
 * A position's fee income expressed as a rate: percent of position value per 24h.
 *
 * The comparable figure is the pool's own `fee_tvl_ratio["24h"]`, which is also a
 * percent per 24 hours (verified against a live response: fees24h / tvl reproduces
 * it exactly). Above the pool's rate means the range is concentrated where the
 * volume is; below it means the position is earning less than a passive LP in the
 * same pool would, while still paying rebalance costs.
 */
export interface FeeRate {
  pctPer24h: number;
  /** Hours the figure was actually measured over — a 6h reading is not a 24h one. */
  hours: number;
  /**
   * A lifetime average: all-time fees over the position's whole life. Understates a
   * position that has lately been in range, because it averages in every period the
   * position sat outside it. Used only as a cross-check on the indexer's own rate.
   */
  basis: "since-open";
}

/** Under a quarter of an hour of history, the rate is noise scaled by 96. */
const MIN_RATE_HOURS = 0.25;

/**
 * The indexer's own per-position 24h fee/TVL, parsed from its string form.
 *
 * Preferred over anything derived from the sample log. `allTimeFees` does not
 * accrue continuously — measured on a live position, 20 of 23 fifteen-minute
 * intervals moved by exactly zero while the position was in range the whole time,
 * so a rate differenced from it reports when the indexer's number happened to jump
 * rather than what the position earned. This field has no such problem, needs no
 * history, and is the figure Meteora's own UI shows.
 *
 * Note it is the indexer's ESTIMATE of a 24h rate, not a measurement over 24 hours:
 * an 8-hour-old position still reports one.
 */
export function positionFeeTvlPct(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  // Every numeric field on this response is a string, so a non-numeric value means
  // the shape changed rather than that the rate is zero.
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/** Lifetime average, kept as an independent cross-check on the indexer's figure. */
export function sinceOpenFeeRate(
  allTimeFeesUsd: number,
  valueUsd: number,
  openedAt: number,
  now: number,
): FeeRate | null {
  if (!(valueUsd > 0) || !(allTimeFeesUsd >= 0)) return null;
  const hours = (now - openedAt) / 3_600_000;
  if (hours < MIN_RATE_HOURS) return null;
  return { pctPer24h: (allTimeFeesUsd / valueUsd) * (24 / hours) * 100, hours, basis: "since-open" };
}

/** Total lamports a set of rebalances consumed: network + priority fees, plus sunk bin-array rent. */
export function lamportsOf(rs: RebalanceRecord[]): number {
  return rs.reduce((a, r) => a + r.costLamports + r.rentLamports, 0);
}

/**
 * What the swap legs cost, in USD.
 *
 * Kept separate from `lamportsOf` because it is not a lamport figure and does
 * not convert at the SOL price — it is a loss taken in the pool's own tokens at
 * the moment of the swap, already priced then.
 *
 * This is usually the LARGER of the two. Network fees for a path-B rebalance run
 * around a cent; the AMM fees on a four-figure swap run to tens of cents. A
 * ledger counting only lamports reports a rebalance as nearly free.
 *
 * Records written before the measurement existed carry no figure and contribute
 * zero — they are undercounted, not wrong, and `swapCostCoverage` says how many.
 */
export function swapCostUsdOf(rs: RebalanceRecord[]): number {
  return rs.reduce((a, r) => a + (r.swapCostUsd ?? 0), 0);
}

/**
 * How much of the cost ledger actually has its swap cost measured.
 *
 * Reported so the dashboard can say "this figure is still incomplete" rather
 * than quietly presenting a mixed ledger as a total.
 */
export function swapCostCoverage(rs: RebalanceRecord[]): { measured: number; swaps: number } {
  const swaps = rs.filter((r) => r.path === "B");
  return { measured: swaps.filter((r) => r.swapCostUsd != null).length, swaps: swaps.length };
}

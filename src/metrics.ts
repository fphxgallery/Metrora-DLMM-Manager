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
   * `realized` is what this position genuinely earned over the sampled window.
   * `since-open` is a lifetime average, used until there is enough history; it
   * understates a position that has lately been in range, because it averages in
   * every period the position sat outside it.
   */
  basis: "realized" | "since-open";
}

/** Under a quarter of an hour of history, the rate is noise scaled by 96. */
const MIN_RATE_HOURS = 0.25;

/**
 * Fee rate from the sample log: what this position actually earned, annualised to
 * a 24h figure from however long was sampled.
 *
 * Uses the CURRENT position value as the denominator rather than its value at each
 * sample, which is an approximation — the position's value moves with price. It is
 * the same approximation the pool-wide ratio makes, so the two stay comparable.
 */
export function realizedFeeRate(
  samples: { ts: number; feesUsd: number }[],
  valueUsd: number,
): FeeRate | null {
  if (!(valueUsd > 0) || samples.length < 2) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const hours = (last.ts - first.ts) / 3_600_000;
  if (hours < MIN_RATE_HOURS) return null;
  const earned = last.feesUsd - first.feesUsd;
  // allTimeFees counts claimed fees too, so it only ever rises. A fall means the
  // indexer disagreed with itself, and scaling a negative delta by 24/hours would
  // report a confident negative yield.
  if (earned < 0) return null;
  return { pctPer24h: (earned / valueUsd) * (24 / hours) * 100, hours, basis: "realized" };
}

/** Lifetime average, for a position with too little sampled history to measure. */
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

/**
 * The rate over successive buckets, for a trend line.
 *
 * Each point is its own bucket's rate, not a running total — a cumulative curve
 * looks like a rate but is not one, and reading its height instead of its slope
 * gets the answer wrong. Buckets shorter than the sample interval would alternate
 * between one sample and none, so the caller picks the width.
 */
export function feeRateSeries(
  samples: { ts: number; feesUsd: number }[],
  valueUsd: number,
  bucketMs: number,
): number[] {
  if (!(valueUsd > 0) || samples.length < 2 || bucketMs <= 0) return [];
  const out: number[] = [];
  let anchor = samples[0];
  for (const s of samples) {
    const span = s.ts - anchor.ts;
    if (span < bucketMs) continue;
    const earned = Math.max(0, s.feesUsd - anchor.feesUsd);
    out.push((earned / valueUsd) * (24 / (span / 3_600_000)) * 100);
    anchor = s;
  }
  return out;
}

/** Total lamports a set of rebalances consumed: network + priority fees, plus sunk bin-array rent. */
export function lamportsOf(rs: RebalanceRecord[]): number {
  return rs.reduce((a, r) => a + r.costLamports + r.rentLamports, 0);
}

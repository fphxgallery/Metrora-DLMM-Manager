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

/** Total lamports a set of rebalances consumed: network + priority fees, plus sunk bin-array rent. */
export function lamportsOf(rs: RebalanceRecord[]): number {
  return rs.reduce((a, r) => a + r.costLamports + r.rentLamports, 0);
}

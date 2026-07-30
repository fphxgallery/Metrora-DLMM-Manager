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

/** Total lamports a set of rebalances consumed: network + priority fees, plus sunk bin-array rent. */
export function lamportsOf(rs: RebalanceRecord[]): number {
  return rs.reduce((a, r) => a + r.costLamports + r.rentLamports, 0);
}

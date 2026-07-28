export function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n < 0 ? "-" : "";
  const a = Math.abs(n);
  if (a >= 1_000_000) return `${sign}$${(a / 1_000_000).toFixed(2)}M`;
  if (a >= 1_000) return `${sign}$${(a / 1_000).toFixed(1)}k`;
  if (a >= 1 || a === 0) return `${sign}$${a.toFixed(2)}`;
  // Sub-dollar amounts matter here: fees accrue in cents and rebalance costs are
  // fractions of a dollar, so two decimals would round them all to "$0.00".
  return `${sign}$${a.toFixed(4)}`;
}

/** Takes a value already in percent units (0.04 renders as "0.04%"). */
export function fmtPct(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n !== 0 && Math.abs(n) < 0.01) return `${n < 0 ? "-" : ""}<0.01%`;
  return `${n.toFixed(digits)}%`;
}

export function fmtPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1000) return n.toFixed(2);
  if (n >= 1) return n.toFixed(4);
  return n.toPrecision(4);
}

export function fmtNum(n: number | null | undefined, digits = 0): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { maximumFractionDigits: digits });
}

export function fmtAmount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n === 0) return "0";
  if (Math.abs(n) >= 1000) return n.toFixed(2);
  if (Math.abs(n) >= 1) return n.toFixed(4);
  return n.toPrecision(4);
}

export function fmtAgo(ts: number | null | undefined): string {
  if (!ts) return "—";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function shortPk(pk: string | null | undefined): string {
  if (!pk) return "—";
  return `${pk.slice(0, 4)}…${pk.slice(-4)}`;
}

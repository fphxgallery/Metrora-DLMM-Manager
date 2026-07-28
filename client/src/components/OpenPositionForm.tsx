import { useState } from "react";
import { api } from "../api.ts";
import { fmtNum, fmtPrice, shortPk } from "../format.ts";
import type { PoolDetail } from "./PoolsTab.tsx";

interface OpenResult {
  positionPk: string;
  minBinId: number;
  maxBinId: number;
  minPrice: number;
  maxPrice: number;
  results: { dryRun: boolean; signature?: string; unitsConsumed?: number }[];
}

const STRATEGIES = [
  { value: "Spot", hint: "even across the range — the default" },
  { value: "Curve", hint: "concentrated near the active price" },
  { value: "BidAsk", hint: "weighted to the range edges" },
];

/**
 * Opens a position in the inspected pool. The range is expressed as a half-width
 * in bins so it stays centred on the active bin — the same shape the rebalancer
 * restores, which keeps a manual open and an automatic re-centre consistent.
 */
export function OpenPositionForm({ pool, onOpened }: { pool: PoolDetail; onOpened: () => void }) {
  const [xAmount, setXAmount] = useState("0");
  const [yAmount, setYAmount] = useState("0");
  const [rangeBins, setRangeBins] = useState(String(pool.suggestedRange.rangeBins));
  const [strategyType, setStrategyType] = useState("Spot");
  const [auto, setAuto] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [logs, setLogs] = useState<string[] | null>(null);
  const [done, setDone] = useState<OpenResult | null>(null);

  const bins = Number(rangeBins);
  const minBin = pool.activeBinId - (Number.isFinite(bins) ? bins : 0);
  const maxBin = pool.activeBinId + (Number.isFinite(bins) ? bins : 0);
  // binStep is in basis points per bin, so each bin is 1.0001^… ≈ (1 + step/10000).
  const priceAt = (bin: number) => pool.activePrice * Math.pow(1 + pool.binStep / 10_000, bin - pool.activeBinId);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setLogs(null);
    setDone(null);
    try {
      const res = await api.post<OpenResult>("/api/positions/open", {
        poolAddress: pool.address,
        xAmount: Number(xAmount) || 0,
        yAmount: Number(yAmount) || 0,
        rangeBins: Number(rangeBins),
        strategyType,
        auto,
      });
      setDone(res);
      onOpened();
    } catch (err) {
      const e2 = err as { message?: string; logs?: string[] };
      setError(e2.message ?? String(err));
      setLogs(e2.logs ?? null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel" onSubmit={submit}>
      <h2>Open a position — {pool.name}</h2>

      <div className="grid-2">
        <label className="field">
          <span>{pool.tokenX.symbol} amount</span>
          <input value={xAmount} onChange={(e) => setXAmount(e.target.value)} inputMode="decimal" />
        </label>
        <label className="field">
          <span>{pool.tokenY.symbol} amount</span>
          <input value={yAmount} onChange={(e) => setYAmount(e.target.value)} inputMode="decimal" />
        </label>
        <label className="field">
          <span>Range (± bins)</span>
          <input value={rangeBins} onChange={(e) => setRangeBins(e.target.value)} inputMode="numeric" />
        </label>
        <label className="field">
          <span>Strategy</span>
          <select value={strategyType} onChange={(e) => setStrategyType(e.target.value)}>
            {STRATEGIES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.value} — {s.hint}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="faint" style={{ marginBottom: 10 }}>
        Range {fmtPrice(priceAt(minBin))} – {fmtPrice(priceAt(maxBin))} ({fmtNum(maxBin - minBin + 1)} bins, active{" "}
        {fmtPrice(pool.activePrice)}). Deposits below the active price are taken in {pool.tokenY.symbol}, above it in{" "}
        {pool.tokenX.symbol}.
      </div>

      <label className="row" style={{ marginBottom: 12 }}>
        <input type="checkbox" style={{ width: "auto" }} checked={auto} onChange={(e) => setAuto(e.target.checked)} />
        <span className="faint">rebalance this position automatically</span>
      </label>

      {error && <div className="msg err">{error}</div>}
      {logs && (
        <pre className="logs" style={{ height: 160 }}>
          {logs.join("\n")}
        </pre>
      )}
      {done && (
        <div className="msg ok">
          {done.results[0]?.dryRun ? "DRY-RUN — simulated ok, nothing sent." : "Position opened."} Range{" "}
          {fmtPrice(done.minPrice)} – {fmtPrice(done.maxPrice)} (bins {done.minBinId}…{done.maxBinId}). Position{" "}
          {shortPk(done.positionPk)}
          {done.results[0]?.signature ? ` · tx ${shortPk(done.results[0].signature)}` : ""}
        </div>
      )}

      <button className="btn primary" disabled={busy}>
        {busy ? "…" : "OPEN POSITION"}
      </button>
    </form>
  );
}

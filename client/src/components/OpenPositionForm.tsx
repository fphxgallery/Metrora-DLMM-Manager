import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { fmtAmount, fmtNum, fmtPrice, fmtUsd, shortPk } from "../format.ts";
import type { PoolDetail } from "./PoolsTab.tsx";

interface OpenResult {
  positionPk: string;
  minBinId: number;
  maxBinId: number;
  minPrice: number;
  maxPrice: number;
  results: { dryRun: boolean; signature?: string; unitsConsumed?: number }[];
}

const STRATEGIES = ["Spot", "Curve", "BidAsk"] as const;

/**
 * Splits the wallet's balances into an equal-USD-value deposit: whichever side
 * is worth less caps the fill, and an equal value is taken from the other side
 * — the excess on the larger side is left untouched, not drained.
 *
 * (Not `totalValue / 2` from each side's own balance — that identity forces
 * BOTH sides to their full balance the moment the wallet is imbalanced, since
 * totalValue is defined as the sum of both balances in the first place.)
 */
function autoFillAmounts(
  balX: number,
  balY: number,
  priceX: number,
  priceY: number,
): { x: number; y: number } {
  if (!(priceX > 0) || !(priceY > 0)) return { x: 0, y: 0 };
  const perSideUsd = Math.min(balX * priceX, balY * priceY);
  if (!(perSideUsd > 0)) return { x: 0, y: 0 };
  return { x: perSideUsd / priceX, y: perSideUsd / priceY };
}

/**
 * Opens a position in the inspected pool. The range is expressed as a half-width
 * in bins so it stays centred on the active bin — the same shape the rebalancer
 * restores, which keeps a manual open and an automatic re-centre consistent.
 */
export function OpenPositionForm({ pool, onOpened }: { pool: PoolDetail; onOpened: () => void }) {
  const [xAmount, setXAmount] = useState("0");
  const [yAmount, setYAmount] = useState("0");
  const [autoFill, setAutoFill] = useState(false);
  const [rangeBins, setRangeBins] = useState(String(pool.suggestedRange.rangeBins));
  const [strategyType, setStrategyType] = useState<(typeof STRATEGIES)[number]>("Spot");
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

  function applyAutoFill(balances: { x: number; y: number }) {
    const { x, y } = autoFillAmounts(balances.x, balances.y, pool.tokenX.priceUsd, pool.tokenY.priceUsd);
    setXAmount(x ? x.toFixed(pool.tokenX.decimals) : "0");
    setYAmount(y ? y.toFixed(pool.tokenY.decimals) : "0");
  }

  function toggleAutoFill(next: boolean) {
    setAutoFill(next);
    if (next && pool.walletBalances) applyAutoFill(pool.walletBalances);
  }

  // Re-fill when the pool's balances refresh (e.g. after this form's own
  // submit) as long as the toggle is still on — otherwise it would silently
  // go stale the moment a deposit changed the wallet.
  useEffect(() => {
    if (autoFill && pool.walletBalances) applyAutoFill(pool.walletBalances);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pool.walletBalances?.x, pool.walletBalances?.y]);

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
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 4 }}>
        <h2 style={{ margin: 0 }}>Open a position — {pool.name}</h2>
        <label className="row" style={{ gap: 8, cursor: pool.walletBalances ? "pointer" : "not-allowed" }}>
          <span className="faint">Auto-Fill</span>
          <span className="switch">
            <input
              type="checkbox"
              checked={autoFill}
              disabled={!pool.walletBalances}
              onChange={(e) => toggleAutoFill(e.target.checked)}
            />
            <span className="track" />
          </span>
        </label>
      </div>

      <div className="grid-2">
        <label className="field">
          <span>{pool.tokenX.symbol} amount</span>
          <input
            value={xAmount}
            onChange={(e) => {
              setAutoFill(false);
              setXAmount(e.target.value);
            }}
            inputMode="decimal"
          />
          <BalanceHint amount={pool.walletBalances?.x} symbol={pool.tokenX.symbol} priceUsd={pool.tokenX.priceUsd} />
        </label>
        <label className="field">
          <span>{pool.tokenY.symbol} amount</span>
          <input
            value={yAmount}
            onChange={(e) => {
              setAutoFill(false);
              setYAmount(e.target.value);
            }}
            inputMode="decimal"
          />
          <BalanceHint amount={pool.walletBalances?.y} symbol={pool.tokenY.symbol} priceUsd={pool.tokenY.priceUsd} />
        </label>
        <label className="field">
          <span>Range (± bins)</span>
          <input value={rangeBins} onChange={(e) => setRangeBins(e.target.value)} inputMode="numeric" />
        </label>
        <label className="field">
          <span>Strategy</span>
          <div className="segmented">
            {STRATEGIES.map((s) => (
              <button
                key={s}
                type="button"
                className={strategyType === s ? "active" : ""}
                onClick={() => setStrategyType(s)}
              >
                {s}
              </button>
            ))}
          </div>
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

function BalanceHint({ amount, symbol, priceUsd }: { amount?: number; symbol: string; priceUsd: number }) {
  if (amount == null) {
    return (
      <span className="faint" style={{ textTransform: "none", letterSpacing: 0, fontSize: 11 }}>
        no wallet configured
      </span>
    );
  }
  return (
    <span className="faint" style={{ textTransform: "none", letterSpacing: 0, fontSize: 11 }}>
      balance {fmtAmount(amount)} {symbol}
      {priceUsd > 0 ? ` (${fmtUsd(amount * priceUsd)})` : ""}
    </span>
  );
}

import { useState } from "react";
import { api } from "../api.ts";
import { fmtAmount, fmtNum, fmtPrice, fmtUsd, shortPk } from "../format.ts";
import type { PoolDetail } from "./PoolsTab.tsx";

interface ApePlan {
  pairName: string | null;
  payWith: "x" | "y";
  inSymbol: string;
  outSymbol: string;
  amountIn: number;
  swapIn: number;
  keep: number;
  quotedOut: number;
  priceImpactBps: number;
  route: string;
  strategyType: string;
  rangeBins: number;
  minBinId: number;
  maxBinId: number;
  minPrice: number;
  maxPrice: number;
  depositUsd: number;
  estCostUsd: number;
  autoManage: boolean;
}

interface ApeResult {
  plan: ApePlan;
  dryRun: boolean;
  swap: { signature?: string };
  received?: number;
  open?: { positionPk: string; minPrice: number; maxPrice: number; managed: boolean };
  note?: string;
}

/**
 * One token in, a two-sided position out.
 *
 * The confirm step is not ceremony. A preview costs a Jupiter quote and no fee,
 * and the quote is the only place the swap's real price and impact appear — so
 * showing it is strictly better than a single button that spends first and
 * reports afterwards. It also means every guard has already passed by the time
 * CONFIRM is live.
 */
export function ApeForm({ pool, onOpened, onClose }: { pool: PoolDetail; onOpened: () => void; onClose: () => void }) {
  const [amount, setAmount] = useState("");
  const [payWith, setPayWith] = useState<"x" | "y">("x");
  const [plan, setPlan] = useState<ApePlan | null>(null);
  const [result, setResult] = useState<ApeResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [logs, setLogs] = useState<string[] | null>(null);

  const side = payWith === "x" ? pool.tokenX : pool.tokenY;
  const balance = payWith === "x" ? pool.walletBalances?.x : pool.walletBalances?.y;

  function fail(err: unknown) {
    const e = err as { message?: string; logs?: string[] };
    setError(e.message ?? String(err));
    setLogs(e.logs ?? null);
  }

  async function call<T>(path: string, then: (v: T) => void) {
    setBusy(true);
    setError("");
    setLogs(null);
    try {
      then(
        await api.post<T>(path, {
          poolAddress: pool.address,
          amount: Number(amount),
          payWith,
        }),
      );
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  // Any edit invalidates the quote it was priced on — never leave a stale plan
  // sitting above a CONFIRM button.
  function edit(fn: () => void) {
    setPlan(null);
    setResult(null);
    fn();
  }

  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 4 }}>
        <h2 style={{ margin: 0 }}>Ape into {pool.name}</h2>
        <button className="btn" onClick={onClose}>
          CANCEL
        </button>
      </div>

      <div className="faint" style={{ textTransform: "none", letterSpacing: 0, marginBottom: 12 }}>
        One token in. Half is swapped for the other side, then a position opens centred on the active bin — using your
        SETTINGS values, shown below before anything is sent.
      </div>

      <div className="grid-2">
        <label className="field">
          <span>Amount in</span>
          <input
            value={amount}
            onChange={(e) => edit(() => setAmount(e.target.value))}
            inputMode="decimal"
            placeholder="0.0"
          />
          <span className="faint" style={{ textTransform: "none", letterSpacing: 0, fontSize: 11 }}>
            {balance == null
              ? "no wallet configured"
              : `balance ${fmtAmount(balance)} ${side.symbol}${
                  side.priceUsd > 0 ? ` (${fmtUsd(balance * side.priceUsd)})` : ""
                }`}
          </span>
        </label>
        <label className="field">
          <span>Pay with</span>
          <div className="segmented">
            {(["x", "y"] as const).map((s) => (
              <button
                key={s}
                type="button"
                className={payWith === s ? "active" : ""}
                onClick={() => edit(() => setPayWith(s))}
              >
                {s === "x" ? pool.tokenX.symbol : pool.tokenY.symbol}
              </button>
            ))}
          </div>
        </label>
      </div>

      {plan && !result && (
        <>
          <div className="row" style={{ gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
            <span className="chip">
              <span className="sym">SWAP</span>
              <span className="amt">
                {fmtAmount(plan.swapIn)} {plan.inSymbol}
              </span>
            </span>
            <span className="faint">→</span>
            <span className="chip">
              <span className="sym">RECEIVE</span>
              <span className="amt">
                {fmtAmount(plan.quotedOut)} {plan.outSymbol}
              </span>
            </span>
            <span className="faint" style={{ textTransform: "none", letterSpacing: 0 }}>
              impact {(plan.priceImpactBps / 100).toFixed(2)}% · via {plan.route}
            </span>
          </div>

          <div className="tiles" style={{ marginBottom: 12 }}>
            <Tile
              label="Resulting range"
              value={`${fmtPrice(plan.minPrice)} – ${fmtPrice(plan.maxPrice)}`}
              sub={`±${plan.rangeBins} bins · ${fmtNum(plan.maxBinId - plan.minBinId + 1)} wide`}
            />
            <Tile
              label="Deposit"
              value={plan.depositUsd > 0 ? fmtUsd(plan.depositUsd) : "—"}
              sub={`${fmtAmount(plan.keep)} ${plan.inSymbol} + ${fmtAmount(plan.quotedOut)} ${plan.outSymbol}`}
            />
            <Tile label="Est. cost" value={fmtUsd(plan.estCostUsd)} sub="swap impact + fees + rent" />
          </div>

          <div className="row" style={{ gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
            <span className="faint">USING</span>
            <span className="tag">{plan.strategyType}</span>
            <span className="tag">±{plan.rangeBins} bins</span>
            <span className="tag">{plan.autoManage ? "auto-rebalanced" : "unmanaged"}</span>
          </div>
        </>
      )}

      {error && <div className="msg err">{error}</div>}
      {logs && (
        <pre className="logs" style={{ height: 160 }}>
          {logs.join("\n")}
        </pre>
      )}

      {result && (
        <div className={`msg ${result.open || result.dryRun ? "ok" : "err"}`}>
          {result.dryRun
            ? result.note
            : `Swapped ${fmtAmount(result.plan.swapIn)} ${result.plan.inSymbol} → ${fmtAmount(
                result.received ?? 0,
              )} ${result.plan.outSymbol}${
                result.open
                  ? `. Position ${shortPk(result.open.positionPk)} opened, ${fmtPrice(
                      result.open.minPrice,
                    )} – ${fmtPrice(result.open.maxPrice)}${result.open.managed ? ", auto-rebalanced." : "."}`
                  : "."
              }`}
        </div>
      )}

      <div className="row" style={{ gap: 8, marginTop: 12 }}>
        {!plan || result ? (
          <button
            className="btn"
            disabled={busy || !(Number(amount) > 0)}
            onClick={() => void call<ApePlan>("/api/positions/ape/preview", setPlan)}
          >
            {busy ? "…" : "PREVIEW"}
          </button>
        ) : (
          <button
            className="btn primary"
            disabled={busy}
            onClick={() =>
              void call<ApeResult>("/api/positions/ape", (r) => {
                setResult(r);
                onOpened();
              })
            }
          >
            {busy ? "…" : "CONFIRM — SWAP & OPEN"}
          </button>
        )}
      </div>
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="tile">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div className="faint">{sub}</div>}
    </div>
  );
}

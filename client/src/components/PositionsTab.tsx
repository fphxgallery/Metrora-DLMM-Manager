import { useCallback, useEffect, useState } from "react";
import { api } from "../api.ts";
import { fmtAgo, fmtAmount, fmtNum, fmtPct, fmtPrice, fmtUsd, shortPk } from "../format.ts";

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
  valueInY: number;
  valueUsd: number;
  feesUsd: number;
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
  pnl: { pnlUsd: number; pnlPctChange: number; allTimeFeesUsd: number; createdAt?: number | null } | null;
}

export interface PositionsResponse {
  wallet: string | null;
  solBalance: number;
  positions: PositionView[];
}

export function PositionsTab() {
  const [data, setData] = useState<PositionsResponse | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      setData(await api.get<PositionsResponse>("/api/positions"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [load]);

  if (!data && !error) return <div className="panel faint">loading…</div>;

  return (
    <>
      {error && <div className="msg err">{error}</div>}

      <div className="panel">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div className="row" style={{ gap: 16 }}>
            <span className="faint">wallet</span>
            <span>{data?.wallet ? shortPk(data.wallet) : <span className="warn">none — create one in SETTINGS</span>}</span>
            <span className="faint">SOL</span>
            <span>{fmtAmount(data?.solBalance)}</span>
          </div>
          <button className="btn" disabled={busy} onClick={() => void load()}>
            {busy ? "…" : "REFRESH"}
          </button>
        </div>
      </div>

      {data && data.positions.length === 0 && (
        <div className="panel faint">
          No DLMM positions for this wallet. Find a pool in POOLS and open one.
        </div>
      )}

      {data?.positions.map((p) => (
        <PositionCard key={p.positionPk} p={p} onChanged={load} />
      ))}
    </>
  );
}

function PositionCard({ p, onChanged }: { p: PositionView; onChanged: () => void }) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [logs, setLogs] = useState<string[] | null>(null);
  const [ok, setOk] = useState("");
  const [confirmExit, setConfirmExit] = useState(false);

  async function act(name: string, path: string, body: Record<string, unknown> = {}) {
    setBusy(name);
    setError("");
    setLogs(null);
    setOk("");
    try {
      const res = await api.post<{ results?: { dryRun: boolean; signature?: string }[] }>(path, {
        poolAddress: p.poolAddress,
        ...body,
      });
      const sent = res.results?.filter((r) => r.signature).length ?? 0;
      setOk(res.results?.[0]?.dryRun ? `${name}: DRY-RUN simulated ok, nothing sent` : `${name}: ${sent} tx confirmed`);
      onChanged();
    } catch (e) {
      const err = e as { message?: string; logs?: string[] };
      setError(err.message ?? String(e));
      setLogs(err.logs ?? null);
    } finally {
      setBusy("");
      setConfirmExit(false);
    }
  }

  const drifted = p.ratioBps <= 500 || p.ratioBps >= 9500;
  const anyBusy = busy !== "";

  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div className="row">
          <b>{p.pairName}</b>
          <span className="faint">bin step {p.binStep}</span>
          <span className={`pill ${p.inRange ? "good" : "bad"}`}>{p.inRange ? "IN RANGE" : "OUT OF RANGE"}</span>
          {p.managed?.auto && <span className="pill good">AUTO</span>}
          {drifted && <span className="pill warn">ONE-SIDED</span>}
        </div>
        <div className="row">
          <button
            className={`btn${p.managed?.auto ? "" : " primary"}`}
            disabled={anyBusy}
            onClick={() =>
              void act("auto", `/api/positions/${p.positionPk}/manage`, {
                auto: !(p.managed?.auto ?? false),
                pairName: p.pairName,
              })
            }
          >
            {p.managed?.auto ? "DISABLE AUTO" : "ENABLE AUTO"}
          </button>
          <button
            className="btn"
            disabled={anyBusy || p.feesUsd <= 0}
            onClick={() => void act("claim", `/api/positions/${p.positionPk}/claim`)}
          >
            {busy === "claim" ? "…" : "CLAIM FEES"}
          </button>
          <button
            className="btn"
            disabled={anyBusy}
            onClick={() => void act("rebalance", `/api/positions/${p.positionPk}/rebalance`)}
          >
            {busy === "rebalance" ? "…" : "REBALANCE"}
          </button>
          {confirmExit ? (
            <>
              <button
                className="btn danger"
                disabled={anyBusy}
                onClick={() => void act("exit", `/api/positions/${p.positionPk}/exit`)}
              >
                {busy === "exit" ? "…" : "CONFIRM EXIT"}
              </button>
              <button className="btn" disabled={anyBusy} onClick={() => setConfirmExit(false)}>
                CANCEL
              </button>
            </>
          ) : (
            <button className="btn danger" disabled={anyBusy} onClick={() => setConfirmExit(true)}>
              EXIT
            </button>
          )}
        </div>
      </div>

      {confirmExit && (
        <div className="msg" style={{ borderColor: "var(--warn)" }}>
          <span className="warn">Exit</span> removes 100% of the liquidity, claims fees and rewards, and closes the
          position account. It cannot be undone — reopening costs rent again.
        </div>
      )}
      {ok && <div className="msg ok">{ok}</div>}
      {error && <div className="msg err">{error}</div>}
      {logs && (
        <pre className="logs" style={{ height: 140 }}>
          {logs.join("\n")}
        </pre>
      )}

      <RangeBar p={p} />

      <div className="tiles" style={{ marginTop: 12 }}>
        <Tile label="Value" value={fmtUsd(p.valueUsd)} sub={`${fmtAmount(p.amountX)} ${p.tokenX.symbol} · ${fmtAmount(p.amountY)} ${p.tokenY.symbol}`} />
        <Tile label="Unclaimed fees" value={fmtUsd(p.feesUsd)} sub={`${fmtAmount(p.feeX)} ${p.tokenX.symbol} · ${fmtAmount(p.feeY)} ${p.tokenY.symbol}`} />
        <Tile
          label="PnL"
          value={p.pnl ? fmtUsd(p.pnl.pnlUsd) : "—"}
          sub={p.pnl ? `${fmtPct(p.pnl.pnlPctChange)} · fees ${fmtUsd(p.pnl.allTimeFeesUsd)}` : "not indexed yet"}
          cls={p.pnl ? (p.pnl.pnlUsd >= 0 ? "good" : "bad") : undefined}
        />
        <Tile label="Range" value={`${fmtPrice(p.minPrice)} – ${fmtPrice(p.maxPrice)}`} sub={`${fmtNum(p.widthBins)} bins · active ${fmtPrice(p.activePrice)}`} />
        <Tile
          label="Rebalances"
          value={p.managed ? fmtNum(p.managed.rebalanceCount) : "—"}
          sub={p.managed?.lastRebalanceAt ? fmtAgo(p.managed.lastRebalanceAt) : "never"}
        />
        <Tile
          label="Time in range"
          value={p.managed?.timeInRangePct != null ? fmtPct(p.managed.timeInRangePct, 1) : "—"}
          sub={p.managed ? "since managed" : "not managed"}
        />
      </div>

      <div className="faint" style={{ marginTop: 8, fontSize: 11 }}>
        position {shortPk(p.positionPk)} · pool {shortPk(p.poolAddress)} · bins {p.lowerBinId}…{p.upperBinId} · active{" "}
        {p.activeBinId} ({p.binsToEdge >= 0 ? `${p.binsToEdge} from edge` : `${-p.binsToEdge} bins outside`})
      </div>
    </div>
  );
}

/**
 * Where the active price sits inside the position's range. Out-of-range is shown
 * by pinning the marker to the edge it left and coloring it — the single most
 * important thing to see at a glance, because an out-of-range position earns nothing.
 */
function RangeBar({ p }: { p: PositionView }) {
  const pct = Math.max(0, Math.min(100, p.pctThroughRange));
  return (
    <div style={{ marginTop: 12 }}>
      <div
        style={{
          position: "relative",
          height: 26,
          background: "var(--panel-2)",
          border: "1px solid var(--border)",
          borderRadius: 4,
        }}
      >
        <div
          style={{
            position: "absolute",
            left: `calc(${pct}% - 1px)`,
            top: -3,
            bottom: -3,
            width: 2,
            background: p.inRange ? "var(--accent)" : "var(--bad)",
            boxShadow: `0 0 8px ${p.inRange ? "rgba(56,225,255,.6)" : "rgba(248,113,113,.6)"}`,
          }}
        />
        <span className="faint" style={{ position: "absolute", left: 8, top: 4, fontSize: 11 }}>
          {fmtPrice(p.minPrice)}
        </span>
        <span className="faint" style={{ position: "absolute", right: 8, top: 4, fontSize: 11 }}>
          {fmtPrice(p.maxPrice)}
        </span>
      </div>
    </div>
  );
}

function Tile({ label, value, sub, cls }: { label: string; value: string; sub?: string; cls?: string }) {
  return (
    <div className="tile">
      <div className="label">{label}</div>
      <div className={`value ${cls ?? ""}`}>{value}</div>
      {sub && <div className="faint">{sub}</div>}
    </div>
  );
}

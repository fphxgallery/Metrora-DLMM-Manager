import { useCallback, useEffect, useState } from "react";
import { api, type Settings } from "../api.ts";
import { fmtAgo, fmtAmount, fmtNum, fmtPct, fmtPrice, fmtUsd, shortPk } from "../format.ts";
import { WalletPanel } from "./WalletPanel.tsx";

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
    openedAt: number;
    timeInRangePct: number | null;
  } | null;
  feeRate: {
    positionPctPer24h: number | null;
    poolPctPer24h: number | null;
  };
  pnl: { pnlUsd: number; pnlPctChange: number; allTimeFeesUsd: number } | null;
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
  // Fallback for positions with no per-position override — mirrors the
  // engine's own `managed.edgeBufferBins ?? cfg.edgeBufferBins` fallback, so
  // the range bar's zones match what actually decides when a rebalance fires.
  const [defaultEdgeBufferBins, setDefaultEdgeBufferBins] = useState<number | null>(null);

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

  useEffect(() => {
    api
      .get<Settings>("/api/settings")
      .then((s) => setDefaultEdgeBufferBins(Number(s.config.EDGE_BUFFER_BINS)))
      .catch(() => {
        /* the range bar just falls back to a fixed zone width */
      });
  }, []);

  if (!data && !error) return <div className="panel faint">loading…</div>;

  return (
    <>
      {error && <div className="msg err">{error}</div>}

      <WalletPanel wallet={data?.wallet} solBalance={data?.solBalance} onRefresh={load} />

      {data && data.positions.length === 0 && (
        <div className="panel faint">
          No DLMM positions for this wallet. Find a pool in POOLS and open one.
        </div>
      )}

      {data?.positions.map((p) => (
        <PositionCard key={p.positionPk} p={p} onChanged={load} defaultEdgeBufferBins={defaultEdgeBufferBins} />
      ))}
    </>
  );
}

function PositionCard({
  p,
  onChanged,
  defaultEdgeBufferBins,
}: {
  p: PositionView;
  onChanged: () => void;
  defaultEdgeBufferBins: number | null;
}) {
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

      <RangeBar p={p} defaultEdgeBufferBins={defaultEdgeBufferBins} />

      <div className="group-label">Position</div>
      <div className="tiles" style={{ marginTop: 6, marginBottom: 14 }}>
        <Tile label="Value" value={fmtUsd(p.valueUsd)} sub={`${fmtAmount(p.amountX)} ${p.tokenX.symbol} · ${fmtAmount(p.amountY)} ${p.tokenY.symbol}`} />
        <Tile label="Range" value={`${fmtPrice(p.minPrice)} – ${fmtPrice(p.maxPrice)}`} sub={`${fmtNum(p.widthBins)} bins · active ${fmtPrice(p.activePrice)}`} />
      </div>

      <div className="group-label">Performance</div>
      <div className="tiles" style={{ marginTop: 6 }}>
        <Tile
          label="PnL"
          value={p.pnl ? fmtUsd(p.pnl.pnlUsd) : "—"}
          sub={p.pnl ? `${fmtPct(p.pnl.pnlPctChange)} · lifetime fees ${fmtUsd(p.pnl.allTimeFeesUsd)}` : "not indexed yet"}
          cls={p.pnl ? (p.pnl.pnlUsd >= 0 ? "good" : "bad") : undefined}
        />
        <Tile label="Unclaimed fees" value={fmtUsd(p.feesUsd)} sub={`${fmtAmount(p.feeX)} ${p.tokenX.symbol} · ${fmtAmount(p.feeY)} ${p.tokenY.symbol}`} />
        <FeeTvlTile rate={p.feeRate} valueUsd={p.valueUsd} />
        <TimeInRangeTile p={p} defaultEdgeBufferBins={defaultEdgeBufferBins} />
      </div>

      <div className="faint" style={{ marginTop: 10, fontSize: 11 }}>
        {p.managed ? fmtNum(p.managed.rebalanceCount) : "—"} rebalances ·{" "}
        {p.managed?.lastRebalanceAt ? fmtAgo(p.managed.lastRebalanceAt) : "never"} · position {shortPk(p.positionPk)} ·
        pool {shortPk(p.poolAddress)} · bins {p.lowerBinId}…{p.upperBinId} · active {p.activeBinId} (
        {p.binsToEdge >= 0 ? `${p.binsToEdge} from edge` : `${-p.binsToEdge} bins outside`})
      </div>
    </div>
  );
}

/**
 * Where the active price sits inside the position's range, colored by how close
 * it is to triggering a rebalance rather than just in-range/out — a continuous
 * green-to-red gradient whose transition points are the position's ACTUAL
 * `edgeBufferBins` zone (dashed lines), not an arbitrary safe/risky split. Out
 * of range is still the single loudest signal: the marker itself turns red and
 * pins to the edge it left, since an out-of-range position earns nothing.
 */
function RangeBar({ p, defaultEdgeBufferBins }: { p: PositionView; defaultEdgeBufferBins: number | null }) {
  const pct = Math.max(0, Math.min(100, p.pctThroughRange));
  const edgeBufferBins = p.managed?.edgeBufferBins ?? defaultEdgeBufferBins ?? Math.round(p.widthBins * 0.15);

  // Zone boundary as a % of the track: where EDGE_BUFFER_BINS actually starts.
  // Clamped so a degenerate config (buffer >= half the width) can't collapse
  // the gradient into nonsense.
  const zonePct = p.widthBins > 0 ? clamp((edgeBufferBins / p.widthBins) * 100, 2, 40) : 15;
  // The gradient fades from amber to green over the same width as the zone
  // itself, so the color reads as a continuous "how close to the edge" scale
  // rather than a hard flip at the boundary.
  const fadePct = Math.min(zonePct * 2, 50);

  const gradient =
    `linear-gradient(90deg, var(--bad) 0%, var(--warn) ${zonePct}%, var(--good) ${fadePct}%, ` +
    `var(--good) ${100 - fadePct}%, var(--warn) ${100 - zonePct}%, var(--bad) 100%)`;

  return (
    <div style={{ marginTop: 12 }}>
      <div
        style={{
          position: "relative",
          height: 26,
          borderRadius: 4,
          overflow: "hidden",
          border: "1px solid var(--border)",
          background: gradient,
        }}
      >
        {/* Scrim so the price labels and marker stay legible over the gradient. */}
        <div style={{ position: "absolute", inset: 0, background: "rgba(17,23,31,0.62)" }} />

        <div
          style={{
            position: "absolute",
            left: `${zonePct}%`,
            top: 0,
            bottom: 0,
            width: 0,
            borderLeft: "1px dashed rgba(251,191,36,0.5)",
          }}
        />
        <div
          style={{
            position: "absolute",
            right: `${zonePct}%`,
            top: 0,
            bottom: 0,
            width: 0,
            borderLeft: "1px dashed rgba(251,191,36,0.5)",
          }}
        />

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
        <span
          style={{
            position: "absolute",
            left: 8,
            top: 4,
            fontSize: 11,
            color: "#fff",
            textShadow: "0 1px 2px rgba(0,0,0,0.9)",
          }}
        >
          {fmtPrice(p.minPrice)}
        </span>
        <span
          style={{
            position: "absolute",
            right: 8,
            top: 4,
            fontSize: 11,
            color: "#fff",
            textShadow: "0 1px 2px rgba(0,0,0,0.9)",
          }}
        >
          {fmtPrice(p.maxPrice)}
        </span>
      </div>
    </div>
  );
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/**
 * Fee income as a rate, with the pool's own rate marked on the bar.
 *
 * The rate alone does not say whether it is good — 0.4% a day is excellent in one
 * pool and poor in another. The tick is the pool's rate and the fill is this
 * position's, so being ahead is one glance rather than two numbers and a division.
 * Behind the tick means the position earns less than a passive LP in the same pool
 * would while still paying to rebalance, which is the one failure this app can
 * cause and otherwise never surfaces.
 */
function FeeTvlTile({ rate, valueUsd }: { rate: PositionView["feeRate"]; valueUsd: number }) {
  const { positionPctPer24h, poolPctPer24h } = rate;
  const own = positionPctPer24h ?? null;
  // Nothing to show at all: the indexer has not seen this position and the pool
  // metadata is missing too.
  if (own == null && poolPctPer24h == null) {
    return (
      <div className="tile">
        <div className="label">Fee / TVL · 24h</div>
        <div className="value">—</div>
        <div className="faint">not indexed yet</div>
      </div>
    );
  }

  // Falling back to the pool's rate is fine; presenting it as the position's is not.
  const showing = own ?? poolPctPer24h!;
  const isOwn = own != null;
  const ahead = isOwn && poolPctPer24h != null ? showing >= poolPctPer24h : true;

  // Headroom above whichever is larger, so the pool tick never sits on the edge
  // where it reads as a full bar.
  const scale = Math.max(showing, poolPctPer24h ?? 0) * 1.35 || 1;
  const fillPct = Math.min(100, (showing / scale) * 100);
  const poolPct = poolPctPer24h != null ? Math.min(100, (poolPctPer24h / scale) * 100) : null;

  return (
    <div className="tile">
      <div className="label">{isOwn ? "Fee / TVL · 24h" : "Pool fee / TVL · 24h"}</div>
      <div className={`value ${isOwn && poolPctPer24h != null ? (ahead ? "good" : "warn") : ""}`}>
        {fmtPct(showing, 2)}
      </div>
      <div className="cmp tile-tail">
        <div className="cmp-track">
          <div className={`cmp-fill ${ahead ? "" : "low"}`} style={{ width: `${fillPct}%` }} />
          {poolPct != null && isOwn && <div className="cmp-pool" style={{ left: `${poolPct}%` }} />}
        </div>
        <div className="cmp-labels">
          <span>≈ {fmtUsd((showing / 100) * valueUsd)} / day</span>
          {poolPctPer24h != null && isOwn && <span>pool {fmtPct(poolPctPer24h, 2)}</span>}
        </div>
      </div>
    </div>
  );
}

function Tile({ label, value, sub, cls }: { label: string; value: string; sub?: string; cls?: string }) {
  return (
    <div className="tile">
      <div className="label">{label}</div>
      <div className={`value ${cls ?? ""}`}>{value}</div>
      {sub && <div className="faint tile-tail">{sub}</div>}
    </div>
  );
}

/**
 * "Bins to trigger" is distance to the actual rebalance trigger (the edge-buffer
 * zone), not the raw range edge — same `edgeBufferBins` fallback as RangeBar so
 * the two stay consistent about what decides when a rebalance fires.
 */
function TimeInRangeTile({ p, defaultEdgeBufferBins }: { p: PositionView; defaultEdgeBufferBins: number | null }) {
  const edgeBufferBins = p.managed?.edgeBufferBins ?? defaultEdgeBufferBins ?? Math.round(p.widthBins * 0.15);
  const halfWidth = Math.max(1, Math.round(p.widthBins / 2));
  const maxDistance = Math.max(1, halfWidth - edgeBufferBins);
  const binsFromTrigger = Math.max(0, p.binsToEdge - edgeBufferBins);
  const proximityPct = clamp((binsFromTrigger / maxDistance) * 100, 0, 100);
  const barColor = !p.inRange ? "var(--bad)" : proximityPct <= 20 ? "var(--warn)" : "var(--good)";

  return (
    <div className="tile">
      <div className="label">Time in range</div>
      <div className="value">{p.managed?.timeInRangePct != null ? fmtPct(p.managed.timeInRangePct, 1) : "—"}</div>
      <div className="faint">
        {p.managed?.openedAt ? `opened ${fmtAgo(p.managed.openedAt)}` : p.managed ? "since managed" : "not managed"}
      </div>
      {p.managed && (
        <div className="tile-tail">
          <div
            style={{
              marginTop: 8,
              height: 4,
              borderRadius: 2,
              background: "var(--border)",
              position: "relative",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                bottom: 0,
                width: `${proximityPct}%`,
                background: barColor,
                borderRadius: 2,
              }}
            />
          </div>
          <div className="faint" style={{ fontSize: 10, marginTop: 4 }}>
            {p.inRange ? `${fmtNum(binsFromTrigger)} of ${fmtNum(maxDistance)} bins to trigger` : "out of range"}
          </div>
        </div>
      )}
    </div>
  );
}

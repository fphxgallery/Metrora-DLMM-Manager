import { useCallback, useEffect, useState } from "react";
import { api, type Settings } from "../api.ts";
import { fmtAgo, fmtAmount, fmtNum, fmtPct, fmtPrice, fmtUsd } from "../format.ts";
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

interface ZapOutPlan {
  to: "x" | "y";
  toSymbol: string;
  fromSymbol: string;
  amountTo: number;
  amountFrom: number;
  needsSwap: boolean;
  quotedOut: number;
  totalOut: number;
  priceImpactBps: number;
  route: string | null;
  rentLamports: number;
  estCostUsd: number;
}

interface ZapOutResult {
  plan: ZapOutPlan;
  dryRun: boolean;
  received?: number;
  note?: string;
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
  // Zap out closes the position BEFORE it swaps, so the preview is not a
  // nicety: it is where an unroutable position is refused while it still
  // exists. There is deliberately no way to confirm without one.
  const [zapPlan, setZapPlan] = useState<ZapOutPlan | null>(null);
  const [zapping, setZapping] = useState(false);

  async function previewZap(to?: "x" | "y") {
    setBusy("zap");
    setError("");
    setLogs(null);
    setOk("");
    setZapPlan(null);
    try {
      setZapPlan(
        await api.post<ZapOutPlan>(`/api/positions/${p.positionPk}/zap-out/preview`, {
          poolAddress: p.poolAddress,
          ...(to ? { to } : {}),
        }),
      );
      setZapping(true);
    } catch (e) {
      const err = e as { message?: string; logs?: string[] };
      setError(err.message ?? String(e));
      setLogs(err.logs ?? null);
      setZapping(false);
    } finally {
      setBusy("");
    }
  }

  async function confirmZap() {
    if (!zapPlan) return;
    setBusy("zap");
    setError("");
    setLogs(null);
    setOk("");
    try {
      const res = await api.post<ZapOutResult>(`/api/positions/${p.positionPk}/zap-out`, {
        poolAddress: p.poolAddress,
        to: zapPlan.to,
      });
      setOk(
        res.dryRun
          ? (res.note ?? "DRY-RUN simulated ok, nothing sent")
          : `Zapped out to ${fmtAmount((res.received ?? 0) + res.plan.amountTo)} ${res.plan.toSymbol}` +
            ` · rent back ${(res.plan.rentLamports / 1e9).toFixed(5)} SOL`,
      );
      setZapping(false);
      setZapPlan(null);
      onChanged();
    } catch (e) {
      const err = e as { message?: string; logs?: string[] };
      setError(err.message ?? String(e));
      setLogs(err.logs ?? null);
    } finally {
      setBusy("");
    }
  }


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
          <b title={`position ${p.positionPk}\npool ${p.poolAddress}\nbins ${p.lowerBinId}…${p.upperBinId} · active ${p.activeBinId}`}>{p.pairName}</b>
          <span className="faint">bin step {p.binStep}</span>
          <span className={`pill ${p.inRange ? "good" : "bad"}`}>{p.inRange ? "IN RANGE" : "OUT OF RANGE"}</span>
          {p.managed?.auto && <span className="pill good">AUTO</span>}
          {drifted && <span className="pill warn">ONE-SIDED</span>}
          <span style={{ marginLeft: 6 }}>{fmtUsd(p.valueUsd)}</span>
          <span className="fact-sub">
            {fmtAmount(p.amountX)} {p.tokenX.symbol} · {fmtAmount(p.amountY)} {p.tokenY.symbol}
          </span>
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
          <button className="btn" disabled={anyBusy} onClick={() => void previewZap()}>
            {busy === "zap" && !zapping ? "…" : "ZAP OUT"}
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
      {zapping && zapPlan && (
        <div className="msg" style={{ borderColor: "var(--warn)" }}>
          <div className="row" style={{ gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
            <span className="faint">RECEIVE</span>
            <div className="segmented">
              {(["x", "y"] as const).map((side) => (
                <button
                  key={side}
                  type="button"
                  className={zapPlan.to === side ? "active" : ""}
                  disabled={anyBusy}
                  onClick={() => void previewZap(side)}
                >
                  {side === "x" ? p.tokenX.symbol : p.tokenY.symbol}
                </button>
              ))}
            </div>
          </div>

          <div className="row" style={{ gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
            {zapPlan.needsSwap ? (
              <>
                <span className="chip">
                  <span className="sym">SWAP</span>
                  <span className="amt">
                    {fmtAmount(zapPlan.amountFrom)} {zapPlan.fromSymbol}
                  </span>
                </span>
                <span className="faint">→</span>
                <span className="chip">
                  <span className="sym">FOR</span>
                  <span className="amt">
                    {fmtAmount(zapPlan.quotedOut)} {zapPlan.toSymbol}
                  </span>
                </span>
                <span className="faint" style={{ textTransform: "none", letterSpacing: 0 }}>
                  impact {(zapPlan.priceImpactBps / 100).toFixed(2)}%
                  {zapPlan.route ? ` · via ${zapPlan.route}` : ""}
                </span>
              </>
            ) : (
              <span className="faint" style={{ textTransform: "none", letterSpacing: 0 }}>
                Already entirely in {zapPlan.toSymbol} — no swap needed, this is just an exit.
              </span>
            )}
          </div>

          <div className="row" style={{ gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
            <span className="chip">
              <span className="sym">YOU RECEIVE</span>
              <span className="amt">
                {fmtAmount(zapPlan.totalOut)} {zapPlan.toSymbol}
              </span>
            </span>
            <span className="chip">
              <span className="sym">RENT BACK</span>
              <span className="amt">{(zapPlan.rentLamports / 1e9).toFixed(5)} SOL</span>
            </span>
            <span className="chip">
              <span className="sym">EST. COST</span>
              <span className="amt">{fmtUsd(zapPlan.estCostUsd)}</span>
            </span>
          </div>

          <div style={{ marginBottom: 10 }}>
            <span className="warn">Zap out</span> closes the position and reclaims its rent, then swaps. The swap
            happens <b>after</b> the close — if the route fails you keep both tokens and the position is already gone.
            It cannot be undone.
          </div>

          <div className="row" style={{ gap: 8 }}>
            <button className="btn danger" disabled={anyBusy} onClick={() => void confirmZap()}>
              {busy === "zap" ? "…" : `CONFIRM — CLOSE & SWAP TO ${zapPlan.toSymbol}`}
            </button>
            <button
              className="btn"
              disabled={anyBusy}
              onClick={() => {
                setZapping(false);
                setZapPlan(null);
              }}
            >
              CANCEL
            </button>
          </div>
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

      {/*
        One strip of label/value pairs rather than two rows of tiles.
        Tiles cost ~250px per position in whitespace and heading chrome, which is
        most of a card, and the range bar above already carries the thing worth
        looking at. Each fact keeps its old sub-caption, demoted to grey.

        Time-in-range is deliberately absent: the IN RANGE pill in the header
        answers "is it in range now", and the historical percentage is on the
        METRICS tab per position, so it is out of the card rather than out of the
        app. The addresses that used to sit in a footer line are on the pair
        name's tooltip.
      */}
      <div className="facts">
        <Fact k="Range" v={`${fmtPrice(p.minPrice)} – ${fmtPrice(p.maxPrice)}`}>
          {fmtNum(p.widthBins)} bins ·{" "}
          {p.binsToEdge >= 0 ? `${p.binsToEdge} from edge` : `${-p.binsToEdge} outside`}
        </Fact>
        <Fact
          k="PnL"
          v={p.pnl ? fmtUsd(p.pnl.pnlUsd) : "—"}
          cls={p.pnl ? (p.pnl.pnlUsd >= 0 ? "good" : "bad") : undefined}
        >
          {p.pnl ? `${fmtPct(p.pnl.pnlPctChange)} · lifetime ${fmtUsd(p.pnl.allTimeFeesUsd)}` : "not indexed yet"}
        </Fact>
        {/*
          The accrual RATE, not the token split the old tile showed. Both are
          useful, but the split runs to ~190px of digits and pushed the strip
          onto a second row; the rate is what tells you whether the unclaimed
          figure beside it is a morning's work or a week's. The split is on the
          tooltip.
        */}
        <Fact
          k="Fees"
          v={fmtUsd(p.feesUsd)}
          title={`unclaimed ${fmtAmount(p.feeX)} ${p.tokenX.symbol} · ${fmtAmount(p.feeY)} ${p.tokenY.symbol}`}
        >
          {feePerDayUsd(p) == null ? "unclaimed" : `≈ ${fmtUsd(feePerDayUsd(p)!)}/day`}
        </Fact>
        <Fact
          k="Fee/TVL"
          v={p.feeRate?.positionPctPer24h == null ? "—" : fmtPct(p.feeRate.positionPctPer24h)}
          cls={feeRateCls(p.feeRate)}
        >
          {p.feeRate?.poolPctPer24h == null ? "24h" : `pool ${fmtPct(p.feeRate.poolPctPer24h)}`}
        </Fact>
        <Fact k="Rebalances" v={p.managed ? fmtNum(p.managed.rebalanceCount) : "—"}>
          {p.managed?.lastRebalanceAt ? fmtAgo(p.managed.lastRebalanceAt) : "never"}
        </Fact>
      </div>
    </div>
  );
}

/**
 * One label/value pair in a position's fact strip, with its detail demoted.
 *
 * The tile this replaces gave each figure a bordered box and its own line; at
 * six figures per position that was most of the card's height for no extra
 * information. Same three parts, laid out inline.
 */
function Fact({
  k,
  v,
  cls,
  title,
  children,
}: {
  k: string;
  v: string;
  cls?: string;
  title?: string;
  children?: React.ReactNode;
}) {
  return (
    <span className="fact" title={title}>
      <span className="fact-k">{k}</span>
      <span className={cls}>{v}</span>
      {children && <span className="fact-sub">{children}</span>}
    </span>
  );
}

/** What the position earns per day at the indexer's own 24h fee/TVL rate. */
function feePerDayUsd(p: PositionView): number | null {
  const pct = p.feeRate?.positionPctPer24h;
  if (pct == null || !(p.valueUsd > 0)) return null;
  return (p.valueUsd * pct) / 100;
}

/** Green when the position out-earns the pool it sits in, which is the comparison that matters. */
function feeRateCls(rate: PositionView["feeRate"]): string | undefined {
  if (rate?.positionPctPer24h == null || rate.poolPctPer24h == null) return undefined;
  return rate.positionPctPer24h >= rate.poolPctPer24h ? "good" : undefined;
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


/**
 * "Bins to trigger" is distance to the actual rebalance trigger (the edge-buffer
 * zone), not the raw range edge — same `edgeBufferBins` fallback as RangeBar so
 * the two stay consistent about what decides when a rebalance fires.
 */

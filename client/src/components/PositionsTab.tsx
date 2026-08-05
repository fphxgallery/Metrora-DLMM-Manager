import { useCallback, useEffect, useState } from "react";
import { api, type Settings } from "../api.ts";
import { fmtAgo, fmtAmount, fmtNum, fmtPct, fmtPrice, fmtUsd } from "../format.ts";
import { gaugeGeometry, type GaugeGeometry } from "../gauge.ts";
import { WalletPanel } from "./WalletPanel.tsx";

/**
 * Stop loss / take profit as the engine would apply them — the server has
 * already folded any per-position override into the global default, so `stopLoss`
 * here is the number that would actually fire.
 */
export interface TriggerView {
  on: boolean;
  measure: "pct" | "usd";
  stopLoss: number | null;
  takeProfit: number | null;
  onFire: string;
  overridden: boolean;
  streak: number;
  confirmations: number;
  lastReading: number | null;
  lastCheckAt: number | null;
  refusals: number;
  disarmedReason: string | null;
}

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
    triggers: TriggerView;
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
  // Which card has its liquidity panel open. Held HERE rather than in the card
  // so that (a) the 30s poll cannot collapse it — the cards re-render, this does
  // not — and (b) opening one closes the other without the cards knowing about
  // each other.
  const [openPk, setOpenPk] = useState<string | null>(null);

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

      <WalletPanel
        wallet={data?.wallet}
        solBalance={data?.solBalance}
        onRefresh={load}
        dlmmTotalUsd={data ? data.positions.reduce((s, p) => s + p.valueUsd, 0) : undefined}
      />

      {data && data.positions.length === 0 && (
        <div className="panel faint">
          No DLMM positions for this wallet. Find a pool in POOLS and open one.
        </div>
      )}

      {data?.positions.map((p) => (
        <PositionCard
          key={p.positionPk}
          p={p}
          onChanged={load}
          defaultEdgeBufferBins={defaultEdgeBufferBins}
          open={openPk === p.positionPk}
          onToggle={() => setOpenPk((cur) => (cur === p.positionPk ? null : p.positionPk))}
        />
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
  open,
  onToggle,
}: {
  p: PositionView;
  onChanged: () => void;
  defaultEdgeBufferBins: number | null;
  open: boolean;
  onToggle: () => void;
}) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [logs, setLogs] = useState<string[] | null>(null);
  const [ok, setOk] = useState("");
  const [confirmExit, setConfirmExit] = useState(false);
  const [showTriggers, setShowTriggers] = useState(false);
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
    <div
      className={`panel card-x${open ? " open" : ""}`}
      onClick={(e) => {
        // Empty space only. Controls handle their own clicks, the sub-panels are
        // workspaces rather than toggles, and a click that ends a text selection
        // is someone copying an address, not asking for the chart.
        const t = e.target as HTMLElement;
        if (t.closest("button, input, select, a, .no-expand")) return;
        if (window.getSelection()?.toString()) return;
        onToggle();
      }}
    >
      <div className="row">
        <div className="row" style={{ flex: 1 }}>
          <b title={`position ${p.positionPk}\npool ${p.poolAddress}\nbins ${p.lowerBinId}…${p.upperBinId} · active ${p.activeBinId}`}>{p.pairName}</b>
          <span className="faint">bin step {p.binStep}</span>
          <span className={`pill ${p.inRange ? "good" : "bad"}`}>{p.inRange ? "IN RANGE" : "OUT OF RANGE"}</span>
          {p.managed?.auto && <span className="pill good">AUTO</span>}
          {p.managed?.triggers.on && (
            <span className="pill warn" title={`fires ${onFireLabel(p.managed.triggers.onFire)} after ${p.managed.triggers.confirmations} confirming readings`}>
              {thresholdSummary(p.managed.triggers)}
            </span>
          )}
          {drifted && <span className="pill warn">ONE-SIDED</span>}
          <span style={{ marginLeft: 6 }}>{fmtUsd(p.valueUsd)}</span>
          <span className="fact-sub">
            {fmtAmount(p.amountX)} {p.tokenX.symbol} · {fmtAmount(p.amountY)} {p.tokenY.symbol}
          </span>
          <span className="chev" title={open ? "hide liquidity" : "show liquidity by bin"}>
            ›
          </span>
        </div>
      </div>

      {/*
        Everything you can DO to a position now lives behind the expand, with the
        chart. Six controls per position permanently on screen made a list of
        positions read as a control panel. Controls come FIRST inside the panel:
        you decide whether to act from the collapsed card's facts, and open it in
        order to act, so the chart is context on the way past rather than
        something to scroll over.
      */}
      {open && (
        <div className="lp no-expand">
          <div className="row">
          <button
            className={`btn sm${p.managed?.auto ? "" : " primary"}`}
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
            className="btn sm"
            disabled={anyBusy || p.feesUsd <= 0}
            onClick={() => void act("claim", `/api/positions/${p.positionPk}/claim`)}
          >
            {busy === "claim" ? "…" : "CLAIM FEES"}
          </button>
          <button
            className="btn sm"
            disabled={anyBusy}
            onClick={() => void act("rebalance", `/api/positions/${p.positionPk}/rebalance`)}
          >
            {busy === "rebalance" ? "…" : "REBALANCE"}
          </button>
          {p.managed && (
            <button className={`btn sm${showTriggers ? " primary" : ""}`} disabled={anyBusy} onClick={() => setShowTriggers(!showTriggers)}>
              TRIGGERS
            </button>
          )}
          {/* The destructive pair, pushed right so EXIT is never adjacent to REBALANCE. */}
          <span style={{ flex: 1 }} />
          <button className="btn sm" disabled={anyBusy} onClick={() => void previewZap()}>
            {busy === "zap" && !zapping ? "…" : "ZAP OUT"}
          </button>
          {confirmExit ? (
            <>
              <button
                className="btn sm danger"
                disabled={anyBusy}
                onClick={() => void act("exit", `/api/positions/${p.positionPk}/exit`)}
              >
                {busy === "exit" ? "…" : "CONFIRM EXIT"}
              </button>
              <button className="btn sm" disabled={anyBusy} onClick={() => setConfirmExit(false)}>
                CANCEL
              </button>
            </>
          ) : (
            <button className="btn sm danger" disabled={anyBusy} onClick={() => setConfirmExit(true)}>
              EXIT
            </button>
          )}
          </div>

      {confirmExit && (
        <div className="msg" style={{ borderColor: "var(--warn)" }}>
          <span className="warn">Exit</span> removes 100% of the liquidity, claims fees and rewards, and closes the
          position account. It cannot be undone — reopening costs rent again.
        </div>
      )}
      {zapping && zapPlan && (
        <div className="msg no-expand" style={{ borderColor: "var(--warn)" }}>
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

      {showTriggers && p.managed && (
        <TriggersPanel p={p} triggers={p.managed.triggers} onChanged={onChanged} disabled={anyBusy} />
      )}

      {ok && <div className="msg ok">{ok}</div>}
      {error && <div className="msg err">{error}</div>}
      {logs && (
        <pre className="logs" style={{ height: 140 }}>
          {logs.join("\n")}
        </pre>
      )}

          <hr className="lp-rule" />
          <LiquidityChart p={p} />
        </div>
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
          {p.binsToEdge >= 0 ? `${fmtNum(p.binsToEdge)} bins from edge` : `${fmtNum(-p.binsToEdge)} bins outside`}
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

interface BinView {
  binId: number;
  price: number;
  x: number;
  y: number;
  valueInY: number;
}

interface PositionBins {
  binStep: number;
  activeBinId: number;
  lowerBinId: number;
  upperBinId: number;
  tokenX: { symbol: string; decimals: number };
  tokenY: { symbol: string; decimals: number };
  bins: BinView[];
}

/**
 * The position's liquidity, bin by bin.
 *
 * Bar height is each bin's worth in the QUOTE token, not its raw amount. Bins
 * below the active one hold only quote and bins above hold only base, so raw
 * amounts put the two halves on incomparable scales and draw a cliff at the
 * active bin that does not exist. Valuing in quote is what makes the whole
 * distribution read as one shape — and it is what makes a gap in that shape
 * visible, which is the entire point of the panel: a two-bin notch left by a
 * drifted deposit was diagnosed off exactly this chart.
 *
 * Fetched only while expanded, and re-fetched when the active bin moves or a
 * rebalance lands — the two things that actually change the picture.
 */
function LiquidityChart({ p }: { p: PositionView }) {
  const [data, setData] = useState<PositionBins | null>(null);
  const [error, setError] = useState("");

  const rebalances = p.managed?.rebalanceCount ?? 0;
  useEffect(() => {
    let live = true;
    setError("");
    api
      .get<PositionBins>(`/api/positions/${p.positionPk}/bins?poolAddress=${p.poolAddress}`)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      // The card can be collapsed, or the poll can move the active bin, before
      // this lands. Without the guard a stale response overwrites a newer one.
      live = false;
    };
  }, [p.positionPk, p.poolAddress, p.activeBinId, rebalances]);

  if (error) return <div className="msg err">liquidity: {error}</div>;
  if (!data) return <div className="faint">reading bins…</div>;

  const max = Math.max(...data.bins.map((b) => b.valueInY), 0);
  const withBase = data.bins.filter((b) => b.x > 0).length;
  const withQuote = data.bins.filter((b) => b.y > 0).length;
  const sym = { x: data.tokenX.symbol, y: data.tokenY.symbol };
  // Totals and the active price come from the BINS, not from the card's own
  // position record. They are two different fetches taken at two different
  // moments, and a panel that labels one fetch's chart with another's numbers is
  // quietly lying — the totals here are exactly what the bars above add up to.
  const totalX = data.bins.reduce((t, b) => t + b.x, 0);
  const totalY = data.bins.reduce((t, b) => t + b.y, 0);
  const activePrice = data.bins.find((b) => b.binId === data.activeBinId)?.price ?? null;

  return (
    <>
      <div className="lp-head">
        <span className="faint">Liquidity by bin</span>
        <span className="lp-tok">
          <i className="sw" style={{ background: "#3ec9d6" }} /> {sym.y} <span className="fact-sub">below price</span>
        </span>
        <span className="lp-tok">
          <i className="sw" style={{ background: "#8b7bf0" }} /> {sym.x} <span className="fact-sub">above price</span>
        </span>
        <span className="lp-tok">
          <i className="sw" style={{ background: "#e8f3ff" }} /> active bin
        </span>
        <span style={{ flex: 1 }} />
        <span className="fact-sub">
          {data.bins.length} bins · {data.lowerBinId}…{data.upperBinId}
        </span>
      </div>

      <div className="lp-chart">
        {data.bins.map((b) => {
          const cls =
            b.valueInY <= 0 ? "empty" : b.binId === data.activeBinId ? "act" : b.binId < data.activeBinId ? "y" : "x";
          return (
            <div
              key={b.binId}
              className={`lp-bin ${cls}`}
              style={{ height: `${max > 0 ? Math.max(2, (b.valueInY / max) * 100) : 2}%` }}
              title={
                `bin ${b.binId} · ${fmtPrice(b.price)}\n` +
                `${fmtAmount(b.x)} ${sym.x} · ${fmtAmount(b.y)} ${sym.y}\n` +
                `${fmtAmount(b.valueInY)} ${sym.y} of value`
              }
            />
          );
        })}
      </div>
      <div className="lp-axis">
        <span>{fmtPrice(data.bins[0]?.price ?? 0)}</span>
        {/* Null when the price has left the position's range entirely — there is
            no active bin among these bins to read a price off. */}
        <span>{activePrice == null ? "active bin outside range" : `${fmtPrice(activePrice)} · active`}</span>
        <span>{fmtPrice(data.bins[data.bins.length - 1]?.price ?? 0)}</span>
      </div>

      <div className="lp-grid">
        <div>
          <span>{sym.x}</span>
          <b>{fmtAmount(totalX)}</b>
        </div>
        <div>
          <span>{sym.y}</span>
          <b>{fmtAmount(totalY)}</b>
        </div>
        <div>
          <span>bins holding {sym.x}</span>
          <b>{withBase}</b>
        </div>
        <div>
          <span>bins holding {sym.y}</span>
          <b>{withQuote}</b>
        </div>
        <div>
          <span>unclaimed fees</span>
          <b>{fmtUsd(p.feesUsd)}</b>
        </div>
        <div>
          <span>value</span>
          <b>{fmtUsd(p.valueUsd)}</b>
        </div>
      </div>
    </>
  );
}

/** "SL −15% · TP +40%", or whichever half is set. */
function thresholdSummary(t: TriggerView): string {
  const parts: string[] = [];
  if (t.stopLoss != null) parts.push(`SL ${fmtThreshold(t.stopLoss, t.measure)}`);
  if (t.takeProfit != null) parts.push(`TP ${fmtThreshold(t.takeProfit, t.measure)}`);
  return parts.length > 0 ? parts.join(" · ") : "NO THRESHOLD";
}

function fmtThreshold(n: number, measure: TriggerView["measure"]): string {
  return measure === "usd" ? fmtUsd(n) : `${n > 0 ? "+" : ""}${n}%`;
}

function onFireLabel(onFire: string): string {
  if (onFire === "exit") return "an exit, keeping both tokens";
  return `a zap out to the ${onFire === "zap-x" ? "X (base)" : "Y (quote)"} side`;
}

/**
 * Arms this position's stop loss and take profit.
 *
 * Deliberately its own panel behind a button rather than another row of facts:
 * this is the one control on the card that can close the position without anyone
 * watching, and the distance-to-threshold readout underneath it is the thing
 * that says whether the numbers above are sane before they are armed.
 */
function TriggersPanel({
  p,
  triggers,
  onChanged,
  disabled,
}: {
  p: PositionView;
  triggers: TriggerView;
  onChanged: () => void;
  disabled: boolean;
}) {
  // Blank means "use the global", which is why these start from the OVERRIDE and
  // not from the effective value — prefilling the inherited number would turn
  // every save into an override of a default the operator never meant to pin.
  const [stopLoss, setStopLoss] = useState(triggers.overridden && triggers.stopLoss != null ? String(triggers.stopLoss) : "");
  const [takeProfit, setTakeProfit] = useState(
    triggers.overridden && triggers.takeProfit != null ? String(triggers.takeProfit) : "",
  );
  const [onFire, setOnFire] = useState(triggers.overridden ? triggers.onFire : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save(patch: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      await api.post(`/api/positions/${p.positionPk}/triggers`, patch);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const armed = triggers.on;
  const reading = triggers.lastReading;
  const unit = triggers.measure === "usd" ? "$" : "%";
  const geo = gaugeGeometry(reading, triggers.stopLoss, triggers.takeProfit);

  return (
    <div className="msg no-expand" style={{ borderColor: armed ? "var(--warn)" : "var(--border)" }}>
      <div className="row" style={{ gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
        <span className="faint">TRIGGERS</span>
        <div className="segmented">
          <button
            type="button"
            className={armed ? "active" : ""}
            disabled={disabled || busy}
            onClick={() => void save({ on: true })}
          >
            ON
          </button>
          <button
            type="button"
            className={armed ? "" : "active"}
            disabled={disabled || busy}
            onClick={() => void save({ on: false })}
          >
            OFF
          </button>
        </div>
        <span className={triggers.overridden ? "tg-pill warn" : "tg-pill"}>
          {triggers.overridden ? "this position's thresholds" : "global thresholds"}
        </span>
        <span className="tg-sep" />
        <span className="fact-sub">
          {triggers.refusals > 0 && <span className="bad">refused {triggers.refusals}× · </span>}
          checked {triggers.lastCheckAt ? fmtAgo(triggers.lastCheckAt) : "never"}
        </span>
      </div>

      <TriggerGauge triggers={triggers} geo={geo} />

      <hr className="tg-rule" />

      <div className="row" style={{ gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
        <label className="field" style={{ minWidth: 130, marginBottom: 0 }}>
          <span>Stop loss ({unit})</span>
          <input value={stopLoss} onChange={(e) => setStopLoss(e.target.value)} placeholder={fallback(triggers.stopLoss)} />
        </label>
        <label className="field" style={{ minWidth: 130, marginBottom: 0 }}>
          <span>Take profit ({unit})</span>
          <input value={takeProfit} onChange={(e) => setTakeProfit(e.target.value)} placeholder={fallback(triggers.takeProfit)} />
        </label>
        <label className="field" style={{ minWidth: 190, marginBottom: 0 }}>
          <span>On fire</span>
          <select value={onFire} onChange={(e) => setOnFire(e.target.value)}>
            <option value="">global — {onFireLabel(triggers.onFire)}</option>
            <option value="zap-y">zap out to QUOTE (Y)</option>
            <option value="zap-x">zap out to BASE (X)</option>
            <option value="exit">exit — keep both tokens</option>
          </select>
        </label>
        <button
          className="btn"
          disabled={disabled || busy}
          onClick={() =>
            void save({
              // null is "clear the override and fall back to the global", which is
              // a different instruction from leaving the field out entirely.
              stopLoss: stopLoss.trim() === "" ? null : Number(stopLoss),
              takeProfit: takeProfit.trim() === "" ? null : Number(takeProfit),
              onFire: onFire === "" ? null : onFire,
            })
          }
        >
          {busy ? "…" : "SAVE THRESHOLDS"}
        </button>
        <span className="tg-sep" />
        <Confirmations streak={triggers.streak} of={triggers.confirmations} />
      </div>

      {triggers.disarmedReason && (
        <div className="msg err" style={{ marginTop: 10 }}>
          Disarmed after repeated refusals — the position is still open and no longer protected. Last reason:{" "}
          {triggers.disarmedReason}
        </div>
      )}

      {error && <div className="msg err" style={{ marginTop: 10 }}>{error}</div>}
    </div>
  );
}

/**
 * The stop, the live reading and the target on one axis.
 *
 * This is what replaced the paragraph that used to explain what the thresholds
 * meant. The explanation was true but static; the distance to the thresholds is
 * the thing that changes every check and the thing you open the panel to see.
 */
function TriggerGauge({ triggers, geo }: { triggers: TriggerView; geo: GaugeGeometry | null }) {
  const reading = triggers.lastReading;
  const m = triggers.measure;

  if (!geo) {
    return (
      <div className="fact-sub">Nothing armed can fire — set a stop loss or a take profit below.</div>
    );
  }

  // Amber once readings start stacking up. Off the ends the marker is pinned
  // rather than placed, and the two ends do NOT mean the same thing: past the
  // stop is the bad one, past the target is the position winning.
  const state = geo.beyond === "lo" ? " pinned" : geo.beyond === "hi" ? " over" : triggers.streak > 0 ? " hot" : "";
  const nowCls = geo.beyond === "lo" ? "bad" : geo.beyond === "hi" ? "good" : triggers.streak > 0 ? "warn" : undefined;

  return (
    <div className="tg-gauge">
      <div className="tg-ends">
        <span>
          <span className="faint">STOP </span>
          {triggers.stopLoss == null ? (
            <span className="fact-sub">none</span>
          ) : (
            <span className="bad">{fmtThreshold(triggers.stopLoss, m)}</span>
          )}
        </span>
        <span>
          <span className="faint">NOW </span>
          <span className={nowCls}>{reading == null ? "—" : fmtThreshold(round2(reading), m)}</span>
        </span>
        <span>
          <span className="faint">TARGET </span>
          {triggers.takeProfit == null ? (
            <span className="fact-sub">none</span>
          ) : (
            <span className="good">{fmtThreshold(triggers.takeProfit, m)}</span>
          )}
        </span>
      </div>

      <div className="tg-track">
        {geo.zeroPct != null && (
          <div className="tg-zero" style={{ left: `${geo.zeroPct}%` }} title="break even" />
        )}
        {geo.pct != null && <div className={`tg-mark${state}`} style={{ left: `${geo.pct}%` }} />}
      </div>

      <div className="tg-foot">
        <span className={geo.beyond === "lo" ? "bad" : undefined}>
          {gap(reading, triggers.stopLoss, "stop", reading != null && triggers.stopLoss != null && reading < triggers.stopLoss)}
        </span>
        <span className={geo.beyond === "hi" && triggers.takeProfit != null ? "good" : undefined}>
          {gap(reading, triggers.takeProfit, "target", reading != null && triggers.takeProfit != null && reading > triggers.takeProfit)}
        </span>
      </div>
    </div>
  );
}

/**
 * One end of the gauge's footer: how far there is left to go, if that is knowable.
 *
 * `past` matters. The distance is an absolute value, so without it a reading of
 * -8% against a -1% stop rendered as "7.2 to stop" — which reads as seven points
 * of headroom on a position that blew through its stop seven points ago.
 */
function gap(reading: number | null, threshold: number | null, label: string, past: boolean): string {
  if (threshold == null) return `no ${label}`;
  if (reading == null) return "—";
  return `${distance(reading, threshold)} ${past ? "past" : "to"} the ${label}`;
}

/**
 * How many consecutive readings have held, as dots.
 *
 * A trigger needs N in a row, so the interesting part is the progress, not the
 * fraction — "confirmed 0 of 3" made you read a sentence to learn nothing has
 * happened. Falls back to text past ten, where dots stop being countable.
 */
function Confirmations({ streak, of }: { streak: number; of: number }) {
  const title = `${streak} of ${of} consecutive readings held`;
  if (of > 10) {
    return (
      <span className="fact-sub" title={title}>
        confirmed {streak} of {of}
      </span>
    );
  }
  return (
    <span className="row" style={{ gap: 8 }} title={title}>
      <span className="fact-sub">confirmations</span>
      <span className="tg-dots">
        {Array.from({ length: of }, (_, i) => (
          <span key={i} className={i < streak ? "on" : undefined}>
            ●
          </span>
        ))}
      </span>
    </span>
  );
}

/** Placeholder showing the inherited value a blank box would fall back to. */
function fallback(v: number | null): string {
  return v == null ? "off" : `${v} (global)`;
}

/** How far the current reading is from a threshold, in the measure's own points. */
function distance(reading: number | null, threshold: number | null): string {
  if (reading == null || threshold == null) return "—";
  return `${round2(Math.abs(reading - threshold))}`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api.ts";
import { fmtAgo, fmtPct, fmtUsd } from "../format.ts";

// ALL is a timeframe rather than a separate all-time panel: the same figures over
// an unbounded window, in one place, read the same way.
const TIMEFRAMES = ["24H", "7D", "30D", "90D", "ALL"] as const;
type Timeframe = (typeof TIMEFRAMES)[number];

interface Point {
  ts: number;
  usd: number;
}

interface History {
  tf: string;
  /** null for ALL, which has no left edge. */
  from: number | null;
  /** Oldest moment the response covers — cost reaches back further than samples. */
  dataFrom: number | null;
  to: number;
  collectingSince: number | null;
  sampleIntervalMin: number;
  fees: Point[];
  pnl: Point[];
  cost: Point[];
  events: number[];
}

/** Cadence figures, which belong to the position rather than the window. */
export interface CadenceProps {
  medianGapMin: number | null;
  minGapMin: number | null;
  cooldownMin: number;
}

// Plot geometry, in viewBox units. The SVG scales to its container, so these are
// fixed and the container decides how big a unit is.
const L = 46;
const R = 694;
// Headroom for the topmost gridline's label. At 14 it sat hard against the panel's
// heading row; the label is drawn at the line's own y, so the line needs to start
// below the text above it.
const TOP = 20;

/**
 * Round gridline values covering 0..max.
 *
 * Slicing the maximum into equal fractions gives labels like "$0.8709" — every
 * one a different number of significant digits, none of them a value anyone would
 * choose. Snapping the step to 1/2/5 × a power of ten keeps the labels readable
 * whether the axis spans cents or hundreds of dollars.
 */
function niceTicks(lo: number, hi: number, count = 4): number[] {
  if (!(hi > lo)) return [0];
  const raw = (hi - lo) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step / 2; v += step) {
    out.push(Number(v.toFixed(10)));
  }
  return out;
}

/** "+$1.06" / "−$0.42". The sign is the whole point of a PnL, so it is never dropped. */
function signedUsd(v: number): string {
  return `${v >= 0 ? "+" : "−"}${fmtUsd(Math.abs(v))}`;
}

/** Cumulative series are rebased to the window so a short window is not two flat
 * lines pinned near their all-time totals — "what did this earn and spend over
 * THIS period" is the question the timeframe pills are asking. */
function rebase(points: Point[]): Point[] {
  if (points.length === 0) return points;
  const base = points[0].usd;
  return points.map((p) => ({ ts: p.ts, usd: p.usd - base }));
}

/**
 * Trims a series to start at `from`, carrying the last earlier reading forward as
 * an anchor at that instant.
 *
 * Used to clamp the plot to the data that actually exists. Requesting 90 days
 * when only one has been sampled otherwise draws 89 days of flat line and then a
 * vertical spike at the right edge — a shape that says "nothing happened for
 * three months", which is the opposite of the truth.
 */
function clampFrom(points: Point[], from: number): Point[] {
  const inside = points.filter((p) => p.ts >= from);
  const before = points.filter((p) => p.ts < from).pop();
  return before ? [{ ts: from, usd: before.usd }, ...inside] : inside;
}

export function HistoryCharts({ cadence }: { cadence: CadenceProps }) {
  const [tf, setTf] = useState<Timeframe>("24H");
  const [h, setH] = useState<History | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setH(await api.get<History>(`/api/history?tf=${tf}`));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [tf]);

  useEffect(() => {
    void load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [load]);

  // The plot starts where the data starts, not where the requested window starts.
  // ALL has no left edge, so there the data start IS the edge.
  const plotFrom = useMemo(() => {
    if (!h) return 0;
    const edge = h.from ?? h.dataFrom ?? h.to - 86_400_000;
    return Math.max(edge, h.dataFrom ?? edge);
  }, [h]);
  const fees = useMemo(() => rebase(clampFrom(h?.fees ?? [], plotFrom)), [h, plotFrom]);
  // Clamped BEFORE rebasing, so cost is measured from its value at the plot's
  // left edge and the two series answer for the same span.
  const cost = useMemo(() => rebase(clampFrom(h?.cost ?? [], plotFrom)), [h, plotFrom]);

  const pills = (
    <div className="pills-row">
      {TIMEFRAMES.map((t) => (
        <button
          key={t}
          type="button"
          className="pill-btn"
          aria-pressed={t === tf}
          onClick={() => setTf(t)}
        >
          {t}
        </button>
      ))}
    </div>
  );

  if (error) return <div className="msg err">{error}</div>;

  const netUsd = fees.length > 0 && cost.length > 0 ? fees[fees.length - 1].usd - cost[cost.length - 1].usd : null;
  // Two points is the minimum that draws a line; one sample is a dot with no story.
  const drawable = h != null && fees.length >= 2;

  return (
    <>
      <div className="panel">
        {/* The net figure IS the heading — "does the automation pay?" was a question
            this number answers, so it was a row of chrome above the answer. Caption
            below rather than beside it, which keeps the pills pinned top-right at
            every width instead of letting a long caption push them onto their own
            line. */}
        <div className="verdict-hd">
          <div>
            <b className={netUsd == null ? "" : netUsd >= 0 ? "good" : "bad"}>
              {netUsd == null ? "—" : `${netUsd >= 0 ? "+" : "−"}${fmtUsd(Math.abs(netUsd))}`}
            </b>
            <div className="faint">
              {netUsd == null
                ? "does the automation pay?"
                : `net ${tf === "ALL" ? "all time" : `over ${tf.toLowerCase()}`} · fees earned minus rebalance cost`}
            </div>
          </div>
          {pills}
        </div>

        {drawable && h ? (
          <PayChart
            key={tf}
            fees={fees}
            cost={cost}
            events={h.events.filter((ts) => ts >= plotFrom)}
            from={plotFrom}
            to={h.to}
            cadence={cadence}
            pnl={clampFrom(h.pnl, plotFrom)}
            pnlNowUsd={h.pnl.length > 0 ? h.pnl[h.pnl.length - 1].usd : null}
          />
        ) : (
          <div className="empty-chart">
            {h?.collectingSince == null ? (
              <>
                No PnL history yet. Sampling every {h?.sampleIntervalMin ?? 15} minutes from now — the 24h chart fills
                in within a day.
              </>
            ) : (
              <>
                Collecting since {fmtAgo(h.collectingSince)} — not enough readings to plot yet.
                <br />
                The Data API reports only a position's current value, so history cannot be backfilled.
              </>
            )}
          </div>
        )}

      </div>
    </>
  );
}

function PayChart({
  fees,
  cost,
  events,
  from,
  to,
  cadence,
  pnl,
  pnlNowUsd,
}: {
  fees: Point[];
  cost: Point[];
  events: number[];
  from: number;
  to: number;
  cadence: CadenceProps;
  /** Position PnL including price movement, overlaid on the same axis. */
  pnl: Point[];
  /** Latest PnL, for the legend. */
  pnlNowUsd: number | null;
}) {
  const BOT = 150;
  const TICK = 164;
  // One axis for all three series. It has to reach below zero, because PnL can be
  // negative and fees and cost never are — so $0 is a line through the plot rather
  // than its floor.
  const all = [...fees.map((p) => p.usd), ...cost.map((p) => p.usd), ...pnl.map((p) => p.usd), 0];
  const lo = Math.min(...all);
  const hi = Math.max(...all, 0.01);
  const pad = (hi - lo) * 0.08 || 0.01;
  const min = lo - pad;
  const max = hi + pad;
  const ticks = niceTicks(min, max);
  const x = (ts: number) => L + ((ts - from) / Math.max(1, to - from)) * (R - L);
  const y = (usd: number) => BOT - ((usd - min) / (max - min)) * (BOT - TOP);

  const feeLine = fees.map((p) => `${x(p.ts)},${y(p.usd)}`).join(" ");
  // Cost is a STEP: it only moves when a rebalance lands, and a smooth line would
  // imply continuous spending and hide that the spend is lumpy.
  const costPath = cost
    .map((p, i) => (i === 0 ? `M${x(p.ts)},${y(p.usd)}` : `H${x(p.ts)}V${y(p.usd)}`))
    .join(" ");

  const costAt = (ts: number) => {
    let v = cost[0]?.usd ?? 0;
    for (const c of cost) if (c.ts <= ts) v = c.usd;
    return v;
  };
  /** Nearest PnL reading — it is sampled on its own cadence, not the fee cadence. */
  const pnlAt = (ts: number): number | null => {
    if (pnl.length === 0) return null;
    let best = pnl[0];
    for (const p of pnl) if (Math.abs(p.ts - ts) < Math.abs(best.ts - ts)) best = p;
    return best.usd;
  };
  const pnlLine = pnl.map((p) => `${x(p.ts)},${y(p.usd)}`).join(" ");

  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const box = svg.getBoundingClientRect();
    const vx = ((e.clientX - box.left) / box.width) * 700;
    const ts = from + ((vx - L) / (R - L)) * (to - from);
    let best = 0;
    for (let i = 1; i < fees.length; i++) {
      if (Math.abs(fees[i].ts - ts) < Math.abs(fees[best].ts - ts)) best = i;
    }
    setHover(best);
  };

  const hv = hover != null ? fees[hover] : null;
  const feeEnd = fees[fees.length - 1];
  const costEnd = cost[cost.length - 1];

  return (
    <>
      <div className="chart-wrap">
        <svg
          ref={svgRef}
          viewBox={`0 0 700 186`}
          role="img"
          aria-label="Cumulative fees earned against cumulative rebalance cost over the selected window"
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        >
          {ticks.map((v) => (
            <g key={v}>
              <line className="grid" x1={L} y1={y(v)} x2={R} y2={y(v)} />
              <text className="axis" x={0} y={y(v) + 3}>
                {fmtUsd(v)}
              </text>
            </g>
          ))}

          <line className="zero" x1={L} y1={y(0)} x2={R} y2={y(0)} />

          {/* PnL first, so it sits BEHIND the two lines it shares the axis with. A
              filled band rather than a third line: it is context for the fee and
              cost story, not a peer of it. */}
          {pnl.length >= 2 && (
            <>
              <path
                d={`M${x(pnl[0].ts)},${y(0)} ${pnlLine.split(" ").map((s) => `L${s}`).join(" ")} L${x(pnl[pnl.length - 1].ts)},${y(0)} Z`}
                className="fill-pnl"
              />
              <polyline points={pnlLine} className="line-pnl-band" />
            </>
          )}

          {/* Anchored to the first DATA point, not the plot edge — anchoring at L
              drew a filled region over a span that has no readings in it. */}
          <path
            d={`M${x(fees[0].ts)},${y(0)} ${feeLine.split(" ").map((s) => `L${s}`).join(" ")} L${x(feeEnd.ts)},${y(0)} Z`}
            className="fill-fee"
          />
          <path d={costPath} className="line-cost" />
          <polyline points={feeLine} className="line-fee" />

          <g className="event-ticks">
            {events.map((ts) => (
              <line key={ts} x1={x(ts)} y1={TICK} x2={x(ts)} y2={TICK + 9} />
            ))}
          </g>
          <text className="axis" x={L} y={TICK + 22}>
            {fmtAgo(from)}
          </text>
          <text className="axis" x={R} y={TICK + 22} textAnchor="end">
            now
          </text>

          <circle cx={x(feeEnd.ts)} cy={y(feeEnd.usd)} r={3.5} className="dot-fee" />
          <circle cx={x(costEnd.ts)} cy={y(costEnd.usd)} r={3.5} className="dot-cost" />

          {hv && <line className="crosshair" x1={x(hv.ts)} y1={TOP} x2={x(hv.ts)} y2={BOT} />}
        </svg>
        {hv && (
          // Flipped to the left of the crosshair once past the midpoint, otherwise
          // it is clipped by the panel edge exactly where the newest data is.
          <div
            className="chart-tip"
            style={
              x(hv.ts) > 350
                ? { right: `${((700 - x(hv.ts) + 12) / 700) * 100}%` }
                : { left: `${((x(hv.ts) + 12) / 700) * 100}%` }
            }
          >
            <div className="faint">{fmtAgo(hv.ts)}</div>
            <div>
              <span className="tip-k">Fees</span>
              <span className="good">{fmtUsd(hv.usd)}</span>
            </div>
            <div>
              <span className="tip-k">Cost</span>
              <span className="bad">{fmtUsd(costAt(hv.ts))}</span>
            </div>
            {pnlAt(hv.ts) != null && (
              <div>
                <span className="tip-k">PnL</span>
                <span style={{ color: "var(--accent)" }}>{signedUsd(pnlAt(hv.ts)!)}</span>
              </div>
            )}
            <div>
              <span className="tip-k">Net</span>
              <span className={hv.usd - costAt(hv.ts) >= 0 ? "good" : "bad"}>
                {fmtUsd(hv.usd - costAt(hv.ts))}
              </span>
            </div>
          </div>
        )}
      </div>

      <div className="chart-legend">
        <span>
          <i className="sw-fee" />
          Fees earned <b>{fmtUsd(feeEnd.usd)}</b>
        </span>
        <span>
          <i className="sw-cost" />
          Rebalance cost <b>{fmtUsd(costEnd.usd)}</b>
        </span>
        <span>
          <i className="sw-event" />
          Rebalance ({events.length})
        </span>
        {/* Position PnL including price movement — the one figure on this card that
            the two lines above cannot tell you. Fees and cost say what the
            automation did; this says what the position is worth having done. */}
        {pnlNowUsd != null && (
          <span className="legend-end faint">
            PnL <b className={pnlNowUsd >= 0 ? "good" : "bad"}>{signedUsd(pnlNowUsd)}</b>
          </span>
        )}
      </div>
      {costEnd.usd > 0 && (
        <div className="tiles" style={{ marginTop: 11 }}>
          <MiniTile
            label="Cost drag"
            value={feeEnd.usd > 0 ? fmtPct((costEnd.usd / feeEnd.usd) * 100, 1) : "—"}
            cls={dragCls(feeEnd.usd, costEnd.usd)}
          />
          <MiniTile label="Cost per rebalance" value={events.length > 0 ? fmtUsd(costEnd.usd / events.length) : "—"} />
          <MiniTile
            label="Fees / day"
            value={fmtUsd(feeEnd.usd / Math.max(1 / 24, (to - from) / 86_400_000))}
            cls="good"
          />
          {/* The rebalance COUNT is already in the legend, so this slot carries the
              cadence instead — the number that says whether the count is a problem. */}
          <MiniTile
            label="Median gap"
            value={cadence.medianGapMin == null ? "—" : `${Math.round(cadence.medianGapMin)}m`}
            valueNote={cadence.minGapMin == null ? undefined : `shortest ${Math.round(cadence.minGapMin)}m`}
            sub={isChurning(cadence) ? "Raise COOLDOWN_MIN or widen RANGE_BINS." : undefined}
            cls={isChurning(cadence) ? "warn" : undefined}
          />
        </div>
      )}
    </>
  );
}

/**
 * Churn is the position re-centring about as fast as the cooldown permits, so the
 * yardstick is the cooldown those gaps were subject to — against a fixed number
 * the same reading is alarming on a 60-minute cooldown and unremarkable on a
 * 5-minute one. The floor covers COOLDOWN_MIN=0, where every gap would qualify.
 */
function isChurning({ medianGapMin, cooldownMin }: CadenceProps): boolean {
  if (medianGapMin == null) return false;
  return medianGapMin <= Math.max(cooldownMin * 1.5, 5);
}

function dragCls(fees: number, cost: number): string | undefined {
  if (fees <= 0) return "bad";
  const pct = (cost / fees) * 100;
  if (pct > 50) return "bad";
  if (pct > 25) return "warn";
  return "good";
}

function MiniTile({
  label,
  value,
  valueNote,
  sub,
  cls,
}: {
  label: string;
  value: string;
  valueNote?: string;
  sub?: string;
  cls?: string;
}) {
  return (
    <div className="tile">
      <div className="label">{label}</div>
      <div className={`value ${cls ?? ""}`}>
        {value}
        {valueNote && <span className="value-note">{valueNote}</span>}
      </div>
      {sub && <div className="faint">{sub}</div>}
    </div>
  );
}

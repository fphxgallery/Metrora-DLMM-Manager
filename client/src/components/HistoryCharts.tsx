import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api.ts";
import { fmtAgo, fmtPct, fmtUsd } from "../format.ts";

const TIMEFRAMES = ["24H", "7D", "30D", "90D"] as const;
type Timeframe = (typeof TIMEFRAMES)[number];

interface Point {
  ts: number;
  usd: number;
}

interface History {
  tf: string;
  from: number;
  to: number;
  enough: boolean;
  collectingSince: number | null;
  sampleIntervalMin: number;
  fees: Point[];
  pnl: Point[];
  cost: Point[];
  events: number[];
}

// Plot geometry, in viewBox units. The SVG scales to its container, so these are
// fixed and the container decides how big a unit is.
const L = 46;
const R = 694;
const TOP = 14;

/**
 * Round gridline values covering 0..max.
 *
 * Slicing the maximum into equal fractions gives labels like "$0.8709" — every
 * one a different number of significant digits, none of them a value anyone would
 * choose. Snapping the step to 1/2/5 × a power of ten keeps the labels readable
 * whether the axis spans cents or hundreds of dollars.
 */
function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0];
  const raw = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const out: number[] = [];
  for (let v = 0; v <= max + step / 2; v += step) out.push(Number(v.toFixed(10)));
  return out;
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

export function HistoryCharts() {
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
  const plotFrom = useMemo(() => {
    if (!h || h.fees.length === 0) return h?.from ?? 0;
    return Math.max(h.from, h.fees[0].ts);
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
        <div className="panel-hd">
          <h2>Does the automation pay?</h2>
          {pills}
        </div>

        {netUsd != null && (
          <div className="verdict">
            <b className={netUsd >= 0 ? "good" : "bad"}>
              {netUsd >= 0 ? "+" : "−"}
              {fmtUsd(Math.abs(netUsd))}
            </b>
            <span className="faint">net over {tf.toLowerCase()} · fees earned minus rebalance cost</span>
          </div>
        )}

        {drawable && h ? (
          <PayChart
            key={tf}
            fees={fees}
            cost={cost}
            events={h.events.filter((ts) => ts >= plotFrom)}
            from={plotFrom}
            to={h.to}
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

        {drawable && h && !h.enough && (
          <p className="note">
            History starts {fmtAgo(h.collectingSince ?? undefined)}, so this window is not full yet. Cost is exact
            regardless — every rebalance carries its own timestamp.
          </p>
        )}
      </div>

      {h && h.pnl.length >= 2 && (
        <div className="panel">
          <div className="panel-hd">
            <h2>Net PnL including price move</h2>
            <span className="faint">{fmtUsd(h.pnl[h.pnl.length - 1].usd)} now</span>
          </div>
          <PnlChart points={clampFrom(h.pnl, plotFrom)} from={plotFrom} to={h.to} />
          <p className="note">
            Its own chart, never a second axis on the one above. Impermanent loss from the pair moving is far larger
            than fee income, so sharing a scale would render the fee signal invisible.
          </p>
        </div>
      )}
    </>
  );
}

function PayChart({
  fees,
  cost,
  events,
  from,
  to,
}: {
  fees: Point[];
  cost: Point[];
  events: number[];
  from: number;
  to: number;
}) {
  const BOT = 150;
  const TICK = 164;
  const peak = Math.max(...fees.map((p) => p.usd), ...cost.map((p) => p.usd), 0.01);
  const ticks = niceTicks(peak);
  // The top gridline is the scale, so the highest value always sits inside the plot.
  const top = Math.max(peak, ticks[ticks.length - 1]);
  const x = (ts: number) => L + ((ts - from) / Math.max(1, to - from)) * (R - L);
  const y = (usd: number) => BOT - (usd / top) * (BOT - TOP);

  const feeLine = fees.map((p) => `${x(p.ts)},${y(p.usd)}`).join(" ");
  // Cost is a STEP: it only moves when a rebalance lands, and a smooth line would
  // imply continuous spending and hide that the spend is lumpy.
  const costPath = cost
    .map((p, i) => (i === 0 ? `M${x(p.ts)},${y(p.usd)}` : `H${x(p.ts)}V${y(p.usd)}`))
    .join(" ");

  // Breakeven: where cumulative fees first overtake cumulative cost inside this
  // window. Only marked when the crossing is actually here — no marker for a
  // crossing that happened outside the view.
  const costAt = (ts: number) => {
    let v = cost[0]?.usd ?? 0;
    for (const c of cost) if (c.ts <= ts) v = c.usd;
    return v;
  };
  let cross: Point | null = null;
  for (let i = 1; i < fees.length; i++) {
    if (fees[i].usd >= costAt(fees[i].ts) && fees[i - 1].usd < costAt(fees[i - 1].ts)) {
      cross = fees[i];
      break;
    }
  }

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

          {/* Anchored to the first DATA point, not the plot edge — anchoring at L
              drew a filled region over a span that has no readings in it. */}
          <path
            d={`M${x(fees[0].ts)},${y(0)} ${feeLine.split(" ").map((s) => `L${s}`).join(" ")} L${x(feeEnd.ts)},${y(0)} Z`}
            className="fill-fee"
          />
          <path d={costPath} className="line-cost" />
          <polyline points={feeLine} className="line-fee" />

          {cross && (
            <>
              <line className="zero" x1={x(cross.ts)} y1={TOP} x2={x(cross.ts)} y2={BOT} />
              <circle cx={x(cross.ts)} cy={y(cross.usd)} r={4.5} className="cross-mark" />
            </>
          )}

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
        <span className="legend-end faint">
          {cross
            ? `break even ${fmtAgo(cross.ts)}`
            : feeEnd.usd >= costEnd.usd
              ? "in profit across the whole window"
              : "not yet break even"}
        </span>
      </div>
      {costEnd.usd > 0 && (
        <div className="tiles" style={{ marginTop: 11 }}>
          <MiniTile label="Cost drag" value={feeEnd.usd > 0 ? fmtPct((costEnd.usd / feeEnd.usd) * 100, 1) : "—"} cls={dragCls(feeEnd.usd, costEnd.usd)} />
          <MiniTile label="Cost per rebalance" value={events.length > 0 ? fmtUsd(costEnd.usd / events.length) : "—"} />
          <MiniTile label="Fees / day" value={fmtUsd(feeEnd.usd / Math.max(1 / 24, (to - from) / 86_400_000))} cls="good" />
          <MiniTile label="Rebalances" value={String(events.length)} />
        </div>
      )}
    </>
  );
}

function dragCls(fees: number, cost: number): string | undefined {
  if (fees <= 0) return "bad";
  const pct = (cost / fees) * 100;
  if (pct > 50) return "bad";
  if (pct > 25) return "warn";
  return "good";
}

function MiniTile({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div className="tile">
      <div className="label">{label}</div>
      <div className={`value ${cls ?? ""}`}>{value}</div>
    </div>
  );
}

function PnlChart({ points, from, to }: { points: Point[]; from: number; to: number }) {
  const BOT = 96;
  const lo = Math.min(...points.map((p) => p.usd), 0);
  const hi = Math.max(...points.map((p) => p.usd), 0);
  const pad = (hi - lo) * 0.18 || 1;
  const x = (ts: number) => L + ((ts - from) / Math.max(1, to - from)) * (R - L);
  const y = (usd: number) => BOT - ((usd - lo + pad / 2) / (hi - lo + pad)) * (BOT - TOP);
  const line = points.map((p) => `${x(p.ts)},${y(p.usd)}`).join(" ");
  const end = points[points.length - 1];

  return (
    <div className="chart-wrap">
      <svg viewBox="0 0 700 110" role="img" aria-label="Position PnL including price movement over the selected window">
        <line className="zero" x1={L} y1={y(0)} x2={R} y2={y(0)} />
        <text className="axis" x={0} y={y(0) + 3}>
          {fmtUsd(0)}
        </text>
        {/* The extremes, so the swing has a magnitude and not just a shape. */}
        <text className="axis" x={0} y={y(hi) + 3}>
          {fmtUsd(hi)}
        </text>
        <text className="axis" x={0} y={y(lo) + 3}>
          {fmtUsd(lo)}
        </text>
        <polyline points={line} className="line-pnl" />
        <circle cx={x(end.ts)} cy={y(end.usd)} r={3.5} className="dot-pnl" />
      </svg>
    </div>
  );
}

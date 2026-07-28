import { useState } from "react";

export interface Bin {
  binId: number;
  price: number;
  amountX: number;
  amountY: number;
  liquidityUsd: number;
}

/**
 * Series colors are validated (dataviz six checks) against the panel surface
 * #0d1117 in dark mode: lightness band, chroma floor, CVD separation ΔE 18.6
 * protan, normal-vision ΔE 23.6, contrast ≥ 3:1.
 */
const COLOR_X = "#2494b0";
const COLOR_Y = "#c47616";

const W = 1000;
const H = 200;
const PAD_BOTTOM = 22;

/**
 * Liquidity per price bin, split by which token that bin holds. In a DLMM the
 * bins below the active price hold the quote token and those above hold the
 * base token, so the split is the shape of the book — it is what tells you
 * whether a range will actually be filled on both sides.
 */
export function BinChart({
  bins,
  activeBinId,
  range,
  symbolX,
  symbolY,
}: {
  bins: Bin[];
  activeBinId: number;
  range?: { minBinId: number; maxBinId: number };
  symbolX: string;
  symbolY: string;
}) {
  const [hover, setHover] = useState<Bin | null>(null);

  if (bins.length === 0) return <div className="faint">no bin data</div>;

  const max = Math.max(...bins.map((b) => b.liquidityUsd), 1);
  const slot = W / bins.length;
  const barW = Math.max(2, slot - 2); // 2px surface gap between adjacent bars
  const plotH = H - PAD_BOTTOM;

  const xOf = (i: number) => i * slot + (slot - barW) / 2;
  const hOf = (usd: number) => (usd / max) * plotH;

  const activeIdx = bins.findIndex((b) => b.binId === activeBinId);
  const inRangeIdx = range
    ? bins.map((b, i) => (b.binId >= range.minBinId && b.binId <= range.maxBinId ? i : -1)).filter((i) => i >= 0)
    : [];

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 6 }}>
        <div className="row" style={{ gap: 14 }}>
          <Legend color={COLOR_X} label={symbolX} />
          <Legend color={COLOR_Y} label={symbolY} />
        </div>
        <div className="faint" style={{ fontSize: 11 }}>
          {hover ? (
            <>
              bin {hover.binId} · {fmtPrice(hover.price)} · {fmtUsd(hover.liquidityUsd)}
              {"  "}
              <span style={{ color: COLOR_X }}>
                {fmtAmt(hover.amountX)} {symbolX}
              </span>{" "}
              <span style={{ color: COLOR_Y }}>
                {fmtAmt(hover.amountY)} {symbolY}
              </span>
            </>
          ) : (
            "hover a bin for detail"
          )}
        </div>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} style={{ display: "block", overflow: "visible" }}>
        {/* Selected range band, drawn under the bars. */}
        {inRangeIdx.length > 0 && (
          <rect
            x={xOf(inRangeIdx[0]) - 1}
            y={0}
            width={xOf(inRangeIdx[inRangeIdx.length - 1]) + barW - xOf(inRangeIdx[0]) + 2}
            height={plotH}
            fill="rgba(56,225,255,0.07)"
            stroke="rgba(56,225,255,0.35)"
            strokeDasharray="3 3"
          />
        )}

        {bins.map((b, i) => {
          // Bins hold one token or the other, so these effectively never stack;
          // drawing both handles the active bin, which holds a little of each.
          const share = xShare(b);
          const hX = hOf(b.liquidityUsd * share);
          const hY = hOf(b.liquidityUsd * (1 - share));
          const gap = hX > 0 && hY > 0 ? 2 : 0;
          return (
            <g
              key={b.binId}
              onMouseEnter={() => setHover(b)}
              onMouseLeave={() => setHover((h) => (h?.binId === b.binId ? null : h))}
            >
              {/* Invisible full-height hit target — bigger than the mark. */}
              <rect x={i * slot} y={0} width={slot} height={plotH} fill="transparent" />
              {hY > 0 && <rect x={xOf(i)} y={plotH - hY} width={barW} height={hY} rx={2} fill={COLOR_Y} />}
              {hX > 0 && (
                <rect x={xOf(i)} y={plotH - hY - gap - hX} width={barW} height={hX} rx={2} fill={COLOR_X} />
              )}
            </g>
          );
        })}

        {/* Active bin marker. */}
        {activeIdx >= 0 && (
          <>
            <line
              x1={xOf(activeIdx) + barW / 2}
              y1={0}
              x2={xOf(activeIdx) + barW / 2}
              y2={plotH}
              stroke="#38e1ff"
              strokeWidth={2}
            />
            <text x={xOf(activeIdx) + barW / 2} y={plotH + 14} fill="#38e1ff" fontSize={11} textAnchor="middle">
              active
            </text>
          </>
        )}

        {/* Recessive price axis: ends only, so labels never collide. */}
        <text x={0} y={plotH + 14} fill="#4a586a" fontSize={11}>
          {fmtPrice(bins[0].price)}
        </text>
        <text x={W} y={plotH + 14} fill="#4a586a" fontSize={11} textAnchor="end">
          {fmtPrice(bins[bins.length - 1].price)}
        </text>
      </svg>
    </div>
  );
}

/**
 * Share of a bin's USD value held as token X. Bins away from the active price
 * are single-sided, so this is 0 or 1 almost everywhere; only the active bin
 * holds both, and there an even split of the drawn height is close enough —
 * the exact ratio inside one bin isn't decision-relevant.
 */
function xShare(b: Bin): number {
  if (b.liquidityUsd <= 0) return 0;
  const anyX = b.amountX > 0;
  const anyY = b.amountY > 0;
  if (anyX && !anyY) return 1;
  if (anyY && !anyX) return 0;
  return anyX ? 0.5 : 0;
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="row" style={{ gap: 6 }}>
      <span style={{ width: 10, height: 10, background: color, borderRadius: 2, display: "inline-block" }} />
      <span className="faint">{label}</span>
    </span>
  );
}

function fmtPrice(n: number): string {
  if (n >= 1000) return n.toFixed(0);
  if (n >= 1) return n.toFixed(4);
  return n.toPrecision(4);
}
function fmtUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}
function fmtAmt(n: number): string {
  if (n === 0) return "0";
  if (n >= 1000) return n.toFixed(0);
  if (n >= 1) return n.toFixed(3);
  return n.toPrecision(3);
}

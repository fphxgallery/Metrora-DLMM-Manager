/**
 * Where the live trigger reading sits between the stop loss and the take profit.
 *
 * Its own module, with no imports, because it is the only arithmetic in the
 * triggers panel that can be wrong in a way you cannot see: a marker at the
 * wrong offset still looks like a marker. Kept pure so `test/trigger-gauge.test.mjs`
 * can exercise the clamping and the one-sided cases directly.
 */
export interface GaugeGeometry {
  /** Value at the left edge of the track. */
  lo: number;
  /** Value at the right edge. */
  hi: number;
  /** Marker offset across the track, 0–100, or null when there is no reading. */
  pct: number | null;
  /** Offset of the break-even line, or null when zero is not inside the track. */
  zeroPct: number | null;
  /**
   * Set when the reading is off the end of the track and the marker had to be
   * pinned. A reading past its own stop is exactly when the panel matters most,
   * so it must not silently render as "sitting at the threshold".
   */
  beyond: "lo" | "hi" | null;
}

/**
 * Null when there is nothing to draw — no thresholds at all, or a degenerate
 * span. The caller renders the panel without a gauge rather than a flat bar.
 *
 * With one threshold set the missing end is break-even, which is the honest
 * anchor: a position with a stop and no target has "back to flat" as the only
 * other number on the axis.
 */
export function gaugeGeometry(
  reading: number | null,
  stopLoss: number | null,
  takeProfit: number | null,
): GaugeGeometry | null {
  if (stopLoss == null && takeProfit == null) return null;

  const lo = stopLoss ?? 0;
  const hi = takeProfit ?? 0;
  const span = hi - lo;
  if (!(span > 0)) return null;

  let pct: number | null = null;
  let beyond: "lo" | "hi" | null = null;
  if (reading != null && Number.isFinite(reading)) {
    const raw = ((reading - lo) / span) * 100;
    if (raw < 0) beyond = "lo";
    else if (raw > 100) beyond = "hi";
    pct = Math.min(100, Math.max(0, raw));
  }

  // Only when zero is strictly inside: on a one-sided gauge it IS an edge, and
  // a line drawn on the border reads as the border.
  const zeroPct = lo < 0 && hi > 0 ? ((0 - lo) / span) * 100 : null;

  return { lo, hi, pct, zeroPct, beyond };
}

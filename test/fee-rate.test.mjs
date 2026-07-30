import test from "node:test";
import assert from "node:assert/strict";

import { positionFeeTvlPct, sinceOpenFeeRate } from "../dist/metrics.js";

// The position rate now comes from the indexer's own feePerTvl24h rather than being
// differenced out of the sample log. Measured on a live position, 20 of 23
// fifteen-minute intervals of allTimeFees moved by exactly zero while the position
// was in range the whole time — a rate differenced from that field reports when the
// indexer's number happened to jump, not what the position earned.

const H = 3_600_000;

test("the rate is parsed from its string form", () => {
  // Every numeric field on the PnL response is a string.
  assert.equal(positionFeeTvlPct("1.0986021612405226"), 1.0986021612405226);
});

test("a number is accepted too, in case the API stops quoting it", () => {
  assert.equal(positionFeeTvlPct(0.44), 0.44);
});

test("zero is a real rate, not a missing one", () => {
  // A position earning nothing is exactly the case worth showing.
  assert.equal(positionFeeTvlPct("0"), 0);
  assert.equal(positionFeeTvlPct(0), 0);
});

test("absent means absent, not zero", () => {
  // Rendering a missing field as 0% would claim the position earns nothing.
  assert.equal(positionFeeTvlPct(undefined), null);
  assert.equal(positionFeeTvlPct(null), null);
  assert.equal(positionFeeTvlPct(""), null);
});

test("a non-numeric value is rejected rather than becoming NaN", () => {
  // The shape changing must not put NaN% on a card.
  assert.equal(positionFeeTvlPct("n/a"), null);
  assert.equal(positionFeeTvlPct("1.2%"), null);
  assert.equal(positionFeeTvlPct({}), null);
  assert.equal(positionFeeTvlPct(Number.NaN), null);
  assert.equal(positionFeeTvlPct(Infinity), null);
});

test("a negative rate is rejected", () => {
  // Fee income cannot be negative; a negative here means the field changed meaning.
  assert.equal(positionFeeTvlPct("-0.5"), null);
});

test("the live value is a percent, comparable to the pool's", () => {
  // Verified by curl: fees["24h"] / tvl reproduces fee_tvl_ratio["24h"] exactly, so
  // both sides of the comparison are percents per 24h.
  const position = positionFeeTvlPct("1.0986021612405226");
  const pool = 0.43642580871128583;
  assert.ok(position > pool, "this position was beating its pool");
  assert.ok(Math.abs(position / pool - 2.52) < 0.01, "≈2.5x, as shown on the card");
});

// ---- the lifetime cross-check, logged and never displayed -------------------

test("the lifetime average annualises to a 24h figure", () => {
  // $3 of lifetime fees on a $100 position open for 72h = 1%/24h.
  const now = 1_000_000_000;
  const r = sinceOpenFeeRate(3, 100, now - 72 * H, now);
  assert.equal(r.basis, "since-open");
  assert.ok(Math.abs(r.pctPer24h - 1) < 1e-9, `got ${r.pctPer24h}`);
  assert.equal(Math.round(r.hours), 72);
});

test("a position open for minutes yields nothing", () => {
  // 24/0.08 is a 300x multiplier on rounding error.
  const now = 1_000_000_000;
  assert.equal(sinceOpenFeeRate(0.01, 100, now - 5 * 60_000, now), null);
});

test("a worthless or unpriced position yields nothing, never a division by zero", () => {
  const now = 1_000_000_000;
  assert.equal(sinceOpenFeeRate(1, 0, now - 48 * H, now), null);
  assert.equal(sinceOpenFeeRate(1, -5, now - 48 * H, now), null);
});

test("zero lifetime fees is a real zero", () => {
  const now = 1_000_000_000;
  assert.equal(sinceOpenFeeRate(0, 100, now - 48 * H, now).pctPer24h, 0);
});

test("the cross-check catches an order-of-magnitude divergence", () => {
  // What the tripwire in buildFeeRate is for: the two measure different windows and
  // will never agree closely, but a 5x gap would flag feePerTvl24h changing units.
  const now = 1_000_000_000;
  const lifetime = sinceOpenFeeRate(0.3119, 119.8, now - 8.3 * H, now);
  const indexer = positionFeeTvlPct("1.0986021612405226");
  const factor = indexer / lifetime.pctPer24h;
  // The real observed pair: ~0.75%/24h lifetime against 1.10% from the indexer.
  assert.ok(factor > 1 / 5 && factor < 5, `factor ${factor.toFixed(2)} should not trip the tripwire`);
});

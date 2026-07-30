import test from "node:test";
import assert from "node:assert/strict";

import { realizedFeeRate, sinceOpenFeeRate, feeRateSeries } from "../dist/metrics.js";

// Fee income as a percent of position value per 24h, so it can be compared with
// the pool's own fee_tvl_ratio["24h"] — verified against a live response to be a
// PERCENT (fees["24h"] / tvl reproduces it exactly), not a fraction.

const H = 3_600_000;
const s = (hoursAgo, feesUsd, now = 0) => ({ ts: now - hoursAgo * H, feesUsd });

test("a full day of samples gives the rate directly", () => {
  // $1 earned on a $100 position over 24h = 1%/24h.
  const r = realizedFeeRate([s(24, 10), s(0, 11)], 100);
  assert.equal(r.basis, "realized");
  assert.equal(Math.round(r.hours), 24);
  assert.ok(Math.abs(r.pctPer24h - 1) < 1e-9, `got ${r.pctPer24h}`);
});

test("a partial window is scaled to 24h and reports the hours it used", () => {
  // $0.25 over 6h on $100 → 1%/24h, but measured over 6 hours.
  const r = realizedFeeRate([s(6, 0), s(0, 0.25)], 100);
  assert.ok(Math.abs(r.pctPer24h - 1) < 1e-9, `got ${r.pctPer24h}`);
  assert.equal(Math.round(r.hours), 6, "the caller needs this to label it honestly");
});

test("fees are read as a DELTA, not a total", () => {
  // The log holds all-time fees. Treating the last value as the window's income
  // would report a position's whole lifetime as one day's earnings.
  const r = realizedFeeRate([s(24, 100), s(0, 101)], 100);
  assert.ok(Math.abs(r.pctPer24h - 1) < 1e-9, `got ${r.pctPer24h} — read the total, not the delta`);
});

test("a falling all-time total yields nothing rather than a negative rate", () => {
  // all-time fees include claimed fees, so they only rise. A fall is the indexer
  // disagreeing with itself, and 24/hours would scale it into a confident loss.
  assert.equal(realizedFeeRate([s(6, 5), s(0, 4)], 100), null);
});

test("too little history yields nothing rather than noise scaled by 96", () => {
  // Two samples 3 minutes apart: 24/0.05 = a 480x multiplier on rounding error.
  assert.equal(realizedFeeRate([s(0.05, 1), s(0, 1.001)], 100), null);
});

test("a worthless or unpriced position yields nothing, never a division by zero", () => {
  assert.equal(realizedFeeRate([s(24, 0), s(0, 1)], 0), null);
  assert.equal(realizedFeeRate([s(24, 0), s(0, 1)], -5), null);
});

test("fewer than two samples cannot make a rate", () => {
  assert.equal(realizedFeeRate([s(0, 1)], 100), null);
  assert.equal(realizedFeeRate([], 100), null);
});

// ---- since-open fallback ---------------------------------------------------

test("the lifetime average annualises to a 24h figure", () => {
  // $3 of lifetime fees on a $100 position open for 72h = 1%/24h.
  const now = 1_000_000_000;
  const r = sinceOpenFeeRate(3, 100, now - 72 * H, now);
  assert.equal(r.basis, "since-open");
  assert.ok(Math.abs(r.pctPer24h - 1) < 1e-9, `got ${r.pctPer24h}`);
  assert.equal(Math.round(r.hours), 72);
});

test("a position open for minutes yields nothing", () => {
  const now = 1_000_000_000;
  assert.equal(sinceOpenFeeRate(0.01, 100, now - 5 * 60_000, now), null);
});

test("zero lifetime fees is a real zero, not an absent rate", () => {
  // A position that has earned nothing is exactly the case worth showing.
  const now = 1_000_000_000;
  const r = sinceOpenFeeRate(0, 100, now - 48 * H, now);
  assert.equal(r.pctPer24h, 0);
});

// ---- trend ----------------------------------------------------------------

test("each trend point is its own bucket's rate, not a running total", () => {
  const now = 0;
  // Four hours, $0.25 earned each hour, $100 position → 6%/24h every bucket.
  const rows = [s(4, 0, now), s(3, 0.25, now), s(2, 0.5, now), s(1, 0.75, now), s(0, 1, now)];
  const series = feeRateSeries(rows, 100, H);
  assert.equal(series.length, 4);
  for (const v of series) assert.ok(Math.abs(v - 6) < 1e-9, `got ${v} — looks cumulative`);
});

test("a bucket with no fees reads zero and does not distort its neighbours", () => {
  const now = 0;
  const rows = [s(3, 0, now), s(2, 0.25, now), s(1, 0.25, now), s(0, 0.5, now)];
  const series = feeRateSeries(rows, 100, H);
  assert.equal(series.length, 3);
  assert.ok(Math.abs(series[0] - 6) < 1e-9);
  assert.equal(series[1], 0, "an hour out of range earns nothing");
  assert.ok(Math.abs(series[2] - 6) < 1e-9);
});

test("samples closer together than the bucket are accumulated, not dropped", () => {
  const now = 0;
  // 15-minute sampling, one hour of it: one bucket, not four and not zero.
  const rows = [s(1, 0, now), s(0.75, 0.1, now), s(0.5, 0.2, now), s(0.25, 0.3, now), s(0, 0.4, now)];
  const series = feeRateSeries(rows, 100, H);
  assert.equal(series.length, 1);
  assert.ok(Math.abs(series[0] - 9.6) < 1e-9, `got ${series[0]}`);
});

test("a series shorter than one bucket is empty rather than misleading", () => {
  const now = 0;
  assert.deepEqual(feeRateSeries([s(0.5, 0, now), s(0, 1, now)], 100, H), []);
});

test("guards mirror the rate itself", () => {
  assert.deepEqual(feeRateSeries([s(2, 0), s(0, 1)], 0, H), []);
  assert.deepEqual(feeRateSeries([s(2, 0), s(0, 1)], 100, 0), []);
  assert.deepEqual(feeRateSeries([], 100, H), []);
});

import test from "node:test";
import assert from "node:assert/strict";

import { cooldownFloor, isChurning } from "../dist/metrics.js";

// The churn hint used to render unconditionally, so the Median gap tile could show
// a healthy six-hour cadence with "Raise COOLDOWN_MIN" underneath it. Judging a
// gap needs the cooldown it was subject to: 7 minutes is churn on a 5-minute
// cooldown and impossible on a 60-minute one.

test("a per-position cooldown overrides the global default", () => {
  assert.equal(cooldownFloor([{ cooldownMin: 5 }], 60), 5);
});

test("an unset per-position cooldown falls back to the global", () => {
  assert.equal(cooldownFloor([{}], 60), 60);
});

test("the smallest cooldown wins — it is the one that can produce short gaps", () => {
  assert.equal(cooldownFloor([{ cooldownMin: 60 }, {}, { cooldownMin: 5 }], 30), 5);
});

test("no managed positions falls back to the global", () => {
  assert.equal(cooldownFloor([], 45), 45);
});

test("nothing is flagged before a position has rebalanced twice", () => {
  // medianGapMin is null until there are two rebalances of the SAME position.
  assert.equal(isChurning(null, 5), false);
});

test("a gap near the cooldown is churn — the cooldown is all that holds it back", () => {
  // The box's live setting: COOLDOWN_MIN=5.
  assert.equal(isChurning(6, 5), true);
  assert.equal(isChurning(7.5, 5), true);
});

test("a gap well clear of the cooldown is not churn", () => {
  assert.equal(isChurning(8, 5), false);
  assert.equal(isChurning(222, 5), false);
});

test("the same reading is judged against the configured cooldown, not a constant", () => {
  // 70 minutes: churn on an hour-long cooldown, unremarkable on a 5-minute one.
  assert.equal(isChurning(70, 60), true);
  assert.equal(isChurning(70, 5), false);
});

test("a healthy cadence on the shipped default is not flagged", () => {
  assert.equal(isChurning(222, 60), false);
});

test("COOLDOWN_MIN=0 falls back to a 5 minute floor instead of flagging everything", () => {
  // With no cooldown every gap is "as fast as allowed", so the ratio test alone
  // would flag a perfectly healthy six-hour cadence.
  assert.equal(isChurning(360, 0), false);
  assert.equal(isChurning(3, 0), true);
});

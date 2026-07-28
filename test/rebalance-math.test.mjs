import test from "node:test";
import assert from "node:assert/strict";
import BN from "bn.js";

import { balancedTargetRange, planSwapLeg } from "../dist/meteora/rebalance.js";
import { rangeStatus, toRaw, toUi, valuePosition } from "../dist/meteora/pricing.js";

// The target range must match the SDK's BalancedStrategyBuilder exactly, or the
// plan shown to the user (and the rent estimate derived from it) describes a
// different position than the one the instruction actually builds.
test("balancedTargetRange re-centres on the active bin", () => {
  // Odd width: symmetric, width preserved.
  assert.deepEqual(balancedTargetRange({ lowerBinId: -10, upperBinId: 10 }, 100), [90, 110]);

  // Even width: floor(width/2) per side, extra bin to the bid side — so a
  // 10-bin position comes back 11 bins wide. This is SDK behavior, not a
  // rounding choice of ours, and the plan must report what will really happen.
  const [lo, hi] = balancedTargetRange({ lowerBinId: 0, upperBinId: 9 }, 50);
  assert.deepEqual([lo, hi], [44, 54]);
  assert.equal(hi - lo + 1, 11, "an even width grows by one bin");
});

test("balancedTargetRange keeps the active bin inside, and settles at odd widths", () => {
  for (let width = 1; width <= 64; width++) {
    const [lo, hi] = balancedTargetRange({ lowerBinId: 0, upperBinId: width - 1 }, 1000);
    assert.ok(lo <= 1000 && hi >= 1000, `active bin inside range for width ${width}`);

    const newWidth = hi - lo + 1;
    assert.equal(newWidth, width % 2 === 1 ? width : width + 1, `width ${width}`);

    // Widening happens at most once: re-centring the result is a fixed point.
    const [lo2, hi2] = balancedTargetRange({ lowerBinId: lo, upperBinId: hi }, 1000);
    assert.equal(hi2 - lo2 + 1, newWidth, `width ${width} is stable after one rebalance`);
  }
});

test("planSwapLeg does nothing while the position is near balanced", () => {
  const balanced = valuePosition({
    amountXRaw: new BN(1_000_000_000), // 1 X at price 100 => 100 Y of value
    amountYRaw: new BN(100_000_000),
    decimalsX: 9,
    decimalsY: 6,
    priceXinY: 100,
  });
  assert.equal(balanced.ratioBps, 5000);
  assert.equal(planSwapLeg(balanced, { ratioToleranceBps: 1500, maxSwapPctOfPosition: 60 }), null);
});

test("planSwapLeg withdraws half of a fully one-sided position", () => {
  // All value in Y: price ran up through the range and sold the X off.
  const oneSided = valuePosition({
    amountXRaw: new BN(0),
    amountYRaw: new BN(200_000_000), // 200 Y
    decimalsX: 9,
    decimalsY: 6,
    priceXinY: 100,
  });
  assert.equal(oneSided.ratioBps, 0);

  const leg = planSwapLeg(oneSided, { ratioToleranceBps: 1500, maxSwapPctOfPosition: 60 });
  assert.ok(leg);
  assert.equal(leg.surplusIsX, false, "surplus is the quote token");
  assert.equal(leg.withdrawBps, 5000, "half of the Y side goes to the swap");
  assert.equal(leg.swapValueInY, 100);
});

test("planSwapLeg respects the max-swap cap", () => {
  const oneSided = valuePosition({
    amountXRaw: new BN(2_000_000_000), // all in X
    amountYRaw: new BN(0),
    decimalsX: 9,
    decimalsY: 6,
    priceXinY: 100,
  });
  assert.equal(oneSided.ratioBps, 10000);

  // A 10% cap must bind before the natural 50% split.
  const capped = planSwapLeg(oneSided, { ratioToleranceBps: 1500, maxSwapPctOfPosition: 10 });
  assert.ok(capped);
  assert.equal(capped.surplusIsX, true);
  assert.equal(capped.withdrawBps, 1000);
});

test("planSwapLeg ignores an empty position", () => {
  const empty = valuePosition({
    amountXRaw: new BN(0),
    amountYRaw: new BN(0),
    decimalsX: 9,
    decimalsY: 6,
    priceXinY: 100,
  });
  assert.equal(planSwapLeg(empty, { ratioToleranceBps: 1500, maxSwapPctOfPosition: 60 }), null);
});

test("rangeStatus reports distance to the edge, negative once outside", () => {
  const inside = rangeStatus(100, 90, 110);
  assert.equal(inside.inRange, true);
  assert.equal(inside.binsToEdge, 10);
  assert.equal(inside.width, 21);

  const atEdge = rangeStatus(109, 90, 110);
  assert.equal(atEdge.binsToEdge, 1);

  const outside = rangeStatus(115, 90, 110);
  assert.equal(outside.inRange, false);
  assert.equal(outside.binsToEdge, -5, "negative distance means bins outside the range");
});

// toRaw is the boundary between UI numbers and on-chain amounts. Multiplying by
// 10**decimals in floating point is wrong for 9-decimal mints at realistic
// sizes, which would silently deposit the wrong amount.
test("toRaw is exact for 9-decimal amounts", () => {
  assert.equal(toRaw(1.234567891, 9).toString(), "1234567891");
  assert.equal(toRaw(123.456, 9).toString(), "123456000000");
  assert.equal(toRaw(0.000000001, 9).toString(), "1");
  assert.equal(toRaw(0, 9).toString(), "0");
  assert.equal(toRaw(-5, 9).toString(), "0", "negative amounts clamp to zero");
});

test("toRaw truncates rather than rounding up past the balance", () => {
  // A 7th decimal on a 6-decimal mint must not round up into more than the
  // wallet holds.
  assert.equal(toRaw(1.9999999, 6).toString(), "1999999");
});

test("toUi round-trips toRaw", () => {
  for (const [ui, decimals] of [
    [1.234567891, 9],
    [0.5, 6],
    [1000, 6],
  ]) {
    assert.equal(toUi(toRaw(ui, decimals), decimals), ui);
  }
});

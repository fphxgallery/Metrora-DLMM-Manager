import test from "node:test";
import assert from "node:assert/strict";
import BN from "bn.js";

import { balancedTargetRange, legLanded, planSwapLeg } from "../dist/meteora/rebalance.js";
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

// A rebalance leg's "did it land?" test decides whether resumeJournal finishes
// the remaining legs or writes the entry off. Getting it wrong on path B closes
// the entry and leaves the withdrawn surplus stranded in the wallet, so the
// drifted case below is the one that actually costs money.
test("legLanded reads a landed leg that drifted off the plan's target", () => {
  const entry = { sigs: [], sourceMinBinId: 0, sourceMaxBinId: 20, targetMinBinId: 90, targetMaxBinId: 110 };

  // Landed exactly where the plan said.
  assert.equal(legLanded(entry, { lowerBinId: 90, upperBinId: 110 }), true);

  // Landed, but the active bin moved between plan and send so the builder
  // re-centred one bin over. Still landed — this is the case that used to be
  // misread as "withdraw leg did not land".
  assert.equal(legLanded(entry, { lowerBinId: 91, upperBinId: 111 }), true);
  assert.equal(legLanded(entry, { lowerBinId: 85, upperBinId: 105 }), true);

  // Never landed: the position is untouched at its source range.
  assert.equal(legLanded(entry, { lowerBinId: 0, upperBinId: 20 }), false);
});

test("legLanded falls back to the exact target when source bins are absent", () => {
  // Entries journalled before sourceMin/MaxBinId existed. No source data means
  // no drift tolerance is possible — don't guess, use the old exact test.
  const legacy = { sigs: [], targetMinBinId: 90, targetMaxBinId: 110 };
  assert.equal(legLanded(legacy, { lowerBinId: 90, upperBinId: 110 }), true);
  assert.equal(legLanded(legacy, { lowerBinId: 91, upperBinId: 111 }), false);
});

// Seen live 2026-07-29: a withdraw failed on chain (no signature recorded), the
// engine retried 30s later, and the retry's withdraw landed and moved the range.
// Judging the FAILED entry by range alone read that move as its own, which would
// have let it spend the retry's stranded funds.
test("legLanded refuses to guess when two entries target one position", () => {
  const failed = { sigs: [], sourceMinBinId: -6560, sourceMaxBinId: -6492, targetMinBinId: -6543, targetMaxBinId: -6475 };
  const moved = { lowerBinId: -6544, upperBinId: -6476 }; // moved by the OTHER entry

  assert.equal(legLanded(failed, moved), true, "range alone says landed — the old, wrong answer");
  assert.equal(legLanded(failed, moved, { ambiguous: true }), false, "but not attributable, so no");
});

test("legLanded trusts a recorded signature over any range inference", () => {
  // Signatures are journalled only after every send in the leg returned, so one
  // being present outranks circumstantial evidence — even ambiguity.
  const landedEntry = { sigs: ["SIG"], sourceMinBinId: -6560, sourceMaxBinId: -6492, targetMinBinId: -6544, targetMaxBinId: -6476 };
  assert.equal(legLanded(landedEntry, { lowerBinId: -6560, upperBinId: -6492 }), true, "even if the range looks unmoved");
  assert.equal(legLanded(landedEntry, { lowerBinId: -6544, upperBinId: -6476 }, { ambiguous: true }), true);
});

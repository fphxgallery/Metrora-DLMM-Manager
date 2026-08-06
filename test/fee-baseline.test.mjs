import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Store } from "../dist/state.js";
import { feesSinceBaseline, feeBaselineCoverage } from "../dist/metrics.js";

// The cost ledger can be emptied from the dashboard; the indexer's allTimeFees
// cannot. Compared raw after a reset, /api/metrics put a position's LIFETIME fee
// income against a few hours of spending — on the live box that read as 1.01%
// cost drag while the ledger held 2 of 56 rebalances. Wrong by ~28x, and wrong in
// the flattering direction, which is the one that matters for a figure whose only
// job is to answer "is this worth running".
//
// The baseline is what each position had already earned when the ledger was
// cleared. Subtracting it puts income back on the ledger's window — the same rule
// partitionRebalances applies across positions, applied across time.

const dir = () => mkdtempSync(join(tmpdir(), "dlmm-fee-baseline-"));

const position = (pk, over = {}) => ({
  positionPk: pk,
  poolAddress: "POOL1",
  auto: true,
  openedAt: 1_000,
  rebalanceCount: 0,
  pollsTotal: 0,
  pollsInRange: 0,
  ...over,
});

const record = (pk, ts) => ({
  ts,
  positionPk: pk,
  poolAddress: "POOL1",
  path: "B",
  fromRange: [-10, 10],
  toRange: [-9, 11],
  costLamports: 70_000,
  rentLamports: 0,
  sigs: ["SIG"],
});

// ------------------------------------------------------------ arithmetic ----

test("fees are counted from the baseline, not from the position's birth", () => {
  assert.equal(feesSinceBaseline(88.5, 64.2), 88.5 - 64.2);
});

test("no baseline means the whole history counts", () => {
  // A position opened after the last reset, or an install that has never reset.
  assert.equal(feesSinceBaseline(88.5, undefined), 88.5);
});

test("a falling all-time total reads as zero, never as negative income", () => {
  // Claimed fees only rise, so a fall is the indexer contradicting itself. The
  // same guard the fee-rate code applies to the same field.
  assert.equal(feesSinceBaseline(60, 64.2), 0);
});

test("a zero or unusable all-time figure contributes nothing", () => {
  assert.equal(feesSinceBaseline(0, 64.2), 0);
  assert.equal(feesSinceBaseline(Number.NaN, 64.2), 0);
  assert.equal(feesSinceBaseline(88.5, Number.NaN), 88.5, "an unusable baseline is ignored, not applied");
});

// -------------------------------------------------------------- coverage ----

test("with no reset ever, nothing is uncovered", () => {
  const cov = feeBaselineCoverage([position("A"), position("B")], undefined);
  assert.deepEqual(cov, { covered: 0, uncovered: 0 });
});

test("a position opened AFTER the reset needs no baseline", () => {
  // Its whole history is already inside the window.
  const cov = feeBaselineCoverage([position("A", { openedAt: 5_000 })], 2_000);
  assert.deepEqual(cov, { covered: 0, uncovered: 0 });
});

test("a position that predates the reset with no baseline is reported uncovered", () => {
  // This is the honest-reporting case: its pre-reset earnings are still being
  // counted, so feesEarnedUsd is overstated and the dashboard must be able to say so.
  const cov = feeBaselineCoverage(
    [position("A", { openedAt: 1_000, feeBaselineUsd: 12 }), position("B", { openedAt: 1_000 })],
    2_000,
  );
  assert.deepEqual(cov, { covered: 1, uncovered: 1 });
});

// ----------------------------------------------------------------- store ----

test("clearing the ledger stamps each position's baseline and the reset time", () => {
  const store = new Store(dir());
  store.upsertPosition(position("A"));
  store.upsertPosition(position("B"));
  store.recordRebalance(record("A", 10));
  store.recordRebalance(record("B", 20));

  const before = Date.now();
  const dropped = store.clearRebalances(new Map([["A", 64.19], ["B", 3.5]]));

  assert.equal(dropped, 2);
  assert.deepEqual(store.rebalances(), []);
  assert.equal(store.position("A").feeBaselineUsd, 64.19);
  assert.equal(store.position("B").feeBaselineUsd, 3.5);
  assert.ok(store.ledgerResetAt() >= before, "the window's start is recorded");
  assert.ok(store.position("A").feeBaselineAt >= before);
});

test("a position whose fees could not be read gets NO baseline rather than a zero", () => {
  // A zero would claim it had earned nothing so far, which understates the
  // baseline and overstates income — the very error being fixed. Left unset, it
  // is counted in full and reported as uncovered instead of quietly lying.
  const store = new Store(dir());
  store.upsertPosition(position("A"));
  store.upsertPosition(position("B"));

  store.clearRebalances(new Map([["A", 64.19]]));

  assert.equal(store.position("A").feeBaselineUsd, 64.19);
  assert.equal(store.position("B").feeBaselineUsd, undefined);
  assert.equal(feeBaselineCoverage(store.positions(), store.ledgerResetAt()).uncovered, 1);
});

test("the reset still does not move real money", () => {
  // rebalanceCount and lastRebalanceAt are the position's own state, and
  // lastRebalanceAt is what the cooldown guard reads. A chart reset that cleared
  // it would let a position rebalance again immediately.
  const store = new Store(dir());
  store.upsertPosition(position("A"));
  store.recordRebalance(record("A", 1_700_000_000_000));
  store.openJournal({
    id: "j1",
    positionPk: "A",
    poolAddress: "POOL1",
    path: "B",
    phase: "swap",
    targetMinBinId: -10,
    targetMaxBinId: 10,
    strategyType: "Spot",
    startedAt: 1,
    updatedAt: 1,
    sigs: [],
  });

  store.clearRebalances(new Map([["A", 5]]));

  const p = store.position("A");
  assert.equal(p.rebalanceCount, 1, "count survives");
  assert.equal(p.lastRebalanceAt, 1_700_000_000_000, "cooldown still armed");
  assert.equal(store.pendingJournal().length, 1, "a pending entry still marks funds in the wallet");
});

test("the baseline and reset time survive a reload from disk", () => {
  const d = dir();
  const store = new Store(d);
  store.upsertPosition(position("A"));
  store.clearRebalances(new Map([["A", 64.19]]));

  const onDisk = JSON.parse(readFileSync(join(d, "state.json"), "utf8"));
  assert.equal(onDisk.positions[0].feeBaselineUsd, 64.19);
  assert.ok(onDisk.ledgerResetAt > 0);

  const reloaded = new Store(d);
  assert.equal(reloaded.position("A").feeBaselineUsd, 64.19);
  assert.equal(reloaded.ledgerResetAt(), onDisk.ledgerResetAt);
});

test("the live shape: lifetime income against a reset ledger stops flattering", () => {
  // The box on 2026-08-06: $88.51 all-time fees, $64.19 of it earned before the
  // reset, $5.00 of cost recorded since.
  const costUsd = 5.0049;
  const raw = 88.5105;
  const windowed = feesSinceBaseline(raw, 64.1892);

  const before = (costUsd / raw) * 100;
  const after = (costUsd / windowed) * 100;

  assert.ok(before < 6, `was ${before.toFixed(2)}%`);
  assert.ok(after > 20, `now ${after.toFixed(2)}%`);
});

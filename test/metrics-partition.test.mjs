import test from "node:test";
import assert from "node:assert/strict";

import { partitionRebalances, lamportsOf } from "../dist/metrics.js";

// The METRICS tab drew cost from EVERY rebalance ever recorded, but fee income
// only from positions still managed -- so a freshly opened position inherited
// four closed positions' spending and NET read negative before it had rebalanced
// even once. Cost and fees have to come from the same set of positions.
const rec = (positionPk, costLamports, rentLamports = 0) => ({
  ts: 1,
  positionPk,
  poolAddress: "POOL1",
  path: "A",
  fromRange: [-10, 10],
  toRange: [-8, 12],
  costLamports,
  rentLamports,
  sigs: [],
});

test("spending on closed positions is kept out of the managed total", () => {
  const all = [rec("DEAD1", 1000), rec("LIVE", 300), rec("DEAD2", 2000)];
  const { managed, retired } = partitionRebalances(all, [{ positionPk: "LIVE" }]);

  assert.equal(lamportsOf(managed), 300, "only the live position's own cost");
  assert.equal(lamportsOf(retired), 3000, "closed positions' cost is reported, not discarded");
});

test("a new position with no rebalances yet shows zero cost, not inherited cost", () => {
  // The reported symptom: cost tile read $0.3340 on a position that had never
  // rebalanced, so NET was negative and cost drag was undefined.
  const all = [rec("DEAD1", 4_540_000)];
  const { managed, retired } = partitionRebalances(all, [{ positionPk: "FRESH" }]);

  assert.equal(managed.length, 0);
  assert.equal(lamportsOf(managed), 0);
  assert.equal(retired.length, 1, "still surfaced separately so it is not invisible");
});

test("rent is counted alongside fees", () => {
  // Bin-array rent is NOT refunded on close -- the arrays are pool-owned and
  // shared -- so it belongs in cost. Position-account rent, which IS refunded,
  // is never recorded here.
  const { managed } = partitionRebalances([rec("LIVE", 500, 71_000)], [{ positionPk: "LIVE" }]);
  assert.equal(lamportsOf(managed), 71_500);
});

test("every record is retained by exactly one side of the split", () => {
  const all = [rec("A", 1), rec("B", 2), rec("C", 3), rec("A", 4)];
  const { managed, retired } = partitionRebalances(all, [{ positionPk: "A" }, { positionPk: "C" }]);

  assert.equal(managed.length + retired.length, all.length);
  assert.equal(lamportsOf(managed) + lamportsOf(retired), 10, "no record is double-counted or lost");
  assert.deepEqual(retired.map((r) => r.positionPk), ["B"]);
});

test("no managed positions means nothing is attributed to the current setup", () => {
  const all = [rec("DEAD1", 1000), rec("DEAD2", 2000)];
  const { managed, retired } = partitionRebalances(all, []);

  assert.equal(lamportsOf(managed), 0);
  assert.equal(retired.length, 2);
});

test("an empty ledger partitions cleanly", () => {
  const { managed, retired } = partitionRebalances([], [{ positionPk: "LIVE" }]);
  assert.deepEqual(managed, []);
  assert.deepEqual(retired, []);
  assert.equal(lamportsOf([]), 0);
});

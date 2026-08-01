import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SampleLog } from "../dist/history.js";
import { Store } from "../dist/state.js";

// The reset is allowed to destroy history. It is NOT allowed to change what the
// engine will do next: the cooldown guard reads a position's own lastRebalanceAt
// (Engine.evaluate), so clearing that alongside the ledger would make a position
// eligible to rebalance the moment the chart was tidied -- a UI action moving real
// money. These tests pin the boundary between the two.

function scratch() {
  return mkdtempSync(join(tmpdir(), "dlmm-reset-"));
}

function managedPosition(over = {}) {
  return {
    positionPk: "P1",
    poolAddress: "POOL",
    auto: true,
    openedAt: 1,
    rebalanceCount: 0,
    pollsTotal: 0,
    pollsInRange: 0,
    ...over,
  };
}

function rebalanceRecord(over = {}) {
  return {
    ts: 1,
    positionPk: "P1",
    poolAddress: "POOL",
    path: "A",
    fromRange: [0, 10],
    toRange: [5, 15],
    costLamports: 5_000,
    rentLamports: 0,
    sigs: ["sig"],
    ...over,
  };
}

test("SampleLog.clear empties the log and reports the row count", () => {
  const dir = scratch();
  const log = new SampleLog(dir);
  log.append([
    { ts: 1000, positionPk: "A", feesUsd: 1, pnlUsd: 2 },
    { ts: 2000, positionPk: "A", feesUsd: 3, pnlUsd: 4 },
  ]);
  assert.equal(log.read().length, 2);

  assert.equal(log.clear(), 2);
  assert.deepEqual(log.read(), []);
  assert.equal(log.earliest(), undefined);
  // Truncated, not deleted -- append must keep working without a mkdir dance.
  assert.ok(existsSync(join(dir, "samples.jsonl")));
  assert.equal(readFileSync(join(dir, "samples.jsonl"), "utf8"), "");
});

test("SampleLog.clear is a no-op on an empty log and leaves it usable", () => {
  const log = new SampleLog(scratch());
  assert.equal(log.clear(), 0);
  log.append([{ ts: 5, positionPk: "A", feesUsd: 1, pnlUsd: 1 }]);
  assert.equal(log.read().length, 1);
});

test("Store.clearRebalances drops the ledger but never the cooldown state", () => {
  const dir = scratch();
  const store = new Store(dir);
  store.upsertPosition(managedPosition());
  for (const ts of [10_000, 20_000, 30_000]) {
    store.recordRebalance(rebalanceRecord({ ts }));
  }

  const before = store.position("P1");
  assert.equal(store.rebalances().length, 3);
  assert.equal(before.rebalanceCount, 3);
  assert.equal(before.lastRebalanceAt, 30_000);

  assert.equal(store.clearRebalances(), 3);

  assert.deepEqual(store.rebalances(), []);
  const after = store.position("P1");
  // The two figures the engine actually reads. If either moved, a reset would
  // have shortened a cooldown.
  assert.equal(after.lastRebalanceAt, 30_000, "cooldown anchor must survive a reset");
  assert.equal(after.rebalanceCount, 3, "the position's own count is not chart history");

  // And it must survive a reload -- the clear is persisted, the rest is not lost.
  const reloaded = new Store(dir);
  assert.deepEqual(reloaded.rebalances(), []);
  assert.equal(reloaded.position("P1").lastRebalanceAt, 30_000);
});

test("Store.clearRebalances leaves pending journal entries alone", () => {
  const store = new Store(scratch());
  store.openJournal({
    id: "j1",
    positionPk: "P1",
    poolAddress: "POOL",
    path: "B",
    phase: "swapped",
    targetMinBinId: 0,
    targetMaxBinId: 10,
    createdAt: 1,
    updatedAt: 1,
  });
  store.recordRebalance(rebalanceRecord({ ts: 1, path: "B" }));

  store.clearRebalances();

  // A pending entry is the only record that funds are sitting in the wallet.
  assert.equal(store.pendingJournal().length, 1);
  assert.equal(store.pendingJournal()[0].id, "j1");
});

test("Store.clearRebalances on an empty ledger reports zero and does not write", () => {
  const dir = scratch();
  const store = new Store(dir);
  assert.equal(store.clearRebalances(), 0);
  assert.deepEqual(store.rebalances(), []);
});

test("a cleared ledger still accepts new records", () => {
  const store = new Store(scratch());
  store.upsertPosition(managedPosition());
  store.recordRebalance(rebalanceRecord({ ts: 1, sigs: ["a"] }));
  store.clearRebalances();
  store.recordRebalance(rebalanceRecord({ ts: 2, sigs: ["b"] }));
  assert.equal(store.rebalances().length, 1);
  assert.deepEqual(store.rebalances()[0].sigs, ["b"]);
  // The count keeps counting from where it was -- it was never chart state.
  assert.equal(store.position("P1").rebalanceCount, 2);
});

test("state.json written before clearRebalances existed still loads", () => {
  const dir = scratch();
  writeFileSync(
    join(dir, "state.json"),
    JSON.stringify({ version: 1, positions: [], journal: [], rebalances: [] }),
  );
  const store = new Store(dir);
  assert.equal(store.clearRebalances(), 0);
});

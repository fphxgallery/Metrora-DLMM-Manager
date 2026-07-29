import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Store } from "../dist/state.js";

// The journal is a ring buffer, and it used to shift() blindly off the head. An
// entry stuck in `pending` is the ONLY record that funds are sitting in the
// wallet instead of the pool, so evicting one deletes the evidence resumeJournal
// needs -- and at ~16 rebalances an hour the buffer wraps inside a day.
const CAP = 100;

function newStore() {
  return new Store(mkdtempSync(join(tmpdir(), "dlmm-evict-")));
}

function entry(id, phase) {
  return {
    id,
    positionPk: `POS-${id}`,
    poolAddress: "POOL1",
    path: "B",
    phase,
    targetMinBinId: -10,
    targetMaxBinId: 10,
    strategyType: "Spot",
    startedAt: 0,
    updatedAt: 0,
    sigs: [],
  };
}

test("a pending entry at the head survives the buffer wrapping", () => {
  const store = newStore();
  store.openJournal(entry("stuck", "swap"));
  // Fill past the cap with completed entries, as a day of normal running would.
  for (let i = 0; i < CAP + 5; i++) store.openJournal(entry(`ok-${i}`, "done"));

  assert.ok(store.journalEntry("stuck"), "stuck entry was evicted -- funds unrecoverable");
  assert.equal(store.get().journal.length, CAP);
  assert.deepEqual(
    store.pendingJournal().map((j) => j.id),
    ["stuck"],
    "resume must still be able to find it",
  );
});

test("eviction takes the OLDEST terminal entry, not just any", () => {
  const store = newStore();
  store.openJournal(entry("oldest-done", "done"));
  store.openJournal(entry("stuck", "withdraw"));
  for (let i = 0; i < CAP - 1; i++) store.openJournal(entry(`ok-${i}`, "done"));

  assert.equal(store.get().journal.length, CAP);
  assert.equal(store.journalEntry("oldest-done"), undefined, "oldest terminal should go first");
  assert.ok(store.journalEntry("stuck"));
});

test("an all-pending journal grows past the cap rather than dropping funds", () => {
  const store = newStore();
  for (let i = 0; i < CAP + 3; i++) store.openJournal(entry(`p-${i}`, "swap"));

  assert.equal(store.get().journal.length, CAP + 3, "nothing evictable, so keep everything");
  assert.equal(store.pendingJournal().length, CAP + 3);
});

test("a failed entry is terminal and stays evictable", () => {
  const store = newStore();
  store.openJournal(entry("failed-one", "failed"));
  for (let i = 0; i < CAP; i++) store.openJournal(entry(`ok-${i}`, "done"));

  assert.equal(store.journalEntry("failed-one"), undefined);
});

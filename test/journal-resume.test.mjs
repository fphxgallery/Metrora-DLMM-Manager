import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Store } from "../dist/state.js";

function newStore() {
  const dir = mkdtempSync(join(tmpdir(), "dlmm-test-"));
  return { store: new Store(dir), file: join(dir, "state.json") };
}

const entry = (over = {}) => ({
  id: "j1", positionPk: "POS1", poolAddress: "POOL1", path: "B", phase: "deposit",
  targetMinBinId: -6574, targetMaxBinId: -6506,
  sourceMinBinId: -6560, sourceMaxBinId: -6492,
  strategyType: "Curve", startedAt: 1, updatedAt: 1,
  sigs: ["SIG_WITHDRAW", "SIG_SWAP"],
  error: "resume failed: Signature 2u4YDQ… has expired: block height exceeded.",
  ...over,
});

// A recovered rebalance that still carries the failure text which stranded it
// renders in the dashboard as though it had failed.
test("completing a journal entry clears the failure that stranded it", () => {
  const { store, file } = newStore();
  store.openJournal(entry());
  store.updateJournal("j1", {
    phase: "done",
    sigs: ["SIG_WITHDRAW", "SIG_SWAP", "SIG_DEPOSIT"],
    error: undefined,
  });

  const j = store.journalEntry("j1");
  assert.equal(j.phase, "done");
  assert.equal(j.error, undefined, "stale error cleared in memory");
  assert.deepEqual(j.sigs, ["SIG_WITHDRAW", "SIG_SWAP", "SIG_DEPOSIT"], "recovery signature recorded");

  // It must not survive the JSON round-trip either: `error: undefined` has to be
  // dropped on write, not merely hidden behind an in-memory property.
  const onDisk = JSON.parse(readFileSync(file, "utf8")).journal[0];
  assert.equal("error" in onDisk, false, "no stale error persisted");
  assert.equal(onDisk.phase, "done");
});

test("a completed entry leaves the pending set", () => {
  const { store } = newStore();
  store.openJournal(entry());
  assert.equal(store.pendingJournal().length, 1);
  store.updateJournal("j1", { phase: "done", error: undefined });
  assert.equal(store.pendingJournal().length, 0);
});

// recordRebalance is what moves lastRebalanceAt. Skipping it on a resumed
// rebalance left the cooldown guard blind to one that had just happened.
test("recording a resumed rebalance starts the cooldown and bills the cost", () => {
  const { store } = newStore();
  store.upsertPosition({
    positionPk: "POS1", poolAddress: "POOL1", auto: true,
    openedAt: 1, rebalanceCount: 0, pollsTotal: 0, pollsInRange: 0,
  });
  assert.equal(store.position("POS1").lastRebalanceAt, undefined, "no cooldown before");

  store.recordRebalance({
    ts: 1_700_000_000_000, positionPk: "POS1", poolAddress: "POOL1", path: "B",
    fromRange: [-6560, -6492], toRange: [-6574, -6506],
    costLamports: 87_943, rentLamports: 0,
    sigs: ["SIG_WITHDRAW", "SIG_SWAP", "SIG_DEPOSIT"],
  });

  const p = store.position("POS1");
  assert.equal(p.rebalanceCount, 1);
  assert.equal(p.lastRebalanceAt, 1_700_000_000_000, "cooldown now sees it");
  assert.equal(store.rebalances().length, 1);
  assert.equal(store.rebalances()[0].costLamports, 87_943, "fees counted in the ledger");
});

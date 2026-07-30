import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";

import { Store } from "../dist/state.js";
import { registerPositionRoutes } from "../dist/routes/positions.js";

// REBALANCE NOW deliberately bypasses the cooldown / range / cost guards -- those
// are policy and the operator may overrule them. The pending-journal check is
// NOT policy. A path-B rebalance that stopped mid-flight has withdrawn funds
// sitting in the WALLET, and the engine correctly declines to act, which makes
// the position look stale and invites a manual click. That click would open a
// SECOND journal entry on the same position, and resume attributes a leg by the
// range change it caused -- with two pending entries the change cannot be
// attributed to either, so NEITHER is resumable and the funds strand by hand.

const POS = "POSITION_A";
const OTHER = "POSITION_B";

function entry(id, positionPk, phase) {
  return {
    id,
    positionPk,
    poolAddress: "POOL1",
    path: "B",
    phase,
    targetMinBinId: -10,
    targetMaxBinId: 10,
    strategyType: "Spot",
    startedAt: 0,
    updatedAt: 0,
  };
}

function buildApp(journal) {
  const store = new Store(mkdtempSync(join(tmpdir(), "dlmm-manual-guard-")));
  for (const e of journal) store.openJournal(e);
  store.upsertPosition({
    positionPk: POS,
    poolAddress: "POOL1",
    auto: true,
    openedAt: 0,
    rebalanceCount: 0,
    pollsTotal: 0,
    pollsInRange: 0,
  });

  // Planning is the step the guard must prevent from ever running. Any call
  // into it fails the test loudly rather than silently reaching the network.
  const planned = [];
  const ctx = {
    cfg: { apiToken: "" },
    client: {},
    dataApi: {},
    sender: {},
    store,
    log: { info() {}, warn() {}, error() {}, debug() {} },
    engine: { isBusy: () => false },
  };
  const rebalanceDeps = {
    ...ctx,
    // planRebalance/executeRebalance are imported by the route module itself, so
    // these deps are only reachable if the guard let the request through; the
    // real functions would then throw on the empty client stub.
    planned,
  };

  const app = Fastify();
  registerPositionRoutes(app, ctx, rebalanceDeps);
  return { app, store };
}

const rebalance = (app, pk = POS) => app.inject({ method: "POST", url: `/api/positions/${pk}/rebalance` });

test("manual rebalance is refused with 409 while a journal entry for that position is pending", async () => {
  const { app } = buildApp([entry("J1", POS, "swap")]);
  const res = await rebalance(app);

  assert.equal(res.statusCode, 409, "409 -- same refusal shape as the in-flight check");
  await app.close();
});

test("the refusal names the journal id and the phase it stopped at", async () => {
  const { app } = buildApp([entry("J1", POS, "swap")]);
  const body = (await rebalance(app)).json();

  assert.match(body.error, /J1/, "names the journal entry the operator must look up");
  assert.match(body.error, /swap/, "names the phase, i.e. where the funds are");
  assert.equal(body.journalId, "J1");
  assert.equal(body.phase, "swap");
  await app.close();
});

test("the refusal only promises remedies that actually exist", async () => {
  // The engine retries pending entries from its tick (RESUME_RETRY_MS = 120s)
  // and /api/journal is read-only -- there is no clear/force-fail endpoint, so
  // the message must not send the operator looking for one.
  const { app } = buildApp([entry("J1", POS, "withdraw")]);
  const body = (await rebalance(app)).json();

  assert.match(body.error, /automatically/, "says the engine is already retrying it");
  assert.match(body.error, /journal/, "points at the read-only journal to watch");
  await app.close();
});

test("a pending entry for a DIFFERENT position does not block this one", async () => {
  const { app } = buildApp([entry("J1", OTHER, "swap")]);
  const res = await rebalance(app);

  assert.notEqual(res.statusCode, 409, "the guard is per-position, not global");
  await app.close();
});

test("terminal entries do not block: phase done", async () => {
  const { app } = buildApp([entry("J1", POS, "done")]);
  assert.notEqual((await rebalance(app)).statusCode, 409);
  await app.close();
});

test("terminal entries do not block: phase failed", async () => {
  const { app } = buildApp([entry("J1", POS, "failed")]);
  assert.notEqual((await rebalance(app)).statusCode, 409);
  await app.close();
});

test("a resolved history plus one live entry still blocks", async () => {
  // The live entry is last and the terminal ones must not mask it.
  const { app } = buildApp([
    entry("J0", POS, "done"),
    entry("JX", OTHER, "deposit"),
    entry("J2", POS, "deposit"),
  ]);
  const body = (await rebalance(app)).json();

  assert.equal(body.journalId, "J2");
  assert.equal(body.phase, "deposit");
  await app.close();
});

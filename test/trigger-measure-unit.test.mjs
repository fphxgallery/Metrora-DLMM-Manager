import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";

import { evaluateTrigger, TriggerRunner } from "../dist/triggers.js";
import { Store } from "../dist/state.js";
import { registerPositionRoutes } from "../dist/routes/positions.js";
import { loadConfig } from "../dist/config.js";

// A threshold is a bare number, so its meaning lives entirely in TRIGGER_MEASURE.
// v1.11.3 changed that default from "pct" to "usd" because the indexer's
// pnlPctChange divides by CUMULATIVE deposits -- measured on the live box the
// denominator was exactly rebalanceCount + 1 times the position's value, so a
// -3% stop on a position that had rebalanced 14 times was really a -58% stop and
// KIO sat 35% down without firing.
//
// The switch that fixes that is also the hazard: the same stored numbers, read as
// dollars, were ALREADY crossed on three of four live positions. Two of those
// closes would have been accidents, and closing is terminal -- bin-array rent
// never comes back. So the unit travels with the number, and a mismatch disarms
// instead of acting.

const MIN = 60_000;
const NOW = 1_800_000_000_000;

function cfg(over = {}) {
  return {
    stopLoss: undefined,
    takeProfit: undefined,
    triggerOnFire: "zap-y",
    triggerConfirmations: 1,
    triggerCheckMin: 2,
    triggerMinAgeMin: 30,
    triggerMeasure: "usd",
    triggersArmed: true,
    dryRun: false,
    ...over,
  };
}

function position(triggers = {}) {
  return {
    positionPk: "POS1",
    poolAddress: "POOL1",
    pairName: "KIO-SOL",
    auto: true,
    openedAt: NOW - 10 * 24 * 60 * MIN,
    rebalanceCount: 14,
    pollsTotal: 0,
    pollsInRange: 0,
    triggers: { on: true, streak: 0, refusals: 0, stopLoss: -3, takeProfit: 10, ...triggers },
  };
}

// ---------------------------------------------------------------- the guard

test("thresholds written before the unit was recorded are not read as dollars", () => {
  // The live shape at the moment of upgrade: KIO carrying stopLoss -3 meaning
  // -3%, config now comparing in USD, and pnlUsd at -26.15. Read as dollars the
  // stop is crossed by a factor of eight and would close the position.
  const v = evaluateTrigger({ now: NOW, reading: -26.15, managed: position(), cfg: cfg(), busy: false });

  assert.equal(v.fire, false, "an unstamped threshold was acted on as if it were dollars");
  assert.equal(v.code, "stale-measure");
});

test("a threshold stamped pct is not read as dollars either", () => {
  const v = evaluateTrigger({
    now: NOW,
    reading: -26.15,
    managed: position({ measure: "pct" }),
    cfg: cfg(),
    busy: false,
  });

  assert.equal(v.fire, false);
  assert.equal(v.code, "stale-measure");
});

test("the take profit side is refused on a stale unit too", () => {
  // CATE on the live box: takeProfit 10 meaning +10%, sitting at +$9.63. Read as
  // dollars that is nearly crossed, and a cent of drift would have closed a
  // position that was up 12% and doing exactly what it was opened to do.
  const v = evaluateTrigger({
    now: NOW,
    reading: 9.63,
    managed: position({ measure: "pct", stopLoss: -1, takeProfit: 5 }),
    cfg: cfg(),
    busy: false,
  });

  assert.equal(v.fire, false);
  assert.equal(v.code, "stale-measure");
});

test("a matching unit evaluates normally and still fires", () => {
  // The guard must not be a blanket refusal -- once the operator has re-entered
  // the thresholds in dollars, the stop has to work.
  const v = evaluateTrigger({
    now: NOW,
    reading: -26.15,
    managed: position({ measure: "usd" }),
    cfg: cfg(),
    busy: false,
  });

  assert.equal(v.fire, true, "a correctly stamped threshold failed to fire");
  assert.equal(v.side, "stop");
  assert.equal(v.threshold, -3);
});

test("the unit is checked ahead of busy and of the minimum age", () => {
  // Ordering matters: a stale position should surface on the first tick it is
  // looked at, not on whichever one the timing guards happen to let through.
  const busyVerdict = evaluateTrigger({
    now: NOW,
    reading: -26.15,
    managed: position({ measure: "pct" }),
    cfg: cfg(),
    busy: true,
  });
  assert.equal(busyVerdict.code, "stale-measure", "busy masked the unit mismatch");

  const young = position({ measure: "pct" });
  young.openedAt = NOW - 5 * MIN;
  const youngVerdict = evaluateTrigger({ now: NOW, reading: -26.15, managed: young, cfg: cfg(), busy: false });
  assert.equal(youngVerdict.code, "stale-measure", "too-new masked the unit mismatch");
});

test("a position with triggers off is still just off, not stale", () => {
  const v = evaluateTrigger({
    now: NOW,
    reading: -26.15,
    managed: position({ on: false }),
    cfg: cfg(),
    busy: false,
  });
  assert.equal(v.code, "off");
});

// ---------------------------------------------------------------- the runner

function harness({ conf = cfg(), triggers = {}, reading = -26.15 } = {}) {
  const store = new Store(mkdtempSync(join(tmpdir(), "dlmm-measure-")));
  const p = position(triggers);
  store.upsertPosition({ ...p, triggers: undefined });
  store.setTriggers("POS1", p.triggers);

  const closed = [];
  const alerts = [];
  const ctx = {
    cfg: conf,
    store,
    log: { info() {}, debug() {}, warn() {}, error() {} },
    notifier: { notify: (t) => alerts.push(t) },
    client: { wallet: () => ({ publicKey: { toBase58: () => "WALLET" } }) },
    dataApi: {
      positionPnlSafe: async () => [
        { positionAddress: "POS1", pnlUsd: String(reading), pnlPctChange: String(reading) },
      ],
    },
  };
  const actions = {
    zapOut: async (_d, params) => closed.push({ kind: "zap", ...params }),
    exit: async (_d, params) => closed.push({ kind: "exit", ...params }),
  };
  return { runner: new TriggerRunner(ctx, {}, () => false, actions), store, closed, alerts };
}

test("a stale position is disarmed rather than closed", async () => {
  const { runner, store, closed, alerts } = harness();
  await runner.run(NOW);

  assert.deepEqual(closed, [], "a position was CLOSED on a threshold in the wrong unit");
  assert.equal(store.position("POS1").triggers.on, false, "left armed while unable to ever fire");
  const why = store.position("POS1").triggers.disarmedReason;
  assert.match(why, /set in pct/, "the reason must name the unit the numbers were written in");
  assert.match(why, /now compare in usd/, "and the unit they are now being read as");
  assert.match(why, /Re-enter/, "and what to do about it");
  assert.equal(alerts.length, 1, "the operator was not told, or was told more than once");
  assert.match(alerts[0], /DISARMED/);
  assert.match(alerts[0], /still open and no longer protected/);
});

test("the thresholds are left alone so the operator can see what they were", async () => {
  const { runner, store } = harness();
  await runner.run(NOW);

  const t = store.position("POS1").triggers;
  assert.equal(t.stopLoss, -3, "the stale threshold was silently rewritten");
  assert.equal(t.takeProfit, 10);
});

test("the alert does not repeat on every check interval", async () => {
  const { runner, alerts } = harness();
  await runner.run(NOW);
  await runner.run(NOW + 10 * MIN);
  await runner.run(NOW + 20 * MIN);

  assert.equal(alerts.length, 1, "a disarmed position kept paging");
});

test("no PnL is fetched for a position whose unit is stale", async () => {
  // The mismatch is knowable without the network, and the fetch is the expensive
  // part of a tick. Also proves the guard runs on the reading-free gate pass.
  const { runner, store } = harness();
  let fetches = 0;
  const wrapped = new TriggerRunner(
    {
      cfg: cfg(),
      store,
      log: { info() {}, debug() {}, warn() {}, error() {} },
      notifier: { notify() {} },
      client: { wallet: () => ({ publicKey: { toBase58: () => "WALLET" } }) },
      dataApi: {
        positionPnlSafe: async () => {
          fetches += 1;
          return [];
        },
      },
    },
    {},
    () => false,
    { zapOut: async () => {}, exit: async () => {} },
  );
  await wrapped.run(NOW);

  assert.equal(fetches, 0, "paid for a PnL read on a position that could not act on it");
});

test("a correctly stamped position still closes through the runner", async () => {
  const { runner, closed, alerts } = harness({ triggers: { measure: "usd" } });
  await runner.run(NOW);

  assert.equal(closed.length, 1, "the guard blocked a legitimate stop loss");
  assert.equal(closed[0].kind, "zap");
  assert.match(alerts[0], /FIRED/);
});

// ---------------------------------------------------------------- the stamp

function app() {
  const store = new Store(mkdtempSync(join(tmpdir(), "dlmm-measure-route-")));
  store.upsertPosition({
    positionPk: "POS1",
    poolAddress: "POOL1",
    auto: true,
    openedAt: 0,
    rebalanceCount: 0,
    pollsTotal: 0,
    pollsInRange: 0,
  });
  const ctx = {
    cfg: { apiToken: "", triggerMeasure: "usd", stopLoss: undefined, takeProfit: undefined },
    client: {},
    dataApi: {},
    sender: {},
    store,
    log: { info() {}, warn() {}, error() {}, debug() {} },
    engine: { isBusy: () => false },
  };
  const f = Fastify();
  registerPositionRoutes(f, ctx, { ...ctx });
  return { f, store };
}

test("setting thresholds stamps the unit they were entered in", async () => {
  const { f, store } = app();
  const res = await f.inject({
    method: "POST",
    url: "/api/positions/POS1/triggers",
    payload: { on: true, stopLoss: -3, takeProfit: 10 },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(store.position("POS1").triggers.measure, "usd");
  await f.close();
});

test("arming an already-configured position re-stamps it", async () => {
  // Arming is the moment the operator last looked at the numbers and agreed with
  // them, which is exactly the claim the guard needs -- so it must count as
  // consent even when no threshold value changed.
  const { f, store } = app();
  store.setTriggers("POS1", { stopLoss: -3, takeProfit: 10, measure: "pct" });

  await f.inject({ method: "POST", url: "/api/positions/POS1/triggers", payload: { on: true } });

  assert.equal(store.position("POS1").triggers.measure, "usd");
  assert.equal(store.position("POS1").triggers.stopLoss, -3, "re-stamping must not disturb the thresholds");
  await f.close();
});

// ---------------------------------------------------------------- the default

test("TRIGGER_MEASURE defaults to usd", () => {
  const c = loadConfig({ KEYPAIR_PATH: "/nonexistent", DATA_DIR: mkdtempSync(join(tmpdir(), "dlmm-cfg-")) });
  assert.equal(c.triggerMeasure, "usd", "the percent measure cannot be used as a stop -- see the config comment");
});

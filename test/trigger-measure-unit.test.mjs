import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";

import { evaluateTrigger, TriggerRunner, MEASURE_REV } from "../dist/triggers.js";
import { pnlPctOfBasis, MIN_PNL_BASIS_USD } from "../dist/metrics.js";
import { Store } from "../dist/state.js";
import { registerPositionRoutes } from "../dist/routes/positions.js";
import { loadConfig } from "../dist/config.js";

// A threshold is a bare number, so its meaning lives entirely in the measure.
//
// The indexer's pnlPctChange divides by CUMULATIVE deposits, and a path-B
// rebalance redeposits the whole position -- so the denominator grows by one
// position-notional every rebalance. Measured live the dilution was exactly
// rebalanceCount + 1: KIO, 27% down on its capital, reported -2.6% after 14
// rebalances and sat under a -3% stop that could never fire.
//
// v1.11.3 sidestepped that by defaulting to usd. v1.11.4 fixes the percentage
// itself, dividing by capital committed, and pct is the default again.
//
// Both changes are hazards as well as fixes, and for the same reason: the stored
// numbers do not change when their meaning does. Read as dollars, three of four
// live positions were ALREADY past their thresholds, two of them by accident.
// And "pct" now names a different number than it did in v1.11.3 -- on KIO the two
// definitions read -2.6% and -26.9% at the same instant. So the unit AND its
// revision travel with the numbers, and any mismatch disarms instead of acting.

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
    managed: position({ measure: "usd", measureRev: MEASURE_REV }),
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
  assert.match(why, /before v1\.11\.3/, "the reason must name what the numbers were written against");
  assert.match(why, /now compare in \$/, "and what they are now being read as");
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
  const { runner, closed, alerts } = harness({ triggers: { measure: "usd", measureRev: MEASURE_REV } });
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

test("TRIGGER_MEASURE defaults to pct, which v1.11.4 made sound", () => {
  const c = loadConfig({ KEYPAIR_PATH: "/nonexistent", DATA_DIR: mkdtempSync(join(tmpdir(), "dlmm-cfg-")) });
  assert.equal(c.triggerMeasure, "pct");
});

// ------------------------------------------------- the revision of the measure

test("a pct stamp from v1.11.3 is as stale as no stamp at all", () => {
  // Same unit name, different number. The old pct was the indexer's diluted
  // figure; -3 written against it is nowhere near -3% of capital.
  const v = evaluateTrigger({
    now: NOW,
    reading: -26.9,
    managed: position({ measure: "pct", measureRev: undefined }),
    cfg: cfg({ triggerMeasure: "pct" }),
    busy: false,
  });

  assert.equal(v.fire, false, "a threshold written against the old percent was acted on");
  assert.equal(v.code, "stale-measure");
});

test("an older revision is refused even when the unit matches exactly", () => {
  const v = evaluateTrigger({
    now: NOW,
    reading: -26.9,
    managed: position({ measure: "pct", measureRev: MEASURE_REV - 1 }),
    cfg: cfg({ triggerMeasure: "pct" }),
    busy: false,
  });
  assert.equal(v.code, "stale-measure");
});

test("the current revision on a matching unit fires normally", () => {
  const v = evaluateTrigger({
    now: NOW,
    reading: -26.9,
    managed: position({ measure: "pct", measureRev: MEASURE_REV }),
    cfg: cfg({ triggerMeasure: "pct" }),
    busy: false,
  });
  assert.equal(v.fire, true, "the revision guard blocked a correctly stamped threshold");
});

test("the disarm names the old definition rather than just the unit", async () => {
  const { runner, store } = harness({
    conf: cfg({ triggerMeasure: "pct" }),
    triggers: { measure: "pct", measureRev: undefined },
  });
  await runner.run(NOW);

  const why = store.position("POS1").triggers.disarmedReason;
  assert.match(why, /before v1\.11\.4/, "an operator reading this must be able to tell the two percents apart");
  assert.match(why, /capital committed/, "and know which one is now in force");
  assert.doesNotMatch(why, /in pct but triggers now compare in pct/, "the message must not contradict itself");
});

test("the route stamps the current revision, not just the unit", async () => {
  const { f, store } = app();
  await f.inject({
    method: "POST",
    url: "/api/positions/POS1/triggers",
    payload: { on: true, stopLoss: -3, takeProfit: 10 },
  });

  assert.equal(store.position("POS1").triggers.measureRev, MEASURE_REV);
  await f.close();
});

// --------------------------------------------------------- the percentage itself

test("the percentage divides by capital committed, not by cumulative deposits", () => {
  // KIO's live figures. The indexer reported -2.599% against $922.22 of
  // cumulative deposits; against the $89.12 actually committed it is -26.9%.
  const pct = pnlPctOfBasis(-23.97, 922.22, 833.10);
  assert.ok(Math.abs(pct - -26.9) < 0.1, `expected about -26.9%, got ${pct}`);
});

test("rebalances cancel out of the denominator exactly", () => {
  // One rebalance withdraws the whole position and puts it back, adding the same
  // amount to both sides. The percentage must not move.
  const before = pnlPctOfBasis(-10, 100, 0);
  const after = pnlPctOfBasis(-10, 100 + 90, 0 + 90);
  assert.equal(after, before, "the measure decayed as the position churned -- the original bug");

  // And it must still hold after fourteen of them, which is where KIO was.
  let dep = 100;
  let wd = 0;
  for (let i = 0; i < 14; i++) {
    dep += 90;
    wd += 90;
  }
  assert.equal(pnlPctOfBasis(-10, dep, wd), before);
});

test("a position whose withdrawals have caught up with its deposits reads null", () => {
  // No capital at risk to express a return on, and the percentage would swing on
  // rounding. Null is "no reading", the one state that never fires.
  assert.equal(pnlPctOfBasis(-10, 100, 100), null);
  assert.equal(pnlPctOfBasis(-10, 100, 101), null, "a negative basis must not flip the sign of the reading");
  assert.equal(pnlPctOfBasis(-10, 100, 100 - MIN_PNL_BASIS_USD / 2), null, "a basis under the floor still reads null");
  assert.ok(pnlPctOfBasis(-10, 100, 100 - MIN_PNL_BASIS_USD) !== null, "exactly at the floor is usable");
});

test("a non-numeric field from the indexer reads null rather than NaN", () => {
  assert.equal(pnlPctOfBasis(NaN, 100, 0), null);
  assert.equal(pnlPctOfBasis(-10, Number("nope"), 0), null);
  assert.equal(pnlPctOfBasis(-10, 100, Number(undefined)), null);
});

test("the trigger reads the derived percentage, never the indexer's", async () => {
  // pnlPctChange is supplied and is comfortably inside the thresholds; the
  // derived figure is past the stop. Only the derived one may be acted on.
  const store = new Store(mkdtempSync(join(tmpdir(), "dlmm-derived-")));
  const p = position({ measure: "pct", measureRev: MEASURE_REV, stopLoss: -20, takeProfit: 50 });
  store.upsertPosition({ ...p, triggers: undefined });
  store.setTriggers("POS1", p.triggers);

  const closed = [];
  const runner = new TriggerRunner(
    {
      cfg: cfg({ triggerMeasure: "pct" }),
      store,
      log: { info() {}, debug() {}, warn() {}, error() {} },
      notifier: { notify() {} },
      client: { wallet: () => ({ publicKey: { toBase58: () => "WALLET" } }) },
      dataApi: {
        positionPnlSafe: async () => [
          {
            positionAddress: "POS1",
            pnlUsd: "-23.97",
            pnlPctChange: "-2.599",
            allTimeDeposits: { total: { usd: "922.22" } },
            allTimeWithdrawals: { total: { usd: "833.10" } },
          },
        ],
      },
    },
    {},
    () => false,
    { zapOut: async (_d, params) => closed.push(params), exit: async () => {} },
  );
  await runner.run(NOW);

  assert.equal(closed.length, 1, "the diluted pnlPctChange was used -- the stop did not fire at -26.9%");
});

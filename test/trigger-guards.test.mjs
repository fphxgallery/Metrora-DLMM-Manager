import test from "node:test";
import assert from "node:assert/strict";

import { evaluateTrigger, thresholdsFor } from "../dist/triggers.js";
import { INDEXER_SETTLE_MS } from "../dist/sampler.js";

// Everything standing between an indexer reading and a closed position. Firing is
// terminal — the position is gone and its bin-array rent is not recoverable — so
// each guard gets a test that fails if it is removed.
//
// The reading these defend against is real. On 2026-07-30 the Data API reported
// -$43.56 for about ten seconds on a position actually at +$1.32: it had indexed a
// path-B rebalance's withdraw leg and not yet its deposit.

const MIN = 60_000;
const NOW = 1_800_000_000_000;

function cfg(over = {}) {
  return {
    stopLoss: -15,
    takeProfit: 40,
    triggerOnFire: "zap-y",
    triggerConfirmations: 3,
    triggerCheckMin: 2,
    triggerMinAgeMin: 30,
    triggerMeasure: "pct",
    ...over,
  };
}

function position(over = {}) {
  return {
    positionPk: "POS1",
    poolAddress: "POOL1",
    pairName: "JitoSOL-ONyc",
    auto: true,
    // Opened long enough ago to clear the minimum age in every test but the one
    // that is about it.
    openedAt: NOW - 10 * 24 * 60 * MIN,
    rebalanceCount: 0,
    pollsTotal: 0,
    pollsInRange: 0,
    // `measure` matches the default cfg above. It is stamped when the thresholds
    // are set, and a mismatch disarms the position before any other guard runs —
    // so an unstamped fixture would make every test here pass for the wrong
    // reason. The mismatch itself is covered in trigger-measure-unit.test.mjs.
    triggers: { on: true, streak: 0, refusals: 0, measure: "pct", ...(over.triggers ?? {}) },
    ...over,
  };
}

/**
 * Replays a series of readings the way the runner does: evaluate, write the
 * streak back, advance the clock by one check interval. Returns every verdict.
 */
function feed(readings, { conf = cfg(), managed = position(), busy = false } = {}) {
  const out = [];
  let now = NOW;
  for (const reading of readings) {
    const v = evaluateTrigger({ now, reading, managed, cfg: conf, busy });
    out.push(v);
    managed.triggers = { ...managed.triggers, streak: v.streak, streakSide: v.side, lastCheckAt: now };
    if (v.fire) break;
    now += conf.triggerCheckMin * MIN;
  }
  return out;
}

test("the -$43 indexer blip does not close a healthy position", () => {
  // Two readings past the stop with a good one between them. At 3 confirmations
  // this must never fire, however many times the blip recurs.
  const verdicts = feed([-50, 1.3, -50, 2.1, -50, 1.9], {
    conf: cfg({ triggerMeasure: "usd", stopLoss: -20 }),
    // Spelled out rather than partial: `position()` spreads `over` last, so a
    // partial `triggers` replaces the defaults instead of merging with them.
    managed: position({ triggers: { on: true, streak: 0, refusals: 0, measure: "usd" } }),
  });

  assert.equal(
    verdicts.filter((v) => v.fire).length,
    0,
    "a stop loss fired on readings that were never consecutive",
  );
  // And the count genuinely resets rather than merely lagging.
  assert.deepEqual(
    verdicts.map((v) => v.streak),
    [1, 0, 1, 0, 1, 0],
  );
});

test("three consecutive readings past the stop do fire", () => {
  const verdicts = feed([-16, -17, -18]);
  assert.equal(verdicts.length, 3);
  assert.equal(verdicts[2].fire, true);
  assert.equal(verdicts[2].side, "stop");
  assert.equal(verdicts[2].threshold, -15);
  assert.equal(verdicts[2].action, "zap-y");
});

test("the take profit side fires on its own threshold", () => {
  const verdicts = feed([41, 45, 60]);
  assert.equal(verdicts[2].fire, true);
  assert.equal(verdicts[2].side, "target");
  assert.equal(verdicts[2].threshold, 40);
});

test("crossing the other threshold restarts the count", () => {
  // A wild pair that swings past both. Neither side ever gets three in a row.
  const verdicts = feed([-16, 41, -16, 41, -16]);
  assert.equal(verdicts.filter((v) => v.fire).length, 0);
  assert.deepEqual(
    verdicts.map((v) => v.streak),
    [1, 1, 1, 1, 1],
  );
});

test("nothing fires inside the settle window after a rebalance", () => {
  // The exact condition the blip happened under: a rebalance had just landed.
  const managed = position({ lastRebalanceAt: NOW - INDEXER_SETTLE_MS + 1_000 });
  const v = evaluateTrigger({ now: NOW, reading: -99, managed, cfg: cfg(), busy: false });

  assert.equal(v.fire, false);
  assert.equal(v.code, "settling");
});

test("a rebalance older than the settle window does not block a check", () => {
  const managed = position({ lastRebalanceAt: NOW - INDEXER_SETTLE_MS - 1 });
  const v = evaluateTrigger({ now: NOW, reading: -99, managed, cfg: cfg({ triggerConfirmations: 1 }) , busy: false });
  assert.equal(v.fire, true);
});

test("a position younger than the minimum age is never triggered", () => {
  const managed = position({ openedAt: NOW - 5 * MIN });
  const v = evaluateTrigger({ now: NOW, reading: -99, managed, cfg: cfg(), busy: false });

  assert.equal(v.fire, false);
  assert.equal(v.code, "too-new");
});

test("an unresolved rebalance blocks the check", () => {
  // Funds sitting in the wallet mid path-B make the position read as missing a
  // leg — which is exactly the shape of a reading that must not close anything.
  const v = evaluateTrigger({ now: NOW, reading: -99, managed: position(), cfg: cfg(), busy: true });

  assert.equal(v.fire, false);
  assert.equal(v.code, "busy");
});

test("triggers off for the position means nothing is evaluated", () => {
  const managed = position({ triggers: { on: false, streak: 0, refusals: 0 } });
  const v = evaluateTrigger({ now: NOW, reading: -99, managed, cfg: cfg(), busy: false });

  assert.equal(v.fire, false);
  assert.equal(v.code, "off");
});

test("armed with no thresholds anywhere does nothing", () => {
  const v = evaluateTrigger({
    now: NOW,
    reading: -99,
    managed: position(),
    cfg: cfg({ stopLoss: undefined, takeProfit: undefined }),
    busy: false,
  });

  assert.equal(v.fire, false);
  assert.equal(v.code, "no-thresholds");
});

test("the check interval is respected", () => {
  const managed = position({ triggers: { on: true, streak: 0, refusals: 0, measure: "pct", lastCheckAt: NOW - 30_000 } });
  const v = evaluateTrigger({ now: NOW, reading: -99, managed, cfg: cfg(), busy: false });

  assert.equal(v.fire, false);
  assert.equal(v.code, "not-due");
});

test("a missing reading is reported as needing one, and never as a cross", () => {
  // null is also how the runner asks "would you check this position at all",
  // so it has to survive every earlier guard and stop exactly here.
  const v = evaluateTrigger({ now: NOW, reading: null, managed: position(), cfg: cfg(), busy: false });

  assert.equal(v.fire, false);
  assert.equal(v.code, "needs-reading");
});

test("NaN is treated as no reading rather than as a number", () => {
  const v = evaluateTrigger({ now: NOW, reading: NaN, managed: position(), cfg: cfg(), busy: false });
  assert.equal(v.code, "needs-reading");
});

test("a disabled side cannot fire, however far the reading goes", () => {
  // Take profit only. A catastrophic loss must not close a position whose
  // operator deliberately set no stop.
  const v = evaluateTrigger({
    now: NOW,
    reading: -95,
    managed: position(),
    cfg: cfg({ stopLoss: undefined, triggerConfirmations: 1 }),
    busy: false,
  });

  assert.equal(v.fire, false);
  assert.equal(v.code, "within");
});

test("per-position thresholds win over the globals", () => {
  const managed = position({ triggers: { on: true, streak: 0, refusals: 0, measure: "pct", stopLoss: -5, onFire: "exit" } });
  const v = evaluateTrigger({ now: NOW, reading: -6, managed, cfg: cfg({ triggerConfirmations: 1 }), busy: false });

  assert.equal(v.fire, true);
  assert.equal(v.threshold, -5, "the global -15 was used instead of the position's -5");
  assert.equal(v.action, "exit");
});

test("thresholdsFor falls back per FIELD, not all-or-nothing", () => {
  const th = thresholdsFor(cfg(), { on: true, streak: 0, refusals: 0, stopLoss: -5 });
  assert.equal(th.stopLoss, -5);
  assert.equal(th.takeProfit, 40, "overriding the stop loss must not disable the global take profit");
  assert.equal(th.onFire, "zap-y");
});

test("exactly at the threshold counts as crossed", () => {
  const atStop = evaluateTrigger({
    now: NOW,
    reading: -15,
    managed: position(),
    cfg: cfg({ triggerConfirmations: 1 }),
    busy: false,
  });
  const atTarget = evaluateTrigger({
    now: NOW,
    reading: 40,
    managed: position(),
    cfg: cfg({ triggerConfirmations: 1 }),
    busy: false,
  });

  assert.equal(atStop.fire, true);
  assert.equal(atTarget.fire, true);
});

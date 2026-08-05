import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TriggerRunner, MAX_REFUSALS } from "../dist/triggers.js";
import { Store } from "../dist/state.js";

// What the runner does once a threshold has actually fired: whether it closes
// anything at all, through which path, and what happens when the close is refused.
//
// The real Store is used rather than a stub, because the merge behaviour of
// setTriggers is part of what is under test — a patch that replaced the whole
// object would drop the thresholds while appearing to work.

const MIN = 60_000;
const NOW = 1_800_000_000_000;

function cfg(over = {}) {
  return {
    stopLoss: -15,
    takeProfit: 40,
    triggerOnFire: "zap-y",
    triggerConfirmations: 2,
    triggerCheckMin: 2,
    triggerMinAgeMin: 30,
    triggerMeasure: "pct",
    triggersArmed: true,
    dryRun: false,
    ...over,
  };
}

/**
 * @param readings  what the indexer reports for POS1, one per run() call
 */
function harness({ conf = cfg(), readings = [], triggers = { on: true }, zapThrows = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dlmm-trigger-"));
  const store = new Store(dir);
  store.upsertPosition({
    positionPk: "POS1",
    poolAddress: "POOL1",
    pairName: "JitoSOL-ONyc",
    auto: true,
    openedAt: NOW - 10 * 24 * 60 * MIN,
    rebalanceCount: 0,
    pollsTotal: 0,
    pollsInRange: 0,
  });
  store.setTriggers("POS1", { streak: 0, refusals: 0, ...triggers });

  const sent = [];
  const alerts = [];
  let i = 0;

  const ctx = {
    cfg: conf,
    store,
    log: { info() {}, debug() {}, warn() {}, error() {} },
    notifier: { notify: (t) => alerts.push(t) },
    client: { wallet: () => ({ publicKey: { toBase58: () => "WALLET" } }) },
    dataApi: {
      positionPnlSafe: async () => {
        const value = readings[Math.min(i, readings.length - 1)];
        i += 1;
        return value === undefined || value === null
          ? []
          : [{ positionAddress: "POS1", pnlPctChange: String(value), pnlUsd: String(value) }];
      },
    },
  };

  const actions = {
    zapOut: async (_deps, params) => {
      if (zapThrows) throw new Error(zapThrows);
      sent.push({ kind: "zap", ...params });
      return {};
    },
    exit: async (_deps, params) => {
      if (zapThrows) throw new Error(zapThrows);
      sent.push({ kind: "exit", ...params });
      return {};
    },
  };

  const runner = new TriggerRunner(ctx, {}, () => false, actions);
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  return { runner, store, sent, alerts, cleanup, dir };
}

/** Runs enough ticks to satisfy the confirmation count, advancing past the interval. */
async function ticks(runner, n, conf = cfg()) {
  const out = [];
  for (let k = 0; k < n; k++) {
    out.push(await runner.run(NOW + k * (conf.triggerCheckMin * MIN + 1_000)));
  }
  return out;
}

test("an armed, confirmed stop loss closes the position through zap out", async () => {
  const h = harness({ readings: [-20, -21] });
  const fired = await ticks(h.runner, 2);

  assert.deepEqual(h.sent, [{ kind: "zap", positionPk: "POS1", poolAddress: "POOL1", to: "y" }]);
  assert.ok(fired[1].has("POS1"), "the fired set must name the position so the tick skips it");
  assert.equal(h.store.position("POS1"), undefined, "a closed position must stop being managed");
  assert.ok(h.alerts.some((a) => a.includes("FIRED")), `no alert sent — got ${JSON.stringify(h.alerts)}`);
  h.cleanup();
});

test("DRY-RUN evaluates and alerts but closes nothing", async () => {
  // Deliberately not simulated: a dry zap out cannot exercise the swap leg,
  // because the exit whose proceeds it would sell never happened.
  const h = harness({ conf: cfg({ dryRun: true }), readings: [-20, -21] });
  await ticks(h.runner, 2);

  assert.deepEqual(h.sent, [], "DRY-RUN must not close a position");
  assert.ok(h.store.position("POS1"), "the position must still be managed");
  assert.ok(h.alerts.some((a) => a.includes("WOULD fire")), "the operator should still hear about it");
  h.cleanup();
});

test("alert-only mode closes nothing, and pages once rather than every check", async () => {
  const h = harness({ conf: cfg({ triggersArmed: false }), readings: [-20, -21, -22, -23, -24] });
  await ticks(h.runner, 5);

  assert.deepEqual(h.sent, []);
  assert.equal(
    h.alerts.filter((a) => a.includes("WOULD fire")).length,
    1,
    `an unarmed position past its threshold paged repeatedly: ${JSON.stringify(h.alerts)}`,
  );
  h.cleanup();
});

test("a position with triggers off is never even read", async () => {
  const h = harness({ triggers: { on: false }, readings: [-99, -99] });
  await ticks(h.runner, 2);

  assert.deepEqual(h.sent, []);
  assert.equal(h.store.position("POS1").triggers.streak, 0);
  h.cleanup();
});

test("the on-fire override picks the exit path", async () => {
  const h = harness({ triggers: { on: true, onFire: "exit" }, readings: [-20, -21] });
  await ticks(h.runner, 2);

  assert.deepEqual(h.sent, [{ kind: "exit", positionPk: "POS1", poolAddress: "POOL1" }]);
  h.cleanup();
});

test("zapping to the X side is passed through", async () => {
  const h = harness({ triggers: { on: true, onFire: "zap-x" }, readings: [-20, -21] });
  await ticks(h.runner, 2);

  assert.equal(h.sent[0].to, "x");
  h.cleanup();
});

test("a refused close leaves the position open and retries", async () => {
  const h = harness({ readings: [-20, -21], zapThrows: "swap price impact 900bps exceeds MAX_SWAP_PRICE_IMPACT_BPS" });
  await ticks(h.runner, 2);

  const t = h.store.position("POS1").triggers;
  assert.ok(h.store.position("POS1"), "a refused close must not unmanage the position");
  assert.equal(t.on, true, "one refusal must not disarm");
  assert.equal(t.refusals, 1);
  assert.ok(h.alerts.some((a) => a.includes("could not close")));
  h.cleanup();
});

test("repeated refusals disarm rather than retrying forever", async () => {
  const h = harness({ readings: [-20, -21, -22, -23, -24, -25, -26, -27], zapThrows: "no route found" });
  // Two ticks to confirm, then one per refusal after the first.
  await ticks(h.runner, MAX_REFUSALS + 2);

  const t = h.store.position("POS1").triggers;
  assert.equal(t.refusals, MAX_REFUSALS);
  assert.equal(t.on, false, `still armed after ${MAX_REFUSALS} refusals — it would alert forever`);
  assert.match(t.disarmedReason, /no route found/);
  assert.ok(
    h.alerts.some((a) => a.includes("DISARMED") && a.includes("no longer protected")),
    "disarming must be loud — the position is now unprotected",
  );
  h.cleanup();
});

test("a pool the indexer has nothing for does not fire or crash", async () => {
  const h = harness({ readings: [null, null, null] });
  await ticks(h.runner, 3);

  assert.deepEqual(h.sent, []);
  assert.ok(h.store.position("POS1"));
  h.cleanup();
});

test("the check interval is enforced across ticks, not just within one", async () => {
  // Engine ticks every 30s; a 2-minute check interval must swallow most of them.
  const h = harness({ readings: [-20, -21, -22, -23] });
  for (let k = 0; k < 4; k++) await h.runner.run(NOW + k * 30_000);

  assert.deepEqual(h.sent, [], "four 30-second ticks reached two confirmations at a 2-minute interval");
  assert.equal(h.store.position("POS1").triggers.streak, 1);
  h.cleanup();
});

test("the streak survives a restart", async () => {
  // The box is redeployed often. A streak reset by every restart would mean a
  // stop loss that never reaches its final confirmation.
  const h = harness({ readings: [-20] });
  await h.runner.run(NOW);

  // A second Store over the same directory is what a restart looks like.
  const reloaded = new Store(h.dir);
  assert.equal(reloaded.position("POS1").triggers.streak, 1, "the streak must be on disk, not only in memory");
  assert.equal(reloaded.position("POS1").triggers.streakSide, "stop");
  h.cleanup();
});

import test from "node:test";
import assert from "node:assert/strict";

import { Sampler } from "../dist/sampler.js";

// pnlUsd is taken verbatim from the Data API, which is eventually consistent.
// Measured live 2026-07-30: a path-B rebalance completed at 18:12:24 having
// moved 45.22 USDC out of the position and back; the sample ten seconds later
// read -$43.56 against +$1.32 before and +$1.72 after -- a swing of $44.88,
// which is the withdrawn leg. The indexer had seen the withdraw and not the
// deposit. A sample taken in that window is not a reading, it is noise.

const INTERVAL = 900_000; // 15 minutes
const NOW = 1_800_000_000_000;

function build({ lastRebalanceAt, lastSampleTs = NOW - INTERVAL - 1 }) {
  const calls = { pnlReads: 0, appended: [] };
  const deps = {
    store: {
      positions: () => [{ positionPk: "pos1", poolAddress: "pool1", lastRebalanceAt }],
      position: () => ({ positionPk: "pos1", lastRebalanceAt }),
    },
    dataApi: {
      positionPnlSafe: async () => {
        calls.pnlReads += 1;
        return [{ positionAddress: "pos1", pnlUsd: "1.32", allTimeFees: { total: { usd: "1.22" } } }];
      },
    },
    client: { wallet: () => ({ publicKey: { toBase58: () => "wallet" } }) },
    samples: {
      read: () => (lastSampleTs ? [{ ts: lastSampleTs }] : []),
      append: (rows) => calls.appended.push(...rows),
    },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    intervalMs: INTERVAL,
  };
  return { sampler: new Sampler(deps), calls };
}

test("skips the pass when a rebalance landed seconds ago", async () => {
  const { sampler, calls } = build({ lastRebalanceAt: NOW - 10_000 });
  await sampler.maybeSample(NOW);
  assert.equal(calls.pnlReads, 0, "must not even ask the indexer");
  assert.deepEqual(calls.appended, []);
});

test("still skips near the end of the settle window", async () => {
  const { sampler, calls } = build({ lastRebalanceAt: NOW - 119_000 });
  await sampler.maybeSample(NOW);
  assert.equal(calls.pnlReads, 0);
});

test("samples once the position has settled", async () => {
  const { sampler, calls } = build({ lastRebalanceAt: NOW - 121_000 });
  await sampler.maybeSample(NOW);
  assert.equal(calls.pnlReads, 1);
  assert.equal(calls.appended.length, 1);
  assert.equal(calls.appended[0].pnlUsd, 1.32);
});

test("a position that has never rebalanced is never held back", async () => {
  const { sampler, calls } = build({ lastRebalanceAt: undefined });
  await sampler.maybeSample(NOW);
  assert.equal(calls.pnlReads, 1);
});

test("a skipped pass does not advance the clock, so the next tick retries", async () => {
  const { sampler, calls } = build({ lastRebalanceAt: NOW - 10_000 });
  await sampler.maybeSample(NOW);
  assert.equal(calls.pnlReads, 0);

  // 30s later the rebalance is still settling: still skipped.
  await sampler.maybeSample(NOW + 30_000);
  assert.equal(calls.pnlReads, 0);

  // Past the window, and the interval has NOT been reset by the skips, so this
  // tick samples rather than waiting another 15 minutes for a fresh slot.
  await sampler.maybeSample(NOW + 130_000);
  assert.equal(calls.pnlReads, 1, "the skipped interval must not be forfeited");
});

test("the settle guard does not override the sample interval", async () => {
  // Settled, but only a minute since the last sample.
  const { sampler, calls } = build({ lastRebalanceAt: NOW - 600_000, lastSampleTs: NOW - 60_000 });
  await sampler.maybeSample(NOW);
  assert.equal(calls.pnlReads, 0, "cadence still governs when nothing is settling");
});

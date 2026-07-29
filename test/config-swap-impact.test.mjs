import test from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../dist/config.js";

// MAX_SWAP_PRICE_IMPACT_BPS aborts the swap leg on a bad route, which is a
// different thing from SWAP_SLIPPAGE_BPS (movement tolerated on a route already
// accepted). A misparsed or unvalidated value here silently disables the guard.
const withEnv = (v, fn) => {
  const prev = process.env.MAX_SWAP_PRICE_IMPACT_BPS;
  if (v === undefined) delete process.env.MAX_SWAP_PRICE_IMPACT_BPS;
  else process.env.MAX_SWAP_PRICE_IMPACT_BPS = v;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.MAX_SWAP_PRICE_IMPACT_BPS;
    else process.env.MAX_SWAP_PRICE_IMPACT_BPS = prev;
  }
};

test("defaults to 200bps, matching Meteora's own swap price-impact default", () => {
  withEnv(undefined, () => assert.equal(loadConfig().maxSwapPriceImpactBps, 200));
});

test("reads an explicit value", () => {
  withEnv("50", () => assert.equal(loadConfig().maxSwapPriceImpactBps, 50));
});

test("rejects values that would disable or nonsense the guard", () => {
  // 0 would abort every swap; >10000 is not a meaningful bps ceiling.
  withEnv("0", () => assert.throws(loadConfig, /MAX_SWAP_PRICE_IMPACT_BPS/));
  withEnv("-1", () => assert.throws(loadConfig, /MAX_SWAP_PRICE_IMPACT_BPS/));
  withEnv("10001", () => assert.throws(loadConfig, /MAX_SWAP_PRICE_IMPACT_BPS/));
  withEnv("abc", () => assert.throws(loadConfig, /must be a number/));
});

// ---------------------------------------------------- swap priority ceiling ----
//
// Jupiter builds and signs the swap, so PRIORITY_FEE_MICROLAMPORTS does not reach
// it. This is the only control over that leg's fee, and it previously came from
// `priorityFeeMicroLamports * 1000` -- a per-CU price scaled by an arbitrary
// factor, which yielded a 0.2 SOL ceiling on a single swap.
const withLamports = (v, fn) => {
  const prev = process.env.MAX_SWAP_PRIORITY_LAMPORTS;
  if (v === undefined) delete process.env.MAX_SWAP_PRIORITY_LAMPORTS;
  else process.env.MAX_SWAP_PRIORITY_LAMPORTS = v;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.MAX_SWAP_PRIORITY_LAMPORTS;
    else process.env.MAX_SWAP_PRIORITY_LAMPORTS = prev;
  }
};

test("defaults to 200000 lamports, and no longer derives from the per-CU price", () => {
  withLamports(undefined, () => {
    const cfg = loadConfig();
    assert.equal(cfg.maxSwapPriorityLamports, 200_000);
    // The old derivation would have produced this instead.
    assert.notEqual(cfg.maxSwapPriorityLamports, cfg.priorityFeeMicroLamports * 1000);
  });
});

test("rejects a ceiling that would defeat its own purpose", () => {
  withLamports("0", () => assert.throws(loadConfig, /positive integer/));
  withLamports("-1", () => assert.throws(loadConfig, /positive integer/));
  withLamports("1.5", () => assert.throws(loadConfig, /positive integer/));
  // 0.2 SOL -- what the old derivation produced at the old fee setting.
  withLamports("200000000", () => assert.throws(loadConfig, /0\.1 SOL/));
});

test("accepts a deliberately raised ceiling up to the cap", () => {
  withLamports("100000000", () => assert.equal(loadConfig().maxSwapPriorityLamports, 100_000_000));
});

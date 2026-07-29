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

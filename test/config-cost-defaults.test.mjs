import test from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../dist/config.js";

// Two shipped defaults were measured wrong on live funds. A fresh clone got the
// broken values even after the running box had been corrected by hand, so these
// pin the corrections. dotenv runs once at import, which is why deleting a key
// here stays deleted across loadConfig() calls.
const withoutEnv = (keys, fn) => {
  const prev = keys.map((k) => [k, process.env[k]]);
  for (const k of keys) delete process.env[k];
  try {
    return fn();
  } finally {
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

test("SWAP_SLIPPAGE_BPS defaults to 50, not 0", () => {
  // 0 delegates to Jupiter's dynamic slippage, whose maxBps is a ceiling and not
  // a floor: it chose 15bps on SOL/USDC and about one swap in five died on error
  // 6001 while quoted price impact was 0-1bps. 50 is Meteora's own swap default.
  withoutEnv(["SWAP_SLIPPAGE_BPS"], () => {
    assert.equal(loadConfig().swapSlippageBps, 50);
  });
});

test("SWAP_SLIPPAGE_BPS=0 is still accepted when asked for explicitly", () => {
  // Opting into dynamic slippage is a legitimate choice on a volatile pair; the
  // fix is to the default, not to the range.
  process.env.SWAP_SLIPPAGE_BPS = "0";
  try {
    assert.equal(loadConfig().swapSlippageBps, 0);
  } finally {
    delete process.env.SWAP_SLIPPAGE_BPS;
  }
});

test("PRIORITY_FEE_MICROLAMPORTS defaults to 50000, not 200000", () => {
  // Sampled via getRecentPrioritizationFees: 141 of 150 recent blocks paid ZERO.
  // Safe this low only because sends rebroadcast until the blockhash expires.
  withoutEnv(["PRIORITY_FEE_MICROLAMPORTS"], () => {
    assert.equal(loadConfig().priorityFeeMicroLamports, 50_000);
  });
});

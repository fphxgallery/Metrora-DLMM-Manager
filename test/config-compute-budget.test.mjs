import test from "node:test";
import assert from "node:assert/strict";

import { loadConfig, MAX_COMPUTE_UNIT_LIMIT, MAX_PRIORITY_LAMPORTS_PER_TX } from "../dist/config.js";

// COMPUTE_UNIT_LIMIT and PRIORITY_FEE_MICROLAMPORTS are both editable from the
// SETTINGS tab, and the trial loadConfig() in applyConfigUpdates is the only gate
// before the value is persisted to .env. Neither key had a rule, so a negative
// limit threw inside ComputeBudgetProgram on every signing path (rebalance, open,
// claim, exit, close-accounts) while the app still booted and reported healthy.
// dotenv runs once at import, which is why env writes here must be restored.
const withEnv = (vars, fn) => {
  const prev = Object.keys(vars).map((k) => [k, process.env[k]]);
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = String(v);
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

test("COMPUTE_UNIT_LIMIT=-5 is rejected", () => {
  // ComputeBudgetProgram.setComputeUnitLimit({units:-5}) throws "out of range"
  // inside TxSender.budgetIxs, killing every transaction the app builds.
  withEnv({ COMPUTE_UNIT_LIMIT: -5 }, () => {
    assert.throws(loadConfig, /COMPUTE_UNIT_LIMIT must be an integer >= 1/);
  });
});

test("COMPUTE_UNIT_LIMIT=0 is rejected", () => {
  withEnv({ COMPUTE_UNIT_LIMIT: 0 }, () => {
    assert.throws(loadConfig, /COMPUTE_UNIT_LIMIT must be an integer >= 1/);
  });
});

test("COMPUTE_UNIT_LIMIT with a fractional value is rejected", () => {
  withEnv({ COMPUTE_UNIT_LIMIT: 600_000.5 }, () => {
    assert.throws(loadConfig, /COMPUTE_UNIT_LIMIT must be an integer >= 1/);
  });
});

test("COMPUTE_UNIT_LIMIT=99000000 is rejected as above the runtime ceiling", () => {
  // Encodes fine, but exceeds Solana's per-transaction maximum so every tx dies
  // at simulation; it also inflates perTxLamports enough that the rebalance cost
  // guard silently refuses every rebalance.
  withEnv({ COMPUTE_UNIT_LIMIT: 99_000_000, PRIORITY_FEE_MICROLAMPORTS: 0 }, () => {
    assert.throws(loadConfig, /COMPUTE_UNIT_LIMIT must be <= 1400000/);
  });
});

test("COMPUTE_UNIT_LIMIT exactly at the runtime ceiling is accepted", () => {
  assert.equal(MAX_COMPUTE_UNIT_LIMIT, 1_400_000);
  withEnv({ COMPUTE_UNIT_LIMIT: MAX_COMPUTE_UNIT_LIMIT, PRIORITY_FEE_MICROLAMPORTS: 50_000 }, () => {
    assert.equal(loadConfig().computeUnitLimit, 1_400_000);
  });
});

test("COMPUTE_UNIT_LIMIT one above the runtime ceiling is rejected", () => {
  withEnv({ COMPUTE_UNIT_LIMIT: MAX_COMPUTE_UNIT_LIMIT + 1, PRIORITY_FEE_MICROLAMPORTS: 0 }, () => {
    assert.throws(loadConfig, /COMPUTE_UNIT_LIMIT must be <= 1400000/);
  });
});

test("PRIORITY_FEE_MICROLAMPORTS=-1 is rejected", () => {
  // u64 encoding of a negative throws in TxSender.budgetIxs, same blast radius.
  withEnv({ PRIORITY_FEE_MICROLAMPORTS: -1 }, () => {
    assert.throws(loadConfig, /PRIORITY_FEE_MICROLAMPORTS must be a non-negative integer/);
  });
});

test("PRIORITY_FEE_MICROLAMPORTS with a fractional value is rejected", () => {
  withEnv({ PRIORITY_FEE_MICROLAMPORTS: 50_000.5 }, () => {
    assert.throws(loadConfig, /PRIORITY_FEE_MICROLAMPORTS must be a non-negative integer/);
  });
});

test("PRIORITY_FEE_MICROLAMPORTS=0 is accepted", () => {
  // Paying nothing is legitimate — most recent blocks price at zero.
  withEnv({ PRIORITY_FEE_MICROLAMPORTS: 0, COMPUTE_UNIT_LIMIT: 600_000 }, () => {
    assert.equal(loadConfig().priorityFeeMicroLamports, 0);
  });
});

test("PRIORITY_FEE_MICROLAMPORTS=1000000000 is rejected by the derived product guard", () => {
  // 1e9 microlamports/CU at the default 600k CU limit is 6e8 lamports = 0.6 SOL
  // of priority fee on EVERY transaction. Each input is individually plausible;
  // only the product exposes it.
  withEnv({ PRIORITY_FEE_MICROLAMPORTS: 1_000_000_000, COMPUTE_UNIT_LIMIT: 600_000 }, () => {
    assert.throws(loadConfig, /is 600000000 lamports of priority fee/);
  });
});

test("the product guard's message names the computed lamports and both inputs", () => {
  withEnv({ PRIORITY_FEE_MICROLAMPORTS: 1_000_000_000, COMPUTE_UNIT_LIMIT: 600_000 }, () => {
    assert.throws(loadConfig, (err) => {
      assert.match(err.message, /PRIORITY_FEE_MICROLAMPORTS \(1000000000\)/);
      assert.match(err.message, /COMPUTE_UNIT_LIMIT \(600000\)/);
      assert.match(err.message, /600000000 lamports/);
      assert.match(err.message, /ONE transaction's priority fee, not a budget/);
      return true;
    });
  });
});

test("a product exactly at the ceiling is accepted", () => {
  // 10,000,000 microlamports/CU x 1,000,000 CU / 1e6 = 10,000,000 lamports.
  assert.equal(MAX_PRIORITY_LAMPORTS_PER_TX, 10_000_000);
  withEnv({ PRIORITY_FEE_MICROLAMPORTS: 10_000_000, COMPUTE_UNIT_LIMIT: 1_000_000 }, () => {
    const cfg = loadConfig();
    assert.equal((cfg.priorityFeeMicroLamports * cfg.computeUnitLimit) / 1e6, MAX_PRIORITY_LAMPORTS_PER_TX);
  });
});

test("a product one lamport above the ceiling is rejected", () => {
  withEnv({ PRIORITY_FEE_MICROLAMPORTS: 10_000_001, COMPUTE_UNIT_LIMIT: 1_000_000 }, () => {
    assert.throws(loadConfig, /10000001 lamports of priority fee/);
  });
});

test("the values running on the live box are accepted", () => {
  // The live box runs 50000 with the default 600000 CU limit: 30,000 lamports per
  // transaction. If this rule rejected these, the next boot or reload would fail.
  withEnv({ PRIORITY_FEE_MICROLAMPORTS: 50_000, COMPUTE_UNIT_LIMIT: 600_000 }, () => {
    const cfg = loadConfig();
    assert.equal(cfg.priorityFeeMicroLamports, 50_000);
    assert.equal(cfg.computeUnitLimit, 600_000);
    assert.equal((cfg.priorityFeeMicroLamports * cfg.computeUnitLimit) / 1e6, 30_000);
  });
});

test("the repo .env values are accepted", () => {
  // 200000 x 600000 / 1e6 = 120,000 lamports.
  withEnv({ PRIORITY_FEE_MICROLAMPORTS: 200_000, COMPUTE_UNIT_LIMIT: 600_000 }, () => {
    const cfg = loadConfig();
    assert.equal((cfg.priorityFeeMicroLamports * cfg.computeUnitLimit) / 1e6, 120_000);
  });
});

test("the shipped defaults are accepted", () => {
  withEnv({ PRIORITY_FEE_MICROLAMPORTS: undefined, COMPUTE_UNIT_LIMIT: undefined }, () => {
    const cfg = loadConfig();
    assert.equal(cfg.priorityFeeMicroLamports, 50_000);
    assert.equal(cfg.computeUnitLimit, 600_000);
    assert.equal((cfg.priorityFeeMicroLamports * cfg.computeUnitLimit) / 1e6, 30_000);
  });
});

import test from "node:test";
import assert from "node:assert/strict";

import { planTopUp } from "../dist/meteora/rebalance.js";
import { loadConfig } from "../dist/config.js";

// The rebalance instruction settles rounding shortfalls out of the wallet's quote
// ATA. Observed live on a Curve position: an empty USDC ATA turned a few cents of
// shortfall into "insufficient funds" (0x1) at simulation, failing the whole
// rebalance before its first transaction was sent. This keeps a dollar there.

const base = {
  balanceUsd: 0,
  floorUsd: 1,
  maxTopUpUsd: 5,
  solPriceUsd: 74,
  solBalance: 0.47,
  minSolBalance: 0.05,
};

test("an empty buffer is refilled to twice the floor", () => {
  // Twice, not exactly the floor: a rebalance that eats a few cents would
  // otherwise trigger another top-up on the very next tick.
  const p = planTopUp(base);
  assert.equal(p.wantUsd, 2);
  assert.ok(Math.abs(p.wantSol - 2 / 74) < 1e-12);
});

test("a partly drained buffer tops up only the difference", () => {
  const p = planTopUp({ ...base, balanceUsd: 0.6 });
  assert.ok(Math.abs(p.wantUsd - 1.4) < 1e-12, `got ${p.wantUsd}`);
});

test("a buffer above the floor is left alone", () => {
  assert.deepEqual(planTopUp({ ...base, balanceUsd: 1 }), { skip: "buffer is already above the floor" });
  assert.deepEqual(planTopUp({ ...base, balanceUsd: 15.07 }), { skip: "buffer is already above the floor" });
});

test("MIN_SOL_BALANCE is never spent", () => {
  // The reserve is what keeps fees and rent payable. Topping the quote buffer out
  // of it would trade one empty balance for another.
  const p = planTopUp({ ...base, solBalance: 0.05 });
  assert.deepEqual(p, { skip: "SOL above MIN_SOL_BALANCE is insufficient to top it up" });
});

test("a wallet below the reserve cannot top up at all", () => {
  assert.ok("skip" in planTopUp({ ...base, solBalance: 0.01 }));
});

test("a top-up larger than the spendable surplus is refused, not truncated", () => {
  // Half-filling the buffer would leave it below the floor anyway, and would still
  // have paid a swap fee for the privilege.
  const p = planTopUp({ ...base, solBalance: 0.06, solPriceUsd: 74 }); // 0.01 SOL ≈ $0.74 spendable
  assert.deepEqual(p, { skip: "SOL above MIN_SOL_BALANCE is insufficient to top it up" });
});

test("MAX_TOPUP_USD caps the spend", () => {
  // A mispriced quote or a bad balance read must not be able to drain the wallet.
  const p = planTopUp({ ...base, floorUsd: 100, maxTopUpUsd: 5, solBalance: 10 });
  assert.equal(p.wantUsd, 5);
});

test("an unavailable SOL price skips rather than dividing by zero", () => {
  assert.deepEqual(planTopUp({ ...base, solPriceUsd: 0 }), { skip: "SOL price unavailable" });
  assert.deepEqual(planTopUp({ ...base, solPriceUsd: Number.NaN }), { skip: "SOL price unavailable" });
});

// ---- config ---------------------------------------------------------------

const withEnv = (vars, fn) => {
  const prev = Object.entries(vars).map(([k]) => [k, process.env[k]]);
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
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

test("the floor defaults to $1 and auto top-up defaults ON", () => {
  withEnv({ MIN_QUOTE_BALANCE_USD: undefined, AUTO_TOPUP: undefined, MAX_TOPUP_USD: undefined }, () => {
    const cfg = loadConfig();
    assert.equal(cfg.minQuoteBalanceUsd, 1);
    assert.equal(cfg.autoTopUp, true);
    assert.equal(cfg.maxTopUpUsd, 5);
  });
});

test("the floor can be disabled entirely with 0", () => {
  withEnv({ MIN_QUOTE_BALANCE_USD: "0" }, () => assert.equal(loadConfig().minQuoteBalanceUsd, 0));
});

test("a ceiling below the floor is rejected", () => {
  // It would forbid the very top-up the floor asks for, so every rebalance would
  // log a warning it could never act on.
  withEnv({ MIN_QUOTE_BALANCE_USD: "10", MAX_TOPUP_USD: "5" }, () =>
    assert.throws(loadConfig, /MAX_TOPUP_USD/),
  );
});

test("nonsense values are rejected rather than silently disabling the guard", () => {
  withEnv({ MIN_QUOTE_BALANCE_USD: "-1" }, () => assert.throws(loadConfig, /MIN_QUOTE_BALANCE_USD/));
  withEnv({ MAX_TOPUP_USD: "0" }, () => assert.throws(loadConfig, /MAX_TOPUP_USD/));
});

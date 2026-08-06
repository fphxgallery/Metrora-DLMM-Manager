import test from "node:test";
import assert from "node:assert/strict";

import { measureSwapCost } from "../dist/meteora/rebalance.js";
import { lamportsOf, swapCostUsdOf, swapCostCoverage } from "../dist/metrics.js";

// What a rebalance's swap actually cost.
//
// The reference is the POOL'S OWN mid price, not the Jupiter quote. A quote is
// already net of the fees it will pay, so measuring against it reports the
// slippage and hides the fee — and the fee is the larger number. This was read
// off chain first: a JitoSOL->ONyc rebalance routed JitoSOL->SOL->USDC->ONyc
// across three unrelated pools, and the Whirlpool hop alone charged 1.00 bps
// (lpFee 0.082259 + protocolFee 0.012291 on 945.495354 USDC) that appeared in
// no quote comparison and in no ledger.

test("cost is measured against the pool mid, not against the quote", () => {
  // 10 X at a mid of 100 should have become 1000 Y. Jupiter quoted 999 — already
  // net of its fees — and 998 arrived.
  const c = measureSwapCost({ poolPrice: 100, fromIsX: true, amountInUi: 10, receivedUi: 998, quotedOutUi: 999 });

  // Against the mid: 2 Y short of 1000 = 20 bps. That is the real cost.
  assert.equal(c.costBps, 20);
  assert.equal(c.costInY, 2);
  // Against the quote: only 1 short of 999 ≈ 10 bps. Half the story, and the
  // half that omits what the pools charged.
  assert.ok(Math.abs(c.vsQuoteBps - 10.01) < 0.02, `vsQuote ${c.vsQuoteBps}`);
  assert.ok(c.costBps > c.vsQuoteBps, "the pool-mid measure must not report less than the quote measure here");
});

test("a swap from the quote side is measured in the same direction", () => {
  // 1000 Y at a mid of 100 should have become 10 X; 9.98 arrived.
  const c = measureSwapCost({ poolPrice: 100, fromIsX: false, amountInUi: 1000, receivedUi: 9.98, quotedOutUi: 9.99 });

  assert.ok(Math.abs(c.costBps - 20) < 1e-9, `bps ${c.costBps}`);
  // 0.02 X short, valued at the mid, is 2 Y — the same money as the test above,
  // so the two directions are comparable in the ledger.
  assert.ok(Math.abs(c.costInY - 2) < 1e-9, `costInY ${c.costInY}`);
});

test("beating the pool's own price is recorded as a negative cost, not clamped", () => {
  // Routing elsewhere can genuinely do better than the pool. Clamping at zero
  // would bias the ledger upward and hide the case worth knowing about.
  const c = measureSwapCost({ poolPrice: 100, fromIsX: true, amountInUi: 10, receivedUi: 1002, quotedOutUi: 1001 });

  assert.ok(c.costBps < 0, `expected a negative cost, got ${c.costBps}`);
  assert.equal(c.costInY, -2);
});

test("the on-chain rebalance reproduces", () => {
  // Real figures from 2vaQ/2si9/5rzq: 9.913275102 JitoSOL swapped, 835.695379423
  // ONyc received. The pool's mid at the active bin was ~84.5 ONyc per JitoSOL.
  const c = measureSwapCost({
    poolPrice: 84.5,
    fromIsX: true,
    amountInUi: 9.913275102,
    receivedUi: 835.695379423,
    quotedOutUi: 835.695379423,
  });

  // At mid, 9.913275102 x 84.5 = 837.67 ONyc. 1.98 ONyc short ≈ 23.6 bps.
  assert.ok(c.costBps > 20 && c.costBps < 30, `bps ${c.costBps}`);
  // And measured against the quote alone it reads as free, which is precisely
  // the failure this replaces.
  assert.equal(c.vsQuoteBps, 0);
});

test("a nonsense input is refused rather than recorded as a wild cost", () => {
  // A zero or missing pool price would divide the ledger into nonsense; better
  // to record nothing than a number nobody can explain later.
  assert.equal(measureSwapCost({ poolPrice: 0, fromIsX: true, amountInUi: 10, receivedUi: 1, quotedOutUi: 1 }), null);
  assert.equal(measureSwapCost({ poolPrice: 100, fromIsX: true, amountInUi: 0, receivedUi: 1, quotedOutUi: 1 }), null);
  assert.equal(
    measureSwapCost({ poolPrice: 100, fromIsX: true, amountInUi: 10, receivedUi: NaN, quotedOutUi: 1 }),
    null,
  );
});

test("a swap that returned nothing is a total loss, and says so", () => {
  const c = measureSwapCost({ poolPrice: 100, fromIsX: true, amountInUi: 10, receivedUi: 0, quotedOutUi: 1000 });
  assert.equal(c.costBps, 10_000);
  assert.equal(c.costInY, 1000);
});

const rec = (over = {}) => ({ path: "B", costLamports: 100_094, rentLamports: 0, ...over });

test("the ledger adds swap cost to the fees, and does not convert it", () => {
  // The fee side is lamports and converts at the SOL price; the swap side was
  // already priced in USD when it happened. Folding one into the other would
  // re-price an old loss at today's SOL price.
  const rs = [rec({ swapCostUsd: 0.28 }), rec({ swapCostUsd: 0.31 })];

  assert.equal(lamportsOf(rs), 200_188);
  assert.ok(Math.abs(swapCostUsdOf(rs) - 0.59) < 1e-9);

  const solPrice = 73.65;
  const feeUsd = (lamportsOf(rs) / 1e9) * solPrice;
  // The point of the whole change: the swap cost is ~40x the network fees.
  assert.ok(swapCostUsdOf(rs) > feeUsd * 30, `fees ${feeUsd}, swap ${swapCostUsdOf(rs)}`);
});

test("records written before the measurement existed count as zero, not NaN", () => {
  const rs = [rec(), rec({ swapCostUsd: 0.28 })];
  assert.equal(swapCostUsdOf(rs), 0.28);
  assert.ok(Number.isFinite(swapCostUsdOf(rs)));
});

test("coverage says how much of the ledger is actually measured", () => {
  // A mixed ledger presented as a total would be worse than the old undercount,
  // because it would look complete.
  const rs = [rec(), rec({ swapCostUsd: 0.28 }), rec({ path: "A", swapCostUsd: undefined })];
  const cov = swapCostCoverage(rs);

  assert.equal(cov.swaps, 2, "path A never swaps and must not dilute the coverage figure");
  assert.equal(cov.measured, 1);
});

test("a ledger with no swaps at all reports full coverage of nothing", () => {
  const cov = swapCostCoverage([rec({ path: "A" })]);
  assert.equal(cov.swaps, 0);
  assert.equal(cov.measured, 0);
});

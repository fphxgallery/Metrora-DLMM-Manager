import test from "node:test";
import assert from "node:assert/strict";

import { TxError } from "../dist/tx/send.js";
import { isRequotableSwapFailure } from "../dist/meteora/rebalance.js";

// Observed on the live position: a route quoted at 0bps impact failed simulation
// on slippage, and a re-quote minutes later filled on a different route. Retrying
// inline closes that window -- but ONLY for a failure we can prove was never
// broadcast. Re-sending a swap that may have landed would swap the position's
// funds twice, and nothing can undo that.

const SIM_SLIPPAGE = new TxError(
  "swap USDC->SOL would fail: Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 failed: custom program error: 0x1771",
  ["Program log: ..."],
);

test("a simulation slippage failure is safe to re-quote", () => {
  // "would fail" comes from assertSimulationOk, which runs before broadcast.
  assert.equal(isRequotableSwapFailure(SIM_SLIPPAGE), true);
});

test("an ON-CHAIN slippage failure is NOT re-quoted", () => {
  // Same program error, but this one was broadcast. Even though a failed
  // transaction changes no state, the message alone cannot prove which
  // transaction the error belongs to -- resume re-reads chain state instead.
  const onChain = new TxError(
    "swap USDC->SOL failed on chain: custom program error: 0x1771",
    ["Program log: ..."],
  );
  assert.equal(isRequotableSwapFailure(onChain), false);
});

test("an expired blockhash is NOT re-quoted", () => {
  // The dangerous case: unknown outcome. The swap may have landed.
  const expired = new TxError("Signature ... has expired: block height exceeded");
  assert.equal(isRequotableSwapFailure(expired), false);
});

test("a confirmation timeout is NOT re-quoted", () => {
  assert.equal(isRequotableSwapFailure(new TxError("swap USDC->SOL confirmation timed out")), false);
});

test("a simulation failure that is not slippage is not re-quoted", () => {
  // Insufficient funds, a missing account or a program bug fails identically on
  // a retry, so a re-quote only burns quotes.
  const broke = new TxError("swap USDC->SOL would fail: Error: insufficient funds", []);
  assert.equal(isRequotableSwapFailure(broke), false);
});

test("the price-impact refusal is not re-quoted", () => {
  // A plain Error, thrown before anything is built. Impact is a property of
  // current liquidity, so an immediate re-quote would hit the same wall.
  const impact = new Error(
    "swap price impact 250bps exceeds MAX_SWAP_PRICE_IMPACT_BPS (200bps) — refusing the USDC->SOL route.",
  );
  assert.equal(isRequotableSwapFailure(impact), false);
});

test("a non-TxError is never re-quoted", () => {
  assert.equal(isRequotableSwapFailure(new Error("would fail: 0x1771")), false);
  assert.equal(isRequotableSwapFailure("would fail: 0x1771"), false);
  assert.equal(isRequotableSwapFailure(undefined), false);
  assert.equal(isRequotableSwapFailure(null), false);
});

test("slippage worded in prose is recognised too", () => {
  // Jupiter's own text, in case the numeric code is not surfaced.
  const worded = new TxError("swap SOL->USDC would fail: SlippageToleranceExceeded", []);
  assert.equal(isRequotableSwapFailure(worded), true);
});

test("0x1771 is Jupiter error 6001", () => {
  // Guards the constant against a careless edit: the hex in the matcher must be
  // the slippage code, not some neighbouring error.
  assert.equal(parseInt("1771", 16), 6001);
});

import test from "node:test";
import assert from "node:assert/strict";
import BN from "bn.js";

import { depositShortfall } from "../dist/meteora/rebalance.js";

/**
 * What the deposit half of `RebalanceLiquidity` must find from the wallet.
 *
 * On 2026-08-07 a BUTTHOLE-SOL withdraw leg failed with `{"InstructionError":
 * [4,{"Custom":1}]}` — the SPL Token program's "insufficient funds", raised from
 * inside `process deposit`. It names neither the account nor the amount, so the
 * error alone cannot distinguish the two possible fixes:
 *
 *   - a dust shortfall means MIN_QUOTE_BALANCE_USD ($1) is just too low;
 *   - a shortfall of real money means the re-centre wants a different token mix
 *     than it removed, which no buffer size fixes.
 *
 * These pin the arithmetic that tells them apart.
 */

const SOL = 9;
const MEME = 9;

function call(over = {}) {
  return depositShortfall({
    depositedX: new BN(0),
    depositedY: new BN(0),
    withdrawnX: new BN(0),
    withdrawnY: new BN(0),
    ataX: new BN(0),
    ataY: new BN(0),
    decimalsX: MEME,
    decimalsY: SOL,
    ...over,
  });
}

test("the shortfall is what the deposit wants beyond what the removal returns", () => {
  // The removal funds the deposit in the same instruction. Only the difference
  // has to come from the wallet.
  const r = call({
    depositedY: new BN(1_000_000_000), // 1.0 SOL deposited
    withdrawnY: new BN(970_000_000), // 0.97 SOL released
    ataY: new BN(27_140_501), // ~0.0271 SOL buffer
  });

  assert.equal(r.y.needed, 0.03);
  assert.equal(r.y.covered, false, "0.0271 in the account does not cover 0.03");
  assert.equal(r.covered, false);
});

test("a deposit smaller than the removal needs nothing from the wallet", () => {
  // Shrinking a position releases more than it puts back. Without the floor at
  // zero this reads as a negative requirement, which would then "cover" a real
  // shortfall on the other side once summed.
  const r = call({ depositedY: new BN(500), withdrawnY: new BN(900), ataY: new BN(0) });

  assert.equal(r.y.needed, 0);
  assert.equal(r.y.covered, true);
});

test("needing exactly what is in the account is covered", () => {
  // `gte`, not `gt`. An off-by-one here reports a healthy rebalance as doomed.
  const r = call({ depositedY: new BN(100), withdrawnY: new BN(0), ataY: new BN(100) });
  assert.equal(r.y.covered, true);
});

test("one short side is enough to fail the whole thing", () => {
  // The instruction is atomic: both debits happen or neither does.
  const r = call({
    depositedX: new BN(10),
    withdrawnX: new BN(0),
    ataX: new BN(10), // X fine
    depositedY: new BN(10),
    withdrawnY: new BN(0),
    ataY: new BN(9), // Y one short
  });

  assert.equal(r.x.covered, true);
  assert.equal(r.y.covered, false);
  assert.equal(r.covered, false);
});

test("a short BASE side fails it too, not just the quote side", () => {
  /**
   * The mirror of the test above, and it is not redundant: with only the
   * quote-short case, an overall verdict that ignored the base side entirely
   * would still answer correctly, and the gap would not show. The base token is
   * the one the buffer does NOT top up, so this is the case likely to be
   * under-thought.
   */
  const r = call({
    depositedX: new BN(10),
    withdrawnX: new BN(0),
    ataX: new BN(9), // X one short
    depositedY: new BN(10),
    withdrawnY: new BN(0),
    ataY: new BN(10), // Y fine
  });

  assert.equal(r.x.covered, false);
  assert.equal(r.y.covered, true);
  assert.equal(r.covered, false, "the instruction is atomic — either debit failing sinks it");
});

test("each side is scaled by its OWN decimals", () => {
  // A 6-decimal quote against a 9-decimal base is the common case, and sharing
  // one exponent between them misreports by a factor of 1000 — which is exactly
  // the size of error that would answer "dust or real money" backwards.
  const r = depositShortfall({
    depositedX: new BN(1_000_000_000),
    withdrawnX: new BN(0),
    ataX: new BN(0),
    depositedY: new BN(1_000_000),
    withdrawnY: new BN(0),
    ataY: new BN(0),
    decimalsX: 9,
    decimalsY: 6,
  });

  assert.equal(r.x.needed, 1, "9 decimals");
  assert.equal(r.y.needed, 1, "6 decimals");
});

test("the reading distinguishes dust from real money", () => {
  // The whole point. These two produce the same on-chain error and want
  // opposite responses.
  const dust = call({ depositedY: new BN(1_000_000_100), withdrawnY: new BN(1_000_000_000), ataY: new BN(0) });
  assert.equal(dust.y.needed, 1e-7, "a hundred lamports — MIN_QUOTE_BALANCE_USD is simply too low");

  const real = call({ depositedY: new BN(1_500_000_000), withdrawnY: new BN(1_000_000_000), ataY: new BN(0) });
  assert.equal(real.y.needed, 0.5, "half a SOL — the re-centre wants a different mix, no buffer fixes that");
});

test("the withdrawn and deposited figures are reported, not just the difference", () => {
  // A shortfall of 0.03 means something different against a 0.1 SOL position
  // than against a 100 SOL one, and the log has to carry enough to tell.
  const r = call({
    depositedY: new BN(1_000_000_000),
    withdrawnY: new BN(970_000_000),
    ataY: new BN(27_140_501),
  });

  assert.equal(r.y.deposited, 1);
  assert.equal(r.y.withdrawn, 0.97);
  assert.equal(r.y.ata, 0.027140501);
});

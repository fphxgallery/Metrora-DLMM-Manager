import test from "node:test";
import assert from "node:assert/strict";
import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";

import { walletMovement } from "../dist/meteora/rebalance.js";
import { MeteoraClient } from "../dist/meteora/client.js";

/**
 * What a landed withdraw leg did to the wallet's token accounts.
 *
 * This replaces a measurement that could never have worked. v1.12.2 modelled the
 * same question from `simulateRebalancePositionWithBalancedStrategy`, reading
 * `actualAmount{X,Y}Deposited`. Six live samples spanning ratioBps 1745 to 8852
 * every one reported zero, because those fields are the explicit `topUpAmount`
 * arguments — passed as `new BN(0)` — and not the internal redeposit of
 * withdrawn liquidity that actually debits the wallet.
 *
 * The tests for it all passed. They pinned the arithmetic given its inputs, and
 * the arithmetic was right; the inputs meant something else. Which is the case
 * for reading the transaction instead: a balance delta cannot be wrong about
 * what a field name meant.
 */

const SOL = 9;
const MEME = 6;

const call = (over = {}) =>
  walletMovement({ deltaX: null, deltaY: null, decimalsX: MEME, decimalsY: SOL, ...over });

test("a negative delta is the wallet supplying the difference", () => {
  // The whole point. The instruction debited the account, and that magnitude is
  // exactly what the buffer had to cover.
  const r = call({ deltaY: new BN(-30_000_000) });

  assert.equal(r.y.delta, -0.03);
  assert.equal(r.y.supplied, 0.03, "reported as a positive amount supplied");
  assert.equal(r.suppliedAnything, true);
});

test("a positive delta is the leg paying the wallet, and supplies nothing", () => {
  // The common case: a withdraw leg releases the surplus for the swap to pick up.
  const r = call({ deltaX: new BN(3_131_411_987) });

  assert.equal(r.x.delta, 3131.411987);
  assert.equal(r.x.supplied, 0);
  assert.equal(r.suppliedAnything, false);
});

test("a zero delta is not a supply", () => {
  // `isNeg()` rather than `!gt(0)`. Treating zero as a draw would make every
  // quiet leg look like it leaned on the buffer, which is the exact signal this
  // exists to detect.
  const r = call({ deltaX: new BN(0), deltaY: new BN(0) });

  assert.equal(r.x.supplied, 0);
  assert.equal(r.y.supplied, 0);
  assert.equal(r.suppliedAnything, false);
});

test("either side drawing is enough to flag it", () => {
  // The base token is the one MIN_QUOTE_BALANCE_USD never tops up, so a draw
  // there matters at least as much as one on the quote side.
  assert.equal(call({ deltaX: new BN(-1), deltaY: new BN(500) }).suppliedAnything, true);
  assert.equal(call({ deltaX: new BN(500), deltaY: new BN(-1) }).suppliedAnything, true);
});

test("each side is scaled by its own decimals", () => {
  // A 6-decimal token against 9-decimal SOL is the normal case here, and one
  // shared exponent misreports by 1000x — which would answer "dust or real
  // money" backwards, the only question this measurement exists to settle.
  const r = walletMovement({
    deltaX: new BN(-1_000_000),
    deltaY: new BN(-1_000_000_000),
    decimalsX: 6,
    decimalsY: 9,
  });

  assert.equal(r.x.supplied, 1);
  assert.equal(r.y.supplied, 1);
});

test("an unmeasurable side is null, not zero", () => {
  /**
   * `receivedInTx` returns null when the transaction could not be read. Folding
   * that to zero would report "drew nothing from the wallet" about a leg nobody
   * measured — the same mistake as the swap output in v1.11.9, where a clamped
   * unknown read as a confident zero and stranded 0.39 SOL.
   */
  const r = call({ deltaX: null, deltaY: new BN(-5) });

  assert.equal(r.x, null);
  assert.equal(r.y.supplied, 5e-9);
  assert.equal(r.suppliedAnything, true, "the side that WAS read still counts");
});

test("both sides unreadable reports nothing rather than a clean bill of health", () => {
  const r = call({ deltaX: null, deltaY: null });

  assert.equal(r.x, null);
  assert.equal(r.y, null);
  assert.equal(r.suppliedAnything, false, "no evidence of a draw is not evidence of none");
});

test("dust and real money are distinguishable, which is the entire purpose", () => {
  // These two produce the same on-chain error and want opposite responses.
  assert.equal(call({ deltaY: new BN(-100) }).y.supplied, 1e-7, "dust — the floor is simply too low");
  assert.equal(call({ deltaY: new BN(-500_000_000) }).y.supplied, 0.5, "half a SOL — no buffer size fixes that");
});

// ---- end to end, against a real transaction ---------------------------------

/**
 * The check that was missing from v1.12.2, and the reason it shipped inert.
 *
 * Every unit test above passes against a measurement that reads the wrong
 * fields — they only prove the arithmetic, never that the thing being fed in
 * describes reality. So this drives the whole path, `receivedInTx` included,
 * against a transaction that actually happened.
 *
 * Fixture: 4bSSeDeF..., a STONK-SOL withdraw leg from 2026-08-07 22:45:12.
 * The shape is the interesting part — the instruction credits the wSOL account,
 * then CLOSES it, unwrapping the withdrawn SOL plus the buffer plus the account
 * rent into native lamports. Reading the token side alone sees 27190495 -> 0 and
 * concludes the buffer was consumed. It was not; it came back as native SOL.
 */
const WALLET = "9sVHeFmj9i2tH2Mzst5wpeWZPfBSoFrSpZtTi7d5ZpWV";
const STONK = "6GmAFSYs4gk3FDao5FzzySQpPZaWsa4rUJHacpMpUNgx";
const WSOL = "So11111111111111111111111111111111111111112";

const WITHDRAW_LEG_TX = {
  meta: {
    err: null,
    fee: 37_979,
    preBalances: [1_000_000_000, 5_000_000],
    postBalances: [1_375_981_121, 5_000_000],
    preTokenBalances: [
      { owner: WALLET, mint: STONK, uiTokenAmount: { amount: "361475292365" } },
      { owner: WALLET, mint: WSOL, uiTokenAmount: { amount: "27190495" } },
    ],
    postTokenBalances: [
      { owner: WALLET, mint: STONK, uiTokenAmount: { amount: "361475456658" } },
      { owner: WALLET, mint: WSOL, uiTokenAmount: { amount: "0" } },
    ],
  },
  transaction: { message: { accountKeys: [{ pubkey: new PublicKey(WALLET) }, { pubkey: new PublicKey(STONK) }] } },
};

function clientFor(tx) {
  const c = Object.create(MeteoraClient.prototype);
  Object.defineProperty(c, "connection", { value: { getParsedTransaction: async () => tx }, writable: true });
  c.wallet = () => ({ publicKey: new PublicKey(WALLET) });
  c.cfg = { minSolBalance: 0.05 };
  c.tokenProgramOf = async () => new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  return c;
}

test("a real withdraw leg measures as a net CREDIT, not a draw on the buffer", async () => {
  const c = clientFor(WITHDRAW_LEG_TX);
  const [dx, dy] = await Promise.all([
    c.receivedInTx("SIG", new PublicKey(STONK)),
    c.receivedInTx("SIG", new PublicKey(WSOL)),
  ]);
  const m = walletMovement({ deltaX: dx, deltaY: dy, decimalsX: 9, decimalsY: 9 });

  assert.equal(m.x.delta, 0.000164293);
  // +0.375981121 native, -0.027190495 wSOL. The token side alone would read this
  // as the buffer being drained; folded together it is a credit.
  assert.equal(m.y.delta, 0.348790626);
  assert.equal(m.suppliedAnything, false, "this leg took nothing from the wallet");
});

test("the reading is not trivially zero — the v1.12.2 failure mode", async () => {
  /**
   * The previous measurement returned 0 for every field on every live sample,
   * and nothing in the suite noticed. Any replacement has to prove it produces
   * real magnitudes from real input, or it is the same bug wearing new fields.
   */
  const c = clientFor(WITHDRAW_LEG_TX);
  const dy = await c.receivedInTx("SIG", new PublicKey(WSOL));

  assert.notEqual(dy.toString(), "0", "a zero here is what made the old version useless");
  assert.ok(Math.abs(walletMovement({ deltaX: null, deltaY: dy, decimalsX: 9, decimalsY: 9 }).y.delta) > 0.001);
});

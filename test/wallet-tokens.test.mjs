import test from "node:test";
import assert from "node:assert/strict";

import { buildTokenView, lockReason, reclaimableLamports } from "../dist/wallet/tokens.js";

const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const RANDOM = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

/** A standard SPL token account's rent-exempt deposit, in lamports. */
const RENT = 2_039_280;

const acct = (over = {}) => ({
  pubkey: "ata1",
  mint: RANDOM,
  programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  amountRaw: "0",
  decimals: 5,
  uiAmount: 0,
  rentLamports: RENT,
  ...over,
});

const none = new Set();

// ---- what may be closed ---------------------------------------------------

test("an empty account is closable", () => {
  assert.equal(lockReason(acct(), none), null);
});

test("an account holding a balance is not", () => {
  assert.equal(lockReason(acct({ uiAmount: 0.0284 }), none), "holds a balance");
});

test("a managed position's tokens are blocked even when empty", () => {
  // The rebalance path re-creates these accounts, so closing one reclaims rent
  // that the very next rebalance pays again.
  const inUse = new Set([USDC]);
  assert.equal(lockReason(acct({ mint: USDC }), inUse), "in use by a managed position");
  assert.equal(lockReason(acct({ mint: USDC, uiAmount: 15.07 }), inUse), "in use by a managed position");
});

test("in use beats holds-a-balance, so the reason names the real block", () => {
  // Both apply to the quote buffer. The one that matters is the one the user
  // cannot fix by spending the balance.
  assert.equal(lockReason(acct({ mint: USDC, uiAmount: 15.07 }), new Set([USDC])), "in use by a managed position");
});

test("wrapped SOL with a balance is still closable — it unwraps", () => {
  // Left-over wSOL from an interrupted rebalance is recovered this way; the
  // balance returns to the same wallet as native SOL.
  assert.equal(lockReason(acct({ mint: WSOL, uiAmount: 0.21 }), none), null);
  const v = buildTokenView(acct({ mint: WSOL, uiAmount: 0.21 }), undefined, none);
  assert.equal(v.unwrapsToSol, true);
});

test("wrapped SOL of a managed pool is protected like any other side", () => {
  assert.equal(lockReason(acct({ mint: WSOL, uiAmount: 0.21 }), new Set([WSOL])), "in use by a managed position");
});

// ---- pricing --------------------------------------------------------------

test("a known mint gets a symbol and a USD value", () => {
  const v = buildTokenView(acct({ mint: USDC, uiAmount: 15.0693 }), { symbol: "USDC", usdPrice: 0.9997 }, none);
  assert.equal(v.symbol, "USDC");
  assert.ok(Math.abs(v.usdValue - 15.0648) < 0.001, `got ${v.usdValue}`);
});

test("a mint Jupiter does not know lists with a balance and no USD", () => {
  // An unpriced airdrop must still appear — it may be the thing holding an
  // account open, and hiding it would hide why the rent cannot be reclaimed.
  const v = buildTokenView(acct({ uiAmount: 1000 }), undefined, none);
  assert.equal(v.symbol, null);
  assert.equal(v.usdPrice, null);
  assert.equal(v.usdValue, null);
});

test("a nonsense price is treated as no price rather than NaN", () => {
  for (const usdPrice of [Number.NaN, Number.POSITIVE_INFINITY]) {
    const v = buildTokenView(acct({ uiAmount: 5 }), { symbol: "X", usdPrice }, none);
    assert.equal(v.usdValue, null);
  }
});

// ---- what a claim would return --------------------------------------------

test("only unlocked accounts count toward the reclaimable total", () => {
  const views = [
    buildTokenView(acct({ pubkey: "a" }), undefined, none), // empty -> closable
    buildTokenView(acct({ pubkey: "b" }), undefined, none), // empty -> closable
    buildTokenView(acct({ pubkey: "c", uiAmount: 3 }), undefined, none), // holds a balance
    buildTokenView(acct({ pubkey: "d", mint: USDC }), undefined, new Set([USDC])), // in use
  ];
  assert.equal(reclaimableLamports(views), RENT * 2);
});

test("rent comes from the account itself, not a hardcoded constant", () => {
  // Token-2022 accounts with extensions are larger and hold more rent. Closing
  // returns the account's own lamports, so that is what is reported.
  const views = [buildTokenView(acct({ rentLamports: 2_484_480 }), undefined, none)];
  assert.equal(reclaimableLamports(views), 2_484_480);
});

test("a wallet with nothing to claim reports zero", () => {
  assert.equal(reclaimableLamports([buildTokenView(acct({ uiAmount: 1 }), undefined, none)]), 0);
});

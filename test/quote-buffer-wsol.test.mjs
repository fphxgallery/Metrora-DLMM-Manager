import test from "node:test";
import assert from "node:assert/strict";
import BN from "bn.js";

import { ensureQuoteBuffer } from "../dist/meteora/rebalance.js";

// The guard this file covers already existed and still let two rebalances fail on
// chain, because it was defeated twice over on any *-SOL pool:
//
//   1. It read MeteoraClient.tokenBalance, which deliberately folds native SOL
//      into the wSOL figure. A wallet with 0.85 SOL and an EMPTY wSOL ATA read as
//      ~$62 against a $1 floor, so the guard returned "fine" every time.
//   2. Even had it fired, the top-up swapped WSOL_MINT -> quoteMint. When the
//      quote IS SOL that is wSOL -> wSOL, which is not a route.
//
// Both observed live: RebalanceLiquidity's deposit half asked for 146,041 lamports
// of wSOL (CATE-SOL) and 743,476 (CONTRA-SOL) out of an ATA that did not exist,
// and the whole instruction reverted with SPL Token "insufficient funds" (0x1).

const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const SOL_PRICE = 72.86;

/**
 * @param ataRaw    what the quote ATA actually holds on chain
 * @param nativeSol native SOL in the wallet -- the balance that fooled the old read
 */
function harness({ quoteMint, ataRaw, nativeSol = 0.85, autoTopUp = true, minQuoteBalanceUsd = 1 }) {
  const sent = [];
  const quoted = [];
  const warnings = [];

  const deps = {
    cfg: {
      minQuoteBalanceUsd,
      maxTopUpUsd: 5,
      minSolBalance: 0.05,
      autoTopUp,
    },
    client: {
      wallet: () => ({ publicKey: { toBase58: () => "WALLET" } }),
      requireWallet: () => ({ publicKey: { toBase58: () => "WALLET" } }),
      solBalance: async () => nativeSol,
      // The honest on-chain read. Returns zero for a missing ATA rather than throwing.
      ataBalance: async () => new BN(ataRaw),
      // The folded read. If anything under test calls this for the wSOL buffer the
      // original bug is back, so it fails loudly rather than returning a number.
      tokenBalance: async () => {
        throw new Error("ensureQuoteBuffer must not use the native-SOL-folded balance");
      },
      wrapSolIxs: (lamports) => [{ kind: "wrap", lamports }],
    },
    sender: {
      sendInstructions: async (ixs, _signers, label) => {
        sent.push({ label, ixs });
        return { signature: "SIG_WRAP" };
      },
      sendVersioned: async (_tx, label) => {
        sent.push({ label });
        return { signature: "SIG_SWAP" };
      },
    },
    swapper: {
      quote: async (q) => {
        quoted.push(q);
        return q;
      },
      buildTransaction: async () => ({}),
    },
    dataApi: { solPriceUsd: async () => SOL_PRICE },
    log: { info() {}, debug() {}, warn: (o, m) => warnings.push(m ?? o) },
  };

  const args =
    quoteMint === WSOL
      ? { quoteMint: WSOL, quoteSymbol: "SOL", quotePriceUsd: SOL_PRICE, quoteDecimals: 9 }
      : { quoteMint: USDC, quoteSymbol: "USDC", quotePriceUsd: 1, quoteDecimals: 6 };

  return { deps, args, sent, quoted, warnings };
}

test("an empty wSOL ATA is seen as empty, not as the wallet's native SOL", async () => {
  // The exact live shape: no wSOL ATA at all, 0.85 SOL sitting in the wallet.
  const h = harness({ quoteMint: WSOL, ataRaw: 0, nativeSol: 0.85 });
  const res = await ensureQuoteBuffer(h.deps, h.args);

  assert.equal(res.balanceUsd, 0, "the folded native-SOL balance must not count here");
  assert.equal(res.low, false, "it should have been topped up");
});

test("a SOL quote is WRAPPED, never swapped", async () => {
  const h = harness({ quoteMint: WSOL, ataRaw: 0 });
  await ensureQuoteBuffer(h.deps, h.args);

  assert.equal(h.quoted.length, 0, "wSOL -> wSOL is not a route and must never be quoted");
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].label, "wrap SOL buffer");
  assert.equal(h.sent[0].ixs[0].kind, "wrap");
});

test("the wrap is sized to twice the floor and stays inside MIN_SOL_BALANCE", async () => {
  const h = harness({ quoteMint: WSOL, ataRaw: 0 });
  await ensureQuoteBuffer(h.deps, h.args);

  const lamports = h.sent[0].ixs[0].lamports;
  const wantSol = (1 * 2) / SOL_PRICE; // floor $1 -> refill to $2
  assert.ok(Math.abs(lamports - Math.floor(wantSol * 1e9)) <= 1, `got ${lamports}`);

  // Comfortably covers both shortfalls seen on chain.
  assert.ok(lamports > 743_476, "must cover the largest observed shortfall");
});

test("a funded wSOL ATA is left alone", async () => {
  // $2 of wSOL already wrapped, floor is $1.
  const h = harness({ quoteMint: WSOL, ataRaw: Math.floor((2 / SOL_PRICE) * 1e9) });
  const res = await ensureQuoteBuffer(h.deps, h.args);

  assert.equal(res.low, false);
  assert.equal(h.sent.length, 0, "nothing to do — no transaction should be sent");
});

test("a non-SOL quote still tops up by swapping", async () => {
  // The USDC path is untouched by this fix and must keep working.
  const h = harness({ quoteMint: USDC, ataRaw: 0 });
  await ensureQuoteBuffer(h.deps, h.args);

  assert.equal(h.quoted.length, 1);
  assert.equal(h.quoted[0].inputMint, WSOL);
  assert.equal(h.quoted[0].outputMint, USDC);
  assert.equal(h.sent[0].label, "top up USDC buffer");
});

test("AUTO_TOPUP off warns instead of wrapping", async () => {
  const h = harness({ quoteMint: WSOL, ataRaw: 0, autoTopUp: false });
  const res = await ensureQuoteBuffer(h.deps, h.args);

  assert.equal(res.low, true);
  assert.equal(h.sent.length, 0, "nothing may be signed with AUTO_TOPUP off");
});

test("a wallet with no spendable SOL refuses rather than eating the reserve", async () => {
  // MIN_SOL_BALANCE is what keeps fees and rent payable.
  const h = harness({ quoteMint: WSOL, ataRaw: 0, nativeSol: 0.05 });
  const res = await ensureQuoteBuffer(h.deps, h.args);

  assert.equal(res.low, true);
  assert.equal(h.sent.length, 0);
});

test("a failed wrap warns and does not block the rebalance", async () => {
  // The buffer is a precaution; a rebalance that would have worked anyway must
  // still be attempted.
  const h = harness({ quoteMint: WSOL, ataRaw: 0 });
  h.deps.sender.sendInstructions = async () => {
    throw new Error("blockhash expired");
  };

  const res = await ensureQuoteBuffer(h.deps, h.args);
  assert.equal(res.low, true, "reported as low, but no throw");
});

test("MIN_QUOTE_BALANCE_USD=0 disables the guard entirely", async () => {
  const h = harness({ quoteMint: WSOL, ataRaw: 0, minQuoteBalanceUsd: 0 });
  const res = await ensureQuoteBuffer(h.deps, h.args);

  assert.deepEqual(res, { balanceUsd: null, low: false });
  assert.equal(h.sent.length, 0);
});

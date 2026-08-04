import test from "node:test";
import assert from "node:assert/strict";
import BN from "bn.js";

import { ensurePoolBuffers } from "../dist/meteora/rebalance.js";

// The buffer guard used to cover token_y only, and that gap cost a rebalance on
// chain. Observed live 2026-08-04: the wSOL buffer (token_y) was topped up
// correctly at 13:59:04, and the same rebalance reverted four seconds later for
// 261,692 base units of the token_x side (Jimothy, a Token-2022 mint) against an
// ATA holding none of it -- InstructionError [4, Custom: 1], fee paid.
//
// Which side comes up short depends only on where the price sits, so both have to
// be buffered. These tests pin that, and pin the ordering rule that keeps two
// top-ups from together spending past MIN_SOL_BALANCE.

const WSOL = "So11111111111111111111111111111111111111112";
const JIMOTHY = "Ge87EtsjwRQbHaqQmKRno69RFTwh9bfSsm99XNxTpump";
const JITOSOL = "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn";

const SOL_PRICE = 72.86;

/** A pool record shaped like the Data API's, with prices the guard can use. */
function pool({ x, y }) {
  return {
    token_x: { address: x.mint, symbol: x.symbol, price: x.price, decimals: x.decimals },
    token_y: { address: y.mint, symbol: y.symbol, price: y.price, decimals: y.decimals },
  };
}

/**
 * @param balances raw ATA balance per mint -- anything absent reads as zero,
 *                 which is what a missing ATA looks like on chain.
 */
function harness({ balances = {}, nativeSol = 1.5, autoTopUp = true } = {}) {
  const sent = [];
  const quoted = [];
  // Every top-up spends SOL. Tracking it here is what makes the sequencing test
  // meaningful: a parallel implementation would plan both against the same figure.
  let sol = nativeSol;
  const solSeenByEachPlan = [];

  const deps = {
    cfg: { minQuoteBalanceUsd: 1, maxTopUpUsd: 5, minSolBalance: 0.05, autoTopUp },
    client: {
      wallet: () => ({ publicKey: { toBase58: () => "WALLET" } }),
      requireWallet: () => ({ publicKey: { toBase58: () => "WALLET" } }),
      solBalance: async () => {
        solSeenByEachPlan.push(sol);
        return sol;
      },
      ataBalance: async (mint) => new BN(balances[mint.toBase58?.() ?? String(mint)] ?? 0),
      tokenBalance: async () => {
        throw new Error("must not use the native-SOL-folded balance");
      },
      wrapSolIxs: (lamports) => [{ kind: "wrap", lamports }],
    },
    sender: {
      sendInstructions: async (ixs, _s, label) => {
        sol -= ixs[0].lamports / 1e9;
        sent.push({ label, lamports: ixs[0].lamports });
        return { signature: "SIG_WRAP" };
      },
      sendVersioned: async (_tx, label) => {
        sent.push({ label });
        return { signature: "SIG_SWAP" };
      },
    },
    swapper: {
      quote: async (q) => {
        sol -= Number(q.amount.toString()) / 1e9;
        quoted.push(q);
        return q;
      },
      buildTransaction: async () => ({}),
    },
    dataApi: { solPriceUsd: async () => SOL_PRICE },
    log: { info() {}, debug() {}, warn() {} },
  };

  return { deps, sent, quoted, solSeenByEachPlan };
}

const JIMOTHY_SOL = pool({
  x: { mint: JIMOTHY, symbol: "Jimothy", price: 0.00042, decimals: 6 },
  y: { mint: WSOL, symbol: "SOL", price: SOL_PRICE, decimals: 9 },
});

test("the token_x side is buffered, not just token_y", async () => {
  // The exact live shape: both ATAs empty on a Jimothy-SOL position.
  const h = harness();
  await ensurePoolBuffers(h.deps, JIMOTHY_SOL);

  const labels = h.sent.map((s) => s.label);
  assert.ok(
    labels.includes("top up Jimothy buffer"),
    `token_x was never topped up — got ${JSON.stringify(labels)}`,
  );
  assert.ok(labels.includes("wrap SOL buffer"), "token_y must still be covered");
});

test("token_x is handled before token_y, so the SOL side is priced last", async () => {
  const h = harness();
  await ensurePoolBuffers(h.deps, JIMOTHY_SOL);

  assert.deepEqual(h.sent.map((s) => s.label), ["top up Jimothy buffer", "wrap SOL buffer"]);
});

test("the second top-up sees the SOL the first one spent", async () => {
  // Sequential, not concurrent. Run in parallel both sides would plan against the
  // same pre-spend balance and could together dip under MIN_SOL_BALANCE.
  const h = harness({ nativeSol: 1.5 });
  await ensurePoolBuffers(h.deps, JIMOTHY_SOL);

  assert.equal(h.solSeenByEachPlan.length, 2);
  assert.ok(
    h.solSeenByEachPlan[1] < h.solSeenByEachPlan[0],
    `second plan saw a stale balance: ${JSON.stringify(h.solSeenByEachPlan)}`,
  );
});

test("a side already holding enough is skipped", async () => {
  // token_x funded above the $1 floor, token_y empty.
  const h = harness({ balances: { [JIMOTHY]: Math.floor((5 / 0.00042) * 1e6) } });
  await ensurePoolBuffers(h.deps, JIMOTHY_SOL);

  assert.deepEqual(h.sent.map((s) => s.label), ["wrap SOL buffer"]);
});

test("both sides funded means nothing is sent at all", async () => {
  const h = harness({
    balances: {
      [JIMOTHY]: Math.floor((5 / 0.00042) * 1e6),
      [WSOL]: Math.floor((5 / SOL_PRICE) * 1e9),
    },
  });
  await ensurePoolBuffers(h.deps, JIMOTHY_SOL);

  assert.equal(h.sent.length, 0);
  assert.equal(h.quoted.length, 0);
});

test("a pool with no SOL side swaps for both, wrapping neither", async () => {
  // JitoSOL-ONyc: neither side is native SOL, so both go through the swap path.
  const jitoOnyc = pool({
    x: { mint: JITOSOL, symbol: "JitoSOL", price: 95.5, decimals: 9 },
    y: { mint: "5Y8NV33Vv7WbnLfq3zBcKSdYPrk7g2KoiQoe7M2tcxp5", symbol: "ONyc", price: 1.13, decimals: 9 },
  });
  const h = harness();
  await ensurePoolBuffers(h.deps, jitoOnyc);

  assert.deepEqual(h.sent.map((s) => s.label), ["top up JitoSOL buffer", "top up ONyc buffer"]);
  assert.equal(h.quoted.length, 2);
  assert.ok(h.quoted.every((q) => q.inputMint === WSOL), "both legs are funded out of SOL");
});

test("one side failing does not stop the other, and never throws", async () => {
  // The buffer is a precaution. A token_x swap that cannot route must not take
  // the wSOL wrap down with it, and must not block the rebalance either.
  const h = harness();
  h.deps.swapper.quote = async () => {
    throw new Error("no route found");
  };

  await ensurePoolBuffers(h.deps, JIMOTHY_SOL);
  assert.deepEqual(h.sent.map((s) => s.label), ["wrap SOL buffer"]);
});

test("an unpriced side is skipped rather than guessed at", async () => {
  // price 0 means the Data API had nothing for it; sizing a top-up off that would
  // be inventing a number.
  const unpriced = pool({
    x: { mint: JIMOTHY, symbol: "Jimothy", price: 0, decimals: 6 },
    y: { mint: WSOL, symbol: "SOL", price: SOL_PRICE, decimals: 9 },
  });
  const h = harness();
  await ensurePoolBuffers(h.deps, unpriced);

  assert.deepEqual(h.sent.map((s) => s.label), ["wrap SOL buffer"]);
});

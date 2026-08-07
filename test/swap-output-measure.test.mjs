import test from "node:test";
import assert from "node:assert/strict";
import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";

import { runSwapLeg, depositProceeds } from "../dist/meteora/rebalance.js";
import { MeteoraClient } from "../dist/meteora/client.js";

/**
 * How a swap's output is measured, and what happens when it cannot be.
 *
 * On 2026-08-07 a STONK->SOL swap delivered 0.391783 SOL and the manager recorded
 * that it had received nothing. The deposit was skipped, the rebalance was marked
 * `done`, and the whole $29 input was written to the cost ledger as a 100% swap
 * loss -- which moved the dashboard's cost drag from 11% to 45% while the money
 * sat safe in the wallet the entire time.
 *
 * The cause was measuring by differencing two balance reads either side of the
 * send. Confirmation does not guarantee the follow-up read is served by a node
 * that has caught up, and `BN.max(0, after - before)` turned the resulting
 * negative difference into a clean, confident zero.
 *
 * Two rules come out of that, and everything here pins one of them:
 *   1. Read the output from the transaction's own record, not from a later query.
 *   2. Unknown is not zero. Never deposit a guess, never cost a guess, and never
 *      mark an entry done when the answer was never obtained.
 */

const SOL = "So11111111111111111111111111111111111111112";
const STONK = "6GmAFSYs4gk3FDao5FzzySQpPZaWsa4rUJHacpMpUNgx";
const WALLET = "9sVHeFmj9i2tH2Mzst5wpeWZPfBSoFrSpZtTi7d5ZpWV";
const pk = (s) => new PublicKey(s);

// ---- the measurement itself -------------------------------------------------

/**
 * The real 5BwixYVW... transaction, reduced to the fields the measurement reads.
 *
 * The shape is the whole point: the swap unwrapped into native SOL, so the wallet
 * has NO wSOL token balance on either side of the transaction. Anything reading
 * only the token side sees two absent rows and concludes nothing arrived.
 */
function unwrappedSwapTx({ pre = 2_295_671_123, post = 2_687_453_734 } = {}) {
  return {
    meta: {
      err: null,
      fee: 13_272,
      preBalances: [pre, 1_000_000],
      postBalances: [post, 1_000_000],
      preTokenBalances: [],
      postTokenBalances: [],
    },
    transaction: { message: { accountKeys: [{ pubkey: pk(WALLET) }, { pubkey: pk(STONK) }] } },
  };
}

function clientWith(getParsedTransaction) {
  const c = Object.create(MeteoraClient.prototype);
  Object.defineProperty(c, "connection", { value: { getParsedTransaction }, writable: true });
  c.wallet = () => ({ publicKey: pk(WALLET) });
  c.cfg = { minSolBalance: 0.05 };
  return c;
}

test("a swap that unwraps into native SOL is measured, not read as zero", async () => {
  // The exact case that stranded the funds. Both wSOL token rows are absent
  // because the account was opened, filled and closed inside the transaction.
  const c = clientWith(async () => unwrappedSwapTx());
  const got = await c.receivedInTx("SIG", pk(SOL));

  assert.equal(got.toString(), "391782611", "the native lamport delta is the proceeds");
});

test("the transaction fee is not added back, so the figure stays spendable", async () => {
  // 391782611 is the delta net of the 13272 fee. Adding it back would report
  // 391795883 -- more than the wallet actually holds, and a deposit sized from it
  // cannot settle.
  const c = clientWith(async () => unwrappedSwapTx());
  const got = await c.receivedInTx("SIG", pk(SOL));

  assert.equal(got.toString(), "391782611");
  assert.notEqual(got.toString(), "391795883", "the fee really did leave the wallet");
});

test("an SPL output is measured from the token rows", async () => {
  const c = clientWith(async () => ({
    meta: {
      err: null,
      preBalances: [1_000_000],
      postBalances: [1_000_000],
      preTokenBalances: [{ owner: WALLET, mint: STONK, uiTokenAmount: { amount: "245271295" } }],
      postTokenBalances: [{ owner: WALLET, mint: STONK, uiTokenAmount: { amount: "3885143009" } }],
    },
    transaction: { message: { accountKeys: [{ pubkey: pk(WALLET) }] } },
  }));

  assert.equal((await c.receivedInTx("SIG", pk(STONK))).toString(), "3639871714");
});

test("another account's balances in the same transaction are not counted", async () => {
  const c = clientWith(async () => ({
    meta: {
      err: null,
      preBalances: [1_000_000],
      postBalances: [1_000_000],
      preTokenBalances: [{ owner: "SOMEONE_ELSE", mint: STONK, uiTokenAmount: { amount: "0" } }],
      postTokenBalances: [{ owner: "SOMEONE_ELSE", mint: STONK, uiTokenAmount: { amount: "999999999" } }],
    },
    transaction: { message: { accountKeys: [{ pubkey: pk(WALLET) }] } },
  }));

  assert.equal((await c.receivedInTx("SIG", pk(STONK))).toString(), "0", "the pool's side is not ours");
});

test("a transaction that cannot be found reads as unknown, never as zero", async () => {
  // This is the distinction the whole fix turns on. Returning a zero here puts
  // the caller straight back into "swap produced nothing to deposit".
  const c = clientWith(async () => null);
  assert.equal(await c.receivedInTx("SIG", pk(SOL)), null);
});

test("a failed transaction reads as unknown", async () => {
  const c = clientWith(async () => ({ meta: { err: { InstructionError: [0, "X"] } }, transaction: {} }));
  assert.equal(await c.receivedInTx("SIG", pk(SOL)), null);
});

test("a lookup that throws is retried before giving up", async () => {
  let calls = 0;
  const c = clientWith(async () => {
    calls += 1;
    if (calls < 3) throw new Error("tx not found yet");
    return unwrappedSwapTx();
  });

  // Confirmation and queryability are not the same thing; a first miss is normal.
  assert.equal((await c.receivedInTx("SIG", pk(SOL))).toString(), "391782611");
  assert.equal(calls, 3);
});

// ---- what the swap leg does with it -----------------------------------------

function swapHarness({ receivedInTx, tokenBalanceBefore, tokenBalanceAfter, costThrows = false }) {
  const journal = {};
  let reads = 0;
  const deps = {
    cfg: { maxSwapPriceImpactBps: 200 },
    client: {
      requireWallet: () => ({ publicKey: pk(WALLET) }),
      getPool: async () => ({
        // A throwing price is how `costThrows` reaches measureSwapCost's caller.
        tokenX: { publicKey: pk(SOL), owner: pk(SOL), mint: { decimals: 9 } },
        tokenY: { publicKey: pk(STONK), owner: pk(STONK), mint: { decimals: 9 } },
        lbPair: costThrows ? null : { activeId: 0 },
      }),
      tokenBalance: async () => (reads++ === 0 ? tokenBalanceBefore : tokenBalanceAfter),
      receivedInTx,
    },
    sender: { sendVersioned: async (_t, label) => ({ label, dryRun: false, signature: "SIG_SWAP" }) },
    swapper: {
      quote: async () => ({ route: "r", outAmount: new BN(391_782_611), priceImpactBps: 1, quote: {} }),
      buildTransaction: async () => ({}),
    },
    store: {
      updateJournal: (_id, patch) => Object.assign(journal, patch),
      journalEntry: () => journal,
    },
    log: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
  };
  const plan = {
    poolAddress: "POOL",
    swap: { fromMint: STONK, toMint: SOL, fromSymbol: "STONK", toSymbol: "SOL" },
  };
  return { deps, plan, entry: { id: "j1" }, journal };
}

test("the transaction's figure is used even when a balance read disagrees", async () => {
  // The stale read said nothing moved. The transaction says otherwise, and the
  // transaction is the ledger's own record.
  const h = swapHarness({
    receivedInTx: async () => new BN(391_782_611),
    tokenBalanceBefore: new BN(2_245_671_123),
    tokenBalanceAfter: new BN(2_245_671_123),
  });

  const out = await runSwapLeg(h.deps, h.entry, h.plan, new BN(3_639_871_714));
  assert.equal(out.received.toString(), "391782611");
});

test("an unreadable transaction does not read as zero", async () => {
  // Both routes fail: the transaction cannot be read, and the balance difference
  // is the flat zero that started all this. The answer must be null.
  const h = swapHarness({
    receivedInTx: async () => null,
    tokenBalanceBefore: new BN(2_245_671_123),
    tokenBalanceAfter: new BN(2_245_671_123),
  });

  const out = await runSwapLeg(h.deps, h.entry, h.plan, new BN(3_639_871_714));
  assert.equal(out.received, null, "a zero here is what skipped the deposit and stranded 0.39 SOL");
});

test("a NEGATIVE balance difference is unknown too, not a clamped zero", async () => {
  // `BN.max(0, after - before)` is what made a stale read look like a measurement.
  const h = swapHarness({
    receivedInTx: async () => null,
    tokenBalanceBefore: new BN(2_245_671_123),
    tokenBalanceAfter: new BN(2_000_000_000),
  });

  const out = await runSwapLeg(h.deps, h.entry, h.plan, new BN(3_639_871_714));
  assert.equal(out.received, null);
});

test("a positive balance difference is still accepted as a fallback", async () => {
  // The old method is not wrong, just unreliable. When it produces something that
  // cannot be a stale read, it is better than nothing.
  const h = swapHarness({
    receivedInTx: async () => null,
    tokenBalanceBefore: new BN(2_245_671_123),
    tokenBalanceAfter: new BN(2_637_453_734),
  });

  const out = await runSwapLeg(h.deps, h.entry, h.plan, new BN(3_639_871_714));
  assert.equal(out.received.toString(), "391782611");
});

test("an unmeasured swap is not costed, so no false loss reaches the ledger", async () => {
  const h = swapHarness({
    receivedInTx: async () => null,
    tokenBalanceBefore: new BN(2_245_671_123),
    tokenBalanceAfter: new BN(2_245_671_123),
  });

  const out = await runSwapLeg(h.deps, h.entry, h.plan, new BN(3_639_871_714));

  assert.equal(out.cost, null, "costing a zero reports a 100% loss and writes it down as fact");
  assert.equal(h.journal.swap?.costBps, undefined);
  assert.notEqual(h.journal.swap?.costBps, 10_000, "the exact figure the live ledger recorded");
});

test("the measured amount is journalled even when costing fails", async () => {
  // Costing is bookkeeping and may throw. The amount is what `resume` needs to
  // finish the deposit -- writing them together meant one failure lost both, and
  // resume can only answer a missing outAmount by giving up.
  const h = swapHarness({
    receivedInTx: async () => new BN(391_782_611),
    tokenBalanceBefore: new BN(0),
    tokenBalanceAfter: new BN(0),
    costThrows: true,
  });

  const out = await runSwapLeg(h.deps, h.entry, h.plan, new BN(3_639_871_714));

  assert.equal(out.cost, null, "the cost really did fail");
  assert.equal(h.journal.swap?.outAmount, "391782611", "but the amount survived it");
  assert.equal(h.journal.swap?.sig, "SIG_SWAP");
});

// ---- and what the deposit does with it --------------------------------------

const depositDeps = {
  client: { requireWallet: () => ({ publicKey: pk(WALLET) }) },
  sender: {},
  log: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
};

test("an unmeasured swap refuses to deposit, loudly", async () => {
  // Returning empty marks the rebalance done and records it in the cost ledger.
  // That is only correct if the swap genuinely produced nothing. Throwing leaves
  // the journal on `deposit` with the error attached, which is what resume reads.
  await assert.rejects(
    () => depositProceeds(depositDeps, { id: "j1" }, { positionPk: "POS", swap: { toMint: SOL } }, null),
    /could not be measured/,
    "silence here is what marked a strand as a completed rebalance",
  );
});

test("a measured zero is still allowed through quietly", async () => {
  // The dry-run path: nothing was sent, so nothing arrived. Genuinely zero, and
  // it must not be escalated into an error by the fix above.
  const out = await depositProceeds(
    depositDeps,
    { id: "j1" },
    { positionPk: "POS", swap: { toMint: SOL } },
    new BN(0),
  );
  assert.deepEqual(out, []);
});

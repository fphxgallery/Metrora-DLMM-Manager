import test from "node:test";
import assert from "node:assert/strict";
import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";

import { TxError } from "../dist/tx/send.js";
import { runSwapLeg } from "../dist/meteora/rebalance.js";

// Exercises the loop itself, not just the predicate: how many times it quotes,
// when it stops, and that a failure with an unknown outcome escapes immediately
// instead of being re-sent.

const IN_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const OUT_MINT = "So11111111111111111111111111111111111111112";

const simSlippage = () =>
  new TxError("swap USDC->SOL would fail: custom program error: 0x1771", ["log"]);

function harness({ sendResults, priceImpactBps = 0, maxSwapPriceImpactBps = 200 }) {
  const quotes = [];
  const sends = [];
  let balance = new BN(0);

  const deps = {
    cfg: { maxSwapPriceImpactBps },
    client: {
      requireWallet: () => ({ publicKey: new PublicKey(OUT_MINT) }),
      getPool: async () => ({
        tokenX: { publicKey: new PublicKey(OUT_MINT), owner: new PublicKey(OUT_MINT) },
        tokenY: { publicKey: new PublicKey(IN_MINT), owner: new PublicKey(IN_MINT) },
      }),
      tokenBalance: async () => balance,
      // The primary measurement: what the landed transaction actually delivered.
      // Balance differencing is only the fallback, and only when it comes out
      // positive -- see "an unreadable transaction does not read as zero" in
      // swap-output-measure.test.mjs.
      receivedInTx: async () => (sends.length > 0 ? new BN(591_300_000) : null),
    },
    sender: {
      sendVersioned: async (_tx, label) => {
        const next = sendResults[sends.length];
        sends.push(label);
        if (next instanceof Error) throw next;
        // A landed swap moves the balance, which is what `received` measures.
        balance = new BN(591_300_000);
        return next;
      },
    },
    swapper: {
      quote: async (p) => {
        quotes.push(p.amount.toString());
        return {
          route: `route-${quotes.length}`,
          outAmount: new BN(591_300_000),
          priceImpactBps,
          quote: {},
        };
      },
      buildTransaction: async () => ({}),
    },
    store: { updateJournal: () => {} },
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  };

  const entry = { id: "j1" };
  const plan = {
    poolAddress: "POOL",
    swap: { fromMint: IN_MINT, toMint: OUT_MINT, fromSymbol: "USDC", toSymbol: "SOL" },
  };
  return { deps, entry, plan, quotes, sends };
}

test("a slippage failure at simulation is re-quoted and the swap completes", async () => {
  const h = harness({
    sendResults: [simSlippage(), { label: "swap", dryRun: false, signature: "SIG2" }],
  });
  const out = await runSwapLeg(h.deps, h.entry, h.plan, new BN(43_561_532));

  assert.equal(out.result.signature, "SIG2");
  assert.equal(out.received.toString(), "591300000", "measures what actually arrived");
  assert.equal(h.quotes.length, 2, "re-quoted rather than reusing the stale quote");
  assert.equal(h.sends.length, 2);
});

test("the amount is unchanged across re-quotes", async () => {
  // The funds are already in the wallet from the withdraw leg; a retry must swap
  // exactly the same amount, never a re-derived one.
  const h = harness({
    sendResults: [simSlippage(), simSlippage(), { label: "swap", dryRun: false, signature: "SIG3" }],
  });
  await runSwapLeg(h.deps, h.entry, h.plan, new BN(43_561_532));
  assert.deepEqual(h.quotes, ["43561532", "43561532", "43561532"]);
});

test("it gives up after three attempts and rethrows the last failure", async () => {
  const h = harness({ sendResults: [simSlippage(), simSlippage(), simSlippage()] });
  await assert.rejects(
    () => runSwapLeg(h.deps, h.entry, h.plan, new BN(1000)),
    /0x1771/,
    "the real error must survive, not be replaced by a retry-exhausted message",
  );
  assert.equal(h.quotes.length, 3, "bounded — no runaway quoting");
  assert.equal(h.sends.length, 3);
});

test("an expired blockhash escapes on the FIRST attempt and is never re-sent", async () => {
  // The unsafe case. The swap may have landed, so resume must handle it after
  // re-reading chain state.
  const h = harness({
    sendResults: [
      new TxError("Signature ... has expired: block height exceeded"),
      { label: "swap", dryRun: false, signature: "MUST_NOT_HAPPEN" },
    ],
  });
  await assert.rejects(() => runSwapLeg(h.deps, h.entry, h.plan, new BN(1000)), /expired/);
  assert.equal(h.sends.length, 1, "a swap with an unknown outcome must not be sent twice");
  assert.equal(h.quotes.length, 1);
});

test("the price-impact guard still fires before anything is signed", async () => {
  const h = harness({ sendResults: [], priceImpactBps: 250, maxSwapPriceImpactBps: 200 });
  await assert.rejects(
    () => runSwapLeg(h.deps, h.entry, h.plan, new BN(1000)),
    /MAX_SWAP_PRICE_IMPACT_BPS/,
  );
  assert.equal(h.sends.length, 0, "nothing built or sent");
  assert.equal(h.quotes.length, 1, "not re-quoted — impact is current liquidity, not timing");
});

test("a dry run returns no signature and nothing received", async () => {
  const h = harness({ sendResults: [{ label: "swap", dryRun: true }] });
  const out = await runSwapLeg(h.deps, h.entry, h.plan, new BN(1000));
  assert.equal(out.result.signature, undefined);
  assert.equal(out.received.toString(), "0");
});

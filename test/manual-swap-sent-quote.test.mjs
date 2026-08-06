import test from "node:test";
import assert from "node:assert/strict";
import BN from "bn.js";

import { executeSwap } from "../dist/swap/manual.js";

// executeSwap deliberately re-quotes at confirm rather than trusting the plan the
// client is holding -- a Jupiter quote goes stale in seconds. That means the quote
// planSwap checked is NOT the quote that gets signed, so the price-impact ceiling
// has to run again on the second one. Checking only the discarded quote left the
// guard measuring a route that was never sent: the simulation passes (a terrible
// swap is still a valid one) and `otherAmountThreshold` comes from the same bad
// quote, so slippage tolerance does not bind either.
//
// runSwapLeg already re-checks impact on every attempt's quote. This is the same
// rule on the manual path.

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const TOKENS = {
  [SOL]: { id: SOL, symbol: "SOL", usdPrice: 190, decimals: 9 },
  [USDC]: { id: USDC, symbol: "USDC", usdPrice: 1, decimals: 6 },
};

function stubJupiter(byMint) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const q = new URL(String(url)).searchParams.get("query") ?? "";
    const rows = q.split(",").map((m) => byMint[m]).filter(Boolean);
    return { ok: true, json: async () => rows };
  };
  return () => {
    globalThis.fetch = original;
  };
}

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

/**
 * `quotes` is consumed one per call: the first is what the preview inside
 * executeSwap sees, the second is the one actually built and signed.
 */
function deps({ quotes, maxSwapPriceImpactBps = 200 }) {
  const calls = { quotes: [], sends: [] };
  let n = 0;

  return {
    calls,
    deps: {
      cfg: { minSolBalance: 0.05, maxSwapPriceImpactBps, swapSlippageBps: 50 },
      store: { pendingJournal: () => [], positions: () => [] },
      client: {
        connection: {
          getParsedTokenAccountsByOwner: async (_owner, { programId }) => ({
            value:
              programId.toBase58() !== TOKEN_PROGRAM
                ? []
                : [
                    {
                      pubkey: { toBase58: () => "ata-sol" },
                      account: {
                        owner: programId,
                        lamports: 2039280,
                        data: {
                          parsed: {
                            info: {
                              mint: SOL,
                              tokenAmount: { amount: "4000000000", decimals: 9, uiAmount: 4 },
                            },
                          },
                        },
                      },
                    },
                  ],
          }),
        },
        requireWallet: () => ({ publicKey: { toBase58: () => "wa11et", equals: () => false } }),
        assertSolFunded: async () => {},
        getPool: async () => {
          throw new Error("no pool");
        },
        tokenBalance: async () => new BN("4000000000"),
      },
      sender: {
        sendVersioned: async (_tx, label, opts) => {
          calls.sends.push({ label, opts });
          return { label, dryRun: false, signature: "5sig", feeLamports: 5000 };
        },
      },
      swapper: {
        quote: async (p) => {
          const q = quotes[Math.min(n, quotes.length - 1)];
          n += 1;
          calls.quotes.push(p.amount.toString());
          return {
            outAmount: q.outAmount,
            priceImpactBps: q.priceImpactBps,
            route: q.route,
            quote: { otherAmountThreshold: q.otherAmountThreshold ?? "1", slippageBps: q.slippageBps ?? 50 },
          };
        },
        buildTransaction: async () => ({}),
      },
      log: { info() {}, warn() {}, error() {} },
      notify: () => {},
    },
  };
}

const GOOD = { outAmount: new BN("190000000"), priceImpactBps: 4, route: "Whirlpool", slippageBps: 50 };
const DRAINED = { outAmount: new BN("7600000"), priceImpactBps: 9000, route: "Drained", slippageBps: 50 };

test("a route that degrades between the preview and the send is refused, not signed", async () => {
  const restore = stubJupiter(TOKENS);
  const { deps: d, calls } = deps({ quotes: [GOOD, DRAINED] });

  await assert.rejects(
    () => executeSwap(d, { inputMint: SOL, outputMint: USDC, amount: 1 }),
    (e) => {
      assert.match(e.message, /9000bps exceeds MAX_SWAP_PRICE_IMPACT_BPS/);
      assert.match(e.message, /Nothing was sent/);
      return true;
    },
  );
  restore();

  assert.equal(calls.quotes.length, 2, "it did re-quote at confirm");
  assert.deepEqual(calls.sends, [], "the 9000bps quote was never signed");
});

test("the ceiling is the config value on the sent quote too", async () => {
  const restore = stubJupiter(TOKENS);
  // Same second quote, but a ceiling above it: this must go through, proving the
  // refusal above is the threshold and not just "the second quote is rejected".
  const { deps: d, calls } = deps({ quotes: [GOOD, DRAINED], maxSwapPriceImpactBps: 9500 });

  const out = await executeSwap(d, { inputMint: SOL, outputMint: USDC, amount: 1 });
  restore();

  assert.equal(calls.sends.length, 1);
  assert.equal(out.plan.priceImpactBps, 9000);
});

test("the plan handed back describes the quote that ran, not the one it replaced", async () => {
  const restore = stubJupiter(TOKENS);
  const second = {
    outAmount: new BN("185000000"),
    priceImpactBps: 30,
    route: "Meteora",
    otherAmountThreshold: "184000000",
    slippageBps: 50,
  };
  const { deps: d } = deps({ quotes: [GOOD, second] });

  const out = await executeSwap(d, { inputMint: SOL, outputMint: USDC, amount: 1 });
  restore();

  const { plan } = out;
  assert.equal(plan.route, "Meteora", "the route that was signed");
  assert.equal(plan.priceImpactBps, 30);
  assert.equal(plan.quotedOut, 185, "scaled at the OUTPUT mint's decimals");
  assert.equal(plan.minOut, 184);
  assert.equal(plan.rate, 185);
  // USD is rescaled from the preview's own implied unit price ($1/USDC), never
  // re-fetched: one more lookup between the quote and the send is one more thing
  // that can fail.
  assert.equal(plan.outUsd, 185);
  assert.equal(plan.inUsd, 190);
  assert.ok(Math.abs(plan.valueDeltaPct - ((185 - 190) / 190) * 100) < 1e-9);
});

test("an unpriced token leaves the rescaled USD figures null rather than zero", async () => {
  // Indexed, so its decimals are known, but carrying no price — which is the
  // ordinary case for a long-tail mint.
  const restore = stubJupiter({ [SOL]: TOKENS[SOL], [USDC]: { id: USDC, symbol: "USDC", decimals: 6 } });
  const { deps: d } = deps({
    quotes: [GOOD, { outAmount: new BN("185000000"), priceImpactBps: 30, route: "Meteora" }],
  });

  const out = await executeSwap(d, { inputMint: SOL, outputMint: USDC, amount: 1 });
  restore();

  assert.equal(out.plan.outUsd, null);
  assert.equal(out.plan.valueDeltaPct, null);
  assert.equal(out.plan.quotedOut, 185, "the swap itself is unaffected by the missing price");
});

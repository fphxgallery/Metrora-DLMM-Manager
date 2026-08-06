import test from "node:test";
import assert from "node:assert/strict";
import BN from "bn.js";

import { planSwap, executeSwap } from "../dist/swap/manual.js";

// The manual swap. Everything here is a guard that runs BEFORE a signature, or
// the one thing that happens after: measuring what actually arrived.
//
// The guard that matters most is the pending-journal refusal. Between a
// rebalance's withdraw and its deposit, the withdrawn side sits in the wallet
// looking exactly like spare change — and spending it is how this project has
// stranded funds before. A test that only checked "insufficient balance" would
// miss that entirely, because the balance is there.

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const CATE = "CATEmoJVQvL1qLGRNe5xrxbnwUiF3JXTLZXWTKqCpump";

/** Jupiter's token-search response, stubbed onto global fetch. */
function stubJupiter(byMint) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const q = new URL(String(url)).searchParams.get("query") ?? "";
    const rows = q
      .split(",")
      .map((mint) => byMint[mint])
      .filter(Boolean);
    return { ok: true, json: async () => rows };
  };
  return () => {
    globalThis.fetch = original;
  };
}

const TOKENS = {
  [SOL]: { id: SOL, symbol: "SOL", usdPrice: 190, decimals: 9 },
  [USDC]: { id: USDC, symbol: "USDC", usdPrice: 1, decimals: 6 },
  [CATE]: { id: CATE, symbol: "CATE", usdPrice: 0.0034, decimals: 6 },
};

function deps({
  pending = [],
  accounts = [{ mint: SOL, decimals: 9, uiAmount: 4, programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" }],
  balances = { [SOL]: new BN("4000000000") },
  quote = { outAmount: new BN("760000000"), priceImpactBps: 4, route: "Whirlpool", otherAmountThreshold: "756000000", slippageBps: 50 },
  quoteThrows = null,
  maxSwapPriceImpactBps = 200,
  positions = [],
  pools = {},
  sendResult = { label: "manual swap", dryRun: false, signature: "5sig", feeLamports: 5000 },
  balanceAfter = null,
} = {}) {
  const calls = { quotes: [], sends: [], built: 0 };
  let balanceReads = 0;

  return {
    calls,
    deps: {
      cfg: { minSolBalance: 0.05, maxSwapPriceImpactBps, swapSlippageBps: 50 },
      store: {
        pendingJournal: () => pending,
        positions: () => positions,
      },
      client: {
        connection: {
          getParsedTokenAccountsByOwner: async (_owner, { programId }) => ({
            value: accounts
              .filter((a) => a.programId === programId.toBase58())
              .map((a) => ({
                pubkey: { toBase58: () => `ata-${a.mint}` },
                account: {
                  owner: programId,
                  lamports: 2039280,
                  data: {
                    parsed: {
                      info: {
                        mint: a.mint,
                        tokenAmount: { amount: String(a.uiAmount * 10 ** a.decimals), decimals: a.decimals, uiAmount: a.uiAmount },
                      },
                    },
                  },
                },
              })),
          }),
        },
        requireWallet: () => ({ publicKey: { toBase58: () => "wa11et", equals: () => false } }),
        assertSolFunded: async () => {},
        getPool: async (address) => {
          const p = pools[address];
          if (!p) throw new Error("pool unavailable");
          return p;
        },
        tokenBalance: async (mint) => {
          const key = mint.toBase58();
          // The second read of the OUTPUT balance is the post-swap one.
          if (balanceAfter && key === balanceAfter.mint) {
            balanceReads += 1;
            return balanceReads > 1 ? balanceAfter.after : balanceAfter.before;
          }
          return balances[key] ?? new BN(0);
        },
      },
      sender: {
        sendVersioned: async (_tx, label, opts) => {
          calls.sends.push({ label, opts });
          return sendResult;
        },
      },
      swapper: {
        quote: async (p) => {
          calls.quotes.push(p);
          if (quoteThrows) throw new Error(quoteThrows);
          return { ...quote, quote: { otherAmountThreshold: quote.otherAmountThreshold, slippageBps: quote.slippageBps } };
        },
        buildTransaction: async () => {
          calls.built += 1;
          return {};
        },
      },
      log: { info() {}, warn() {}, error() {} },
      notify: () => {},
    },
  };
}

async function rejects(fn, pattern) {
  await assert.rejects(fn, (e) => {
    assert.match(e.message, pattern);
    return true;
  });
}

test("an unfinished rebalance blocks the swap before a quote is even asked for", async () => {
  const restore = stubJupiter(TOKENS);
  try {
    const { deps: d, calls } = deps({ pending: [{ id: "j1", phase: "swap" }] });
    await rejects(() => planSwap(d, { inputMint: SOL, outputMint: USDC, amount: 1 }), /unfinished/i);
    // Not merely refused — refused EARLY. Those funds are mid-flight, and the
    // point is that nothing about them is inspected or spent.
    assert.equal(calls.quotes.length, 0);
  } finally {
    restore();
  }
});

test("the refusal names the withdrawn funds, not just a rule", async () => {
  const restore = stubJupiter(TOKENS);
  try {
    const { deps: d } = deps({ pending: [{ id: "j1" }, { id: "j2" }] });
    await rejects(
      () => planSwap(d, { inputMint: SOL, outputMint: USDC, amount: 1 }),
      /2 pending journal entries.*sitting in this wallet/s,
    );
  } finally {
    restore();
  }
});

test("a swap larger than the spendable balance is refused", async () => {
  const restore = stubJupiter(TOKENS);
  try {
    const { deps: d, calls } = deps({ balances: { [SOL]: new BN("4000000000") } });
    await rejects(() => planSwap(d, { inputMint: SOL, outputMint: USDC, amount: 9 }), /insufficient SOL/);
    assert.equal(calls.quotes.length, 0);
  } finally {
    restore();
  }
});

test("selling SOL says where the missing balance went", async () => {
  // tokenBalance already nets off MIN_SOL_BALANCE, so a wallet showing 4 SOL
  // can only spend 3.95. Without this line that reads as a bug.
  const restore = stubJupiter(TOKENS);
  try {
    const { deps: d } = deps();
    await rejects(() => planSwap(d, { inputMint: SOL, outputMint: USDC, amount: 9 }), /MIN_SOL_BALANCE=0\.05/);
  } finally {
    restore();
  }
});

test("price impact over MAX_SWAP_PRICE_IMPACT_BPS is refused after quoting", async () => {
  const restore = stubJupiter(TOKENS);
  try {
    const { deps: d, calls } = deps({
      quote: { outAmount: new BN("1"), priceImpactBps: 900, route: "Obscure", otherAmountThreshold: "1", slippageBps: 50 },
    });
    await rejects(
      () => planSwap(d, { inputMint: SOL, outputMint: USDC, amount: 1 }),
      /900bps exceeds MAX_SWAP_PRICE_IMPACT_BPS \(200bps\).*Nothing was sent/s,
    );
    assert.equal(calls.quotes.length, 1);
    assert.equal(calls.sends.length, 0);
  } finally {
    restore();
  }
});

test("the impact ceiling is the config value, not a constant", async () => {
  const restore = stubJupiter(TOKENS);
  try {
    const { deps: d } = deps({
      maxSwapPriceImpactBps: 1000,
      quote: { outAmount: new BN("760000000"), priceImpactBps: 900, route: "Obscure", otherAmountThreshold: "1", slippageBps: 50 },
    });
    const plan = await planSwap(d, { inputMint: SOL, outputMint: USDC, amount: 1 });
    assert.equal(plan.priceImpactBps, 900);
  } finally {
    restore();
  }
});

test("swapping a token into itself is refused", async () => {
  const restore = stubJupiter(TOKENS);
  try {
    const { deps: d } = deps();
    await rejects(() => planSwap(d, { inputMint: SOL, outputMint: SOL, amount: 1 }), /same/);
  } finally {
    restore();
  }
});

test("a nonsense mint is refused as a mint, not as a failed quote", async () => {
  const restore = stubJupiter(TOKENS);
  try {
    const { deps: d } = deps();
    await rejects(() => planSwap(d, { inputMint: "not-a-mint", outputMint: USDC, amount: 1 }), /not a valid mint/);
  } finally {
    restore();
  }
});

test("an amount below the mint's precision is refused rather than sent as zero", async () => {
  const restore = stubJupiter(TOKENS);
  try {
    const { deps: d } = deps({
      accounts: [{ mint: USDC, decimals: 6, uiAmount: 100, programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" }],
      balances: { [USDC]: new BN("100000000") },
    });
    await rejects(() => planSwap(d, { inputMint: USDC, outputMint: SOL, amount: 1e-9 }), /rounds to zero/);
  } finally {
    restore();
  }
});

test("buying a token the wallet has never held scales the quote from Jupiter's decimals", async () => {
  // The ordinary case: there is no token account to read decimals from, and the
  // quote does not carry them. Getting this wrong misreports the amount received
  // by orders of magnitude.
  const restore = stubJupiter(TOKENS);
  try {
    const { deps: d } = deps({
      quote: { outAmount: new BN("190000000"), priceImpactBps: 4, route: "Whirlpool", otherAmountThreshold: "189000000", slippageBps: 50 },
    });
    const plan = await planSwap(d, { inputMint: SOL, outputMint: USDC, amount: 1 });

    assert.equal(plan.outDecimals, 6);
    assert.equal(plan.quotedOut, 190);
    assert.equal(plan.minOut, 189);
  } finally {
    restore();
  }
});

test("a mint neither the wallet nor Jupiter knows is refused, not guessed", async () => {
  const restore = stubJupiter({ [SOL]: TOKENS[SOL] });
  try {
    const { deps: d } = deps();
    await rejects(
      () => planSwap(d, { inputMint: SOL, outputMint: CATE, amount: 1 }),
      /cannot determine the decimals.*Nothing was sent/s,
    );
  } finally {
    restore();
  }
});

test("selling a token a managed position needs warns but does not refuse", async () => {
  const restore = stubJupiter(TOKENS);
  try {
    const { deps: d } = deps({
      positions: [{ poolAddress: "PooL1" }],
      pools: {
        PooL1: {
          tokenX: { publicKey: { toBase58: () => SOL } },
          tokenY: { publicKey: { toBase58: () => CATE } },
        },
      },
    });
    const plan = await planSwap(d, { inputMint: SOL, outputMint: USDC, amount: 1 });

    assert.match(plan.inUseWarning, /managed position pool PooL1/);
    // The distinction the warning exists to make: the position keeps its own
    // liquidity, it is the WALLET balance the rebalancer draws on.
    assert.match(plan.inUseWarning, /liquidity is untouched/);
  } finally {
    restore();
  }
});

test("an unrelated token carries no warning", async () => {
  const restore = stubJupiter(TOKENS);
  try {
    const { deps: d } = deps({
      positions: [{ poolAddress: "PooL1" }],
      pools: {
        PooL1: {
          tokenX: { publicKey: { toBase58: () => CATE } },
          tokenY: { publicKey: { toBase58: () => USDC } },
        },
      },
    });
    const plan = await planSwap(d, { inputMint: SOL, outputMint: USDC, amount: 1 });
    assert.equal(plan.inUseWarning, null);
  } finally {
    restore();
  }
});

test("a pool that cannot be read costs the warning, never the swap", async () => {
  const restore = stubJupiter(TOKENS);
  try {
    const { deps: d } = deps({ positions: [{ poolAddress: "GonE" }] });
    const plan = await planSwap(d, { inputMint: SOL, outputMint: USDC, amount: 1 });
    assert.equal(plan.inUseWarning, null);
    assert.equal(plan.quotedOut > 0, true);
  } finally {
    restore();
  }
});

test("the plan reports the swap in USD on both sides", async () => {
  const restore = stubJupiter(TOKENS);
  try {
    const { deps: d } = deps({
      quote: { outAmount: new BN("190000000"), priceImpactBps: 4, route: "Whirlpool", otherAmountThreshold: "189000000", slippageBps: 50 },
    });
    const plan = await planSwap(d, { inputMint: SOL, outputMint: USDC, amount: 1 });

    assert.equal(plan.inUsd, 190);
    assert.equal(plan.outUsd, 190);
    assert.equal(plan.valueDeltaPct, 0);
    assert.equal(plan.rate, 190);
  } finally {
    restore();
  }
});

test("a swap that loses value reports it as a negative delta", async () => {
  const restore = stubJupiter(TOKENS);
  try {
    const { deps: d } = deps({
      quote: { outAmount: new BN("180500000"), priceImpactBps: 4, route: "Whirlpool", otherAmountThreshold: "1", slippageBps: 50 },
    });
    const plan = await planSwap(d, { inputMint: SOL, outputMint: USDC, amount: 1 });
    assert.equal(Math.round(plan.valueDeltaPct * 100) / 100, -5);
  } finally {
    restore();
  }
});

test("an unpriced token still swaps — the USD figures just go null", async () => {
  const restore = stubJupiter({ [SOL]: TOKENS[SOL], [CATE]: { id: CATE, symbol: "CATE", decimals: 6 } });
  try {
    const { deps: d } = deps();
    const plan = await planSwap(d, { inputMint: SOL, outputMint: CATE, amount: 1 });

    assert.equal(plan.outUsd, null);
    assert.equal(plan.valueDeltaPct, null);
    assert.equal(plan.outSymbol, "CATE");
  } finally {
    restore();
  }
});

test("confirming sends with force, so DRY_RUN cannot silently swallow it", async () => {
  // DRY_RUN exists to stop the UNATTENDED engine moving money. A swap a human
  // previewed and confirmed is not unattended, and a CONFIRM button that
  // simulates and reports success would be a lie about where the funds are.
  const restore = stubJupiter(TOKENS);
  try {
    const { deps: d, calls } = deps({
      balanceAfter: { mint: USDC, before: new BN("0"), after: new BN("190000000") },
      quote: { outAmount: new BN("190000000"), priceImpactBps: 4, route: "Whirlpool", otherAmountThreshold: "1", slippageBps: 50 },
    });
    const out = await executeSwap(d, { inputMint: SOL, outputMint: USDC, amount: 1 });

    assert.equal(calls.sends.length, 1);
    assert.equal(calls.sends[0].opts?.force, true);
    assert.equal(out.send.signature, "5sig");
  } finally {
    restore();
  }
});

test("what was received is measured from the wallet, not taken from the quote", async () => {
  // Jupiter quotes an estimate; slippage means the real figure differs. Reporting
  // the quote back as if it were the outcome would make every log and every
  // notification quietly wrong.
  const restore = stubJupiter(TOKENS);
  try {
    const { deps: d } = deps({
      quote: { outAmount: new BN("190000000"), priceImpactBps: 4, route: "Whirlpool", otherAmountThreshold: "1", slippageBps: 50 },
      balanceAfter: { mint: USDC, before: new BN("5000000"), after: new BN("193500000") },
    });
    const out = await executeSwap(d, { inputMint: SOL, outputMint: USDC, amount: 1 });

    assert.equal(out.received, 188.5);
    assert.notEqual(out.received, out.plan.quotedOut);
  } finally {
    restore();
  }
});

test("confirming re-runs every guard against fresh state", async () => {
  // The plan the client holds was priced seconds ago. A journal entry that
  // appeared in between must stop the swap even though the preview passed.
  const restore = stubJupiter(TOKENS);
  try {
    const { deps: d, calls } = deps({ pending: [{ id: "j1" }] });
    await rejects(() => executeSwap(d, { inputMint: SOL, outputMint: USDC, amount: 1 }), /unfinished/i);
    assert.equal(calls.sends.length, 0);
    assert.equal(calls.built, 0);
  } finally {
    restore();
  }
});

test("the quote is taken again at confirm rather than reused from the preview", async () => {
  const restore = stubJupiter(TOKENS);
  try {
    const { deps: d, calls } = deps({
      balanceAfter: { mint: USDC, before: new BN("0"), after: new BN("190000000") },
      quote: { outAmount: new BN("190000000"), priceImpactBps: 4, route: "Whirlpool", otherAmountThreshold: "1", slippageBps: 50 },
    });
    await executeSwap(d, { inputMint: SOL, outputMint: USDC, amount: 1 });

    // One inside the re-plan, one for the transaction actually built.
    assert.equal(calls.quotes.length, 2);
    assert.equal(calls.built, 1);
  } finally {
    restore();
  }
});

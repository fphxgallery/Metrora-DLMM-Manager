import test from "node:test";
import assert from "node:assert/strict";
import BN from "bn.js";
import { Keypair, PublicKey } from "@solana/web3.js";

import { planApe, splitHalf } from "../dist/meteora/ape.js";

// Ape pays in with ONE token and needs a two-sided position, so half is swapped
// for the other side. Everything worth testing here is a refusal: the guards
// that must fire before a signature exists, plus the split arithmetic, which is
// the only real calculation in the module.

const MINT_X = new PublicKey("So11111111111111111111111111111111111111112");
const MINT_Y = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

const CFG = {
  rangeBins: 34,
  strategyType: "Curve",
  maxSwapPriceImpactBps: 200,
  minSolBalance: 0.05,
  priorityFeeMicroLamports: 50_000,
  computeUnitLimit: 600_000,
  apeAutoManage: false,
};

/**
 * @param balance raw base units the wallet holds of the pay-with side
 * @param priceImpactBps what Jupiter reports for the half-swap
 */
function deps({ balance = "1000000000", priceImpactBps = 1, quoteFails = false, cfg = {} } = {}) {
  const quoted = [];
  const pool = {
    lbPair: { activeId: -6488, binStep: 4 },
    tokenX: { publicKey: MINT_X, owner: TOKEN_PROGRAM, mint: { decimals: 9 } },
    tokenY: { publicKey: MINT_Y, owner: TOKEN_PROGRAM, mint: { decimals: 6 } },
    fromPricePerLamport: () => "74.67",
    quoteCreatePosition: async () => ({
      positionCost: 0.0574,
      positionReallocCost: 0,
      bitmapExtensionCost: 0,
      binArrayCost: 0.0713,
      transactionCount: 2,
      positionCount: 1,
      binArraysCount: 2,
    }),
  };
  return {
    quoted,
    deps: {
      cfg: { ...CFG, ...cfg },
      client: {
        getPool: async () => pool,
        tokenBalance: async () => new BN(balance),
      },
      dataApi: {
        pool: async () => ({
          name: "SOL-USDC",
          token_x: { symbol: "SOL", price: 74.67 },
          token_y: { symbol: "USDC", price: 1 },
        }),
        solPriceUsd: async () => 74.67,
      },
      swapper: {
        quote: async (q) => {
          if (quoteFails) throw new Error("jupiter quote failed (429)");
          quoted.push(q.amount.toString());
          return {
            outAmount: new BN("7460000"),
            priceImpactBps,
            route: "Meteora DLMM",
            quote: {},
          };
        },
      },
      sender: {},
      store: {},
      log: { info() {}, warn() {}, error() {}, debug() {} },
    },
  };
}

const ape = (over = {}) => ({ poolAddress: "pool", amount: 0.2, payWith: "x", ...over });

test("splits an even amount into two exact halves", () => {
  const { swapRaw, keepRaw } = splitHalf(new BN(200_000_000));
  assert.equal(swapRaw.toString(), "100000000");
  assert.equal(keepRaw.toString(), "100000000");
});

test("an odd amount keeps the spare unit rather than losing it", () => {
  const total = new BN(7);
  const { swapRaw, keepRaw } = splitHalf(total);
  assert.equal(swapRaw.toString(), "3");
  assert.equal(keepRaw.toString(), "4");
  // The point of taking the remainder instead of dividing twice.
  assert.equal(swapRaw.add(keepRaw).toString(), total.toString());
});

test("quotes the swap for exactly half the input", async () => {
  const { deps: d, quoted } = deps();
  const plan = await planApe(d, ape());
  assert.deepEqual(quoted, ["100000000"]);
  assert.equal(plan.swapIn, 0.1);
  assert.equal(plan.keep, 0.1);
  assert.equal(plan.amountIn, 0.2);
});

test("the plan reports the range it would open, centred on the active bin", async () => {
  const plan = await planApe(deps().deps, ape());
  assert.equal(plan.activeBinId, -6488);
  assert.equal(plan.minBinId, -6522);
  assert.equal(plan.maxBinId, -6454);
  assert.equal(plan.rangeBins, 34);
});

test("borrows the strategy from settings rather than inventing one", async () => {
  const plan = await planApe(deps().deps, ape());
  assert.equal(plan.strategyType, "Curve");
});

test("an explicit strategy overrides the setting for this call", async () => {
  const plan = await planApe(deps().deps, ape({ strategyType: "Spot" }));
  assert.equal(plan.strategyType, "Spot");
});

test("refuses a price impact above MAX_SWAP_PRICE_IMPACT_BPS, without quoting twice", async () => {
  const { deps: d } = deps({ priceImpactBps: 250 });
  await assert.rejects(() => planApe(d, ape()), /price impact 250bps exceeds MAX_SWAP_PRICE_IMPACT_BPS/);
});

test("an impact exactly at the ceiling is allowed", async () => {
  const plan = await planApe(deps({ priceImpactBps: 200 }).deps, ape());
  assert.equal(plan.priceImpactBps, 200);
});

test("refuses an amount the wallet cannot fund, and says what it has", async () => {
  const { deps: d, quoted } = deps({ balance: "50000000" });
  await assert.rejects(() => planApe(d, ape({ amount: 0.2 })), /insufficient SOL: need 0.2, wallet has 0.05/);
  // Refused before it cost a Jupiter quote.
  assert.deepEqual(quoted, []);
});

test("the insufficient-balance message names the SOL reserve, which is why the balance looks short", async () => {
  const { deps: d } = deps({ balance: "50000000" });
  await assert.rejects(() => planApe(d, ape()), /MIN_SOL_BALANCE=0.05/);
});

test("refuses a non-positive amount", async () => {
  await assert.rejects(() => planApe(deps().deps, ape({ amount: 0 })), /amount must be greater than zero/);
  await assert.rejects(() => planApe(deps().deps, ape({ amount: -1 })), /amount must be greater than zero/);
});

test("refuses a side that is not x or y", async () => {
  await assert.rejects(() => planApe(deps().deps, ape({ payWith: "z" })), /payWith must be/);
});

test("refuses an amount too small to split", async () => {
  // 1 raw unit of a 9-decimal mint: half of it is zero, so there is no swap to make.
  await assert.rejects(
    () => planApe(deps().deps, ape({ amount: 0.000000001 })),
    /too small to split into a two-sided position/,
  );
});

test("paying with the other side flips the swap direction and the symbols", async () => {
  const plan = await planApe(deps().deps, ape({ payWith: "y", amount: 20 }));
  assert.equal(plan.payWith, "y");
  assert.equal(plan.inSymbol, "USDC");
  assert.equal(plan.outSymbol, "SOL");
  assert.equal(plan.inMint, MINT_Y.toBase58());
  assert.equal(plan.outMint, MINT_X.toBase58());
});

test("autoManage follows APE_AUTO_MANAGE, and an explicit choice overrides it", async () => {
  assert.equal((await planApe(deps().deps, ape())).autoManage, false);
  assert.equal((await planApe(deps({ cfg: { apeAutoManage: true } }).deps, ape())).autoManage, true);
  assert.equal((await planApe(deps().deps, ape({ auto: true }))).autoManage, true);
  assert.equal((await planApe(deps({ cfg: { apeAutoManage: true } }).deps, ape({ auto: false }))).autoManage, false);
});

test("prices the ape: rent, one fee per transaction, and the swap's own impact", async () => {
  const plan = await planApe(deps({ priceImpactBps: 100 }).deps, ape());
  // quoteCreatePosition says 2 transactions for the open; the swap is a third.
  const perTx = 5_000 + Math.ceil((50_000 * 600_000) / 1_000_000);
  assert.equal(plan.estCost.txFeesLamports, perTx * 3);
  assert.equal(plan.estCost.rentLamports, Math.round(0.1287 * 1e9));
  // 1% of the half being swapped: deposit is 0.2 SOL at $74.67 = $14.934.
  assert.ok(Math.abs(plan.estCost.swapImpactUsd - 14.934 / 2 / 100) < 1e-9);
  assert.ok(plan.estCostUsd > 0);
});

test("a failed rent quote prices rent at zero rather than failing the ape", async () => {
  const { deps: d } = deps();
  d.client.getPool = async () => ({
    lbPair: { activeId: -6488, binStep: 4 },
    tokenX: { publicKey: MINT_X, owner: TOKEN_PROGRAM, mint: { decimals: 9 } },
    tokenY: { publicKey: MINT_Y, owner: TOKEN_PROGRAM, mint: { decimals: 6 } },
    fromPricePerLamport: () => "74.67",
    quoteCreatePosition: async () => {
      throw new Error("rpc down");
    },
  });
  const plan = await planApe(d, ape());
  assert.equal(plan.estCost.rentLamports, 0);
});

test("a Jupiter outage surfaces as an error, not a plan with no swap in it", async () => {
  const { deps: d } = deps({ quoteFails: true });
  await assert.rejects(() => planApe(d, ape()), /jupiter quote failed/);
});

test("an unpriced pool still plans, just without USD figures", async () => {
  const { deps: d } = deps();
  d.dataApi.pool = async () => {
    throw new Error("indexer down");
  };
  const plan = await planApe(d, ape());
  assert.equal(plan.depositUsd, 0);
  assert.equal(plan.pairName, null);
  // Falls back to something legible rather than "undefined".
  assert.equal(plan.inSymbol, "X");
});

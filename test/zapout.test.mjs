import test from "node:test";
import assert from "node:assert/strict";
import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";

import { planZapOut, executeZapOut } from "../dist/meteora/zapout.js";

// Zap out closes the position and THEN swaps, which is the opposite order from
// Ape and the reason most of these tests exist. Two things carry the risk:
// every refusal has to happen while the position is still open, and the amount
// swapped afterwards must be what the POSITION released -- not the wallet
// delta, which also contains the rent the close just handed back.

const MINT_X = new PublicKey("So11111111111111111111111111111111111111112");
const MINT_Y = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const POSITION = new PublicKey("GKctchi3sq24RW43nTSbNuDyfhnHZG7hVe4bC298G1QC");

const CFG = {
  zapOutTo: "y",
  maxSwapPriceImpactBps: 200,
  priorityFeeMicroLamports: 50_000,
  computeUnitLimit: 600_000,
  minSolBalance: 0.05,
};

/**
 * @param totalX raw base units of SOL the position holds
 * @param balances successive tokenBalance() answers, in call order
 */
function harness({
  totalX = "734000000",
  totalY = "54810000",
  priceImpactBps = 2,
  pending = [],
  balances = null,
  exitSends = true,
  swapThrows = false,
  cfg = {},
} = {}) {
  const calls = { swapAmounts: [], exited: 0, quoted: 0 };
  const pool = {
    lbPair: { activeId: -6488, binStep: 4 },
    tokenX: { publicKey: MINT_X, owner: TOKEN_PROGRAM, mint: { decimals: 9 } },
    tokenY: { publicKey: MINT_Y, owner: TOKEN_PROGRAM, mint: { decimals: 6 } },
    fromPricePerLamport: () => "74.67",
    getPosition: async () => ({
      positionData: {
        totalXAmount: totalX,
        totalYAmount: totalY,
        feeX: new BN(0),
        feeY: new BN(0),
        lowerBinId: -6522,
        upperBinId: -6454,
      },
    }),
    removeLiquidity: async () => [{}],
  };

  let balanceCall = 0;
  const deps = {
    cfg: { ...CFG, ...cfg },
    client: {
      connection: { getAccountInfo: async () => ({ lamports: 57_400_000 }) },
      getPool: async () => pool,
      requireWallet: () => ({ publicKey: MINT_X }),
      assertSolFunded: async () => {},
      invalidate: () => {},
      tokenBalance: async () => new BN(balances ? (balances[balanceCall++] ?? "0") : "0"),
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
        calls.quoted += 1;
        calls.swapAmounts.push(q.amount.toString());
        return { outAmount: new BN("54800000"), priceImpactBps, route: "Meteora DLMM", quote: {} };
      },
      buildTransaction: async () => {
        if (swapThrows) throw new Error("jupiter swap build failed (500)");
        return {};
      },
    },
    sender: {
      sendAll: async () => {
        calls.exited += 1;
        return [{ dryRun: !exitSends, signature: exitSends ? "exitsig" : undefined }];
      },
      sendVersioned: async () => ({ dryRun: false, signature: "swapsig" }),
    },
    store: {
      pendingJournal: () => pending,
      removePosition: () => {},
      position: () => undefined,
    },
    log: { info() {}, warn() {}, error() {}, debug() {} },
  };
  return { deps, calls };
}

const params = (over = {}) => ({
  positionPk: POSITION.toBase58(),
  poolAddress: "pool",
  ...over,
});

test("defaults to the quote side, and names both symbols", async () => {
  const plan = await planZapOut(harness().deps, params());
  assert.equal(plan.to, "y");
  assert.equal(plan.toSymbol, "USDC");
  assert.equal(plan.fromSymbol, "SOL");
});

test("an explicit side overrides ZAP_OUT_TO and flips the swap direction", async () => {
  const plan = await planZapOut(harness().deps, params({ to: "x" }));
  assert.equal(plan.to, "x");
  assert.equal(plan.toSymbol, "SOL");
  assert.equal(plan.fromSymbol, "USDC");
  assert.equal(plan.fromMint, MINT_Y.toBase58());
});

test("swaps the whole of the unwanted side, fees included", async () => {
  const { deps, calls } = harness();
  const plan = await planZapOut(deps, params());
  assert.deepEqual(calls.swapAmounts, ["734000000"]);
  assert.equal(plan.amountFrom, 0.734);
  assert.equal(plan.amountFromRaw, "734000000");
});

test("totalOut is what was already in the target plus the swap proceeds", async () => {
  const plan = await planZapOut(harness().deps, params());
  assert.equal(plan.amountTo, 54.81);
  assert.equal(plan.quotedOut, 54.8);
  assert.equal(plan.totalOut, 109.61);
});

test("reports the rent the close returns, read from the account itself", async () => {
  const plan = await planZapOut(harness().deps, params());
  assert.equal(plan.rentLamports, 57_400_000);
});

test("a position already entirely in the target token needs no swap", async () => {
  const { deps, calls } = harness({ totalX: "0" });
  const plan = await planZapOut(deps, params());
  assert.equal(plan.needsSwap, false);
  assert.equal(plan.quotedOut, 0);
  assert.equal(plan.route, null);
  assert.equal(calls.quoted, 0, "should not quote a swap it does not need");
  assert.equal(plan.totalOut, plan.amountTo);
});

test("refuses a bad route BEFORE anything closes", async () => {
  const { deps, calls } = harness({ priceImpactBps: 500 });
  await assert.rejects(() => planZapOut(deps, params()), /still open/);
  assert.equal(calls.exited, 0, "the position must not have been exited");
});

test("refuses while a journal entry is pending for this position", async () => {
  const { deps, calls } = harness({
    pending: [{ id: "j1", phase: "swap", positionPk: POSITION.toBase58() }],
  });
  await assert.rejects(() => executeZapOut(deps, params()), /unfinished rebalance j1 is pending at phase "swap"/);
  assert.equal(calls.exited, 0);
});

test("a pending entry for a DIFFERENT position does not block", async () => {
  const { deps, calls } = harness({
    pending: [{ id: "j1", phase: "swap", positionPk: "someone-else" }],
    balances: ["0", "734000000", "0", "54800000"],
  });
  await executeZapOut(deps, params());
  assert.equal(calls.exited, 1);
});

test("swaps what the position released, NOT the wallet delta that includes reclaimed rent", async () => {
  // Closing returns 0.0574 SOL of rent as native SOL, which tokenBalance folds
  // into the wSOL figure. The delta is therefore 0.734 + 0.0574; only the 0.734
  // belonged to the position.
  const { deps, calls } = harness({ balances: ["0", "791400000", "0", "54800000"] });
  await executeZapOut(deps, params());
  // First quote is the plan's; the second is the one that actually executes.
  assert.equal(calls.swapAmounts[1], "734000000");
  assert.notEqual(calls.swapAmounts[1], "791400000", "must not sell the reclaimed rent");
});

test("caps at the wallet when it holds LESS than the position claimed", async () => {
  const { deps, calls } = harness({ balances: ["0", "700000000", "0", "54800000"] });
  await executeZapOut(deps, params());
  assert.equal(calls.swapAmounts[1], "700000000");
});

test("dry-run exits and stops, without pretending the swap ran", async () => {
  const { deps, calls } = harness({ exitSends: false });
  const res = await executeZapOut(deps, params());
  assert.equal(res.dryRun, true);
  assert.equal(res.swap, undefined);
  assert.match(res.note, /not simulated/);
  assert.equal(calls.swapAmounts.length, 1, "only the plan's quote, no execution quote");
});

test("a swap that fails after the close reports both balances rather than just failing", async () => {
  const { deps } = harness({ balances: ["0", "734000000", "0"], swapThrows: true });
  await assert.rejects(
    () => executeZapOut(deps, params()),
    /the position was closed but the swap failed.*0\.734 SOL and 54\.81 USDC/s,
  );
});

test("prices the exit's transactions plus the swap, and the swap's own impact", async () => {
  const plan = await planZapOut(harness({ priceImpactBps: 100 }).deps, params());
  const perTx = 5_000 + Math.ceil((50_000 * 600_000) / 1_000_000);
  // 69 bins -> one exit transaction, plus the swap.
  assert.equal(plan.estCost.txFeesLamports, perTx * 2);
  // 1% of the SOL side: 0.734 * 74.67.
  assert.ok(Math.abs(plan.estCost.swapImpactUsd - 0.734 * 74.67 * 0.01) < 1e-9);
});

test("an unpriced pool still plans", async () => {
  const { deps } = harness();
  deps.dataApi.pool = async () => {
    throw new Error("indexer down");
  };
  const plan = await planZapOut(deps, params());
  assert.equal(plan.valueUsd, 0);
  assert.equal(plan.toSymbol, "Y");
});

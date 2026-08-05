import test from "node:test";
import assert from "node:assert/strict";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";

import { depositProceeds } from "../dist/meteora/rebalance.js";

// Path B reshapes around the active bin, swaps, then deposits the proceeds. The
// swap takes seconds, and the deposit can only place the base token ABOVE the
// active bin as it stands when the deposit is BUILT -- so any bin the price
// crossed in between keeps the reshape's small share and gets nothing from the
// proceeds. That is the notch seen on JitoSOL-ONyc: bins 11121 and 11122 holding
// 0.25 JitoSOL where the curve called for ~0.9, because RebalanceLiquidity
// anchored on bin 11120 and AddLiquidityByStrategy2 anchored on 11122.

const X_MINT = new PublicKey("J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn");
const Y_MINT = new PublicKey("5Y8NTFAg4pcqmxKW6HTvJRbwHUqDCFrGxjNwCXRZpump");
const POSITION = new PublicKey("F6nAhumqoKAbRYqYhjm5os4cnwHKrwE7ntg3mFipnZdn");
const POOL = "9VPnw4KgHwhRW1HnqdA6Jx56USAF3jYGrNqu7pD42D1X";

function harness({
  activeBinId = 11122,
  lowerBinId = 11086,
  upperBinId = 11154,
  recentreBeforeDeposit = true,
  initBinArrays = 0,
  recentreThrows = null,
  sendThrows = null,
} = {}) {
  const calls = { sends: [], deposits: [], sims: 0, poolFetches: 0 };
  // The re-centre reshapes around the active bin, so the position it leaves
  // behind is centred -- 34 bins each side of a 69-bin position.
  let range = [lowerBinId, upperBinId];

  // Real instructions, not stand-in objects: `new Transaction().add(...)`
  // rejects anything else, and a throw there is caught by the re-centre's own
  // "never fatal" handler -- which silently turned every guard test green
  // regardless of what the guards did.
  const realIx = () =>
    new TransactionInstruction({ keys: [], programId: PublicKey.default, data: Buffer.alloc(0) });

  // A fresh object per fetch, sequence-stamped, so a deposit built from a pool
  // read BEFORE the re-centre is detectable rather than invisible.
  let poolSeq = 0;
  const makePool = () => {
    const seq = ++poolSeq;
    const pool = {
      seq,
      lbPair: { activeId: activeBinId },
      tokenX: { publicKey: X_MINT, owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") },
      tokenY: { publicKey: Y_MINT, owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") },
      getPosition: async () => ({ positionData: { lowerBinId: range[0], upperBinId: range[1] } }),
      simulateRebalancePositionWithBalancedStrategy: async () => {
        calls.sims += 1;
        if (recentreThrows) throw new Error(recentreThrows);
        return { sim: true };
      },
      rebalancePosition: async () => ({
        initBinArrayInstructions: Array.from({ length: initBinArrays }, realIx),
        rebalancePositionInstruction: [realIx()],
      }),
      addLiquidityByStrategy: async (args) => {
        calls.deposits.push({
          minBinId: args.strategy.minBinId,
          maxBinId: args.strategy.maxBinId,
          x: args.totalXAmount.toString(),
          y: args.totalYAmount.toString(),
          sawPoolSeq: seq,
        });
        return { add: () => {} };
      },
    };
    return pool;
  };

  const deps = {
    cfg: { recentreBeforeDeposit, maxActiveBinSlippage: 15 },
    client: {
      requireWallet: () => ({ publicKey: POSITION }),
      getPool: async () => { calls.poolFetches += 1; return makePool(); },
      getPosition: async () => ({ positionData: { lowerBinId: range[0], upperBinId: range[1] } }),
      invalidate: () => {},
      ataIxs: () => [],
    },
    sender: {
      send: async (_tx, _signers, label) => {
        calls.sends.push(label);
        if (label.includes("re-centre")) {
          if (sendThrows) throw new Error(sendThrows);
          // The re-centre lands: the position is now centred on the active bin.
          range = [activeBinId - 34, activeBinId + 34];
        }
        return { signature: `sig-${label}` };
      },
    },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    store: { updateJournal() {} },
  };

  const plan = {
    positionPk: POSITION.toBase58(),
    poolAddress: POOL,
    strategyType: "Curve",
    activeBinId: 11120,
    swap: { toMint: X_MINT.toBase58(), fromMint: Y_MINT.toBase58() },
  };

  return { deps, plan, calls, rangeNow: () => range };
}

test("an off-centre position is re-centred before the proceeds go in", async () => {
  const { deps, plan, calls, rangeNow } = harness({ activeBinId: 11122 });
  await depositProceeds(deps, { id: "j1" }, plan, new BN("11095200000"));

  assert.deepEqual(calls.sends, ["rebalance (re-centre before deposit)", "rebalance (deposit leg)"]);
  assert.deepEqual(rangeNow(), [11088, 11156], "the re-centre did not move the range onto the active bin");
  assert.deepEqual(
    [calls.deposits[0].minBinId, calls.deposits[0].maxBinId],
    [11088, 11156],
    "the deposit used the pre-re-centre range",
  );
});

test("a position already on the active bin is left alone", async () => {
  // The common case. An extra transaction per rebalance for nothing would cost
  // more than the notch it is meant to prevent.
  const { deps, plan, calls } = harness({ activeBinId: 11120, lowerBinId: 11086, upperBinId: 11154 });
  await depositProceeds(deps, { id: "j2" }, plan, new BN("11095200000"));

  assert.deepEqual(calls.sends, ["rebalance (deposit leg)"]);
  assert.equal(calls.sims, 0, "simulated a re-centre that was not needed");
});

test("the re-centre is skipped when it would pay bin-array rent", async () => {
  // ~0.0714 SOL, never recoverable, against a mis-shape worth a few cents of
  // fees. Not a trade worth making.
  const { deps, plan, calls } = harness({ activeBinId: 11122, initBinArrays: 1 });
  await depositProceeds(deps, { id: "j3" }, plan, new BN("11095200000"));

  assert.deepEqual(calls.sends, ["rebalance (deposit leg)"]);
});

test("a failed re-centre still deposits", async () => {
  // The whole safety property: proceeds stranded in the wallet is far worse than
  // a notch in the curve, so nothing in the re-centre may abort the deposit.
  for (const h of [
    harness({ activeBinId: 11122, recentreThrows: "simulate blew up" }),
    harness({ activeBinId: 11122, sendThrows: "blockhash expired" }),
  ]) {
    await depositProceeds(h.deps, { id: "j4" }, h.plan, new BN("11095200000"));
    assert.ok(
      h.calls.sends.includes("rebalance (deposit leg)"),
      "a failing re-centre swallowed the deposit",
    );
    assert.equal(h.calls.deposits.length, 1);
  }
});

test("the kill switch turns it off entirely", async () => {
  const { deps, plan, calls } = harness({ activeBinId: 11122, recentreBeforeDeposit: false });
  await depositProceeds(deps, { id: "j5" }, plan, new BN("11095200000"));

  assert.deepEqual(calls.sends, ["rebalance (deposit leg)"]);
  assert.equal(calls.sims, 0);
});

test("the deposit is built from a pool read AFTER the re-centre", async () => {
  // Building it from the pool fetched before the re-centre would anchor the
  // deposit on the bin the re-centre just moved away from -- reintroducing the
  // exact notch this change removes. The re-centre reads two pools (one to plan
  // from, one to confirm), so the deposit's must be the third.
  const { deps, plan, calls } = harness({ activeBinId: 11122 });
  await depositProceeds(deps, { id: "j6" }, plan, new BN("11095200000"));
  assert.equal(calls.poolFetches, 3, `pool fetched ${calls.poolFetches} times`);
  assert.equal(calls.deposits[0].sawPoolSeq, 3, "the deposit was built from a pool read before the re-centre");
});

test("nothing is sent at all when the swap produced nothing", async () => {
  const { deps, plan, calls } = harness({ activeBinId: 11122 });
  const out = await depositProceeds(deps, { id: "j7" }, plan, new BN(0));

  assert.deepEqual(out, []);
  assert.deepEqual(calls.sends, [], "re-centred a position with nothing to deposit");
});

test("the proceeds still go in on the correct side", async () => {
  const { deps, plan, calls } = harness({ activeBinId: 11122 });
  await depositProceeds(deps, { id: "j8" }, plan, new BN("11095200000"));
  assert.equal(calls.deposits[0].x, "11095200000", "base-token proceeds were deposited as quote");
  assert.equal(calls.deposits[0].y, "0");
});

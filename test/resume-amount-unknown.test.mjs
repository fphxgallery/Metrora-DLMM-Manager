import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";

import { Store } from "../dist/state.js";
import { resumeJournal } from "../dist/meteora/rebalance.js";

// Resume used to treat "the amount was never journalled" as "move everything in
// the wallet". It is not: MeteoraClient.tokenBalance deliberately ADDS native SOL
// above the MIN_SOL_BALANCE reserve to the wSOL token account, so for a wSOL leg
// the fallback is very nearly the whole wallet -- and for any other mint it still
// includes the idle quote buffer ensureQuoteBuffer parks there on purpose.
// Refusing and telling the operator where the funds are is the only safe answer.

// Must be real base58: resume constructs a PublicKey from it before it reaches
// the branch under test.
const POS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const ADD_ENDPOINT = `POST /api/positions/${POS}/add`;

const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// What the wallet would really look like: ~0.42 SOL of "available" wSOL, almost
// all of it the operator's fee reserve rather than anything this rebalance moved.
const WALLET = { [WSOL]: new BN(420_000_000), [USDC]: new BN(75_000_000) };

function harness({ phase, swap }) {
  const store = new Store(mkdtempSync(join(tmpdir(), "dlmm-resume-amt-")));
  store.openJournal({
    id: "j1",
    positionPk: POS,
    poolAddress: "POOL1",
    path: "B",
    phase,
    targetMinBinId: -10,
    targetMaxBinId: 10,
    sourceMinBinId: -20,
    sourceMaxBinId: 0,
    strategyType: "Spot",
    startedAt: 1,
    updatedAt: 1,
    // A landed withdraw leg: sigs are positive proof for legLanded.
    sigs: ["SIG_WITHDRAW"],
    swap,
  });

  const quoted = [];
  const sent = [];
  const deposited = [];
  const balances = { ...WALLET };

  const positionData = {
    lowerBinId: -20,
    upperBinId: 0,
    totalXAmount: "1000000000",
    totalYAmount: "150000000",
    feeX: new BN(0),
    feeY: new BN(0),
  };

  const pool = {
    lbPair: { activeId: 0, binStep: 4 },
    tokenX: { publicKey: pk(WSOL), owner: pk(WSOL), mint: { decimals: 9 } },
    tokenY: { publicKey: pk(USDC), owner: pk(USDC), mint: { decimals: 6 } },
    fromPricePerLamport: () => "150",
    getPosition: async () => ({ positionData }),
    addLiquidityByStrategy: async (args) => {
      deposited.push(args.totalXAmount.toString() + "/" + args.totalYAmount.toString());
      return {};
    },
  };

  const deps = {
    cfg: {
      strategyType: "Spot",
      ratioToleranceBps: 500,
      maxSwapPctOfPosition: 50,
      priorityFeeMicroLamports: 50_000,
      computeUnitLimit: 400_000,
      maxSwapPriceImpactBps: 200,
    },
    client: {
      wallet: () => ({ publicKey: pk(USDC) }),
      requireWallet: () => ({ publicKey: pk(USDC) }),
      getPool: async () => pool,
      tokenBalance: async (mint) => balances[mint.toBase58()] ?? new BN(0),
      invalidate: () => {},
    },
    dataApi: { pool: async () => null, solPriceUsd: async () => 150 },
    sender: {
      send: async (_tx, _signers, label) => {
        sent.push(label);
        return { label, dryRun: false, signature: "SIG_DEPOSIT" };
      },
      sendVersioned: async (_tx, label) => {
        sent.push(label);
        // A landed swap is what moves the destination balance.
        balances[USDC] = balances[USDC].add(new BN(60_000_000));
        return { label, dryRun: false, signature: "SIG_SWAP" };
      },
    },
    swapper: {
      quote: async (p) => {
        quoted.push(p.amount.toString());
        return { route: "r", outAmount: new BN(60_000_000), priceImpactBps: 1, quote: {} };
      },
      buildTransaction: async () => ({}),
    },
    store,
    log: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
  };

  return { deps, store, quoted, sent, deposited };
}

const pk = (s) => new PublicKey(s);

test("a landed withdraw with no journalled amount is refused, not swept", async () => {
  const h = harness({
    phase: "swap",
    swap: { inMint: WSOL, outMint: USDC, inAmount: "0" },
  });
  await resumeJournal(h.deps);

  // Asserted first, because this is the money: the old fallback quoted the FULL
  // 420000000 "available" wSOL -- the fee reserve, not the withdrawn surplus.
  assert.deepEqual(h.quoted, [], "no swap was even quoted");
  assert.deepEqual(h.sent, [], "nothing signed or sent");
  assert.equal(
    h.store.journalEntry("j1").phase,
    "failed",
    "terminal -- it must not retry this forever either",
  );
});

test("the refusal tells the operator where the funds are and how to recover them", async () => {
  const h = harness({
    phase: "swap",
    swap: { inMint: WSOL, outMint: USDC, inAmount: "0" },
  });
  await resumeJournal(h.deps);

  const { error } = h.store.journalEntry("j1");
  assert.match(error, /never journalled/, "names the actual cause");
  assert.match(error, /wallet/, "says where the money is");
  assert.ok(error.includes(ADD_ENDPOINT), "an endpoint that exists");
});

test("phase withdraw with no journalled amount is refused the same way", async () => {
  // Same branch, entered one phase earlier.
  const h = harness({
    phase: "withdraw",
    swap: { inMint: WSOL, outMint: USDC, inAmount: "0" },
  });
  await resumeJournal(h.deps);

  assert.equal(h.store.journalEntry("j1").phase, "failed");
  assert.deepEqual(h.sent, []);
});

test("a real journalled amount still swaps min(intended, available)", async () => {
  // The behaviour that must NOT change: intended above what is actually there is
  // capped by the wallet, so a partially completed swap is not double-spent.
  const h = harness({
    phase: "swap",
    swap: { inMint: WSOL, outMint: USDC, inAmount: "999000000000" },
  });
  await resumeJournal(h.deps);

  assert.deepEqual(h.quoted, ["420000000"], "capped at the wallet balance");
  assert.equal(h.store.journalEntry("j1").phase, "done");
});

test("a journalled amount below the balance is swapped in full", async () => {
  const h = harness({
    phase: "swap",
    swap: { inMint: WSOL, outMint: USDC, inAmount: "30000000" },
  });
  await resumeJournal(h.deps);

  assert.deepEqual(h.quoted, ["30000000"], "the intended amount, not the whole wallet");
});

test("the deposit branch refuses an unjournalled outAmount", async () => {
  const h = harness({
    phase: "deposit",
    swap: { inMint: WSOL, outMint: USDC, inAmount: "30000000" },
  });
  await resumeJournal(h.deps);

  assert.deepEqual(h.deposited, [], "the idle quote buffer was not deposited");
  assert.deepEqual(h.sent, []);
  const j = h.store.journalEntry("j1");
  assert.equal(j.phase, "failed");
  assert.ok(j.error.includes(ADD_ENDPOINT));
});

test("the deposit branch still deposits min(intended, available)", async () => {
  const h = harness({
    phase: "deposit",
    swap: { inMint: WSOL, outMint: USDC, inAmount: "30000000", outAmount: "999000000000" },
  });
  await resumeJournal(h.deps);

  assert.deepEqual(h.deposited, ["0/75000000"], "capped at the wallet balance, deposited as Y");
  assert.equal(h.store.journalEntry("j1").phase, "done");
});

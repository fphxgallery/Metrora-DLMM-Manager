import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";

import { Store } from "../dist/state.js";
import { resumeJournal } from "../dist/meteora/rebalance.js";

// runSwapLeg journals the swap's SIGNATURE the moment it confirms, and only then
// does runWithSwap move the phase to "deposit" -- an RPC round trip, the cost
// measurement and a disk write later. A crash or a redeploy in that window leaves
// `phase: "swap"` on a swap that has already landed on chain.
//
// Resuming from the phase alone re-runs it, and min(intended, available) is no
// protection: the swapped side has been drained, but tokenBalance folds native SOL
// above MIN_SOL_BALANCE back into wSOL, so `available` is very nearly the whole fee
// reserve and the second swap sells it. A journalled signature is positive proof,
// exactly as it is for the withdraw leg in legLanded.

const POS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const ADD_ENDPOINT = `POST /api/positions/${POS}/add`;

const pk = (s) => new PublicKey(s);

// The wallet AFTER the swap landed: the wSOL ATA is drained, but 0.42 SOL of
// native fee reserve reads back through the fold, and the USDC proceeds arrived.
const WALLET = { [WSOL]: new BN(420_000_000), [USDC]: new BN(135_000_000) };

function harness({ phase, swap }) {
  const store = new Store(mkdtempSync(join(tmpdir(), "dlmm-resume-landed-")));
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
      // The pre-deposit re-centre is a separate concern; off so the deposit leg
      // is the only send this test can attribute.
      recentreBeforeDeposit: false,
    },
    client: {
      wallet: () => ({ publicKey: pk(USDC) }),
      requireWallet: () => ({ publicKey: pk(USDC) }),
      getPool: async () => pool,
      tokenBalance: async (mint) => balances[mint.toBase58()] ?? new BN(0),
      invalidate: () => {},
      connection: { getTransaction: async () => ({ meta: { fee: 5000 } }) },
    },
    dataApi: { pool: async () => null, solPriceUsd: async () => 150 },
    sender: {
      send: async (_tx, _signers, label) => {
        sent.push(label);
        return { label, dryRun: false, signature: "SIG_DEPOSIT" };
      },
      sendVersioned: async (_tx, label) => {
        sent.push(label);
        balances[USDC] = balances[USDC].add(new BN(60_000_000));
        return { label, dryRun: false, signature: "SIG_SWAP_2" };
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

/** What runSwapLeg writes at the moment the swap confirms. */
const LANDED = {
  inMint: WSOL,
  outMint: USDC,
  inAmount: "300000000",
  outAmount: "60000000",
  sig: "SIG_SWAP_ALREADY_LANDED",
};

test("a swap with a journalled signature is NOT swapped a second time", async () => {
  const h = harness({ phase: "swap", swap: LANDED });
  await resumeJournal(h.deps);

  // This is the money: without the signature check, `intended` 300000000 is
  // capped by an `available` of 420000000 -- the operator's fee reserve, folded
  // in from native SOL -- and 0.3 SOL is sold all over again.
  assert.deepEqual(h.quoted, [], "no second swap was even quoted");
  assert.equal(
    h.sent.filter((l) => /swap/i.test(l)).length,
    0,
    "no second swap was signed",
  );
});

test("it resumes from the deposit instead, using the swap's measured proceeds", async () => {
  const h = harness({ phase: "swap", swap: LANDED });
  await resumeJournal(h.deps);

  assert.deepEqual(h.deposited, ["0/60000000"], "the journalled proceeds were deposited, once");
  assert.equal(h.store.journalEntry("j1").phase, "done");
});

test("a landed swap whose proceeds were never journalled is refused, not guessed", async () => {
  // The signature says the swap happened; without an outAmount there is nothing
  // that says how much arrived, and `available` includes the idle quote buffer.
  const h = harness({
    phase: "swap",
    swap: { inMint: WSOL, outMint: USDC, inAmount: "300000000", sig: "SIG_SWAP_ALREADY_LANDED" },
  });
  await resumeJournal(h.deps);

  assert.deepEqual(h.quoted, [], "nothing re-swapped");
  assert.deepEqual(h.deposited, [], "nothing deposited on a guess");
  const j = h.store.journalEntry("j1");
  assert.equal(j.phase, "failed");
  assert.ok(j.error.includes(ADD_ENDPOINT), "points at a recovery endpoint that exists");
});

test("without a signature the swap still runs — the phase alone is not enough to skip it", async () => {
  // The ordinary interrupted case, which must keep working: no signature means
  // the swap may never have been sent, so resume takes it.
  const h = harness({
    phase: "swap",
    swap: { inMint: WSOL, outMint: USDC, inAmount: "300000000" },
  });
  await resumeJournal(h.deps);

  assert.deepEqual(h.quoted, ["300000000"], "the interrupted swap was resumed");
  assert.equal(h.store.journalEntry("j1").phase, "done");
});

test("a phase-deposit entry is unaffected by the signature check", async () => {
  const h = harness({ phase: "deposit", swap: LANDED });
  await resumeJournal(h.deps);

  assert.deepEqual(h.quoted, []);
  assert.deepEqual(h.deposited, ["0/60000000"]);
});

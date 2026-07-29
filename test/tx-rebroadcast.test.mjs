import test from "node:test";
import assert from "node:assert/strict";

import { TxSender, TxError } from "../dist/tx/send.js";

const log = { info(){}, warn(){}, error(){}, debug(){} };
const cfg = { computeUnitLimit: 600000, priorityFeeMicroLamports: 200000 };

/**
 * `statuses` is consumed one entry per poll; `blockHeights` likewise. The raw
 * bytes are irrelevant — only the send/poll choreography is under test.
 */
function fakeConnection({ statuses, blockHeights = [], historyStatus = null }) {
  const state = { sends: 0, polls: 0, historyLookups: 0 };
  return {
    state,
    async sendRawTransaction() { state.sends++; return "SIG111"; },
    async getSignatureStatus(_sig, opts) {
      if (opts?.searchTransactionHistory) { state.historyLookups++; return { value: historyStatus }; }
      return { value: statuses[Math.min(state.polls++, statuses.length - 1)] };
    },
    async getBlockHeight() { return blockHeights.length ? blockHeights.shift() : 0; },
    async getTransaction() { return { meta: { fee: 5000 } }; },
  };
}

const call = (conn, expired) => {
  const sender = new TxSender(cfg, conn, log, () => false);
  return sender.confirmWithRebroadcast(new Uint8Array([1, 2, 3]), "test tx", ["log line"], expired);
};

test("rebroadcasts until the transaction confirms", async () => {
  const conn = fakeConnection({ statuses: [null, null, { confirmationStatus: "confirmed" }] });
  const sig = await call(conn, async () => false);

  assert.equal(sig, "SIG111");
  // 1 initial broadcast + 1 per unconfirmed poll. A passive wait would be 1.
  assert.equal(conn.state.sends, 3, "resent the same bytes while unconfirmed");
});

test("surfaces an on-chain error as TxError, with the simulation logs", async () => {
  const conn = fakeConnection({ statuses: [{ err: { InstructionError: [1, { Custom: 6001 }] } }] });
  await assert.rejects(() => call(conn, async () => false), (e) => {
    assert.ok(e instanceof TxError);
    assert.match(e.message, /failed on chain/);
    assert.deepEqual(e.logs, ["log line"]);
    return true;
  });
});

// The block-height read is at `confirmed`, so a transaction included in the last
// slot or two is still invisible when expiry trips. Reporting "nothing landed"
// there would be a lie about money that already moved.
test("expiry re-checks history and returns the signature if it actually landed", async () => {
  const conn = fakeConnection({
    statuses: [null],
    historyStatus: { confirmationStatus: "confirmed", err: null },
  });
  const sig = await call(conn, async () => true);

  assert.equal(sig, "SIG111");
  assert.equal(conn.state.historyLookups, 1, "checked history before declaring failure");
});

test("throws only when expiry is confirmed by history too", async () => {
  const conn = fakeConnection({ statuses: [null], historyStatus: null });
  await assert.rejects(() => call(conn, async () => true), (e) => {
    assert.ok(!(e instanceof TxError), "expiry is not a program failure");
    assert.match(e.message, /blockhash expired/);
    assert.match(e.message, /safe to retry/);
    return true;
  });
});

// ---------------------------------------------------------------- CU limit ----
//
// The priority fee is price x limit, but scheduling priority comes from the
// per-CU price alone, so an oversized limit is pure waste. Cutting too close,
// though, fails on chain with "exceeded compute units" -- and unlike an expired
// blockhash, that fee IS charged. These pin the conservatism.

const { Transaction, ComputeBudgetProgram, Keypair, PublicKey } = await import("@solana/web3.js");

const txWithLimit = (units) =>
  new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200000 }),
  );
const limitOf = (tx) => {
  const ix = tx.instructions.find(
    (i) => i.programId.equals(ComputeBudgetProgram.programId) && i.data[0] === 2,
  );
  return ix ? ix.data.readUInt32LE(1) : null;
};
const sender = () => new TxSender(cfg, {}, log, () => false);

test("retightens the SDK's 1.4M fallback limit down to real usage", () => {
  const tx = txWithLimit(1_400_000);
  const units = sender().retightenComputeLimit(tx, 250_000);

  assert.equal(units, Math.ceil(250_000 * 1.5) + 20_000);
  assert.equal(limitOf(tx), units, "instruction was actually replaced");
  assert.ok(units > 250_000, "keeps headroom above simulated usage");
  assert.ok(units < 1_400_000 / 3, "and is a large saving");
});

test("leaves a proportionate limit alone", () => {
  const tx = txWithLimit(600_000);
  assert.equal(sender().retightenComputeLimit(tx, 400_000), null, "1.5x is not disproportionate");
  assert.equal(limitOf(tx), 600_000, "untouched");
});

test("never raises a limit", () => {
  // Ratio trips (10x) but the safety floor alone would exceed the current limit.
  const tx = txWithLimit(10_000);
  const units = sender().retightenComputeLimit(tx, 1_000);
  assert.equal(units, 10_000, "clamped to the existing limit");
  assert.equal(limitOf(tx), 10_000);
});

test("does nothing without a limit instruction or a usage figure", () => {
  const bare = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200000 }),
  );
  assert.equal(sender().retightenComputeLimit(bare, 250_000), null, "no limit ix to replace");
  assert.equal(sender().retightenComputeLimit(txWithLimit(1_400_000), undefined), null);
  assert.equal(sender().retightenComputeLimit(txWithLimit(1_400_000), 0), null);
});

// Replacing an instruction invalidates the signature. If re-signing did not
// work, every retightened transaction would be rejected as malformed.
test("the transaction is still signable and serialisable after retightening", () => {
  const payer = Keypair.generate();
  const tx = txWithLimit(1_400_000);
  tx.recentBlockhash = new PublicKey(Keypair.generate().publicKey).toBase58();
  tx.feePayer = payer.publicKey;
  tx.sign(payer);
  const before = tx.serialize().length;

  assert.ok(sender().retightenComputeLimit(tx, 250_000) !== null);
  tx.sign(payer); // what send() does after retightening

  const after = tx.serialize();
  assert.ok(after.length > 0);
  assert.equal(after.length, before, "same shape, just a different limit value");
  assert.equal(limitOf(tx), Math.ceil(250_000 * 1.5) + 20_000);
});

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

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";

import { Store } from "../dist/state.js";
import { exitPosition } from "../dist/meteora/actions.js";

// Closing a position while a path-B entry is pending destroys the only thing
// resume can finish against. On the next pass getPosition throws, the entry goes
// terminal with "check balances manually", and the withdrawn surplus stays in the
// wallet with nothing tracking it.
//
// A manual rebalance, a zap out and the engine all refuse in this state. Exit --
// reachable from the UI in one click, and the one action that is irreversible --
// did not, so the guard lives in exitPosition itself: the EXIT button, a fired
// stop loss and zap out's own close leg all arrive through that one function.

const POS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const OTHER = "GKctchi3sq24RW43nTSbNuDyfhnHZG7hVe4bC298G1QC";
const POOL = "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6";

const pk = (s) => new PublicKey(s);

function harness({ pending = null } = {}) {
  const store = new Store(mkdtempSync(join(tmpdir(), "dlmm-exit-guard-")));
  store.upsertPosition({
    positionPk: POS,
    poolAddress: POOL,
    auto: true,
    openedAt: 1,
    rebalanceCount: 0,
    pollsTotal: 0,
    pollsInRange: 0,
  });
  if (pending) {
    store.openJournal({
      id: "j1",
      positionPk: pending.positionPk,
      poolAddress: POOL,
      path: "B",
      phase: pending.phase,
      targetMinBinId: -10,
      targetMaxBinId: 10,
      sourceMinBinId: -20,
      sourceMaxBinId: 0,
      strategyType: "Spot",
      startedAt: 1,
      updatedAt: 1,
      sigs: ["SIG_WITHDRAW"],
      swap: { inMint: "in", outMint: "out", inAmount: "300000000" },
    });
  }

  const sent = [];
  const removed = [];
  const pool = {
    getPosition: async () => ({ positionData: { lowerBinId: -20, upperBinId: 0 } }),
    removeLiquidity: async () => [{}],
  };

  const deps = {
    cfg: {},
    client: {
      requireWallet: () => ({ publicKey: pk(POS) }),
      assertSolFunded: async () => {},
      getPool: async () => pool,
      invalidate: () => {},
    },
    dataApi: {},
    sender: {
      sendAll: async (txs, _signers, label) => {
        sent.push(label);
        return txs.map(() => ({ label, dryRun: false, signature: "SIG_EXIT" }));
      },
    },
    store: {
      ...store,
      positions: () => store.positions(),
      position: (p) => store.position(p),
      pendingJournal: () => store.pendingJournal(),
      removePosition: (p) => {
        removed.push(p);
        store.removePosition(p);
      },
    },
    log: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
  };

  return { deps, store, sent, removed };
}

test("exiting a position with an unfinished rebalance is refused before anything is sent", async () => {
  const h = harness({ pending: { positionPk: POS, phase: "swap" } });

  await assert.rejects(
    () => exitPosition(h.deps, { poolAddress: POOL, positionPk: POS }),
    (e) => {
      assert.match(e.message, /unfinished rebalance j1 is pending at phase "swap"/);
      assert.match(e.message, /wallet/, "says where the funds are");
      return true;
    },
  );

  assert.deepEqual(h.sent, [], "nothing signed");
  assert.deepEqual(h.removed, [], "still managed, so the engine can still resume it");
  assert.equal(h.store.pendingJournal().length, 1, "the entry is left resumable");
});

test("the withdraw phase is refused too — that is where the surplus is in the wallet", async () => {
  const h = harness({ pending: { positionPk: POS, phase: "withdraw" } });
  await assert.rejects(() => exitPosition(h.deps, { poolAddress: POOL, positionPk: POS }), /unfinished rebalance/);
  assert.deepEqual(h.sent, []);
});

test("a pending entry for a DIFFERENT position does not block this one", async () => {
  const h = harness({ pending: { positionPk: OTHER, phase: "swap" } });

  const results = await exitPosition(h.deps, { poolAddress: POOL, positionPk: POS });

  assert.equal(results.length, 1);
  assert.deepEqual(h.sent, [`exit ${POS.slice(0, 6)}`]);
  assert.deepEqual(h.removed, [POS], "unmanaged, because the exit landed");
});

test("with nothing pending the exit runs exactly as before", async () => {
  const h = harness();

  const results = await exitPosition(h.deps, { poolAddress: POOL, positionPk: POS });

  assert.equal(results[0].signature, "SIG_EXIT");
  assert.deepEqual(h.removed, [POS]);
});

test("a resolved entry does not block — only pending ones do", async () => {
  const h = harness({ pending: { positionPk: POS, phase: "swap" } });
  h.store.updateJournal("j1", { phase: "done" });

  const results = await exitPosition(h.deps, { poolAddress: POOL, positionPk: POS });

  assert.equal(results[0].signature, "SIG_EXIT");
});

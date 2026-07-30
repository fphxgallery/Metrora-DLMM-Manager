import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { Keypair } from "@solana/web3.js";

import { registerWalletTokenRoutes } from "../dist/routes/wallet.js";

// The in-use guard is documented as a HARD block: a managed position's token
// accounts are the ones the rebalance path re-creates, so closing one reclaims
// rent the very next rebalance pays again. That guard is built from a per-pool
// getPool() read, and when one of those reads throws the mint set is INCOMPLETE
// -- an empty managed account then classifies as closable. Nothing else catches
// it (the "holds a balance" rule only covers funded accounts), so the close
// route must refuse the whole request rather than close what it cannot classify.

const OWNER = Keypair.generate();
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const MINT_X = Keypair.generate().publicKey.toBase58();
const MINT_Y = Keypair.generate().publicKey.toBase58();
const ATA = Keypair.generate().publicKey.toBase58();

/** Shape of one row of connection.getParsedTokenAccountsByOwner(). */
function rpcAccount({ pubkey, mint, uiAmount = 0 }) {
  return {
    pubkey: { toBase58: () => pubkey },
    account: {
      owner: { toBase58: () => TOKEN_PROGRAM },
      lamports: 2_039_280,
      data: { parsed: { info: { mint, tokenAmount: { amount: "0", decimals: 6, uiAmount } } } },
    },
  };
}

function buildApp({ poolReadFails, accounts = [rpcAccount({ pubkey: ATA, mint: MINT_X })] }) {
  const sent = [];
  const pool = {
    tokenX: { publicKey: { toBase58: () => MINT_X } },
    tokenY: { publicKey: { toBase58: () => MINT_Y } },
  };

  const ctx = {
    cfg: { apiToken: "", keypairPath: "/dev/null" },
    store: { positions: () => [{ poolAddress: "POOL1" }] },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    notifier: { notify() {} },
    dataApi: { async solPriceUsd() { return 0; } },
    client: {
      connection: {
        // Both token programs are queried; only the classic one has rows.
        async getParsedTokenAccountsByOwner(_owner, { programId }) {
          const classic = programId.toBase58() === TOKEN_PROGRAM;
          return { value: classic ? accounts : [] };
        },
      },
      wallet: () => OWNER,
      requireWallet: () => OWNER,
      async getPool() {
        if (poolReadFails) throw new Error("failed to get info about account POOL1: TypeError: fetch failed");
        return pool;
      },
    },
    sender: {
      async sendInstructions(ixs, _signers, label) {
        sent.push({ count: ixs.length, label });
        return { label, dryRun: false, signature: "SIG_CLOSE" };
      },
    },
  };

  const app = Fastify();
  registerWalletTokenRoutes(app, ctx);
  return { app, sent };
}

const close = (app) =>
  app.inject({ method: "POST", url: "/api/wallet/close-accounts", payload: { accounts: [ATA] } });

test("a failed pool read refuses the whole close request instead of closing blind", async () => {
  const { app, sent } = buildApp({ poolReadFails: true });
  const res = await close(app);

  assert.equal(res.statusCode, 503, "503 -- the guard is unavailable, not the request invalid");
  const body = res.json();
  assert.match(body.error, /in-use guard/, "says which guard could not be confirmed");
  assert.match(body.error, /nothing was closed/, "tells the operator no funds moved");
  assert.match(body.error, /retry/, "tells the operator what to do");
  assert.equal(sent.length, 0, "no transaction may be built, let alone sent");
  await app.close();
});

test("with every pool readable the same request closes normally", async () => {
  // MINT_X is a managed pool's side, so this account is in use and refused --
  // by the guard, on a COMPLETE mint set, which is the behaviour being protected.
  const { app, sent } = buildApp({ poolReadFails: false });
  const res = await close(app);

  assert.equal(res.statusCode, 400, "reaches the per-account classification, not the 503 bail-out");
  assert.deepEqual(res.json().refused, [{ pubkey: ATA, reason: "in use by a managed position" }]);
  assert.equal(sent.length, 0);
  await app.close();
});

test("an unmanaged empty account still closes when the pool reads succeed", async () => {
  // The happy path: the 503 must not fire when the mint set is complete.
  const other = Keypair.generate().publicKey.toBase58();
  const { app, sent } = buildApp({
    poolReadFails: false,
    accounts: [rpcAccount({ pubkey: other, mint: Keypair.generate().publicKey.toBase58() })],
  });

  const res = await app.inject({
    method: "POST",
    url: "/api/wallet/close-accounts",
    payload: { accounts: [other] },
  });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.closed, [other]);
  assert.equal(body.reclaimedLamports, 2_039_280);
  assert.deepEqual(sent, [{ count: 1, label: "close token accounts" }]);
  await app.close();
});

test("the same account is NOT closed when a pool read failed", async () => {
  // Same wallet, same selection, only the pool read differs -- this is the
  // defect: before the guard, the failure silently downgraded to "closable".
  const other = Keypair.generate().publicKey.toBase58();
  const { app, sent } = buildApp({
    poolReadFails: true,
    accounts: [rpcAccount({ pubkey: other, mint: Keypair.generate().publicKey.toBase58() })],
  });

  const res = await app.inject({
    method: "POST",
    url: "/api/wallet/close-accounts",
    payload: { accounts: [other] },
  });

  assert.equal(res.statusCode, 503);
  assert.equal(sent.length, 0);
  await app.close();
});

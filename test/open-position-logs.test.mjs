import test from "node:test";
import assert from "node:assert/strict";
import BN from "bn.js";
import { Keypair, PublicKey } from "@solana/web3.js";

import { openPosition } from "../dist/meteora/actions.js";
import { TxError } from "../dist/tx/send.js";

// The wide-open path (>70 bins) creates the position and deposits in two
// transactions. When the deposit leg fails, its program logs are the only place
// the real reason appears -- this is exactly where the Curve rounding
// "insufficient funds" failure lands. run() in routes/positions.ts attaches
// `logs` to the 400 response only for `instanceof TxError`, so re-wrapping the
// cause in a plain Error silently made those failures undiagnosable.
const PROGRAM_LOGS = [
  "Program log: Instruction: AddLiquidityByStrategy",
  "Program log: Error: insufficient funds",
];

function deps({ depositError }) {
  const mint = (decimals) => ({
    publicKey: Keypair.generate().publicKey,
    owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
    mint: { decimals },
  });
  const pool = {
    lbPair: { activeId: 0 },
    tokenX: mint(9),
    tokenY: mint(6),
    async createExtendedEmptyPosition() { return { instructions: [] }; },
    async addLiquidityByStrategy() { throw depositError; },
  };
  return {
    cfg: { rangeBins: 60, strategyType: "Spot", minSolBalance: 0.05 },
    client: {
      requireWallet: () => Keypair.generate(),
      async assertSolFunded() {},
      async getPool() { return pool; },
      async tokenBalance() { return new BN("1000000000000"); },
      invalidate() {},
    },
    // The create leg lands; only the deposit fails.
    sender: { async send() { return { label: "create", dryRun: false, signature: "SIG_CREATE" }; } },
    store: { upsertPosition() {} },
    log: { info() {}, warn() {}, error() {}, debug() {} },
  };
}

const open = (d) => openPosition(d, { poolAddress: "POOL1", xAmount: 1, yAmount: 0, rangeBins: 60 });

test("a failed deposit keeps the program logs for the dashboard", async () => {
  await assert.rejects(
    () => open(deps({ depositError: new TxError("deposit would fail: insufficient funds", PROGRAM_LOGS) })),
    (e) => {
      assert.ok(e instanceof TxError, "must stay a TxError or run() drops the logs");
      assert.deepEqual(e.logs, PROGRAM_LOGS, "program logs survive the re-wrap");
      // The operator-facing guidance must survive too.
      assert.match(e.message, /was created but the deposit failed/);
      assert.match(e.message, /POST \/api\/positions\/.+\/add/);
      assert.match(e.message, /insufficient funds/, "underlying reason retained");
      return true;
    },
  );
});

test("a non-TxError cause still produces a plain Error", async () => {
  await assert.rejects(
    () => open(deps({ depositError: new Error("connection reset") })),
    (e) => {
      assert.ok(!(e instanceof TxError), "nothing to attach, so no false TxError");
      assert.match(e.message, /connection reset/);
      assert.match(e.message, /was created but the deposit failed/);
      return true;
    },
  );
});

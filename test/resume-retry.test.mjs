import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Store } from "../dist/state.js";
import { resumeJournal } from "../dist/meteora/rebalance.js";

// resumeJournal now runs from the engine tick, not only at boot. Without an age
// filter a permanently stuck entry -- a route whose price impact stays above the
// guard, say -- would be retried every 30s forever.
function harness(updatedAt) {
  const store = new Store(mkdtempSync(join(tmpdir(), "dlmm-resume-")));
  store.openJournal({
    id: "j1", positionPk: "POS1", poolAddress: "POOL1", path: "B", phase: "swap",
    targetMinBinId: -10, targetMaxBinId: 10, sourceMinBinId: -20, sourceMaxBinId: 0,
    strategyType: "Curve", startedAt: updatedAt, updatedAt, sigs: ["SIG"],
    swap: { inMint: "IN", outMint: "OUT", inAmount: "1" },
  });
  // updatedAt is stamped by updateJournal, so set it directly for the test.
  store.journalEntry("j1").updatedAt = updatedAt;

  const seen = [];
  const deps = {
    store,
    // No wallet: resumeJournal announces, then logs and skips per entry. Whether
    // the announcement happens at all is what reveals the age filter's decision.
    client: { wallet: () => null },
    log: {
      info: () => {},
      debug: () => {},
      warn: (_obj, msg) => seen.push(msg),
      error: (_obj, msg) => seen.push(msg),
    },
  };
  return { deps, seen };
}

test("a tick skips an entry touched more recently than the retry interval", async () => {
  const { deps, seen } = harness(Date.now()); // just updated
  await resumeJournal(deps, { minAgeMs: 120_000 });
  assert.deepEqual(seen, [], "no resume attempt, not even the announcement");
});

test("a tick retries an entry once it has gone stale", async () => {
  const { deps, seen } = harness(Date.now() - 200_000);
  await resumeJournal(deps, { minAgeMs: 120_000 });
  assert.ok(seen.includes("resuming unfinished rebalances"), "picked the entry up");
});

test("boot resumes everything regardless of age", async () => {
  const { deps, seen } = harness(Date.now());
  await resumeJournal(deps); // no opts -- what index.ts does
  assert.ok(seen.includes("resuming unfinished rebalances"));
});

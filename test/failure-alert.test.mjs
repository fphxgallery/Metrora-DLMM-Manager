import test from "node:test";
import assert from "node:assert/strict";

import { rebalanceFailureHtml, rebalanceRecoveredHtml } from "../dist/alerts.js";
import { decodeTxError, fundsAt, legOf } from "../dist/errors.js";

/**
 * The failure alert, and the recovery alert that answers it.
 *
 * What this replaces arrived on 2026-08-07 at 21:11:58 UTC, in full:
 *
 *   ⚠️ Rebalance FAILED for BUTTHOLE-SOL: rebalance (deposit leg) failed on
 *   chain: {"InstructionError":[5,{"Custom":6004}]}
 *
 * Nothing in that says what 6004 means, that ~$37 was sitting loose in the
 * wallet at the time, or that it would be retried in two minutes. It recovered
 * at 21:14:21 and said nothing about that either -- which is the reason a real
 * strand went unnoticed for days: every FAILED looked identical and permanent.
 */

const CFG = { maxActiveBinSlippage: 15 };
const REAL = 'rebalance (deposit leg) failed on chain: {"InstructionError":[5,{"Custom":6004}]}';

const block = (html) => html.match(/<code>([\s\S]*?)<\/code>/)[1];

function fail(over = {}) {
  return rebalanceFailureHtml({
    pairName: "BUTTHOLE-SOL",
    phase: "deposit",
    error: REAL,
    journalId: "271b2cda-c910-48cd-af00-3ab6e3082c00",
    strandedUsd: 36.72,
    cfg: CFG,
    retryEveryMs: 120_000,
    ...over,
  });
}

// ---- decoding ---------------------------------------------------------------

test("6004 decodes to the name in the DLMM program's own IDL", () => {
  const d = decodeTxError(REAL, CFG);
  assert.equal(d.code, 6004);
  assert.equal(d.name, "ExceededBinSlippageTolerance");
  assert.match(d.cause, /active bin moved more than 15 bins/);
});

test("a swap's code is NOT read against the DLMM table", () => {
  /**
   * The trap this gate exists for. Jupiter's 6001 is a slippage failure; the
   * DLMM program's 6001 is `InvalidBinId`. Decoding one against the other gives
   * a confident wrong answer, which is worse than the raw number -- it sends the
   * operator to check the wrong thing entirely.
   */
  const d = decodeTxError('swap BUTTHOLE->SOL failed on chain: {"InstructionError":[5,{"Custom":6001}]}', CFG);

  assert.equal(d.code, 6001, "the number is still reported");
  assert.equal(d.name, null, "but never named against the wrong program's table");
  assert.equal(d.cause, null);
});

test("the same code IS named when a DLMM transaction threw it", () => {
  const d = decodeTxError('rebalance (withdraw leg) failed on chain: {"InstructionError":[2,{"Custom":6001}]}', CFG);
  assert.equal(d.name, "InvalidBinId");
});

test("the slippage figure comes from config, not a hardcoded 15", () => {
  const d = decodeTxError(REAL, { maxActiveBinSlippage: 40 });
  assert.match(d.cause, /more than 40 bins/);
});

test("an error with no custom code decodes to nothing rather than guessing", () => {
  assert.equal(decodeTxError("rebalance (deposit leg) would fail: Program log: insufficient funds", CFG), null);
});

test("a code with no IDL entry keeps the number and drops the name", () => {
  const d = decodeTxError('rebalance (deposit leg) failed on chain: {"InstructionError":[5,{"Custom":9999}]}', CFG);
  assert.equal(d.code, 9999);
  assert.equal(d.name, null);
});

// ---- where the money is -----------------------------------------------------

test("the phase says whether anything is out of the position", () => {
  // The single most useful line in the alert, and the one the error text cannot
  // supply: a path-B rebalance dismantles the position before rebuilding it.
  assert.equal(fundsAt("withdraw").held, false, "the withdraw failed, so nothing left");
  assert.equal(fundsAt("atomic").held, false, "path A is one transaction — it either happened or it did not");
  assert.equal(fundsAt("swap").held, true);
  assert.equal(fundsAt("deposit").held, true);
});

test("an unknown phase admits it rather than claiming the funds are safe", () => {
  const f = fundsAt(undefined);
  assert.equal(f.held, false);
  assert.match(f.where, /unknown/, "silently reporting 'intact' would be a lie with money behind it");
});

test("legs are numbered so the alert says how far it got", () => {
  assert.deepEqual(legOf("deposit"), { name: "deposit", step: "3 of 3" });
  assert.deepEqual(legOf("withdraw"), { name: "withdraw", step: "1 of 3" });
  assert.equal(legOf("done"), null);
});

// ---- the failure alert ------------------------------------------------------

test("the alert answers all three questions the old one did not", () => {
  const rows = block(fail());

  assert.match(rows, /leg\s+deposit\s+3 of 3/, "how far it got");
  assert.match(rows, /code\s+6004\s+ExceededBinSlippageTolerance/, "what the code means");
  assert.match(rows, /cause\s+the active bin moved more than 15/, "why");
  assert.match(rows, /funds\s+~\$36\.72\s+in the WALLET/, "where the money is");
  assert.match(rows, /retry\s+automatic\s+~2 min/, "whether anything happens next");
  assert.match(rows, /entry\s+271b2cda/, "what to look up");
});

test("the raw JSON is gone from the body", () => {
  // It was the entire message before. The code row carries the number now.
  assert.ok(!fail().includes("InstructionError"), "the unreadable part is what this replaces");
});

test("an undecodable error falls back to the message, not to silence", () => {
  const rows = block(fail({ error: "rebalance (deposit leg) would fail: Program log: Error: insufficient funds" }));

  assert.match(rows, /cause\s+rebalance \(deposit leg\) would/);
  assert.ok(!rows.includes("code "), "no code row when there is no code");
});

test("a failure before anything moved does not claim funds are in the wallet", () => {
  const rows = block(fail({ phase: "withdraw", strandedUsd: 36.72 }));

  assert.match(rows, /funds\s+—\s+untouched — the position is intact/);
  assert.ok(!rows.includes("$36.72"), "a figure here would read as money at risk when none is");
});

test("a pair name containing markup cannot break the message", () => {
  // Same rule as the success alert: pair names come from token metadata.
  const html = fail({ pairName: '<b>PWN</b> & "co"' });
  assert.ok(!html.includes("<b>PWN</b>"));
  const tags = [...html.matchAll(/<\/?([a-z]+)>/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(tags)].sort(), ["b", "code"]);
});

test("the columns line up", () => {
  const rows = block(fail())
    .split("\n")
    .filter((r) => /^(leg|code|funds|retry|entry)/.test(r));

  for (const r of rows) {
    assert.equal(r[8], " ", `label column not padded to 9 in "${r}"`);
    assert.notEqual(r[9], " ", `value column does not start at offset 9 in "${r}"`);
  }
  // The wide column exists because "automatic" and "0.5086 SOL" collided with
  // the success alert's 9-wide one instead of aligning beside it.
  for (const r of rows.filter((r) => /^(leg|code|funds|retry)/.test(r))) {
    assert.equal(r[21], " ", `first value not padded to 13 in "${r}"`);
    assert.notEqual(r[22], " ", `second column does not start at offset 22 in "${r}"`);
  }
});

test("a long cause wraps instead of running off a phone screen", () => {
  const lines = block(fail()).split("\n");
  for (const l of lines) assert.ok(l.length <= 50, `line too long to read on a phone: "${l}"`);

  const cause = lines.filter((l) => l.startsWith("cause") || /^ {9}\S/.test(l));
  assert.ok(cause.length > 1, "the 15-bin explanation is longer than one row");
});

// ---- the recovery alert -----------------------------------------------------

function recovered(over = {}) {
  return rebalanceRecoveredHtml({
    pairName: "BUTTHOLE-SOL",
    journalId: "271b2cda-c910-48cd-af00-3ab6e3082c00",
    attempt: 1,
    failedAt: 1_000_000,
    range: [-1004, -936],
    costLamports: 15_077,
    solPriceUsd: 74.02,
    now: 1_000_000 + 143_000,
    ...over,
  });
}

test("the recovery reports the real gap, seconds included", () => {
  // 2m23s is the actual figure from the live event. Rounded to "2m" it stops
  // saying whether this was the first scheduled retry or the fourth.
  assert.match(block(recovered()), /retry\s+#1\s+after 2m23s/);
});

test("the recovery says what landed, where, and what it cost", () => {
  const rows = block(recovered());
  assert.match(rows, /outcome\s+deposit landed/);
  assert.match(rows, /range\s+-1004 — -936/);
  assert.match(rows, /cost\s+\$0\.001\s+all legs/);
  assert.match(rows, /entry\s+271b2cda/);
});

test("a later attempt is numbered, so a struggling entry is visible", () => {
  assert.match(block(recovered({ attempt: 4 })), /retry\s+#4/);
});

test("without a SOL price the cost is still reported, in SOL", () => {
  // Degrading to nothing would hide the one figure that says what the retry cost.
  assert.match(block(recovered({ solPriceUsd: null })), /cost\s+0\.000015 SOL/);
});

test("an entry with no recorded failure time omits the gap rather than inventing one", () => {
  const rows = block(recovered({ failedAt: null }));
  assert.match(rows, /retry\s+#1/);
  assert.ok(!/after/.test(rows), "a gap measured from an unknown start is not a gap");
});

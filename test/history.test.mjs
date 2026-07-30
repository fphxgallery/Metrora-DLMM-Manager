import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SampleLog, aggregateByTs, downsample } from "../dist/history.js";

const dir = () => mkdtempSync(join(tmpdir(), "dlmm-hist-"));
const s = (ts, positionPk, feesUsd, pnlUsd = 0) => ({ ts, positionPk, feesUsd, pnlUsd });

test("appends and reads back in timestamp order", () => {
  const log = new SampleLog(dir());
  log.append([s(3000, "A", 3), s(1000, "A", 1)]);
  log.append([s(2000, "A", 2)]);
  assert.deepEqual(log.read().map((r) => r.ts), [1000, 2000, 3000]);
});

test("read(since) excludes anything older than the window", () => {
  const log = new SampleLog(dir());
  log.append([s(1000, "A", 1), s(5000, "A", 5), s(9000, "A", 9)]);
  assert.deepEqual(log.read(5000).map((r) => r.ts), [5000, 9000]);
});

test("a truncated final line does not lose the rest of the log", () => {
  // The process can die mid-append. That must cost one sample, not the file.
  const d = dir();
  const file = join(d, "samples.jsonl");
  writeFileSync(file, `${JSON.stringify(s(1000, "A", 1))}\n${JSON.stringify(s(2000, "A", 2))}\n{"ts":3000,"posi`);
  const log = new SampleLog(d);
  assert.deepEqual(log.read().map((r) => r.ts), [1000, 2000]);
});

test("an absent log reads as empty rather than throwing", () => {
  const log = new SampleLog(dir());
  assert.deepEqual(log.read(), []);
  assert.equal(log.earliest(), undefined);
});

test("prune drops rows past retention and rewrites the file", () => {
  const d = dir();
  const log = new SampleLog(d);
  const now = Date.now();
  log.append([s(now - 100 * 86_400_000, "A", 1), s(now - 1000, "A", 2)]);
  const dropped = log.prune(90 * 86_400_000);
  assert.equal(dropped, 1);
  assert.deepEqual(log.read().map((r) => r.feesUsd), [2]);
  // Rewritten, not just filtered in memory.
  assert.equal(readFileSync(join(d, "samples.jsonl"), "utf8").trim().split("\n").length, 1);
});

test("prune is a no-op when everything is inside retention", () => {
  const log = new SampleLog(dir());
  log.append([s(Date.now() - 1000, "A", 1)]);
  assert.equal(log.prune(90 * 86_400_000), 0);
});

test("appending nothing does not create a file", () => {
  const d = dir();
  new SampleLog(d).append([]);
  assert.equal(existsSync(join(d, "samples.jsonl")), false);
});

test("the read cache is invalidated by an append", () => {
  const log = new SampleLog(dir());
  log.append([s(1000, "A", 1)]);
  assert.equal(log.read().length, 1);
  log.append([s(2000, "A", 2)]);
  assert.equal(log.read().length, 2, "second append must not be served from the first read's cache");
});

// ---- aggregation -----------------------------------------------------------

test("positions sampled at the same instant are summed into one point", () => {
  const rows = [s(1000, "A", 2), s(1000, "B", 3), s(2000, "A", 4), s(2000, "B", 5)];
  assert.deepEqual(aggregateByTs(rows, (r) => r.feesUsd), [
    { ts: 1000, usd: 5 },
    { ts: 2000, usd: 9 },
  ]);
});

test("aggregation sorts by time even when the log does not", () => {
  const rows = [s(9000, "A", 9), s(1000, "A", 1)];
  assert.deepEqual(aggregateByTs(rows, (r) => r.feesUsd).map((p) => p.ts), [1000, 9000]);
});

// ---- downsampling ----------------------------------------------------------

test("a series shorter than the cap is returned untouched", () => {
  const pts = [{ ts: 1, usd: 1 }, { ts: 2, usd: 2 }];
  assert.equal(downsample(pts, 100), pts);
});

test("downsampling keeps the LAST reading in each bucket", () => {
  // These are cumulative totals, so averaging or taking the first reading would
  // drag every plotted point below the true running total.
  const pts = Array.from({ length: 100 }, (_, i) => ({ ts: i * 1000, usd: i }));
  const out = downsample(pts, 10);
  assert.ok(out.length <= 12, `expected ~10 points, got ${out.length}`);
  assert.equal(out[out.length - 1].usd, 99, "the final point survives");
  // Monotonic in, monotonic out.
  for (let i = 1; i < out.length; i++) assert.ok(out[i].usd >= out[i - 1].usd);
});

test("downsampling never drops the newest point", () => {
  const pts = Array.from({ length: 8_640 }, (_, i) => ({ ts: i * 900_000, usd: i * 0.01 }));
  const out = downsample(pts, 320);
  assert.equal(out[out.length - 1].ts, pts[pts.length - 1].ts);
  assert.ok(out.length <= 322);
});

test("identical timestamps cannot make downsampling divide by zero", () => {
  const pts = Array.from({ length: 50 }, () => ({ ts: 5000, usd: 1 }));
  const out = downsample(pts, 10);
  assert.equal(out.length, 10);
});

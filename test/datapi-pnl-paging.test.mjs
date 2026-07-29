import test from "node:test";
import assert from "node:assert/strict";

import { DataApi } from "../dist/meteora/datapi.js";

const log = { info(){}, warn(){}, error(){}, debug(){} };
const cfg = { dataApiUrl: "https://example.invalid", dataApiCacheMs: 0 };

/** Serves canned pages and records which page numbers were asked for. */
function stubFetch(pages) {
  const asked = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const page = Number(new URL(url).searchParams.get("page"));
    asked.push(page);
    const body = pages[page - 1] ?? { positions: [], hasNext: false };
    return { ok: true, async json() { return body; } };
  };
  return { asked, restore: () => { globalThis.fetch = original; } };
}

const pos = (id) => ({ positionAddress: id });

test("stops after a single page when hasNext is false", async () => {
  const f = stubFetch([{ positions: [pos("A"), pos("B")], hasNext: false }]);
  try {
    const out = await new DataApi(cfg, log).positionPnl("POOL", "USER");
    assert.deepEqual(out.map((p) => p.positionAddress), ["A", "B"]);
    assert.deepEqual(f.asked, [1], "no needless second request");
  } finally { f.restore(); }
});

// A wallet with >100 positions in one pool used to lose everything past the
// first page -- and a missing entry reads as "not indexed yet", which is
// indistinguishable from truncation.
test("follows hasNext across pages and concatenates", async () => {
  const f = stubFetch([
    { positions: [pos("A")], hasNext: true },
    { positions: [pos("B")], hasNext: true },
    { positions: [pos("C")], hasNext: false },
  ]);
  try {
    const out = await new DataApi(cfg, log).positionPnl("POOL", "USER");
    assert.deepEqual(out.map((p) => p.positionAddress), ["A", "B", "C"]);
    assert.deepEqual(f.asked, [1, 2, 3]);
  } finally { f.restore(); }
});

test("caps paging so a stuck hasNext cannot loop forever", async () => {
  // Every page claims there is another one.
  const f = stubFetch(Array.from({ length: 50 }, (_, i) => ({ positions: [pos(`P${i}`)], hasNext: true })));
  try {
    const out = await new DataApi(cfg, log).positionPnl("POOL", "USER");
    assert.equal(f.asked.length, 10, "stopped at MAX_PNL_PAGES");
    assert.equal(out.length, 10);
  } finally { f.restore(); }
});

test("stops on an empty page even if hasNext stays true", async () => {
  const f = stubFetch([
    { positions: [pos("A")], hasNext: true },
    { positions: [], hasNext: true },
  ]);
  try {
    const out = await new DataApi(cfg, log).positionPnl("POOL", "USER");
    assert.deepEqual(out.map((p) => p.positionAddress), ["A"]);
    assert.deepEqual(f.asked, [1, 2], "did not keep asking past the empty page");
  } finally { f.restore(); }
});

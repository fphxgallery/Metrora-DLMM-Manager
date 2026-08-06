import test from "node:test";
import assert from "node:assert/strict";

import { searchTokens, fetchTokenMeta, buildTokenView } from "../dist/wallet/tokens.js";

// The buy-side picker's data source. Two things matter here and they pull in
// opposite directions: the row has to be recognisable at a glance (icon,
// symbol), and it must never let that recognisability stand in for identity.
// Jupiter's search is fuzzy, symbols are not unique, and a counterfeit mint can
// serve a perfectly convincing logo — so every field the UI trusts for identity
// comes through separately and unmodified.

const REAL_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const FAKE_USDC = "4aFxAf9DxyPvDiCsLU1qzTv7uhKmVbCJgUcnJVpFbSNz";

function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = original;
  };
}

const json = (rows) => async () => ({ ok: true, json: async () => rows });

test("a token's icon comes through for the picker", async () => {
  const restore = stubFetch(
    json([{ id: REAL_USDC, symbol: "USDC", name: "USD Coin", decimals: 6, usdPrice: 0.9995, icon: "https://img/usdc.png", isVerified: true }]),
  );
  try {
    const [t] = await searchTokens("usdc");
    assert.equal(t.icon, "https://img/usdc.png");
    assert.equal(t.symbol, "USDC");
    assert.equal(t.decimals, 6);
    assert.equal(t.verified, true);
  } finally {
    restore();
  }
});

test("a mint with no icon reports null rather than an empty string", async () => {
  // The UI branches on null to draw initials. An empty string is truthy enough
  // in the wrong hands to render a broken image where a disc belongs.
  const restore = stubFetch(json([{ id: FAKE_USDC, symbol: "ONyc", decimals: 6 }]));
  try {
    const [t] = await searchTokens("onyc");
    assert.equal(t.icon, null);
  } finally {
    restore();
  }
});

test("a non-string icon is rejected rather than passed to an img tag", async () => {
  const restore = stubFetch(json([{ id: REAL_USDC, symbol: "USDC", icon: { url: "nope" } }]));
  try {
    const [t] = await searchTokens("usdc");
    assert.equal(t.icon, null);
  } finally {
    restore();
  }
});

test("a counterfeit keeps its own mint, symbol and unverified flag", async () => {
  // The whole reason the picker shows a mint on every row. Both of these answer
  // to "USDC"; only one is the real one, and the icon is no help at all.
  const restore = stubFetch(
    json([
      { id: REAL_USDC, symbol: "USDC", name: "USD Coin", usdPrice: 0.9995, icon: "https://img/usdc.png", isVerified: true },
      { id: FAKE_USDC, symbol: "USDC", name: "USD Coin", usdPrice: 2.09e-6, icon: "https://img/usdc.png", isVerified: false },
    ]),
  );
  try {
    const hits = await searchTokens("usdc");
    assert.equal(hits.length, 2);
    assert.equal(hits[0].mint, REAL_USDC);
    assert.equal(hits[1].mint, FAKE_USDC);
    assert.equal(hits[1].verified, false);
    // Same symbol, same icon — the mint and the flag are the only difference.
    assert.equal(hits[0].symbol, hits[1].symbol);
    assert.equal(hits[0].icon, hits[1].icon);
  } finally {
    restore();
  }
});

test("the results are capped so one query cannot flood the picker", async () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({ id: `mint${i}`, symbol: `T${i}` }));
  const restore = stubFetch(json(rows));
  try {
    assert.equal((await searchTokens("t")).length, 12);
    assert.equal((await searchTokens("t", 3)).length, 3);
  } finally {
    restore();
  }
});

test("a row without a mint is dropped — it could never be swapped into", async () => {
  const restore = stubFetch(json([{ symbol: "GHOST" }, { id: REAL_USDC, symbol: "USDC" }]));
  try {
    const hits = await searchTokens("x");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].mint, REAL_USDC);
  } finally {
    restore();
  }
});

test("a search that fails is an empty list, never a thrown picker", async () => {
  const restore = stubFetch(async () => {
    throw new Error("network down");
  });
  try {
    assert.deepEqual(await searchTokens("usdc"), []);
  } finally {
    restore();
  }
});

test("a non-200 from Jupiter is also an empty list", async () => {
  const restore = stubFetch(async () => ({ ok: false, status: 429, json: async () => [] }));
  try {
    assert.deepEqual(await searchTokens("usdc"), []);
  } finally {
    restore();
  }
});

test("the wallet listing carries icons too, keyed by mint", async () => {
  const restore = stubFetch(json([{ id: REAL_USDC, symbol: "USDC", usdPrice: 1, decimals: 6, icon: "https://img/usdc.png" }]));
  try {
    const meta = await fetchTokenMeta([REAL_USDC]);
    const view = buildTokenView(
      { pubkey: "ata", mint: REAL_USDC, programId: "Tokenkeg", amountRaw: "5000000", decimals: 6, uiAmount: 5, rentLamports: 2039280 },
      meta.get(REAL_USDC),
      new Set(),
    );

    assert.equal(view.icon, "https://img/usdc.png");
    assert.equal(view.usdValue, 5);
  } finally {
    restore();
  }
});

test("an account whose mint Jupiter does not know still builds, iconless", async () => {
  const restore = stubFetch(json([]));
  try {
    const meta = await fetchTokenMeta(["8zJqmQ4f"]);
    const view = buildTokenView(
      { pubkey: "ata", mint: "8zJqmQ4f", programId: "Tokenkeg", amountRaw: "1", decimals: 0, uiAmount: 1, rentLamports: 2039280 },
      meta.get("8zJqmQ4f"),
      new Set(),
    );

    assert.equal(view.icon, null);
    assert.equal(view.symbol, null);
    assert.equal(view.usdValue, null);
  } finally {
    restore();
  }
});

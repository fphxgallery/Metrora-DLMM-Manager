import test from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

import { MeteoraClient } from "../dist/meteora/client.js";

// The ATA address depends on the token program: the program id is one of the
// derivation seeds. A Token-2022 mint derived against the legacy program gives a
// DIFFERENT address, which does not exist -- and reading a missing account does
// not error, it reads as zero.
//
// That silence cost money. CATE (Ai66LHZG9MCzg1WKdawwqduVAXpNDUuV8M3uyq5ppump) is
// Token-2022. The buffer guard read a legacy-derived address, saw $0 on every
// check, and bought another $2 of CATE before every rebalance -- 23 times, into
// the real Token-2022 account, where it accumulated as ~$48 of idle balance while
// the guard went on reporting an empty buffer.

const LEGACY = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const CATE = new PublicKey("Ai66LHZG9MCzg1WKdawwqduVAXpNDUuV8M3uyq5ppump");
const OWNER = new PublicKey("9sVHeFmj9i2tH2Mzst5wpeWZPfBSoFrSpZtTi7d5ZpWV");

/**
 * A client whose chain holds exactly one funded account: the Token-2022 ATA.
 * Anything else reads as a missing account, which is what the real RPC does.
 */
function client({ mintOwner = TOKEN_2022, funded = "2022", mintMissing = false } = {}) {
  const asked = [];
  const c = Object.create(MeteoraClient.prototype);

  const fundedAta = getAssociatedTokenAddressSync(
    CATE,
    OWNER,
    true,
    funded === "2022" ? TOKEN_2022 : LEGACY,
  );

  c.log = { debug() {}, info() {}, warn() {}, error() {} };
  c.tokenPrograms = new Map();
  c.cfg = { minSolBalance: 0.05 };
  c.wallet = () => ({ publicKey: OWNER });
  c.connection = {
    getAccountInfo: async (pk) => {
      if (pk.equals(CATE)) return mintMissing ? null : { owner: mintOwner };
      return null;
    },
    getTokenAccountBalance: async (pk) => {
      asked.push(pk.toBase58());
      if (pk.equals(fundedAta)) return { value: { amount: "2506490000" } };
      // The RPC throws for an account that does not exist. This is the whole
      // trap: the caller's catch turns it into a zero balance.
      throw new Error("could not find account");
    },
    getBalance: async () => 0,
  };

  return { c, asked, fundedAta };
}

test("a Token-2022 balance is read from the Token-2022 ATA", async () => {
  const { c, asked, fundedAta } = client();
  const raw = await c.ataBalance(CATE);

  assert.equal(raw.toString(), "2506490000", "the funded account was not found");
  assert.deepEqual(asked, [fundedAta.toBase58()]);
});

test("the legacy-derived address is never the one consulted for a Token-2022 mint", async () => {
  // Pinning the actual bug: the two addresses differ, and reading the wrong one
  // is silent.
  const legacyAta = getAssociatedTokenAddressSync(CATE, OWNER, true, LEGACY);
  const t22Ata = getAssociatedTokenAddressSync(CATE, OWNER, true, TOKEN_2022);
  assert.notEqual(legacyAta.toBase58(), t22Ata.toBase58(), "the derivation must depend on the program");

  const { c, asked } = client();
  await c.ataBalance(CATE);
  assert.ok(!asked.includes(legacyAta.toBase58()), "the legacy address was consulted");
});

test("without the fix the balance reads as zero rather than failing", async () => {
  // What the old code did, reproduced: force the legacy program as a hint and the
  // funded Token-2022 account becomes invisible. No throw, no warning, just $0 --
  // which the buffer guard read as "empty, buy more".
  const { c } = client();
  const raw = await c.ataBalance(CATE, LEGACY);

  assert.equal(raw.toString(), "0");
});

test("an explicit program id is trusted and no lookup is made", async () => {
  // Every other balance read in the app already knows its program from the pool
  // object. Those must not pay for an extra getAccountInfo.
  let lookups = 0;
  const { c } = client();
  const inner = c.connection.getAccountInfo;
  c.connection.getAccountInfo = async (pk) => {
    lookups += 1;
    return inner(pk);
  };

  await c.ataBalance(CATE, TOKEN_2022);
  assert.equal(lookups, 0, "a caller that supplied the program was made to look it up anyway");
});

test("a legacy mint still resolves to the legacy ATA", async () => {
  const { c, asked, fundedAta } = client({ mintOwner: LEGACY, funded: "legacy" });
  const raw = await c.ataBalance(CATE);

  assert.equal(raw.toString(), "2506490000");
  assert.deepEqual(asked, [fundedAta.toBase58()]);
});

test("the program is looked up once and cached", async () => {
  // A mint's owner cannot change, and this sits on the path that signs.
  let lookups = 0;
  const { c } = client();
  const inner = c.connection.getAccountInfo;
  c.connection.getAccountInfo = async (pk) => {
    lookups += 1;
    return inner(pk);
  };

  await c.ataBalance(CATE);
  await c.ataBalance(CATE);
  await c.ataBalance(CATE);
  assert.equal(lookups, 1, `looked the mint up ${lookups} times`);
});

test("an RPC failure degrades instead of throwing on the signing path", async () => {
  const { c } = client();
  c.connection.getAccountInfo = async () => {
    throw new Error("429 too many requests");
  };

  // Falls back to the default derivation, which is the pre-fix behaviour: wrong
  // for Token-2022, but a wrong buffer figure is survivable and a throw here
  // would abort a rebalance.
  const raw = await c.ataBalance(CATE);
  assert.equal(raw.toString(), "0");
});

test("a mint the RPC does not know is not cached as a guess", async () => {
  const { c } = client({ mintMissing: true });
  await c.ataBalance(CATE);
  assert.equal(c.tokenPrograms.size, 0, "a null lookup must not poison the cache");
});

test("tokenBalance resolves the program the same way", async () => {
  // The other reader. Its callers all pass a program today, but it derives an ATA
  // from the same seeds and would fail the same way if one ever stopped.
  const { c, asked, fundedAta } = client();
  const raw = await c.tokenBalance(CATE);

  assert.equal(raw.toString(), "2506490000");
  assert.deepEqual(asked, [fundedAta.toBase58()]);
});

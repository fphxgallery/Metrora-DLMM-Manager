import test from "node:test";
import assert from "node:assert/strict";

import { positionBins } from "../dist/meteora/positions.js";

// The liquidity-by-bin read behind the position card's dropdown. The number that
// matters is `valueInY`: bins below the active one hold only the quote token and
// bins above hold only the base token, so charting raw amounts draws a cliff at
// the active bin that is not really there. Valuing every bin in the quote token
// is what makes the distribution read as one shape -- and what made a two-bin
// deposit notch visible on JitoSOL-ONyc in the first place.

const POSITION = "F6nAhumqoKAbRYqYhjm5os4cnwHKrwE7ntg3mFipnZdn";
const POOL = "9VPnw4KgHwhRW1HnqdA6Jx56USAF3jYGrNqu7pD42D1X";

function deps({ bins, activeId = 11114, meta = { token_x: { symbol: "JitoSOL" }, token_y: { symbol: "ONyc" } }, metaThrows = false } = {}) {
  const calls = { fresh: [], pools: 0 };
  const pool = {
    lbPair: { activeId, binStep: 4 },
    tokenX: { mint: { decimals: 9 } },
    tokenY: { mint: { decimals: 9 } },
    // Pass-through, NOT a constant 1: with equal decimals this conversion is the
    // identity, so prices come out at the real ~85 for bin step 4. A mock that
    // returned 1 made `x * price + y` indistinguishable from `x + y`, and the
    // valuation test proved nothing -- mutation testing is how that surfaced.
    fromPricePerLamport: (v) => String(v),
    getPosition: async () => ({
      positionData: {
        lowerBinId: bins[0].binId,
        upperBinId: bins[bins.length - 1].binId,
        positionBinData: bins,
      },
    }),
  };
  return {
    calls,
    deps: {
      client: {
        getPool: async (_addr, opts) => {
          calls.pools += 1;
          calls.fresh.push(opts?.fresh);
          return pool;
        },
      },
      dataApi: {
        pool: async () => {
          if (metaThrows) throw new Error("data api down");
          return meta;
        },
      },
    },
  };
}

const bin = (binId, x, y) => ({ binId, positionXAmount: String(x), positionYAmount: String(y) });

test("each bin is valued in the quote token so both sides share one scale", async () => {
  // 2 base at price 1 plus 3 quote = 5 quote of value.
  const { deps: d } = deps({ bins: [bin(11113, 0, "3000000000"), bin(11115, "2000000000", 0)] });
  const out = await positionBins(d, { positionPk: POSITION, poolAddress: POOL });

  // Guard against the mock going vacuous again.
  assert.ok(out.bins[1].price > 50, `price should be realistic, got ${out.bins[1].price}`);
  assert.equal(out.bins[0].y, 3);
  assert.equal(out.bins[0].valueInY, 3);
  assert.equal(out.bins[1].x, 2);
  assert.equal(out.bins[1].valueInY, 2 * out.bins[1].price);
});

test("the notch survives the round trip", async () => {
  // The real thing, reduced: two bins holding a fraction of their neighbours.
  const { deps: d } = deps({
    bins: [bin(11120, "860200000", 0), bin(11121, "258300000", 0), bin(11122, "250300000", 0), bin(11123, "917600000", 0)],
  });
  const out = await positionBins(d, { positionPk: POSITION, poolAddress: POOL });
  const v = out.bins.map((b) => b.valueInY);

  assert.ok(v[1] < v[0] * 0.4, `bin 11121 should be far below its neighbour, got ${v[1]} vs ${v[0]}`);
  assert.ok(v[2] < v[3] * 0.4, `bin 11122 should be far below its neighbour, got ${v[2]} vs ${v[3]}`);
});

test("raw amounts are converted out of base units", async () => {
  const { deps: d } = deps({ bins: [bin(11113, 0, "1234567890")] });
  const out = await positionBins(d, { positionPk: POSITION, poolAddress: POOL });
  assert.equal(out.bins[0].y, 1.23456789);
});

test("the range and active bin are reported alongside the bins", async () => {
  const { deps: d } = deps({ bins: [bin(11086, 0, "1"), bin(11154, "1", 0)], activeId: 11114 });
  const out = await positionBins(d, { positionPk: POSITION, poolAddress: POOL });

  assert.equal(out.lowerBinId, 11086);
  assert.equal(out.upperBinId, 11154);
  assert.equal(out.activeBinId, 11114);
  assert.equal(out.binStep, 4);
});

test("pool state is read fresh — a cached active bin would mis-colour the chart", async () => {
  const { deps: d, calls } = deps({ bins: [bin(11113, 0, "1")] });
  await positionBins(d, { positionPk: POSITION, poolAddress: POOL });
  assert.deepEqual(calls.fresh, [true]);
});

test("a Data API outage costs the labels, never the shape", async () => {
  // Symbols are cosmetic. The bars are the point, so a failed metadata lookup
  // must not fail the request.
  const { deps: d } = deps({ bins: [bin(11113, 0, "5000000000")], metaThrows: true });
  const out = await positionBins(d, { positionPk: POSITION, poolAddress: POOL });

  assert.equal(out.tokenX.symbol, "X");
  assert.equal(out.tokenY.symbol, "Y");
  assert.equal(out.bins[0].valueInY, 5);
});

test("an empty bin is reported rather than dropped", async () => {
  // The chart indexes bins positionally; silently omitting the empty ones would
  // shift every bar after them and draw a range that does not exist.
  const { deps: d } = deps({ bins: [bin(11113, 0, "1000000000"), bin(11114, 0, 0), bin(11115, "1000000000", 0)] });
  const out = await positionBins(d, { positionPk: POSITION, poolAddress: POOL });

  assert.equal(out.bins.length, 3);
  assert.equal(out.bins[1].valueInY, 0);
  assert.deepEqual(out.bins.map((b) => b.binId), [11113, 11114, 11115]);
});

test("symbols come through when the Data API answers", async () => {
  const { deps: d } = deps({ bins: [bin(11113, 0, "1")] });
  const out = await positionBins(d, { positionPk: POSITION, poolAddress: POOL });
  assert.equal(out.tokenX.symbol, "JitoSOL");
  assert.equal(out.tokenY.symbol, "ONyc");
});

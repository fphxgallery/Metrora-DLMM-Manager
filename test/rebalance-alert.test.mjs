import test from "node:test";
import assert from "node:assert/strict";

import { rebalanceAlertHtml, snapshotBeforeRebalance } from "../dist/alerts.js";

// The alert is sent seconds after a rebalance lands, which is inside the two
// minutes where the indexer is known to be wrong -- so every figure in it is read
// BEFORE the rebalance runs. These pin that, the HTML escaping the monospace
// block requires, and the way each figure degrades on its own.

const NOW = 1_800_000_000_000;
const MIN = 60_000;

function plan(over = {}) {
  return {
    positionPk: "POS1",
    poolAddress: "POOL1",
    path: "A",
    strategyType: "Spot",
    activeBinId: 1700,
    currentRange: [1712, 1772],
    targetRange: [1685, 1745],
    ratioBps: 5000,
    valueInY: 0,
    valueUsd: 74.73,
    unclaimedFeesUsd: 0.9418,
    estCostUsd: 0.21,
    estCost: { txFeesLamports: 0, rentLamports: 0, swapImpactUsd: 0 },
    ...over,
  };
}

function snapshot(over = {}) {
  return {
    pnlUsd: -3.31,
    pnlPctChange: -0.37,
    lifetimeFeesUsd: 9.83,
    claimedFeesUsd: 0.9418,
    feePerDayUsd: 62.17,
    positionFeeTvlPct: 86.64,
    poolFeeTvlPct: 15.48,
    rebalanceNumber: 8,
    lastRebalanceAt: NOW - 41 * MIN,
    ...over,
  };
}

function render(over = {}, planOver = {}) {
  return rebalanceAlertHtml({
    pairName: "CATE-SOL",
    plan: plan(planOver),
    snapshot: snapshot(over),
    now: NOW,
  });
}

/**
 * The text inside the <code> span, which is where every figure lives.
 *
 * <code> rather than <pre> on purpose: Telegram renders a <pre> as a code BLOCK,
 * with a bordered panel and a "copy" header drawn around it.
 */
function block(html) {
  return html.match(/<code>([\s\S]*?)<\/code>/)[1].split("\n");
}

test("every figure the position card shows is in the alert", () => {
  const rows = block(render()).join("\n");

  assert.match(rows, /TVL\s+\$74\.73/);
  assert.match(rows, /PnL\s+-\$3\.31\s+-0\.37%/);
  assert.match(rows, /fees\s+\$0\.9418\s+≈\$62\.17\/day/);
  assert.match(rows, /fee\/TVL\s+86\.64%\s+pool 15\.48%/);
  assert.match(rows, /count\s+#8\s+last 41m/);
  assert.match(rows, /lifetime\s+\$9\.83 fees/);
});

test("the columns actually line up", () => {
  // The whole reason this variant needs parse_mode HTML is the monospace block.
  // If the values do not start at the same offset the block buys nothing.
  const rows = block(render()).filter((r) => /^(TVL|swap|cost|PnL|fees|fee\/TVL|count|lifetime)/.test(r));

  for (const r of rows) {
    assert.equal(r[8], " ", `label column not padded to 9 in "${r}"`);
    assert.notEqual(r[9], " ", `value column does not start at offset 9 in "${r}"`);
  }

  // Rows with a second column start it at 18. Those are the ones whose first
  // value is short enough for the padding to be what puts it there.
  const twoCol = rows.filter((r) => /^(PnL|fees|fee\/TVL|count)/.test(r));
  assert.equal(twoCol.length, 4);
  for (const r of twoCol) {
    assert.equal(r[17], " ", `first value column not padded to 9 in "${r}"`);
    assert.notEqual(r[18], " ", `second column does not start at offset 18 in "${r}"`);
  }
});

test("the block is not a <pre>, so Telegram draws no copy bar around it", () => {
  // A <pre> renders as a code block with its own panel and "copy" header. The
  // alert wants the monospace font and none of the furniture.
  const html = render();
  assert.ok(!html.includes("<pre>"), "a <pre> block brings back the copy bar");
  assert.match(html, /<code>[\s\S]+<\/code>/);
});

test("the range row and the reason line are gone", () => {
  const html = render();
  assert.ok(!block(html).some((r) => r.startsWith("range")), "the range row was removed");
  assert.ok(!html.includes("from the edge"), "the reason line was removed");
});

test("a pair name containing markup cannot break the message", () => {
  // Pair names come from token metadata, which anyone can set. An unescaped "<"
  // makes Telegram reject the whole alert rather than send a partial one.
  const html = rebalanceAlertHtml({
    pairName: '<b>PWN</b> & "co"',
    plan: plan(),
    snapshot: snapshot(),
    now: NOW,
  });

  assert.ok(!html.includes("<b>PWN</b>"), "the injected tag survived unescaped");
  assert.match(html, /&lt;b&gt;PWN&lt;\/b&gt; &amp; "co"/);
  // Only the tags this function emits itself may remain.
  const tags = [...html.matchAll(/<\/?([a-z]+)>/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(tags)].sort(), ["b", "code"]);
});

test("a symbol containing markup is escaped too", () => {
  const html = render({}, { swap: { fromSymbol: "<i>X", toSymbol: "SOL", valueUsd: 31.4, fromMint: "", toMint: "", xWithdrawBps: 0, yWithdrawBps: 0 } });
  assert.ok(!html.includes("<i>X"), "an unescaped symbol reached the output");
  assert.match(html, /&lt;i&gt;X→SOL/);
});

test("the swap row appears only on path B", () => {
  assert.ok(!block(render()).some((r) => r.startsWith("swap")), "path A has no swap leg to report");

  const b = block(
    render({}, { path: "B", swap: { fromSymbol: "CATE", toSymbol: "SOL", valueUsd: 31.4, fromMint: "", toMint: "", xWithdrawBps: 0, yWithdrawBps: 0 } }),
  );
  assert.ok(b.some((r) => /^swap\s+~\$31\.40 CATE→SOL/.test(r)));
});

test("TVL is read from the plan, so it survives an indexer that has nothing to say", () => {
  // The point of sourcing it from `plan.valueUsd` rather than the snapshot: it is
  // the position's own token amounts priced on chain at plan time. Every figure
  // below the divider can go null in the settle window; this one cannot.
  const rows = block(render({ pnlUsd: null, pnlPctChange: null, lifetimeFeesUsd: null, feePerDayUsd: null, positionFeeTvlPct: null, poolFeeTvlPct: null }));

  assert.match(rows.join("\n"), /TVL\s+\$74\.73/);
  assert.match(rows.join("\n"), /PnL\s+not indexed yet/, "the indexer really is dark in this case");
});

test("TVL sits above the divider, with the plan figures rather than the indexer's", () => {
  // Placement is the decision, not decoration. Above the line means "measured on
  // chain before we moved"; below means "what the Data API says". Putting it below
  // would group it with figures that can be wrong for two minutes after a
  // rebalance, and it is the denominator the fee/TVL row is a ratio of.
  const rows = block(render());
  const tvl = rows.findIndex((r) => r.startsWith("TVL"));
  const divider = rows.findIndex((r) => r.startsWith("─"));

  assert.ok(tvl >= 0, "the TVL row is missing");
  assert.ok(divider > tvl, `TVL at ${tvl} must come before the divider at ${divider}`);
  assert.equal(tvl, 0, "TVL leads the block: it is what the other figures are measured against");
});

test("an unindexed position says so rather than printing a zero", () => {
  // A zero here reads as "this position has made nothing", which is a different
  // claim from "the indexer has not caught up".
  const rows = block(render({ pnlUsd: null, pnlPctChange: null, lifetimeFeesUsd: null })).join("\n");

  assert.match(rows, /PnL\s+not indexed yet/);
  assert.ok(!/PnL\s+\$0\.00/.test(rows));
  assert.ok(!rows.includes("lifetime"), "a missing lifetime figure is omitted, not printed as $0");
});

test("each figure degrades on its own", () => {
  const rows = block(render({ feePerDayUsd: null, poolFeeTvlPct: null })).join("\n");

  assert.match(rows, /fees\s+\$0\.9418$/m, "the claimed figure survives a missing rate");
  assert.match(rows, /fee\/TVL\s+86\.64%$/m, "the position rate survives a missing pool rate");
});

test("the first rebalance says so instead of reporting a stale gap", () => {
  const rows = block(render({ rebalanceNumber: 1, lastRebalanceAt: null })).join("\n");
  assert.match(rows, /count\s+#1\s+first one/);
});

test("gaps longer than an hour are not reported in minutes", () => {
  assert.match(block(render({ lastRebalanceAt: NOW - 200 * MIN })).join("\n"), /last 3h20m/);
  assert.match(block(render({ lastRebalanceAt: NOW - 3000 * MIN })).join("\n"), /last 2d/);
});

// ---- the snapshot itself ----

function snapDeps({ pnl = null, meta = null, wallet = "WALLET" } = {}) {
  return {
    client: { wallet: () => (wallet ? { publicKey: { toBase58: () => wallet } } : null) },
    dataApi: {
      positionPnlSafe: async () => (pnl ? [pnl] : []),
      pool: async () => meta,
    },
    log: { debug() {}, info() {}, warn() {}, error() {} },
  };
}

const MANAGED = { positionPk: "POS1", poolAddress: "POOL1", rebalanceCount: 7, lastRebalanceAt: NOW - 41 * MIN };

test("the claimed-fees figure is the unclaimed balance the rebalance is about to collect", async () => {
  // Read from the PLAN, not from the chain after the fact: after the rebalance
  // this number is zero, because the rebalance claimed it.
  const s = await snapshotBeforeRebalance(snapDeps(), MANAGED, plan({ unclaimedFeesUsd: 4.82 }));
  assert.equal(s.claimedFeesUsd, 4.82);
});

test("the count is the rebalance about to run, not the one before it", async () => {
  const s = await snapshotBeforeRebalance(snapDeps(), MANAGED, plan());
  assert.equal(s.rebalanceNumber, 8, "a position with 7 completed is having its 8th");
  assert.equal(s.lastRebalanceAt, NOW - 41 * MIN, "'last' must mean the PREVIOUS rebalance");
});

test("the daily fee figure is the indexer's rate applied to the planned value", async () => {
  const s = await snapshotBeforeRebalance(
    snapDeps({ pnl: {
        positionAddress: "POS1",
        feePerTvl24h: "10",
        pnlUsd: "1",
        pnlPctChange: "99",
        allTimeDeposits: { total: { usd: "100" } },
        allTimeWithdrawals: { total: { usd: "50" } },
        allTimeFees: { total: { usd: "3" } },
      } }),
    MANAGED,
    plan({ valueUsd: 200 }),
  );

  assert.equal(s.positionFeeTvlPct, 10);
  assert.equal(s.feePerDayUsd, 20);
});

test("a Data API failure costs a line in the message, never the rebalance", async () => {
  const deps = snapDeps();
  deps.dataApi.positionPnlSafe = async () => {
    throw new Error("502 bad gateway");
  };
  deps.dataApi.pool = async () => {
    throw new Error("502 bad gateway");
  };

  const s = await snapshotBeforeRebalance(deps, MANAGED, plan());
  assert.equal(s.pnlUsd, null);
  assert.equal(s.claimedFeesUsd, 0.9418, "the plan's own figures still come through");
  assert.equal(s.rebalanceNumber, 8);
});

test("no wallet yields a snapshot rather than a throw", async () => {
  const s = await snapshotBeforeRebalance(snapDeps({ wallet: null }), MANAGED, plan());
  assert.equal(s.pnlUsd, null);
  assert.equal(s.rebalanceNumber, 8);
});

test("another position's PnL in the same pool is not picked up", async () => {
  const s = await snapshotBeforeRebalance(
    snapDeps({ pnl: { positionAddress: "SOMEONE_ELSE", pnlUsd: "999", feePerTvl24h: "50" } }),
    MANAGED,
    plan(),
  );
  assert.equal(s.pnlUsd, null);
  assert.equal(s.positionFeeTvlPct, null);
});

test("the alert reports the indexer's percentage, matching the position card", () => {
  // The card is cross-checked against Meteora's own portfolio page, and since
  // v1.11.7 the trigger reads this same field, so card, gauge and alert all show
  // one number. "the trigger reads Meteora's percentage" in
  // trigger-measure-unit.test.mjs holds the other side of that.
  return snapshotBeforeRebalance(
    snapDeps({
      pnl: {
        positionAddress: "POS1",
        feePerTvl24h: "10",
        pnlUsd: "-5",
        pnlPctChange: "-0.5",
        allTimeDeposits: { total: { usd: "1000" } },
        allTimeWithdrawals: { total: { usd: "900" } },
        allTimeFees: { total: { usd: "3" } },
      },
    }),
    MANAGED,
    plan({ valueUsd: 200 }),
  ).then((s) => {
    assert.equal(s.pnlPctChange, -0.5, `expected Meteora's figure, got ${s.pnlPctChange}`);
    // -5 over the $100 committed would be -5%. That number belongs to the
    // trigger, and must not leak into the alert.
    assert.notEqual(s.pnlPctChange, -5);
  });
});

import type { Config } from "./config.js";
import type { DataApi } from "./meteora/datapi.js";
import type { MeteoraClient } from "./meteora/client.js";
import type { Logger } from "./logger.js";
import type { ManagedPosition } from "./state.js";
import type { RebalancePlan } from "./meteora/rebalance.js";
import { decodeTxError, fundsAt, legOf } from "./errors.js";
import { positionFeeTvlPct } from "./metrics.js";
import { escapeHtml } from "./notify.js";

/**
 * The rebalance alert.
 *
 * Kept out of the engine because of one constraint that shapes everything here:
 * **the figures are read BEFORE the rebalance runs, never after.** The alert is
 * sent seconds after the transaction lands, which is inside the two-minute window
 * where the indexer is known to be wrong — the same window `INDEXER_SETTLE_MS`
 * exists for. Asking the Data API for PnL at that moment is asking it the one
 * question it is guaranteed to answer badly: on 2026-07-30 it reported -$43.56 on
 * a position actually up $1.32, having seen a withdraw leg and not its deposit.
 *
 * So every figure describes the position as it went in, and the wording says so.
 * That also makes the fee line more useful rather than less: unclaimed fees
 * immediately before are exactly what the rebalance went on to claim.
 */

export interface RebalanceSnapshot {
  pnlUsd: number | null;
  /**
   * The indexer's own percentage, matching the position card, Meteora's
   * portfolio page and — from v1.11.7 — the trigger itself. One number
   * everywhere. See the warning on `triggerMeasure` in config.ts for what that
   * costs a stop loss.
   */
  pnlPctChange: number | null;
  lifetimeFeesUsd: number | null;
  /** Unclaimed at snapshot time — i.e. what this rebalance collects on the way through. */
  claimedFeesUsd: number | null;
  feePerDayUsd: number | null;
  positionFeeTvlPct: number | null;
  poolFeeTvlPct: number | null;
  /** Which rebalance this is, counting the one about to run. */
  rebalanceNumber: number;
  lastRebalanceAt: number | null;
}

export interface SnapshotDeps {
  client: MeteoraClient;
  dataApi: DataApi;
  log: Logger;
}

/**
 * Reads what the alert needs, best effort.
 *
 * Every field degrades to null independently, and nothing here is allowed to
 * throw: this runs immediately before money moves, and a Data API hiccup must
 * cost a line in a Telegram message rather than a rebalance.
 */
export async function snapshotBeforeRebalance(
  deps: SnapshotDeps,
  managed: ManagedPosition,
  plan: RebalancePlan,
): Promise<RebalanceSnapshot> {
  const base: RebalanceSnapshot = {
    pnlUsd: null,
    pnlPctChange: null,
    lifetimeFeesUsd: null,
    claimedFeesUsd: plan.unclaimedFeesUsd,
    feePerDayUsd: null,
    positionFeeTvlPct: null,
    poolFeeTvlPct: null,
    rebalanceNumber: managed.rebalanceCount + 1,
    lastRebalanceAt: managed.lastRebalanceAt ?? null,
  };

  const wallet = deps.client.wallet()?.publicKey.toBase58();
  if (!wallet) return base;

  const [pnls, meta] = await Promise.all([
    deps.dataApi.positionPnlSafe(plan.poolAddress, wallet).catch(() => []),
    deps.dataApi.pool(plan.poolAddress).catch(() => null),
  ]);

  const pnl = pnls.find((p) => p.positionAddress === plan.positionPk) ?? null;
  const rate = positionFeeTvlPct(pnl?.feePerTvl24h);

  return {
    ...base,
    pnlUsd: pnl ? numOrNull(pnl.pnlUsd) : null,
    pnlPctChange: pnl ? numOrNull(pnl.pnlPctChange) : null,
    lifetimeFeesUsd: pnl ? numOrNull(pnl.allTimeFees?.total?.usd) : null,
    positionFeeTvlPct: rate,
    poolFeeTvlPct: meta?.fee_tvl_ratio?.["24h"] ?? null,
    // The indexer's rate is percent of value per 24h, so this is just that rate
    // applied to the value the plan already priced.
    feePerDayUsd: rate !== null && plan.valueUsd > 0 ? (plan.valueUsd * rate) / 100 : null,
  };
}

/**
 * Renders the alert as Telegram HTML.
 *
 * The body is one `<pre>` block because the columns only line up in a monospace
 * font — Telegram's default is proportional, and the same text without the block
 * arrives ragged on a phone. Everything interpolated is escaped: pair names come
 * from token metadata, which anyone can set.
 */
export function rebalanceAlertHtml(args: {
  pairName: string;
  plan: RebalancePlan;
  snapshot: RebalanceSnapshot;
  now?: number;
}): string {
  const { pairName, plan, snapshot } = args;
  const now = args.now ?? Date.now();
  const rows: string[] = [];

  /**
   * What the position was worth going in.
   *
   * Above the divider with the other plan figures, not below it with the indexer's,
   * because that is where it comes from: `valueUsd` is the position's own token
   * amounts priced at plan time, computed on chain. It owes the Data API nothing,
   * so it is the one figure here that cannot be wrong in the settle window — and it
   * is the denominator `fee/TVL` and the `≈$/day` estimate are both ratios of.
   */
  rows.push(row("TVL", `$${plan.valueUsd.toFixed(2)}`));

  if (plan.swap) {
    rows.push(row("swap", `~$${plan.swap.valueUsd.toFixed(2)} ${plan.swap.fromSymbol}→${plan.swap.toSymbol}`));
  }
  /**
   * Labelled as an estimate, because that is what it is: a pre-flight guess made
   * before anything was sent, whose swap term assumes ONE hop at the pool's own
   * fee tier. A rebalance read back off chain went across three unrelated pools,
   * so the model does not describe the trade it is pricing. The realized figure
   * lands in the METRICS ledger once the swap has actually run.
   */
  rows.push(row("est. cost", `~$${plan.estCostUsd.toFixed(2)}`));
  rows.push("─".repeat(29));

  rows.push(
    snapshot.pnlUsd == null
      ? row("PnL", "not indexed yet")
      : row("PnL", usd(snapshot.pnlUsd), snapshot.pnlPctChange == null ? "" : pct(snapshot.pnlPctChange)),
  );
  rows.push(
    row(
      "fees",
      snapshot.claimedFeesUsd === null ? "—" : `$${snapshot.claimedFeesUsd.toFixed(4)}`,
      snapshot.feePerDayUsd === null ? "" : `≈$${snapshot.feePerDayUsd.toFixed(2)}/day`,
    ),
  );
  rows.push(
    row(
      "fee/TVL",
      snapshot.positionFeeTvlPct === null ? "—" : `${snapshot.positionFeeTvlPct.toFixed(2)}%`,
      snapshot.poolFeeTvlPct === null ? "" : `pool ${snapshot.poolFeeTvlPct.toFixed(2)}%`,
    ),
  );
  rows.push(
    row(
      "count",
      `#${snapshot.rebalanceNumber}`,
      snapshot.lastRebalanceAt === null ? "first one" : `last ${ago(now - snapshot.lastRebalanceAt)}`,
    ),
  );

  if (snapshot.lifetimeFeesUsd !== null) {
    rows.push(row("lifetime", `$${snapshot.lifetimeFeesUsd.toFixed(2)} fees`));
  }

  // <code>, deliberately not <pre>. Both render monospace, but Telegram treats a
  // <pre> as a code BLOCK and draws its own chrome around it — a bordered panel
  // with a "copy" header. <code> is the same font without the furniture.
  return `🔄 <b>Rebalanced ${escapeHtml(pairName)}</b>\n<code>${escapeHtml(rows.join("\n"))}</code>`;
}

/**
 * The rebalance FAILED alert.
 *
 * What it replaces, in full:
 *
 *   ⚠️ Rebalance FAILED for BUTTHOLE-SOL: rebalance (deposit leg) failed on
 *   chain: {"InstructionError":[5,{"Custom":6004}]}
 *
 * Three things an operator needs from that and could not get: what the code
 * means, whether any money is currently out of the position, and whether
 * anything is going to be done about it. All three are already known here.
 *
 * The funds line is the important one. A path-B rebalance takes the position
 * apart before putting it back, so "failed" spans everything from "nothing
 * moved" to "the whole position is loose tokens in the wallet", and the error
 * text cannot tell them apart. The phase can.
 */
export function rebalanceFailureHtml(args: {
  pairName: string;
  /** The journal phase execution stopped at — where the money is. */
  phase: string | undefined;
  error: string;
  journalId: string;
  /** USD value of the swap leg, when there was one. Null when unknown. */
  strandedUsd: number | null;
  cfg: Pick<Config, "maxActiveBinSlippage">;
  retryEveryMs: number;
}): string {
  const { pairName, phase, error, journalId, strandedUsd } = args;
  const decoded = decodeTxError(error, args.cfg);
  const leg = legOf(phase);
  const funds = fundsAt(phase);
  const rows: string[] = [];

  if (leg) rows.push(wideRow("leg", leg.name, leg.step));
  if (decoded) {
    /**
     * "from the swap route", not "not a DLMM error". 6001 IS a real error — it
     * just came from Jupiter, and the gate declines to name another program's
     * code rather than guessing at it. Saying what it is beats saying what it
     * is not.
     */
    rows.push(wideRow("code", String(decoded.code), decoded.name ?? "from the swap route"));
  }
  rows.push("─".repeat(33));

  /**
   * The decoded cause when there is one, otherwise the raw message. Never both,
   * and never a decode the gate was not confident about: a plausible-looking
   * wrong explanation costs more than no explanation, because it sends the
   * operator to check the wrong thing.
   *
   * Omitted entirely when neither survives. Stripping the JSON off "swap
   * CATE->SOL failed on chain: {...}" leaves the sentence dangling at "failed on
   * chain:", and a `cause` row with no cause in it is worse than no row — it
   * reads as though the explanation went missing.
   */
  const cause = decoded?.cause ?? firstLine(error);
  if (cause !== null) {
    for (const line of wrap(cause, CAUSE_W)) {
      rows.push(wideRow(rows.some((r) => r.startsWith("cause")) ? "" : "cause", line));
    }
  }

  rows.push(
    wideRow("funds", strandedUsd !== null && funds.held ? `~$${strandedUsd.toFixed(2)}` : "—", funds.where),
  );
  rows.push(wideRow("retry", "automatic", `~${Math.round(args.retryEveryMs / 60_000)} min`));
  rows.push(wideRow("entry", journalId.slice(0, 8)));

  return `⚠️ <b>Rebalance FAILED ${escapeHtml(pairName)}</b>\n<code>${escapeHtml(rows.join("\n"))}</code>`;
}

/**
 * The recovery alert, sent when a resume finishes an interrupted rebalance.
 *
 * Nothing was sent for this before: a failure alerted, and the recovery two
 * minutes later was a log line nobody was watching. That taught the wrong
 * lesson — every FAILED looked permanent, so the one that actually WAS
 * permanent (0.39 SOL, 2026-08-07) looked like all the others.
 */
export function rebalanceRecoveredHtml(args: {
  pairName: string;
  journalId: string;
  attempt: number;
  /** When the entry first failed, so this can say how long the funds were out. */
  failedAt: number | null;
  range: [number, number];
  costLamports: number;
  solPriceUsd: number | null;
  now?: number;
}): string {
  const now = args.now ?? Date.now();
  const costSol = args.costLamports / 1_000_000_000;
  const rows = [
    wideRow("retry", `#${args.attempt}`, args.failedAt === null ? "" : `after ${precisely(now - args.failedAt)}`),
    wideRow("outcome", "deposit landed"),
    wideRow("range", `${args.range[0]} — ${args.range[1]}`),
    wideRow(
      "cost",
      args.solPriceUsd ? `$${(costSol * args.solPriceUsd).toFixed(3)}` : `${costSol.toFixed(6)} SOL`,
      "all legs",
    ),
    wideRow("entry", args.journalId.slice(0, 8)),
  ];

  return `✅ <b>Recovered ${escapeHtml(args.pairName)}</b>\n<code>${escapeHtml(rows.join("\n"))}</code>`;
}

/**
 * The readable part of an error message, or null when there is none.
 *
 * Three things get cut, all of them because another row already says it:
 *
 *   - the trailing `{"InstructionError":...}` — the `code` row's whole job
 *   - "Nothing was sent; the withdrawn funds are in the wallet..." — the `funds` row
 *   - "...retried automatically" — the `retry` row
 *
 * What is left of "swap CATE->SOL failed on chain: {...}" after the first cut is
 * "swap CATE->SOL failed on chain:", which is a label and a colon and no
 * information. Returning it produced a `cause` row that looked like the
 * explanation had gone missing, so a message that reduces to nothing returns
 * null and the row is dropped instead.
 */
function firstLine(error: string): string | null {
  const trimmed = error
    .replace(/\s*\{"InstructionError".*$/, "")
    .replace(/\s*[—-]?\s*Nothing was sent;.*$/i, "")
    .replace(/\s*(and\s+)?this rebalance is retried automatically\.?\s*$/i, "")
    .trim();

  // A label with nothing after it: "swap X->Y failed on chain:", "... would fail:".
  if (trimmed === "" || /(failed on chain|would fail)\s*:?$/i.test(trimmed)) return null;
  return trimmed;
}

/**
 * How wide the wrapped cause runs. Matches the divider, so the explanation fills
 * the block rather than stacking into a narrow column beside it.
 */
const CAUSE_W = 33;

/** Greedy wrap. The block is monospace, so a long line would force sideways scrolling. */
function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line === "") line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line !== "") out.push(line);
  return out.length > 0 ? out : [""];
}

const LABEL_W = 9;
const COL_W = 9;

/** One monospace row: label, first column, optional second column. */
function row(label: string, a: string, b = ""): string {
  const head = label.padEnd(LABEL_W);
  return b === "" ? `${head}${a}` : `${head}${a.padEnd(COL_W)}${b}`;
}

/**
 * The failure and recovery alerts use a wider value column than the success
 * alert. Their values are words rather than figures — "automatic", "0.5086 SOL"
 * — and at 9 they collided with the second column instead of aligning with it.
 */
const WIDE_COL_W = 13;

function wideRow(label: string, a: string, b = ""): string {
  const head = label.padEnd(LABEL_W);
  return b === "" ? `${head}${a}` : `${head}${a.padEnd(WIDE_COL_W)}${b}`;
}

/** ASCII hyphen, not a minus sign — it has to line up in a monospace column. */
function usd(n: number): string {
  return `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
}

function pct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

/**
 * A duration with its seconds kept.
 *
 * `ago` rounds to the minute, which is right for "last rebalance 41m ago" and
 * wrong here: a recovery is usually two-and-a-bit minutes, and rounding it to
 * "2m" throws away the part that says whether the retry was the first scheduled
 * one or the fourth.
 */
function precisely(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0) return `${s}s`;
  return s === 0 ? `${m}m` : `${m}m${s}s`;
}

function ago(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h}h${min % 60 ? `${min % 60}m` : ""}` : `${Math.floor(h / 24)}d`;
}

function numOrNull(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

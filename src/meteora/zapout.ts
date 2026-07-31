import BN from "bn.js";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import type { JupiterSwap } from "../swap/jupiter.js";
import { TxError, type SendResult } from "../tx/send.js";
import { exitPosition, type ActionDeps } from "./actions.js";
import type { DlmmPool } from "./sdk.js";
import { toUi } from "./pricing.js";

/**
 * "Zap out": close a position and leave holding one token.
 *
 * `exitPosition` already removes all liquidity, claims fees and closes the
 * position account (reclaiming its rent). What it leaves you with is BOTH
 * tokens. Zap out is that, plus a swap of the side you did not want.
 *
 * The ordering is the opposite of Ape's, and it matters. Ape swaps first, so a
 * failed swap costs a fee and nothing else — you still hold what you started
 * with. Zap out CLOSES first, so a swap that fails afterwards leaves the
 * position gone and both tokens in the wallet. That is why the route is quoted
 * and impact-checked BEFORE anything closes: an unroutable position gets
 * refused while it still exists.
 */

export type ZapSide = "x" | "y";

export interface ZapOutDeps extends ActionDeps {
  swapper: JupiterSwap;
}

export interface ZapOutParams {
  positionPk: string;
  poolAddress: string;
  /** Which side to consolidate into. Defaults to ZAP_OUT_TO. */
  to?: ZapSide;
}

export interface ZapOutPlan {
  positionPk: string;
  poolAddress: string;
  pairName: string | null;
  to: ZapSide;
  toMint: string;
  fromMint: string;
  toSymbol: string;
  fromSymbol: string;
  /** Human units the position already holds of each side, fees included. */
  amountTo: number;
  amountFrom: number;
  /**
   * `amountFrom` in raw base units, carried so the execute path never has to
   * re-derive it from the display float — that round-trip is exactly how a
   * deposit ends up asking for one unit more than the wallet holds.
   */
  amountFromRaw: string;
  /** False when the position is already entirely in the target token. */
  needsSwap: boolean;
  /** Jupiter's quote for `amountFrom`. Zero when no swap is needed. */
  quotedOut: number;
  /** What lands in the wallet: what was already there plus the swap proceeds. */
  totalOut: number;
  priceImpactBps: number;
  route: string | null;
  /** Lamports the position account itself returns when closed. */
  rentLamports: number;
  valueUsd: number;
  estCostUsd: number;
  estCost: { txFeesLamports: number; swapImpactUsd: number };
}

export interface ZapOutResult {
  plan: ZapOutPlan;
  dryRun: boolean;
  exit: SendResult[];
  swap?: SendResult;
  /** Human units actually received from the swap. */
  received?: number;
  note?: string;
}

function sideOf(pool: DlmmPool, side: ZapSide) {
  const token = side === "x" ? pool.tokenX : pool.tokenY;
  return { mint: token.publicKey, program: token.owner, decimals: token.mint.decimals };
}

/**
 * Prices a zap out without closing anything.
 *
 * Everything refusable is decided here — while the position still exists, and
 * can therefore still be left alone.
 */
export async function planZapOut(deps: ZapOutDeps, params: ZapOutParams): Promise<ZapOutPlan> {
  const { cfg, client, dataApi, swapper } = deps;

  const to = params.to ?? cfg.zapOutTo;
  if (to !== "x" && to !== "y") throw new Error('to must be "x" or "y"');
  const from: ZapSide = to === "x" ? "y" : "x";

  const pool = await client.getPool(params.poolAddress, { fresh: true });
  const { positionData } = await pool.getPosition(new PublicKey(params.positionPk));

  const toSide = sideOf(pool, to);
  const fromSide = sideOf(pool, from);
  const meta = await dataApi.pool(params.poolAddress).catch(() => null);
  const symbol = (s: ZapSide) => (s === "x" ? meta?.token_x.symbol : meta?.token_y.symbol) ?? s.toUpperCase();

  // Fees are claimed by the exit and land in the wallet with the principal, so
  // they are part of what gets consolidated.
  const rawOf = (s: ZapSide) =>
    s === "x"
      ? new BN(positionData.totalXAmount).add(positionData.feeX)
      : new BN(positionData.totalYAmount).add(positionData.feeY);
  const fromRaw = rawOf(from);
  const toRawAmount = rawOf(to);

  const needsSwap = !fromRaw.isZero();
  let quotedOut = 0;
  let priceImpactBps = 0;
  let route: string | null = null;

  if (needsSwap) {
    const quote = await swapper.quote({
      inputMint: fromSide.mint.toBase58(),
      outputMint: toSide.mint.toBase58(),
      amount: fromRaw,
    });
    // Refused BEFORE the exit, which is the whole point of quoting first: a
    // position that cannot be routed out is one we leave open.
    if (quote.priceImpactBps > cfg.maxSwapPriceImpactBps) {
      throw new Error(
        `swap price impact ${quote.priceImpactBps}bps exceeds MAX_SWAP_PRICE_IMPACT_BPS ` +
          `(${cfg.maxSwapPriceImpactBps}bps) — refusing to zap out through the ${symbol(from)}->` +
          `${symbol(to)} route. The position is untouched and still open.`,
      );
    }
    quotedOut = toUi(quote.outAmount, toSide.decimals);
    priceImpactBps = quote.priceImpactBps;
    route = quote.route;
  }

  const rentLamports = await positionRent(deps, params.positionPk);
  const priceTo = (to === "x" ? meta?.token_x.price : meta?.token_y.price) ?? 0;
  const priceFrom = (from === "x" ? meta?.token_x.price : meta?.token_y.price) ?? 0;
  const amountTo = toUi(toRawAmount, toSide.decimals);
  const amountFrom = toUi(fromRaw, fromSide.decimals);
  const valueUsd = amountTo * priceTo + amountFrom * priceFrom;

  // The exit can be several transactions on a wide position; the swap is one more.
  const perTxLamports = 5_000 + Math.ceil((cfg.priorityFeeMicroLamports * cfg.computeUnitLimit) / 1_000_000);
  const exitTxCount = Math.max(1, Math.ceil((positionData.upperBinId - positionData.lowerBinId + 1) / 70));
  const txFeesLamports = perTxLamports * (exitTxCount + (needsSwap ? 1 : 0));
  const swapImpactUsd = amountFrom * priceFrom * (priceImpactBps / 10_000);
  const solPriceUsd = await dataApi.solPriceUsd().catch(() => 0);
  const estCostUsd = (txFeesLamports / LAMPORTS_PER_SOL) * solPriceUsd + swapImpactUsd;

  return {
    positionPk: params.positionPk,
    poolAddress: params.poolAddress,
    pairName: meta?.name ?? null,
    to,
    toMint: toSide.mint.toBase58(),
    fromMint: fromSide.mint.toBase58(),
    toSymbol: symbol(to),
    fromSymbol: symbol(from),
    amountTo,
    amountFrom,
    amountFromRaw: fromRaw.toString(),
    needsSwap,
    quotedOut,
    totalOut: amountTo + quotedOut,
    priceImpactBps,
    route,
    rentLamports,
    valueUsd,
    estCostUsd,
    estCost: { txFeesLamports, swapImpactUsd },
  };
}

/**
 * Closes the position, then swaps what came out of the side you did not want.
 *
 * Refuses while a journal entry is pending for this position, for the same
 * reason a manual rebalance does: an unresolved entry means some of this
 * position's funds are already sitting in the wallet mid-flight, and closing
 * around them would consolidate funds the rebalancer is still trying to place.
 */
export async function executeZapOut(deps: ZapOutDeps, params: ZapOutParams): Promise<ZapOutResult> {
  const { client, sender, swapper, store, log } = deps;
  const wallet = client.requireWallet();

  const unfinished = store.pendingJournal().find((j) => j.positionPk === params.positionPk);
  if (unfinished) {
    throw new Error(
      `unfinished rebalance ${unfinished.id} is pending at phase "${unfinished.phase}" — some of this ` +
        "position's funds are in the wallet mid-flight, and zapping out now would consolidate them along " +
        "with the position. The engine retries it automatically about every 2 minutes (watch /api/journal).",
    );
  }

  // Quoted and impact-checked while the position still exists.
  const plan = await planZapOut(deps, params);
  const pool = await client.getPool(plan.poolAddress);
  const fromSide = sideOf(pool, plan.to === "x" ? "y" : "x");
  const toSide = sideOf(pool, plan.to);

  const fromBefore = await client.tokenBalance(fromSide.mint, fromSide.program);
  const exit = await exitPosition(deps, { poolAddress: plan.poolAddress, positionPk: plan.positionPk });

  if (!exit.some((r) => r.signature)) {
    const note =
      "DRY-RUN: the exit simulated ok and nothing was sent. The swap leg is not simulated, because it " +
      "would sell tokens the exit did not actually release.";
    log.info({ positionPk: plan.positionPk }, note);
    return { plan, dryRun: true, exit, note };
  }

  if (!plan.needsSwap) {
    log.info({ positionPk: plan.positionPk }, "zap out: position was already entirely in the target token");
    return { plan, dryRun: false, exit, received: 0 };
  }

  const fromAfter = await client.tokenBalance(fromSide.mint, fromSide.program);
  const delta = BN.max(new BN(0), fromAfter.sub(fromBefore));

  /**
   * Capped at what the POSITION held, never the raw wallet delta.
   *
   * Closing the position also returns its rent, and for a wSOL side that rent
   * lands as native SOL — which `tokenBalance` folds into the wSOL balance. So
   * the delta is "what the position released PLUS the reclaimed rent", and
   * swapping all of it would sell the rent too. The rent should come back as
   * SOL, not as the target token.
   *
   * Same `BN.min(intended, available)` shape the resume path uses, and for the
   * same reason: the journalled/known figure is the intent, the wallet is only
   * the ceiling.
   */
  const intended = new BN(plan.amountFromRaw);
  const swapRaw = BN.min(intended, delta);
  if (swapRaw.isZero()) {
    log.warn(
      { positionPk: plan.positionPk, delta: delta.toString() },
      "zap out: exit released nothing of the side to swap — leaving the balance alone",
    );
    return { plan, dryRun: false, exit, received: 0, note: "the exit released nothing to swap" };
  }

  const toBefore = await client.tokenBalance(toSide.mint, toSide.program);
  const label = `zap out ${plan.fromSymbol}->${plan.toSymbol}`;
  try {
    const quote = await swapper.quote({
      inputMint: plan.fromMint,
      outputMint: plan.toMint,
      amount: swapRaw,
    });
    const swap = await sender.sendVersioned(await swapper.buildTransaction(quote, wallet), label);
    const received = toUi(
      BN.max(new BN(0), (await client.tokenBalance(toSide.mint, toSide.program)).sub(toBefore)),
      toSide.decimals,
    );
    log.info(
      { positionPk: plan.positionPk, signature: swap.signature, received, symbol: plan.toSymbol },
      "zap out complete",
    );
    return { plan, dryRun: false, exit, swap, received };
  } catch (e) {
    // The position is already closed. Whatever went wrong with the swap, the
    // funds are in the wallet as two tokens and the caller needs to hear that
    // rather than "zap out failed".
    const detail = e instanceof Error ? e.message : String(e);
    const message =
      `the position was closed but the swap failed: ${detail}. The wallet now holds about ` +
      `${toUi(swapRaw, fromSide.decimals)} ${plan.fromSymbol} and ${plan.amountTo} ${plan.toSymbol} ` +
      "— nothing is lost, and the swap can be retried from any wallet or by opening a new position.";
    log.error({ positionPk: plan.positionPk, err: detail }, "zap out: swap leg failed after the exit");
    throw e instanceof TxError ? new TxError(message, e.logs) : new Error(message);
  }
}

/**
 * What closing the position account returns, in lamports.
 *
 * Read from the account itself rather than assumed from a constant — the same
 * rule the wallet's rent column follows, and for the same reason: an extended
 * position holds more than a plain one, and what comes back is whatever is
 * actually sitting there. Best effort; a failed read prices it at zero rather
 * than blocking the plan.
 */
async function positionRent(deps: ZapOutDeps, positionPk: string): Promise<number> {
  try {
    const info = await deps.client.connection.getAccountInfo(new PublicKey(positionPk));
    return info?.lamports ?? 0;
  } catch {
    return 0;
  }
}

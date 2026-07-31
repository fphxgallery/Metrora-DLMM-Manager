import BN from "bn.js";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import type { StrategyTypeName } from "../config.js";
import type { JupiterSwap } from "../swap/jupiter.js";
import { TxError, type SendResult } from "../tx/send.js";
import { openPosition, type ActionDeps, type OpenResult } from "./actions.js";
import { DEFAULT_BIN_PER_POSITION, StrategyType, type DlmmPool } from "./sdk.js";
import { priceOfBin, rangeAround, toRaw, toUi } from "./pricing.js";

/**
 * "Ape in": one token, one confirmation, a two-sided position.
 *
 * A DLMM position centred on the active bin wants roughly equal VALUE per side
 * — bins below the active price hold the quote token, bins above hold the base
 * token, and a symmetric range has equally many of each. So paying in with a
 * single token means swapping half of it for the other side and depositing
 * both.
 *
 * Half by value is an approximation, not an identity: where the price sits
 * inside its own bin, and how the strategy weights bins, move the true split a
 * little off 50/50. The residue is cents, it stays in the wallet (which is
 * where the quote buffer lives anyway), and a position that opens meaningfully
 * lopsided is exactly what the rebalancer's path B already corrects. Solving it
 * precisely here would be a lot of arithmetic to save a rounding error.
 *
 * Nothing new is invented for the settings: the shape, width, slippage and
 * impact ceiling are the same values the rebalancer runs on, so an Ape'd
 * position is one the automation would have built itself.
 */

export type ApeSide = "x" | "y";

export interface ApeDeps extends ActionDeps {
  swapper: JupiterSwap;
}

export interface ApeParams {
  poolAddress: string;
  /** Human units of the token being paid in. */
  amount: number;
  /** Which side of the pool is being paid in. */
  payWith: ApeSide;
  rangeBins?: number;
  strategyType?: StrategyTypeName;
  /** Overrides APE_AUTO_MANAGE for this one call. */
  auto?: boolean;
}

export interface ApePlan {
  poolAddress: string;
  pairName: string | null;
  payWith: ApeSide;
  inMint: string;
  outMint: string;
  inSymbol: string;
  outSymbol: string;
  /** Human units. */
  amountIn: number;
  /** The half that gets swapped, and the half that does not. */
  swapIn: number;
  keep: number;
  /** What Jupiter quoted for `swapIn`, in human units. */
  quotedOut: number;
  priceImpactBps: number;
  route: string;
  strategyType: StrategyTypeName;
  rangeBins: number;
  activeBinId: number;
  minBinId: number;
  maxBinId: number;
  minPrice: number;
  maxPrice: number;
  /** Total value going into the position, both sides. 0 when unpriced. */
  depositUsd: number;
  estCostUsd: number;
  estCost: { txFeesLamports: number; rentLamports: number; swapImpactUsd: number };
  /** Whether the resulting position would be enrolled in auto-rebalancing. */
  autoManage: boolean;
}

export interface ApeResult {
  plan: ApePlan;
  dryRun: boolean;
  swap: SendResult;
  /** Human units actually received from the swap. Absent in dry-run. */
  received?: number;
  open?: OpenResult;
  /** Set when the run stopped early but nothing is wrong — dry-run, mainly. */
  note?: string;
}

/** The mint, program and symbol of one side of a pool. */
function sideOf(pool: DlmmPool, side: ApeSide) {
  const token = side === "x" ? pool.tokenX : pool.tokenY;
  return { mint: token.publicKey, program: token.owner, decimals: token.mint.decimals };
}

/**
 * Quotes an ape without sending anything.
 *
 * Every refusal that can be decided before a signature happens here, so the
 * confirm step in the UI is showing a plan that has already passed the guards
 * rather than one that will fail on submit.
 */
export async function planApe(deps: ApeDeps, params: ApeParams): Promise<ApePlan> {
  const { cfg, client, dataApi, swapper } = deps;

  if (!(params.amount > 0)) throw new Error("amount must be greater than zero");
  if (params.payWith !== "x" && params.payWith !== "y") throw new Error('payWith must be "x" or "y"');

  const rangeBins = params.rangeBins ?? cfg.rangeBins;
  const strategyType = params.strategyType ?? cfg.strategyType;
  const pool = await client.getPool(params.poolAddress, { fresh: true });

  const inSide = sideOf(pool, params.payWith);
  const outSide = sideOf(pool, params.payWith === "x" ? "y" : "x");
  const meta = await dataApi.pool(params.poolAddress).catch(() => null);
  const inSymbol = (params.payWith === "x" ? meta?.token_x.symbol : meta?.token_y.symbol) ?? params.payWith.toUpperCase();
  const outSymbol = (params.payWith === "x" ? meta?.token_y.symbol : meta?.token_x.symbol) ?? "the other side";

  // Checked against the same balance rule a deposit uses, so an ape that the
  // wallet cannot fund is refused before it costs a Jupiter quote. For wSOL
  // this already excludes MIN_SOL_BALANCE.
  const amountRaw = toRaw(params.amount, inSide.decimals);
  if (amountRaw.isZero()) throw new Error("amount rounds to zero at this mint's precision");
  const available = await client.tokenBalance(inSide.mint, inSide.program);
  if (available.lt(amountRaw)) {
    throw new Error(
      `insufficient ${inSymbol}: need ${params.amount}, wallet has ${toUi(available, inSide.decimals)}` +
        ` (SOL also keeps MIN_SOL_BALANCE=${cfg.minSolBalance} in reserve for fees)`,
    );
  }

  // Half by value. See splitHalf: the kept side is the REMAINDER, not a second
  // division, so the two halves always add back to exactly what was asked for.
  const { swapRaw, keepRaw } = splitHalf(amountRaw);
  if (swapRaw.isZero()) throw new Error("amount is too small to split into a two-sided position");

  const quote = await swapper.quote({
    inputMint: inSide.mint.toBase58(),
    outputMint: outSide.mint.toBase58(),
    amount: swapRaw,
  });

  // Same ceiling the rebalance swap leg answers to, and refused for the same
  // reason: this is whether the route is worth taking at all, distinct from the
  // slippage we accept on a route already chosen.
  if (quote.priceImpactBps > cfg.maxSwapPriceImpactBps) {
    throw new Error(
      `swap price impact ${quote.priceImpactBps}bps exceeds MAX_SWAP_PRICE_IMPACT_BPS ` +
        `(${cfg.maxSwapPriceImpactBps}bps) — refusing the ${inSymbol}->${outSymbol} route. Nothing was sent.`,
    );
  }

  const activeBinId = pool.lbPair.activeId;
  const { minBinId, maxBinId } = rangeAround(activeBinId, rangeBins);

  const priceIn = (params.payWith === "x" ? meta?.token_x.price : meta?.token_y.price) ?? 0;
  const depositUsd = priceIn > 0 ? params.amount * priceIn : 0;

  const { rentLamports, openTxCount } = await estimateOpenCost(deps, pool, minBinId, maxBinId, strategyType);
  const perTxLamports = 5_000 + Math.ceil((cfg.priorityFeeMicroLamports * cfg.computeUnitLimit) / 1_000_000);
  // The swap is one more transaction on top of whatever the open needs.
  const txFeesLamports = perTxLamports * (openTxCount + 1);
  const swapImpactUsd = (depositUsd / 2) * (quote.priceImpactBps / 10_000);
  const solPriceUsd = await dataApi.solPriceUsd().catch(() => 0);
  const estCostUsd = ((txFeesLamports + rentLamports) / LAMPORTS_PER_SOL) * solPriceUsd + swapImpactUsd;

  return {
    poolAddress: params.poolAddress,
    pairName: meta?.name ?? null,
    payWith: params.payWith,
    inMint: inSide.mint.toBase58(),
    outMint: outSide.mint.toBase58(),
    inSymbol,
    outSymbol,
    amountIn: params.amount,
    swapIn: toUi(swapRaw, inSide.decimals),
    keep: toUi(keepRaw, inSide.decimals),
    quotedOut: toUi(quote.outAmount, outSide.decimals),
    priceImpactBps: quote.priceImpactBps,
    route: quote.route,
    strategyType,
    rangeBins,
    activeBinId,
    minBinId,
    maxBinId,
    minPrice: priceOfBin(pool, minBinId),
    maxPrice: priceOfBin(pool, maxBinId),
    depositUsd,
    estCostUsd,
    estCost: { txFeesLamports, rentLamports, swapImpactUsd },
    autoManage: params.auto ?? cfg.apeAutoManage,
  };
}

/**
 * Swaps half, then opens the position.
 *
 * There is no journal entry for this. A journal is keyed to a position that
 * exists, and here the position is what we are trying to create — there is
 * nothing to resume INTO. What matters instead is that a failure after the swap
 * says exactly what the wallet is now holding, because that is the state a
 * caller has to recover from by hand.
 */
export async function executeApe(deps: ApeDeps, params: ApeParams): Promise<ApeResult> {
  const { client, sender, swapper, log } = deps;
  const wallet = client.requireWallet();
  await client.assertSolFunded();

  // Re-quoted here rather than trusting a plan the caller may have been sitting
  // on: the confirm step is a human deciding, and a quote goes stale in seconds.
  const plan = await planApe(deps, params);
  const pool = await client.getPool(plan.poolAddress);
  const outSide = sideOf(pool, plan.payWith === "x" ? "y" : "x");

  const before = await client.tokenBalance(outSide.mint, outSide.program);
  const label = `ape swap ${plan.inSymbol}->${plan.outSymbol}`;
  const quote = await swapper.quote({
    inputMint: plan.inMint,
    outputMint: plan.outMint,
    amount: toRaw(plan.swapIn, sideOf(pool, plan.payWith).decimals),
  });
  const swap = await sender.sendVersioned(await swapper.buildTransaction(quote, wallet), label);

  if (!swap.signature) {
    // DRY-RUN. The open leg cannot be simulated: it would deposit proceeds that
    // only exist if the swap actually ran, so simulating it would fail on a
    // balance that was never credited — a false alarm, not a finding. Path B's
    // dry-run stops at the same boundary for the same reason.
    const note =
      "DRY-RUN: the swap simulated ok and nothing was sent. The open leg is not simulated, because it " +
      "would deposit proceeds the swap did not actually produce.";
    log.info({ poolAddress: plan.poolAddress }, note);
    return { plan, dryRun: true, swap, note };
  }

  const received = (await client.tokenBalance(outSide.mint, outSide.program)).sub(before);
  const receivedUi = toUi(BN.max(new BN(0), received), outSide.decimals);
  log.info(
    { poolAddress: plan.poolAddress, signature: swap.signature, received: receivedUi, symbol: plan.outSymbol },
    "ape swap landed",
  );

  const payingX = plan.payWith === "x";
  try {
    const open = await openPosition(deps, {
      poolAddress: plan.poolAddress,
      xAmount: payingX ? plan.keep : receivedUi,
      yAmount: payingX ? receivedUi : plan.keep,
      rangeBins: params.rangeBins,
      strategyType: params.strategyType,
      auto: plan.autoManage,
    });
    return { plan, dryRun: false, swap, received: receivedUi, open };
  } catch (e) {
    // The swap is already on chain. Whatever went wrong with the open, the
    // caller's funds moved and they need to know into what — otherwise this
    // reads as "the ape failed" and the swapped balance goes unnoticed.
    const detail = e instanceof Error ? e.message : String(e);
    const message =
      `the swap landed (${swap.signature}) but opening the position failed: ${detail}. ` +
      `The wallet now holds about ${plan.keep} ${plan.inSymbol} and ${receivedUi} ${plan.outSymbol} — ` +
      "nothing is lost; open a position with those amounts from the pool's own form, or ape again.";
    log.error({ poolAddress: plan.poolAddress, signature: swap.signature, err: detail }, "ape: open leg failed");
    throw e instanceof TxError ? new TxError(message, e.logs) : new Error(message);
  }
}

/**
 * Rent and transaction count for the open leg.
 *
 * Best effort: an unavailable quote must not block an ape, so a failure prices
 * the rent at zero and assumes the wide (two-transaction) path, which is the
 * conservative direction for a cost estimate.
 */
async function estimateOpenCost(
  deps: ApeDeps,
  pool: DlmmPool,
  minBinId: number,
  maxBinId: number,
  strategyType: StrategyTypeName,
): Promise<{ rentLamports: number; openTxCount: number }> {
  const wide = maxBinId - minBinId + 1 > DEFAULT_BIN_PER_POSITION.toNumber();
  try {
    const quote = await pool.quoteCreatePosition({
      strategy: { minBinId, maxBinId, strategyType: StrategyType[strategyType] },
    });
    const rentSol =
      quote.positionCost + quote.positionReallocCost + quote.bitmapExtensionCost + quote.binArrayCost;
    return {
      rentLamports: Math.round(rentSol * LAMPORTS_PER_SOL),
      openTxCount: quote.transactionCount > 0 ? quote.transactionCount : wide ? 2 : 1,
    };
  } catch {
    return { rentLamports: 0, openTxCount: wide ? 2 : 1 };
  }
}

/** Exported for tests: the half-split is the one piece of arithmetic here. */
export function splitHalf(amountRaw: BN): { swapRaw: BN; keepRaw: BN } {
  const swapRaw = amountRaw.divn(2);
  return { swapRaw, keepRaw: amountRaw.sub(swapRaw) };
}

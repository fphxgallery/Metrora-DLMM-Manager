import BN from "bn.js";
import { randomUUID } from "node:crypto";
import { LAMPORTS_PER_SOL, PublicKey, Transaction } from "@solana/web3.js";
import type { Config, StrategyTypeName } from "../config.js";
import type { Logger } from "../logger.js";
import type { JournalEntry, Store } from "../state.js";
import { WSOL_MINT, type DataApi } from "./datapi.js";
import type { MeteoraClient } from "./client.js";
import { TxError, type TxSender, type SendResult } from "../tx/send.js";
import type { JupiterSwap } from "../swap/jupiter.js";
import { StrategyType, type DlmmPool, type PositionData } from "./sdk.js";
import { priceOfBin, toUi, valuePosition } from "./pricing.js";

/**
 * Jupiter's `SlippageToleranceExceeded`, as it appears in a failed simulation:
 * "custom program error: 0x1771" (6001).
 */
const JUPITER_SLIPPAGE_ERR = "0x1771";

/**
 * How many times the swap leg will quote before giving up on this tick.
 *
 * Observed live: a route quoted at 0bps price impact failed simulation on
 * slippage, and a re-quote 2m22s later filled immediately on a DIFFERENT route
 * (AlphaQ -> Quantum). Half a percent of real movement in the 174ms between quote
 * and simulation is not plausible for a major pair, so the cause is the route
 * itself — most likely another trade hitting a thin pool inside it. Re-quoting
 * therefore fixes it, and waiting for the next tick to do that leaves the
 * withdrawn funds sitting in the wallet for minutes with nothing gained.
 */
const SWAP_QUOTE_ATTEMPTS = 3;
/** Long enough for route state to change, negligible next to a resume cycle. */
const SWAP_REQUOTE_DELAY_MS = 1_500;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Whether a failed swap send may be re-quoted and sent again immediately.
 *
 * Two conditions, and BOTH matter:
 *
 * `would fail` is the message `assertSimulationOk` throws, which happens before
 * the transaction is broadcast — so it is the only failure we can prove was never
 * sent. Every other failure has an outcome we do not know: a swap that may have
 * landed must never be sent a second time, because doing so would swap the
 * position's funds twice and there is no way to undo it. An expired blockhash or
 * a confirmation timeout falls here, and is left to resume, which re-reads
 * on-chain state first.
 *
 * And the error has to actually be slippage. A route we cannot afford, a missing
 * account or a program bug will fail identically on a retry, so retrying only
 * burns quotes.
 */
export function isRequotableSwapFailure(e: unknown): boolean {
  if (!(e instanceof TxError)) return false;
  if (!e.message.includes("would fail")) return false;
  return e.message.includes(JUPITER_SLIPPAGE_ERR) || /slippage/i.test(e.message);
}

export interface RebalanceDeps {
  cfg: Config;
  client: MeteoraClient;
  dataApi: DataApi;
  sender: TxSender;
  swapper: JupiterSwap;
  store: Store;
  log: Logger;
  /** Optional push channel, so a low wallet buffer is not only a log line. */
  notify?: (msg: string) => void;
}

export interface RebalancePlan {
  positionPk: string;
  poolAddress: string;
  path: "A" | "B";
  strategyType: StrategyTypeName;
  activeBinId: number;
  currentRange: [number, number];
  targetRange: [number, number];
  /** valueX / total, in bps. 5000 is balanced. */
  ratioBps: number;
  /** Position value including unclaimed fees, in token Y and in USD. */
  valueInY: number;
  valueUsd: number;
  unclaimedFeesUsd: number;
  /** Path B: which side is oversupplied and how much of it gets withdrawn. */
  swap?: {
    fromMint: string;
    toMint: string;
    fromSymbol: string;
    toSymbol: string;
    xWithdrawBps: number;
    yWithdrawBps: number;
    /** Value being swapped, in USD, before slippage. */
    valueUsd: number;
  };
  /** Fees + rent this rebalance is expected to cost, in USD. */
  estCostUsd: number;
  estCost: { txFeesLamports: number; rentLamports: number; swapImpactUsd: number };
}

export interface RebalanceOutcome {
  plan: RebalancePlan;
  journalId: string;
  results: SendResult[];
  /** True when nothing was sent because the app is in dry-run. */
  dryRun: boolean;
}

/**
 * Works out how to re-centre a position on the current active bin.
 *
 * The SDK's balanced strategy always rebuilds the position with its *existing
 * width* centred on the active bin, so the plan's job is to decide whether the
 * token ratio also needs fixing, and to price the whole thing so the caller can
 * decide if it is worth doing.
 */
export async function planRebalance(
  deps: RebalanceDeps,
  params: { positionPk: string; poolAddress: string; strategyType?: StrategyTypeName },
): Promise<RebalancePlan> {
  const { cfg, client, dataApi } = deps;
  const pool = await client.getPool(params.poolAddress, { fresh: true });
  const { positionData } = await pool.getPosition(new PublicKey(params.positionPk));

  const activeBinId = pool.lbPair.activeId;
  const strategyType = params.strategyType ?? cfg.strategyType;
  const targetRange = balancedTargetRange(positionData, activeBinId);

  const [meta, solPriceUsd] = await Promise.all([
    dataApi.pool(params.poolAddress).catch(() => null),
    dataApi.solPriceUsd().catch(() => 0),
  ]);
  const priceUsdX = meta?.token_x.price ?? 0;
  const priceUsdY = meta?.token_y.price ?? 0;

  const decimalsX = pool.tokenX.mint.decimals;
  const decimalsY = pool.tokenY.mint.decimals;
  const activePrice = priceOfBin(pool, activeBinId);

  // Fees are withdrawn and redeposited along with the principal, so they belong
  // in the value the ratio is computed from.
  const amountXRaw = new BN(positionData.totalXAmount).add(positionData.feeX);
  const amountYRaw = new BN(positionData.totalYAmount).add(positionData.feeY);
  const value = valuePosition({ amountXRaw, amountYRaw, decimalsX, decimalsY, priceXinY: activePrice });
  const valueUsd = value.amountX * priceUsdX + value.amountY * priceUsdY;
  const unclaimedFeesUsd = toUi(positionData.feeX, decimalsX) * priceUsdX + toUi(positionData.feeY, decimalsY) * priceUsdY;

  // A symmetric range around the active bin wants roughly equal value per side.
  // Beyond the configured tolerance, a swap leg is added; inside it, the cheaper
  // single atomic rebalance is used and the position is left slightly lopsided.
  const leg = planSwapLeg(value, {
    ratioToleranceBps: cfg.ratioToleranceBps,
    maxSwapPctOfPosition: cfg.maxSwapPctOfPosition,
  });
  const needsSwap = leg !== null;

  let swap: RebalancePlan["swap"];
  if (leg) {
    swap = {
      fromMint: (leg.surplusIsX ? pool.tokenX : pool.tokenY).publicKey.toBase58(),
      toMint: (leg.surplusIsX ? pool.tokenY : pool.tokenX).publicKey.toBase58(),
      fromSymbol: (leg.surplusIsX ? meta?.token_x.symbol : meta?.token_y.symbol) ?? (leg.surplusIsX ? "X" : "Y"),
      toSymbol: (leg.surplusIsX ? meta?.token_y.symbol : meta?.token_x.symbol) ?? (leg.surplusIsX ? "Y" : "X"),
      xWithdrawBps: leg.surplusIsX ? leg.withdrawBps : 0,
      yWithdrawBps: leg.surplusIsX ? 0 : leg.withdrawBps,
      valueUsd: value.total > 0 ? (leg.swapValueInY / value.total) * valueUsd : 0,
    };
  }

  // Cost: network+priority fees per transaction, plus rent for any bin arrays
  // the new range needs, plus the expected slippage on the swap leg.
  const perTxLamports = 5_000 + Math.ceil((cfg.priorityFeeMicroLamports * cfg.computeUnitLimit) / 1_000_000);
  const txCount = needsSwap ? 3 : 1;
  const rentLamports = await estimateRentLamports(deps, pool, positionData, targetRange, strategyType);
  const txFeesLamports = perTxLamports * txCount;
  // Assume the swap pays roughly the pool's own fee tier in impact+fees; the
  // real number comes back from the Jupiter quote at execution time.
  const swapImpactUsd = swap ? (swap.valueUsd * (meta?.pool_config.base_fee_pct ?? 0.05)) / 100 : 0;
  const estCostUsd = ((txFeesLamports + rentLamports) / LAMPORTS_PER_SOL) * solPriceUsd + swapImpactUsd;

  return {
    positionPk: params.positionPk,
    poolAddress: params.poolAddress,
    path: needsSwap ? "B" : "A",
    strategyType,
    activeBinId,
    currentRange: [positionData.lowerBinId, positionData.upperBinId],
    targetRange,
    ratioBps: value.ratioBps,
    valueInY: value.total,
    valueUsd,
    unclaimedFeesUsd,
    swap,
    estCostUsd,
    estCost: { txFeesLamports, rentLamports, swapImpactUsd },
  };
}

/**
 * Executes a plan, journalling before every send.
 *
 * Path A is one atomic instruction. Path B withdraws the surplus side, swaps it,
 * then deposits the proceeds — three separate transactions, between which the
 * funds sit in the wallet rather than in the pool. The journal is what makes
 * that interruptible: a crash leaves a record saying exactly which of those
 * boundaries we stopped at.
 */
export async function executeRebalance(deps: RebalanceDeps, plan: RebalancePlan): Promise<RebalanceOutcome> {
  const { store, log } = deps;

  // Before anything is journalled or sent: the rebalance instruction settles
  // rounding shortfalls out of the wallet's quote-token ATA, and an empty one
  // fails the whole thing at simulation.
  const meta = await deps.dataApi.pool(plan.poolAddress).catch(() => null);
  if (meta) {
    await ensureQuoteBuffer(deps, {
      quoteMint: meta.token_y.address,
      quoteSymbol: meta.token_y.symbol,
      quotePriceUsd: meta.token_y.price,
      quoteDecimals: meta.token_y.decimals,
    });
  }

  const entry: JournalEntry = {
    id: randomUUID(),
    positionPk: plan.positionPk,
    poolAddress: plan.poolAddress,
    path: plan.path,
    phase: plan.path === "A" ? "atomic" : "withdraw",
    targetMinBinId: plan.targetRange[0],
    targetMaxBinId: plan.targetRange[1],
    sourceMinBinId: plan.currentRange[0],
    sourceMaxBinId: plan.currentRange[1],
    rentLamports: plan.estCost.rentLamports,
    strategyType: plan.strategyType,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    sigs: [],
    // Path B: journal the swap DIRECTION before anything is sent. The amount is
    // not known until the withdraw lands, but the mints are known now — and
    // without them, a crash between the withdraw landing and the phase->"swap"
    // update leaves an entry that resume cannot identify the stranded funds from.
    ...(plan.path === "B" && plan.swap
      ? { swap: { inMint: plan.swap.fromMint, outMint: plan.swap.toMint, inAmount: "0" } }
      : {}),
  };
  store.openJournal(entry);
  log.info(
    {
      journalId: entry.id,
      positionPk: plan.positionPk,
      path: plan.path,
      from: plan.currentRange,
      to: plan.targetRange,
      ratioBps: plan.ratioBps,
      estCostUsd: round2(plan.estCostUsd),
      feesUsd: round2(plan.unclaimedFeesUsd),
    },
    "rebalance starting",
  );

  try {
    const results = plan.path === "A" ? await runAtomic(deps, plan, entry) : await runWithSwap(deps, plan, entry);
    const dryRun = results.every((r) => r.dryRun);

    // A dry run proves the plan simulates; it must not be recorded as a real
    // rebalance, or the cooldown and cost ledger would both be fiction.
    if (dryRun) {
      store.updateJournal(entry.id, { phase: "done" });
      log.info({ journalId: entry.id }, "DRY-RUN rebalance simulated ok");
      return { plan, journalId: entry.id, results, dryRun };
    }

    store.updateJournal(entry.id, { phase: "done", sigs: sigsOf(results) });
    store.recordRebalance({
      ts: Date.now(),
      positionPk: plan.positionPk,
      poolAddress: plan.poolAddress,
      path: plan.path,
      fromRange: plan.currentRange,
      toRange: plan.targetRange,
      costLamports: results.reduce((a, r) => a + (r.feeLamports ?? 0), 0),
      rentLamports: plan.estCost.rentLamports,
      sigs: sigsOf(results),
    });
    log.info({ journalId: entry.id, sigs: sigsOf(results) }, "rebalance complete");
    return { plan, journalId: entry.id, results, dryRun };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Leave the phase alone: it is the record of where execution stopped, which
    // is what resume() needs. Only mark `failed` for the atomic path, where a
    // failure means nothing moved.
    const cur = store.journalEntry(entry.id);
    if (cur?.phase === "atomic") store.updateJournal(entry.id, { phase: "failed", error: message });
    else store.updateJournal(entry.id, { error: message });
    log.error({ journalId: entry.id, phase: cur?.phase, err: message }, "rebalance failed");
    throw e;
  }
}

// ------------------------------------------------------------------ paths ----

async function runAtomic(deps: RebalanceDeps, plan: RebalancePlan, entry: JournalEntry): Promise<SendResult[]> {
  const { cfg, client, sender } = deps;
  const wallet = client.requireWallet();
  await client.assertSolFunded();

  const pool = await client.getPool(plan.poolAddress, { fresh: true });
  const position = new PublicKey(plan.positionPk);
  const { positionData } = await pool.getPosition(position);

  const sim = await pool.simulateRebalancePositionWithBalancedStrategy(
    position,
    positionData,
    StrategyType[plan.strategyType],
    new BN(0), // no top-up
    new BN(0),
    new BN(0), // withdraw nothing to the wallet — everything is redeposited
    new BN(0),
  );

  const { initBinArrayInstructions, rebalancePositionInstruction } = await pool.rebalancePosition(
    sim,
    new BN(cfg.maxActiveBinSlippage),
  );

  const results: SendResult[] = [];
  if (initBinArrayInstructions.length > 0) {
    results.push(await sender.sendInstructions(initBinArrayInstructions, [wallet], "init bin arrays"));
  }
  results.push(
    await sender.send(
      new Transaction().add(...client.ataIxs(pool), ...rebalancePositionInstruction),
      [wallet],
      "rebalance (atomic)",
    ),
  );

  client.invalidate(plan.poolAddress);
  deps.store.updateJournal(entry.id, { sigs: sigsOf(results) });
  return results;
}

async function runWithSwap(deps: RebalanceDeps, plan: RebalancePlan, entry: JournalEntry): Promise<SendResult[]> {
  const { client, log, store } = deps;
  const wallet = client.requireWallet();
  await client.assertSolFunded();
  if (!plan.swap) throw new Error("path B plan has no swap leg");

  const pool = await client.getPool(plan.poolAddress, { fresh: true });
  const fromMint = new PublicKey(plan.swap.fromMint);
  const fromIsX = fromMint.equals(pool.tokenX.publicKey);
  const fromProgram = fromIsX ? pool.tokenX.owner : pool.tokenY.owner;

  // Balance BEFORE the withdraw, so the amount to swap is the delta the withdraw
  // actually produced — not whatever else happens to be in the wallet.
  const balanceBefore = await client.tokenBalance(fromMint, fromProgram);

  // ---- phase 1: withdraw the surplus side and re-centre the range ----
  const results = await withdrawAndRecentre(deps, plan, entry);

  const balanceAfter = await client.tokenBalance(fromMint, fromProgram);
  const withdrawn = BN.max(new BN(0), balanceAfter.sub(balanceBefore));
  if (withdrawn.isZero()) {
    // Dry-run takes this path: nothing was sent, so nothing arrived.
    log.info({ journalId: entry.id }, "no withdrawn balance to swap (dry-run or nothing to move)");
    return results;
  }

  // ---- phase 2: swap ----
  store.updateJournal(entry.id, {
    phase: "swap",
    sigs: sigsOf(results),
    swap: { inMint: plan.swap.fromMint, outMint: plan.swap.toMint, inAmount: withdrawn.toString() },
  });
  const swapResult = await runSwapLeg(deps, entry, plan, withdrawn);
  results.push(swapResult.result);

  // ---- phase 3: deposit the proceeds into the new range ----
  store.updateJournal(entry.id, { phase: "deposit", sigs: sigsOf(results) });
  results.push(...(await depositProceeds(deps, entry, plan, swapResult.received)));

  client.invalidate(plan.poolAddress);
  return results;
}

/** Phase 1 of path B: one rebalance that recentres and leaves the surplus in the wallet. */
async function withdrawAndRecentre(
  deps: RebalanceDeps,
  plan: RebalancePlan,
  entry: JournalEntry,
): Promise<SendResult[]> {
  const { cfg, client, sender } = deps;
  const wallet = client.requireWallet();
  const pool = await client.getPool(plan.poolAddress, { fresh: true });
  const position = new PublicKey(plan.positionPk);
  const { positionData } = await pool.getPosition(position);

  // Upper bound on what this leg will release into the wallet, journalled
  // BEFORE the send so a crash immediately after it lands still leaves resume a
  // cap to work from. Without one, resume cannot tell how much of the wallet
  // belongs to this rebalance, and marks the entry failed for manual recovery
  // rather than guessing — see the refusals in resumeJournal.
  const xBps = plan.swap!.xWithdrawBps;
  const sideRaw =
    xBps > 0
      ? new BN(positionData.totalXAmount).add(positionData.feeX)
      : new BN(positionData.totalYAmount).add(positionData.feeY);
  const expectedIn = sideRaw.muln(xBps > 0 ? xBps : plan.swap!.yWithdrawBps).divn(10_000);
  deps.store.updateJournal(entry.id, {
    swap: { inMint: plan.swap!.fromMint, outMint: plan.swap!.toMint, inAmount: expectedIn.toString() },
  });

  const sim = await pool.simulateRebalancePositionWithBalancedStrategy(
    position,
    positionData,
    StrategyType[plan.strategyType],
    new BN(0),
    new BN(0),
    new BN(plan.swap!.xWithdrawBps),
    new BN(plan.swap!.yWithdrawBps),
  );

  const { initBinArrayInstructions, rebalancePositionInstruction } = await pool.rebalancePosition(
    sim,
    new BN(cfg.maxActiveBinSlippage),
  );

  const results: SendResult[] = [];
  if (initBinArrayInstructions.length > 0) {
    results.push(await sender.sendInstructions(initBinArrayInstructions, [wallet], "init bin arrays"));
  }
  results.push(
    await sender.send(
      new Transaction().add(...client.ataIxs(pool), ...rebalancePositionInstruction),
      [wallet],
      "rebalance (withdraw leg)",
    ),
  );
  deps.store.updateJournal(entry.id, { sigs: sigsOf(results) });
  return results;
}

/**
 * How much SOL to spend topping the quote buffer back up, or why not to.
 *
 * Separated from the I/O so the arithmetic can be tested: every branch here either
 * spends real SOL or declines to, and getting the reserve interaction wrong would
 * trade an empty quote balance for an empty SOL balance.
 */
export function planTopUp(args: {
  balanceUsd: number;
  floorUsd: number;
  maxTopUpUsd: number;
  solPriceUsd: number;
  solBalance: number;
  minSolBalance: number;
}): { wantUsd: number; wantSol: number } | { skip: string } {
  const { balanceUsd, floorUsd, maxTopUpUsd, solPriceUsd, solBalance, minSolBalance } = args;
  if (balanceUsd >= floorUsd) return { skip: "buffer is already above the floor" };
  if (!(solPriceUsd > 0)) return { skip: "SOL price unavailable" };

  // Refill to twice the floor, so a rebalance that consumes a few cents does not
  // trigger another top-up on the very next tick.
  const wantUsd = Math.min(maxTopUpUsd, floorUsd * 2 - balanceUsd);
  const wantSol = wantUsd / solPriceUsd;

  // MIN_SOL_BALANCE is what keeps fees and rent payable and is not ours to spend.
  const spendableSol = solBalance - minSolBalance;
  if (spendableSol <= 0 || wantSol > spendableSol) {
    return { skip: "SOL above MIN_SOL_BALANCE is insufficient to top it up" };
  }
  return { wantUsd, wantSol };
}

/**
 * Keeps a small idle balance of the quote token in the wallet's ATA, refilled
 * when AUTO_TOPUP is on — by wrapping SOL when the quote is SOL, by swapping a
 * little SOL otherwise.
 *
 * Why this exists: `RebalanceLiquidity` removes the old range and redeposits into
 * the new one inside a single instruction, and settles the difference out of the
 * wallet's ATA. When the removal releases none of a side (price sitting fully on
 * the other one — exactly when a rebalance is most needed) the redeposit still
 * asks for a little of it, and against an empty ATA that is SPL Token
 * "insufficient funds" (0x1). Observed live on two pools: the deposit half asked
 * for 146,041 and 743,476 lamports of wSOL against an ATA that did not exist.
 * The shortfall is cents; a dollar left idle covers it.
 *
 * Never throws. A rebalance that would have worked anyway must not be blocked
 * because the buffer could not be priced or the top-up did not fill.
 */
export async function ensureQuoteBuffer(
  deps: RebalanceDeps,
  args: { quoteMint: string; quoteSymbol: string; quotePriceUsd: number; quoteDecimals: number },
): Promise<{ balanceUsd: number | null; toppedUpUsd?: number; low: boolean }> {
  const { cfg, client, sender, swapper, log } = deps;
  const floor = cfg.minQuoteBalanceUsd;
  if (floor <= 0) return { balanceUsd: null, low: false };

  const wallet = client.wallet();
  if (!wallet || !(args.quotePriceUsd > 0)) return { balanceUsd: null, low: false };

  // The wSOL case is why this reads the ATA rather than `tokenBalance`. That
  // helper folds native SOL into the wSOL figure, which is right when sizing a
  // swap (Jupiter wraps on demand) and wrong here: this guard is asking whether
  // Meteora's instruction can DEBIT the account on chain, and it cannot spend
  // native SOL. With the fold, a wallet holding 0.8 SOL and an empty wSOL ATA
  // read as $60 against a $1 floor, so the guard returned "fine" and the
  // rebalance failed at simulation on the account it was meant to protect.
  let balanceUsd: number;
  try {
    const raw = await client.ataBalance(new PublicKey(args.quoteMint));
    balanceUsd = (Number(raw.toString()) / 10 ** args.quoteDecimals) * args.quotePriceUsd;
  } catch (e) {
    log.debug({ err: e instanceof Error ? e.message : String(e) }, "quote balance read failed");
    return { balanceUsd: null, low: false };
  }
  if (balanceUsd >= floor) return { balanceUsd, low: false };

  if (!cfg.autoTopUp) {
    log.warn(
      { balanceUsd, floor, symbol: args.quoteSymbol },
      "quote-token buffer is below MIN_QUOTE_BALANCE_USD and AUTO_TOPUP is off",
    );
    deps.notify?.(
      `🪙 ${args.quoteSymbol} buffer is $${balanceUsd.toFixed(2)}, below MIN_QUOTE_BALANCE_USD $${floor}. ` +
        "AUTO_TOPUP is off, so a rebalance may fail on a rounding shortfall it cannot cover.",
    );
    return { balanceUsd, low: true };
  }

  const solPriceUsd = await deps.dataApi.solPriceUsd().catch(() => 0);
  const solBalance = await client.solBalance().catch(() => 0);
  const plan = planTopUp({
    balanceUsd,
    floorUsd: floor,
    maxTopUpUsd: cfg.maxTopUpUsd,
    solPriceUsd,
    solBalance,
    minSolBalance: cfg.minSolBalance,
  });
  if ("skip" in plan) {
    log.warn(
      { balanceUsd, floor, solBalance, reason: plan.skip },
      "quote-token buffer is low and could not be topped up",
    );
    deps.notify?.(
      `🪙 ${args.quoteSymbol} buffer is $${balanceUsd.toFixed(2)}, below MIN_QUOTE_BALANCE_USD $${floor} — ` +
        `${plan.skip}. A rebalance may fail on a rounding shortfall it cannot cover.`,
    );
    return { balanceUsd, low: true };
  }

  const lamports = Math.floor(plan.wantSol * LAMPORTS_PER_SOL);

  try {
    // Quote IS SOL: wrap, never swap. The swap below would be wSOL->wSOL, which
    // is not a route — so before this branch existed the guard could only ever
    // no-op on exactly the pools that need it (any *-SOL pair, where token_y is
    // SOL). Wrapping is also strictly cheaper than a swap: no route, no slippage,
    // and the lamports stay yours the whole time.
    if (args.quoteMint === WSOL_MINT) {
      const result = await sender.sendInstructions(client.wrapSolIxs(lamports), [wallet], "wrap SOL buffer");
      if (!result.signature) return { balanceUsd, low: true };
      log.info(
        { balanceUsd, floor, wrappedSol: plan.wantSol, signature: result.signature },
        "wrapped SOL into the wSOL buffer",
      );
      return { balanceUsd, toppedUpUsd: plan.wantUsd, low: false };
    }

    const quote = await swapper.quote({
      inputMint: WSOL_MINT,
      outputMint: args.quoteMint,
      amount: new BN(lamports),
    });
    const tx = await swapper.buildTransaction(quote, wallet);
    const result = await sender.sendVersioned(tx, `top up ${args.quoteSymbol} buffer`);
    if (!result.signature) return { balanceUsd, low: true };
    log.info(
      { balanceUsd, floor, toppedUpUsd: plan.wantUsd, symbol: args.quoteSymbol, signature: result.signature },
      "topped up the quote-token buffer",
    );
    return { balanceUsd, toppedUpUsd: plan.wantUsd, low: false };
  } catch (e) {
    // Worth a warning, not a failure: the rebalance may not need the buffer at all.
    log.warn(
      { err: e instanceof Error ? e.message : String(e), balanceUsd, floor },
      "quote-token top-up failed — continuing, the rebalance may still succeed",
    );
    return { balanceUsd, low: true };
  }
}

/**
 * Phase 2 of path B. Returns what actually landed in the wallet.
 *
 * Exported for tests: the retry count and what it refuses to retry are the risk here.
 */
export async function runSwapLeg(
  deps: RebalanceDeps,
  entry: JournalEntry,
  plan: RebalancePlan,
  amountIn: BN,
): Promise<{ result: SendResult; received: BN }> {
  const { cfg, client, sender, swapper, store, log } = deps;
  const wallet = client.requireWallet();
  const pool = await client.getPool(plan.poolAddress);
  const toMint = new PublicKey(plan.swap!.toMint);
  const toProgram = toMint.equals(pool.tokenX.publicKey) ? pool.tokenX.owner : pool.tokenY.owner;

  // Read once. A re-quoted attempt only happens when the previous one was never
  // broadcast, so the balance cannot have moved underneath us.
  const before = await client.tokenBalance(toMint, toProgram);
  const label = `swap ${plan.swap!.fromSymbol}->${plan.swap!.toSymbol}`;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= SWAP_QUOTE_ATTEMPTS; attempt++) {
    const quote = await swapper.quote({
      inputMint: plan.swap!.fromMint,
      outputMint: plan.swap!.toMint,
      amount: amountIn,
    });
    log.info(
      {
        journalId: entry.id,
        route: quote.route,
        in: amountIn.toString(),
        out: quote.outAmount.toString(),
        priceImpactBps: quote.priceImpactBps,
        ...(attempt > 1 ? { attempt } : {}),
      },
      "swap quoted",
    );

    // Refuse a bad route before anything is signed, so this costs a quote and no
    // fee. Distinct from slippage tolerance: that is movement we accept on a route
    // already chosen, this is whether the route is worth taking at all. Not
    // re-quoted either — impact is a property of current liquidity, so an
    // immediate retry would quote the same wall. The withdrawn funds stay in the
    // wallet and the entry is retried on a later tick, by which point impact may
    // have recovered.
    if (quote.priceImpactBps > cfg.maxSwapPriceImpactBps) {
      throw new Error(
        `swap price impact ${quote.priceImpactBps}bps exceeds MAX_SWAP_PRICE_IMPACT_BPS ` +
          `(${cfg.maxSwapPriceImpactBps}bps) — refusing the ${plan.swap!.fromSymbol}->` +
          `${plan.swap!.toSymbol} route. Nothing was sent; the withdrawn funds are in the wallet ` +
          "and this rebalance is retried automatically.",
      );
    }

    const tx = await swapper.buildTransaction(quote, wallet);
    try {
      const result = await sender.sendVersioned(tx, label);
      store.updateJournal(entry.id, {
        swap: {
          inMint: plan.swap!.fromMint,
          outMint: plan.swap!.toMint,
          inAmount: amountIn.toString(),
          outAmount: quote.outAmount.toString(),
          sig: result.signature,
        },
      });

      if (!result.signature) return { result, received: new BN(0) };

      // Measure rather than trust the quote — the realised output is what matters
      // to the deposit that follows.
      const after = await client.tokenBalance(toMint, toProgram);
      return { result, received: BN.max(new BN(0), after.sub(before)) };
    } catch (e) {
      lastErr = e;
      if (attempt >= SWAP_QUOTE_ATTEMPTS || !isRequotableSwapFailure(e)) throw e;
      log.warn(
        {
          journalId: entry.id,
          attempt,
          route: quote.route,
          err: e instanceof Error ? e.message : String(e),
        },
        "swap failed at simulation on slippage — re-quoting",
      );
      await delay(SWAP_REQUOTE_DELAY_MS);
    }
  }
  throw lastErr;
}

/** Phase 3 of path B: single-sided deposit of the swap proceeds into the new range. */
async function depositProceeds(
  deps: RebalanceDeps,
  entry: JournalEntry,
  plan: RebalancePlan,
  received: BN,
): Promise<SendResult[]> {
  const { client, sender, log } = deps;
  if (received.isZero()) {
    log.warn({ journalId: entry.id }, "swap produced nothing to deposit");
    return [];
  }

  const wallet = client.requireWallet();
  const pool = await client.getPool(plan.poolAddress, { fresh: true });
  const position = new PublicKey(plan.positionPk);
  const { positionData } = await pool.getPosition(position);
  const toIsX = new PublicKey(plan.swap!.toMint).equals(pool.tokenX.publicKey);

  // Deposit over the position's CURRENT range — phase 1 already moved it to the
  // target, and reading it back means a re-centre that landed slightly off
  // (active bin drift) is still deposited into the range that actually exists.
  const tx = await pool.addLiquidityByStrategy({
    positionPubKey: position,
    user: wallet.publicKey,
    totalXAmount: toIsX ? received : new BN(0),
    totalYAmount: toIsX ? new BN(0) : received,
    strategy: {
      minBinId: positionData.lowerBinId,
      maxBinId: positionData.upperBinId,
      strategyType: StrategyType[plan.strategyType],
    },
  });

  return [await sender.send(tx, [wallet], "rebalance (deposit leg)")];
}

// ----------------------------------------------------------------- resume ----

/**
 * Finishes rebalances that were interrupted. Called once at boot.
 *
 * Nothing here assumes a transaction landed just because it was journalled —
 * on-chain and wallet state are re-read and the entry is resumed from what is
 * actually true. Without this, a crash between the withdraw and the deposit
 * strands the funds in the wallet with the position sitting half-empty.
 */
export async function resumeJournal(
  deps: RebalanceDeps,
  opts: { minAgeMs?: number } = {},
): Promise<void> {
  const { store, client, log } = deps;
  // Boot passes nothing and resumes everything at once. The engine tick passes an
  // age so a permanently-stuck entry — a route whose price impact stays too high,
  // say — is retried periodically rather than on every single tick.
  const minAgeMs = opts.minAgeMs ?? 0;
  const now = Date.now();
  const pending = store.pendingJournal().filter((j) => now - j.updatedAt >= minAgeMs);
  if (pending.length === 0) return;

  log.warn({ count: pending.length }, "resuming unfinished rebalances");

  // How many pending entries target each position. More than one and a range
  // change can no longer be attributed to any single entry — see legLanded.
  const pendingPerPosition = new Map<string, number>();
  for (const e of pending) {
    pendingPerPosition.set(e.positionPk, (pendingPerPosition.get(e.positionPk) ?? 0) + 1);
  }

  for (const entry of pending) {
    try {
      if (!client.wallet()) {
        log.error({ journalId: entry.id }, "cannot resume without a wallet");
        continue;
      }

      const pool = await client.getPool(entry.poolAddress, { fresh: true });
      let positionData: PositionData;
      try {
        ({ positionData } = await pool.getPosition(new PublicKey(entry.positionPk)));
      } catch (e) {
        // The account this entry was resuming toward is gone — closed via Exit,
        // or replaced by a fresh open under the same pool. There is nothing left
        // to finish: any funds that were mid-flight either landed in the wallet
        // (check the balance) or were already swept into whatever position
        // exists now. Retrying forever is worse than surfacing that plainly, so
        // this is terminal rather than another `error`-only update that leaves
        // it "pending" indefinitely.
        store.updateJournal(entry.id, {
          phase: "failed",
          error: `target position no longer exists (${e instanceof Error ? e.message : String(e)}) — ` +
            "any in-flight funds are either back in the wallet or already in a newer position; check balances manually",
        });
        log.warn({ journalId: entry.id, positionPk: entry.positionPk }, "resume target position gone — marked failed");
        continue;
      }
      const landed = legLanded(entry, positionData, {
        ambiguous: (pendingPerPosition.get(entry.positionPk) ?? 0) > 1,
      });

      if (entry.phase === "atomic") {
        // One instruction: either it landed or nothing happened. Either way
        // there is nothing half-done to finish.
        store.updateJournal(entry.id, { phase: landed ? "done" : "failed", error: entry.error ?? "interrupted" });
        log.warn({ journalId: entry.id, landed }, "atomic rebalance resolved from chain state");
        continue;
      }

      if (entry.phase === "withdraw" && !landed) {
        // The withdraw leg never landed, so no funds are stranded. Drop it and
        // let the normal trigger re-plan against current prices.
        store.updateJournal(entry.id, { phase: "failed", error: "withdraw leg did not land; re-planning" });
        log.warn({ journalId: entry.id }, "withdraw leg never landed — nothing to resume");
        continue;
      }

      // From here the re-centre landed (at the target, or near it after drift)
      // and the surplus is sitting in the wallet. Re-plan the remaining legs
      // from actual balances. Note the fresh plan will usually have NO swap leg:
      // the surplus is out of the position, so the position now reads balanced.
      // That is why the mints below come from the journal first, not the plan.
      const plan = await planRebalance(deps, {
        positionPk: entry.positionPk,
        poolAddress: entry.poolAddress,
        strategyType: entry.strategyType,
      });

      // Which token is stranded. `new PublicKey("")` throws, and the generic
      // catch below sets only `error` — never `phase` — so an unidentifiable
      // entry used to retry identically on every boot and stay pending forever.
      // Terminal, with instructions, instead.
      const inMint = entry.swap?.inMint || plan.swap?.fromMint;
      const outMint = entry.swap?.outMint || plan.swap?.toMint;
      if (!inMint || !outMint) {
        store.updateJournal(entry.id, {
          phase: "failed",
          error:
            "the withdraw leg landed but the swap direction was never journalled — the withdrawn " +
            "surplus is sitting in the wallet; re-deposit it with POST /api/positions/" +
            `${entry.positionPk}/add`,
        });
        log.error(
          { journalId: entry.id, positionPk: entry.positionPk },
          "resume: swap direction unknown — marked failed, surplus is in the wallet",
        );
        continue;
      }

      // Everything this resume sends, so the signatures and the fees they cost
      // can be recorded rather than thrown away.
      const resumeResults: SendResult[] = [];

      if (entry.phase === "withdraw" || entry.phase === "swap") {
        const fromMint = new PublicKey(inMint);
        const fromProgram = fromMint.equals(pool.tokenX.publicKey) ? pool.tokenX.owner : pool.tokenY.owner;
        const available = await client.tokenBalance(fromMint, fromProgram);
        const intended = new BN(entry.swap?.inAmount ?? "0");
        // An unjournalled amount used to fall back to `available` — "swap
        // everything we can see". That is not a safe proxy for "what this
        // rebalance withdrew": `tokenBalance` folds native SOL above the
        // MIN_SOL_BALANCE reserve into the wSOL balance (client.ts), so for a
        // wSOL leg `available` is very nearly the whole wallet, and even for a
        // non-wSOL leg it includes the idle quote buffer `ensureQuoteBuffer`
        // deliberately parks there. Refuse and tell the operator instead.
        if (intended.isZero()) {
          store.updateJournal(entry.id, {
            phase: "failed",
            error:
              "the withdraw leg landed but the amount to swap was never journalled — the withdrawn " +
              "surplus is sitting in the wallet; re-deposit it with POST /api/positions/" +
              `${entry.positionPk}/add`,
          });
          log.error(
            { journalId: entry.id, positionPk: entry.positionPk, mint: inMint },
            "resume: swap amount unknown — marked failed, surplus is in the wallet",
          );
          continue;
        }
        // Swap the smaller of what we meant to move and what is actually there,
        // so a partially-completed swap is not double-spent.
        const amount = BN.min(intended, available);
        if (amount.isZero()) {
          store.updateJournal(entry.id, { phase: "failed", error: "nothing left to swap on resume" });
          continue;
        }
        store.updateJournal(entry.id, { phase: "swap" });
        const swapResult = await runSwapLeg(deps, entry, planWithSwapFrom(plan, entry), amount);
        resumeResults.push(swapResult.result);
        store.updateJournal(entry.id, { phase: "deposit" });
        resumeResults.push(
          ...(await depositProceeds(deps, entry, planWithSwapFrom(plan, entry), swapResult.received)),
        );
      } else if (entry.phase === "deposit") {
        const toMint = new PublicKey(outMint);
        const toProgram = toMint.equals(pool.tokenX.publicKey) ? pool.tokenX.owner : pool.tokenY.owner;
        const available = await client.tokenBalance(toMint, toProgram);
        const intended = new BN(entry.swap?.outAmount ?? "0");
        // Same refusal as the swap branch above, for the same reason: `available`
        // includes native SOL above the reserve for wSOL and the idle quote
        // buffer otherwise, so it cannot stand in for the swap's proceeds.
        if (intended.isZero()) {
          store.updateJournal(entry.id, {
            phase: "failed",
            error:
              "the swap leg landed but the amount it produced was never journalled — the swap " +
              "proceeds are sitting in the wallet; re-deposit them with POST /api/positions/" +
              `${entry.positionPk}/add`,
          });
          log.error(
            { journalId: entry.id, positionPk: entry.positionPk, mint: outMint },
            "resume: deposit amount unknown — marked failed, proceeds are in the wallet",
          );
          continue;
        }
        const amount = BN.min(intended, available);
        resumeResults.push(...(await depositProceeds(deps, entry, planWithSwapFrom(plan, entry), amount)));
      }

      await finishResumed(deps, entry, resumeResults);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      store.updateJournal(entry.id, { error: `resume failed: ${message}` });
      log.error({ journalId: entry.id, err: message }, "resume failed — funds may be sitting in the wallet");
    }
  }
}

/**
 * Whether a journalled rebalance leg actually landed on chain.
 *
 * The position's range is the only honest evidence, but it has to be compared
 * against where the position STARTED, not against the plan's target.
 * `simulateRebalancePositionWithBalancedStrategy` re-centres on the active bin
 * as of the send, which drifts from the bin the plan was computed on — several
 * RPC round-trips earlier, and one bin is only 0.04% at bin step 4. Comparing
 * against the target reads a perfectly good landed leg as "never landed" the
 * moment price moves, which for path B closes the entry and strands the
 * withdrawn surplus in the wallet.
 *
 * Entries journalled before source bins were recorded fall back to the exact
 * target comparison rather than guessing from data that isn't there.
 */
export function legLanded(
  entry: Pick<
    JournalEntry,
    "targetMinBinId" | "targetMaxBinId" | "sourceMinBinId" | "sourceMaxBinId" | "sigs"
  >,
  positionData: Pick<PositionData, "lowerBinId" | "upperBinId">,
  opts: { ambiguous?: boolean } = {},
): boolean {
  // Positive proof, and it outranks any inference: signatures are journalled
  // only after every send in the leg has returned, so one being present means
  // the leg completed. A leg that threw — at simulation or on chain — never
  // reaches that write, and a transaction that failed on chain changed no state
  // anyway, so the range is untouched either way.
  if (entry.sigs.length > 0) return true;

  // Without a signature the only remaining evidence is the range, and that is
  // circumstantial: it says the position moved, not WHO moved it. With two
  // pending entries against the same position — a failed attempt followed by a
  // successful retry — the retry's landed withdraw moves the range, and the
  // failed entry would read that as its own and go on to spend the retry's
  // stranded funds. Seen live on 2026-07-29. Refuse to guess.
  if (opts.ambiguous) return false;

  if (entry.sourceMinBinId !== undefined && entry.sourceMaxBinId !== undefined) {
    return (
      positionData.lowerBinId !== entry.sourceMinBinId || positionData.upperBinId !== entry.sourceMaxBinId
    );
  }
  return positionData.lowerBinId === entry.targetMinBinId && positionData.upperBinId === entry.targetMaxBinId;
}

/**
 * Closes out a resumed entry.
 *
 * Three things the resume path used to drop on the floor:
 *
 * - The signatures it produced. `sigs` kept only the legs from before the
 *   interruption, so the transaction that actually completed the recovery
 *   appeared nowhere in the journal and had to be dug out of the app log.
 * - The stale `error`. Marking `phase: "done"` left the failure text that
 *   stranded the entry in place, so a recovered rebalance renders in the
 *   dashboard as though it had failed.
 * - The cost ledger entry. A resumed rebalance was never passed to
 *   `recordRebalance`, so its fees went uncounted in METRICS and — worse —
 *   `lastRebalanceAt` stayed stale, leaving the cooldown guard blind to a
 *   rebalance that had just happened.
 */
async function finishResumed(
  deps: RebalanceDeps,
  entry: JournalEntry,
  results: SendResult[],
): Promise<void> {
  const { store, log } = deps;
  const newSigs = sigsOf(results);
  const allSigs = [...entry.sigs, ...newSigs];

  store.updateJournal(entry.id, { phase: "done", sigs: allSigs, error: undefined });

  if (newSigs.length === 0) {
    // Dry-run, or there was nothing left to move. Either way it did not happen,
    // so it must not enter the ledger or start a cooldown.
    log.warn({ journalId: entry.id }, "rebalance resumed with nothing to send — not recorded");
    return;
  }

  // Priced across ALL the legs, including the ones that landed before the
  // interruption: those fees were really paid, and charging only the resumed
  // portion is what kept costUsd understated.
  const costLamports = await sumFees(deps, allSigs);
  store.recordRebalance({
    ts: Date.now(),
    positionPk: entry.positionPk,
    poolAddress: entry.poolAddress,
    path: entry.path,
    fromRange: [entry.sourceMinBinId ?? entry.targetMinBinId, entry.sourceMaxBinId ?? entry.targetMaxBinId],
    toRange: [entry.targetMinBinId, entry.targetMaxBinId],
    costLamports,
    rentLamports: entry.rentLamports ?? 0,
    sigs: allSigs,
  });
  log.warn({ journalId: entry.id, sigs: newSigs, costLamports }, "rebalance resumed and completed");
}

/** Fees actually paid across a set of signatures. Best effort — a miss adds 0. */
async function sumFees(deps: RebalanceDeps, sigs: string[]): Promise<number> {
  let total = 0;
  for (const sig of sigs) {
    try {
      const tx = await deps.client.connection.getTransaction(sig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      total += tx?.meta?.fee ?? 0;
    } catch {
      /* a fee lookup must never fail a completed recovery */
    }
  }
  return total;
}

/** Uses the journalled swap direction, which is what the stranded funds match. */
function planWithSwapFrom(plan: RebalancePlan, entry: JournalEntry): RebalancePlan {
  if (!entry.swap) return plan;
  return {
    ...plan,
    swap: {
      fromMint: entry.swap.inMint,
      toMint: entry.swap.outMint,
      fromSymbol: plan.swap?.fromSymbol ?? "in",
      toSymbol: plan.swap?.toSymbol ?? "out",
      xWithdrawBps: 0,
      yWithdrawBps: 0,
      valueUsd: 0,
    },
  };
}

// ---------------------------------------------------------------- helpers ----

/**
 * Decides whether a swap leg is needed and how much of the oversupplied side to
 * withdraw for it.
 *
 * A symmetric range around the active bin wants roughly equal value per side,
 * so the surplus is whatever one side holds above half the total. The withdraw
 * is expressed in bps *of that side*, which is what the SDK's balanced strategy
 * takes: the remainder is redeposited into the re-centred range and only the
 * withdrawn part reaches the wallet to be swapped.
 *
 * Returns null when the position is already close enough to balanced, in which
 * case the cheaper single atomic rebalance is used instead.
 */
export function planSwapLeg(
  value: { valueX: number; valueY: number; total: number; ratioBps: number },
  opts: { ratioToleranceBps: number; maxSwapPctOfPosition: number },
): { surplusIsX: boolean; withdrawBps: number; swapValueInY: number } | null {
  if (!(value.total > 0)) return null;
  if (Math.abs(value.ratioBps - 5_000) <= opts.ratioToleranceBps) return null;

  const surplusIsX = value.valueX > value.valueY;
  const sideValueInY = surplusIsX ? value.valueX : value.valueY;
  const surplusValueInY = sideValueInY - value.total / 2;
  if (!(surplusValueInY > 0) || !(sideValueInY > 0)) return null;

  // Never move more than the configured share of the position in one go.
  const capValueInY = (value.total * opts.maxSwapPctOfPosition) / 100;
  const swapValueInY = Math.min(surplusValueInY, capValueInY);
  const withdrawBps = Math.max(0, Math.min(10_000, Math.round((swapValueInY / sideValueInY) * 10_000)));
  if (withdrawBps === 0) return null;

  return { surplusIsX, withdrawBps, swapValueInY };
}

/**
 * The range the SDK's balanced strategy will produce, re-centred on the active
 * bin. Mirrors `BalancedStrategyBuilder` so the plan can be shown and
 * cost-checked before anything is simulated on chain.
 *
 * Note the SDK does NOT preserve an even width: it splits floor(width/2) per
 * side and then gives the extra bin to the bid side, so a 10-bin position comes
 * back 11 bins wide (6 below the active bin, 4 above, plus the active bin).
 * Odd widths are symmetric and stable, so a position widens by one bin on its
 * first rebalance and never again.
 */
export function balancedTargetRange(
  positionData: Pick<PositionData, "lowerBinId" | "upperBinId">,
  activeBinId: number,
): [number, number] {
  const width = positionData.upperBinId - positionData.lowerBinId + 1;
  const perSide = Math.floor(width / 2);
  let binPerAsk = perSide;
  let binPerBid = perSide;
  if (width % 2 === 0) {
    binPerAsk -= 1;
    binPerBid += 1;
  }
  return [activeBinId - binPerBid, activeBinId + binPerAsk];
}

/** Rent for bin arrays the new range needs but the pool has not initialized yet. */
async function estimateRentLamports(
  deps: RebalanceDeps,
  pool: DlmmPool,
  positionData: PositionData,
  targetRange: [number, number],
  strategyType: StrategyTypeName,
): Promise<number> {
  try {
    const quote = await pool.quoteCreatePosition({
      strategy: { minBinId: targetRange[0], maxBinId: targetRange[1], strategyType: StrategyType[strategyType] },
    });
    // The position account itself already exists — only new bin arrays and a
    // possible bitmap extension cost anything on a re-centre.
    return Math.round((quote.binArrayCost + quote.bitmapExtensionCost) * LAMPORTS_PER_SOL);
  } catch {
    void positionData;
    void deps;
    return 0;
  }
}

function sigsOf(results: SendResult[]): string[] {
  return results.map((r) => r.signature).filter((s): s is string => Boolean(s));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

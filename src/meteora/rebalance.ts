import BN from "bn.js";
import { randomUUID } from "node:crypto";
import { LAMPORTS_PER_SOL, PublicKey, Transaction } from "@solana/web3.js";
import type { Config, StrategyTypeName } from "../config.js";
import type { Logger } from "../logger.js";
import type { JournalEntry, Store } from "../state.js";
import type { DataApi } from "./datapi.js";
import type { MeteoraClient } from "./client.js";
import type { TxSender, SendResult } from "../tx/send.js";
import type { JupiterSwap } from "../swap/jupiter.js";
import { StrategyType, type DlmmPool, type PositionData } from "./sdk.js";
import { priceOfBin, toUi, valuePosition } from "./pricing.js";

export interface RebalanceDeps {
  cfg: Config;
  client: MeteoraClient;
  dataApi: DataApi;
  sender: TxSender;
  swapper: JupiterSwap;
  store: Store;
  log: Logger;
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

  const entry: JournalEntry = {
    id: randomUUID(),
    positionPk: plan.positionPk,
    poolAddress: plan.poolAddress,
    path: plan.path,
    phase: plan.path === "A" ? "atomic" : "withdraw",
    targetMinBinId: plan.targetRange[0],
    targetMaxBinId: plan.targetRange[1],
    strategyType: plan.strategyType,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    sigs: [],
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
    await sender.send(new Transaction().add(...rebalancePositionInstruction), [wallet], "rebalance (atomic)"),
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
    await sender.send(new Transaction().add(...rebalancePositionInstruction), [wallet], "rebalance (withdraw leg)"),
  );
  deps.store.updateJournal(entry.id, { sigs: sigsOf(results) });
  return results;
}

/** Phase 2 of path B. Returns what actually landed in the wallet. */
async function runSwapLeg(
  deps: RebalanceDeps,
  entry: JournalEntry,
  plan: RebalancePlan,
  amountIn: BN,
): Promise<{ result: SendResult; received: BN }> {
  const { client, sender, swapper, store, log } = deps;
  const wallet = client.requireWallet();
  const pool = await client.getPool(plan.poolAddress);
  const toMint = new PublicKey(plan.swap!.toMint);
  const toProgram = toMint.equals(pool.tokenX.publicKey) ? pool.tokenX.owner : pool.tokenY.owner;

  const before = await client.tokenBalance(toMint, toProgram);
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
    },
    "swap quoted",
  );

  const tx = await swapper.buildTransaction(quote, wallet);
  const result = await sender.sendVersioned(tx, `swap ${plan.swap!.fromSymbol}->${plan.swap!.toSymbol}`);
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

  // Measure rather than trust the quote — dynamic slippage means the realised
  // output is what matters to the deposit that follows.
  const after = await client.tokenBalance(toMint, toProgram);
  const received = BN.max(new BN(0), after.sub(before));
  return { result, received };
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
export async function resumeJournal(deps: RebalanceDeps): Promise<void> {
  const { store, client, log } = deps;
  const pending = store.pendingJournal();
  if (pending.length === 0) return;

  log.warn({ count: pending.length }, "resuming unfinished rebalances");

  for (const entry of pending) {
    try {
      if (!client.wallet()) {
        log.error({ journalId: entry.id }, "cannot resume without a wallet");
        continue;
      }

      const pool = await client.getPool(entry.poolAddress, { fresh: true });
      const { positionData } = await pool.getPosition(new PublicKey(entry.positionPk));
      const atTarget =
        positionData.lowerBinId === entry.targetMinBinId && positionData.upperBinId === entry.targetMaxBinId;

      if (entry.phase === "atomic") {
        // One instruction: either it landed (position is at the target) or
        // nothing happened. Either way there is nothing half-done to finish.
        store.updateJournal(entry.id, { phase: atTarget ? "done" : "failed", error: entry.error ?? "interrupted" });
        log.warn({ journalId: entry.id, landed: atTarget }, "atomic rebalance resolved from chain state");
        continue;
      }

      if (entry.phase === "withdraw" && !atTarget) {
        // The withdraw leg never landed, so no funds are stranded. Drop it and
        // let the normal trigger re-plan against current prices.
        store.updateJournal(entry.id, { phase: "failed", error: "withdraw leg did not land; re-planning" });
        log.warn({ journalId: entry.id }, "withdraw leg never landed — nothing to resume");
        continue;
      }

      // From here the position is at its target range and the surplus is sitting
      // in the wallet. Re-plan the remaining legs from actual balances.
      const plan = await planRebalance(deps, {
        positionPk: entry.positionPk,
        poolAddress: entry.poolAddress,
        strategyType: entry.strategyType,
      });

      if (entry.phase === "withdraw" || entry.phase === "swap") {
        const fromMint = new PublicKey(entry.swap?.inMint ?? plan.swap?.fromMint ?? "");
        const fromProgram = fromMint.equals(pool.tokenX.publicKey) ? pool.tokenX.owner : pool.tokenY.owner;
        const available = await client.tokenBalance(fromMint, fromProgram);
        const intended = new BN(entry.swap?.inAmount ?? "0");
        // Swap the smaller of what we meant to move and what is actually there,
        // so a partially-completed swap is not double-spent.
        const amount = intended.isZero() ? available : BN.min(intended, available);
        if (amount.isZero()) {
          store.updateJournal(entry.id, { phase: "failed", error: "nothing left to swap on resume" });
          continue;
        }
        store.updateJournal(entry.id, { phase: "swap" });
        const swapResult = await runSwapLeg(deps, entry, planWithSwapFrom(plan, entry), amount);
        store.updateJournal(entry.id, { phase: "deposit" });
        await depositProceeds(deps, entry, planWithSwapFrom(plan, entry), swapResult.received);
      } else if (entry.phase === "deposit") {
        const toMint = new PublicKey(entry.swap?.outMint ?? "");
        const toProgram = toMint.equals(pool.tokenX.publicKey) ? pool.tokenX.owner : pool.tokenY.owner;
        const available = await client.tokenBalance(toMint, toProgram);
        const intended = new BN(entry.swap?.outAmount ?? "0");
        const amount = intended.isZero() ? available : BN.min(intended, available);
        await depositProceeds(deps, entry, planWithSwapFrom(plan, entry), amount);
      }

      store.updateJournal(entry.id, { phase: "done" });
      log.warn({ journalId: entry.id }, "rebalance resumed and completed");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      store.updateJournal(entry.id, { error: `resume failed: ${message}` });
      log.error({ journalId: entry.id, err: message }, "resume failed — funds may be sitting in the wallet");
    }
  }
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

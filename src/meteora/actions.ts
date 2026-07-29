import BN from "bn.js";
import { Keypair, PublicKey } from "@solana/web3.js";
import type { Config, StrategyTypeName } from "../config.js";
import type { Logger } from "../logger.js";
import type { Store } from "../state.js";
import type { MeteoraClient } from "./client.js";
import type { TxSender, SendResult } from "../tx/send.js";
import { DEFAULT_BIN_PER_POSITION, StrategyType, type DlmmPool } from "./sdk.js";
import { priceOfBin, rangeAround, toRaw, toUi } from "./pricing.js";

export interface ActionDeps {
  cfg: Config;
  client: MeteoraClient;
  sender: TxSender;
  store: Store;
  log: Logger;
}

export interface OpenParams {
  poolAddress: string;
  /** Human units. At least one must be > 0. */
  xAmount: number;
  yAmount: number;
  rangeBins?: number;
  strategyType?: StrategyTypeName;
  /** Enroll the new position in auto-rebalancing straight away. */
  auto?: boolean;
}

export interface OpenResult {
  positionPk: string;
  poolAddress: string;
  minBinId: number;
  maxBinId: number;
  minPrice: number;
  maxPrice: number;
  activeBinId: number;
  results: SendResult[];
  managed: boolean;
}

/**
 * Opens a position centred on the current active bin and deposits into it.
 *
 * The position account is a fresh keypair that co-signs, so the address is only
 * real once the transaction lands — in dry-run nothing is persisted, because
 * recording a position that does not exist would leave the engine polling a
 * phantom.
 *
 * `initializePosition` can only size an account up to `DEFAULT_BIN_PER_POSITION`
 * (70) bins in one call — asking it for more fails on chain with "Failed to
 * reallocate account data". Wider ranges (anything past a couple of percent on
 * a tight-bin-step pool) need the base account created at that width first,
 * then grown with explicit `increasePositionLength` instructions before any
 * deposit — that's what `createExtendedEmptyPosition` does. So this splits into
 * two transactions once the requested width exceeds the single-call limit:
 * create+extend the (empty) position, then deposit into it.
 */
export async function openPosition(deps: ActionDeps, params: OpenParams): Promise<OpenResult> {
  const { cfg, client, sender, store, log } = deps;
  const wallet = client.requireWallet();
  await client.assertSolFunded();

  if (!(params.xAmount > 0) && !(params.yAmount > 0)) {
    throw new Error("deposit at least one of the two tokens");
  }

  const rangeBins = params.rangeBins ?? cfg.rangeBins;
  const strategyName = params.strategyType ?? cfg.strategyType;
  const pool = await client.getPool(params.poolAddress, { fresh: true });
  const activeBinId = pool.lbPair.activeId;
  const { minBinId, maxBinId } = rangeAround(activeBinId, rangeBins);
  const width = maxBinId - minBinId + 1;

  const totalXAmount = toRaw(params.xAmount, pool.tokenX.mint.decimals);
  const totalYAmount = toRaw(params.yAmount, pool.tokenY.mint.decimals);
  await assertFunded(deps, pool, totalXAmount, totalYAmount);

  const positionKp = Keypair.generate();
  const positionPk = positionKp.publicKey.toBase58();
  const label = `open ${params.poolAddress.slice(0, 6)}`;
  const results: SendResult[] = [];

  if (width <= DEFAULT_BIN_PER_POSITION.toNumber()) {
    // Fits in one call: create the account at its final size and deposit in
    // the same transaction.
    const tx = await pool.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: positionKp.publicKey,
      user: wallet.publicKey,
      totalXAmount,
      totalYAmount,
      strategy: { minBinId, maxBinId, strategyType: StrategyType[strategyName] },
    });
    results.push(await sender.send(tx, [wallet, positionKp], label));
  } else {
    // Leg 1: create the position at its full width (base account + extend
    // instructions), still empty.
    //
    // `createExtendedEmptyPosition` chunks the extend into MAX_RESIZE_LENGTH
    // (91-bin) instructions but returns them all as ONE Transaction, which
    // assumes they fit Solana's ~1232-byte transaction size limit. That holds
    // comfortably up to a few chunks (RANGE_BINS in the hundreds); an
    // extremely wide position (approaching MAX_RANGE_BINS) could in principle
    // need more chunks than one transaction can carry. Unverified past that
    // point — multi-position support was deliberately deferred (see
    // MAX_RANGE_BINS in config.ts), and this inherits the same boundary.
    const createTx = await pool.createExtendedEmptyPosition(
      minBinId,
      maxBinId,
      positionKp.publicKey,
      wallet.publicKey,
    );
    const createResult = await sender.send(createTx, [wallet, positionKp], `${label} (create)`);
    results.push(createResult);

    if (createResult.signature) {
      // Landed for real — the account exists on chain now, deposit into it.
      client.invalidate(params.poolAddress);
      const freshPool = await client.getPool(params.poolAddress, { fresh: true });
      try {
        const depositTx = await freshPool.addLiquidityByStrategy({
          positionPubKey: positionKp.publicKey,
          user: wallet.publicKey,
          totalXAmount,
          totalYAmount,
          strategy: { minBinId, maxBinId, strategyType: StrategyType[strategyName] },
        });
        results.push(await sender.send(depositTx, [wallet], `${label} (deposit)`));
      } catch (e) {
        // The position exists but holds nothing — say so explicitly, with the
        // pubkey, so it isn't just a dangling rent-paying account nobody knows
        // about. The existing /add endpoint can retry the deposit as-is.
        log.error(
          { positionPk, err: e instanceof Error ? e.message : String(e) },
          "position created but deposit failed — retry via POST /api/positions/:pk/add",
        );
        throw new Error(
          `position ${positionPk} was created but the deposit failed: ` +
            `${e instanceof Error ? e.message : String(e)}. Retry the deposit with ` +
            `POST /api/positions/${positionPk}/add — the position itself is fine, just empty.`,
        );
      }
    } else {
      // DRY-RUN: only the create+extend leg can be simulated. The deposit
      // can't be — it targets an account that doesn't exist yet on chain
      // because dry-run sent nothing — so simulating it would just fail with
      // "account not found", which is a false alarm, not a real problem.
      log.info(
        { positionPk },
        "DRY-RUN: create+extend simulated ok; deposit leg not simulated (position doesn't exist yet in dry-run)",
      );
    }
  }

  client.invalidate(params.poolAddress);
  // Only the LAST leg tells us whether the position actually holds liquidity —
  // for the two-tx path that's the deposit, not the create.
  const persisted = Boolean(results.at(-1)?.signature);
  if (persisted) {
    store.upsertPosition({
      positionPk,
      poolAddress: params.poolAddress,
      auto: params.auto ?? false,
      rangeBins,
      // Only an EXPLICIT choice becomes a per-position override — unlike
      // rangeBins (fixed for good at creation), strategyType governs every
      // future rebalance's redeposit shape and must keep tracking the live
      // global default unless the caller deliberately pinned it. Storing the
      // resolved `strategyName` here instead of `params.strategyType` would
      // silently freeze this position on whatever the default happened to be
      // at open time, immune to later Settings changes.
      strategyType: params.strategyType,
      openedAt: Date.now(),
      rebalanceCount: 0,
      pollsTotal: 0,
      pollsInRange: 0,
    });
  }

  log.info(
    { positionPk, poolAddress: params.poolAddress, minBinId, maxBinId, width, dryRun: results.at(-1)?.dryRun },
    "position opened",
  );

  return {
    positionPk,
    poolAddress: params.poolAddress,
    minBinId,
    maxBinId,
    minPrice: priceOfBin(pool, minBinId),
    maxPrice: priceOfBin(pool, maxBinId),
    activeBinId,
    results,
    managed: persisted && Boolean(params.auto),
  };
}

/** Adds liquidity to an existing position, over its current bin range. */
export async function addLiquidity(
  deps: ActionDeps,
  params: { poolAddress: string; positionPk: string; xAmount: number; yAmount: number },
): Promise<SendResult[]> {
  const { cfg, client, sender, log } = deps;
  const wallet = client.requireWallet();
  await client.assertSolFunded();

  if (!(params.xAmount > 0) && !(params.yAmount > 0)) {
    throw new Error("deposit at least one of the two tokens");
  }

  const pool = await client.getPool(params.poolAddress, { fresh: true });
  const position = new PublicKey(params.positionPk);
  const { positionData } = await pool.getPosition(position);

  const totalXAmount = toRaw(params.xAmount, pool.tokenX.mint.decimals);
  const totalYAmount = toRaw(params.yAmount, pool.tokenY.mint.decimals);
  await assertFunded(deps, pool, totalXAmount, totalYAmount);

  // Deposit over the position's existing range — widening it is a resize, which
  // this action deliberately does not do.
  const tx = await pool.addLiquidityByStrategy({
    positionPubKey: position,
    user: wallet.publicKey,
    totalXAmount,
    totalYAmount,
    strategy: {
      minBinId: positionData.lowerBinId,
      maxBinId: positionData.upperBinId,
      strategyType: StrategyType[cfg.strategyType],
    },
  });

  const results = await sender.sendAll([tx], [wallet], `add ${params.positionPk.slice(0, 6)}`);
  client.invalidate(params.poolAddress);
  log.info({ positionPk: params.positionPk, dryRun: results[0]?.dryRun }, "liquidity added");
  return results;
}

/** Claims swap fees and LM rewards for one position, leaving it open. */
export async function claimFees(
  deps: ActionDeps,
  params: { poolAddress: string; positionPk: string },
): Promise<SendResult[]> {
  const { client, sender, log } = deps;
  const wallet = client.requireWallet();
  await client.assertSolFunded();

  const pool = await client.getPool(params.poolAddress, { fresh: true });
  const position = await pool.getPosition(new PublicKey(params.positionPk));

  const hasFees = !position.positionData.feeX.isZero() || !position.positionData.feeY.isZero();
  const hasRewards = !position.positionData.rewardOne.isZero() || !position.positionData.rewardTwo.isZero();
  if (!hasFees && !hasRewards) throw new Error("nothing to claim on this position");

  const txs = await pool.claimAllRewardsByPosition({ owner: wallet.publicKey, position });
  const results = await sender.sendAll(txs, [wallet], `claim ${params.positionPk.slice(0, 6)}`);
  client.invalidate(params.poolAddress);
  log.info({ positionPk: params.positionPk, txs: txs.length }, "fees and rewards claimed");
  return results;
}

/**
 * Removes 100% of a position's liquidity, claims everything, and closes the
 * account so its rent comes back. Stops managing it too — otherwise the engine
 * would keep polling an address that no longer exists.
 */
export async function exitPosition(
  deps: ActionDeps,
  params: { poolAddress: string; positionPk: string },
): Promise<SendResult[]> {
  const { client, sender, store, log } = deps;
  const wallet = client.requireWallet();
  await client.assertSolFunded();

  const pool = await client.getPool(params.poolAddress, { fresh: true });
  const position = new PublicKey(params.positionPk);
  const { positionData } = await pool.getPosition(position);

  const txs = await pool.removeLiquidity({
    user: wallet.publicKey,
    position,
    fromBinId: positionData.lowerBinId,
    toBinId: positionData.upperBinId,
    bps: new BN(10_000),
    shouldClaimAndClose: true,
  });

  const results = await sender.sendAll(txs, [wallet], `exit ${params.positionPk.slice(0, 6)}`);
  client.invalidate(params.poolAddress);

  // Only forget it if something actually landed; a dry-run must not silently
  // unmanage a live position.
  if (results.some((r) => r.signature)) store.removePosition(params.positionPk);
  log.info({ positionPk: params.positionPk, txs: txs.length, dryRun: results[0]?.dryRun }, "position exited");
  return results;
}

/**
 * Fails early with the actual shortfall rather than letting the deposit fail at
 * simulation with an opaque program error.
 */
async function assertFunded(deps: ActionDeps, pool: DlmmPool, needX: BN, needY: BN): Promise<void> {
  const checks: Array<[string, BN, BN, number]> = [];
  if (needX.gtn(0)) {
    checks.push([
      "token X",
      needX,
      await deps.client.tokenBalance(pool.tokenX.publicKey, pool.tokenX.owner),
      pool.tokenX.mint.decimals,
    ]);
  }
  if (needY.gtn(0)) {
    checks.push([
      "token Y",
      needY,
      await deps.client.tokenBalance(pool.tokenY.publicKey, pool.tokenY.owner),
      pool.tokenY.mint.decimals,
    ]);
  }
  for (const [name, need, have, decimals] of checks) {
    if (have.lt(need)) {
      throw new Error(
        `insufficient ${name}: need ${toUi(need, decimals)}, wallet has ${toUi(have, decimals)}` +
          ` (SOL deposits also keep MIN_SOL_BALANCE=${deps.cfg.minSolBalance} in reserve for fees)`,
      );
    }
  }
}

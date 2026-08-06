import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { MeteoraClient } from "../meteora/client.js";
import type { Store } from "../state.js";
import { toRaw, toUi } from "../meteora/pricing.js";
import type { SendResult, TxSender } from "../tx/send.js";
import { fetchTokenMeta, readTokenAccounts } from "../wallet/tokens.js";
import type { JupiterSwap } from "./jupiter.js";

/**
 * Manual wallet swaps.
 *
 * The rebalancer already swaps — this is the same Jupiter leg, driven by hand
 * instead of by a drifted position. It exists because the wallet accumulates
 * odds and ends the automation will never touch: dust left by a zap out, an
 * airdrop, a token whose pool has been closed. Consolidating those meant
 * leaving the app for a DEX front-end.
 *
 * What it is NOT is a trading screen. There is no limit order, no chart and no
 * position tracking. One balance in, one balance out, with every guard the
 * rebalance swap answers to, plus the ones that only matter when a human is
 * holding the button.
 */

export interface SwapDeps {
  cfg: Config;
  client: MeteoraClient;
  store: Store;
  sender: TxSender;
  swapper: JupiterSwap;
  log: Logger;
  /** Optional push channel, matching RebalanceDeps so the same object serves both. */
  notify?: (msg: string) => void;
}

export interface SwapParams {
  inputMint: string;
  outputMint: string;
  /** Human units of the input token. */
  amount: number;
}

export interface SwapPlanView {
  inputMint: string;
  outputMint: string;
  inSymbol: string;
  outSymbol: string;
  inDecimals: number;
  outDecimals: number;
  amountIn: number;
  quotedOut: number;
  /** `otherAmountThreshold` — what the transaction will not go below. */
  minOut: number;
  /** Output per unit of input, from the quote itself. */
  rate: number;
  priceImpactBps: number;
  slippageBps: number;
  route: string;
  /** Null when either side is unpriced; the swap is still allowed. */
  inUsd: number | null;
  outUsd: number | null;
  /** Signed percentage difference in USD between the two sides, or null. */
  valueDeltaPct: number | null;
  /** Wallet balance of the input token, in human units, spendable. */
  available: number;
  /**
   * Set when the input token is one side of a managed position's pool. Not a
   * refusal — the position's own liquidity is untouched by a wallet swap — but
   * the rebalancer draws on this balance, so it is worth saying out loud.
   */
  inUseWarning: string | null;
}

export interface SwapResult {
  plan: SwapPlanView;
  send: SendResult;
  /** Human units actually credited, measured from the wallet. */
  received: number;
}

/** Both mints of every managed position's pool, for the in-use notice. */
async function managedMints(deps: SwapDeps): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const pools = [...new Set(deps.store.positions().map((p) => p.poolAddress))];
  for (const address of pools) {
    try {
      const pool = await deps.client.getPool(address);
      out.set(pool.tokenX.publicKey.toBase58(), address);
      out.set(pool.tokenY.publicKey.toBase58(), address);
    } catch {
      // Cosmetic. A pool that cannot be read costs a warning line, not the swap.
    }
  }
  return out;
}

function mintOf(value: string, label: string): PublicKey {
  try {
    return new PublicKey(value);
  } catch {
    throw new Error(`${label} is not a valid mint address`);
  }
}

/**
 * Prices a swap and runs every refusal that can be decided without signing.
 *
 * A quote costs nothing and is the only place the real route, impact and
 * minimum-received appear, so the UI previews before it confirms — same shape
 * as Ape and Zap Out.
 */
export async function planSwap(deps: SwapDeps, params: SwapParams): Promise<SwapPlanView> {
  const { cfg, client, store, swapper } = deps;

  const inputMint = mintOf(params.inputMint, "inputMint");
  const outputMint = mintOf(params.outputMint, "outputMint");
  if (inputMint.equals(outputMint)) throw new Error("the input and output mints are the same");
  if (!(params.amount > 0)) throw new Error("amount must be greater than zero");

  /**
   * A pending journal is a hard refusal, and it is the reason this guard exists
   * at all. Between a rebalance's withdraw and its deposit the withdrawn side
   * sits in the wallet as an ordinary balance — indistinguishable, here, from
   * spare change. Swapping it out from under the resume path is precisely how
   * funds have been stranded in this app before, so the swap waits.
   */
  const pending = store.pendingJournal();
  if (pending.length > 0) {
    throw new Error(
      `a rebalance is unfinished (${pending.length} pending journal ${
        pending.length === 1 ? "entry" : "entries"
      }) — its withdrawn funds are sitting in this wallet waiting to be redeposited. Swapping now could spend them. Nothing was sent.`,
    );
  }

  const accounts = await readTokenAccounts(client.connection, client.requireWallet().publicKey);
  const meta = await fetchTokenMeta([params.inputMint, params.outputMint]);
  const inMeta = meta.get(params.inputMint);
  const outMeta = meta.get(params.outputMint);
  const inSymbol = inMeta?.symbol ?? params.inputMint.slice(0, 4);
  const outSymbol = outMeta?.symbol ?? params.outputMint.slice(0, 4);

  const account = accounts.find((a) => a.mint === params.inputMint);
  const isSol = inputMint.equals(NATIVE_MINT);
  /**
   * Decimals come from the wallet's own account when there is one. For native
   * SOL there may be no wSOL account at all, and 9 is the mint's fixed value.
   */
  const inDecimals = account?.decimals ?? inMeta?.decimals ?? (isSol ? 9 : null);
  if (inDecimals === null) throw new Error(`the wallet holds no ${inSymbol}`);

  // Includes the native-SOL fold for wSOL, already net of MIN_SOL_BALANCE — so
  // a swap can never eat the fee reserve.
  const availableRaw = await client.tokenBalance(inputMint, account ? new PublicKey(account.programId) : undefined);
  const available = toUi(availableRaw, inDecimals);
  const amountRaw = toRaw(params.amount, inDecimals);
  if (amountRaw.isZero()) throw new Error("amount rounds to zero at this mint's precision");
  if (availableRaw.lt(amountRaw)) {
    throw new Error(
      `insufficient ${inSymbol}: asked for ${params.amount}, ${available} is spendable` +
        (isSol ? ` (MIN_SOL_BALANCE=${cfg.minSolBalance} stays in reserve for fees)` : ""),
    );
  }

  const quote = await swapper.quote({
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: amountRaw,
  });

  // The same ceiling the rebalance swap answers to. Reused deliberately: it is
  // a statement about whether a route is worth taking, and that does not change
  // because a human pressed the button rather than the engine.
  if (quote.priceImpactBps > cfg.maxSwapPriceImpactBps) {
    throw new Error(
      `swap price impact ${quote.priceImpactBps}bps exceeds MAX_SWAP_PRICE_IMPACT_BPS (${cfg.maxSwapPriceImpactBps}bps)` +
        ` — refusing the ${inSymbol}->${outSymbol} route. Nothing was sent.`,
    );
  }

  /**
   * The wallet's own account first, then Jupiter's index. Buying a token the
   * wallet has never held is the ordinary case here, so there is usually no
   * account to read — and Jupiter's quote does not carry decimals. Guessing a
   * scale would misreport the amount received by orders of magnitude, so a mint
   * neither source knows is refused instead.
   */
  const outDecimals =
    accounts.find((a) => a.mint === params.outputMint)?.decimals ??
    outMeta?.decimals ??
    (outputMint.equals(NATIVE_MINT) ? 9 : null);
  if (outDecimals === null) {
    throw new Error(
      `cannot determine the decimals of ${outSymbol} (${params.outputMint}) — the wallet holds none of it and ` +
        `Jupiter does not index it. Nothing was sent.`,
    );
  }

  const quotedOut = toUi(quote.outAmount, outDecimals);
  const inUsd = inMeta?.usdPrice != null ? params.amount * inMeta.usdPrice : null;
  const outUsd = outMeta?.usdPrice != null ? quotedOut * outMeta.usdPrice : null;

  const managed = await managedMints(deps);
  const usedBy = managed.get(params.inputMint);

  return {
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    inSymbol,
    outSymbol,
    inDecimals,
    outDecimals,
    amountIn: params.amount,
    quotedOut,
    minOut: toUi(new BN(quote.quote.otherAmountThreshold), outDecimals),
    rate: params.amount > 0 ? quotedOut / params.amount : 0,
    priceImpactBps: quote.priceImpactBps,
    slippageBps: quote.quote.slippageBps,
    route: quote.route,
    inUsd,
    outUsd,
    valueDeltaPct: inUsd != null && outUsd != null && inUsd > 0 ? ((outUsd - inUsd) / inUsd) * 100 : null,
    available,
    inUseWarning: usedBy
      ? `${inSymbol} is a token of managed position pool ${usedBy}. The position's own liquidity is untouched, ` +
        `but the rebalancer spends this wallet balance when it redeposits.`
      : null,
  };
}

/**
 * Sends the swap.
 *
 * Re-quoted rather than trusting the plan the client is holding: a confirm step
 * is a human deciding, and a Jupiter quote goes stale in seconds. Every guard in
 * `planSwap` therefore runs again here, against fresh state, immediately before
 * anything is signed.
 *
 * `force` is passed to the sender so a manual swap is NOT suppressed by
 * DRY_RUN. The flag exists to keep the unattended engine from moving money on
 * its own; a swap is not unattended, and a confirm button that silently does
 * nothing is worse than no button.
 */
export async function executeSwap(deps: SwapDeps, params: SwapParams): Promise<SwapResult> {
  const { client, sender, swapper, log } = deps;
  const wallet = client.requireWallet();
  await client.assertSolFunded();

  const plan = await planSwap(deps, params);
  const outputMint = new PublicKey(plan.outputMint);
  const before = await client.tokenBalance(outputMint);

  const quote = await swapper.quote({
    inputMint: plan.inputMint,
    outputMint: plan.outputMint,
    amount: toRaw(plan.amountIn, plan.inDecimals),
  });
  const label = `manual swap ${plan.inSymbol}->${plan.outSymbol}`;
  const send = await sender.sendVersioned(await swapper.buildTransaction(quote, wallet), label, { force: true });

  const received = toUi(BN.max(new BN(0), (await client.tokenBalance(outputMint)).sub(before)), plan.outDecimals);
  log.info(
    { signature: send.signature, in: plan.amountIn, inSymbol: plan.inSymbol, received, outSymbol: plan.outSymbol },
    "manual swap landed",
  );
  deps.notify?.(`🔄 Swapped ${plan.amountIn} ${plan.inSymbol} → ${received} ${plan.outSymbol}`);

  return { plan, send, received };
}

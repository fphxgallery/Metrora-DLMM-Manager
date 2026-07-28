import BN from "bn.js";
import { VersionedTransaction, type Keypair } from "@solana/web3.js";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";

const QUOTE_URL = "https://lite-api.jup.ag/swap/v1/quote";
const SWAP_URL = "https://lite-api.jup.ag/swap/v1/swap";

export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  /** Fraction string, e.g. "0.0042" = 0.42%. */
  priceImpactPct: string;
  routePlan?: { swapInfo?: { label?: string } }[];
}

export interface SwapPlan {
  quote: JupiterQuote;
  inAmount: BN;
  outAmount: BN;
  priceImpactBps: number;
  route: string;
}

/**
 * Jupiter swap leg for rebalances.
 *
 * A DLMM position that has drifted through its range holds only one of the two
 * tokens. `rebalance_liquidity` cannot swap mid-instruction, so restoring a
 * two-sided position needs an external swap between the withdraw and the
 * deposit — this is that swap.
 */
export class JupiterSwap {
  constructor(
    private readonly cfg: Config,
    private readonly log: Logger,
  ) {}

  async quote(params: { inputMint: string; outputMint: string; amount: BN; slippageBps?: number }): Promise<SwapPlan> {
    const qs = new URLSearchParams({
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      amount: params.amount.toString(),
      swapMode: "ExactIn",
      // With dynamic slippage the swap endpoint overrides this per route; it is
      // still required here and acts as the ceiling.
      slippageBps: String(params.slippageBps ?? (this.cfg.swapSlippageBps || 100)),
    });

    const res = await retry429(() => fetch(`${QUOTE_URL}?${qs}`, { signal: AbortSignal.timeout(15_000) }));
    if (!res.ok) throw new Error(`jupiter quote failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const quote = (await res.json()) as JupiterQuote;

    return {
      quote,
      inAmount: new BN(quote.inAmount),
      outAmount: new BN(quote.outAmount),
      priceImpactBps: Math.max(0, Math.round((Number(quote.priceImpactPct) || 0) * 10_000)),
      route: quote.routePlan?.[0]?.swapInfo?.label ?? "Jupiter",
    };
  }

  /**
   * Builds the signed swap transaction. Returns it unsent so the caller can put
   * the journal entry in the `swap` phase before anything hits the network.
   */
  async buildTransaction(plan: SwapPlan, wallet: Keypair): Promise<VersionedTransaction> {
    const body = JSON.stringify({
      quoteResponse: plan.quote,
      userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      // SWAP_SLIPPAGE_BPS=0 means "let Jupiter decide", capped generously; a
      // fixed value pins it instead.
      ...(this.cfg.swapSlippageBps > 0 ? {} : { dynamicSlippage: { maxBps: 300 } }),
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: {
          maxLamports: this.cfg.priorityFeeMicroLamports * 1000,
          priorityLevel: "medium",
        },
      },
    });

    const res = await retry429(() =>
      fetch(SWAP_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(20_000),
      }),
    );
    if (!res.ok) throw new Error(`jupiter swap build failed (${res.status}): ${(await res.text()).slice(0, 200)}`);

    const json = (await res.json()) as {
      swapTransaction: string;
      dynamicSlippageReport?: { slippageBps?: number; simulatedIncurredSlippageBps?: number; categoryName?: string };
    };
    const dsr = json.dynamicSlippageReport;
    if (dsr?.slippageBps != null) {
      this.log.info(
        { slippageBps: dsr.slippageBps, simulated: dsr.simulatedIncurredSlippageBps, category: dsr.categoryName },
        "jupiter dynamic slippage",
      );
    }

    const tx = VersionedTransaction.deserialize(Buffer.from(json.swapTransaction, "base64"));
    tx.sign([wallet]);
    return tx;
  }
}

/** Jupiter's public endpoint rate-limits aggressively; back off rather than fail. */
async function retry429(fn: () => Promise<Response>): Promise<Response> {
  let res = await fn();
  for (let attempt = 0; attempt < 3 && res.status === 429; attempt++) {
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    res = await fn();
  }
  return res;
}

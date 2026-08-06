import "dotenv/config";

function str(key: string, def?: string): string {
  const v = process.env[key] ?? def;
  if (v === undefined) throw new Error(`Missing required env: ${key}`);
  return v;
}
function num(key: string, def?: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") {
    if (def === undefined) throw new Error(`Missing required env: ${key}`);
    return def;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Env ${key} must be a number, got "${raw}"`);
  return n;
}
/**
 * A number that may legitimately be absent, where absent means "off".
 *
 * Distinct from `num` with a default: a blank STOP_LOSS is not zero, it is no
 * stop loss at all. Zero would be a threshold the position sits on from the
 * moment it opens.
 */
function numOpt(key: string): number | undefined {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Env ${key} must be a number or blank, got "${raw}"`);
  return n;
}
function bool(key: string, def: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return def;
  return /^(1|true|yes|on)$/i.test(raw);
}

export const STRATEGY_TYPES = ["Spot", "Curve", "BidAsk"] as const;
export type StrategyTypeName = (typeof STRATEGY_TYPES)[number];

/** What a fired stop loss / take profit does with the position. */
export const TRIGGER_ACTIONS = ["zap-y", "zap-x", "exit"] as const;
export type TriggerAction = (typeof TRIGGER_ACTIONS)[number];

/** Whether a threshold is read as a percentage of PnL change or as dollars. */
export const TRIGGER_MEASURES = ["pct", "usd"] as const;
export type TriggerMeasure = (typeof TRIGGER_MEASURES)[number];

export interface Config {
  // --- chain ---
  rpcEndpoint: string;
  cluster: "mainnet-beta" | "devnet";
  keypairPath: string;
  priorityFeeMicroLamports: number;
  computeUnitLimit: number;
  minSolBalance: number;

  // --- meteora data api ---
  dataApiUrl: string;
  dataApiCacheMs: number;

  // --- wallet buffer ---
  /**
   * Quote-token balance, in USD, to keep idle in the wallet.
   *
   * The rebalance instruction tops up rounding shortfalls from the wallet's ATA:
   * with `STRATEGY_TYPE=Curve` the redeposit side can ask for marginally more of a
   * token than the withdraw released, and an empty ATA turns that into an SPL Token
   * "insufficient funds" (0x1) at simulation. The shortfall is cents; the floor
   * exists so it is always covered.
   */
  minQuoteBalanceUsd: number;
  /** Swap a little SOL into the quote token when the buffer runs dry. */
  autoTopUp: boolean;
  /** Hard ceiling on a single top-up, so a mispriced quote cannot drain the wallet. */
  maxTopUpUsd: number;

  // --- ape ---
  /**
   * Whether a position opened by "Ape" is enrolled in auto-rebalancing straight
   * away.
   *
   * Off by default, matching the open form's own default: an ape is a one-click
   * action, and one click should not quietly hand a new position to the engine.
   * Everything else Ape needs — shape, width, slippage, impact ceiling — is
   * borrowed from the rebalance settings rather than duplicated, so an Ape'd
   * position is one the automation would have built itself.
   */
  apeAutoManage: boolean;

  // --- zap out ---
  /**
   * Which side of the pool a zap out consolidates into.
   *
   * A SIDE, not a named mint. Meteora's own control offers a fixed SOL/USDC
   * choice, which works because it assumes those are the universal quote
   * tokens; this app manages arbitrary X/Y pools, where "SOL" means nothing on a
   * pair that contains neither. "y" — the quote side, usually the stable — is
   * the default and the one that generalises.
   */
  zapOutTo: "x" | "y";

  // --- position triggers (stop loss / take profit) ---
  /**
   * Whether a crossed threshold actually closes the position.
   *
   * OFF does not mean "do not evaluate": thresholds are still checked and still
   * alert, they just never act. That is the intended way to run a new pair of
   * numbers for a week before handing them the ability to close a position on
   * real funds. DRY_RUN behaves the same way, for the same reason — a simulated
   * zap out cannot prove the swap leg, since the exit it would sell the proceeds
   * of never happened.
   */
  triggersArmed: boolean;
  /** Whether STOP_LOSS/TAKE_PROFIT are percentages of PnL change or USD. */
  triggerMeasure: TriggerMeasure;
  /**
   * Close when PnL falls to or below this. Negative; blank disables.
   *
   * PnL here is the indexer's, which includes impermanent loss — a position can
   * be earning fees well and still hit a stop because the pair diverged. That is
   * what the number means and it is not "fees went negative".
   */
  stopLoss?: number;
  /** Close when PnL rises to or above this. Positive; blank disables. */
  takeProfit?: number;
  /**
   * Consecutive readings past a threshold before anything fires.
   *
   * Not a nicety. `pnlUsd` comes verbatim from an eventually-consistent indexer,
   * and on 2026-07-30 it reported -$43.56 for about ten seconds on a position
   * actually at +$1.32 — it had seen a rebalance's withdraw leg and not yet the
   * deposit. At 1 confirmation that reading closes a healthy position, for a
   * number that was wrong, irreversibly.
   */
  triggerConfirmations: number;
  /** How often a position's PnL is checked against its thresholds. */
  triggerCheckMin: number;
  /** What firing does: consolidate into the Y side, the X side, or just exit. */
  triggerOnFire: TriggerAction;
  /** Positions younger than this are never triggered — the indexer lags a new one. */
  triggerMinAgeMin: number;

  // --- pnl history ---
  /** How often each managed position's PnL is written to the sample log. */
  sampleIntervalMin: number;
  /** How much sample history to keep. Older rows are pruned at boot. */
  sampleRetentionDays: number;

  // --- default position shape ---
  /** Half-width of a new position in bins: range = [active - N, active + N]. */
  rangeBins: number;
  strategyType: StrategyTypeName;

  // --- auto-rebalance ---
  autoRebalance: boolean;
  pollIntervalMs: number;
  /** Fire when the active bin comes within this many bins of a range edge. */
  edgeBufferBins: number;
  /** Never rebalance the same position more often than this. */
  cooldownMin: number;
  /** Require unclaimed+projected fees >= estimated cost * this ratio. */
  minFeeCoverRatio: number;
  /** Token ratio deviation (bps of position value) that justifies a swap leg. */
  ratioToleranceBps: number;
  /** Max bins the active bin may move between simulate and land before the ix fails. */
  maxActiveBinSlippage: number;
  /**
   * Re-centre the position on the active bin before path B's deposit leg.
   *
   * Path B reshapes around the active bin, swaps, then deposits the proceeds —
   * and the swap takes seconds, in which the active bin can move. The deposit
   * can only place the base token ABOVE the active bin as it stands when the
   * deposit is built, so any bin the price crossed in between is left with the
   * reshape's share and nothing more: a notch in the curve, right next to the
   * price. Re-centring first gives both curves the same anchor.
   *
   * A kill switch rather than a constant because it adds a transaction to a leg
   * that moves real money, and turning it off must not need a redeploy.
   */
  recentreBeforeDeposit: boolean;
  /** Swap slippage for the ratio leg. 0 = let Jupiter pick (dynamic slippage). */
  swapSlippageBps: number;
  /**
   * Hard ceiling, in LAMPORTS, on the priority fee Jupiter may attach to one
   * swap. Jupiter builds and signs the swap itself, so PRIORITY_FEE_MICROLAMPORTS
   * — a per-CU price applied to transactions we build — has no bearing on it.
   * This is the only control we have over that leg's fee.
   */
  maxSwapPriorityLamports: number;
  /** Hard ceiling on how much of a position's value one rebalance may swap. */
  maxSwapPctOfPosition: number;
  /**
   * Refuse the swap leg when Jupiter's quoted price impact exceeds this. A
   * ceiling on how bad a route we are willing to take, distinct from
   * SWAP_SLIPPAGE_BPS, which is how much movement we tolerate on a route we have
   * already accepted. Mirrors the "Swap Price Impact" guard in Meteora's own UI.
   */
  maxSwapPriceImpactBps: number;

  // --- safety ---
  dryRun: boolean;

  // --- service ---
  port: number;
  host: string;
  apiToken?: string;
  enableWalletUi: boolean;
  dataDir: string;
  telegramBotToken?: string;
  telegramChatId?: string;
}

export function loadConfig(): Config {
  const cluster = str("CLUSTER", "mainnet-beta") as Config["cluster"];
  const strategyType = str("STRATEGY_TYPE", "Spot") as StrategyTypeName;

  const cfg: Config = {
    rpcEndpoint: str("RPC_ENDPOINT"),
    cluster,
    keypairPath: str("KEYPAIR_PATH", "./secrets/keypair.json"),
    // Measured against getRecentPrioritizationFees on mainnet: 141 of 150 recent
    // blocks paid ZERO, and the non-zero samples clustered near 500. 50k is still
    // far above market, and only safe to keep this low because sendVersioned
    // rebroadcasts until the blockhash expires rather than broadcasting once.
    priorityFeeMicroLamports: num("PRIORITY_FEE_MICROLAMPORTS", 50_000),
    computeUnitLimit: num("COMPUTE_UNIT_LIMIT", 600_000),
    minSolBalance: num("MIN_SOL_BALANCE", 0.05),

    dataApiUrl: str("DATA_API_URL", "https://dlmm.datapi.meteora.ag"),
    dataApiCacheMs: num("DATA_API_CACHE_MS", 10_000),

    minQuoteBalanceUsd: num("MIN_QUOTE_BALANCE_USD", 1),
    autoTopUp: bool("AUTO_TOPUP", true),
    // Twice the default floor. A top-up is meant to cover rounding, so anything
    // approaching this ceiling means the price or the balance read is wrong.
    maxTopUpUsd: num("MAX_TOPUP_USD", 5),

    apeAutoManage: bool("APE_AUTO_MANAGE", false),
    zapOutTo: str("ZAP_OUT_TO", "y") as Config["zapOutTo"],

    triggersArmed: bool("TRIGGERS_ARMED", false),
    // `pct` is Meteora's `pnlPctChange`, so the trigger, the gauge, the card and
    // the Telegram alert all show one number and the dashboard can be read beside
    // Meteora's own portfolio page.
    //
    // KNOW WHAT THIS COSTS BEFORE CHANGING ANYTHING HERE. `pnlPctChange` divides
    // by CUMULATIVE deposits, and a path-B rebalance withdraws and redeposits the
    // whole position — so every rebalance adds another position-notional to the
    // denominator and the figure decays toward zero no matter what the position
    // does. Measured live, the dilution was exactly `rebalanceCount + 1`:
    //
    //   KIO-SOL, 14 rebalances, 27% down on its capital -> reported -2.6%,
    //   and its -3% stop never fired.
    //
    // A `pct` threshold therefore weakens every time a position rebalances, and a
    // churning position is effectively unprotected. v1.11.4 fixed this by
    // dividing by capital committed; v1.11.7 reverted to Meteora's figure as an
    // explicit operator decision, taken with those numbers in front of them.
    //
    // `usd` is the measure with no denominator to dilute, and is the one to use
    // for a stop that must hold on a position that rebalances often.
    triggerMeasure: str("TRIGGER_MEASURE", "pct") as TriggerMeasure,
    stopLoss: numOpt("STOP_LOSS"),
    takeProfit: numOpt("TAKE_PROFIT"),
    // Three at the default two-minute cadence is roughly six minutes of
    // agreement before anything closes — long next to the ten-second indexer
    // blip that motivates it, short next to any move worth stopping out of.
    triggerConfirmations: num("TRIGGER_CONFIRMATIONS", 3),
    triggerCheckMin: num("TRIGGER_CHECK_MIN", 2),
    triggerOnFire: str("TRIGGER_ON_FIRE", "zap-y") as TriggerAction,
    triggerMinAgeMin: num("TRIGGER_MIN_AGE_MIN", 30),

    // 15 minutes gives 96 readings a day — a dense 24h chart at ~8,600 rows per
    // position over the 90-day window, which is nothing as an appended log and
    // would be unworkable inside state.json.
    sampleIntervalMin: num("SAMPLE_INTERVAL_MIN", 15),
    sampleRetentionDays: num("SAMPLE_RETENTION_DAYS", 90),

    // Defaults are tuned for a bin-step-4 major pair (SOL-USDC): ±60 bins is
    // ±2.4%, which covers that pair's ~3% median daily range. See DEFAULTS_NOTE.
    rangeBins: num("RANGE_BINS", 60),
    strategyType,

    autoRebalance: bool("AUTO_REBALANCE", false),
    pollIntervalMs: num("POLL_INTERVAL_MS", 30_000),
    edgeBufferBins: num("EDGE_BUFFER_BINS", 12),
    cooldownMin: num("COOLDOWN_MIN", 60),
    minFeeCoverRatio: num("MIN_FEE_COVER_RATIO", 1.5),
    // The swap leg costs roughly 30x an atomic rebalance, so tolerate a fairly
    // lopsided position before paying for one.
    ratioToleranceBps: num("RATIO_TOLERANCE_BPS", 3000),
    maxActiveBinSlippage: num("MAX_ACTIVE_BIN_SLIPPAGE", 15),
    recentreBeforeDeposit: bool("RECENTRE_BEFORE_DEPOSIT", true),
    // NOT 0. Zero hands the decision to Jupiter's dynamic slippage, whose maxBps
    // is a CEILING rather than a floor — it classed SOL/USDC as low-volatility and
    // chose 15bps every time, killing roughly one swap in five on error 6001 while
    // quoted price impact was 0-1bps. The failures came from price moving between
    // quote and landing, not from impact. 50 is Meteora's own fixed swap default.
    swapSlippageBps: num("SWAP_SLIPPAGE_BPS", 50),
    // ~0.015 SOL. Generous next to observed swap fees of 16k-75k lamports, and
    // still small enough that a congestion spike cannot quietly eat a position.
    maxSwapPriorityLamports: num("MAX_SWAP_PRIORITY_LAMPORTS", 200_000),
    maxSwapPctOfPosition: num("MAX_SWAP_PCT_OF_POSITION", 50),
    // 200bps = 2%, the default in Meteora's own swap settings.
    maxSwapPriceImpactBps: num("MAX_SWAP_PRICE_IMPACT_BPS", 200),

    dryRun: bool("DRY_RUN", true),

    port: num("PORT", 8080),
    host: str("HOST", "127.0.0.1"),
    apiToken: process.env.API_TOKEN || undefined,
    enableWalletUi: bool("ENABLE_WALLET_UI", false),
    dataDir: str("DATA_DIR", "./data"),
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || undefined,
    telegramChatId: process.env.TELEGRAM_CHAT_ID || undefined,
  };

  validate(cfg);
  return cfg;
}

function validate(cfg: Config): void {
  if (!["mainnet-beta", "devnet"].includes(cfg.cluster)) {
    throw new Error(`CLUSTER must be mainnet-beta or devnet (got "${cfg.cluster}")`);
  }
  if (!(STRATEGY_TYPES as readonly string[]).includes(cfg.strategyType)) {
    throw new Error(`STRATEGY_TYPE must be one of: ${STRATEGY_TYPES.join(", ")} (got "${cfg.strategyType}")`);
  }
  if (!/^https?:\/\//.test(cfg.rpcEndpoint)) {
    throw new Error(`RPC_ENDPOINT must be an http(s) URL (got "${cfg.rpcEndpoint}")`);
  }
  if (!Number.isInteger(cfg.rangeBins) || cfg.rangeBins < 1) {
    throw new Error(`RANGE_BINS must be an integer >= 1 (got ${cfg.rangeBins})`);
  }
  // A single position account can only span POSITION_MAX_LENGTH bins; the SDK's
  // multi-position path is deliberately out of scope for v1, so cap the half-width.
  if (cfg.rangeBins > MAX_RANGE_BINS) {
    throw new Error(`RANGE_BINS must be <= ${MAX_RANGE_BINS} (one position account); got ${cfg.rangeBins}`);
  }
  if (!Number.isInteger(cfg.edgeBufferBins) || cfg.edgeBufferBins < 0) {
    throw new Error(`EDGE_BUFFER_BINS must be a non-negative integer (got ${cfg.edgeBufferBins})`);
  }
  if (cfg.edgeBufferBins >= cfg.rangeBins) {
    throw new Error(
      `EDGE_BUFFER_BINS (${cfg.edgeBufferBins}) must be < RANGE_BINS (${cfg.rangeBins}) — otherwise every position is "near the edge" the moment it opens and rebalances forever`,
    );
  }
  if (cfg.zapOutTo !== "x" && cfg.zapOutTo !== "y") {
    throw new Error(`ZAP_OUT_TO must be "x" (base) or "y" (quote); got "${cfg.zapOutTo}"`);
  }
  if (!(TRIGGER_MEASURES as readonly string[]).includes(cfg.triggerMeasure)) {
    throw new Error(`TRIGGER_MEASURE must be one of: ${TRIGGER_MEASURES.join(", ")} (got "${cfg.triggerMeasure}")`);
  }
  if (!(TRIGGER_ACTIONS as readonly string[]).includes(cfg.triggerOnFire)) {
    throw new Error(`TRIGGER_ON_FIRE must be one of: ${TRIGGER_ACTIONS.join(", ")} (got "${cfg.triggerOnFire}")`);
  }
  // Signs are enforced rather than inferred. A positive STOP_LOSS would sit above
  // a healthy position's PnL and close it on the first check — the exact opposite
  // of what the operator asked for, and irreversibly.
  if (cfg.stopLoss !== undefined && !(cfg.stopLoss < 0)) {
    throw new Error(
      `STOP_LOSS must be negative — it is the loss at which the position is closed; got ${cfg.stopLoss}. Leave it blank to disable.`,
    );
  }
  if (cfg.takeProfit !== undefined && !(cfg.takeProfit > 0)) {
    throw new Error(
      `TAKE_PROFIT must be positive — it is the gain at which the position is closed; got ${cfg.takeProfit}. Leave it blank to disable.`,
    );
  }
  if (!Number.isInteger(cfg.triggerConfirmations) || cfg.triggerConfirmations < 1) {
    throw new Error(`TRIGGER_CONFIRMATIONS must be an integer >= 1 (got ${cfg.triggerConfirmations})`);
  }
  if (!(cfg.triggerCheckMin > 0)) {
    throw new Error(`TRIGGER_CHECK_MIN must be > 0 (got ${cfg.triggerCheckMin})`);
  }
  if (cfg.triggerMinAgeMin < 0) {
    throw new Error(`TRIGGER_MIN_AGE_MIN must be >= 0 (got ${cfg.triggerMinAgeMin})`);
  }
  if (cfg.cooldownMin < 0) throw new Error(`COOLDOWN_MIN must be >= 0 (got ${cfg.cooldownMin})`);
  if (cfg.minQuoteBalanceUsd < 0) {
    throw new Error(`MIN_QUOTE_BALANCE_USD must be >= 0 (got ${cfg.minQuoteBalanceUsd})`);
  }
  if (cfg.maxTopUpUsd <= 0) {
    throw new Error(`MAX_TOPUP_USD must be > 0 (got ${cfg.maxTopUpUsd})`);
  }
  if (cfg.maxTopUpUsd < cfg.minQuoteBalanceUsd) {
    throw new Error(
      `MAX_TOPUP_USD (${cfg.maxTopUpUsd}) must be >= MIN_QUOTE_BALANCE_USD (${cfg.minQuoteBalanceUsd}) — ` +
        "otherwise the ceiling forbids the very top-up the floor asks for",
    );
  }
  if (cfg.sampleIntervalMin <= 0) {
    throw new Error(`SAMPLE_INTERVAL_MIN must be > 0 (got ${cfg.sampleIntervalMin})`);
  }
  if (cfg.sampleRetentionDays <= 0) {
    throw new Error(`SAMPLE_RETENTION_DAYS must be > 0 (got ${cfg.sampleRetentionDays})`);
  }
  if (cfg.minFeeCoverRatio < 0) throw new Error(`MIN_FEE_COVER_RATIO must be >= 0 (got ${cfg.minFeeCoverRatio})`);
  if (cfg.ratioToleranceBps < 0 || cfg.ratioToleranceBps > 10_000) {
    throw new Error(`RATIO_TOLERANCE_BPS must be in [0,10000] (got ${cfg.ratioToleranceBps})`);
  }
  if (cfg.swapSlippageBps < 0 || cfg.swapSlippageBps > 10_000) {
    throw new Error(`SWAP_SLIPPAGE_BPS must be in [0,10000] (got ${cfg.swapSlippageBps})`);
  }
  if (cfg.maxSwapPctOfPosition <= 0 || cfg.maxSwapPctOfPosition > 100) {
    throw new Error(`MAX_SWAP_PCT_OF_POSITION must be in (0,100] (got ${cfg.maxSwapPctOfPosition})`);
  }
  // Capped well below anything defensible for a single swap: the point of this
  // setting is to stop a runaway fee, so an absurd value must not be accepted.
  if (!Number.isInteger(cfg.maxSwapPriorityLamports) || cfg.maxSwapPriorityLamports <= 0) {
    throw new Error(
      `MAX_SWAP_PRIORITY_LAMPORTS must be a positive integer (got ${cfg.maxSwapPriorityLamports})`,
    );
  }
  if (cfg.maxSwapPriorityLamports > 100_000_000) {
    throw new Error(
      `MAX_SWAP_PRIORITY_LAMPORTS must be <= 100000000 (0.1 SOL) — it is a safety ceiling on ONE ` +
        `swap's priority fee, not a budget; got ${cfg.maxSwapPriorityLamports}`,
    );
  }
  if (!Number.isInteger(cfg.computeUnitLimit) || cfg.computeUnitLimit < 1) {
    throw new Error(`COMPUTE_UNIT_LIMIT must be an integer >= 1 (got ${cfg.computeUnitLimit})`);
  }
  if (cfg.computeUnitLimit > MAX_COMPUTE_UNIT_LIMIT) {
    throw new Error(
      `COMPUTE_UNIT_LIMIT must be <= ${MAX_COMPUTE_UNIT_LIMIT} — that is the runtime's per-transaction ` +
        `maximum, so anything above it fails at simulation; got ${cfg.computeUnitLimit}`,
    );
  }
  if (!Number.isInteger(cfg.priorityFeeMicroLamports) || cfg.priorityFeeMicroLamports < 0) {
    throw new Error(
      `PRIORITY_FEE_MICROLAMPORTS must be a non-negative integer (got ${cfg.priorityFeeMicroLamports})`,
    );
  }
  // The per-CU price is not what costs money — the product is. Guard the thing
  // that is actually charged: price * limit / 1e6 lamports for ONE transaction.
  const maxPriorityLamportsPerTx = (cfg.priorityFeeMicroLamports * cfg.computeUnitLimit) / 1e6;
  if (maxPriorityLamportsPerTx > MAX_PRIORITY_LAMPORTS_PER_TX) {
    throw new Error(
      `PRIORITY_FEE_MICROLAMPORTS (${cfg.priorityFeeMicroLamports}) x COMPUTE_UNIT_LIMIT ` +
        `(${cfg.computeUnitLimit}) is ${maxPriorityLamportsPerTx} lamports of priority fee, which must be ` +
        `<= ${MAX_PRIORITY_LAMPORTS_PER_TX} (0.01 SOL) — it is a safety ceiling on ONE transaction's ` +
        `priority fee, not a budget`,
    );
  }
  if (cfg.maxSwapPriceImpactBps <= 0 || cfg.maxSwapPriceImpactBps > 10_000) {
    throw new Error(`MAX_SWAP_PRICE_IMPACT_BPS must be in (0,10000] (got ${cfg.maxSwapPriceImpactBps})`);
  }
  if (cfg.maxActiveBinSlippage < 0) {
    throw new Error(`MAX_ACTIVE_BIN_SLIPPAGE must be >= 0 (got ${cfg.maxActiveBinSlippage})`);
  }
  if (cfg.pollIntervalMs < 5_000) {
    throw new Error("POLL_INTERVAL_MS too low (min 5000ms) — avoid RPC and Data API rate limits");
  }
  if (cfg.minSolBalance < 0) throw new Error("MIN_SOL_BALANCE must be >= 0");
}

/**
 * Half-width cap for a single position account. `POSITION_MAX_LENGTH` in the SDK
 * is 1400 bins; halved and rounded down with margin so [active-N, active+N] plus
 * the active bin always fits one account.
 */
export const MAX_RANGE_BINS = 690;

/**
 * Solana's per-transaction compute ceiling (`MAX_COMPUTE_UNIT_LIMIT`). This is
 * the runtime's hard maximum, not a preference: a `setComputeUnitLimit` above it
 * is rejected, so every transaction the app builds would fail at simulation.
 */
export const MAX_COMPUTE_UNIT_LIMIT = 1_400_000;

/**
 * Hard ceiling, in LAMPORTS, on the priority fee one transaction we build may
 * carry — `PRIORITY_FEE_MICROLAMPORTS * COMPUTE_UNIT_LIMIT / 1e6`. Neither input
 * is dangerous alone; the product is what is actually charged. 0.01 SOL is far
 * above observed market (most blocks price at zero) and far below an amount that
 * could quietly drain the wallet one transaction at a time.
 */
export const MAX_PRIORITY_LAMPORTS_PER_TX = 10_000_000;

/**
 * DEFAULTS_NOTE — why the shipped numbers are what they are, and when they lie.
 *
 * `RANGE_BINS` and `EDGE_BUFFER_BINS` are bin COUNTS, but a bin's size is set by
 * the pool's bin step, so the same count is a completely different price band
 * from one pool to the next:
 *
 *     price band ≈ ±((1 + binStep/10000)^RANGE_BINS − 1)
 *
 *     binStep   1 → ±60 bins = ±0.6%
 *     binStep   4 → ±60 bins = ±2.4%   <- what these defaults assume
 *     binStep  20 → ±60 bins = ±12.7%
 *     binStep  80 → ±60 bins = ±61%
 *
 * The defaults target a bin-step-4 major pair, whose median daily high-low is
 * around 3%. On a wide-bin-step pool they produce an absurdly large range, and
 * on a bin-step-1 pool an unusably tight one — set RANGE_BINS per pool from the
 * price band you actually want. The pool detail view prints the resulting band.
 *
 * `MAX_ACTIVE_BIN_SLIPPAGE` is the same trap in miniature: 15 bins is 0.6% at
 * bin step 4, but 12% at bin step 80.
 */

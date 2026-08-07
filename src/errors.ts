import type { Config } from "./config.js";

/**
 * Turning an on-chain rejection into something a human can act on.
 *
 * The alert used to read, in full:
 *
 *   Rebalance FAILED for BUTTHOLE-SOL: rebalance (deposit leg) failed on
 *   chain: {"InstructionError":[5,{"Custom":6004}]}
 *
 * which says nothing about what went wrong, whether any money moved, or
 * whether it is about to be retried. All three are knowable.
 */

/**
 * Anchor error codes from the Meteora DLMM program, generated from the IDL
 * shipped in `@meteora-ag/dlmm` rather than transcribed. 6000 appears there as
 * `6e3` after bundling, which is why it is easy to miss by eye.
 */
const DLMM_ERRORS: Record<number, string> = {
  6000: "InvalidStartBinIndex",
  6001: "InvalidBinId",
  6002: "InvalidInput",
  6003: "ExceededAmountSlippageTolerance",
  6004: "ExceededBinSlippageTolerance",
  6005: "CompositionFactorFlawed",
  6006: "NonPresetBinStep",
  6007: "ZeroLiquidity",
  6008: "InvalidPosition",
  6009: "BinArrayNotFound",
  6010: "InvalidTokenMint",
  6011: "InvalidAccountForSingleDeposit",
  6012: "PairInsufficientLiquidity",
  6013: "InvalidFeeOwner",
  6014: "InvalidFeeWithdrawAmount",
  6015: "InvalidAdmin",
  6016: "IdenticalFeeOwner",
  6017: "InvalidBps",
  6018: "MathOverflow",
  6019: "TypeCastFailed",
  6020: "InvalidRewardIndex",
  6021: "InvalidRewardDuration",
  6022: "RewardInitialized",
  6023: "RewardUninitialized",
  6024: "IdenticalFunder",
  6025: "RewardCampaignInProgress",
  6026: "IdenticalRewardDuration",
  6027: "InvalidBinArray",
  6028: "NonContinuousBinArrays",
  6029: "InvalidRewardVault",
  6030: "NonEmptyPosition",
  6031: "UnauthorizedAccess",
  6032: "InvalidFeeParameter",
  6033: "MissingOracle",
  6034: "InsufficientSample",
  6035: "InvalidLookupTimestamp",
  6036: "BitmapExtensionAccountIsNotProvided",
  6037: "CannotFindNonZeroLiquidityBinArrayId",
  6038: "BinIdOutOfBound",
  6039: "InsufficientOutAmount",
  6040: "InvalidPositionWidth",
  6041: "ExcessiveFeeUpdate",
  6042: "PoolDisabled",
  6043: "InvalidPoolType",
  6044: "ExceedMaxWhitelist",
  6045: "InvalidIndex",
  6046: "RewardNotEnded",
  6047: "MustWithdrawnIneligibleReward",
  6048: "UnauthorizedAddress",
  6049: "OperatorsAreTheSame",
  6050: "WithdrawToWrongTokenAccount",
  6051: "WrongRentReceiver",
  6052: "AlreadyPassActivationPoint",
  6053: "ExceedMaxSwappedAmount",
  6054: "InvalidStrategyParameters",
  6055: "LiquidityLocked",
  6056: "BinRangeIsNotEmpty",
  6057: "NotExactAmountOut",
  6058: "InvalidActivationType",
  6059: "InvalidActivationDuration",
  6060: "MissingTokenAmountAsTokenLaunchProof",
  6061: "InvalidQuoteToken",
  6062: "InvalidBinStep",
  6063: "InvalidBaseFee",
  6064: "InvalidPreActivationDuration",
  6065: "AlreadyPassPreActivationSwapPoint",
  6066: "InvalidStatus",
  6067: "ExceededMaxOracleLength",
  6068: "InvalidMinimumLiquidity",
  6069: "NotSupportMint",
  6070: "UnsupportedMintExtension",
  6072: "UnmatchTokenMint",
  6073: "UnsupportedTokenMint",
  6074: "InsufficientRemainingAccounts",
  6075: "InvalidRemainingAccountSlice",
  6076: "DuplicatedRemainingAccountTypes",
  6077: "MissingRemainingAccountForTransferHook",
  6078: "NoTransferHookProgram",
  6079: "ZeroFundedAmount",
  6080: "InvalidSide",
  6081: "InvalidResizeLength",
  6082: "NotSupportAtTheMoment",
  6083: "InvalidRebalanceParameters",
  6084: "InvalidRewardAccounts",
  6085: "UndeterminedError",
  6086: "ReallocExceedMaxLengthPerInstruction",
  6087: "InvalidBaseFeeMantissa",
  6088: "InvalidPositionOwner",
  6089: "InvalidPoolAddress",
  6090: "InvalidTokenBadgeType",
  6091: "InvalidTransferHookAuthority",
  6092: "AmountXIsNegative",
  6093: "AmountYIsNegative",
  6094: "InvalidPoolCreator",
  6095: "InvalidFunctionType",
  6096: "InvalidPermission",
  6097: "IncorrectATA",
  6098: "InvalidWithdrawProtocolFeeZapAccounts",
  6099: "MintRestrictedFromZap",
  6100: "CpiDisabled",
  6101: "MissingZapOutInstruction",
  6102: "InvalidZapAccounts",
  6103: "InvalidZapOutParameters",
  6104: "InsufficientInAmount",
  6105: "InvalidPlaceLimitOrderParameters",
  6106: "InvalidLimitOrderOwner",
  6107: "InvalidCancelLimitOrderParameters",
  6108: "CannotFindLimitOrderByBinId",
  6109: "CancelNonEmptyLimitOrder",
  6110: "InvalidCollectFeeMode",
};

/**
 * Plain English for the codes a rebalance can actually produce.
 *
 * Deliberately partial. A name like `ExceededBinSlippageTolerance` is already
 * most of the answer; these add the part that is specific to how THIS app drives
 * the program, which is the bit the IDL cannot tell you.
 */
function dlmmCause(code: number, cfg: Pick<Config, "maxActiveBinSlippage">): string | null {
  switch (code) {
    case 6004:
      return `the active bin moved more than ${cfg.maxActiveBinSlippage} bins while the deposit was in flight`;
    case 6003:
      return "the deposit's token ratio moved past the amount slippage the instruction allowed";
    case 6005:
      return "the deposit's X:Y ratio did not match what the target bins can accept";
    case 6007:
      return "the deposit worked out to zero liquidity — usually a dust amount after a swap";
    case 6009:
    case 6027:
      return "a bin array the target range needs does not exist yet, or was not passed in";
    case 6028:
      return "the bin arrays passed for the target range were not contiguous";
    case 6030:
      return "the position still holds liquidity, so it cannot be closed";
    case 6038:
      return "the target range falls outside the bin ids this pool supports";
    case 6018:
      return "the program overflowed working the amounts out — usually an extreme price or a dust balance";
    default:
      return null;
  }
}

export interface DecodedTxError {
  /** The label of the transaction that failed, e.g. "rebalance (deposit leg)". */
  label: string | null;
  code: number;
  /** The IDL's name, when the failing program is known to be Meteora DLMM. */
  name: string | null;
  /** How it happened, in this app's terms. Null when there is nothing to add. */
  cause: string | null;
}

/**
 * A `Custom` code only means something relative to the program that threw it.
 * Jupiter's 6001 is a slippage failure; the DLMM program's 6001 is
 * `InvalidBinId`. Decoding one against the other's table produces a confident,
 * wrong answer — worse than the raw number, because the raw number at least
 * looks like something to go and check.
 *
 * The gate is the transaction label, which is unambiguous here: every DLMM
 * transaction this app sends is labelled `rebalance (...)`, and the only other
 * thing it sends is `swap X->Y`, which goes to Jupiter. A swap's code is
 * reported without a name.
 */
export function decodeTxError(
  message: string,
  cfg: Pick<Config, "maxActiveBinSlippage">,
): DecodedTxError | null {
  const custom = /\{\s*"Custom"\s*:\s*(\d+)\s*\}/.exec(message);
  if (!custom) return null;
  const code = Number(custom[1]);

  const labelMatch = /^([a-z][^:]*?) (?:failed|would fail)/.exec(message);
  const label = labelMatch ? labelMatch[1].trim() : null;

  const isDlmm = label !== null && label.startsWith("rebalance (");
  return {
    label,
    code,
    name: isDlmm ? (DLMM_ERRORS[code] ?? null) : null,
    cause: isDlmm ? dlmmCause(code, cfg) : null,
  };
}

/** Which leg of a path-B rebalance a journal phase corresponds to. */
export function legOf(phase: string | undefined): { name: string; step: string } | null {
  switch (phase) {
    case "atomic":
      return { name: "rebalance", step: "single tx" };
    case "withdraw":
      return { name: "withdraw", step: "1 of 3" };
    case "swap":
      return { name: "swap", step: "2 of 3" };
    case "deposit":
      return { name: "deposit", step: "3 of 3" };
    default:
      return null;
  }
}

/**
 * Where the money is when a rebalance stops at a given phase.
 *
 * The single most useful line in a failure alert, and the one the operator
 * cannot work out from the error text. A path-B rebalance takes the position
 * apart before putting it back, so "failed" means very different things at
 * different phases: nothing moved at all, or the whole position is sitting in
 * the wallet as loose tokens.
 */
export function fundsAt(phase: string | undefined): { held: boolean; where: string } {
  switch (phase) {
    case "atomic":
    case "withdraw":
      return { held: false, where: "untouched — the position is intact" };
    case "swap":
      return { held: true, where: "in the WALLET" };
    case "deposit":
      return { held: true, where: "in the WALLET" };
    default:
      return { held: false, where: "unknown — check /api/journal" };
  }
}

import { createRequire } from "node:module";
import type * as DlmmSdk from "@meteora-ag/dlmm";

/**
 * Single entry point for the Meteora SDK.
 *
 * `@meteora-ag/dlmm` ships an ESM build (dist/index.mjs) that does a directory
 * import into `@coral-xyz/anchor/dist/cjs/utils/bytes`. Node's ESM resolver
 * rejects that (ERR_UNSUPPORTED_DIR_IMPORT), so `import DLMM from
 * "@meteora-ag/dlmm"` crashes at load time in this ESM project. The CJS build
 * resolves the same specifier fine, so load it through createRequire and take
 * the types from the package's own .d.ts.
 *
 * Everything else in the app imports from here — never from the package
 * directly — so this workaround stays in one place.
 */
const require = createRequire(import.meta.url);
const sdk = require("@meteora-ag/dlmm") as typeof DlmmSdk & { default?: typeof DlmmSdk.default };

/** The DLMM client class (`DLMM.create`, `DLMM.getAllLbPairPositionsByUser`, …). */
export const DLMM = (sdk.default ?? (sdk as unknown as typeof DlmmSdk.default)) as typeof DlmmSdk.default;

export const StrategyType = sdk.StrategyType;
export const LBCLMM_PROGRAM_IDS = sdk.LBCLMM_PROGRAM_IDS;
export const POSITION_MAX_LENGTH = sdk.POSITION_MAX_LENGTH;
export const BASIS_POINT_MAX = sdk.BASIS_POINT_MAX;
export const BIN_ARRAY_FEE = sdk.BIN_ARRAY_FEE;
export const POSITION_FEE = sdk.POSITION_FEE;
export const TOKEN_ACCOUNT_FEE = sdk.TOKEN_ACCOUNT_FEE;
export const getPriceOfBinByBinId = sdk.getPriceOfBinByBinId;
export const getAutoFillAmountByRebalancedPosition = sdk.getAutoFillAmountByRebalancedPosition;
export const getAndCapMaxActiveBinSlippage = sdk.getAndCapMaxActiveBinSlippage;
export const getEstimatedComputeUnitIxWithBuffer = sdk.getEstimatedComputeUnitIxWithBuffer;
export const derivePosition = sdk.derivePosition;

export type {
  BinLiquidity,
  LbPair,
  LbPosition,
  PositionData,
  PositionInfo,
  RebalancePositionResponse,
  SwapQuote,
  TokenReserve,
} from "@meteora-ag/dlmm";

export type DlmmPool = InstanceType<typeof DlmmSdk.default>;
export type StrategyTypeValue = DlmmSdk.StrategyType;

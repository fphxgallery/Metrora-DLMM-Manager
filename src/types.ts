import type { Config } from "./config.js";
import type { Engine } from "./engine.js";
import type { Logger } from "./logger.js";
import type { DataApi } from "./meteora/datapi.js";
import type { MeteoraClient } from "./meteora/client.js";
import type { Notifier } from "./notify.js";
import type { SampleLog } from "./history.js";
import type { Sampler } from "./sampler.js";
import type { Store } from "./state.js";
import type { TxSender } from "./tx/send.js";

/**
 * Everything the route modules need, assembled once at boot in index.ts.
 * `cfg` is mutated in place on settings saves, so holding this reference is
 * enough to see live config changes without a restart.
 */
export interface AppContext {
  cfg: Config;
  store: Store;
  log: Logger;
  notifier: Notifier;
  client: MeteoraClient;
  dataApi: DataApi;
  sender: TxSender;
  /** PnL readings taken over time — the only source of history for the charts. */
  samples: SampleLog;
  sampler: Sampler;
  /** Absolute/relative path to the .env this instance persists settings into. */
  envPath: string;
  /** Re-reads .env and applies it to `cfg` in place. */
  reloadFromEnv(): void;
  /**
   * Assigned after construction — the engine needs this context to exist first,
   * so routes read it through the container rather than taking it as an argument.
   */
  engine?: Engine;
}

/** Effective dry-run: the UI override wins over the env flag. */
export function isDryRun(ctx: Pick<AppContext, "cfg" | "store">): boolean {
  return ctx.store.get().dryRunOverride ?? ctx.cfg.dryRun;
}

/** Effective auto-rebalance: the UI override wins over the env flag. */
export function isAutoRebalance(ctx: Pick<AppContext, "cfg" | "store">): boolean {
  return ctx.store.get().autoOverride ?? ctx.cfg.autoRebalance;
}

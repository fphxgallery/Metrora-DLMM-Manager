import { existsSync } from "node:fs";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { Store } from "./state.js";
import { SampleLog } from "./history.js";
import { Sampler } from "./sampler.js";
import { Notifier } from "./notify.js";
import { DataApi } from "./meteora/datapi.js";
import { MeteoraClient } from "./meteora/client.js";
import { resumeJournal, type RebalanceDeps } from "./meteora/rebalance.js";
import { JupiterSwap } from "./swap/jupiter.js";
import { TxSender } from "./tx/send.js";
import { Engine } from "./engine.js";
import { buildServer, makeReload } from "./server.js";
import { isAutoRebalance, isDryRun, type AppContext } from "./types.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = logger;
  const store = new Store(cfg.dataDir);
  const notifier = new Notifier(cfg, log);
  const envPath = process.env.ENV_FILE || ".env";

  const client = new MeteoraClient(cfg, log);
  const dataApi = new DataApi(cfg, log);
  const samples = new SampleLog(cfg.dataDir);
  const pruned = samples.prune(cfg.sampleRetentionDays * 86_400_000);
  if (pruned > 0) log.info({ pruned, retentionDays: cfg.sampleRetentionDays }, "pruned old pnl samples");
  const swapper = new JupiterSwap(cfg, log);
  // The dry-run flag is read through a closure, not captured, so toggling it in
  // the UI takes effect on the very next transaction.
  const sender = new TxSender(cfg, client.connection, log, () => store.get().dryRunOverride ?? cfg.dryRun);

  const sampler = new Sampler({
    store,
    dataApi,
    client,
    samples,
    log,
    intervalMs: cfg.sampleIntervalMin * 60_000,
  });

  const ctx: AppContext = {
    cfg,
    store,
    log,
    notifier,
    client,
    dataApi,
    sender,
    samples,
    sampler,
    envPath,
    reloadFromEnv: makeReload(cfg, envPath),
  };

  const rebalanceDeps: RebalanceDeps = {
    cfg,
    client,
    dataApi,
    sender,
    swapper,
    store,
    log,
    notify: (msg) => notifier.notify(msg),
    notifyHtml: (html) => notifier.notifyHtml(html),
  };
  const engine = new Engine(ctx, rebalanceDeps, notifier);
  ctx.engine = engine;

  log.info(
    {
      cluster: cfg.cluster,
      mode: isDryRun(ctx) ? "DRY-RUN" : "LIVE",
      autoRebalance: isAutoRebalance(ctx),
      managed: store.positions().length,
      wallet: existsSync(cfg.keypairPath) ? "configured" : "missing",
    },
    "DLMM Manager starting",
  );

  const server = await buildServer(ctx, rebalanceDeps);
  await server.listen({ port: cfg.port, host: cfg.host });
  log.info({ url: `http://${cfg.host}:${cfg.port}` }, "dashboard listening");

  const loopback = ["127.0.0.1", "localhost", "::1"].includes(cfg.host);
  if (!cfg.apiToken && !loopback) {
    log.warn(
      { host: cfg.host },
      "SECURITY: control endpoints are UNAUTHENTICATED and bound to a non-loopback interface — set API_TOKEN",
    );
  }

  // Finish anything an earlier process was interrupted mid-way through, BEFORE
  // the engine starts polling — otherwise a fresh trigger could fire against a
  // position whose funds are still sitting in the wallet. Silent when there was
  // nothing to resume (the normal case on every boot but the first after a crash).
  const pendingAtBoot = store.pendingJournal().length;
  if (pendingAtBoot > 0) {
    notifier.notify(`⏳ Resuming ${pendingAtBoot} unfinished rebalance(s) from a previous run`);
  }
  try {
    await resumeJournal(rebalanceDeps);
  } catch (e) {
    log.error({ err: e instanceof Error ? e.message : String(e) }, "journal resume threw");
  }
  if (pendingAtBoot > 0) {
    const stillPending = store.pendingJournal().length;
    if (stillPending > 0) {
      notifier.notify(
        `⚠️ ${stillPending} rebalance(s) still unresolved after resume — check LOGS/METRICS, funds may be sitting in the wallet`,
      );
    } else {
      notifier.notify(`✅ Resumed and completed ${pendingAtBoot} unfinished rebalance(s)`);
    }
  }

  engine.start();
  notifier.notify(
    `▶️ DLMM Manager started — ${isDryRun(ctx) ? "DRY-RUN" : "LIVE"} on ${cfg.cluster}` +
      `, ${store.positions().length} managed position(s)` +
      (isAutoRebalance(ctx) ? "" : " (auto-rebalance OFF)"),
  );

  const shutdown = async (sig: string) => {
    log.info({ sig }, "shutting down");
    // Awaited, not the usual fire-and-forget notify() — process.exit() right
    // after would kill the Telegram request mid-flight otherwise, and this is
    // the one alert most worth actually receiving (an unexpected restart).
    await notifier.send(`⏹️ DLMM Manager stopping (${sig})`);
    engine.stop();
    store.flush();
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error({ err: err instanceof Error ? err.stack : String(err) }, "fatal");
  process.exit(1);
});

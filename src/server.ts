import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { config as dotenvConfig } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { loadConfig, STRATEGY_TYPES } from "./config.js";
import { getLogs, clearLogs } from "./logger.js";
import { authed, canSetToken, requireAuth, requireWalletAuth } from "./auth.js";
import { updateEnvFile } from "./util/env-file.js";
import {
  generateMnemonic,
  keypairFromMnemonic,
  keypairFromUnknown,
  loadKeypairFile,
  saveKeypairFile,
} from "./wallet/keystore.js";
import type { RebalanceDeps } from "./meteora/rebalance.js";
import { cooldownFloor, lamportsOf, partitionRebalances } from "./metrics.js";
import { aggregateByTs, downsample } from "./history.js";

/**
 * Chart windows offered by the METRICS tab, in milliseconds.
 *
 * ALL is Infinity rather than a large number: it means "back to the first thing
 * we know about", which the response reports as `dataFrom`. Having it here as a
 * timeframe is what lets the tab drop its separate all-time panel — the same
 * figures over an unbounded window, rather than a second set of tiles.
 */
const TIMEFRAMES: Record<string, number> = {
  "24H": 86_400_000,
  "7D": 7 * 86_400_000,
  "30D": 30 * 86_400_000,
  "90D": 90 * 86_400_000,
  ALL: Infinity,
};

/** Points per series in a history response — more than a chart can resolve is waste. */
const MAX_POINTS = 320;
import { registerPoolRoutes } from "./routes/pools.js";
import { registerPositionRoutes } from "./routes/positions.js";
import { registerWalletTokenRoutes } from "./routes/wallet.js";
import { isAutoRebalance, isDryRun, type AppContext } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Read once at boot — the version can't change while the process is running.
const APP_VERSION = ((): string => {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

/**
 * Config keys the SETTINGS tab may write. Anything outside this set is rejected
 * so the endpoint can't be used to set arbitrary environment variables.
 */
const EDITABLE_KEYS = new Set([
  "RANGE_BINS",
  "STRATEGY_TYPE",
  "AUTO_REBALANCE",
  "EDGE_BUFFER_BINS",
  "COOLDOWN_MIN",
  "MIN_FEE_COVER_RATIO",
  "RATIO_TOLERANCE_BPS",
  "MAX_ACTIVE_BIN_SLIPPAGE",
  "SWAP_SLIPPAGE_BPS",
  "MAX_SWAP_PRIORITY_LAMPORTS",
  "MAX_SWAP_PCT_OF_POSITION",
  "MAX_SWAP_PRICE_IMPACT_BPS",
  "PRIORITY_FEE_MICROLAMPORTS",
  "COMPUTE_UNIT_LIMIT",
  "MIN_SOL_BALANCE",
  "MIN_QUOTE_BALANCE_USD",
  "AUTO_TOPUP",
  "MAX_TOPUP_USD",
  // POLL_INTERVAL_MS is deliberately absent: the engine captures it once into
  // setInterval, so editing it here would not take effect until a restart anyway.
]);

export async function buildServer(ctx: AppContext, rebalanceDeps: RebalanceDeps) {
  const { cfg, store, log, notifier } = ctx;
  const app = Fastify({ logger: false, bodyLimit: 1_048_576 });

  // The built React client. In the image it sits at /app/client/dist; in dev it
  // is ../client/dist relative to dist/.
  const clientDir = resolve(__dirname, "..", "client", "dist");
  if (existsSync(clientDir)) {
    await app.register(fastifyStatic, { root: clientDir, prefix: "/" });
    // SPA fallback: any non-/api path that isn't a real file serves index.html.
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "not found" });
      return reply.sendFile("index.html");
    });
  } else {
    log.warn({ clientDir }, "client build not found — run `npm run build:client` (API still served)");
  }

  // ---------------------------------------------------------------- meta ----

  app.get("/api/version", async () => ({ version: APP_VERSION }));

  app.get("/api/health", async () => ({
    ok: true,
    version: APP_VERSION,
    cluster: cfg.cluster,
    dryRun: isDryRun(ctx),
    autoRebalance: isAutoRebalance(ctx),
    walletConfigured: existsSync(cfg.keypairPath),
    uptimeSec: Math.floor(process.uptime()),
  }));

  // Bearer check for the login gate: 200 when the presented token is valid (or
  // no token is configured, i.e. open mode), 401 otherwise.
  app.get("/api/auth/verify", async (req, reply) => {
    if (!authed(cfg, req)) return reply.code(401).send({ ok: false });
    return { ok: true, tokenRequired: Boolean(cfg.apiToken) };
  });

  app.get("/api/status", async () => ({
    version: APP_VERSION,
    cluster: cfg.cluster,
    dryRun: isDryRun(ctx),
    autoRebalance: isAutoRebalance(ctx),
    engineRunning: ctx.engine?.running() ?? false,
    busy: ctx.engine?.status().busy ?? [],
    managed: store.positions().length,
    autoManaged: store.positions().filter((p) => p.auto).length,
    pendingJournal: store.pendingJournal().length,
    rebalances: store.rebalances().length,
  }));

  /** The rebalance journal — unfinished entries are the ones that matter. */
  app.get("/api/journal", async () => ({
    pending: store.pendingJournal(),
    all: store.get().journal.slice(-50).reverse(),
  }));

  /**
   * Cost of automation vs what it earned. The only number that says whether
   * running this app pays: rebalance fees and rent on one side, fees the
   * positions actually collected on the other.
   */
  app.get("/api/metrics", async () => {
    const allRebalances = store.rebalances();
    const positions = store.positions();
    const solPriceUsd = await ctx.dataApi.solPriceUsd().catch(() => 0);

    // Cost and fee income must describe the same positions — see partitionRebalances.
    const { managed: rebalances, retired } = partitionRebalances(allRebalances, positions);

    const costLamports = lamportsOf(rebalances);
    const costUsd = (costLamports / 1_000_000_000) * solPriceUsd;
    // Spending on positions since closed. Kept out of every ratio above, but
    // surfaced so retiring a position cannot quietly erase what it cost.
    const retiredCostUsd = (lamportsOf(retired) / 1_000_000_000) * solPriceUsd;

    // Fee income comes from the indexer's per-position PnL, which counts fees
    // already claimed as well as those still sitting in the position.
    const wallet = ctx.client.wallet()?.publicKey.toBase58();
    let feesEarnedUsd = 0;
    if (wallet) {
      const pools = [...new Set(positions.map((p) => p.poolAddress))];
      for (const pool of pools) {
        const pnls = await ctx.dataApi.positionPnlSafe(pool, wallet);
        for (const pnl of pnls) {
          if (positions.some((p) => p.positionPk === pnl.positionAddress)) {
            feesEarnedUsd += Number(pnl.allTimeFees?.total?.usd ?? 0);
          }
        }
      }
    }

    const pollsTotal = positions.reduce((a, p) => a + p.pollsTotal, 0);
    const pollsInRange = positions.reduce((a, p) => a + p.pollsInRange, 0);

    // Only count intervals between consecutive rebalances of the SAME position;
    // across positions the gaps are meaningless.
    const gaps: number[] = [];
    for (const p of positions) {
      const mine = rebalances.filter((r) => r.positionPk === p.positionPk).map((r) => r.ts).sort((a, b) => a - b);
      for (let i = 1; i < mine.length; i++) gaps.push((mine[i] - mine[i - 1]) / 60_000);
    }
    gaps.sort((a, b) => a - b);

    return {
      solPriceUsd,
      rebalanceCount: rebalances.length,
      pathA: rebalances.filter((r) => r.path === "A").length,
      pathB: rebalances.filter((r) => r.path === "B").length,
      costLamports,
      costUsd,
      retiredCount: retired.length,
      retiredCostUsd,
      feesEarnedUsd,
      netUsd: feesEarnedUsd - costUsd,
      /** Share of fee income eaten by rebalancing. */
      costDragPct: feesEarnedUsd > 0 ? (costUsd / feesEarnedUsd) * 100 : null,
      timeInRangePct: pollsTotal > 0 ? (pollsInRange / pollsTotal) * 100 : null,
      pollsTotal,
      medianGapMin: gaps.length > 0 ? gaps[Math.floor(gaps.length / 2)] : null,
      minGapMin: gaps.length > 0 ? gaps[0] : null,
      /**
       * The cooldown the measured gaps were actually subject to, so the UI can say
       * whether a gap is short *for this configuration* rather than against a fixed
       * number. The smallest one across managed positions: that is the most
       * permissive, and therefore the one capable of producing the shortest gaps.
       */
      cooldownMin: cooldownFloor(positions, cfg.cooldownMin),
      managed: positions.length,
      autoManaged: positions.filter((p) => p.auto).length,
      recent: rebalances.slice(-25).reverse(),
      perPosition: positions.map((p) => ({
        positionPk: p.positionPk,
        pairName: p.pairName,
        auto: p.auto,
        rebalanceCount: p.rebalanceCount,
        lastRebalanceAt: p.lastRebalanceAt,
        timeInRangePct: p.pollsTotal > 0 ? (p.pollsInRange / p.pollsTotal) * 100 : null,
      })),
    };
  });

  /**
   * Time series behind the METRICS charts.
   *
   * Fees and PnL come from the sample log, which only holds what was actually
   * recorded — so a window longer than the history returns `enough: false` and the
   * client shows what it is still collecting rather than drawing a line through
   * absent data. Cost is different: `rebalances[]` already carries a timestamp per
   * record, so the cost curve is exact right back to the first rebalance without
   * ever having been sampled.
   */
  app.get("/api/history", async (req) => {
    const tf = String((req.query as { tf?: string }).tf ?? "24H").toUpperCase();
    const spanMs = TIMEFRAMES[tf] ?? TIMEFRAMES["24H"];
    const now = Date.now();
    // Infinity for ALL: `now - Infinity` is -Infinity, which every timestamp is at
    // or after, so the filters below simply keep everything.
    const from = now - spanMs;

    const positions = store.positions();
    const managedPks = new Set(positions.map((p) => p.positionPk));
    const solPriceUsd = await ctx.dataApi.solPriceUsd().catch(() => 0);

    // Same rule as /api/metrics: only positions still managed, so cost and fees
    // describe one set of positions.
    const rows = ctx.samples.read(from).filter((s) => managedPks.has(s.positionPk));
    const fees = downsample(aggregateByTs(rows, (s) => s.feesUsd), MAX_POINTS);
    const pnl = downsample(aggregateByTs(rows, (s) => s.pnlUsd), MAX_POINTS);

    const { managed: rebalances } = partitionRebalances(store.rebalances(), positions);
    const ordered = [...rebalances].sort((a, b) => a.ts - b.ts);
    let running = 0;
    const cost: { ts: number; usd: number }[] = [];
    for (const r of ordered) {
      running += (r.costLamports + r.rentLamports) / 1_000_000_000;
      if (r.ts >= from) cost.push({ ts: r.ts, usd: running * solPriceUsd });
    }
    // Anchor the step at the window's left edge, otherwise a cost curve whose
    // rebalances all predate the window would start at zero and understate it.
    const spentBefore = ordered
      .filter((r) => r.ts < from)
      .reduce((a, r) => a + (r.costLamports + r.rentLamports) / 1_000_000_000, 0);
    // The left anchor sits at the window edge, except for ALL, where there is no
    // edge — there it belongs at the first rebalance we know about.
    const firstEventTs = ordered[0]?.ts;
    cost.unshift({ ts: Number.isFinite(from) ? from : (firstEventTs ?? now), usd: spentBefore * solPriceUsd });
    cost.push({ ts: now, usd: running * solPriceUsd });

    const earliest = ctx.samples.earliest();
    /**
     * The oldest moment this response has anything to say about.
     *
     * The client plots from here rather than from the window edge, so asking for
     * 90 days with a day of history does not draw 89 days of flat line and a spike
     * at the right — a shape that reads as "nothing happened for three months".
     * Cost reaches back further than samples do, since rebalance records carry
     * their own timestamps and predate any sampling.
     */
    const dataFrom = Math.min(earliest ?? Infinity, firstEventTs ?? Infinity);
    return {
      dataFrom: Number.isFinite(dataFrom) ? dataFrom : null,
      tf,
      /** null for ALL, which has no left edge — plot from `dataFrom` instead. */
      from: Number.isFinite(from) ? from : null,
      to: now,
      collectingSince: earliest ?? null,
      sampleIntervalMin: ctx.cfg.sampleIntervalMin,
      fees,
      pnl,
      cost,
      /** When each rebalance landed, for the ticks under the axis. */
      events: rebalances.filter((r) => r.ts >= from).map((r) => r.ts),
    };
  });

  // -------------------------------------------------------------- domain ----

  registerPoolRoutes(app, ctx);
  registerPositionRoutes(app, ctx, rebalanceDeps);
  registerWalletTokenRoutes(app, ctx);

  // ---------------------------------------------------------------- logs ----

  app.get("/api/logs", async (req) => {
    const since = Number((req.query as { since?: string }).since ?? -1);
    return getLogs(Number.isFinite(since) ? since : -1);
  });

  app.post("/api/logs/clear", async (req, reply) => {
    if (!requireAuth(cfg, req, reply)) return;
    clearLogs();
    return { ok: true };
  });

  // ------------------------------------------------------------ settings ----

  app.get("/api/settings", async (req) => ({
    // Never echo the token itself — only whether one is set.
    tokenSet: Boolean(cfg.apiToken),
    canSetToken: canSetToken(cfg, req),
    walletUiEnabled: cfg.enableWalletUi,
    telegram: {
      configured: notifier.enabled(),
      chatId: cfg.telegramChatId ?? "",
    },
    strategyTypes: STRATEGY_TYPES,
    config: {
      RANGE_BINS: cfg.rangeBins,
      STRATEGY_TYPE: cfg.strategyType,
      AUTO_REBALANCE: isAutoRebalance(ctx),
      EDGE_BUFFER_BINS: cfg.edgeBufferBins,
      COOLDOWN_MIN: cfg.cooldownMin,
      MIN_FEE_COVER_RATIO: cfg.minFeeCoverRatio,
      RATIO_TOLERANCE_BPS: cfg.ratioToleranceBps,
      MAX_ACTIVE_BIN_SLIPPAGE: cfg.maxActiveBinSlippage,
      SWAP_SLIPPAGE_BPS: cfg.swapSlippageBps,
      MAX_SWAP_PRIORITY_LAMPORTS: cfg.maxSwapPriorityLamports,
      MAX_SWAP_PCT_OF_POSITION: cfg.maxSwapPctOfPosition,
      MAX_SWAP_PRICE_IMPACT_BPS: cfg.maxSwapPriceImpactBps,
      PRIORITY_FEE_MICROLAMPORTS: cfg.priorityFeeMicroLamports,
      COMPUTE_UNIT_LIMIT: cfg.computeUnitLimit,
      MIN_SOL_BALANCE: cfg.minSolBalance,
      MIN_QUOTE_BALANCE_USD: cfg.minQuoteBalanceUsd,
      AUTO_TOPUP: cfg.autoTopUp,
      MAX_TOPUP_USD: cfg.maxTopUpUsd,
      POLL_INTERVAL_MS: cfg.pollIntervalMs,
      DRY_RUN: isDryRun(ctx),
      CLUSTER: cfg.cluster,
    },
  }));

  app.post("/api/settings/config", async (req, reply) => {
    if (!requireAuth(cfg, req, reply)) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const updates: Record<string, string> = {};
    for (const [k, v] of Object.entries(body)) {
      if (!EDITABLE_KEYS.has(k)) return reply.code(400).send({ error: `key not editable: ${k}` });
      updates[k] = String(v);
    }
    if (Object.keys(updates).length === 0) return reply.code(400).send({ error: "no updates" });

    const res = applyConfigUpdates(updates);
    if (!res.ok) return reply.code(400).send({ error: res.error });
    return { ok: true, applied: updates };
  });

  /** Runtime toggles that live in state.json, not .env. */
  app.post("/api/settings/mode", async (req, reply) => {
    if (!requireAuth(cfg, req, reply)) return;
    const body = (req.body ?? {}) as { dryRun?: boolean; autoRebalance?: boolean };
    if (typeof body.dryRun === "boolean") store.setDryRunOverride(body.dryRun);
    if (typeof body.autoRebalance === "boolean") store.setAutoOverride(body.autoRebalance);
    log.warn({ dryRun: isDryRun(ctx), autoRebalance: isAutoRebalance(ctx) }, "runtime mode changed");
    return { ok: true, dryRun: isDryRun(ctx), autoRebalance: isAutoRebalance(ctx) };
  });

  app.post("/api/settings/telegram", async (req, reply) => {
    if (!requireAuth(cfg, req, reply)) return;
    const { botToken, chatId } = (req.body ?? {}) as { botToken?: string; chatId?: string };
    const updates: Record<string, string> = {};
    if (botToken !== undefined) updates.TELEGRAM_BOT_TOKEN = botToken.trim();
    if (chatId !== undefined) updates.TELEGRAM_CHAT_ID = chatId.trim();
    if (Object.keys(updates).length === 0) return reply.code(400).send({ error: "no updates" });
    try {
      updateEnvFile(ctx.envPath, updates);
      ctx.reloadFromEnv();
    } catch (e) {
      return reply.code(500).send({ error: `could not persist: ${msg(e)}` });
    }
    return { ok: true, configured: notifier.enabled() };
  });

  app.post("/api/settings/telegram/test", async (req, reply) => {
    if (!requireAuth(cfg, req, reply)) return;
    const r = await notifier.send("✅ DLMM Manager test alert");
    if (!r.ok) return reply.code(400).send({ error: r.error });
    return { ok: true };
  });

  /**
   * First-run API token setup. Only allowed when no token exists yet AND the
   * request is local — see canSetToken(). Rotating an existing token is an
   * .env edit + restart on purpose.
   */
  app.post("/api/settings/token", async (req, reply) => {
    if (!canSetToken(cfg, req)) {
      return reply.code(403).send({
        error: cfg.apiToken
          ? "a token is already set — rotate it by editing API_TOKEN in .env and restarting"
          : "first-run token setup is only allowed from loopback — set API_TOKEN in .env instead",
      });
    }
    const given = ((req.body ?? {}) as { token?: string }).token?.trim();
    const token = given && given.length >= 16 ? given : randomBytes(24).toString("base64url");
    if (given && given.length < 16) return reply.code(400).send({ error: "token must be at least 16 characters" });
    try {
      updateEnvFile(ctx.envPath, { API_TOKEN: token });
      ctx.reloadFromEnv();
    } catch (e) {
      return reply.code(500).send({ error: `could not persist: ${msg(e)}` });
    }
    log.warn("API token set from the dashboard");
    return { ok: true, token };
  });

  app.post("/api/settings/wallet-ui", async (req, reply) => {
    if (!requireAuth(cfg, req, reply)) return;
    const enabled = Boolean(((req.body ?? {}) as { enabled?: boolean }).enabled);
    if (enabled && !cfg.apiToken) {
      return reply.code(403).send({ error: "set an API token before enabling the wallet UI" });
    }
    try {
      updateEnvFile(ctx.envPath, { ENABLE_WALLET_UI: String(enabled) });
      ctx.reloadFromEnv();
    } catch (e) {
      return reply.code(500).send({ error: `could not persist: ${msg(e)}` });
    }
    return { ok: true, enabled: cfg.enableWalletUi };
  });

  // -------------------------------------------------------------- wallet ----

  app.get("/api/wallet", async () => {
    const path = cfg.keypairPath;
    if (!existsSync(path)) return { exists: false, path, uiEnabled: cfg.enableWalletUi };
    try {
      const kp = loadKeypairFile(path);
      return { exists: true, path, publicKey: kp.publicKey.toBase58(), uiEnabled: cfg.enableWalletUi };
    } catch (e) {
      return { exists: true, path, error: msg(e), uiEnabled: cfg.enableWalletUi };
    }
  });

  /**
   * Creates a brand-new hot wallet. The seed phrase is returned ONCE, in this
   * response only — it is never written to disk or logged.
   */
  app.post("/api/wallet/create", async (req, reply) => {
    if (!walletUiGuard(req, reply)) return;
    const { force, words } = (req.body ?? {}) as { force?: boolean; words?: 12 | 24 };
    try {
      const mnemonic = generateMnemonic(words === 12 ? 12 : 24);
      const kp = keypairFromMnemonic(mnemonic);
      saveKeypairFile(cfg.keypairPath, kp, Boolean(force));
      log.warn({ publicKey: kp.publicKey.toBase58() }, "new wallet created from the dashboard");
      notifier.notify(
        `🔑 New wallet created from the dashboard — ${kp.publicKey.toBase58()}` + (force ? " (overwrote the previous key)" : ""),
      );
      return { ok: true, publicKey: kp.publicKey.toBase58(), mnemonic };
    } catch (e) {
      return reply.code(400).send({ error: msg(e) });
    }
  });

  app.post("/api/wallet/import", async (req, reply) => {
    if (!walletUiGuard(req, reply)) return;
    const { secret, account, force } = (req.body ?? {}) as {
      secret?: string;
      account?: number;
      force?: boolean;
    };
    if (!secret?.trim()) return reply.code(400).send({ error: "secret is required" });
    try {
      const kp = keypairFromUnknown(secret, Number(account ?? 0));
      saveKeypairFile(cfg.keypairPath, kp, Boolean(force));
      log.warn({ publicKey: kp.publicKey.toBase58() }, "wallet imported from the dashboard");
      notifier.notify(
        `🔑 Wallet imported from the dashboard — ${kp.publicKey.toBase58()}` + (force ? " (overwrote the previous key)" : ""),
      );
      return { ok: true, publicKey: kp.publicKey.toBase58() };
    } catch (e) {
      return reply.code(400).send({ error: msg(e) });
    }
  });

  // ------------------------------------------------------------- helpers ----

  /** Wallet writes need the feature flag ON, a token configured, and a valid bearer. */
  function walletUiGuard(req: Parameters<typeof requireWalletAuth>[1], reply: Parameters<typeof requireWalletAuth>[2]): boolean {
    if (!cfg.enableWalletUi) {
      void reply.code(403).send({ error: "wallet UI is disabled — set ENABLE_WALLET_UI=true" });
      return false;
    }
    return requireWalletAuth(cfg, req, reply);
  }

  /**
   * Validates env updates by trial-loading the config BEFORE persisting, so a
   * bad value can never be written to .env and brick the next boot.
   */
  function applyConfigUpdates(updates: Record<string, string>): { ok: true } | { ok: false; error: string } {
    const prev: Record<string, string | undefined> = {};
    for (const k of Object.keys(updates)) prev[k] = process.env[k];
    const restore = () => {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    };

    for (const [k, v] of Object.entries(updates)) process.env[k] = v;
    try {
      loadConfig(); // throws on any invalid or self-contradictory value
    } catch (e) {
      restore();
      return { ok: false, error: msg(e) };
    }

    try {
      updateEnvFile(ctx.envPath, updates);
      ctx.reloadFromEnv();
    } catch (e) {
      restore();
      log.error({ err: msg(e) }, "config write/reload failed");
      return { ok: false, error: `could not persist config: ${msg(e)}` };
    }
    return { ok: true };
  }

  return app;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Re-reads .env and mutates `cfg` in place so live references see the change. */
export function makeReload(cfg: import("./config.js").Config, envPath: string): () => void {
  return () => {
    dotenvConfig({ override: true, path: envPath });
    Object.assign(cfg, loadConfig());
  };
}

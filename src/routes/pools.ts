import type { FastifyInstance } from "fastify";
import type { AppContext } from "../types.js";
import { priceOfBin, rangeAround, toUi } from "../meteora/pricing.js";

/** How many bins either side of the active bin the pool detail chart shows. */
const CHART_BINS = 40;

export function registerPoolRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { cfg, client, dataApi, log } = ctx;

  /**
   * Pool search. Thin pass-through to the Meteora Data API's own query grammar
   * (`sort_by=volume_24h:desc`, `filter_by=tvl>10000 && is_blacklisted=false`)
   * so the UI can use the full filter language without this layer re-implementing it.
   */
  app.get("/api/pools", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    try {
      const res = await dataApi.pools({
        query: q.query,
        sortBy: q.sort_by,
        filterBy: q.filter_by,
        page: q.page ? Number(q.page) : undefined,
        pageSize: q.page_size ? Number(q.page_size) : undefined,
      });
      return {
        total: res.total,
        pages: res.pages,
        page: res.current_page,
        pools: res.data.map((p) => ({
          address: p.address,
          name: p.name,
          binStep: p.pool_config.bin_step,
          baseFeePct: p.pool_config.base_fee_pct,
          dynamicFeePct: p.dynamic_fee_pct,
          tvl: p.tvl,
          currentPrice: p.current_price,
          // The API's `apr` is a DAILY percentage (it equals fee_tvl_ratio_24h);
          // `apy` is that compounded over 365 days. Pass them through named for
          // what they are so the UI cannot render a meaningless middle number.
          feeTvlDailyPct: p.apr,
          apyPct: p.apy,
          volume24h: p.volume?.["24h"] ?? 0,
          fees24h: p.fees?.["24h"] ?? 0,
          hasFarm: p.has_farm,
          isBlacklisted: p.is_blacklisted,
          tokenX: { symbol: p.token_x.symbol, mint: p.token_x.address, decimals: p.token_x.decimals, priceUsd: p.token_x.price },
          tokenY: { symbol: p.token_y.symbol, mint: p.token_y.address, decimals: p.token_y.decimals, priceUsd: p.token_y.price },
        })),
      };
    } catch (e) {
      log.warn({ err: msg(e) }, "pool search failed");
      return reply.code(502).send({ error: msg(e) });
    }
  });

  /**
   * Pool detail: indexed metadata plus live on-chain bin state around the active
   * bin. The bin liquidity comes from the chain, not the indexer, because it is
   * what a position would actually be opened against.
   */
  app.get("/api/pools/:address", async (req, reply) => {
    const { address } = req.params as { address: string };
    try {
      const [meta, pool] = await Promise.all([
        dataApi.pool(address).catch(() => null),
        client.getPool(address, { fresh: true }),
      ]);

      const activeBinId = pool.lbPair.activeId;
      const { bins } = await pool.getBinsAroundActiveBin(CHART_BINS, CHART_BINS);
      const decimalsX = pool.tokenX.mint.decimals;
      const decimalsY = pool.tokenY.mint.decimals;
      const priceUsdX = meta?.token_x.price ?? 0;
      const priceUsdY = meta?.token_y.price ?? 0;

      // Default range the "open position" form starts from.
      const suggested = rangeAround(activeBinId, cfg.rangeBins);

      // Despite its name, getDynamicFee() returns the TOTAL fee percentage
      // (base + volatility-driven variable), not the variable part alone.
      // Report both so the UI can show what a swap actually pays right now.
      const feeInfo = pool.getFeeInfo();
      const totalFeePct = Number(pool.getDynamicFee());
      const baseFeePct = Number(feeInfo.baseFeeRatePercentage);

      // Best-effort: a wallet-read failure must not break the pool page, since
      // the chart and range data are useful even with no wallet configured.
      let walletBalances: { x: number; y: number } | null = null;
      if (client.wallet()) {
        try {
          const [balXRaw, balYRaw] = await Promise.all([
            client.tokenBalance(pool.tokenX.publicKey, pool.tokenX.owner),
            client.tokenBalance(pool.tokenY.publicKey, pool.tokenY.owner),
          ]);
          walletBalances = { x: toUi(balXRaw, decimalsX), y: toUi(balYRaw, decimalsY) };
        } catch (e) {
          log.debug({ address, err: msg(e) }, "wallet balance lookup failed");
        }
      }

      return {
        address,
        name: meta?.name ?? address.slice(0, 8),
        binStep: pool.lbPair.binStep,
        activeBinId,
        activePrice: priceOfBin(pool, activeBinId),
        baseFeePct,
        totalFeePct,
        variableFeePct: Math.max(0, totalFeePct - baseFeePct),
        maxFeePct: Number(feeInfo.maxFeeRatePercentage),
        tvl: meta?.tvl ?? null,
        feeTvlDailyPct: meta?.apr ?? null,
        apyPct: meta?.apy ?? null,
        volume24h: meta?.volume?.["24h"] ?? null,
        fees24h: meta?.fees?.["24h"] ?? null,
        isBlacklisted: meta?.is_blacklisted ?? false,
        tokenX: {
          mint: pool.tokenX.publicKey.toBase58(),
          symbol: meta?.token_x.symbol ?? "X",
          decimals: decimalsX,
          priceUsd: priceUsdX,
        },
        tokenY: {
          mint: pool.tokenY.publicKey.toBase58(),
          symbol: meta?.token_y.symbol ?? "Y",
          decimals: decimalsY,
          priceUsd: priceUsdY,
        },
        walletBalances,
        suggestedRange: {
          ...suggested,
          rangeBins: cfg.rangeBins,
          minPrice: priceOfBin(pool, suggested.minBinId),
          maxPrice: priceOfBin(pool, suggested.maxBinId),
        },
        bins: bins.map((b) => ({
          binId: b.binId,
          price: Number(b.pricePerToken),
          amountX: toUi(b.xAmount, decimalsX),
          amountY: toUi(b.yAmount, decimalsY),
          liquidityUsd: toUi(b.xAmount, decimalsX) * priceUsdX + toUi(b.yAmount, decimalsY) * priceUsdY,
        })),
      };
    } catch (e) {
      log.warn({ address, err: msg(e) }, "pool detail failed");
      return reply.code(502).send({ error: msg(e) });
    }
  });
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

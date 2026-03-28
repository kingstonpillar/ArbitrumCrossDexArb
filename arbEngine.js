// arbEngine.js
import "dotenv/config";
import { JsonRpcProvider } from "ethers";
import { buildArbRouteRegistry } from "./arbRouteRegistry.js";
import { startListener } from "./listener.js";
import { quoteRoute } from "./quoteEngine.js";
import {
  recordRouteFailure,
  clearRouteFailure,
} from "./badRouteFilter.js";

const ARBITRUM_RPC_URL = process.env.ARBITRUM_RPC_URL;

if (!ARBITRUM_RPC_URL) {
  throw new Error("Missing ARBITRUM_RPC_URL in environment");
}

const LOG_DIRTY_BATCHES =
  String(process.env.LOG_DIRTY_BATCHES || "true") === "true";

export async function startArbEngine({
  uniswapQuoterAddress,
  onQuote,
}) {
  const httpProvider = new JsonRpcProvider(ARBITRUM_RPC_URL, 42161);

  const registry = await buildArbRouteRegistry();
  const quoteCache = new Map();
  const inFlightRouteIds = new Set();

  async function processRouteIds(routeIds, meta = []) {
    const uniqueRouteIds = [...new Set(routeIds)];

    if (LOG_DIRTY_BATCHES && uniqueRouteIds.length > 0) {
      console.log(
        `[PROCESS_ROUTES] count=${uniqueRouteIds.length} meta=${meta.length}`
      );
    }

    for (const routeId of uniqueRouteIds) {
      if (inFlightRouteIds.has(routeId)) {
        continue;
      }

      const route = registry.routesById.get(routeId);
      if (!route) {
        continue;
      }

      inFlightRouteIds.add(routeId);

      try {
        const quote = await quoteRoute({
          route,
          quoterAddress: uniswapQuoterAddress,
        });

        quoteCache.set(routeId, quote);
        clearRouteFailure(route.pairKey, route.pathKey);

        if (typeof onQuote === "function") {
          const routeMeta =
            meta.find((item) => item?.routeId === routeId) || null;

          await onQuote(quote, {
            route,
            registry,
            quoteCache,
            provider: httpProvider,
            meta: routeMeta,
          });
        }

        console.log(
          `[QUOTE] ${quote.routeId} ${quote.buyDex}->${quote.sellDex} gross=${quote.grossProfit.toString()}`
        );
      } catch (error) {
        const errorMessage = error?.message || String(error);
        console.error(`[QUOTE_FAIL] ${routeId}`, errorMessage);
        recordRouteFailure(route.pairKey, route.pathKey, errorMessage);
      } finally {
        inFlightRouteIds.delete(routeId);
      }
    }
  }

  await processRouteIds(registry.activeRoutes.map((r) => r.id));

  const stop = startListener({
    poolToRouteIds: registry.poolToRouteIds,
    poolsByAddress: registry.poolsByAddress,
    onRoutesDirty: ({ routeIds, meta = [] }) => {
      processRouteIds(routeIds, meta).catch((error) => {
        console.error("[PROCESS_FAIL]", error?.message || error);
      });
    },
  });

  return {
    registry,
    quoteCache,
    stop,
    processRouteIds,
  };
}
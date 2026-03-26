import "dotenv/config";
import { JsonRpcProvider } from "ethers";
import { buildArbRouteRegistry } from "./arbRouteRegistry.js";
import { startListener } from "./listener.js";
import { quoteRoute } from "./quoteEngine.js";

const ARBITRUM_RPC_URL = process.env.ARBITRUM_RPC_URL;

if (!ARBITRUM_RPC_URL) {
  throw new Error("Missing ARBITRUM_RPC_URL in environment");
}

export async function startArbEngine({
  uniswapQuoterAddress,
  onQuote,
}) {
  const httpProvider = new JsonRpcProvider(ARBITRUM_RPC_URL);

  const registry = await buildArbRouteRegistry();
  const quoteCache = new Map();
  const inFlightRouteIds = new Set();

  async function processRouteIds(routeIds) {
    const uniqueRouteIds = [...new Set(routeIds)];

    for (const routeId of uniqueRouteIds) {
      if (inFlightRouteIds.has(routeId)) continue;

      const route = registry.routesById.get(routeId);
      if (!route) continue;

      inFlightRouteIds.add(routeId);

      try {
        const quote = await quoteRoute({
          route,
          quoterAddress: uniswapQuoterAddress,
        });

        quoteCache.set(routeId, quote);

        if (typeof onQuote === "function") {
          await onQuote(quote, {
            route,
            registry,
            quoteCache,
            provider: httpProvider,
          });
        }

        console.log(
          `[QUOTE] ${quote.routeId} ${quote.buyDex}->${quote.sellDex} gross=${quote.grossProfit.toString()}`
        );
      } catch (error) {
        console.error(`[QUOTE_FAIL] ${routeId}`, error?.message || error);
      } finally {
        inFlightRouteIds.delete(routeId);
      }
    }
  }

  await processRouteIds(registry.activeRoutes.map((r) => r.id));

  const stop = startListener({
    poolToRouteIds: registry.poolToRouteIds,
    poolsByAddress: registry.poolsByAddress,
    onRoutesDirty: ({ routeIds }) => {
      processRouteIds(routeIds).catch((error) => {
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
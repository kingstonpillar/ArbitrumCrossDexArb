import { TOKENS } from "./tokens.js";
import { TRADE_SIZES } from "./tradeSizes.js";
import { ARB_PATHS } from "./arbPaths.js";
import { isBlockedRoute } from "./badRouteFilter.js";

const ALLOWED_ROUTES = [
  { pairKey: "LINK/WETH", borrowSymbol: "WETH", intermediateSymbol: "LINK" },
  { pairKey: "ARB/WETH", borrowSymbol: "WETH", intermediateSymbol: "ARB" },
  { pairKey: "WBTC/WETH", borrowSymbol: "WETH", intermediateSymbol: "WBTC" },
  { pairKey: "GMX/WETH", borrowSymbol: "WETH", intermediateSymbol: "GMX" },
  { pairKey: "RDNT/WETH", borrowSymbol: "WETH", intermediateSymbol: "RDNT" },
  { pairKey: "MAGIC/WETH", borrowSymbol: "WETH", intermediateSymbol: "MAGIC" },
  { pairKey: "GRAIL/WETH", borrowSymbol: "WETH", intermediateSymbol: "GRAIL" },
  { pairKey: "UNI/WETH", borrowSymbol: "WETH", intermediateSymbol: "UNI" },
  { pairKey: "AAVE/WETH", borrowSymbol: "WETH", intermediateSymbol: "AAVE" },

  { pairKey: "LINK/USDC", borrowSymbol: "USDC", intermediateSymbol: "LINK" },
  { pairKey: "ARB/USDC", borrowSymbol: "USDC", intermediateSymbol: "ARB" },
  { pairKey: "WBTC/USDC", borrowSymbol: "USDC", intermediateSymbol: "WBTC" },
  { pairKey: "GMX/USDC", borrowSymbol: "USDC", intermediateSymbol: "GMX" },
  { pairKey: "RDNT/USDC", borrowSymbol: "USDC", intermediateSymbol: "RDNT" },
  { pairKey: "MAGIC/USDC", borrowSymbol: "USDC", intermediateSymbol: "MAGIC" },
  { pairKey: "GRAIL/USDC", borrowSymbol: "USDC", intermediateSymbol: "GRAIL" },
  { pairKey: "UNI/USDC", borrowSymbol: "USDC", intermediateSymbol: "UNI" },
  { pairKey: "AAVE/USDC", borrowSymbol: "USDC", intermediateSymbol: "AAVE" },
];

function shouldSkipPair(baseSymbol, quoteSymbol) {
  const blockedPairs = new Set([
    "USDC/USDT",
    "USDT/USDC",
    "USDC/DAI",
    "DAI/USDC",
    "USDT/DAI",
    "DAI/USDT",

    "ARB/USDC",
    "WBTC/USDC",

    "ARB/USDT",
    "LINK/USDT",
  ]);

  return blockedPairs.has(`${baseSymbol}/${quoteSymbol}`);
}

function resolveUniswapFee(borrowSymbol, intermediateSymbol) {
  if (
    (borrowSymbol === "WETH" &&
      (intermediateSymbol === "USDC" || intermediateSymbol === "USDT")) ||
    (intermediateSymbol === "WETH" &&
      (borrowSymbol === "USDC" || borrowSymbol === "USDT"))
  ) {
    return 500;
  }

  return 3000;
}

export function generateRoutes() {
  const routes = [];

  let totalConfigs = 0;
  let skippedPair = 0;
  let skippedToken = 0;
  let skippedSize = 0;
  let skippedBlockedRoute = 0;
  let created = 0;

  for (const config of ALLOWED_ROUTES) {
    totalConfigs++;

    const baseSymbol = config.borrowSymbol;
    const quoteSymbol = config.intermediateSymbol;

    // 🔴 pair-level skip
    if (shouldSkipPair(baseSymbol, quoteSymbol)) {
      skippedPair++;
      console.warn(`[ROUTE_SKIP_PAIR] ${baseSymbol}/${quoteSymbol}`);
      continue;
    }

    const baseToken = TOKENS[baseSymbol];
    const quoteToken = TOKENS[quoteSymbol];

    if (!baseToken || !quoteToken) {
      skippedToken++;
      console.warn(
        `[ROUTE_SKIP_TOKEN] missing token base=${baseSymbol} quote=${quoteSymbol}`
      );
      continue;
    }

    const sizes = TRADE_SIZES[baseSymbol];
    if (!sizes || sizes.length === 0) {
      skippedSize++;
      console.warn(`[ROUTE_SKIP_SIZE] ${baseSymbol} has no trade sizes`);
      continue;
    }

    const uniswapFee = resolveUniswapFee(baseSymbol, quoteSymbol);

    for (const amountIn of sizes) {
      for (const path of ARB_PATHS) {
        const pathKey = `${path.buy}->${path.sell}`;
        const routeKey = `${config.pairKey}|${pathKey}`;

        // 🔴 route-level skip
        if (isBlockedRoute(config.pairKey, pathKey)) {
          skippedBlockedRoute++;
          console.warn(`[ROUTE_BLOCKED] ${routeKey}`);
          continue;
        }

        routes.push({
          id: `${config.pairKey}-${pathKey}-${amountIn.toString()}`,
          pairKey: config.pairKey,
          pathKey,

          base: baseToken,
          quote: quoteToken,

          borrowSymbol: baseSymbol,
          intermediateSymbol: quoteSymbol,

          buyDex: path.buy,
          sellDex: path.sell,
          amountIn,
          uniswapFee,
        });

        created++;
      }
    }
  }

  // ✅ summary log (very important)
  console.log(
    `[ROUTE_GENERATION_SUMMARY] totalConfigs=${totalConfigs} created=${created} skippedPair=${skippedPair} skippedToken=${skippedToken} skippedSize=${skippedSize} blockedRoute=${skippedBlockedRoute}`
  );

  return routes;
}
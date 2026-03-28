import { TOKENS } from "./tokens.js";
import { TRADE_SIZES } from "./tradeSizes.js";
import { ARB_PATHS } from "./arbPaths.js";

const ALLOWED_ROUTES = [
  { pairKey: "LINK/WETH", borrowSymbol: "WETH", intermediateSymbol: "LINK" },
  { pairKey: "ARB/WETH", borrowSymbol: "WETH", intermediateSymbol: "ARB" },
  { pairKey: "WBTC/WETH", borrowSymbol: "WETH", intermediateSymbol: "WBTC" },

  { pairKey: "WETH/USDC", borrowSymbol: "WETH", intermediateSymbol: "USDC" },
  { pairKey: "WETH/USDT", borrowSymbol: "WETH", intermediateSymbol: "USDT" },

  { pairKey: "LINK/USDC", borrowSymbol: "USDC", intermediateSymbol: "LINK" },
  { pairKey: "ARB/USDC", borrowSymbol: "USDC", intermediateSymbol: "ARB" },
  { pairKey: "WBTC/USDC", borrowSymbol: "USDC", intermediateSymbol: "WBTC" },

  { pairKey: "LINK/USDT", borrowSymbol: "USDT", intermediateSymbol: "LINK" },
  { pairKey: "ARB/USDT", borrowSymbol: "USDT", intermediateSymbol: "ARB" },
  { pairKey: "WBTC/USDT", borrowSymbol: "USDT", intermediateSymbol: "WBTC" },
];

function shouldSkipPair(baseSymbol, quoteSymbol) {
  const blockedPairs = new Set([
    "USDC/USDT",
    "USDT/USDC",
    "USDC/DAI",
    "DAI/USDC",
    "USDT/DAI",
    "DAI/USDT",
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

  for (const config of ALLOWED_ROUTES) {
    const baseSymbol = config.borrowSymbol;
    const quoteSymbol = config.intermediateSymbol;

    if (shouldSkipPair(baseSymbol, quoteSymbol)) {
      continue;
    }

    const baseToken = TOKENS[baseSymbol];
    const quoteToken = TOKENS[quoteSymbol];

    if (!baseToken || !quoteToken) {
      continue;
    }

    const sizes = TRADE_SIZES[baseSymbol] || [];
    const uniswapFee = resolveUniswapFee(baseSymbol, quoteSymbol);

    for (const amountIn of sizes) {
      for (const path of ARB_PATHS) {
        routes.push({
          id: `${config.pairKey}-${path.buy}->${path.sell}-${amountIn.toString()}`,
          pairKey: config.pairKey,
          pathKey: `${path.buy}->${path.sell}`,

          // internal trading logic
          base: baseToken,
          quote: quoteToken,

          // explicit route meaning
          borrowSymbol: baseSymbol,
          intermediateSymbol: quoteSymbol,

          buyDex: path.buy,
          sellDex: path.sell,
          amountIn,
          uniswapFee,
        });
      }
    }
  }

  return routes;
}
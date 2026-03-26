import { TOKENS } from "./tokens.js";
import { TRADE_SIZES } from "./tradeSizes.js";
import { ARB_PATHS } from "./arbPaths.js";

const BASE_TOKENS = ["WETH", "USDC"];

function resolveUniswapFee(baseSymbol, quoteSymbol) {
  if (
    (baseSymbol === "WETH" && (quoteSymbol === "USDC" || quoteSymbol === "USDT")) ||
    (quoteSymbol === "WETH" && (baseSymbol === "USDC" || baseSymbol === "USDT"))
  ) {
    return 500;
  }

  return 3000;
}

export function generateRoutes() {
  const routes = [];

  for (const baseSymbol of BASE_TOKENS) {
    const baseToken = TOKENS[baseSymbol];
    const sizes = TRADE_SIZES[baseSymbol] || [];

    for (const quoteSymbol in TOKENS) {
      if (quoteSymbol === baseSymbol) continue;

      const quoteToken = TOKENS[quoteSymbol];
      const uniswapFee = resolveUniswapFee(baseSymbol, quoteSymbol);

      for (const amountIn of sizes) {
        for (const path of ARB_PATHS) {
          routes.push({
            id: `${baseSymbol}/${quoteSymbol}-${path.buy}->${path.sell}-${amountIn.toString()}`,
            pairKey: `${baseSymbol}/${quoteSymbol}`,
            pathKey: `${path.buy}->${path.sell}`,
            base: baseToken,
            quote: quoteToken,
            buyDex: path.buy,
            sellDex: path.sell,
            amountIn,
            uniswapFee,
          });
        }
      }
    }
  }

  return routes;
}
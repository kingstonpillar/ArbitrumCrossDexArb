// tradeSizeOptimizer.js

import { TRADE_SIZES } from "./tradesizer.js";
import { quoteRoute } from "./quoteEngine.js";
import { estimateGasCostWei, DEFAULT_GAS_LIMITS } from "./gasEstimator.js";
import { estimateRouteSlippage } from "./slippageEstimator.js";
import { evaluateQuote } from "./comparator.js";
import { getEthereumPriceUsd } from "./ethereumPrice.js";
import { getMinProfitForRoute } from "./profitThresholds.js";

function convertEthCostToBaseTokenWithPrice(gasCostWei, route, ethPriceUsd) {
  const baseSymbol = route?.base?.symbol;

  if (baseSymbol === "WETH") {
    return gasCostWei;
  }

  if (baseSymbol === "USDC" || baseSymbol === "USDT") {
    const gasEth = Number(gasCostWei) / 1e18;
    const gasUsd = gasEth * ethPriceUsd;

    return BigInt(Math.floor(gasUsd * 1e6));
  }

  return gasCostWei;
}

export async function findOptimalTradeSize({
  route,
  quoterAddress,
  safetyBuffer = 50000000000000n,
  flashLoanFee = 0n,
  v3FallbackBps = 40n,
  extraSafetyBps = 20n,
  gasLimit = DEFAULT_GAS_LIMITS.simpleArb,
  debug = false,
}) {
  if (!route?.base?.symbol) {
    return null;
  }

  const sizes = TRADE_SIZES[route.base.symbol] || [];
  if (!sizes.length) {
    return null;
  }

  const gas = await estimateGasCostWei({ gasLimit });

  let ethPriceUsd = null;
  if (route.base.symbol === "USDC" || route.base.symbol === "USDT") {
    ethPriceUsd = await getEthereumPriceUsd();
  }

  let best = null;

  for (const size of sizes) {
    try {
      const sizedRoute = {
        ...route,
        amountIn: size,
      };

      const quote = await quoteRoute({
        route: sizedRoute,
        quoterAddress,
      });

      const slippageBps = estimateRouteSlippage({
        buyLeg: quote.buyLeg,
        sellLeg: quote.sellLeg,
        v3FallbackBps,
        extraSafetyBps,
      });

      const sellAmountAfterSlippage =
        quote.sellAmountOut - (quote.sellAmountOut * slippageBps / 10000n);

      const adjustedQuote = {
        ...quote,
        sellAmountOut: sellAmountAfterSlippage,
        grossProfit: sellAmountAfterSlippage - quote.amountIn,
        slippageBps,
      };

      const gasCostInBaseToken = convertEthCostToBaseTokenWithPrice(
        gas.gasCostWei,
        sizedRoute,
        ethPriceUsd
      );

      const minProfit = getMinProfitForRoute(sizedRoute);

      const evaluated = evaluateQuote(adjustedQuote, {
        gasCost: gasCostInBaseToken,
        flashLoanFee,
        safetyBuffer,
        minProfit,
      });

      const candidate = {
        size,
        route: sizedRoute,
        quote,
        adjustedQuote,
        evaluated,
        gas,
        gasCostInBaseToken,
        slippageBps,
        minProfit,
      };

      if (!best || candidate.evaluated.netProfit > best.evaluated.netProfit) {
        best = candidate;
      }
    } catch (error) {
      if (debug) {
        console.error(
          `[SIZE_OPTIMIZER_FAIL] route=${route?.id} size=${size?.toString?.() ?? size}`,
          error?.message || error
        );
      }
    }
  }

  if (!best) return null;
  if (!best.evaluated.isProfitable) return null;

  return best;
}
import "dotenv/config";
import { startArbEngine } from "./arbEngine.js";
import { evaluateQuote } from "./comparator.js";
import { estimateGasCostWei, DEFAULT_GAS_LIMITS } from "./gasEstimator.js";
import { estimateRouteSlippage } from "./slippageEstimator.js";
import { sendTelegramAlert } from "./telegramAlert.js";
import { getEthereumPriceUsd } from "./ethereumPrice.js";
import { findOptimalTradeSize } from "./tradeSizeOptimizer.js";
import { getMinProfitForRoute } from "./profitThresholds.js";
// import { buildSwapTx } from "./buildSwapTx.js";

const evaluatedMap = new Map();
const alertedRoutes = new Map();

const CONFIG = {
  safetyBuffer: 50000000000000n,
  flashLoanFee: 0n,
  v3FallbackBps: 40n,
  extraSafetyBps: 20n,
  alertCooldownMs: 15000,
  staleAfterMs: 10000,
  executionDeadlineSec: 20,
  precheckMultiplierBps: 5000n,
};

function getPrecheckMinProfit(route) {
  const minProfit = getMinProfitForRoute(route);
  return (minProfit * CONFIG.precheckMultiplierBps) / 10000n;
}

function formatTokenAmount(amount, decimals = 18, fractionDigits = 6) {
  const raw = typeof amount === "bigint" ? amount : BigInt(amount || 0);
  const base = 10n ** BigInt(decimals);
  const whole = raw / base;
  const fraction = raw % base;

  const padded = fraction.toString().padStart(decimals, "0");
  const trimmed = padded.slice(0, fractionDigits).replace(/0+$/, "");

  return trimmed ? `${whole.toString()}.${trimmed}` : whole.toString();
}

async function convertEthCostToBaseToken(gasCostWei, route) {
  const baseSymbol = route?.base?.symbol;

  if (baseSymbol === "WETH") {
    return gasCostWei;
  }

  if (baseSymbol === "USDC" || baseSymbol === "USDT") {
    const ethPriceUsd = await getEthereumPriceUsd();
    const gasEth = Number(gasCostWei) / 1e18;
    const gasUsd = gasEth * ethPriceUsd;

    return BigInt(Math.floor(gasUsd * 1e6));
  }

  return gasCostWei;
}

function dexTypeToId(dexType) {
  if (dexType === "v2") return 0;
  if (dexType === "v3") return 1;
  throw new Error(`Unsupported dex type: ${dexType}`);
}

function buildExecutionPayload({
  route,
  quote,
  adjustedQuote,
  evaluated,
  gas,
  gasCostInBaseToken,
  slippageBps,
  minProfit,
}) {
  const minBuyAmountOut =
    quote.buyAmountOut - (quote.buyAmountOut * slippageBps / 10000n);

  const minSellAmountOut = adjustedQuote.sellAmountOut;

  return {
    routeId: evaluated.routeId,
    pairKey: evaluated.pairKey,
    pathKey: evaluated.pathKey,

    loanToken: route.base.address,
    loanAmount: quote.amountIn,

    baseToken: route.base.address,
    quoteToken: route.quote.address,

    baseSymbol: route.base.symbol,
    quoteSymbol: route.quote.symbol,

    baseDecimals: route.base.decimals,
    quoteDecimals: route.quote.decimals,

    buyDex: route.buyDex,
    sellDex: route.sellDex,

    buyDexType: route.buyPool.type,
    sellDexType: route.sellPool.type,

    buyDexTypeId: dexTypeToId(route.buyPool.type),
    sellDexTypeId: dexTypeToId(route.sellPool.type),

    buyTarget: route.buyRouter,
    sellTarget: route.sellRouter,

    buyFee: route.buyPool.fee ?? 0,
    sellFee: route.sellPool.fee ?? 0,

    buyTokenIn: route.base.address,
    buyTokenOut: route.quote.address,
    sellTokenIn: route.quote.address,
    sellTokenOut: route.base.address,

    amountIn: quote.amountIn,
    quotedBuyAmountOut: quote.buyAmountOut,
    quotedSellAmountOut: quote.sellAmountOut,

    minBuyAmountOut,
    minSellAmountOut,

    grossProfit: evaluated.grossProfit,
    netProfit: evaluated.netProfit,

    gasCostWei: gas.gasCostWei,
    gasCostInBaseToken,
    slippageBps,

    flashLoanFee: CONFIG.flashLoanFee,
    safetyBuffer: CONFIG.safetyBuffer,
    minProfit,

    deadline: BigInt(Math.floor(Date.now() / 1000) + CONFIG.executionDeadlineSec),
  };
}

async function handleQuote(quote, { route }) {
  const gas = await estimateGasCostWei({
    gasLimit: DEFAULT_GAS_LIMITS.simpleArb,
  });

  const slippageBps = estimateRouteSlippage({
    buyLeg: quote.buyLeg,
    sellLeg: quote.sellLeg,
    v3FallbackBps: CONFIG.v3FallbackBps,
    extraSafetyBps: CONFIG.extraSafetyBps,
  });

  const sellAmountAfterSlippage =
    quote.sellAmountOut - (quote.sellAmountOut * slippageBps / 10000n);

  const adjustedQuote = {
    ...quote,
    sellAmountOut: sellAmountAfterSlippage,
    grossProfit: sellAmountAfterSlippage - quote.amountIn,
    slippageBps,
  };

  const gasCostInBaseToken = await convertEthCostToBaseToken(
    gas.gasCostWei,
    route
  );

  const precheckMinProfit = getPrecheckMinProfit(route);

  const firstPass = evaluateQuote(adjustedQuote, {
    gasCost: gasCostInBaseToken,
    flashLoanFee: CONFIG.flashLoanFee,
    safetyBuffer: CONFIG.safetyBuffer,
    minProfit: precheckMinProfit,
  });

  if (!firstPass.isProfitable) {
    evaluatedMap.delete(quote.routeId);
    return;
  }

  const optimal = await findOptimalTradeSize({
    route,
    quoterAddress: process.env.UNISWAP_QUOTER,
    safetyBuffer: CONFIG.safetyBuffer,
    flashLoanFee: CONFIG.flashLoanFee,
    v3FallbackBps: CONFIG.v3FallbackBps,
    extraSafetyBps: CONFIG.extraSafetyBps,
  });

  if (!optimal) {
    evaluatedMap.delete(quote.routeId);
    return;
  }

  const optimizedRoute = optimal.route;
  const optimizedQuote = optimal.quote;
  const adjustedOptimizedQuote = optimal.adjustedQuote;
  const evaluated = optimal.evaluated;
  const optimizedGas = optimal.gas;
  const optimizedGasCostInBaseToken = optimal.gasCostInBaseToken;
  const optimizedSlippageBps = optimal.slippageBps;
  const minProfit = optimal.minProfit;

  const executionPayload = buildExecutionPayload({
    route: optimizedRoute,
    quote: optimizedQuote,
    adjustedQuote: adjustedOptimizedQuote,
    evaluated,
    gas: optimizedGas,
    gasCostInBaseToken: optimizedGasCostInBaseToken,
    slippageBps: optimizedSlippageBps,
    minProfit,
  });

  evaluatedMap.set(optimizedQuote.routeId, {
    ...evaluated,
    updatedAt: Date.now(),
    gasCostWei: optimizedGas.gasCostWei,
    gasCostInBaseToken: optimizedGasCostInBaseToken,
    baseSymbol: optimizedRoute.base.symbol,
    baseDecimals: optimizedRoute.base.decimals,
    slippageBps: optimizedSlippageBps,
    executionPayload,
    optimalSize: optimal.size,
  });

  console.log(
    `[OPPORTUNITY] ${evaluated.routeId} size=${formatTokenAmount(optimal.size, optimizedRoute.base.decimals)} ${optimizedRoute.base.symbol} gross=${evaluated.grossProfit.toString()} net=${evaluated.netProfit.toString()}`
  );

  console.log("[EXECUTION_PAYLOAD]");
  console.log({
    routeId: executionPayload.routeId,
    loanToken: executionPayload.loanToken,
    loanAmount: executionPayload.loanAmount.toString(),
    buyDex: executionPayload.buyDex,
    sellDex: executionPayload.sellDex,
    minBuyAmountOut: executionPayload.minBuyAmountOut.toString(),
    minSellAmountOut: executionPayload.minSellAmountOut.toString(),
    deadline: executionPayload.deadline.toString(),
  });

  // later:
  // await buildSwapTx(executionPayload);

  const now = Date.now();
  const lastAlertAt = alertedRoutes.get(evaluated.routeId) || 0;

  if (now - lastAlertAt < CONFIG.alertCooldownMs) {
    return;
  }

  alertedRoutes.set(evaluated.routeId, now);

  const message = [
    `🚨 <b>Arbitrage Opportunity Found</b>`,
    `Route: <code>${evaluated.routeId}</code>`,
    `Pair: <b>${evaluated.pairKey}</b>`,
    `Path: <b>${evaluated.pathKey}</b>`,
    `Buy DEX: <b>${evaluated.buyDex}</b>`,
    `Sell DEX: <b>${evaluated.sellDex}</b>`,
    `Optimal Size: <b>${formatTokenAmount(optimal.size, optimizedRoute.base.decimals)} ${optimizedRoute.base.symbol}</b>`,
    `Gross Profit: <b>${formatTokenAmount(evaluated.grossProfit, optimizedRoute.base.decimals)} ${optimizedRoute.base.symbol}</b>`,
    `Net Profit: <b>${formatTokenAmount(evaluated.netProfit, optimizedRoute.base.decimals)} ${optimizedRoute.base.symbol}</b>`,
    `Gas Cost: <b>${formatTokenAmount(optimizedGasCostInBaseToken, optimizedRoute.base.decimals)} ${optimizedRoute.base.symbol}</b>`,
    `Gas Cost Wei: <b>${optimizedGas.gasCostWei.toString()}</b>`,
    `Slippage Bps: <b>${optimizedSlippageBps.toString()}</b>`,
    `Threshold: <b>${formatTokenAmount(minProfit, optimizedRoute.base.decimals)} ${optimizedRoute.base.symbol}</b>`,
  ].join("\n");

  try {
    await sendTelegramAlert(message);
  } catch (error) {
    console.error("[TELEGRAM_ALERT_FAIL]", error?.message || error);
  }
}

function pruneStale(maxAgeMs = CONFIG.staleAfterMs) {
  const now = Date.now();

  for (const [routeId, item] of evaluatedMap.entries()) {
    if (now - item.updatedAt > maxAgeMs) {
      evaluatedMap.delete(routeId);
    }
  }
}

function printBest() {
  pruneStale();

  const opportunities = Array.from(evaluatedMap.values());
  if (!opportunities.length) return;

  opportunities.sort((a, b) => {
    if (a.netProfit === b.netProfit) return 0;
    return a.netProfit > b.netProfit ? -1 : 1;
  });

  const best = opportunities[0];

  console.log("\nBEST OPPORTUNITY");
  console.log(best.routeId);
  console.log(`pair=${best.pairKey}`);
  console.log(`path=${best.pathKey}`);
  console.log(
    `optimalSize=${formatTokenAmount(best.optimalSize, best.baseDecimals)} ${best.baseSymbol}`
  );
  console.log(
    `grossProfit=${formatTokenAmount(best.grossProfit, best.baseDecimals)} ${best.baseSymbol}`
  );
  console.log(
    `netProfit=${formatTokenAmount(best.netProfit, best.baseDecimals)} ${best.baseSymbol}`
  );
  console.log(
    `gasCost=${formatTokenAmount(best.gasCostInBaseToken, best.baseDecimals)} ${best.baseSymbol}`
  );
  console.log(`gasCostWei=${best.gasCostWei.toString()}`);
  console.log(`slippageBps=${best.slippageBps.toString()}\n`);
}

async function main() {
  await startArbEngine({
    uniswapQuoterAddress: process.env.UNISWAP_QUOTER,
    onQuote: handleQuote,
  });

  setInterval(printBest, 3000);
}

main().catch((error) => {
  console.error("[MAIN_FAIL]", error?.message || error);
});
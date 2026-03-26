// comparator.js

function toBigIntSafe(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));
  if (typeof value === "string") return BigInt(value);
  return 0n;
}

function defaultGasCost() {
  return 0n;
}

function defaultFlashLoanFee() {
  return 0n;
}

function defaultSafetyBuffer() {
  return 0n;
}

function defaultMinProfit() {
  return 0n;
}

export function evaluateQuote(
  quote,
  {
    gasCost = defaultGasCost(),
    flashLoanFee = defaultFlashLoanFee(),
    safetyBuffer = defaultSafetyBuffer(),
    minProfit = defaultMinProfit(),
  } = {}
) {
  const amountIn = toBigIntSafe(quote?.amountIn);
  const sellAmountOut = toBigIntSafe(quote?.sellAmountOut);

  const grossProfit = toBigIntSafe(
    quote?.grossProfit ?? (sellAmountOut - amountIn)
  );

  const resolvedGasCost = toBigIntSafe(gasCost);
  const resolvedFlashLoanFee = toBigIntSafe(flashLoanFee);
  const resolvedSafetyBuffer = toBigIntSafe(safetyBuffer);
  const resolvedMinProfit = toBigIntSafe(minProfit);

  const totalCost =
    resolvedGasCost +
    resolvedFlashLoanFee +
    resolvedSafetyBuffer;

  const netProfit = grossProfit - totalCost;
  const isProfitable = netProfit >= resolvedMinProfit;

  return {
    ...quote,

    gasCost: resolvedGasCost,
    flashLoanFee: resolvedFlashLoanFee,
    safetyBuffer: resolvedSafetyBuffer,
    minProfit: resolvedMinProfit,

    totalCost,
    grossProfit,
    netProfit,

    isProfitable,
    status: isProfitable ? "actionable" : "ignore",
  };
}

export function evaluateQuotes(
  quotes,
  {
    gasCostResolver,
    flashLoanFeeResolver,
    safetyBufferResolver,
    minProfitResolver,
  } = {}
) {
  const results = [];

  for (const quote of quotes) {
    const gasCost = gasCostResolver ? gasCostResolver(quote) : 0n;
    const flashLoanFee = flashLoanFeeResolver
      ? flashLoanFeeResolver(quote)
      : 0n;
    const safetyBuffer = safetyBufferResolver
      ? safetyBufferResolver(quote)
      : 0n;
    const minProfit = minProfitResolver
      ? minProfitResolver(quote)
      : 0n;

    results.push(
      evaluateQuote(quote, {
        gasCost,
        flashLoanFee,
        safetyBuffer,
        minProfit,
      })
    );
  }

  return results;
}

export function getProfitableQuotes(results) {
  return results.filter((item) => item.isProfitable);
}

export function rankQuotesByNetProfit(results) {
  return [...results].sort((a, b) => {
    if (a.netProfit === b.netProfit) return 0;
    return a.netProfit > b.netProfit ? -1 : 1;
  });
}

export function getBestOpportunity(results) {
  const ranked = rankQuotesByNetProfit(getProfitableQuotes(results));
  return ranked[0] || null;
}

export function groupByPair(results) {
  const grouped = new Map();

  for (const item of results) {
    const key = item.pairKey || "UNKNOWN";

    if (!grouped.has(key)) {
      grouped.set(key, []);
    }

    grouped.get(key).push(item);
  }

  return grouped;
}

export function groupByPath(results) {
  const grouped = new Map();

  for (const item of results) {
    const key = item.pathKey || `${item.buyDex}->${item.sellDex}`;

    if (!grouped.has(key)) {
      grouped.set(key, []);
    }

    grouped.get(key).push(item);
  }

  return grouped;
}

export function summarizeComparatorResults(results) {
  const profitable = getProfitableQuotes(results);
  const ranked = rankQuotesByNetProfit(profitable);
  const best = ranked[0] || null;

  return {
    total: results.length,
    profitable: profitable.length,
    rejected: results.length - profitable.length,
    best,
    ranked,
  };
}
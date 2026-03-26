// slippageEstimator.js

function toBigIntSafe(value, fallback = 0n) {
  try {
    if (typeof value === "bigint") return value;
    if (typeof value === "number") return BigInt(Math.trunc(value));
    if (typeof value === "string") return BigInt(value);
    return fallback;
  } catch {
    return fallback;
  }
}

export function applyBpsReduction(amount, bps) {
  const x = toBigIntSafe(amount);
  const b = toBigIntSafe(bps);
  return x - (x * b / 10000n);
}

export function estimateV2PriceImpactBps({
  amountIn,
  reserveIn,
  reserveOut,
}) {
  const aIn = toBigIntSafe(amountIn);
  const rIn = toBigIntSafe(reserveIn);
  const rOut = toBigIntSafe(reserveOut);

  if (aIn <= 0n || rIn <= 0n || rOut <= 0n) {
    return 0n;
  }

  // rough impact proxy:
  // trade size as a fraction of input reserve
  return (aIn * 10000n) / rIn;
}

export function estimateLegSlippageBps({
  legType,
  amountIn,
  reserveIn,
  reserveOut,
  fallbackBps = 50n,
}) {
  if (legType === "v2") {
    return estimateV2PriceImpactBps({
      amountIn,
      reserveIn,
      reserveOut,
    });
  }

  // for v3 first pass, use fallback buffer
  return toBigIntSafe(fallbackBps);
}

export function estimateRouteSlippage({
  buyLeg,
  sellLeg,
  v3FallbackBps = 50n,
  extraSafetyBps = 20n,
}) {
  const buyBps = estimateLegSlippageBps({
    legType: buyLeg?.type,
    amountIn: buyLeg?.amountIn,
    reserveIn: buyLeg?.reserveIn,
    reserveOut: buyLeg?.reserveOut,
    fallbackBps: v3FallbackBps,
  });

  const sellBps = estimateLegSlippageBps({
    legType: sellLeg?.type,
    amountIn: sellLeg?.amountIn,
    reserveIn: sellLeg?.reserveIn,
    reserveOut: sellLeg?.reserveOut,
    fallbackBps: v3FallbackBps,
  });

  return buyBps + sellBps + toBigIntSafe(extraSafetyBps);
}

export function estimateMinAcceptableOut({
  quotedAmountOut,
  totalSlippageBps,
}) {
  return applyBpsReduction(quotedAmountOut, totalSlippageBps);
}
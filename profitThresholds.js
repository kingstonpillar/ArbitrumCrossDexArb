// profitThresholds.js

export const MIN_PROFIT_BY_TOKEN = {
  WETH: 2000000000000000n, // 0.002 WETH
  USDC: 4000000n,          // 4 USDC (adjusted from 6 → matches smaller sizes)
};

export function getMinProfitForRoute(route, multiplierBps = 10000n, extra = 0n) {
  const base = MIN_PROFIT_BY_TOKEN[route?.base?.symbol] ?? 0n;
  return ((base * multiplierBps) / 10000n) + extra;
}
 //quoteEngine.js
import "dotenv/config";
import { Contract, JsonRpcProvider } from "ethers";
import { V2_PAIR_ABI, UNISWAP_V3_QUOTER_ABI } from "./abis.js";
import { withRpcLimit } from "./rpcLimiter.js";

const ARBITRUM_RPC_URL = process.env.ARBITRUM_RPC_URL;
const UNISWAP_QUOTER = process.env.UNISWAP_QUOTER;

if (!ARBITRUM_RPC_URL) {
  throw new Error("Missing ARBITRUM_RPC_URL in environment");
}

if (!UNISWAP_QUOTER) {
  throw new Error("Missing UNISWAP_QUOTER in environment");
}

const provider = new JsonRpcProvider(ARBITRUM_RPC_URL);

const pairCache = new Map();
const quoterCache = new Map();

function getPairContract(pairAddress) {
  const key = pairAddress.toLowerCase();

  if (!pairCache.has(key)) {
    pairCache.set(key, new Contract(pairAddress, V2_PAIR_ABI, provider));
  }

  return pairCache.get(key);
}

function getQuoterContract(quoterAddress = UNISWAP_QUOTER) {
  const key = quoterAddress.toLowerCase();

  if (!quoterCache.has(key)) {
    quoterCache.set(
      key,
      new Contract(quoterAddress, UNISWAP_V3_QUOTER_ABI, provider)
    );
  }

  return quoterCache.get(key);
}

function toBigIntSafe(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));
  if (typeof value === "string") return BigInt(value);
  return 0n;
}

export function getAmountOutV2(amountIn, reserveIn, reserveOut, feeBps = 30) {
  const normalizedAmountIn = toBigIntSafe(amountIn);
  const normalizedReserveIn = toBigIntSafe(reserveIn);
  const normalizedReserveOut = toBigIntSafe(reserveOut);

  if (
    normalizedAmountIn <= 0n ||
    normalizedReserveIn <= 0n ||
    normalizedReserveOut <= 0n
  ) {
    return 0n;
  }

  const feeDen = 10_000n;
  const amountInWithFee = normalizedAmountIn * (feeDen - BigInt(feeBps));
  const numerator = amountInWithFee * normalizedReserveOut;
  const denominator = normalizedReserveIn * feeDen + amountInWithFee;

  if (denominator === 0n) return 0n;
  return numerator / denominator;
}

export async function quoteV2({
  pairAddress,
  tokenIn,
  tokenOut,
  amountIn,
  feeBps = 30,
}) {
  if (!pairAddress || !tokenIn || !tokenOut) {
    throw new Error("Missing V2 quote inputs");
  }

  const normalizedAmountIn = toBigIntSafe(amountIn);
  if (normalizedAmountIn <= 0n) {
    throw new Error("Invalid amountIn for V2 quote");
  }

  const pair = getPairContract(pairAddress);

  const [token0, token1, reserves] = await Promise.all([
    withRpcLimit(() => pair.token0()),
    withRpcLimit(() => pair.token1()),
    withRpcLimit(() => pair.getReserves()),
  ]);

  const reserve0 = toBigIntSafe(reserves[0]);
  const reserve1 = toBigIntSafe(reserves[1]);

  let reserveIn;
  let reserveOut;

  if (
    tokenIn.toLowerCase() === token0.toLowerCase() &&
    tokenOut.toLowerCase() === token1.toLowerCase()
  ) {
    reserveIn = reserve0;
    reserveOut = reserve1;
  } else if (
    tokenIn.toLowerCase() === token1.toLowerCase() &&
    tokenOut.toLowerCase() === token0.toLowerCase()
  ) {
    reserveIn = reserve1;
    reserveOut = reserve0;
  } else {
    throw new Error(`Pair ${pairAddress} does not match token direction`);
  }

  const amountOut = getAmountOutV2(
    normalizedAmountIn,
    reserveIn,
    reserveOut,
    feeBps
  );

  return {
    type: "v2",
    pairAddress,
    token0,
    token1,
    reserveIn,
    reserveOut,
    feeBps,
    amountIn: normalizedAmountIn,
    amountOut,
  };
}

export async function quoteV3({
  tokenIn,
  tokenOut,
  amountIn,
  fee,
  quoterAddress = UNISWAP_QUOTER,
}) {
  if (!tokenIn || !tokenOut || fee === undefined || fee === null) {
    throw new Error("Missing V3 quote inputs");
  }

  const normalizedAmountIn = toBigIntSafe(amountIn);
  if (normalizedAmountIn <= 0n) {
    throw new Error("Invalid amountIn for V3 quote");
  }

  const quoter = getQuoterContract(quoterAddress);

  const result = await withRpcLimit(() =>
    quoter.quoteExactInputSingle.staticCall({
      tokenIn,
      tokenOut,
      amountIn: normalizedAmountIn,
      fee,
      sqrtPriceLimitX96: 0,
    })
  );

  return {
    type: "v3",
    fee,
    amountIn: normalizedAmountIn,
    amountOut: toBigIntSafe(result[0]),
    sqrtPriceX96After: result[1],
    initializedTicksCrossed: result[2],
    gasEstimate: toBigIntSafe(result[3]),
  };
}

export async function quoteLeg({
  leg,
  tokenIn,
  tokenOut,
  amountIn,
  quoterAddress = UNISWAP_QUOTER,
}) {
  if (!leg) {
    throw new Error("Missing leg");
  }

  if (leg.type === "v2") {
    return quoteV2({
      pairAddress: leg.address,
      tokenIn,
      tokenOut,
      amountIn,
      feeBps: leg.feeBps ?? 30,
    });
  }

  if (leg.type === "v3") {
    return quoteV3({
      tokenIn,
      tokenOut,
      amountIn,
      fee: leg.fee,
      quoterAddress,
    });
  }

  throw new Error(`Unsupported leg type: ${leg.type}`);
}

export async function quoteRoute({
  route,
  quoterAddress = UNISWAP_QUOTER,
}) {
  if (!route) {
    throw new Error("Missing route");
  }

  const buyQuote = await quoteLeg({
    leg: route.buyPool,
    tokenIn: route.base.address,
    tokenOut: route.quote.address,
    amountIn: route.amountIn,
    quoterAddress,
  });

  const sellQuote = await quoteLeg({
    leg: route.sellPool,
    tokenIn: route.quote.address,
    tokenOut: route.base.address,
    amountIn: buyQuote.amountOut,
    quoterAddress,
  });

  const grossProfit = sellQuote.amountOut - toBigIntSafe(route.amountIn);

  return {
    routeId: route.id,
    pairKey: route.pairKey,
    pathKey: route.pathKey,
    buyDex: route.buyDex,
    sellDex: route.sellDex,
    baseSymbol: route.base.symbol,
    quoteSymbol: route.quote.symbol,
    amountIn: toBigIntSafe(route.amountIn),
    buyAmountOut: buyQuote.amountOut,
    sellAmountOut: sellQuote.amountOut,
    grossProfit,
    buyLeg: buyQuote,
    sellLeg: sellQuote,
  };
}
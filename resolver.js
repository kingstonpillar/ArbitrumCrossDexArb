import "dotenv/config";
import { Contract, ZeroAddress, JsonRpcProvider } from "ethers";
import {
  V2_FACTORY_ABI,
  V2_PAIR_ABI,
  UNISWAP_V3_FACTORY_ABI,
  UNISWAP_V3_POOL_ABI,
} from "./abis.js";
import { withRpcLimit } from "./rpcLimiter.js";

const UNISWAP_V3_FACTORY = process.env.UNISWAP_V3_FACTORY;
const ARBITRUM_RPC_URL = process.env.ARBITRUM_RPC_URL;

if (!ARBITRUM_RPC_URL) {
  throw new Error("Missing ARBITRUM_RPC_URL in environment");
}

const provider = new JsonRpcProvider(ARBITRUM_RPC_URL);

const ALLOWED_UNI_FEES = new Set([500, 3000, 10000]);

const v2FactoryCache = new Map();

const uniswapV3Factory = UNISWAP_V3_FACTORY
  ? new Contract(UNISWAP_V3_FACTORY, UNISWAP_V3_FACTORY_ABI, provider)
  : null;

function getV2Factory(factoryAddress) {
  const key = factoryAddress.toLowerCase();

  if (!v2FactoryCache.has(key)) {
    v2FactoryCache.set(
      key,
      new Contract(factoryAddress, V2_FACTORY_ABI, provider)
    );
  }

  return v2FactoryCache.get(key);
}

export async function resolveV2Pair(factoryAddress, tokenA, tokenB) {
  return withRpcLimit(async () => {
    if (!factoryAddress || !tokenA || !tokenB) return null;

    const factory = getV2Factory(factoryAddress);
    const pair = await factory.getPair(tokenA, tokenB);

    return pair === ZeroAddress ? null : pair;
  });
}

export async function resolveUniswapV3Pool(tokenA, tokenB, fee) {
  return withRpcLimit(async () => {
    if (!UNISWAP_V3_FACTORY || !uniswapV3Factory) {
      throw new Error("Missing UNISWAP_V3_FACTORY in environment");
    }

    if (!tokenA || !tokenB || fee === undefined || fee === null) {
      return null;
    }

    if (!ALLOWED_UNI_FEES.has(Number(fee))) {
      return null;
    }

    const pool = await uniswapV3Factory.getPool(tokenA, tokenB, fee);
    return pool === ZeroAddress ? null : pool;
  });
}

export async function loadV2PairMeta(pairAddress) {
  return withRpcLimit(async () => {
    if (!pairAddress || pairAddress === ZeroAddress) return null;

    const pair = new Contract(pairAddress, V2_PAIR_ABI, provider);

    const [token0, token1] = await Promise.all([
      withRpcLimit(() => pair.token0()),
      withRpcLimit(() => pair.token1()),
    ]);

    return { pair, token0, token1 };
  });
}

export async function loadV3PoolMeta(poolAddress) {
  return withRpcLimit(async () => {
    if (!poolAddress || poolAddress === ZeroAddress) return null;

    const pool = new Contract(poolAddress, UNISWAP_V3_POOL_ABI, provider);

    const [token0, token1] = await Promise.all([
      withRpcLimit(() => pool.token0()),
      withRpcLimit(() => pool.token1()),
    ]);

    return { pool, token0, token1 };
  });
}
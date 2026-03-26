// ethereumPrice.js
import "dotenv/config";
import { Contract, JsonRpcProvider } from "ethers";
import { withRpcLimit } from "./rpcLimiter.js";

const ARBITRUM_RPC_URL = process.env.ARBITRUM_RPC_URL;
const UNISWAP_WETH_USDC_POOL = process.env.UNISWAP_WETH_USDC_POOL;
const WETH_ADDRESS = (process.env.WETH_ADDRESS || "").toLowerCase();
const USDC_ADDRESS = (process.env.USDC_ADDRESS || "").toLowerCase();
const ETH_PRICE_CACHE_MS = 45_000;

if (!ARBITRUM_RPC_URL) {
  throw new Error("Missing ARBITRUM_RPC_URL in environment");
}

if (!UNISWAP_WETH_USDC_POOL) {
  throw new Error("Missing UNISWAP_WETH_USDC_POOL in environment");
}

if (!WETH_ADDRESS) {
  throw new Error("Missing WETH_ADDRESS in environment");
}

if (!USDC_ADDRESS) {
  throw new Error("Missing USDC_ADDRESS in environment");
}

const provider = new JsonRpcProvider(ARBITRUM_RPC_URL);

const UNISWAP_V3_POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
];

const pool = new Contract(
  UNISWAP_WETH_USDC_POOL,
  UNISWAP_V3_POOL_ABI,
  provider
);

const Q192 = 2n ** 192n;
const WETH_DECIMALS = 18n;
const USDC_DECIMALS = 6n;
const PRICE_SCALE = 10n ** 8n; // return price with 8 digits precision internally

let ethPriceCache = {
  value: null,
  updatedAt: 0,
};

function sqrtPriceX96ToPriceScaled({
  sqrtPriceX96,
  wethIsToken0,
}) {
  const sqrt = BigInt(sqrtPriceX96);
  const ratioX192 = sqrt * sqrt;

  // priceToken1PerToken0 scaled by 1e8, adjusted for decimals
  const token1PerToken0Scaled =
    (ratioX192 * PRICE_SCALE * (10n ** WETH_DECIMALS)) /
    (Q192 * (10n ** USDC_DECIMALS));

  if (wethIsToken0) {
    // token1/token0 = USDC per WETH
    return token1PerToken0Scaled;
  }

  // token1/token0 = WETH per USDC
  // invert to get USDC per WETH
  return (PRICE_SCALE * PRICE_SCALE) / token1PerToken0Scaled;
}

export function getCachedEthereumPrice() {
  const now = Date.now();

  if (
    ethPriceCache.value !== null &&
    now - ethPriceCache.updatedAt < ETH_PRICE_CACHE_MS
  ) {
    return {
      price: ethPriceCache.value,
      updatedAt: ethPriceCache.updatedAt,
      isFresh: true,
    };
  }

  return {
    price: ethPriceCache.value,
    updatedAt: ethPriceCache.updatedAt,
    isFresh: false,
  };
}

export function clearEthereumPriceCache() {
  ethPriceCache = {
    value: null,
    updatedAt: 0,
  };
}

export async function fetchEthereumPriceUsd() {
  return withRpcLimit(async () => {
    const [token0, token1, slot0] = await Promise.all([
      withRpcLimit(() => pool.token0()),
      withRpcLimit(() => pool.token1()),
      withRpcLimit(() => pool.slot0()),
    ]);

    const t0 = token0.toLowerCase();
    const t1 = token1.toLowerCase();

    const poolMatchesPair =
      (t0 === WETH_ADDRESS && t1 === USDC_ADDRESS) ||
      (t0 === USDC_ADDRESS && t1 === WETH_ADDRESS);

    if (!poolMatchesPair) {
      throw new Error("Configured UNISWAP_WETH_USDC_POOL does not match WETH/USDC");
    }

    const wethIsToken0 = t0 === WETH_ADDRESS;
    const scaledPrice = sqrtPriceX96ToPriceScaled({
      sqrtPriceX96: slot0.sqrtPriceX96,
      wethIsToken0,
    });

    const price = Number(scaledPrice) / Number(PRICE_SCALE);

    if (!Number.isFinite(price) || price <= 0) {
      throw new Error("Invalid Uniswap ETH/USD price");
    }

    ethPriceCache = {
      value: price,
      updatedAt: Date.now(),
    };

    return price;
  });
}

export async function getEthereumPriceUsd() {
  const cached = getCachedEthereumPrice();

  if (cached.isFresh && cached.price !== null) {
    return cached.price;
  }

  return fetchEthereumPriceUsd();
}
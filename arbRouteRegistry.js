import "dotenv/config";
import { Contract, JsonRpcProvider, ZeroAddress } from "ethers";
import { generateRoutes } from "./arbRouteGenerator.js";
import { resolveUniswapV3Pool, resolveV2Pair } from "./resolver.js";
import { V2_PAIR_ABI } from "./abis.js";

const ARBITRUM_RPC_URL = process.env.ARBITRUM_RPC_URL;

if (!ARBITRUM_RPC_URL) {
  throw new Error("Missing ARBITRUM_RPC_URL in environment");
}

const provider = new JsonRpcProvider(ARBITRUM_RPC_URL, 42161);

const FACTORIES = {
  camelot: process.env.CAMELOT_FACTORY,
  sushi: process.env.SUSHI_FACTORY,
};

const ROUTERS = {
  uniswap: process.env.UNISWAP_V3_ROUTER,
  camelot: process.env.CAMELOT_ROUTER,
  sushi: process.env.SUSHI_ROUTER,
};

async function validateV2Pair(pairAddress, tokenA, tokenB) {
  if (!pairAddress || !tokenA || !tokenB) {
    return false;
  }

  try {
    const pair = new Contract(pairAddress, V2_PAIR_ABI, provider);

    const [token0, token1] = await Promise.all([
      pair.token0(),
      pair.token1(),
    ]);

    if (
      !token0 ||
      !token1 ||
      token0 === ZeroAddress ||
      token1 === ZeroAddress
    ) {
      return false;
    }

    const t0 = token0.toLowerCase();
    const t1 = token1.toLowerCase();
    const a = tokenA.toLowerCase();
    const b = tokenB.toLowerCase();

    const matchesForward = t0 === a && t1 === b;
    const matchesReverse = t0 === b && t1 === a;

    return matchesForward || matchesReverse;
  } catch {
    return false;
  }
}

async function resolveDexPool(dex, route) {
  const tokenA = route.base.address;
  const tokenB = route.quote.address;

  if (dex === "uniswap") {
    const address = await resolveUniswapV3Pool(
      tokenA,
      tokenB,
      route.uniswapFee
    );

    if (!address) return null;
    if (!ROUTERS.uniswap) {
      throw new Error("Missing router address for uniswap");
    }

    return {
      dex: "uniswap",
      type: "v3",
      address,
      router: ROUTERS.uniswap,
      fee: route.uniswapFee,
    };
  }

  if (dex === "camelot" || dex === "sushi") {
    const factory = FACTORIES[dex];
    const router = ROUTERS[dex];

    if (!factory) {
      throw new Error(`Missing factory address for ${dex}`);
    }

    if (!router) {
      throw new Error(`Missing router address for ${dex}`);
    }

    const address = await resolveV2Pair(factory, tokenA, tokenB);
    if (!address) return null;

    return {
      dex,
      type: "v2",
      address,
      router,
      feeBps: 30,
    };
  }

  return null;
}

function addRouteToPoolMap(poolToRouteIds, poolAddress, routeId) {
  const key = poolAddress.toLowerCase();

  if (!poolToRouteIds.has(key)) {
    poolToRouteIds.set(key, []);
  }

  const routeIds = poolToRouteIds.get(key);

  if (!routeIds.includes(routeId)) {
    routeIds.push(routeId);
  }
}

export async function buildArbRouteRegistry() {
  const logicalRoutes = generateRoutes();

  const activeRoutes = [];
  const routesById = new Map();
  const poolsByAddress = new Map();
  const poolToRouteIds = new Map();

  let skipped = 0;

  for (const route of logicalRoutes) {
    let buyPool;
    let sellPool;

    try {
      buyPool = await resolveDexPool(route.buyDex, route);
      if (!buyPool) {
        skipped++;
        continue;
      }

      sellPool = await resolveDexPool(route.sellDex, route);
      if (!sellPool) {
        skipped++;
        continue;
      }

      if (buyPool.type === "v2") {
        const validBuy = await validateV2Pair(
          buyPool.address,
          route.base.address,
          route.quote.address
        );

        if (!validBuy) {
          skipped++;
          continue;
        }
      }

      if (sellPool.type === "v2") {
        const validSell = await validateV2Pair(
          sellPool.address,
          route.base.address,
          route.quote.address
        );

        if (!validSell) {
          skipped++;
          continue;
        }
      }
    } catch (error) {
      skipped++;
      console.error(`[ROUTE_RESOLVE_FAIL] ${route.id}`, error?.message || error);
      continue;
    }

    const liveRoute = {
      ...route,
      buyPool,
      sellPool,
      buyRouter: buyPool.router,
      sellRouter: sellPool.router,
      dexKey: `${route.buyDex}->${route.sellDex}`,
      poolKey: `${buyPool.address.toLowerCase()}->${sellPool.address.toLowerCase()}`,
    };

    activeRoutes.push(liveRoute);
    routesById.set(liveRoute.id, liveRoute);

    const buyKey = buyPool.address.toLowerCase();
    const sellKey = sellPool.address.toLowerCase();

    if (!poolsByAddress.has(buyKey)) {
      poolsByAddress.set(buyKey, buyPool);
    }

    if (!poolsByAddress.has(sellKey)) {
      poolsByAddress.set(sellKey, sellPool);
    }

    addRouteToPoolMap(poolToRouteIds, buyKey, liveRoute.id);
    addRouteToPoolMap(poolToRouteIds, sellKey, liveRoute.id);
  }

  console.log(
    `[ROUTE_REGISTRY] logical=${logicalRoutes.length} active=${activeRoutes.length} skipped=${skipped} pools=${poolsByAddress.size}`
  );

  return {
    activeRoutes,
    routesById,
    poolsByAddress,
    poolToRouteIds,
  };
}
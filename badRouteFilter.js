import fs from "fs";

const BAD_ROUTES_FILE =
  process.env.BAD_ROUTES_FILE || "./bad-routes.json";

const AUTO_BLOCK_ENABLED =
  String(process.env.AUTO_BLOCK_BAD_ROUTES || "true") === "true";

const AUTO_BLOCK_THRESHOLD = Number(
  process.env.AUTO_BLOCK_THRESHOLD || 3
);

const failureCounts = new Map();

const HARDCODED_BAD_ROUTES = new Set([
  "GRAIL/WETH|uniswap->camelot",
  "GRAIL/WETH|camelot->uniswap",
  "GRAIL/WETH|uniswap->sushi",
  "GRAIL/WETH|sushi->uniswap",

  "GMX/USDC|uniswap->sushi",
  "GMX/USDC|sushi->uniswap",
  "GMX/USDC|uniswap->camelot",
  "GMX/USDC|camelot->uniswap",

  "AAVE/USDC|uniswap->sushi",
  "AAVE/USDC|sushi->uniswap",

  "RDNT/USDC|uniswap->sushi",
  "RDNT/USDC|sushi->uniswap",

  "ARB/USDC|uniswap->sushi",
  "ARB/USDC|sushi->uniswap",
  "ARB/USDC|camelot->sushi",
  "ARB/USDC|sushi->camelot",
  "ARB/USDC|uniswap->camelot",
  "ARB/USDC|camelot->uniswap",

  "WBTC/USDC|uniswap->sushi",
  "WBTC/USDC|sushi->uniswap",
  "WBTC/USDC|camelot->sushi",
  "WBTC/USDC|sushi->camelot",
  "WBTC/USDC|uniswap->camelot",
  "WBTC/USDC|camelot->uniswap",
]);

function readPersistedBadRoutes() {
  try {
    if (!fs.existsSync(BAD_ROUTES_FILE)) {
      return new Set();
    }

    const raw = fs.readFileSync(BAD_ROUTES_FILE, "utf8");
    if (!raw.trim()) {
      return new Set();
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return new Set();
    }

    return new Set(parsed);
  } catch (error) {
    console.error("[BAD_ROUTE_FILTER_READ_FAIL]", error?.message || error);
    return new Set();
  }
}

function writePersistedBadRoutes(routesSet) {
  try {
    fs.writeFileSync(
      BAD_ROUTES_FILE,
      JSON.stringify([...routesSet].sort(), null, 2)
    );
  } catch (error) {
    console.error("[BAD_ROUTE_FILTER_WRITE_FAIL]", error?.message || error);
  }
}

const persistedBadRoutes = readPersistedBadRoutes();

export function getRouteBlockKey(pairKey, pathKey) {
  return `${pairKey}|${pathKey}`;
}

export function isBlockedRoute(pairKey, pathKey) {
  const key = getRouteBlockKey(pairKey, pathKey);
  return HARDCODED_BAD_ROUTES.has(key) || persistedBadRoutes.has(key);
}

export function recordRouteFailure(pairKey, pathKey, errorMessage = "") {
  if (!AUTO_BLOCK_ENABLED) return;

  const key = getRouteBlockKey(pairKey, pathKey);

  if (HARDCODED_BAD_ROUTES.has(key) || persistedBadRoutes.has(key)) {
    return;
  }

  const normalized = String(errorMessage || "").toLowerCase();

  const shouldCount =
    normalized.includes("token0") ||
    normalized.includes("token1") ||
    normalized.includes("could not decode result data") ||
    normalized.includes("bad_data") ||
    normalized.includes("execution reverted") ||
    normalized.includes("spl") ||
    normalized.includes("unexpected error") ||
    normalized.includes("call_exception");

  if (!shouldCount) {
    return;
  }

  const nextCount = (failureCounts.get(key) || 0) + 1;
  failureCounts.set(key, nextCount);

  console.warn(
    `[BAD_ROUTE_FAIL_COUNT] route=${key} count=${nextCount}/${AUTO_BLOCK_THRESHOLD}`
  );

  if (nextCount >= AUTO_BLOCK_THRESHOLD) {
    persistedBadRoutes.add(key);
    writePersistedBadRoutes(persistedBadRoutes);

    console.warn(`[BAD_ROUTE_AUTO_BLOCKED] route=${key}`);
  }
}

export function clearRouteFailure(pairKey, pathKey) {
  const key = getRouteBlockKey(pairKey, pathKey);
  failureCounts.delete(key);
}

export function getBlockedRoutesSnapshot() {
  return {
    hardcoded: [...HARDCODED_BAD_ROUTES].sort(),
    persisted: [...persistedBadRoutes].sort(),
  };
}
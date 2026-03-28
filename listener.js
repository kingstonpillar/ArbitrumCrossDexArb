import "dotenv/config";
import { Contract, WebSocketProvider } from "ethers";
import { V2_PAIR_ABI, UNISWAP_V3_POOL_ABI } from "./abis.js";

const ARBITRUM_WSS_RPC_URL = process.env.ARBITRUM_WSS_RPC_URL;

if (!ARBITRUM_WSS_RPC_URL) {
  throw new Error("Missing ARBITRUM_WSS_RPC_URL in environment");
}

const RECONNECT_DELAY_MS = Number(process.env.WSS_RECONNECT_DELAY_MS || 3000);
const LOG_EVENTS = String(process.env.WSS_LOG_EVENTS || "true") === "true";
const DIRTY_FLUSH_MS = Number(process.env.WSS_DIRTY_FLUSH_MS || 100);
const MIN_POOL_EVENT_GAP_MS = Number(process.env.MIN_POOL_EVENT_GAP_MS || 200);

export function startListener({
  poolToRouteIds,
  poolsByAddress,
  onRoutesDirty,
}) {
  let wssProvider = null;
  let teardown = [];
  let stopped = false;
  let reconnectTimer = null;
  let reconnectCount = 0;

  const dirtyRouteIds = new Set();
  const dirtyMetaByRouteId = new Map();
  const lastSeenByPool = new Map();
  let flushTimer = null;

  function flushDirtyRoutes() {
    if (!dirtyRouteIds.size) {
      flushTimer = null;
      return;
    }

    const routeIds = [...dirtyRouteIds];
    const meta = routeIds.map((routeId) => ({
      routeId,
      ...(dirtyMetaByRouteId.get(routeId) || {}),
    }));

    dirtyRouteIds.clear();
    dirtyMetaByRouteId.clear();
    flushTimer = null;

    if (LOG_EVENTS) {
      console.log(`[DIRTY_FLUSH] routes=${routeIds.length}`);
    }

    onRoutesDirty({
      routeIds,
      meta,
    });
  }

  function scheduleDirty({
    routeIds,
    poolAddress,
    poolMeta,
    eventType,
    blockNumber,
    txHash,
  }) {
    for (const routeId of routeIds) {
      dirtyRouteIds.add(routeId);

      if (!dirtyMetaByRouteId.has(routeId)) {
        dirtyMetaByRouteId.set(routeId, {
          poolAddress,
          poolMeta,
          eventType,
          blockNumber,
          txHash,
        });
      }
    }

    if (flushTimer) return;

    flushTimer = setTimeout(() => {
      try {
        flushDirtyRoutes();
      } catch (error) {
        console.error("[DIRTY_FLUSH_FAIL]", error?.message || error);
        flushTimer = null;
      }
    }, DIRTY_FLUSH_MS);
  }

  function clearSubscriptions() {
    for (const stop of teardown) {
      try {
        stop();
      } catch (error) {
        console.error("[LISTENER_TEARDOWN_FAIL]", error?.message || error);
      }
    }
    teardown = [];
  }

  function destroyProvider() {
    if (!wssProvider) return;

    try {
      wssProvider.destroy();
    } catch (error) {
      console.error("[WSS_DESTROY_FAIL]", error?.message || error);
    }

    wssProvider = null;
  }

  function clearTimersAndBuffers() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }

    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    dirtyRouteIds.clear();
    dirtyMetaByRouteId.clear();
    lastSeenByPool.clear();
  }

  function scheduleReconnect(reason = "unknown") {
    if (stopped) return;
    if (reconnectTimer) return;

    const delayMs = Math.min(RECONNECT_DELAY_MS * Math.max(reconnectCount + 1, 1), 30000);
    reconnectCount += 1;

    console.warn(
      `[WSS_RECONNECT_SCHEDULED] attempt=${reconnectCount} reason=${reason} delayMs=${delayMs}`
    );

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;

      if (stopped) return;

      try {
        clearSubscriptions();
        destroyProvider();
        connectAndSubscribe();
      } catch (error) {
        console.error("[WSS_RECONNECT_FAIL]", error?.message || error);
        scheduleReconnect("reconnect-failed");
      }
    }, delayMs);
  }

  function attachProviderMonitors(provider) {
    provider.on("error", (error) => {
      console.error("[WSS_PROVIDER_ERROR]", error?.message || error);
      scheduleReconnect("provider-error");
    });

    const ws = provider.websocket;

    if (ws && typeof ws.on === "function") {
      ws.on("open", () => {
        console.log("[WSS_OPEN]");
      });

      ws.on("close", (code, reason) => {
        console.warn(
          `[WSS_CLOSE] code=${code} reason=${reason ? reason.toString() : ""}`
        );
        scheduleReconnect("socket-close");
      });

      ws.on("error", (error) => {
        console.error("[WSS_SOCKET_ERROR]", error?.message || error);
        scheduleReconnect("socket-error");
      });
    }
  }

  function connectAndSubscribe() {
    wssProvider = new WebSocketProvider(ARBITRUM_WSS_RPC_URL);
    attachProviderMonitors(wssProvider);

    let subscribedPools = 0;
    let subscribedHandlers = 0;

    for (const [poolAddress, routeIds] of poolToRouteIds.entries()) {
      const poolMeta = poolsByAddress.get(poolAddress);
      if (!poolMeta) continue;

      const abi = poolMeta.type === "v3" ? UNISWAP_V3_POOL_ABI : V2_PAIR_ABI;
      const contract = new Contract(poolAddress, abi, wssProvider);

      const emitDirty = (eventType) => (...args) => {
        const now = Date.now();
        const last = lastSeenByPool.get(poolAddress) || 0;

        if (now - last < MIN_POOL_EVENT_GAP_MS) {
          if (LOG_EVENTS) {
            console.log(
              `[DIRTY_SKIPPED] type=${eventType} dex=${poolMeta.dex} pool=${poolAddress} reason=pool-gap`
            );
          }
          return;
        }

        lastSeenByPool.set(poolAddress, now);

        const event = args[args.length - 1];
        const blockNumber = event.log?.blockNumber;
        const txHash = event.log?.transactionHash;

        if (LOG_EVENTS) {
          console.log(
            `[DIRTY] type=${eventType} dex=${poolMeta.dex} pool=${poolAddress} routes=${routeIds.length} block=${blockNumber ?? "?"} tx=${txHash ?? "?"}`
          );
        }

        scheduleDirty({
          routeIds,
          poolAddress,
          poolMeta,
          eventType,
          blockNumber,
          txHash,
        });
      };

      const onSwap = emitDirty("Swap");
      contract.on("Swap", onSwap);
      subscribedHandlers += 1;

      let onSync = null;

      if (poolMeta.type === "v2") {
        onSync = emitDirty("Sync");
        contract.on("Sync", onSync);
        subscribedHandlers += 1;
      }

      teardown.push(() => {
        try {
          contract.off("Swap", onSwap);
        } catch (error) {
          console.error("[LISTENER_OFF_SWAP_FAIL]", error?.message || error);
        }

        if (onSync) {
          try {
            contract.off("Sync", onSync);
          } catch (error) {
            console.error("[LISTENER_OFF_SYNC_FAIL]", error?.message || error);
          }
        }
      });

      subscribedPools += 1;
    }

    console.log(
      `[LISTENER_READY] pools=${subscribedPools} handlers=${subscribedHandlers} reconnectCount=${reconnectCount}`
    );
  }

  console.log(
    `[LISTENER_START] pools=${poolToRouteIds.size} wss=${ARBITRUM_WSS_RPC_URL}`
  );

  connectAndSubscribe();

  return () => {
    stopped = true;

    clearTimersAndBuffers();
    clearSubscriptions();
    destroyProvider();

    console.log("[LISTENER_STOPPED]");
  };
}
import "dotenv/config";
import { Contract, WebSocketProvider } from "ethers";
import { V2_PAIR_ABI, UNISWAP_V3_POOL_ABI } from "./abis.js";

const ARBITRUM_WSS_RPC_URL = process.env.ARBITRUM_WSS_RPC_URL;

if (!ARBITRUM_WSS_RPC_URL) {
  throw new Error("Missing ARBITRUM_WSS_RPC_URL in environment");
}

const RECONNECT_DELAY_MS = Number(process.env.WSS_RECONNECT_DELAY_MS || 3000);
const LOG_EVENTS = String(process.env.WSS_LOG_EVENTS || "true") === "true";

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

  function scheduleReconnect(reason = "unknown") {
    if (stopped) return;
    if (reconnectTimer) return;

    reconnectCount += 1;

    console.warn(
      `[WSS_RECONNECT_SCHEDULED] attempt=${reconnectCount} reason=${reason} delayMs=${RECONNECT_DELAY_MS}`
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
    }, RECONNECT_DELAY_MS);
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
        const event = args[args.length - 1];

        if (LOG_EVENTS) {
          console.log(
            `[DIRTY] type=${eventType} dex=${poolMeta.dex} pool=${poolAddress} routes=${routeIds.length} block=${event.log?.blockNumber ?? "?"} tx=${event.log?.transactionHash ?? "?"}`
          );
        }

        onRoutesDirty({
          routeIds,
          poolAddress,
          poolMeta,
          eventType,
          blockNumber: event.log?.blockNumber,
          txHash: event.log?.transactionHash,
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

    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    clearSubscriptions();
    destroyProvider();

    console.log("[LISTENER_STOPPED]");
  };
}
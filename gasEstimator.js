import "dotenv/config";
import { JsonRpcProvider } from "ethers";
import { withRpcLimit } from "./rpcLimiter.js";

export const DEFAULT_GAS_LIMITS = {
  simpleArb: 350000n,
  flashLoanArb: 700000n,
};

const ARBITRUM_RPC_URL = process.env.ARBITRUM_RPC_URL;

if (!ARBITRUM_RPC_URL) {
  throw new Error("Missing ARBITRUM_RPC_URL in environment");
}

const provider = new JsonRpcProvider(ARBITRUM_RPC_URL);

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

export async function getGasPriceWei() {
  return withRpcLimit(async () => {
    const feeData = await provider.getFeeData();

    if (feeData.gasPrice != null) {
      return toBigIntSafe(feeData.gasPrice);
    }

    if (feeData.maxFeePerGas != null) {
      return toBigIntSafe(feeData.maxFeePerGas);
    }

    return 0n;
  });
}

export async function estimateGasCostWei({
  gasLimit = DEFAULT_GAS_LIMITS.simpleArb,
  gasPriceWei,
}) {
  const resolvedGasPrice =
    gasPriceWei != null
      ? toBigIntSafe(gasPriceWei)
      : await getGasPriceWei();

  const resolvedGasLimit = toBigIntSafe(gasLimit);

  return {
    gasLimit: resolvedGasLimit,
    gasPriceWei: resolvedGasPrice,
    gasCostWei: resolvedGasLimit * resolvedGasPrice,
  };
}

export async function estimateGasCostInBaseToken({
  gasLimit = DEFAULT_GAS_LIMITS.simpleArb,
  gasPriceWei,
}) {
  return estimateGasCostWei({
    gasLimit,
    gasPriceWei,
  });
}
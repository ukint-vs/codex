import * as dotenv from "dotenv";
import { Address } from "viem";

dotenv.config({ quite: true });

const getEnv = (name: string): string => {
  const env = process.env[name];
  if (!env) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return env;
};

export const config = {
  contracts: {
    orderbook: getEnv("ORDERBOOK_ADDRESS") as Address,
    baseTokenVault: getEnv("BASE_TOKEN_VAULT_ADDRESS") as Address,
    quoteTokenVault: getEnv("QUOTE_TOKEN_VAULT_ADDRESS") as Address,
    router: getEnv("ROUTER_ADDRESS") as Address,
  },
  transports: {
    ethereumWs: getEnv("ETHEREUM_WS_RPC"),
    varaEthWsRpc: getEnv("VARA_ETH_WS_RPC"),
  },
  accounts: {
    privateKey: getEnv("PRIVATE_KEY"),
    mnemonicForAccountDerivation: getEnv("MNEMONIC_FOR_ACCOUNTS"),
  },
};

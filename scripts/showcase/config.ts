import * as dotenv from "dotenv";
import { Address } from "viem";

dotenv.config({ quiet: true });

const getEnv = (name: string): string => {
  const env = process.env[name];
  if (!env) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return env;
};

const getOptionalEnv = (name: string): string | undefined => {
  const env = process.env[name];
  return env && env.trim().length > 0 ? env.trim() : undefined;
};

const getEnvAny = (names: string[], fallback?: string): string => {
  for (const name of names) {
    const value = getOptionalEnv(name);
    if (value) return value;
  }
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing environment variable: one of [${names.join(", ")}]`);
};

const parseCsv = (value?: string): string[] => {
  if (!value) return [];
  return value
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
};

const parseCsvNumbers = (value?: string): Array<number | undefined> =>
  parseCsv(value).map((x) => {
    const parsed = Number(x);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  });

const isLocalWsUrl = (value: string): boolean =>
  /^(ws|wss):\/\/(127\.0\.0\.1|localhost)(:\d+)?/i.test(value.trim());

const toWsUrl = (value: string): string => {
  if (value.startsWith("ws://") || value.startsWith("wss://")) return value;
  if (value.startsWith("http://")) return `ws://${value.slice("http://".length)}`;
  if (value.startsWith("https://")) return `wss://${value.slice("https://".length)}`;
  return value;
};

const legacyOrderbook = getEnv("ORDERBOOK_ADDRESS") as Address;
const legacyBaseVault = getEnv("BASE_TOKEN_VAULT_ADDRESS") as Address;
const legacyQuoteVault = getEnv("QUOTE_TOKEN_VAULT_ADDRESS") as Address;

const marketOrderbooks = parseCsv(getOptionalEnv("ORDERBOOK_MARKET_ADDRESSES"));
const marketBaseVaults = parseCsv(getOptionalEnv("BASE_TOKEN_VAULT_ADDRESSES"));
const marketBaseTokenIds = parseCsv(getOptionalEnv("MARKET_BASE_TOKEN_IDS"));
const marketQuoteVaults = parseCsv(getOptionalEnv("QUOTE_TOKEN_VAULT_ADDRESSES"));
const marketQuoteTokenIds = parseCsv(getOptionalEnv("MARKET_QUOTE_TOKEN_IDS"));
const marketBaseSymbols = parseCsv(getOptionalEnv("MARKET_BASE_SYMBOLS"));
const marketQuoteSymbols = parseCsv(getOptionalEnv("MARKET_QUOTE_SYMBOLS"));
const marketMidPrices = parseCsvNumbers(getOptionalEnv("MARKET_MID_PRICES"));

const marketCount = Math.min(
  marketOrderbooks.length,
  marketBaseVaults.length,
  marketBaseTokenIds.length,
);

const markets =
  marketCount > 0
    ? Array.from({ length: marketCount }).map((_, i) => ({
        orderbook: marketOrderbooks[i] as Address,
        baseTokenVault: marketBaseVaults[i] as Address,
        quoteTokenVault: (marketQuoteVaults[i] ?? legacyQuoteVault) as Address,
        baseTokenId: marketBaseTokenIds[i],
        quoteTokenId:
          marketQuoteTokenIds[i] ?? "0000000000000000000000000000000000000001",
        baseSymbol: marketBaseSymbols[i] ?? `BASE${i}`,
        quoteSymbol: marketQuoteSymbols[i] ?? "USDC",
        midPriceQuotePerBase: marketMidPrices[i],
      }))
    : [
        {
          orderbook: legacyOrderbook,
          baseTokenVault: legacyBaseVault,
          quoteTokenVault: legacyQuoteVault,
          baseTokenId: "0000000000000000000000000000000000000000",
          quoteTokenId: "0000000000000000000000000000000000000001",
          baseSymbol: "BASE",
          quoteSymbol: "QUOTE",
          midPriceQuotePerBase: 1,
        },
      ];

export const config = {
  contracts: {
    orderbook: legacyOrderbook,
    baseTokenVault: legacyBaseVault,
    quoteTokenVault: legacyQuoteVault,
    router: getEnv("ROUTER_ADDRESS") as Address,
    validators: parseCsv(
      getEnvAny(["VALIDATOR_ADDRESSES", "VALIDATOR_ADDRESS"], ""),
    ) as Address[],
    markets,
  },
  transports: {
    // Prefer explicit local ws var; only use legacy ETH_RPC_WS if it points to localhost.
    ethereumWs: toWsUrl(
      getOptionalEnv("ETHEREUM_WS_RPC")
        ?? (isLocalWsUrl(getOptionalEnv("ETH_RPC_WS") ?? "")
          ? (getOptionalEnv("ETH_RPC_WS") as string)
          : "ws://127.0.0.1:8545"),
    ),
    // Prefer explicit local ws var; only use legacy RPC_URL when it targets localhost.
    varaEthWsRpc: toWsUrl(
      getOptionalEnv("VARA_ETH_WS_RPC")
        ?? (getOptionalEnv("RPC_URL")?.includes("127.0.0.1")
          ? (getOptionalEnv("RPC_URL") as string)
          : "ws://127.0.0.1:9944"),
    ),
  },
  accounts: {
    privateKey: getEnv("PRIVATE_KEY"),
    mnemonicForAccountDerivation: getEnvAny(
      ["MNEMONIC_FOR_ACCOUNTS", "MNEMONIC"],
      "test test test test test test test test test test test junk",
    ),
  },
};

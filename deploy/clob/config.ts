import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
import { privateKeyToAccount } from 'viem/accounts';

// Load .env from current working dir, then fallback to repo root (../../.env)
config();
if (!process.env.PRIVATE_KEY) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  config({ path: path.resolve(__dirname, '../../.env') });
}

export function requireEnv<T>(val: T, name: string): T {
  if (!val) {
    console.error(`Missing ${name} in env (.env)`);
    process.exit(1);
  }
  return val;
}

export const PRIVATE_KEY = requireEnv(
  process.env.PRIVATE_KEY as `0x${string}`,
  'PRIVATE_KEY',
);

export const ROUTER_ADDRESS = requireEnv(
  (process.env.ROUTER_ADDRESS ||
    '0x579D6098197517140e5aec47c78d6f7181916dd6') as `0x${string}`,
  'ROUTER_ADDRESS',
);

// HTTP endpoint for viem clients (L1 deploy uses HTTP)
export const ETH_RPC_HTTP =
  process.env.ETH_RPC_HTTP ||
  (process.env.ETH_RPC && process.env.ETH_RPC.startsWith('http')
    ? process.env.ETH_RPC
    : 'https://hoodi-reth-rpc.gear-tech.io');

// Websocket endpoint for ethexe subscriptions
export const ETH_RPC_WS =
  process.env.ETH_RPC_WS ||
  (process.env.ETH_RPC && process.env.ETH_RPC.startsWith('ws')
    ? process.env.ETH_RPC
    : 'wss://hoodi-reth-rpc.gear-tech.io/ws');

// Backward compat alias: prefer HTTP version
export const ETH_RPC = requireEnv(ETH_RPC_HTTP, 'ETH_RPC');
export const RPC_WS =
  process.env.RPC_WS || 'ws://vara-eth-validator-1.gear-tech.io:9944';
export const CHAIN_ID = Number(process.env.CHAIN_ID || 560048); // Hoodi Testnet
export const HOODI_CHAIN_ID = CHAIN_ID;
export const ETH_KEY_STORE = process.env.ETH_KEY_STORE;

// WASM Paths
export const VAULT_WASM_PATH =
  process.env.VAULT_WASM_PATH ||
  '../../target/wasm32-gear/release/vault_app.opt.wasm';
export const ORDERBOOK_WASM_PATH =
  process.env.ORDERBOOK_WASM_PATH ||
  '../../target/wasm32-gear/release/orderbook.opt.wasm';

// IDL Paths
export const VAULT_IDL_PATH =
  process.env.VAULT_IDL_PATH || '../../programs/vault/vault.idl';
export const ORDERBOOK_IDL_PATH =
  process.env.ORDERBOOK_IDL_PATH || '../../programs/orderbook/orderbook.idl';

// Code IDs
export const VAULT_CODE_ID = process.env.VAULT_CODE_ID as `0x${string}` | undefined;
export const ORDERBOOK_CODE_ID = process.env.ORDERBOOK_CODE_ID as `0x${string}` | undefined;

// Program IDs
export const VAULT_PROGRAM_ID = process.env.VAULT_PROGRAM_ID as `0x${string}` | undefined;
export const ORDERBOOK_PROGRAM_ID = process.env.ORDERBOOK_PROGRAM_ID as `0x${string}` | undefined;

export const SALT = process.env.SALT || 'clob_salt';
export const SENDER_ADDRESS =
  (process.env.SENDER_ADDRESS as `0x${string}` | undefined) ||
  (process.env.SENDER as `0x${string}` | undefined) ||
  privateKeyToAccount(PRIVATE_KEY).address;
export const ETHEXE_BIN =
  process.env.ETHEXE_BIN ||
  '/Users/ukintvs/Documents/projects/gear/target/release/ethexe';

export const VAULT_CALLER_ADDRESS = process.env.VAULT_CALLER_ADDRESS as `0x${string}` | undefined;
export const ORDERBOOK_CALLER_ADDRESS = process.env.ORDERBOOK_CALLER_ADDRESS as `0x${string}` | undefined;

export const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;

// Default top-up amount for executable balance (WVARA, 12 decimals). Override with EXEC_TOPUP_WEI.
export const EXEC_TOPUP_WEI =
  (process.env.EXEC_TOPUP_WEI && BigInt(process.env.EXEC_TOPUP_WEI)) ||
  1000000000000n; // 1 WVARA with 12 decimals

// Skip init when a program ID already exists to avoid re-running constructors.
export const SKIP_INIT_IF_EXISTS =
  (process.env.SKIP_INIT_IF_EXISTS ?? 'true').toLowerCase() === 'true';

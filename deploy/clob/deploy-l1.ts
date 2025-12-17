import { createWalletClient, http, createPublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ETH_RPC_HTTP, CHAIN_ID, PRIVATE_KEY, VAULT_PROGRAM_ID, ORDERBOOK_PROGRAM_ID } from './config';
import VaultCallerArtifact from './artifacts/VaultCaller.json';
import OrderbookCallerArtifact from './artifacts/OrderbookCaller.json';

const account = privateKeyToAccount(PRIVATE_KEY);

const walletClient = createWalletClient({
  account,
  chain: {
    id: CHAIN_ID,
    name: 'Hoodi',
    network: 'hoodi',
    nativeCurrency: {
      decimals: 18,
      name: 'Ether',
      symbol: 'ETH',
    },
    rpcUrls: {
      default: { http: [ETH_RPC_HTTP] },
      public: { http: [ETH_RPC_HTTP] },
    },
  },
  transport: http(),
});

const publicClient = createPublicClient({
  chain: {
    id: CHAIN_ID,
    name: 'Hoodi',
    network: 'hoodi',
    nativeCurrency: {
      decimals: 18,
      name: 'Ether',
      symbol: 'ETH',
    },
    rpcUrls: {
      default: { http: [ETH_RPC_HTTP] },
      public: { http: [ETH_RPC_HTTP] },
    },
  },
  transport: http(),
});

export async function deployL1() {
  console.log('--- Deploying L1 Contracts ---');

  if (!VAULT_PROGRAM_ID) {
    throw new Error('Missing VAULT_PROGRAM_ID in .env');
  }
  if (!ORDERBOOK_PROGRAM_ID) {
    throw new Error('Missing ORDERBOOK_PROGRAM_ID in .env');
  }

  console.log(`Deploying VaultCaller for L2 Vault: ${VAULT_PROGRAM_ID}`);
  const vaultHash = await walletClient.deployContract({
    abi: VaultCallerArtifact.abi,
    bytecode: VaultCallerArtifact.bytecode.object as `0x${string}`,
    args: [VAULT_PROGRAM_ID as `0x${string}`], // Mirror address == Program ID
  });
  console.log(`VaultCaller deployment tx: ${vaultHash}`);

  const vaultReceipt = await publicClient.waitForTransactionReceipt({ hash: vaultHash });
  if (vaultReceipt.contractAddress) {
    console.log(`VaultCaller deployed at: ${vaultReceipt.contractAddress}`);
  }

  console.log(`Deploying OrderbookCaller for L2 Orderbook: ${ORDERBOOK_PROGRAM_ID}`);
  const orderbookHash = await walletClient.deployContract({
    abi: OrderbookCallerArtifact.abi,
    bytecode: OrderbookCallerArtifact.bytecode.object as `0x${string}`,
    args: [ORDERBOOK_PROGRAM_ID as `0x${string}`], // Mirror address == Program ID
  });
  console.log(`OrderbookCaller deployment tx: ${orderbookHash}`);

  const orderbookReceipt = await publicClient.waitForTransactionReceipt({ hash: orderbookHash });
  if (orderbookReceipt.contractAddress) {
    console.log(`OrderbookCaller deployed at: ${orderbookReceipt.contractAddress}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    deployL1().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}

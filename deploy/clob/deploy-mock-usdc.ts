import { readFileSync } from 'fs';
import path from 'path';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ETH_RPC_HTTP, PRIVATE_KEY, CHAIN_ID, SENDER_ADDRESS } from './config.ts';

function loadArtifact() {
  const artifactPath = path.resolve('artifacts/MockUSDC.json');
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf-8'));
  return {
    abi: artifact.abi,
    bytecode: artifact.bytecode.object as `0x${string}`,
  };
}

export async function deployMockUsdc(mintTo?: string, mintAmount?: string) {
  const account = privateKeyToAccount(PRIVATE_KEY);
  const publicClient = createPublicClient({ transport: http(ETH_RPC_HTTP) });
  const walletClient = createWalletClient({ account, transport: http(ETH_RPC_HTTP) });
  const { abi, bytecode } = loadArtifact();

  console.log('Deploying MockUSDC...');
  const hash = await walletClient.deployContract({
    abi,
    bytecode,
    args: [],
    chain: { id: CHAIN_ID, name: 'Hoodi', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [ETH_RPC_HTTP] } } },
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) {
    throw new Error('MockUSDC deployment failed');
  }
  const tokenAddress = receipt.contractAddress;
  console.log('MockUSDC deployed at:', tokenAddress);

  if (mintAmount) {
    const to = mintTo || SENDER_ADDRESS;
    if (!to) {
      throw new Error('Missing mint recipient (SENDER_ADDRESS)');
    }
    console.log(`Minting ${mintAmount} to ${to}...`);
    const mintHash = await walletClient.writeContract({
      address: tokenAddress,
      abi,
      functionName: 'mint',
      args: [to, BigInt(mintAmount)],
      chain: { id: CHAIN_ID, name: 'Hoodi', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [ETH_RPC_HTTP] } } },
    });
    await publicClient.waitForTransactionReceipt({ hash: mintHash });
    console.log('✓ Minted');
  }

  return tokenAddress;
}

async function main() {
  const [mintTo, mintAmount] = process.argv.slice(2);
  await deployMockUsdc(mintTo, mintAmount);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}

import { createPublicClient, createWalletClient, http, parseAbi, defineChain, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ETH_RPC_HTTP, PRIVATE_KEY, VAULT_CALLER_ADDRESS, CHAIN_ID } from './config.ts';
import { toEthAddress, parseU128 } from './utils.ts';

const hoodi = defineChain({
  id: CHAIN_ID,
  name: 'Hoodi Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: [ETH_RPC_HTTP] },
  },
});

const VAULT_ABI = parseAbi([
  'function initiateWithdrawal(address token, uint256 amount) external',
]);

export async function withdrawEth(tokenArg?: string, amountArg?: string) {
  if (!tokenArg || !amountArg) {
    throw new Error('Usage: withdraw-eth <token> <amount>');
  }

  const token = toEthAddress(tokenArg, 'token');
  const amount = parseU128(amountArg, 'amount');
  const vaultAddress = getAddress(VAULT_CALLER_ADDRESS);
  const account = privateKeyToAccount(PRIVATE_KEY);

  const publicClient = createPublicClient({
    chain: hoodi,
    transport: http(ETH_RPC_HTTP),
  });
  const walletClient = createWalletClient({
    account,
    chain: hoodi,
    transport: http(ETH_RPC_HTTP),
  });

  console.log(`Withdrawing ${amount} of ${token} via ${vaultAddress}...`);
  const withdrawHash = await walletClient.writeContract({
    address: vaultAddress,
    abi: VAULT_ABI,
    functionName: 'initiateWithdrawal',
    args: [token, amount],
    chain: hoodi,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: withdrawHash });
  console.log('✓ Withdrawal initiated. Tx:', receipt.transactionHash);
}

async function main() {
  const [tokenArg, amountArg] = process.argv.slice(2);
  await withdrawEth(tokenArg, amountArg);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}

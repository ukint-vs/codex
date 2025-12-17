import { createPublicClient, createWalletClient, http, parseAbi, defineChain, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  ETH_RPC_HTTP,
  PRIVATE_KEY,
  VAULT_CALLER_ADDRESS,
  CHAIN_ID,
  VAULT_PROGRAM_ID,
} from './config.ts';
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
  'function deposit(address token, uint256 amount) external',
  'function vaultVaultDeposit(bool callReply, uint8[20] user, uint8[20] token, uint128 amount) external',
]);

const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function balanceOf(address account) external view returns (uint256)',
  'function allowance(address owner, address spender) external view returns (uint256)',
]);

export async function depositEth(tokenArg?: string, amountArg?: string) {
  if (!tokenArg || !amountArg) {
    throw new Error('Usage: deposit-eth <token> <amount>');
  }

  const token = toEthAddress(tokenArg, 'token');
  const amount = parseU128(amountArg, 'amount');
  const vaultAddress = getAddress(VAULT_CALLER_ADDRESS);
  const account = privateKeyToAccount(PRIVATE_KEY);
  const user = account.address;

  const publicClient = createPublicClient({
    chain: hoodi,
    transport: http(ETH_RPC_HTTP),
  });
  const walletClient = createWalletClient({
    account,
    chain: hoodi,
    transport: http(ETH_RPC_HTTP),
  });

  const balance = await publicClient.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [account.address],
  });
  const allowance = await publicClient.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [account.address, vaultAddress],
  });
  console.log(`Token: ${token}`);
  console.log(`Balance: ${balance.toString()}`);
  console.log(`Allowance: ${allowance.toString()}`);

  if (balance < amount) {
    console.warn(`Warning: balance < amount (${balance.toString()} < ${amount.toString()})`);
  }

  if (allowance < amount) {
    console.log(`Approving ${amount} for ${vaultAddress}...`);
    const approveHash = await walletClient.writeContract({
      address: token,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [vaultAddress, amount],
      chain: hoodi,
    });
    await publicClient.waitForTransactionReceipt({ hash: approveHash });
    console.log('✓ Approved');
  } else {
    console.log('Allowance sufficient, skipping approve');
  }

  console.log(`Depositing ${amount} of ${token} to ${vaultAddress}...`);
  try {
    const depositHash = await walletClient.writeContract({
      address: vaultAddress,
      abi: VAULT_ABI,
      functionName: 'deposit',
      args: [token, amount],
      chain: hoodi,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: depositHash });
    console.log('✓ Deposit successful. Tx:', receipt.transactionHash);
  } catch (err: any) {
    console.error('Deposit reverted:', err?.shortMessage || err?.message || err);
    try {
      console.log('Trying direct vaultVaultDeposit (bypasses transferFrom)...');
      const userBytes = Array.from(Buffer.from(user.slice(2).padStart(40, '0'), 'hex')).slice(-20);
      const tokenBytes = Array.from(Buffer.from(token.slice(2).padStart(40, '0'), 'hex')).slice(-20);
      const directHash = await walletClient.writeContract({
        address: vaultAddress,
        abi: VAULT_ABI,
        functionName: 'vaultVaultDeposit',
        args: [false, userBytes as any, tokenBytes as any, amount],
        chain: hoodi,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: directHash });
      console.log('✓ Direct vaultVaultDeposit submitted. Tx:', receipt.transactionHash);
    } catch (simErr: any) {
      console.error('Direct call error:', simErr?.shortMessage || simErr?.message || simErr);
    }
    process.exit(1);
  }
}

async function main() {
  const [tokenArg, amountArg] = process.argv.slice(2);
  await depositEth(tokenArg, amountArg);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}

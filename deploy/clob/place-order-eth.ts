import { createPublicClient, createWalletClient, http, parseAbi, defineChain, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ETH_RPC_HTTP, PRIVATE_KEY, CHAIN_ID } from './config.ts';
import { parseU128, toH160 } from './utils.ts';

const ORDERBOOK_CALLER_ADDRESS = process.env.ORDERBOOK_CALLER_ADDRESS;

const hoodi = defineChain({
  id: CHAIN_ID,
  name: 'Hoodi Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: [ETH_RPC_HTTP] },
  },
});

const ORDERBOOK_ABI = parseAbi([
  'function placeOrder(uint128 price, uint128 quantity, bool isBuy, address baseToken, address quoteToken) external',
]);

function parseIsBuy(value: string | undefined): boolean {
  if (!value) {
    throw new Error('Missing is_buy (use buy/sell or true/false)');
  }
  const normalized = value.toLowerCase();
  if (['buy', 'b', 'true', '1', 'yes'].includes(normalized)) return true;
  if (['sell', 's', 'false', '0', 'no'].includes(normalized)) return false;
  throw new Error(`Invalid is_buy: ${value} (use buy/sell or true/false)`);
}

export async function placeOrderEth(
  priceArg?: string,
  qtyArg?: string,
  isBuyArg?: string,
  baseArg?: string,
  quoteArg?: string,
) {
  if (!ORDERBOOK_CALLER_ADDRESS) {
    throw new Error('ORDERBOOK_CALLER_ADDRESS not set in .env');
  }

  const price = parseU128(priceArg, 'price');
  const quantity = parseU128(qtyArg, 'quantity');
  const isBuy = parseIsBuy(isBuyArg);
  const base = toH160(baseArg, 'base_token');
  const quote = toH160(quoteArg, 'quote_token');
  const orderbookCaller = getAddress(ORDERBOOK_CALLER_ADDRESS);

  const account = privateKeyToAccount(PRIVATE_KEY);
  const publicClient = createPublicClient({ chain: hoodi, transport: http(ETH_RPC_HTTP) });
  const walletClient = createWalletClient({ account, chain: hoodi, transport: http(ETH_RPC_HTTP) });

  console.log(`OrderbookCaller: ${orderbookCaller}`);
  console.log(`Placing ${isBuy ? 'BUY' : 'SELL'} order: price=${price.toString()} quantity=${quantity.toString()}`);
  console.log(`Base: ${base} Quote: ${quote}`);

  const hash = await walletClient.writeContract({
    address: orderbookCaller,
    abi: ORDERBOOK_ABI,
    functionName: 'placeOrder',
    args: [price, quantity, isBuy, base, quote],
    chain: hoodi,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log('✓ Order submitted. Tx:', receipt.transactionHash);
}

async function main() {
  const [priceArg, qtyArg, isBuyArg, baseArg, quoteArg] = process.argv.slice(2);
  await placeOrderEth(priceArg, qtyArg, isBuyArg, baseArg, quoteArg);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}

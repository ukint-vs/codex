import { deployL1 } from './deploy-l1.ts';
import { deployL2 } from './deploy-l2.ts';
import { addMarket } from './add-market.ts';
import { setEthVaultCaller } from './set-vault-caller.ts';
import { depositEth } from './deposit-eth.ts';
import { placeOrderEth } from './place-order-eth.ts';
import { placeOrderGear } from './place-order-gear.ts';
import { deployMockUsdc } from './deploy-mock-usdc.ts';

function envFlag(name: string, defaultValue = true): boolean {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  return ['1', 'true', 'yes', 'y'].includes(raw.toLowerCase());
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name} in env (.env)`);
  }
  return value;
}

function readOrderSpec(prefix: string) {
  const price = process.env[`${prefix}_PRICE`];
  const quantity = process.env[`${prefix}_QTY`];
  const side = process.env[`${prefix}_SIDE`];
  if (!price || !quantity || !side) return null;

  const method = (process.env[`${prefix}_METHOD`] || 'eth').toLowerCase();
  const base =
    process.env[`${prefix}_BASE_TOKEN`] || process.env.FULL_BASE_TOKEN || '';
  const quote =
    process.env[`${prefix}_QUOTE_TOKEN`] || process.env.FULL_QUOTE_TOKEN || '';
  if (!base || !quote) {
    throw new Error(`Missing base/quote token for ${prefix} (set FULL_BASE_TOKEN/FULL_QUOTE_TOKEN or ${prefix}_BASE_TOKEN/${prefix}_QUOTE_TOKEN)`);
  }
  return { price, quantity, side, method, base, quote };
}

function ensureDefaultDepositConfig() {
  if (!process.env.FULL_DEPOSIT_TOKEN) {
    process.env.FULL_DEPOSIT_TOKEN = process.env.WVARA_ADDRESS;
  }
  if (!process.env.FULL_DEPOSIT_AMOUNT) {
    process.env.FULL_DEPOSIT_AMOUNT = '1000000000000'; // 1 WVARA (12 decimals)
  }
}

async function main() {
  console.log('🚀 Starting Full Testnet Deployment (full flow)...');

  console.log('\n--- Phase 1: Gear L2 Deployment ---');
  await deployL2();

  console.log('\n--- Phase 2: Ethereum L1 Deployment ---');
  await deployL1();

  const vaultProgramId = requireEnv('VAULT_PROGRAM_ID');
  const orderbookProgramId = requireEnv('ORDERBOOK_PROGRAM_ID');
  const vaultCaller = requireEnv('VAULT_CALLER_ADDRESS');
  const orderbookCaller = requireEnv('ORDERBOOK_CALLER_ADDRESS');

  if (envFlag('FULL_SET_VAULT_CALLER', true)) {
    console.log('\n--- Phase 3: Set Vault Caller ---');
    await setEthVaultCaller(vaultProgramId, vaultCaller);
  }

  if (envFlag('FULL_DEPLOY_MOCK_USDC', true)) {
    console.log('\n--- Phase 3.5: Deploy Mock USDC ---');
    const mintAmount = process.env.FULL_MOCK_USDC_MINT || '100000000000'; // 100,000 USDC (6 decimals)
    const tokenAddress = await deployMockUsdc(undefined, mintAmount);
    process.env.FULL_MOCK_USDC_ADDRESS = tokenAddress;
    if (!process.env.FULL_BASE_TOKEN || !process.env.FULL_QUOTE_TOKEN) {
      process.env.FULL_BASE_TOKEN = process.env.WVARA_ADDRESS;
      process.env.FULL_QUOTE_TOKEN = tokenAddress;
    }
    if (!process.env.FULL_DEPOSIT_TOKEN2) {
      process.env.FULL_DEPOSIT_TOKEN2 = tokenAddress;
    }
    if (!process.env.FULL_DEPOSIT_AMOUNT2) {
      process.env.FULL_DEPOSIT_AMOUNT2 = '1000000'; // 1 USDC (6 decimals)
    }
  }

  if (envFlag('FULL_ADD_MARKET', true)) {
    console.log('\n--- Phase 4: Add Market (authorize orderbook) ---');
    await addMarket(orderbookProgramId);
  }

  if (envFlag('FULL_DEPOSIT', true)) {
    console.log('\n--- Phase 5: Deposit ERC20 (L1) ---');
    ensureDefaultDepositConfig();
    const token = requireEnv('FULL_DEPOSIT_TOKEN');
    const amount = requireEnv('FULL_DEPOSIT_AMOUNT');
    await depositEth(token, amount);
    if (process.env.FULL_DEPOSIT_TOKEN2 && process.env.FULL_DEPOSIT_AMOUNT2) {
      await depositEth(process.env.FULL_DEPOSIT_TOKEN2, process.env.FULL_DEPOSIT_AMOUNT2);
    }
  } else {
    console.log('\n--- Phase 5: Deposit ERC20 (skipped) ---');
  }

  if (envFlag('FULL_PLACE_ORDERS', true)) {
    console.log('\n--- Phase 6: Place Orders ---');
    const order1 = readOrderSpec('FULL_ORDER1');
    const order2 = readOrderSpec('FULL_ORDER2');

    const autoOrders = envFlag('FULL_AUTO_ORDERS', true);
    const base = process.env.FULL_BASE_TOKEN;
    const quote = process.env.FULL_QUOTE_TOKEN;
    const orders = [];
    if (order1) orders.push(order1);
    if (order2) orders.push(order2);
    if (!orders.length && autoOrders && base && quote) {
      orders.push({ price: '1', quantity: '1', side: 'buy', method: 'eth', base, quote });
      orders.push({ price: '2', quantity: '1', side: 'sell', method: 'gear', base, quote });
    }
    if (!orders.length) {
      console.log('No orders configured. Set FULL_ORDER1_* or FULL_ORDER2_* to place orders.');
    }

    for (const order of orders) {
      if (order.method === 'gear') {
        await placeOrderGear(order.price, order.quantity, order.side, order.base, order.quote);
      } else {
        await placeOrderEth(order.price, order.quantity, order.side, order.base, order.quote);
      }
    }
  } else {
    console.log('\n--- Phase 6: Place Orders (skipped) ---');
  }

  console.log('\n✅ Full Deployment Complete!');
}

main().catch((error) => {
  console.error('\n❌ Full Deployment Failed:', error);
  process.exit(1);
});

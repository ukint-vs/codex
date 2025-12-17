import { readFileSync } from 'fs';
import { createPublicClient, createWalletClient, defineChain, http, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { EthereumClient, WsVaraEthProvider, VaraEthApi, getMirrorClient } from '@vara-eth/api';
import { Sails } from 'sails-js';
import { SailsIdlParser } from 'sails-js-parser';
import {
  PRIVATE_KEY,
  ETH_RPC_HTTP,
  ETH_RPC_WS,
  ROUTER_ADDRESS,
  ORDERBOOK_PROGRAM_ID,
  HOODI_CHAIN_ID,
  ORDERBOOK_IDL_PATH,
  RPC_WS,
} from './config.ts';
import { hexToBytes } from './utils.ts';

const hoodi = defineChain({
  id: HOODI_CHAIN_ID,
  name: 'Hoodi Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: [ETH_RPC_HTTP] },
  },
});

async function main() {
  if (!ORDERBOOK_PROGRAM_ID) {
    throw new Error('ORDERBOOK_PROGRAM_ID not set');
  }

  const [orderArg, baseArg, quoteArg] = process.argv.slice(2);
  const orderId = orderArg ? BigInt(orderArg) : null;
  const base = baseArg ? hexToBytes(baseArg, 'base_token') : null;
  const quote = quoteArg ? hexToBytes(quoteArg, 'quote_token') : null;

  const account = privateKeyToAccount(PRIVATE_KEY);
  const publicClient = createPublicClient({ chain: hoodi, transport: http(ETH_RPC_HTTP) });
  const walletClient = createWalletClient({ account, chain: hoodi, transport: http(ETH_RPC_HTTP) });

  const ethereumClient = new EthereumClient(publicClient, walletClient, getAddress(ROUTER_ADDRESS));
  await ethereumClient.isInitialized;
  const mirror = getMirrorClient(getAddress(ORDERBOOK_PROGRAM_ID), walletClient, publicClient);

  const provider = new WsVaraEthProvider(
    (RPC_WS || 'ws://vara-eth-validator-1.gear-tech.io:9944') as `ws://${string}` | `wss://${string}`
  );
  const api = new VaraEthApi(provider, ethereumClient);
  await provider.connect();

  const stateHash = await mirror.stateHash();
  console.log('State hash:', stateHash);

  const idlContent = readFileSync(ORDERBOOK_IDL_PATH, 'utf-8');
  const parser = await SailsIdlParser.new();
  const sails = new Sails(parser);
  await sails.parseIdl(idlContent);

  // Admin
  const adminPayload = sails.services.OrderBook.queries.Admin.encodePayload();
  const adminReply = await api.call.program.calculateReplyForHandle(
    account.address,
    ORDERBOOK_PROGRAM_ID,
    adminPayload,
  );
  const admin = sails.services.OrderBook.queries.Admin.decodeResult(adminReply.payload);
  console.log('Admin:', admin);

  // Vault
  const vaultPayload = sails.services.OrderBook.queries.Vault.encodePayload();
  const vaultReply = await api.call.program.calculateReplyForHandle(
    account.address,
    ORDERBOOK_PROGRAM_ID,
    vaultPayload,
  );
  const vaultId = sails.services.OrderBook.queries.Vault.decodeResult(vaultReply.payload);
  console.log('Vault:', vaultId);

  // Order counter
  const ocPayload = sails.services.OrderBook.queries.OrderCounter.encodePayload();
  const ocReply = await api.call.program.calculateReplyForHandle(
    account.address,
    ORDERBOOK_PROGRAM_ID,
    ocPayload,
  );
  const oc = sails.services.OrderBook.queries.OrderCounter.decodeResult(ocReply.payload);
  console.log('Order counter:', oc.toString());

  // Best bid/ask
  const bbPayload = sails.services.OrderBook.queries.BestBid.encodePayload();
  const bbReply = await api.call.program.calculateReplyForHandle(
    account.address,
    ORDERBOOK_PROGRAM_ID,
    bbPayload,
  );
  const bb = sails.services.OrderBook.queries.BestBid.decodeResult(bbReply.payload) as [boolean, bigint, bigint];
  console.log('Best bid:', bb[0] ? { price: bb[1].toString(), qty: bb[2].toString() } : 'none');

  const baPayload = sails.services.OrderBook.queries.BestAsk.encodePayload();
  const baReply = await api.call.program.calculateReplyForHandle(
    account.address,
    ORDERBOOK_PROGRAM_ID,
    baPayload,
  );
  const ba = sails.services.OrderBook.queries.BestAsk.decodeResult(baReply.payload) as [boolean, bigint, bigint];
  console.log('Best ask:', ba[0] ? { price: ba[1].toString(), qty: ba[2].toString() } : 'none');

  // Specific order (if provided)
  if (orderId !== null) {
    const goPayload = sails.services.OrderBook.queries.GetOrder.encodePayload(orderId);
    const goReply = await api.call.program.calculateReplyForHandle(
      account.address,
      ORDERBOOK_PROGRAM_ID,
      goPayload,
    );
    const res = sails.services.OrderBook.queries.GetOrder.decodeResult(goReply.payload) as unknown;
    if (!Array.isArray(res)) {
      console.log('Order:', res);
    } else if (!res[0]) {
      console.log(`Order ${orderId} not found`);
    } else if (res.length < 6) {
      console.log('Order (partial):', res);
    } else {
      const tuple = res as [boolean, string, string, boolean, bigint, bigint];
      console.log('Order:', {
        owner: tuple[1],
        user: tuple[2],
        is_buy: tuple[3],
        price: tuple[4].toString(),
        qty: tuple[5].toString(),
      });
    }
  }

  // Matching for a market (requires base/quote)
  if (base && quote) {
    console.log('Market tokens:', { base: Buffer.from(base).toString('hex'), quote: Buffer.from(quote).toString('hex') });
    const msPayload = sails.services.OrderBook.queries.MarketScale.encodePayload(base, quote);
    const msReply = await api.call.program.calculateReplyForHandle(
      account.address,
      ORDERBOOK_PROGRAM_ID,
      msPayload,
    );
    const ms = sails.services.OrderBook.queries.MarketScale.decodeResult(msReply.payload);
    if (typeof ms === 'bigint' || typeof ms === 'number' || typeof ms === 'string') {
      console.log('Market scale:', ms.toString());
    } else {
      console.log('Market scale:', ms);
    }
  }

  await api.provider.disconnect?.();
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});

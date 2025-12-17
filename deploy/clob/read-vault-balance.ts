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
  VAULT_PROGRAM_ID,
  HOODI_CHAIN_ID,
  VAULT_IDL_PATH,
  RPC_WS,
} from './config.ts';
import { hexToBytes, toActorId32, toH160 } from './utils.ts';

const hoodi = defineChain({
  id: HOODI_CHAIN_ID,
  name: 'Hoodi Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: [ETH_RPC_HTTP] },
  },
});

async function main() {
  if (!VAULT_PROGRAM_ID) {
    throw new Error('VAULT_PROGRAM_ID not set');
  }

  const [userArg, tokenArg] = process.argv.slice(2);
  const user = toActorId32(userArg, 'user');
  const token = toH160(tokenArg, 'token');

  const account = privateKeyToAccount(PRIVATE_KEY);
  const publicClient = createPublicClient({ chain: hoodi, transport: http(ETH_RPC_HTTP) });
  const walletClient = createWalletClient({ account, chain: hoodi, transport: http(ETH_RPC_HTTP) });

  const ethereumClient = new EthereumClient(publicClient, walletClient, getAddress(ROUTER_ADDRESS));
  await ethereumClient.isInitialized;
  const mirror = getMirrorClient(getAddress(VAULT_PROGRAM_ID), walletClient, publicClient);

  const provider = new WsVaraEthProvider(
    (RPC_WS || 'ws://vara-eth-validator-1.gear-tech.io:9944') as `ws://${string}` | `wss://${string}`
  );
  const api = new VaraEthApi(provider, ethereumClient);
  await provider.connect();

  const stateHash = await mirror.stateHash();
  console.log('State hash:', stateHash);

  const idlContent = readFileSync(VAULT_IDL_PATH, 'utf-8');
  const parser = await SailsIdlParser.new();
  const sails = new Sails(parser);
  await sails.parseIdl(idlContent);

  const payload = sails.services.Vault.queries.GetBalance.encodePayload(
    hexToBytes(user, 'user'),
    hexToBytes(token, 'token'),
  );
  const reply = await api.call.program.calculateReplyForHandle(
    account.address,
    VAULT_PROGRAM_ID,
    payload,
  );
  const [available, reserved] =
    sails.services.Vault.queries.GetBalance.decodeResult(reply.payload) as [bigint, bigint];
  console.log('Balance:', { available: available.toString(), reserved: reserved.toString() });

  await api.provider.disconnect?.();
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});

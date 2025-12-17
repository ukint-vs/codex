import { readFileSync } from 'fs';
import { createPublicClient, createWalletClient, defineChain, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { EthereumClient, WsVaraEthProvider, VaraEthApi, getMirrorClient } from '@vara-eth/api';
import { Sails } from 'sails-js';
import { SailsIdlParser } from 'sails-js-parser';
import {
  PRIVATE_KEY,
  ETH_RPC,
  RPC_WS,
  ETH_RPC_WS,
  ROUTER_ADDRESS,
  VAULT_PROGRAM_ID,
  HOODI_CHAIN_ID,
  VAULT_IDL_PATH,
  ORDERBOOK_PROGRAM_ID,
} from './config.ts';
import { hexToBytes, toH160, toActorId32, toEthAddress } from './utils.ts';

const hoodi = defineChain({
  id: HOODI_CHAIN_ID,
  name: 'Hoodi Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: [ETH_RPC] },
  },
});

async function main() {
  if (!VAULT_PROGRAM_ID) {
    throw new Error('VAULT_PROGRAM_ID not set');
  }
  const vaultProgramIdActor = toActorId32(VAULT_PROGRAM_ID, 'VAULT_PROGRAM_ID');
  const vaultProgramIdEth = toEthAddress(VAULT_PROGRAM_ID, 'VAULT_PROGRAM_ID');

  const [userArg, tokenArg, programArg] = process.argv.slice(2);
  const user = userArg ? hexToBytes(toActorId32(userArg, 'user'), 'user') : null;
  const token = tokenArg ? hexToBytes(toH160(tokenArg, 'token'), 'token') : null;
  const program = programArg || ORDERBOOK_PROGRAM_ID || null;

  const account = privateKeyToAccount(PRIVATE_KEY);
  const publicClient = createPublicClient({ chain: hoodi, transport: http(ETH_RPC) });
  const walletClient = createWalletClient({ account, chain: hoodi, transport: http(ETH_RPC) });

  const ethereumClient = new EthereumClient(publicClient, walletClient, ROUTER_ADDRESS);
  await ethereumClient.isInitialized;
  const mirror = getMirrorClient(vaultProgramIdEth, walletClient, publicClient);

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

  // Admin
  const adminPayload = sails.services.Vault.queries.Admin.encodePayload();
  const adminReply = await api.call.program.calculateReplyForHandle(
    account.address,
    vaultProgramIdEth,
    adminPayload,
  );
  const admin = sails.services.Vault.queries.Admin.decodeResult(adminReply.payload);
  console.log('Admin:', admin);

  // Eth Vault Caller
  const evcPayload = sails.services.Vault.queries.EthVaultCaller.encodePayload();
  const evcReply = await api.call.program.calculateReplyForHandle(
    account.address,
    vaultProgramIdEth,
    evcPayload,
  );
  const evc = sails.services.Vault.queries.EthVaultCaller.decodeResult(evcReply.payload);
  console.log('EthVaultCaller:', evc);

  // Authorized program (if provided)
  if (program) {
    const programBytes = hexToBytes(toActorId32(program, 'program'), 'program');
    const authPayload = sails.services.Vault.queries.IsAuthorized.encodePayload(programBytes);
    const authReply = await api.call.program.calculateReplyForHandle(
      account.address,
      vaultProgramIdEth,
      authPayload,
    );
    const isAuth = sails.services.Vault.queries.IsAuthorized.decodeResult(authReply.payload);
    console.log('Is authorized:', program, isAuth);
  }

  // Balance (if user+token provided)
  if (user && token) {
    const balPayload = sails.services.Vault.queries.GetBalance.encodePayload(user, token);
    const balReply = await api.call.program.calculateReplyForHandle(
      account.address,
      vaultProgramIdEth,
      balPayload,
    );
    const bal = sails.services.Vault.queries.GetBalance.decodeResult(balReply.payload) as [bigint, bigint];
    console.log('Balance:', { available: bal[0].toString(), reserved: bal[1].toString() });
  }

  // Treasury (if token provided)
  if (token) {
    const trePayload = sails.services.Vault.queries.GetTreasury.encodePayload(token);
    const treReply = await api.call.program.calculateReplyForHandle(
      account.address,
      vaultProgramIdEth,
      trePayload,
    );
    const tre = sails.services.Vault.queries.GetTreasury.decodeResult(treReply.payload);
    console.log('Treasury:', tre);
  }

  await api.provider.disconnect?.();
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});

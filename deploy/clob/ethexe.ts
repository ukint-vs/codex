import { spawnSync } from 'child_process';
import {
  ETH_RPC,
  ROUTER_ADDRESS,
  SENDER_ADDRESS,
  ETHEXE_BIN,
  ETH_KEY_STORE,
  PRIVATE_KEY,
  RPC_WS,
  ETH_RPC_WS,
  ETH_RPC_HTTP,
} from './config.ts';
import {
  VaraEthApi,
  WsVaraEthProvider,
  EthereumClient,
  getMirrorClient,
  getRouterClient,
} from '@vara-eth/api';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

type JsonOutput = Record<string, unknown>;

interface ApiContext {
  api: VaraEthApi;
  ethereumClient: EthereumClient;
}

let apiContext: ApiContext | null = null;

async function getApiContext(): Promise<ApiContext> {
  if (apiContext) return apiContext;

  const publicClient = createPublicClient({
    transport: http(ETH_RPC_HTTP),
  });
  const account = privateKeyToAccount(PRIVATE_KEY);
  const walletClient = createWalletClient({
    account,
    transport: http(ETH_RPC_HTTP),
  });

  const ethereumClient = new EthereumClient(
    publicClient,
    walletClient,
    ROUTER_ADDRESS as `0x${string}`,
  );
  await ethereumClient.isInitialized;

  const api = new VaraEthApi(
    new WsVaraEthProvider(RPC_WS as `ws://${string}`),
    ethereumClient,
  );
  apiContext = { api, ethereumClient };
  return apiContext;
}

export async function runEthexeTx(args: string[]): Promise<JsonOutput> {
  const command = args[0];

  /*
  // Dispatch to API if supported
  try {
    if (command === 'send-message') {
      const { ethereumClient } = await getApiContext();
      const destination = args[1] as `0x${string}`;
      const payload = args[2] as `0x${string}`;
      const value = BigInt(args[3] || '0');

      const mirror = getMirrorClient(
        destination,
        ethereumClient.walletClient as any,
        ethereumClient.publicClient as any,
      );
      const tx = await mirror.sendMessage(payload, value);
      const receipt = await tx.sendAndWaitForReceipt();

      return {
        status: receipt.status,
        transaction_hash: receipt.transactionHash,
        ok: receipt.status === 'success',
      };
    }

    if (command === 'create') {
      const { ethereumClient } = await getApiContext();
      const codeId = args[1] as `0x${string}`;
      // args might contain --salt <salt>
      let salt: `0x${string}` | undefined;
      const saltIdx = args.indexOf('--salt');
      if (saltIdx !== -1) {
        salt = args[saltIdx + 1] as `0x${string}`;
      }

      const router = getRouterClient(
        ROUTER_ADDRESS as `0x${string}`,
        ethereumClient.walletClient as any,
        ethereumClient.publicClient as any,
      );
      const tx = await (salt
        ? router.createProgram(codeId, salt)
        : router.createProgram(codeId));
      const receipt = await tx.sendAndWaitForReceipt();
      const programId = await tx.getProgramId();

      return {
        status: receipt.status,
        transaction_hash: receipt.transactionHash,
        actor_id: programId,
        ok: receipt.status === 'success',
      };
    }

    if (command === 'executable-balance-top-up') {
      const { ethereumClient } = await getApiContext();
      const programId = args[1] as `0x${string}`;
      const amount = BigInt(args[2]);

      const mirror = getMirrorClient(
        programId,
        ethereumClient.walletClient as any,
        ethereumClient.publicClient as any,
      );
      const tx = await mirror.executableBalanceTopUp(amount);
      const receipt = await tx.sendAndWaitForReceipt();

      return {
        status: receipt.status,
        transaction_hash: receipt.transactionHash,
        ok: receipt.status === 'success',
      };
    }
  } catch (error) {
    console.error(`API Error for ${command}:`, (error as Error).message);
    throw error;
  }
  */

  // Fallback to CLI for unsupported commands (e.g., upload)
  const cliArgs = [
    '--cfg',
    'none',
    'tx',
    '--ethereum-rpc',
    ETH_RPC_WS,
    '--ethereum-router',
    ROUTER_ADDRESS,
    '--sender',
    SENDER_ADDRESS,
  ];

  if (ETH_KEY_STORE) {
    cliArgs.push('--key-store', ETH_KEY_STORE);
  }

  const proc = spawnSync(ETHEXE_BIN, cliArgs.concat(args), {
    stdio: ['inherit', 'pipe', 'inherit'],
  });

  if (proc.error) {
    throw proc.error;
  }

  if (proc.status !== 0) {
    const stdout = proc.stdout?.toString() ?? '';
    const stderr = proc.stderr?.toString() ?? '';
    throw new Error(
      `ethexe exited with code ${proc.status}\nstdout: ${stdout}\nstderr: ${stderr}`,
    );
  }

  const stdout = proc.stdout?.toString().trim();
  if (!stdout) {
    return {};
  }

  try {
    return JSON.parse(stdout) as JsonOutput;
  } catch (error) {
    const message = (error as Error).message;
    throw new Error(
      `Failed to parse ethexe output: ${message}\nRaw output: ${stdout}`,
    );
  }
}

import { runEthexeTx } from './ethexe.ts';
import { VAULT_PROGRAM_ID, RPC_WS } from './config.ts';

async function main() {
  if (!VAULT_PROGRAM_ID) {
    throw new Error('VAULT_PROGRAM_ID is required');
  }
  const ws = RPC_WS || 'ws://vara-eth-validator-1.gear-tech.io:9944';

  const result = await runEthexeTx([
    'query',
    '--rpc-url',
    ws,
    VAULT_PROGRAM_ID,
    '-j',
  ]);

  console.log('Mirror state (Vault):');
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});

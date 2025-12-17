import { runEthexeTx } from './ethexe.ts';
import { toActorId32 } from './utils.ts';
import { VAULT_PROGRAM_ID } from './config.ts';

async function main() {
  const program = toActorId32(VAULT_PROGRAM_ID, 'VAULT_PROGRAM_ID');
  const result = await runEthexeTx([
    'query',
    '--rpc-url',
    process.env.ETH_RPC_WS || '',
    program,
    '-j',
  ]);

  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});

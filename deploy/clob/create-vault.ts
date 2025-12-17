import { keccak256, stringToHex } from 'viem';
import { runEthexeTx } from './ethexe.ts';
import { VAULT_CODE_ID, SALT } from './config.ts';

function normalizeCodeId(codeId: string): `0x${string}` {
  const hex = codeId.startsWith('0x') ? codeId : `0x${codeId}`;
  if (hex.length !== 66) {
    throw new Error('VAULT_CODE_ID must be 32-byte hex (0x + 64 chars)');
  }
  return hex as `0x${string}`;
}

function toSaltH256(input: string): `0x${string}` {
  const hex = input.startsWith('0x')
    ? input
    : keccak256(stringToHex(input));

  if (hex.length !== 66) {
    throw new Error('SALT must resolve to 32-byte hex (0x + 64 chars)');
  }

  return hex as `0x${string}`;
}

async function main() {
  if (!VAULT_CODE_ID) {
    console.error('Error: VAULT_CODE_ID not set in .env');
    process.exit(1);
  }

  const codeId = normalizeCodeId(VAULT_CODE_ID);
  const saltHex = toSaltH256(SALT);

  console.log('\nCreating Vault via ethexe CLI...');
  console.log('Code ID:', codeId);
  console.log('Salt (H256):', saltHex);

  const result = await runEthexeTx([
    'create',
    codeId,
    '--salt',
    saltHex,
    '-j',
  ]);

  const programId = result.actor_id as string | undefined;
  if (!programId) {
    throw new Error('ethexe did not return actor_id');
  }

  console.log('\n=== Vault Created ===');
  console.log('Program ID:', programId);
  console.log('\n✓ Done! Add to .env: VAULT_PROGRAM_ID=' + programId);
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});

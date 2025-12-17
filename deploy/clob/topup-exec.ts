import { runEthexeTx } from './ethexe.ts';
import { toEthAddress, parseU128 } from './utils.ts';
import { ORDERBOOK_PROGRAM_ID, VAULT_PROGRAM_ID } from './config.ts';

function parseArgs(): { mirrorId: `0x${string}`; value: bigint } {
  const [first, second] = process.argv.slice(2);

  if (first && second) {
    return { mirrorId: toEthAddress(first, 'mirror'), value: parseU128(second, 'value') };
  }

  if (first) {
    // Treat single arg as value; mirror from env
    const mirror =
      ORDERBOOK_PROGRAM_ID ??
      VAULT_PROGRAM_ID;
    return { mirrorId: toEthAddress(mirror, 'mirror'), value: parseU128(first, 'value') };
  }

  throw new Error('Usage: topup-exec <mirror?> <value>  (value in WVARA wei; if mirror omitted, uses ORDERBOOK_PROGRAM_ID or VAULT_PROGRAM_ID)');
}

async function main() {
  const { mirrorId, value } = parseArgs();

  // value is in WVARA (18 decimals)
  const result = await runEthexeTx([
    'executable-balance-top-up',
    mirrorId,
    value.toString(),
    '-j',
  ]);

  console.log('Result:', result);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});

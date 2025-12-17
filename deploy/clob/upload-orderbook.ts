import { readFileSync } from 'fs';
import path from 'path';
import { runEthexeTx } from './ethexe.ts';
import { ORDERBOOK_WASM_PATH } from './config.ts';

async function main() {
  const wasmPath = path.resolve(ORDERBOOK_WASM_PATH);
  const wasmCode = readFileSync(wasmPath);

  console.log('\nUploading Orderbook WASM via ethexe CLI...');
  console.log('Path:', wasmPath);
  console.log('WASM size:', wasmCode.length, 'bytes');
  console.log('(This waits for validation)');

  const result = await runEthexeTx(['upload', '-w', '-j', wasmPath]);

  const codeId = result.code_id as string | undefined;
  if (!codeId) {
    throw new Error('ethexe did not return code_id');
  }

  console.log('\n✓ Orderbook Code validated');
  console.log('Code ID:', codeId);
  console.log('\nAdd to .env: ORDERBOOK_CODE_ID=' + codeId);
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});

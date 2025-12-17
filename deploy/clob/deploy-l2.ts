import { readFileSync } from 'fs';
import path from 'path';
import { keccak256, stringToHex } from 'viem';
import { Sails } from 'sails-js';
import { SailsIdlParser } from 'sails-js-parser';
import { runEthexeTx } from './ethexe';
import { loadDeployment, saveDeployment } from './deployments';
import { 
    VAULT_WASM_PATH, 
    VAULT_IDL_PATH, 
    ORDERBOOK_WASM_PATH, 
    ORDERBOOK_IDL_PATH,
    SALT,
    VAULT_CODE_ID,
    ORDERBOOK_CODE_ID,
    VAULT_PROGRAM_ID,
    ORDERBOOK_PROGRAM_ID,
    EXEC_TOPUP_WEI,
    SKIP_INIT_IF_EXISTS,
} from './config';
import { payloadToHex, toActorId32 } from './utils';

function toSaltH256(input: string): `0x${string}` {
  const hex = input.startsWith('0x')
    ? input
    : keccak256(stringToHex(input));
  return hex as `0x${string}`;
}

function normalizeId(id?: `0x${string}` | string | null): `0x${string}` | undefined {
  if (!id) return undefined;
  const val = id as string;
  if (val.toLowerCase() === '0x') return undefined;
  return val as `0x${string}`;
}

function assertInitOk(result: any, name: string) {
  const code = result?.reply_info?.code ?? result?.code;
  if (code && `${code}`.toLowerCase().includes('error')) {
    throw new Error(`${name} init failed: ${code}`);
  }
}

async function deployProgram(
  name: string,
  wasmPath: string,
  idlPath: string,
  salt: string,
  existingCodeId?: `0x${string}`,
  existingProgramId?: `0x${string}`,
  execTopupWei?: bigint,
  initArgs: (`0x${string}` | Uint8Array)[] = [],
) {
    console.log(`\n--- Deploying ${name} ---`);

    // 1. Upload (skip if code id already provided)
    let codeId = existingCodeId as string | undefined;
    if (codeId) {
      console.log(`${name} Code ID provided, skipping upload: ${codeId}`);
    } else {
      console.log(`Uploading ${name} WASM...`);
      const uploadResult = await runEthexeTx(['upload', '-w', '-j', path.resolve(wasmPath)]);
      codeId = uploadResult.code_id as string;
      if (!codeId) throw new Error(`Failed to upload ${name} WASM`);
      console.log(`${name} Code ID: ${codeId}`);
    }

    // 2. Create
    let programId = existingProgramId;
    if (programId) {
      console.log(`${name} Program ID provided, skipping create: ${programId}`);
    } else {
      console.log(`Creating ${name} program...`);
      const saltHex = toSaltH256(salt);
      const createResult = await runEthexeTx(['create', codeId, '--salt', saltHex, '-j']);
      programId = createResult.actor_id as `0x${string}`;
      if (!programId) throw new Error(`Failed to create ${name} program`);
      console.log(`${name} Program ID: ${programId}`);
    }

    // 2.5 Top up executable balance if requested
    if (execTopupWei && execTopupWei > 0n) {
      console.log(`Topping up ${name} executable balance by ${execTopupWei.toString()} wei...`);
      await runEthexeTx([
        'executable-balance-top-up',
        programId,
        execTopupWei.toString(),
        '--approve',
        '-j',
      ]);
      console.log(`✓ ${name} executable balance topped up`);
    }

    // 3. Initialize
    if (existingProgramId && SKIP_INIT_IF_EXISTS) {
      console.log(`Skipping ${name} init (existing program ID and SKIP_INIT_IF_EXISTS=true)`);
      return programId;
    }

    console.log(`Initializing ${name}...`);
    const idlContent = readFileSync(idlPath, 'utf-8');
    const parser = await SailsIdlParser.new();
    const sails = new Sails(parser);
    await sails.parseIdl(idlContent);

    // Encode 'Create' constructor payload (assuming empty for both)
    const initPayload = sails.ctors.Create.encodePayload(...initArgs);
    const payloadHex = payloadToHex(initPayload);
    
    const initResult = await runEthexeTx(['send-message', '-w', '-j', programId, payloadHex, '0']);
    assertInitOk(initResult, name);
    console.log(`✓ ${name} Initialized`);

    return programId;
}

export async function deployL2() {
    console.log('=== L2 Deployment Script ===');
    
    let deployment = loadDeployment();
    if (!deployment) {
        deployment = {
            network: 'hoodi-vara',
            timestamp: new Date().toISOString(),
            l1: { router: '0x', mirror: '0x', vault: '0x', orderbook: '0x' },
            l2: { vault: '0x', orderbook: '0x' },
        };
    }

    const vaultId = await deployProgram(
      'Vault',
      VAULT_WASM_PATH,
      VAULT_IDL_PATH,
      SALT + '_vault',
      VAULT_CODE_ID,
      normalizeId(VAULT_PROGRAM_ID || (deployment.l2?.vault as `0x${string}` | undefined)),
      EXEC_TOPUP_WEI,
      [],
    );
    deployment.l2.vault = vaultId;

    const obId = await deployProgram(
      'Orderbook',
      ORDERBOOK_WASM_PATH,
      ORDERBOOK_IDL_PATH,
      SALT + '_ob',
      ORDERBOOK_CODE_ID,
      normalizeId(ORDERBOOK_PROGRAM_ID || (deployment.l2?.orderbook as `0x${string}` | undefined)),
      EXEC_TOPUP_WEI,
      [toActorId32(deployment.l2?.vault || vaultId, 'VAULT_PROGRAM_ID')],
    );
    deployment.l2.orderbook = obId;

    deployment.timestamp = new Date().toISOString();
    saveDeployment(deployment);
    console.log('\n=== L2 Deployment Complete ===');
    console.log('Updated deployments.json');
}

if (import.meta.url === `file://${process.argv[1]}`) {
    deployL2().catch((error) => {
        console.error('Error:', error.message);
        process.exit(1);
    });
}

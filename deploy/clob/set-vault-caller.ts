import { readFileSync } from 'fs';
import { Sails } from 'sails-js';
import { SailsIdlParser } from 'sails-js-parser';
import {
  VAULT_PROGRAM_ID,
  VAULT_IDL_PATH,
} from './config.ts';
import { runEthexeTx } from './ethexe.ts';
import { payloadToHex, shouldWatchReplies, toActorId32, logReplyInfo } from './utils.ts';

// Get VAULT_CALLER_ADDRESS from process.env because it might not be in config.ts
const VAULT_CALLER_ADDRESS = process.env.VAULT_CALLER_ADDRESS;

export async function setEthVaultCaller(vaultProgramId?: string, vaultCallerAddress?: string) {
  const programId = vaultProgramId || VAULT_PROGRAM_ID;
  const callerAddress = vaultCallerAddress || VAULT_CALLER_ADDRESS;
  if (!programId) {
    throw new Error('VAULT_PROGRAM_ID not set in .env');
  }
  if (!callerAddress) {
    throw new Error('VAULT_CALLER_ADDRESS not set in .env');
  }

  console.log('\nUpdating EthVaultCaller in Vault...');
  console.log('Vault:', programId);
  console.log('Caller:', callerAddress);

  const callerActorId = toActorId32(callerAddress, 'VAULT_CALLER_ADDRESS');

  const idlContent = readFileSync(VAULT_IDL_PATH, 'utf-8');
  const parser = await SailsIdlParser.new();
  const sails = new Sails(parser);
  await sails.parseIdl(idlContent);

  const callerBytes = Buffer.from(callerActorId.slice(2), 'hex');
  const payload =
    sails.services.Vault.functions.SetEthVaultCaller.encodePayload(callerBytes);
  const payloadHex = payloadToHex(payload);
  console.log('Payload:', payloadHex);

  const args = ['send-message', '-j', programId, payloadHex, '0'];
  if (shouldWatchReplies()) args.splice(1, 0, '-w');

  const result = await runEthexeTx(args);
  logReplyInfo(result);
  console.log('✓ SetEthVaultCaller submitted');
}

async function main() {
  await setEthVaultCaller();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('Error:', error.message);
    process.exit(1);
  });
}

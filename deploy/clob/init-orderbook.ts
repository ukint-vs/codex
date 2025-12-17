import { readFileSync } from 'fs';
import { Sails } from 'sails-js';
import { SailsIdlParser } from 'sails-js-parser';
import {
  ORDERBOOK_PROGRAM_ID,
  VAULT_PROGRAM_ID,
  ORDERBOOK_IDL_PATH,
} from './config.ts';
import { runEthexeTx } from './ethexe.ts';
import { payloadToHex, shouldWatchReplies, toActorId32, logReplyInfo } from './utils.ts';

async function main() {
  if (!ORDERBOOK_PROGRAM_ID) {
    console.error('Error: ORDERBOOK_PROGRAM_ID not set in .env');
    process.exit(1);
  }
  if (!VAULT_PROGRAM_ID) {
    console.error('Error: VAULT_PROGRAM_ID not set in .env (required for ctor)');
    process.exit(1);
  }

  console.log('\nInitializing Orderbook via ethexe CLI...');

  const vaultActorId = toActorId32(VAULT_PROGRAM_ID, 'VAULT_PROGRAM_ID');
  const orderbookId = toActorId32(ORDERBOOK_PROGRAM_ID, 'ORDERBOOK_PROGRAM_ID');

  const idlContent = readFileSync(ORDERBOOK_IDL_PATH, 'utf-8');
  const parser = await SailsIdlParser.new();
  const sails = new Sails(parser);
  await sails.parseIdl(idlContent);

  const initPayload = sails.ctors.Create.encodePayload(vaultActorId);
  const payloadHex = payloadToHex(initPayload);
  console.log('Init payload:', payloadHex);

  const args = ['send-message', '-j', orderbookId, payloadHex, '0'];
  if (shouldWatchReplies()) args.splice(1, 0, '-w');

  const result = await runEthexeTx(args);
  logReplyInfo(result);
  console.log('✓ InitOrderbook submitted');
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});

import { readFileSync } from 'fs';
import { Sails } from 'sails-js';
import { SailsIdlParser } from 'sails-js-parser';
import {
  VAULT_PROGRAM_ID,
  ORDERBOOK_PROGRAM_ID,
  VAULT_IDL_PATH,
} from './config.ts';
import { runEthexeTx } from './ethexe.ts';
import { payloadToHex, shouldWatchReplies, toActorId32, logReplyInfo } from './utils.ts';

async function main() {
  if (!VAULT_PROGRAM_ID) {
    console.error('Error: VAULT_PROGRAM_ID not set in .env');
    process.exit(1);
  }
  if (!ORDERBOOK_PROGRAM_ID) {
    console.error('Error: ORDERBOOK_PROGRAM_ID not set in .env');
    process.exit(1);
  }

  console.log('\nAuthorizing Orderbook in Vault via ethexe CLI...');
  console.log('Vault:', VAULT_PROGRAM_ID);
  console.log('Orderbook:', ORDERBOOK_PROGRAM_ID);

  const vaultId = toActorId32(VAULT_PROGRAM_ID, 'VAULT_PROGRAM_ID');
  const orderbookActorId = toActorId32(ORDERBOOK_PROGRAM_ID, 'ORDERBOOK_PROGRAM_ID');

  const idlContent = readFileSync(VAULT_IDL_PATH, 'utf-8');
  const parser = await SailsIdlParser.new();
  const sails = new Sails(parser);
  await sails.parseIdl(idlContent);

  const orderbookBytes = Buffer.from(orderbookActorId.slice(2), 'hex');
  const payload =
    sails.services.Vault.functions.AddMarket.encodePayload(orderbookBytes);
  const payloadHex = payloadToHex(payload);
  console.log('Payload:', payloadHex);

  const args = ['send-message', '-j', vaultId, payloadHex, '0'];
  if (shouldWatchReplies()) args.splice(1, 0, '-w');

  const result = await runEthexeTx(args);
  logReplyInfo(result);
  console.log('✓ AuthorizeOrderbook submitted');
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});

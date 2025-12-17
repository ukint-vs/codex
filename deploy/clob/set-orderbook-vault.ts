import { readFileSync } from 'fs';
import { Sails } from 'sails-js';
import { SailsIdlParser } from 'sails-js-parser';
import { runEthexeTx } from './ethexe.ts';
import { ORDERBOOK_IDL_PATH, ORDERBOOK_PROGRAM_ID, VAULT_PROGRAM_ID } from './config.ts';
import { toActorId32, toEthAddress, shouldWatchReplies, payloadToHex, logReplyInfo } from './utils.ts';

async function main() {
  if (!ORDERBOOK_PROGRAM_ID) {
    throw new Error('ORDERBOOK_PROGRAM_ID not set in .env');
  }
  if (!VAULT_PROGRAM_ID) {
    throw new Error('VAULT_PROGRAM_ID not set in .env');
  }

  const orderbookMirror = toEthAddress(ORDERBOOK_PROGRAM_ID, 'ORDERBOOK_PROGRAM_ID');
  const vaultActorId = toActorId32(VAULT_PROGRAM_ID, 'VAULT_PROGRAM_ID');

  const idlContent = readFileSync(ORDERBOOK_IDL_PATH, 'utf-8');
  const parser = await SailsIdlParser.new();
  const sails = new Sails(parser);
  await sails.parseIdl(idlContent);

  const payload = sails.services.OrderBook.functions.SetVault.encodePayload(vaultActorId);
  const payloadHex = payloadToHex(payload);

  const args = ['send-message', '-j', orderbookMirror, payloadHex, '0'];
  if (shouldWatchReplies()) args.splice(1, 0, '-w');

  const result = await runEthexeTx(args);
  logReplyInfo(result);
  console.log('✓ SetVault submitted');
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});

import { Sails } from 'sails-js';
import { SailsIdlParser } from 'sails-js-parser';
import fs from 'fs';
import { runEthexeTx } from './ethexe.ts';
import { VAULT_IDL_PATH, VAULT_PROGRAM_ID, ORDERBOOK_PROGRAM_ID } from './config.ts';
import { toActorId32, toEthAddress, shouldWatchReplies, payloadToHex, hexToBytes, logReplyInfo } from './utils.ts';

export async function addMarket(orderbookArg?: string) {
  const orderbookId = toActorId32(orderbookArg || ORDERBOOK_PROGRAM_ID, 'ORDERBOOK_PROGRAM_ID');
  const vaultMirror = toEthAddress(VAULT_PROGRAM_ID, 'VAULT_PROGRAM_ID');

  const idlContent = fs.readFileSync(VAULT_IDL_PATH, 'utf-8');
  const parser = await SailsIdlParser.new();
  const sails = new Sails(parser);
  await sails.parseIdl(idlContent);

  const orderbookBytes = hexToBytes(orderbookId, 'orderbook');
  const payload =
    sails.services.Vault.functions.AddMarket.encodePayload(orderbookBytes);
  const payloadHex = payloadToHex(payload);

  const args = ['send-message', '-j', vaultMirror, payloadHex, '0'];
  if (shouldWatchReplies()) args.splice(1, 0, '-w');

  const result = await runEthexeTx(args);
  logReplyInfo(result);
  console.log('✓ AddMarket submitted');
}

async function main() {
  const orderbookArg = process.argv[2];
  await addMarket(orderbookArg);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}

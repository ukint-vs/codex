import { Sails } from 'sails-js';
import { SailsIdlParser } from 'sails-js-parser';
import fs from 'fs';
import { runEthexeTx } from './ethexe.ts';
import { ORDERBOOK_IDL_PATH, ORDERBOOK_PROGRAM_ID, ORDERBOOK_CALLER_ADDRESS } from './config.ts';
import { toActorId32, toEthAddress, shouldWatchReplies, payloadToHex, hexToBytes, logReplyInfo } from './utils.ts';

export async function setEthOrderbookCaller(
  orderbookProgramArg?: string,
  callerArg?: string,
) {
  const orderbookProgramId = toEthAddress(orderbookProgramArg || ORDERBOOK_PROGRAM_ID, 'ORDERBOOK_PROGRAM_ID');
  const callerId = toActorId32(callerArg || ORDERBOOK_CALLER_ADDRESS, 'ORDERBOOK_CALLER_ADDRESS');

  const idlContent = fs.readFileSync(ORDERBOOK_IDL_PATH, 'utf-8');
  const parser = await SailsIdlParser.new();
  const sails = new Sails(parser);
  await sails.parseIdl(idlContent);

  const callerBytes = hexToBytes(callerId, 'caller');
  const payload = sails.services.OrderBook.functions.SetEthOrderbookCaller.encodePayload(
    callerBytes,
  );
  const payloadHex = payloadToHex(payload);

  const args = ['send-message', '-j', orderbookProgramId, payloadHex, '0'];
  if (shouldWatchReplies()) args.splice(1, 0, '-w');

  const result = await runEthexeTx(args);
  logReplyInfo(result);
  console.log('✓ SetEthOrderbookCaller submitted');
}

async function main() {
  const [orderbookProgramArg, callerArg] = process.argv.slice(2);
  await setEthOrderbookCaller(orderbookProgramArg, callerArg);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}

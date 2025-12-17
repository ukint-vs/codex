import { Sails } from 'sails-js';
import { SailsIdlParser } from 'sails-js-parser';
import fs from 'fs';
import { runEthexeTx } from './ethexe.ts';
import { ORDERBOOK_IDL_PATH, ORDERBOOK_PROGRAM_ID } from './config.ts';
import { toH160, parseU128, shouldWatchReplies, payloadToHex, hexToBytes, toActorId32, logReplyInfo } from './utils.ts';

async function main() {
  const [orderIdArg, baseArg, quoteArg] = process.argv.slice(2);
  const orderId = parseU128(orderIdArg, 'order_id');
  const base = toH160(baseArg, 'base_token');
  const quote = toH160(quoteArg, 'quote_token');
  const orderbookId = toActorId32(ORDERBOOK_PROGRAM_ID, 'ORDERBOOK_PROGRAM_ID');

  const idlContent = fs.readFileSync(ORDERBOOK_IDL_PATH, 'utf-8');
  const parser = await SailsIdlParser.new();
  const sails = new Sails(parser);
  await sails.parseIdl(idlContent);

  const payload =
    sails.services.OrderBook.functions.CancelOrder.encodePayload(
      orderId,
      hexToBytes(base, 'base_token'),
      hexToBytes(quote, 'quote_token'),
    );
  const payloadHex = payloadToHex(payload);

  const args = ['send-message', '-j', orderbookId, payloadHex, '0'];
  if (shouldWatchReplies()) args.splice(1, 0, '-w');

  const result = await runEthexeTx(args);
  logReplyInfo(result);
  console.log('✓ CancelOrder submitted');
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});

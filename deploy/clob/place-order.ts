import { Sails } from 'sails-js';
import { SailsIdlParser } from 'sails-js-parser';
import fs from 'fs';
import { runEthexeTx } from './ethexe.ts';
import { ORDERBOOK_IDL_PATH, ORDERBOOK_PROGRAM_ID } from './config.ts';
import { toH160, parseU128, shouldWatchReplies, payloadToHex, hexToBytes, toActorId32, logReplyInfo } from './utils.ts';

async function main() {
  const [sideArg, priceArg, qtyArg, baseArg, quoteArg] = process.argv.slice(2);
  const isBuy = (sideArg || '').toLowerCase() === 'buy';
  if (sideArg === undefined) throw new Error('side is required (buy|sell)');
  if (!['buy', 'sell'].includes(sideArg.toLowerCase())) {
    throw new Error('side must be buy or sell');
  }
  const price = parseU128(priceArg, 'price');
  const quantity = parseU128(qtyArg, 'quantity');
  const base = toH160(baseArg, 'base_token');
  const quote = toH160(quoteArg, 'quote_token');
  const orderbookId = toActorId32(ORDERBOOK_PROGRAM_ID, 'ORDERBOOK_PROGRAM_ID');

  const idlContent = fs.readFileSync(ORDERBOOK_IDL_PATH, 'utf-8');
  const parser = await SailsIdlParser.new();
  const sails = new Sails(parser);
  await sails.parseIdl(idlContent);

  const payload =
    sails.services.OrderBook.functions.PlaceOrder.encodePayload(
      price,
      quantity,
      isBuy,
      hexToBytes(base, 'base_token'),
      hexToBytes(quote, 'quote_token'),
    );
  const payloadHex = payloadToHex(payload);

  const args = ['send-message', '-j', orderbookId, payloadHex, '0'];
  if (shouldWatchReplies()) args.splice(1, 0, '-w');

  const result = await runEthexeTx(args);
  logReplyInfo(result);
  console.log('✓ PlaceOrder submitted');
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});

import { Sails } from 'sails-js';
import { SailsIdlParser } from 'sails-js-parser';
import fs from 'fs';
import { runEthexeTx } from './ethexe.ts';
import { ORDERBOOK_IDL_PATH, ORDERBOOK_PROGRAM_ID } from './config.ts';
import { toH160, parseU128, shouldWatchReplies, payloadToHex, hexToBytes, toEthAddress, logReplyInfo } from './utils.ts';

function parseIsBuy(value: string | undefined): boolean {
  if (!value) {
    throw new Error('Missing is_buy (use buy/sell or true/false)');
  }
  const normalized = value.toLowerCase();
  if (['buy', 'b', 'true', '1', 'yes'].includes(normalized)) return true;
  if (['sell', 's', 'false', '0', 'no'].includes(normalized)) return false;
  throw new Error(`Invalid is_buy: ${value} (use buy/sell or true/false)`);
}

export async function placeOrderGear(
  priceArg?: string,
  qtyArg?: string,
  isBuyArg?: string,
  baseArg?: string,
  quoteArg?: string,
) {
  const price = parseU128(priceArg, 'price');
  const quantity = parseU128(qtyArg, 'quantity');
  const isBuy = parseIsBuy(isBuyArg);
  const base = toH160(baseArg, 'base_token');
  const quote = toH160(quoteArg, 'quote_token');
  const orderbookId = toEthAddress(ORDERBOOK_PROGRAM_ID, 'ORDERBOOK_PROGRAM_ID');

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

async function main() {
  const [priceArg, qtyArg, isBuyArg, baseArg, quoteArg] = process.argv.slice(2);
  await placeOrderGear(priceArg, qtyArg, isBuyArg, baseArg, quoteArg);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}

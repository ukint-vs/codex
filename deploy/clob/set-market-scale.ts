import { Sails } from 'sails-js';
import { SailsIdlParser } from 'sails-js-parser';
import fs from 'fs';
import { runEthexeTx } from './ethexe.ts';
import { ORDERBOOK_IDL_PATH, ORDERBOOK_PROGRAM_ID } from './config.ts';
import { toEthAddress, toH160, parseU128, shouldWatchReplies, payloadToHex, hexToBytes, logReplyInfo } from './utils.ts';

export async function setMarketScale(
  orderbookProgramArg?: string,
  baseArg?: string,
  quoteArg?: string,
  scaleArg?: string,
) {
  const orderbookProgramId = toEthAddress(orderbookProgramArg || ORDERBOOK_PROGRAM_ID, 'ORDERBOOK_PROGRAM_ID');
  const base = toH160(baseArg, 'base_token');
  const quote = toH160(quoteArg, 'quote_token');
  const priceScale = parseU128(scaleArg, 'price_scale');

  const idlContent = fs.readFileSync(ORDERBOOK_IDL_PATH, 'utf-8');
  const parser = await SailsIdlParser.new();
  const sails = new Sails(parser);
  await sails.parseIdl(idlContent);

  const payload = sails.services.OrderBook.functions.SetMarketScale.encodePayload(
    hexToBytes(base, 'base_token'),
    hexToBytes(quote, 'quote_token'),
    priceScale,
  );
  const payloadHex = payloadToHex(payload);

  const args = ['send-message', '-j', orderbookProgramId, payloadHex, '0'];
  if (shouldWatchReplies()) args.splice(1, 0, '-w');

  const result = await runEthexeTx(args);
  logReplyInfo(result);
  console.log('✓ SetMarketScale submitted');
}

async function main() {
  const [orderbookProgramArg, baseArg, quoteArg, scaleArg] = process.argv.slice(2);
  await setMarketScale(orderbookProgramArg, baseArg, quoteArg, scaleArg);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}

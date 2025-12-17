import { Sails } from 'sails-js';
import { SailsIdlParser } from 'sails-js-parser';
import fs from 'fs';
import { runEthexeTx } from './ethexe.ts';
import { VAULT_IDL_PATH, VAULT_PROGRAM_ID } from './config.ts';
import { toH160, parseU128, shouldWatchReplies, payloadToHex, hexToBytes, toActorId32, logReplyInfo, toEthAddress } from './utils.ts';

async function main() {
  const [userArg, tokenArg, amountArg] = process.argv.slice(2);

  const user = toActorId32(userArg, 'user');
  const token = toH160(tokenArg, 'token');
  const amount = parseU128(amountArg, 'amount');
  const vaultId = toEthAddress(VAULT_PROGRAM_ID, 'VAULT_PROGRAM_ID');

  const idlContent = fs.readFileSync(VAULT_IDL_PATH, 'utf-8');
  const parser = await SailsIdlParser.new();
  const sails = new Sails(parser);
  await sails.parseIdl(idlContent);

  const payload =
    sails.services.Vault.functions.VaultWithdraw.encodePayload(
      hexToBytes(user, 'user'),
      hexToBytes(token, 'token'),
      amount,
    );
  const payloadHex = payloadToHex(payload);

  const args = ['send-message', '-j', vaultId as string, payloadHex, '0'];
  if (shouldWatchReplies()) args.splice(1, 0, '-w');

  const result = await runEthexeTx(args);
  logReplyInfo(result);
  console.log('✓ Withdraw submitted');
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});

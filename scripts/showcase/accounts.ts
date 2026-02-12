import { Address, HDAccount, mnemonicToAccount } from "viem/accounts";

import { config } from "./config.js";
import { logger } from "./logger.js";

export const accountsBaseTokensFunded = new Map<Address, HDAccount>();
export const accountsQuoteTokensFunded = new Map<Address, HDAccount>();

export async function initAccounts(n: number) {
  const mnemonic = config.accounts.mnemonicForAccountDerivation;

  logger.info(`Initializing ${n} accounts from ${mnemonic}`);

  for (let i = 0; i < n; i += 2) {
    const account1 = mnemonicToAccount(mnemonic, {
      path: `m/44'/60'/0'/0/${i}`,
    });
    accountsBaseTokensFunded.set(account1.address, account1);
    const account2 = mnemonicToAccount(mnemonic, {
      path: `m/44'/60'/0'/0/${i + 1}`,
    });
    accountsQuoteTokensFunded.set(account2.address, account2);
  }
}

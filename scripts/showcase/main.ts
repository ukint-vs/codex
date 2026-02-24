import {
  Account,
  Address,
  createPublicClient,
  createWalletClient,
  webSocket,
} from "viem";
import {
  EthereumClient,
  ISigner,
  VaraEthApi,
  WsVaraEthProvider,
} from "@vara-eth/api";
import { walletClientToSigner } from "@vara-eth/api/signer";

import {
  accountsBaseTokensFunded,
  accountsQuoteTokensFunded,
  initAccounts,
} from "./accounts.js";
import { initCodec, orderbookCodec, vaultCodec } from "./codec.js";
import { Orderbook, Vault } from "./programs/index.js";
import { config } from "./config.js";
import { logger } from "./logger.js";

const TARGET_BALANCE = BigInt(1000 * 1e6);
const BASE_PRICE = 1.0; // base price in quote tokens per base token

// Randomization helpers
const randInt = (min: number, max: number) =>
  Math.floor(Math.random() * (max - min + 1)) + min;
const randFloat = (min: number, max: number) =>
  Math.round((Math.random() * (max - min) + min) * 100) / 100;
const shuffle = <T>(arr: T[]): T[] =>
  arr
    .map((v) => ({ v, sort: Math.random() }))
    .sort((a, b) => a.sort - b.sort)
    .map(({ v }) => v);

async function main() {
  await initCodec();
  await initAccounts(20);

  const ethTransport = webSocket("ws://127.0.0.1:8545");

  const publicClient = createPublicClient({
    transport: ethTransport,
  });

  const ethClient = new EthereumClient(publicClient, config.contracts.router);

  const varaEthApi = new VaraEthApi(
    new WsVaraEthProvider("ws://127.0.0.1:9944"),
    ethClient,
  );

  const orderbook = new Orderbook(
    orderbookCodec,
    varaEthApi,
    publicClient,
    6,
    6,
  );

  const baseVault = new Vault(
    vaultCodec,
    varaEthApi,
    publicClient,
    config.contracts.baseTokenVault,
    6,
  );
  const quoteVault = new Vault(
    vaultCodec,
    varaEthApi,
    publicClient,
    config.contracts.quoteTokenVault,
    6,
  );

  // Helper: create a signer from an account
  const makeSigner = (account: Account): ISigner => {
    const wc = createWalletClient({ account, transport: ethTransport });
    return walletClientToSigner(wc);
  };

  await baseVault.queryAdmin();
  await quoteVault.queryAdmin();

  // ── Step 1: Fund accounts ──────────────────────────────────────────────
  logger.info("Step 1: Funding accounts in vaults");

  const fundAccounts = async (
    accounts: Map<Address, Account>,
    vault: Vault,
  ) => {
    for (const [address, account] of accounts.entries()) {
      const signer = makeSigner(account);
      const [available] = await vault.withSigner(signer).getBalance(address);

      if (available < TARGET_BALANCE) {
        await vault.vaultDeposit(address, TARGET_BALANCE - available);
      }
    }
  };

  await fundAccounts(accountsBaseTokensFunded, baseVault);
  await fundAccounts(accountsQuoteTokensFunded, quoteVault);

  // ── Step 2: Transfer to market ─────────────────────────────────────────
  logger.info("Step 2: Transferring funds from vaults to orderbook market");

  const transferToMarket = async (
    accounts: Map<Address, Account>,
    vault: Vault,
  ) => {
    for (const [address, account] of accounts.entries()) {
      const signer = makeSigner(account);
      const amount = randInt(200, 800); // random 200–800 tokens
      await vault
        .withSigner(signer)
        .transferToMarket(config.contracts.orderbook, amount);
      logger.info("Transferred to market", { address, amount });
    }
  };

  await transferToMarket(accountsBaseTokensFunded, baseVault);
  await transferToMarket(accountsQuoteTokensFunded, quoteVault);

  // ── Step 3: Place orders ───────────────────────────────────────────────
  logger.info("Step 3: Placing orders on the orderbook");

  // Pick a random subset of sellers and buyers to participate
  const allSellers = shuffle([...accountsBaseTokensFunded.entries()]);
  const allBuyers = shuffle([...accountsQuoteTokensFunded.entries()]);

  const activeSellers = allSellers.slice(0, randInt(3, allSellers.length));
  const activeBuyers = allBuyers.slice(0, randInt(3, allBuyers.length));

  logger.info("Active participants", {
    sellers: activeSellers.length,
    buyers: activeBuyers.length,
  });

  const orderPromises: Promise<bigint>[] = [];
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // Sellers place sell limit orders at randomized prices above BASE_PRICE
  for (const [address, account] of activeSellers) {
    const signer = makeSigner(account);
    const price = randFloat(BASE_PRICE + 0.01, BASE_PRICE + 0.15);
    const amount = randInt(10, 100);

    logger.info("Placing sell limit order", { address, price, amount });
    orderPromises.push(
      orderbook.withSigner(signer).placeSellLimitOrder(amount, price),
    );
    await delay(100);
  }

  // Buyers place buy limit orders at randomized prices below BASE_PRICE
  for (const [address, account] of activeBuyers) {
    const signer = makeSigner(account);
    const price = randFloat(BASE_PRICE - 0.15, BASE_PRICE - 0.01);
    const amount = randInt(10, 100);

    logger.info("Placing buy limit order", { address, price, amount });
    orderPromises.push(
      orderbook.withSigner(signer).placeBuyLimitOrder(amount, price),
    );
    await delay(100);
  }

  // Place crossing market orders to trigger matches
  {
    const [address, account] = activeSellers[0];
    const signer = makeSigner(account);
    const amount = randInt(5, 30);
    logger.info("Placing sell market order to trigger matches", {
      address,
      amount,
    });
    orderPromises.push(
      orderbook.withSigner(signer).placeSellMarketOrder(amount),
    );
    await delay(100);
  }

  {
    const [address, account] = activeBuyers[0];
    const signer = makeSigner(account);
    const amount = randInt(5, 30);
    const maxQuote = amount * 2; // generous slippage
    logger.info("Placing buy market order to trigger matches", {
      address,
      amount,
    });
    orderPromises.push(
      orderbook.withSigner(signer).placeBuyMarketOrder(amount, maxQuote),
    );
  }

  // Wait for all orders with a timeout
  const SETTLE_TIMEOUT_MS = 60_000;
  logger.info(
    `Waiting for all orders to settle (timeout: ${SETTLE_TIMEOUT_MS / 1000}s)...`,
  );

  const timeout = (ms: number) =>
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), ms),
    );

  const results = await Promise.allSettled(
    orderPromises.map((p) => Promise.race([p, timeout(SETTLE_TIMEOUT_MS)])),
  );

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const timedOut = results.filter(
    (r) => r.status === "rejected" && r.reason?.message === "timeout",
  );
  const failed = results.filter(
    (r) => r.status === "rejected" && r.reason?.message !== "timeout",
  );

  // ── Summary ────────────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(72));
  console.log("  ORDER SUMMARY");
  console.log("=".repeat(72));
  console.log(`  Total orders:     ${results.length}`);
  console.log(`  Fulfilled:        ${fulfilled.length}`);
  console.log(`  Timed out:        ${timedOut.length}`);
  console.log(`  Failed:           ${failed.length}`);

  if (failed.length > 0) {
    console.log("\n  Failures:");
    for (const r of failed) {
      if (r.status === "rejected") {
        console.log(`    - ${r.reason?.message ?? r.reason}`);
      }
    }
  }

  console.log("\n" + "-".repeat(72));
  console.log("  ORDERBOOK STATE");
  console.log("-".repeat(72));

  const bestAsk = await orderbook.bestAskPrice();
  const bestBid = await orderbook.bestBidPrice();
  console.log(`  Best bid:         ${bestBid?.toString() ?? "none"}`);
  console.log(`  Best ask:         ${bestAsk?.toString() ?? "none"}`);

  console.log("\n" + "-".repeat(72));
  console.log("  SELLER BALANCES (on orderbook)");
  console.log("-".repeat(72));
  for (const [address] of accountsBaseTokensFunded.entries()) {
    const [base, quote] = await orderbook.balanceOf(address);
    console.log(
      `  ${address}  base=${base.toString().padStart(12)}  quote=${quote.toString().padStart(12)}`,
    );
  }

  console.log("\n" + "-".repeat(72));
  console.log("  BUYER BALANCES (on orderbook)");
  console.log("-".repeat(72));
  for (const [address] of accountsQuoteTokensFunded.entries()) {
    const [base, quote] = await orderbook.balanceOf(address);
    console.log(
      `  ${address}  base=${base.toString().padStart(12)}  quote=${quote.toString().padStart(12)}`,
    );
  }

  console.log("=".repeat(72) + "\n");

  return 0;
}

main()
  .catch((error) => {
    console.log(
      "========================================================================",
    );
    console.error(error);
    process.exit(1);
  })
  .then(process.exit);

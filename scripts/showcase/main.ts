import {
  Account,
  Address,
  createPublicClient,
  createWalletClient,
  formatUnits,
  toHex,
  webSocket,
} from "viem";
import {
  ISigner,
  VaraEthApi,
  WsVaraEthProvider,
  getRouterClient,
} from "@vara-eth/api";
import { privateKeyToAccount } from "viem/accounts";

import {
  accountsBaseTokensFunded,
  accountsQuoteTokensFunded,
  initAccounts,
} from "./accounts.js";
import { initCodec, orderbookCodec, vaultCodec } from "./codec.js";
import { Orderbook, Vault } from "./programs/index.js";
import { actorIdToAddress } from "./programs/util.js";
import { config } from "./config.js";
import { logger } from "./logger.js";

const TARGET_BALANCE = BigInt(25_000 * 1e6);
const MARKETS_DEFAULT_SEED = 1_000n;

const POPULATE_LEVELS = 10;
const POPULATE_ORDERS_PER_LEVEL = 10;
const POPULATE_TICK_BPS = 50;
const POPULATE_MIN_BASE = BigInt(2 * 1e6);
const POPULATE_MAX_BASE = BigInt(20 * 1e6);

const SETTLE_TIMEOUT_MS = 60_000;
const LOCAL_VALIDATOR_FALLBACK =
  "0x70997970C51812dc3A010C7d01b50e0d17dC79C8" as Address;
const TOKEN_DECIMALS = 6;
const MIN_REPRESENTABLE_PRICE = 0.000001;

const formatToken = (amount: bigint, decimals: number = TOKEN_DECIMALS): string =>
  `${formatUnits(amount, decimals)} (${amount.toString()} atoms)`;

type DemoParticipant = {
  role: string;
  address: Address;
  derivationPath: string;
  privateKey: string;
};

type TakerExecution = {
  label: string;
  address: Address;
  status: "fulfilled" | "timed_out" | "failed";
  orderId?: string;
  reason?: string;
};

type MarketSummaryRow = {
  market: number;
  orderbook: Address;
  baseVault: Address;
  quoteVault: Address;
  baseTokenId: string;
  quoteTokenId: string;
  baseSymbol: string;
  quoteSymbol: string;
  midPriceQuotePerBase: string;
  transferBase: number;
  transferQuote: number;
  takerAmountBase: number;
  takerMaxQuote: number;
  seed: string;
  bidsSeeded: number;
  asksSeeded: number;
  firstOrderId: string;
  lastOrderId: string;
  bestBidBefore: string;
  bestAskBefore: string;
  bestBidAfter: string;
  bestAskAfter: string;
  takersFulfilled: number;
  takersTimedOut: number;
  takersFailed: number;
  buyerAddress: Address;
  sellerAddress: Address;
  buyerBaseBefore: string;
  buyerQuoteBefore: string;
  buyerBaseAfter: string;
  buyerQuoteAfter: string;
  sellerBaseBefore: string;
  sellerQuoteBefore: string;
  sellerBaseAfter: string;
  sellerQuoteAfter: string;
  takerExecutions: TakerExecution[];
};

type MarketRuntimeConfig = {
  midPriceQuotePerBase: number;
  transferBase: number;
  transferQuote: number;
  takerAmountBase: number;
  takerMaxQuote: number;
};

const fallbackMidPriceByPair = new Map<string, number>([
  ["VARA/USDC", 0.001165],
  ["ETH/USDC", 2055],
  ["USDC/VARA", 1 / 0.001165],
  ["USDC/USDC", 1],
  ["VARA/VARA", 1],
  ["ETH/ETH", 1],
]);

const normalizeMidPrice = (value: number): number =>
  Math.max(value, MIN_REPRESENTABLE_PRICE);

const fallbackMidPrice = (baseSymbol: string, quoteSymbol: string): number => {
  const key = `${baseSymbol.toUpperCase()}/${quoteSymbol.toUpperCase()}`;
  return normalizeMidPrice(fallbackMidPriceByPair.get(key) ?? 1);
};

const deriveMarketRuntime = (
  explicitMidPrice: number | undefined,
  baseSymbol: string,
  quoteSymbol: string,
): MarketRuntimeConfig => {
  const midPriceQuotePerBase = normalizeMidPrice(
    explicitMidPrice && explicitMidPrice > 0
      ? explicitMidPrice
      : fallbackMidPrice(baseSymbol, quoteSymbol),
  );

  const takerAmountBase =
    midPriceQuotePerBase >= 1_000
      ? 1
      : midPriceQuotePerBase >= 100
        ? 2
        : midPriceQuotePerBase >= 1
          ? 10
          : midPriceQuotePerBase >= 0.01
            ? 50
            : 250;

  const requiredQuote = Math.max(
    1,
    Math.ceil(midPriceQuotePerBase * takerAmountBase * 1.5),
  );
  const takerMaxQuote = Math.max(250, requiredQuote);
  const transferQuote = Math.max(500, Math.ceil(requiredQuote * 2.25));
  const transferBase = Math.max(500, takerAmountBase * 20);

  return {
    midPriceQuotePerBase,
    transferBase,
    transferQuote,
    takerAmountBase,
    takerMaxQuote,
  };
};

const timeout = (ms: number) =>
  new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("timeout")), ms),
  );

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([promise, timeout(ms)]);
}

class CompatEthereumClient {
  public router: Pick<ReturnType<typeof getRouterClient>, "validators">;
  private routerClient: ReturnType<typeof getRouterClient>;
  private fallbackValidators: Address[];
  private signerRef?: ISigner;
  private chainId = 31337;

  constructor(
    private publicClient: ReturnType<typeof createPublicClient>,
    routerAddress: Address,
    fallbackValidators: Address[],
    signer?: ISigner,
  ) {
    this.signerRef = signer;
    this.routerClient = getRouterClient({
      address: routerAddress,
      signer,
      publicClient,
    });
    this.fallbackValidators = fallbackValidators.map(
      (address) => address.toLowerCase() as Address,
    );
    this.router = {
      validators: async () => {
        try {
          return await this.routerClient.validators();
        } catch (error) {
          if (this.fallbackValidators.length === 0) {
            throw error;
          }

          logger.warn(
            "router.validators() unavailable; using fallback validator list",
            {
              error: String(error),
              fallbackValidators: this.fallbackValidators,
            },
          );
          return this.fallbackValidators;
        }
      },
    };
  }

  async waitForInitialization() {
    this.chainId = await this.publicClient.getChainId();
    return true;
  }

  setSigner(signer: ISigner) {
    this.signerRef = signer;
    this.routerClient.setSigner(signer);
    return this;
  }

  get signer(): ISigner {
    if (!this.signerRef) {
      throw new Error("Signer not set");
    }
    return this.signerRef;
  }

  async getBlockNumber() {
    return Number(await this.publicClient.getBlockNumber());
  }

  getBlock(blockNumber: number) {
    return this.publicClient.getBlock({ blockNumber: BigInt(blockNumber) });
  }

  async getLatestBlockTimestamp() {
    const block = await this.publicClient.getBlock({ blockTag: "latest" });
    return Number(block.timestamp);
  }

  get blockDuration() {
    if (this.chainId === 31337) return 1;
    if (this.chainId === 1 || this.chainId === 560048) return 12;
    return 1;
  }
}

async function main() {
  await initCodec();
  await initAccounts(20);

  const ethTransport = webSocket(config.transports.ethereumWs);

  const publicClient = createPublicClient({
    transport: ethTransport,
  });

  const fallbackValidators =
    config.contracts.validators.length > 0
      ? config.contracts.validators
      : [LOCAL_VALIDATOR_FALLBACK];

  const ethClient = new CompatEthereumClient(
    publicClient,
    config.contracts.router,
    fallbackValidators,
  );
  await ethClient.waitForInitialization();

  const varaEthApi = new VaraEthApi(
    new WsVaraEthProvider(config.transports.varaEthWsRpc),
    ethClient as any,
  );

  const makeSigner = (account: Account): ISigner => {
    const wc = createWalletClient({ account, transport: ethTransport });
    const signerAccount = wc.account ?? account;

    return {
      getAddress: async () => signerAccount.address,
      signMessage: async (message: Uint8Array | string) => {
        if (typeof message === "string") {
          if (message.startsWith("0x")) {
            return wc.signMessage({
              account: signerAccount,
              message: { raw: message as `0x${string}` },
            });
          }
          return wc.signMessage({
            account: signerAccount,
            message,
          });
        }

        return wc.signMessage({
          account: signerAccount,
          message: { raw: message },
        });
      },
    };
  };

  const fallbackAdminAccount = privateKeyToAccount(
    config.accounts.privateKey as `0x${string}`,
  );
  const fallbackAdminSigner = makeSigner(fallbackAdminAccount);

  const allAccounts = [
    ...accountsBaseTokensFunded.values(),
    ...accountsQuoteTokensFunded.values(),
  ];

  const privateKeyForAccount = (account: Account): string => {
    const hdKeyGetter = (account as { getHdKey?: () => { privateKey: Uint8Array } }).getHdKey;
    if (!hdKeyGetter) return "(private key unavailable)";
    return toHex(hdKeyGetter().privateKey);
  };

  const signerByAddress = new Map<string, ISigner>();

  const getSignerForAddress = (address: Address): ISigner => {
    const key = address.toLowerCase();
    const cached = signerByAddress.get(key);
    if (cached) return cached;

    const account = allAccounts.find(
      (candidate) => candidate.address.toLowerCase() === key,
    );

    const signer = account ? makeSigner(account) : fallbackAdminSigner;
    signerByAddress.set(key, signer);
    if (!account) {
      logger.warn("Using PRIVATE_KEY signer fallback for address", { address });
    }
    return signer;
  };

  const resolveAdminSigner = async (vault: Vault): Promise<ISigner> => {
    const adminActorId = await vault.queryAdmin();
    const adminAddress = actorIdToAddress(adminActorId);
    logger.info("Resolved admin signer", { adminActorId, adminAddress });
    return getSignerForAddress(adminAddress);
  };

  const marketContexts = config.contracts.markets.map((market, index) => {
    const baseSymbol = (market.baseSymbol ?? `BASE${index}`).toUpperCase();
    const quoteSymbol = (market.quoteSymbol ?? "USDC").toUpperCase();
    const runtime = deriveMarketRuntime(
      market.midPriceQuotePerBase,
      baseSymbol,
      quoteSymbol,
    );

    return {
      index,
      orderbook: new Orderbook(
        orderbookCodec,
        varaEthApi,
        publicClient,
        market.orderbook,
        6,
        6,
      ),
      baseVault: new Vault(vaultCodec, varaEthApi, publicClient, market.baseTokenVault, 6),
      quoteVault: new Vault(vaultCodec, varaEthApi, publicClient, market.quoteTokenVault, 6),
      orderbookAddress: market.orderbook,
      baseVaultAddress: market.baseTokenVault,
      quoteVaultAddress: market.quoteTokenVault,
      baseTokenId: market.baseTokenId,
      quoteTokenId: market.quoteTokenId,
      baseSymbol,
      quoteSymbol,
      ...runtime,
      adminSigner: fallbackAdminSigner,
      quoteAdminSigner: fallbackAdminSigner,
    };
  });

  logger.info("Markets detected", {
    count: marketContexts.length,
    pairs: marketContexts.map((m) => `${m.baseSymbol}/${m.quoteSymbol}`),
    orderbooks: marketContexts.map((m) => m.orderbookAddress),
  });

  // Step 1: fund vault balances.
  logger.info("Step 1: Funding account balances in vaults");

  const fundAccounts = async (
    accounts: Map<Address, Account>,
    vault: Vault,
    adminSigner: ISigner,
  ) => {
    for (const [address, account] of accounts.entries()) {
      const signer = makeSigner(account);
      const available = await vault.withSigner(signer).getBalance(address);
      if (available < TARGET_BALANCE) {
        await vault
          .withSigner(adminSigner)
          .vaultDeposit(address, TARGET_BALANCE - available);
      }
    }
  };

  const authorizeMarket = async (
    vault: Vault,
    adminSigner: ISigner,
    marketAddress: Address,
    label: string,
  ) => {
    await vault.withSigner(adminSigner).addMarket(marketAddress);
    logger.info("Market authorized in vault", {
      label,
      marketAddress,
    });
  };

  const fundedVaults = new Set<string>();

  for (const market of marketContexts) {
    market.adminSigner = await resolveAdminSigner(market.baseVault);
    market.quoteAdminSigner = await resolveAdminSigner(market.quoteVault);

    const baseVaultKey = market.baseVaultAddress.toLowerCase();
    if (!fundedVaults.has(baseVaultKey)) {
      await fundAccounts(accountsBaseTokensFunded, market.baseVault, market.adminSigner);
      fundedVaults.add(baseVaultKey);
    }

    const quoteVaultKey = market.quoteVaultAddress.toLowerCase();
    if (!fundedVaults.has(quoteVaultKey)) {
      await fundAccounts(
        accountsQuoteTokensFunded,
        market.quoteVault,
        market.quoteAdminSigner,
      );
      fundedVaults.add(quoteVaultKey);
    }
  }

  for (const market of marketContexts) {
    await authorizeMarket(
      market.baseVault,
      market.adminSigner,
      market.orderbookAddress,
      `base-${market.index}`,
    );
    await authorizeMarket(
      market.quoteVault,
      market.quoteAdminSigner,
      market.orderbookAddress,
      `quote-${market.index}`,
    );
  }

  const baseParticipants = [...accountsBaseTokensFunded.entries()]
    .map(([address, account], index) => ({
      address,
      account,
      derivationPath: `m/44'/60'/0'/0/${index * 2}`,
      role: `base-maker-${index}`,
      privateKey: privateKeyForAccount(account),
    }))
    .slice(0, 4);
  const quoteParticipants = [...accountsQuoteTokensFunded.entries()]
    .map(([address, account], index) => ({
      address,
      account,
      derivationPath: `m/44'/60'/0'/0/${index * 2 + 1}`,
      role: `quote-maker-${index}`,
      privateKey: privateKeyForAccount(account),
    }))
    .slice(0, 4);

  const participantSummary: DemoParticipant[] = [
    ...baseParticipants.map((participant) => ({
      role: participant.role,
      address: participant.address,
      derivationPath: participant.derivationPath,
      privateKey: participant.privateKey,
    })),
    ...quoteParticipants.map((participant) => ({
      role: participant.role,
      address: participant.address,
      derivationPath: participant.derivationPath,
      privateKey: participant.privateKey,
    })),
  ];

  // Step 2+: run each market: transfer funds, seed depth, submit takers.
  const perMarketSummary: MarketSummaryRow[] = [];

  for (const market of marketContexts) {
    logger.info("Preparing market", {
      market: market.index,
      pair: `${market.baseSymbol}/${market.quoteSymbol}`,
      orderbook: market.orderbookAddress,
      baseVault: market.baseVaultAddress,
      quoteVault: market.quoteVaultAddress,
      baseTokenId: market.baseTokenId,
      quoteTokenId: market.quoteTokenId,
      midPriceQuotePerBase: market.midPriceQuotePerBase,
      transferBase: market.transferBase,
      transferQuote: market.transferQuote,
      takerAmountBase: market.takerAmountBase,
      takerMaxQuote: market.takerMaxQuote,
    });

    for (const { address, account } of baseParticipants) {
      await market
        .baseVault
        .withSigner(makeSigner(account))
        .transferToMarket(market.orderbookAddress, market.transferBase);
      logger.info("Base transferred to market", { market: market.index, address });
    }

    for (const { address, account } of quoteParticipants) {
      await market
        .quoteVault
        .withSigner(makeSigner(account))
        .transferToMarket(market.orderbookAddress, market.transferQuote);
      logger.info("Quote transferred to market", { market: market.index, address });
    }

    const bestBidPreSeed = BigInt(await market.orderbook.bestBidPrice());
    const bestAskPreSeed = BigInt(await market.orderbook.bestAskPrice());
    const marketAlreadySeeded = bestBidPreSeed > 0n || bestAskPreSeed > 0n;

    let seedResult: {
      bidsInserted: number;
      asksInserted: number;
      firstOrderId: bigint;
      lastOrderId: bigint;
    } = {
      bidsInserted: 0,
      asksInserted: 0,
      firstOrderId: 0n,
      lastOrderId: 0n,
    };

    if (marketAlreadySeeded) {
      logger.warn("Market already has depth, skipping Populate Demo Orders", {
        market: market.index,
        orderbook: market.orderbookAddress,
        bestBid: bestBidPreSeed.toString(),
        bestAsk: bestAskPreSeed.toString(),
      });
    } else {
      const midPrice = market.orderbook.calculateLimitPrice(
        market.midPriceQuotePerBase,
      );
      seedResult = await market
        .orderbook
        .withSigner(market.adminSigner)
        .populateDemoOrders({
          seed: MARKETS_DEFAULT_SEED + BigInt(market.index),
          levels: POPULATE_LEVELS,
          ordersPerLevel: POPULATE_ORDERS_PER_LEVEL,
          midPrice,
          tickBps: POPULATE_TICK_BPS,
          minAmountBase: POPULATE_MIN_BASE,
          maxAmountBase: POPULATE_MAX_BASE,
        });
    }

    const bestBidBefore = BigInt(await market.orderbook.bestBidPrice());
    const bestAskBefore = BigInt(await market.orderbook.bestAskPrice());

    const buyer = quoteParticipants[0];
    const seller = baseParticipants[0];
    const sellerBackup = baseParticipants[1];
    if (!buyer || !seller || !sellerBackup) {
      throw new Error("Not enough demo participants configured");
    }

    const buyerAddress = buyer.address;
    const sellerAddress = seller.address;

    const [buyerBaseBefore, buyerQuoteBefore] = await market.orderbook.balanceOf(
      buyerAddress,
    );
    const [sellerBaseBefore, sellerQuoteBefore] = await market.orderbook.balanceOf(
      sellerAddress,
    );

    const maxQuoteUnitsFromBalance = Number(
      buyerQuoteBefore / BigInt(10 ** TOKEN_DECIMALS),
    );
    const buyMaxQuoteUnits = Math.min(
      market.takerMaxQuote,
      maxQuoteUnitsFromBalance,
    );

    const takerRequests: Array<{
      label: string;
      address: Address;
      submit: () => Promise<bigint>;
    }> = [
      {
        label: "sell-market-1",
        address: sellerAddress,
        submit: () =>
          market
            .orderbook
            .withSigner(makeSigner(seller.account))
            .placeSellMarketOrder(market.takerAmountBase),
      },
    ];

    if (buyMaxQuoteUnits > 0) {
      takerRequests.push({
        label: "buy-market-1",
        address: buyerAddress,
        submit: () =>
          market
            .orderbook
            .withSigner(makeSigner(buyer.account))
            .placeBuyMarketOrder(market.takerAmountBase, buyMaxQuoteUnits),
      });
    } else {
      logger.warn("Skipping buy taker due to zero quote balance in market", {
        market: market.index,
        pair: `${market.baseSymbol}/${market.quoteSymbol}`,
        buyer: buyerAddress,
      });
      takerRequests.push({
        label: "sell-market-2-fallback",
        address: sellerBackup.address,
        submit: () =>
          market
            .orderbook
            .withSigner(makeSigner(sellerBackup.account))
            .placeSellMarketOrder(market.takerAmountBase),
      });
    }

    const takerExecutions: TakerExecution[] = [];
    for (const request of takerRequests) {
      try {
        const orderId = await withTimeout(request.submit(), SETTLE_TIMEOUT_MS);
        takerExecutions.push({
          label: request.label,
          address: request.address,
          status: "fulfilled",
          orderId: orderId.toString(),
        });
      } catch (error) {
        const reason = (error as Error)?.message ?? String(error);
        takerExecutions.push({
          label: request.label,
          address: request.address,
          status: reason === "timeout" ? "timed_out" : "failed",
          reason,
        });
      }
    }

    const takersFulfilled = takerExecutions.filter(
      (x) => x.status === "fulfilled",
    ).length;
    const takersTimedOut = takerExecutions.filter(
      (x) => x.status === "timed_out",
    ).length;
    const takersFailed = takerExecutions.filter(
      (x) => x.status === "failed",
    ).length;

    const bestBidAfter = BigInt(await market.orderbook.bestBidPrice());
    const bestAskAfter = BigInt(await market.orderbook.bestAskPrice());
    const [buyerBaseAfter, buyerQuoteAfter] = await market.orderbook.balanceOf(
      buyerAddress,
    );
    const [sellerBaseAfter, sellerQuoteAfter] = await market.orderbook.balanceOf(
      sellerAddress,
    );

    logger.info("Market execution summary", {
      market: market.index,
      pair: `${market.baseSymbol}/${market.quoteSymbol}`,
      bidsSeeded: seedResult.bidsInserted,
      asksSeeded: seedResult.asksInserted,
      firstOrderId: seedResult.firstOrderId.toString(),
      lastOrderId: seedResult.lastOrderId.toString(),
      bestBidBefore: bestBidBefore.toString(),
      bestAskBefore: bestAskBefore.toString(),
      bestBidAfter: bestBidAfter.toString(),
      bestAskAfter: bestAskAfter.toString(),
      takersFulfilled,
      takersTimedOut,
      takersFailed,
      buyer: buyerAddress,
      seller: sellerAddress,
      takerExecutions,
    });

    perMarketSummary.push({
      market: market.index,
      orderbook: market.orderbookAddress,
      baseVault: market.baseVaultAddress,
      quoteVault: market.quoteVaultAddress,
      baseTokenId: market.baseTokenId,
      quoteTokenId: market.quoteTokenId,
      baseSymbol: market.baseSymbol,
      quoteSymbol: market.quoteSymbol,
      midPriceQuotePerBase: market.midPriceQuotePerBase.toString(),
      transferBase: market.transferBase,
      transferQuote: market.transferQuote,
      takerAmountBase: market.takerAmountBase,
      takerMaxQuote: market.takerMaxQuote,
      seed: (MARKETS_DEFAULT_SEED + BigInt(market.index)).toString(),
      bidsSeeded: seedResult.bidsInserted,
      asksSeeded: seedResult.asksInserted,
      firstOrderId: seedResult.firstOrderId.toString(),
      lastOrderId: seedResult.lastOrderId.toString(),
      bestBidBefore: bestBidBefore.toString(),
      bestAskBefore: bestAskBefore.toString(),
      bestBidAfter: bestBidAfter.toString(),
      bestAskAfter: bestAskAfter.toString(),
      takersFulfilled,
      takersTimedOut,
      takersFailed,
      buyerAddress,
      sellerAddress,
      buyerBaseBefore: buyerBaseBefore.toString(),
      buyerQuoteBefore: buyerQuoteBefore.toString(),
      buyerBaseAfter: buyerBaseAfter.toString(),
      buyerQuoteAfter: buyerQuoteAfter.toString(),
      sellerBaseBefore: sellerBaseBefore.toString(),
      sellerQuoteBefore: sellerQuoteBefore.toString(),
      sellerBaseAfter: sellerBaseAfter.toString(),
      sellerQuoteAfter: sellerQuoteAfter.toString(),
      takerExecutions,
    });
  }

  console.log("\n" + "=".repeat(88));
  console.log("  MULTI-MARKET SHOWCASE SUMMARY");
  console.log("=".repeat(88));
  console.log("\n  Access");
  console.log(
    `    Admin fallback signer (PRIVATE_KEY): ${fallbackAdminAccount.address} | ${config.accounts.privateKey}`,
  );
  console.log("    Funded participants are derived from mnemonic:");
  console.log(`      ${config.accounts.mnemonicForAccountDerivation}`);
  console.log("\n  Accounts Used (funding + takers)");
  for (const participant of participantSummary) {
    console.log(
      `    ${participant.role} | ${participant.address} | ${participant.derivationPath} | ${participant.privateKey}`,
    );
  }

  console.log("\n  Demo Parameters");
  console.log(`    Markets: ${marketContexts.length}`);
  console.log(`    Target vault balance per user: ${formatToken(TARGET_BALANCE)}`);
  console.log(
    "    Transfers and taker sizing are dynamic per market based on target mid price.",
  );
  console.log(
    `    Seed depth per market: levels=${POPULATE_LEVELS}, orders_per_level=${POPULATE_ORDERS_PER_LEVEL}, tick_bps=${POPULATE_TICK_BPS}`,
  );
  console.log(
    `    Seed base amount range: ${formatToken(POPULATE_MIN_BASE)} .. ${formatToken(POPULATE_MAX_BASE)}`,
  );

  for (const row of perMarketSummary) {
    console.log(`\n  Market #${row.market} (${row.baseSymbol}/${row.quoteSymbol})`);
    console.log(`    Orderbook: ${row.orderbook}`);
    console.log(`    Base vault: ${row.baseVault}`);
    console.log(`    Quote vault: ${row.quoteVault}`);
    console.log(`    Base token id: ${row.baseTokenId}`);
    console.log(`    Quote token id: ${row.quoteTokenId}`);
    console.log(`    Mid price (${row.quoteSymbol} per ${row.baseSymbol}): ${row.midPriceQuotePerBase}`);
    console.log(
      `    Transfer/taker: base=${row.transferBase}, quote=${row.transferQuote}, taker_base=${row.takerAmountBase}, taker_max_quote=${row.takerMaxQuote}`,
    );
    console.log(`    Seed used: ${row.seed}`);
    console.log(`    Seeded bids/asks: ${row.bidsSeeded}/${row.asksSeeded}`);
    console.log(`    Seed order id range: ${row.firstOrderId} -> ${row.lastOrderId}`);
    console.log(
      `    Best bid/ask before: ${row.bestBidBefore}/${row.bestAskBefore}`,
    );
    console.log(
      `    Best bid/ask after:  ${row.bestBidAfter}/${row.bestAskAfter}`,
    );
    console.log(
      `    Takers fulfilled/timed out/failed: ${row.takersFulfilled}/${row.takersTimedOut}/${row.takersFailed}`,
    );
    for (const execution of row.takerExecutions) {
      const suffix = execution.orderId
        ? `order_id=${execution.orderId}`
        : `reason=${execution.reason ?? "unknown"}`;
      console.log(
        `      ${execution.label} | ${execution.address} | ${execution.status} | ${suffix}`,
      );
    }
    console.log(
      `    Buyer balance (base): ${formatToken(BigInt(row.buyerBaseBefore))} -> ${formatToken(BigInt(row.buyerBaseAfter))}`,
    );
    console.log(
      `    Buyer balance (quote): ${formatToken(BigInt(row.buyerQuoteBefore))} -> ${formatToken(BigInt(row.buyerQuoteAfter))}`,
    );
    console.log(
      `    Seller balance (base): ${formatToken(BigInt(row.sellerBaseBefore))} -> ${formatToken(BigInt(row.sellerBaseAfter))}`,
    );
    console.log(
      `    Seller balance (quote): ${formatToken(BigInt(row.sellerQuoteBefore))} -> ${formatToken(BigInt(row.sellerQuoteAfter))}`,
    );
    console.log(`    Buyer/Seller: ${row.buyerAddress} / ${row.sellerAddress}`);
  }
  console.log("\n" + "=".repeat(88) + "\n");

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

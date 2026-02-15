import { Account, Address, createPublicClient, createWalletClient, formatUnits, webSocket } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ISigner,
  VaraEthApi,
  WsVaraEthProvider,
  getRouterClient,
} from "@vara-eth/api";

import {
  accountsBaseTokensFunded,
  accountsQuoteTokensFunded,
  initAccounts,
} from "./accounts.js";
import { initCodec, orderbookCodec, vaultCodec } from "./codec.js";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { Orderbook, Vault } from "./programs/index.js";
import { actorIdToAddress } from "./programs/util.js";

const TOKEN_DECIMALS = 6;
const TOKEN_ATOMS = 10n ** BigInt(TOKEN_DECIMALS);
const PRICE_DECIMALS = 30;
const MIN_PRICE = 0.000001;
const LOCAL_VALIDATOR_FALLBACK =
  "0x70997970C51812dc3A010C7d01b50e0d17dC79C8" as Address;

const envNumber = (key: string, fallback: number): number => {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const envBool = (key: string, fallback: boolean): boolean => {
  const raw = process.env[key];
  if (!raw) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
};

const ACCOUNT_POOL_SIZE = Math.max(8, envNumber("LIQ_ACCOUNT_POOL_SIZE", 40));
const MAKERS_PER_SIDE = Math.max(2, envNumber("LIQ_MAKERS_PER_SIDE", 8));
const LEVELS = Math.max(2, envNumber("LIQ_LEVELS", 20));
const ORDERS_PER_LEVEL = Math.max(1, envNumber("LIQ_ORDERS_PER_LEVEL", 8));
const TICK_BPS = Math.max(1, envNumber("LIQ_TICK_BPS", 25));
const MIN_BASE_UNITS = Math.max(1, envNumber("LIQ_MIN_BASE_UNITS", 20));
const MAX_BASE_UNITS = Math.max(MIN_BASE_UNITS, envNumber("LIQ_MAX_BASE_UNITS", 120));
const BASE_TARGET_UNITS = Math.max(10_000, envNumber("LIQ_BASE_TARGET_UNITS", 1_000_000));
const QUOTE_TARGET_UNITS = Math.max(10_000, envNumber("LIQ_QUOTE_TARGET_UNITS", 2_000_000));
const BASE_TRANSFER_UNITS_FLOOR = Math.max(100, envNumber("LIQ_BASE_TRANSFER_UNITS", 100_000));
const QUOTE_TRANSFER_UNITS_FLOOR = Math.max(100, envNumber("LIQ_QUOTE_TRANSFER_UNITS", 300_000));
const USE_POPULATE_DEMO = envBool("LIQ_USE_POPULATE_DEMO", true);
const SEED_BASE = BigInt(Math.max(1, envNumber("LIQ_SEED_BASE", 4_242)));
const POPULATE_ONLY_ON_EMPTY = envBool("LIQ_POPULATE_ONLY_ON_EMPTY", true);
const IO_CONCURRENCY = Math.max(1, envNumber("LIQ_IO_CONCURRENCY", 8));

type MakerParticipant = {
  address: Address;
  account: Account;
  role: string;
};

type MarketContext = {
  index: number;
  pair: string;
  orderbookAddress: Address;
  orderbook: Orderbook;
  orderbookForSigner: (signer: ISigner) => Orderbook;
  baseVaultAddress: Address;
  quoteVaultAddress: Address;
  baseVault: Vault;
  quoteVault: Vault;
  baseVaultForSigner: (signer: ISigner) => Vault;
  quoteVaultForSigner: (signer: ISigner) => Vault;
  baseSymbol: string;
  quoteSymbol: string;
  midPriceQuotePerBase: number;
  transferBaseUnits: number;
  transferQuoteUnits: number;
  baseAdminSigner: ISigner;
  quoteAdminSigner: ISigner;
  baseAdminKey: string;
  quoteAdminKey: string;
};

type SeedStats = {
  bidsPlaced: number;
  asksPlaced: number;
  bidsFailed: number;
  asksFailed: number;
  mode: "populate-demo" | "manual-ladder" | "already-seeded";
};

const fallbackMidByPair = new Map<string, number>([
  ["VARA/USDC", 0.001165],
  ["ETH/USDC", 2055],
  ["USDC/VARA", 1 / 0.001165],
  ["USDC/USDC", 1],
  ["VARA/VARA", 1],
  ["ETH/ETH", 1],
]);

const normalizeMidPrice = (value: number): number =>
  Math.max(MIN_PRICE, Number.isFinite(value) && value > 0 ? value : 1);

const fpPriceToNumber = (value: bigint): number => {
  const scale = 10n ** BigInt(PRICE_DECIMALS);
  const whole = value / scale;
  const frac = value % scale;
  const micro = (frac * 1_000_000n) / scale;
  return Number(whole) + Number(micro) / 1_000_000;
};

const asUnits = (value: bigint, decimals: number = TOKEN_DECIMALS): string =>
  formatUnits(value, decimals);
const unitsToAtoms = (units: number): bigint => BigInt(units) * TOKEN_ATOMS;
const atomsToUnitsCeil = (atoms: bigint): number =>
  Number((atoms + TOKEN_ATOMS - 1n) / TOKEN_ATOMS);

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
        } catch {
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

const deriveTransferPlan = (midPrice: number): { baseUnits: number; quoteUnits: number } => {
  const avgBase = (MIN_BASE_UNITS + MAX_BASE_UNITS) / 2;
  const totalBasePerSide = LEVELS * ORDERS_PER_LEVEL * avgBase;
  const perMakerBase = Math.ceil((totalBasePerSide / MAKERS_PER_SIDE) * 1.35);
  const baseUnits = Math.max(BASE_TRANSFER_UNITS_FLOOR, perMakerBase);

  const avgBidPrice = Math.max(
    MIN_PRICE,
    midPrice * (1 - (TICK_BPS * (LEVELS + 1)) / 20_000),
  );
  const quotePerMaker = Math.ceil(perMakerBase * avgBidPrice * 1.65);
  const quoteUnits = Math.max(QUOTE_TRANSFER_UNITS_FLOOR, quotePerMaker);

  return { baseUnits, quoteUnits };
};

const fillBalanceIfNeeded = async (
  participants: MakerParticipant[],
  vaultForSigner: (signer: ISigner) => Vault,
  adminSigner: ISigner,
  adminKey: string,
  targetUnits: number,
  signerForAccount: (account: Account) => ISigner,
  runForSigner: <T>(signerKey: string, task: () => Promise<T>) => Promise<T>,
) => {
  const targetAtoms = unitsToAtoms(targetUnits);
  const balances = await Promise.all(
    participants.map(async (participant) => ({
      participant,
      available: await vaultForSigner(signerForAccount(participant.account))
        .getBalance(participant.address),
    })),
  );

  for (const { participant, available } of balances) {
    if (available >= targetAtoms) {
      continue;
    }

    const delta = targetAtoms - available;
    await runForSigner(adminKey, () =>
      vaultForSigner(adminSigner).vaultDeposit(participant.address, delta),
    );
  }
};

const authorizeMarkets = async (
  markets: MarketContext[],
  runForSigner: <T>(signerKey: string, task: () => Promise<T>) => Promise<T>,
) => {
  for (const market of markets) {
    await runForSigner(market.baseAdminKey, () =>
      market
        .baseVaultForSigner(market.baseAdminSigner)
        .addMarket(market.orderbookAddress),
    );
    await runForSigner(market.quoteAdminKey, () =>
      market
        .quoteVaultForSigner(market.quoteAdminSigner)
        .addMarket(market.orderbookAddress),
    );
  }
};

const transferToOrderbook = async (
  markets: MarketContext[],
  baseMakers: MakerParticipant[],
  quoteMakers: MakerParticipant[],
  signerForAccount: (account: Account) => ISigner,
  runForSigner: <T>(signerKey: string, task: () => Promise<T>) => Promise<T>,
) => {
  for (const market of markets) {
    logger.info("Transferring maker balances to orderbook", {
      market: market.index,
      pair: market.pair,
      basePerMaker: market.transferBaseUnits,
      quotePerMaker: market.transferQuoteUnits,
    });
    await Promise.all([
      Promise.all(
        baseMakers.map(async (maker) => {
          const [baseBalance] = await market.orderbook.balanceOf(maker.address);
          const required = unitsToAtoms(market.transferBaseUnits);
          if (baseBalance >= required) {
            return;
          }

          const deficitUnits = atomsToUnitsCeil(required - baseBalance);
          await runForSigner(maker.address, () =>
            market
              .baseVaultForSigner(signerForAccount(maker.account))
              .transferToMarket(market.orderbookAddress, deficitUnits),
          );
        }),
      ),
      Promise.all(
        quoteMakers.map(async (maker) => {
          const [, quoteBalance] = await market.orderbook.balanceOf(maker.address);
          const required = unitsToAtoms(market.transferQuoteUnits);
          if (quoteBalance >= required) {
            return;
          }

          const deficitUnits = atomsToUnitsCeil(required - quoteBalance);
          await runForSigner(maker.address, () =>
            market
              .quoteVaultForSigner(signerForAccount(maker.account))
              .transferToMarket(market.orderbookAddress, deficitUnits),
          );
        }),
      ),
    ]);
  }
};

const runWithConcurrency = async <T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
) => {
  const width = Math.max(1, Math.min(concurrency, items.length));
  let cursor = 0;

  await Promise.all(
    Array.from({ length: width }, async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        await worker(items[index]);
      }
    }),
  );
};

const createSignerTaskRunner = () => {
  const tails = new Map<string, Promise<unknown>>();

  return async <T>(signerKey: string, task: () => Promise<T>): Promise<T> => {
    const key = signerKey.toLowerCase();
    const previous = tails.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    tails.set(key, next);

    try {
      return await next;
    } finally {
      if (tails.get(key) === next) {
        tails.delete(key);
      }
    }
  };
};

const seedManualDepth = async (
  market: MarketContext,
  baseMakers: MakerParticipant[],
  quoteMakers: MakerParticipant[],
  signerForAccount: (account: Account) => ISigner,
  runForSigner: <T>(signerKey: string, task: () => Promise<T>) => Promise<T>,
): Promise<SeedStats> => {
  let bidsPlaced = 0;
  let asksPlaced = 0;
  let bidsFailed = 0;
  let asksFailed = 0;

  const askQueues = new Map<string, Array<{ level: number; amountBase: number; price: number }>>();
  const bidQueues = new Map<string, Array<{ level: number; amountBase: number; price: number }>>();

  const enqueue = (
    queues: Map<string, Array<{ level: number; amountBase: number; price: number }>>,
    maker: MakerParticipant,
    payload: { level: number; amountBase: number; price: number },
  ) => {
    const key = maker.address.toLowerCase();
    const bucket = queues.get(key);
    if (bucket) {
      bucket.push(payload);
      return;
    }

    queues.set(key, [payload]);
  };

  for (let level = 1; level <= LEVELS; level += 1) {
    const offset = (TICK_BPS * level) / 10_000;
    const askPrice = Math.max(MIN_PRICE, market.midPriceQuotePerBase * (1 + offset));
    const bidPrice = Math.max(MIN_PRICE, market.midPriceQuotePerBase * (1 - offset));

    for (let i = 0; i < ORDERS_PER_LEVEL; i += 1) {
      const amountBase =
        MIN_BASE_UNITS + ((level * 37 + i * 13) % (MAX_BASE_UNITS - MIN_BASE_UNITS + 1));

      const askMaker = baseMakers[(level + i) % baseMakers.length];
      enqueue(askQueues, askMaker, { level, amountBase, price: askPrice });

      const bidMaker = quoteMakers[(level + i) % quoteMakers.length];
      enqueue(bidQueues, bidMaker, { level, amountBase, price: bidPrice });
    }
  }

  await runWithConcurrency(
    [...askQueues.entries()],
    Math.max(1, Math.min(IO_CONCURRENCY, askQueues.size)),
    async ([makerKey, orders]) => {
      const maker = baseMakers.find(
        (candidate) => candidate.address.toLowerCase() === makerKey,
      );
      if (!maker) return;

      for (const order of orders) {
        try {
          await runForSigner(maker.address, () =>
            market
              .orderbookForSigner(signerForAccount(maker.account))
              .placeSellLimitOrder(order.amountBase, order.price, false),
          );
          asksPlaced += 1;
        } catch (error) {
          asksFailed += 1;
          logger.warn("Ask placement failed", {
            market: market.index,
            pair: market.pair,
            maker: maker.address,
            level: order.level,
            amountBase: order.amountBase,
            askPrice: order.price,
            error: String(error),
          });
        }
      }
    },
  );

  await runWithConcurrency(
    [...bidQueues.entries()],
    Math.max(1, Math.min(IO_CONCURRENCY, bidQueues.size)),
    async ([makerKey, orders]) => {
      const maker = quoteMakers.find(
        (candidate) => candidate.address.toLowerCase() === makerKey,
      );
      if (!maker) return;

      for (const order of orders) {
        try {
          await runForSigner(maker.address, () =>
            market
              .orderbookForSigner(signerForAccount(maker.account))
              .placeBuyLimitOrder(order.amountBase, order.price, false),
          );
          bidsPlaced += 1;
        } catch (error) {
          bidsFailed += 1;
          logger.warn("Bid placement failed", {
            market: market.index,
            pair: market.pair,
            maker: maker.address,
            level: order.level,
            amountBase: order.amountBase,
            bidPrice: order.price,
            error: String(error),
          });
        }
      }
    },
  );

  return {
    bidsPlaced,
    asksPlaced,
    bidsFailed,
    asksFailed,
    mode: "manual-ladder",
  };
};

const tryPopulateDemoDepth = async (
  market: MarketContext,
  runForSigner: <T>(signerKey: string, task: () => Promise<T>) => Promise<T>,
): Promise<SeedStats | null> => {
  const bestBid = BigInt(await market.orderbook.bestBidPrice());
  const bestAsk = BigInt(await market.orderbook.bestAskPrice());
  const hasDepth = bestBid > 0n || bestAsk > 0n;
  if (POPULATE_ONLY_ON_EMPTY && hasDepth) {
    return {
      bidsPlaced: 0,
      asksPlaced: 0,
      bidsFailed: 0,
      asksFailed: 0,
      mode: "already-seeded",
    };
  }

  try {
    const result = await runForSigner(market.baseAdminKey, () =>
      market
        .orderbookForSigner(market.baseAdminSigner)
        .populateDemoOrders({
          seed: SEED_BASE + BigInt(market.index),
          levels: LEVELS,
          ordersPerLevel: ORDERS_PER_LEVEL,
          midPrice: market.orderbook.calculateLimitPrice(market.midPriceQuotePerBase),
          tickBps: TICK_BPS,
          minAmountBase: unitsToAtoms(MIN_BASE_UNITS),
          maxAmountBase: unitsToAtoms(MAX_BASE_UNITS),
        }),
    );

    return {
      bidsPlaced: result.bidsInserted,
      asksPlaced: result.asksInserted,
      bidsFailed: 0,
      asksFailed: 0,
      mode: "populate-demo",
    };
  } catch (error) {
    logger.warn("PopulateDemoOrders unavailable, falling back to manual seeding", {
      market: market.index,
      pair: market.pair,
      orderbook: market.orderbookAddress,
      error: String(error),
    });
    return null;
  }
};

async function main() {
  await initCodec();
  await initAccounts(ACCOUNT_POOL_SIZE);

  const baseMakers = [...accountsBaseTokensFunded.entries()]
    .slice(0, MAKERS_PER_SIDE)
    .map(([address, account], index) => ({
      address,
      account,
      role: `base-maker-${index}`,
    }));
  const quoteMakers = [...accountsQuoteTokensFunded.entries()]
    .slice(0, MAKERS_PER_SIDE)
    .map(([address, account], index) => ({
      address,
      account,
      role: `quote-maker-${index}`,
    }));

  if (baseMakers.length === 0 || quoteMakers.length === 0) {
    throw new Error("No maker accounts available. Increase LIQ_ACCOUNT_POOL_SIZE.");
  }

  const ethTransport = webSocket(config.transports.ethereumWs);
  const publicClient = createPublicClient({ transport: ethTransport });

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
          return wc.signMessage({ account: signerAccount, message });
        }
        return wc.signMessage({
          account: signerAccount,
          message: { raw: message },
        });
      },
      sendTransaction: async (txData: any) =>
        wc.sendTransaction({
          account: signerAccount,
          ...(txData ?? {}),
        } as any),
    } as ISigner;
  };

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

  const fallbackAdminAccount = privateKeyToAccount(
    config.accounts.privateKey as `0x${string}`,
  );
  const fallbackAdminSigner = makeSigner(fallbackAdminAccount);

  const allAccounts = [
    ...accountsBaseTokensFunded.values(),
    ...accountsQuoteTokensFunded.values(),
  ];

  const signerByAddress = new Map<string, ISigner>();
  const getSignerForAddress = (address: Address): ISigner => {
    const key = address.toLowerCase();
    const cached = signerByAddress.get(key);
    if (cached) return cached;
    const account = allAccounts.find((candidate) => candidate.address.toLowerCase() === key);
    const signer = account ? makeSigner(account) : fallbackAdminSigner;
    signerByAddress.set(key, signer);
    return signer;
  };
  const signerForAccount = (account: Account): ISigner =>
    getSignerForAddress(account.address);
  const runForSigner = createSignerTaskRunner();

  const markets: MarketContext[] = config.contracts.markets.map((market, index) => {
    const baseSymbol = (market.baseSymbol ?? `BASE${index}`).toUpperCase();
    const quoteSymbol = (market.quoteSymbol ?? "USDC").toUpperCase();
    const pair = `${baseSymbol}/${quoteSymbol}`;

    const bestMid = normalizeMidPrice(
      market.midPriceQuotePerBase
      ?? fallbackMidByPair.get(pair)
      ?? 1,
    );
    const transferPlan = deriveTransferPlan(bestMid);

    return {
      index,
      pair,
      orderbookAddress: market.orderbook,
      orderbook: new Orderbook(
        orderbookCodec,
        varaEthApi,
        publicClient,
        market.orderbook,
        TOKEN_DECIMALS,
        TOKEN_DECIMALS,
      ),
      baseVaultAddress: market.baseTokenVault,
      quoteVaultAddress: market.quoteTokenVault,
      baseVault: new Vault(vaultCodec, varaEthApi, publicClient, market.baseTokenVault, TOKEN_DECIMALS),
      quoteVault: new Vault(vaultCodec, varaEthApi, publicClient, market.quoteTokenVault, TOKEN_DECIMALS),
      orderbookForSigner: (signer: ISigner) =>
        new Orderbook(
          orderbookCodec,
          varaEthApi,
          publicClient,
          market.orderbook,
          TOKEN_DECIMALS,
          TOKEN_DECIMALS,
        ).withSigner(signer),
      baseVaultForSigner: (signer: ISigner) =>
        new Vault(
          vaultCodec,
          varaEthApi,
          publicClient,
          market.baseTokenVault,
          TOKEN_DECIMALS,
        ).withSigner(signer),
      quoteVaultForSigner: (signer: ISigner) =>
        new Vault(
          vaultCodec,
          varaEthApi,
          publicClient,
          market.quoteTokenVault,
          TOKEN_DECIMALS,
        ).withSigner(signer),
      baseSymbol,
      quoteSymbol,
      midPriceQuotePerBase: bestMid,
      transferBaseUnits: transferPlan.baseUnits,
      transferQuoteUnits: transferPlan.quoteUnits,
      baseAdminSigner: fallbackAdminSigner,
      quoteAdminSigner: fallbackAdminSigner,
      baseAdminKey: fallbackAdminAccount.address.toLowerCase(),
      quoteAdminKey: fallbackAdminAccount.address.toLowerCase(),
    };
  });

  await Promise.all(
    markets.map(async (market) => {
      const [baseAdminActor, quoteAdminActor] = await Promise.all([
        market.baseVault.queryAdmin(),
        market.quoteVault.queryAdmin(),
      ]);
      const baseAdminAddress = actorIdToAddress(baseAdminActor);
      const quoteAdminAddress = actorIdToAddress(quoteAdminActor);
      market.baseAdminSigner = getSignerForAddress(baseAdminAddress);
      market.quoteAdminSigner = getSignerForAddress(quoteAdminAddress);
      market.baseAdminKey = baseAdminAddress.toLowerCase();
      market.quoteAdminKey = quoteAdminAddress.toLowerCase();
    }),
  );

  const totalBaseTransferPerMaker = markets.reduce(
    (acc, market) => acc + market.transferBaseUnits,
    0,
  );
  const totalQuoteTransferPerMaker = markets.reduce(
    (acc, market) => acc + market.transferQuoteUnits,
    0,
  );
  const baseTargetUnits = Math.max(BASE_TARGET_UNITS, totalBaseTransferPerMaker * 2);
  const quoteTargetUnits = Math.max(QUOTE_TARGET_UNITS, totalQuoteTransferPerMaker * 2);

  const fundedBaseVaults = new Set<string>();
  const fundedQuoteVaults = new Set<string>();
  for (const market of markets) {
    if (!fundedBaseVaults.has(market.baseVaultAddress.toLowerCase())) {
      await fillBalanceIfNeeded(
        baseMakers,
        market.baseVaultForSigner,
        market.baseAdminSigner,
        market.baseAdminKey,
        baseTargetUnits,
        signerForAccount,
        runForSigner,
      );
      fundedBaseVaults.add(market.baseVaultAddress.toLowerCase());
    }

    if (!fundedQuoteVaults.has(market.quoteVaultAddress.toLowerCase())) {
      await fillBalanceIfNeeded(
        quoteMakers,
        market.quoteVaultForSigner,
        market.quoteAdminSigner,
        market.quoteAdminKey,
        quoteTargetUnits,
        signerForAccount,
        runForSigner,
      );
      fundedQuoteVaults.add(market.quoteVaultAddress.toLowerCase());
    }
  }

  await authorizeMarkets(markets, runForSigner);
  await transferToOrderbook(
    markets,
    baseMakers,
    quoteMakers,
    signerForAccount,
    runForSigner,
  );

  logger.info("Seeding orderbooks with deep liquidity", {
    markets: markets.length,
    makersPerSide: MAKERS_PER_SIDE,
    levels: LEVELS,
    ordersPerLevel: ORDERS_PER_LEVEL,
    tickBps: TICK_BPS,
    minBaseUnits: MIN_BASE_UNITS,
    maxBaseUnits: MAX_BASE_UNITS,
    usePopulateDemo: USE_POPULATE_DEMO,
  });

  const summary: Array<Record<string, string | number>> = [];

  for (const market of markets) {
    const preBid = BigInt(await market.orderbook.bestBidPrice());
    const preAsk = BigInt(await market.orderbook.bestAskPrice());
    const hasDepth = preBid > 0n || preAsk > 0n;
    if (preBid > 0n && preAsk > 0n) {
      market.midPriceQuotePerBase = normalizeMidPrice(fpPriceToNumber((preBid + preAsk) / 2n));
    }

    let stats: SeedStats;
    if (POPULATE_ONLY_ON_EMPTY && hasDepth) {
      stats = {
        bidsPlaced: 0,
        asksPlaced: 0,
        bidsFailed: 0,
        asksFailed: 0,
        mode: "already-seeded",
      };
    } else {
      let maybeStats: SeedStats | null = null;
      if (USE_POPULATE_DEMO) {
        maybeStats = await tryPopulateDemoDepth(market, runForSigner);
      }
      stats = maybeStats
        ?? await seedManualDepth(
          market,
          baseMakers,
          quoteMakers,
          signerForAccount,
          runForSigner,
        );
    }

    const postBid = BigInt(await market.orderbook.bestBidPrice());
    const postAsk = BigInt(await market.orderbook.bestAskPrice());
    const tradesCount = await market.orderbook.tradesCount();

    summary.push({
      market: market.index,
      pair: market.pair,
      mode: stats.mode,
      bidsPlaced: stats.bidsPlaced,
      asksPlaced: stats.asksPlaced,
      bidsFailed: stats.bidsFailed,
      asksFailed: stats.asksFailed,
      bestBid: asUnits(postBid, PRICE_DECIMALS),
      bestAsk: asUnits(postAsk, PRICE_DECIMALS),
      tradesCount: tradesCount.toString(),
    });
  }

  console.log("\nLiquidity loading complete:\n");
  console.table(summary);
}

main().catch((error) => {
  logger.error("Liquidity loader failed", { error: String(error) });
  process.exit(1);
});

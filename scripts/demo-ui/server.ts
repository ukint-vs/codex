import http from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ISigner,
  VaraEthApi,
  WsVaraEthProvider,
  getRouterClient,
} from "@vara-eth/api";
import {
  Account,
  Address,
  createPublicClient,
  createWalletClient,
  formatUnits,
  webSocket,
} from "viem";

import { initAccounts, accountsBaseTokensFunded, accountsQuoteTokensFunded } from "../showcase/accounts.js";
import { initCodec, orderbookCodec } from "../showcase/codec.js";
import { config } from "../showcase/config.js";
import { logger } from "../showcase/logger.js";
import { Orderbook } from "../showcase/programs/index.js";
import { actorIdToAddress } from "../showcase/programs/util.js";

const TOKEN_DECIMALS = 6;
const PRICE_DECIMALS = 30;
const DEFAULT_REFRESH_MS = 5000;
const DEFAULT_ORDERS_PER_MARKET = 20;
const DEFAULT_DEPTH_LEVELS = 20;
const DEFAULT_OPEN_ORDERS_SCAN_COUNT = 220;
const DEFAULT_TRADES_PER_MARKET = 300;
const DEFAULT_ACTION_HISTORY_LIMIT = 2_000;
const DEFAULT_MAKER_ACCOUNTS_PER_SIDE = 4;
const LOCAL_VALIDATOR_FALLBACK =
  "0x70997970C51812dc3A010C7d01b50e0d17dC79C8" as Address;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");
const defaultHistoryFilePath = path.join(__dirname, "data", "recent-actions.json");

type Participant = {
  role: string;
  address: Address;
};

type OrderRow = {
  id: string;
  side: "Buy" | "Sell";
  owner: Address;
  priceQuotePerBase: string;
  remainingBase: string;
  reservedQuote: string;
};

type BalanceRow = {
  role: string;
  address: Address;
  base: string;
  quote: string;
};

type DepthLevel = {
  priceQuotePerBase: string;
  sizeBase: string;
  totalBase: string;
  orders: number;
};

type ActionRow = {
  ts: string;
  kind: "market" | "take" | "limit";
  status: "submitted" | "executed" | "failed";
  actorRole: string;
  side: "buy" | "sell";
  amountBase: number;
  orderId?: string;
  selectedOrderId?: number;
  selectedOrderSide?: "buy" | "sell";
  baseDelta?: string;
  quoteDelta?: string;
  executionPriceApprox?: string;
  note?: string;
};

type TradeRow = {
  seq: string;
  makerOrderId: string;
  takerOrderId: string;
  maker: Address;
  taker: Address;
  priceQuotePerBase: string;
  amountBase: string;
  amountQuote: string;
  ts: string;
};

type MarketSnapshot = {
  index: number;
  orderbook: Address;
  baseVault: Address;
  quoteVault: Address;
  baseTokenId: string;
  quoteTokenId: string;
  baseSymbol: string;
  quoteSymbol: string;
  bestBid: string;
  bestAsk: string;
  spreadBps: string | null;
  orders: OrderRow[];
  depth: {
    asks: DepthLevel[];
    bids: DepthLevel[];
  };
  balances: BalanceRow[];
  tradesCount: string;
  trades: TradeRow[];
  recentActions: ActionRow[];
};

type Snapshot = {
  updatedAt: string;
  refreshMs: number;
  source: {
    ethereumWs: string;
    varaEthWsRpc: string;
  };
  participants: Participant[];
  markets: MarketSnapshot[];
  warning?: string;
};

type PersistedActionsV1 = {
  version: 1;
  savedAt: string;
  entries: Record<string, ActionRow[]>;
};

type TriggerOrderBody = {
  market: number;
  side: "buy" | "sell";
  amountBase: number;
  maxQuote?: number;
  actorRole?: string;
};

type ExecuteOrderBody = {
  market: number;
  orderId: number;
  amountBase?: number;
  actorRole?: string;
};

type SubmitLimitOrderBody = {
  market: number;
  side: "buy" | "sell";
  amountBase: number;
  priceQuotePerBase: number;
  actorRole?: string;
};

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

const asUnits = (value: bigint, decimals: number): string => formatUnits(value, decimals);
const asPrice = (value: bigint): string => formatUnits(value, PRICE_DECIMALS);

const computeSpreadBps = (bestBid: bigint, bestAsk: bigint): string | null => {
  if (bestBid <= 0n || bestAsk <= 0n || bestAsk < bestBid) return null;
  const mid = (bestBid + bestAsk) / 2n;
  if (mid === 0n) return null;
  const bps = ((bestAsk - bestBid) * 10_000n * 1_000n) / mid;
  return (Number(bps) / 1_000).toFixed(3);
};

const ordersPerMarket = Number(
  process.env.DEMO_UI_ORDERS_PER_MARKET ?? DEFAULT_ORDERS_PER_MARKET,
);
const depthLevels = Number(
  process.env.DEMO_UI_DEPTH_LEVELS ?? DEFAULT_DEPTH_LEVELS,
);
const openOrdersScanCount = Number(
  process.env.DEMO_UI_OPEN_ORDERS_SCAN_COUNT ?? DEFAULT_OPEN_ORDERS_SCAN_COUNT,
);
const tradesPerMarket = Number(
  process.env.DEMO_UI_TRADES_PER_MARKET ?? DEFAULT_TRADES_PER_MARKET,
);
const refreshMs = Number(process.env.DEMO_UI_REFRESH_MS ?? DEFAULT_REFRESH_MS);
const port = Number(process.env.DEMO_UI_PORT ?? 4180);
const actionHistoryLimit = Number(
  process.env.DEMO_UI_ACTION_HISTORY_LIMIT ?? DEFAULT_ACTION_HISTORY_LIMIT,
);
const makerAccountsPerSide = Math.max(
  1,
  Number(
    process.env.DEMO_UI_MAKER_ACCOUNTS_PER_SIDE
      ?? DEFAULT_MAKER_ACCOUNTS_PER_SIDE,
  ),
);
const historyFilePath =
  process.env.DEMO_UI_HISTORY_FILE?.trim() || defaultHistoryFilePath;

const marketActionKey = (marketIndex: number, orderbookAddress: Address): string =>
  `${marketIndex}:${orderbookAddress.toLowerCase()}`;

const buildParticipants = (perSide: number): Participant[] => {
  const base = [...accountsBaseTokensFunded.keys()].slice(0, perSide).map((address, i) => ({
    role: `base-maker-${i}`,
    address,
  }));
  const quote = [...accountsQuoteTokensFunded.keys()].slice(0, perSide).map((address, i) => ({
    role: `quote-maker-${i}`,
    address,
  }));
  return [...base, ...quote];
};

type OpenOrder = {
  id: bigint;
  side: 0 | 1;
  owner: Address;
  limitPrice: bigint;
  amountBase: bigint;
  reservedQuote: bigint;
};

const scanOpenOrders = async (
  orderbook: Orderbook,
  count: number,
): Promise<OpenOrder[]> => {
  const rows = await orderbook.ordersReverse(0, count);
  return rows.map((row) => ({
    id: row.id,
    side: (row.side === 0 ? 0 : 1) as 0 | 1,
    owner: actorIdToAddress(row.owner),
    limitPrice: row.limitPrice,
    amountBase: row.amountBase,
    reservedQuote: row.reservedQuote,
  }));
};

const prioritizeOrdersForTaking = (orders: OpenOrder[], count: number): OpenOrder[] => {
  const asks = orders
    .filter((order) => order.side === 1)
    .sort((a, b) => {
      if (a.limitPrice !== b.limitPrice) return a.limitPrice < b.limitPrice ? -1 : 1;
      if (a.id !== b.id) return a.id < b.id ? -1 : 1;
      return 0;
    });
  const bids = orders
    .filter((order) => order.side === 0)
    .sort((a, b) => {
      if (a.limitPrice !== b.limitPrice) return a.limitPrice > b.limitPrice ? -1 : 1;
      if (a.id !== b.id) return a.id < b.id ? -1 : 1;
      return 0;
    });

  const prioritized: OpenOrder[] = [];
  let i = 0;
  while (prioritized.length < count && (i < asks.length || i < bids.length)) {
    if (i < asks.length) prioritized.push(asks[i]);
    if (prioritized.length >= count) break;
    if (i < bids.length) prioritized.push(bids[i]);
    i += 1;
  }
  return prioritized;
};

const toOrderRows = (orders: OpenOrder[], count: number): OrderRow[] =>
  prioritizeOrdersForTaking(orders, count).map((order) => ({
    id: order.id.toString(),
    side: order.side === 0 ? "Buy" : "Sell",
    owner: order.owner,
    priceQuotePerBase: asPrice(order.limitPrice),
    remainingBase: asUnits(order.amountBase, TOKEN_DECIMALS),
    reservedQuote: asUnits(order.reservedQuote, TOKEN_DECIMALS),
  }));

const buildDepth = (
  orders: OpenOrder[],
  levelsPerSide: number,
): { asks: DepthLevel[]; bids: DepthLevel[] } => {
  const aggregate = (side: 0 | 1, ascending: boolean): DepthLevel[] => {
    const map = new Map<bigint, { size: bigint; orders: number }>();
    for (const order of orders) {
      if (order.side !== side) continue;
      const entry = map.get(order.limitPrice) ?? { size: 0n, orders: 0 };
      entry.size += order.amountBase;
      entry.orders += 1;
      map.set(order.limitPrice, entry);
    }

    const levels = [...map.entries()]
      .sort((a, b) => {
        if (a[0] === b[0]) return 0;
        if (ascending) return a[0] < b[0] ? -1 : 1;
        return a[0] > b[0] ? -1 : 1;
      })
      .slice(0, levelsPerSide);

    let cumulative = 0n;
    return levels.map(([price, level]) => {
      cumulative += level.size;
      return {
        priceQuotePerBase: asPrice(price),
        sizeBase: asUnits(level.size, TOKEN_DECIMALS),
        totalBase: asUnits(cumulative, TOKEN_DECIMALS),
        orders: level.orders,
      };
    });
  };

  return {
    asks: aggregate(1, true),
    bids: aggregate(0, false),
  };
};

const contentType = (filePath: string): string => {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".jpg") || filePath.endsWith(".jpeg")) return "image/jpeg";
  if (filePath.endsWith(".webp")) return "image/webp";
  if (filePath.endsWith(".woff2")) return "font/woff2";
  if (filePath.endsWith(".woff")) return "font/woff";
  if (filePath.endsWith(".ttf")) return "font/ttf";
  return "text/plain; charset=utf-8";
};

const fpPriceToNumber = (value: bigint): number => {
  const scale = 10n ** BigInt(PRICE_DECIMALS);
  const whole = value / scale;
  const frac = value % scale;
  const micro = (frac * 1_000_000n) / scale;
  return Number(whole) + Number(micro) / 1_000_000;
};

const readJsonBody = async <T>(req: http.IncomingMessage): Promise<T> => {
  let body = "";
  for await (const chunk of req) {
    body += chunk.toString();
    if (body.length > 1_000_000) {
      throw new Error("Payload too large");
    }
  }
  if (!body.trim()) {
    throw new Error("Request body is empty");
  }
  return JSON.parse(body) as T;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const formatPriceAdaptive = (value: number): string => {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1000) return value.toFixed(2);
  if (value >= 1) return value.toFixed(6).replace(/\.?0+$/, "");
  if (value >= 0.01) return value.toFixed(8).replace(/\.?0+$/, "");
  if (value >= 0.0001) return value.toFixed(10).replace(/\.?0+$/, "");
  return value.toPrecision(10).replace(/\.?0+$/, "");
};

const parsePositiveNumber = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

const executionPriceFromDeltas = (
  baseDelta: bigint,
  quoteDelta: bigint,
): string | undefined => {
  if (baseDelta === 0n || quoteDelta === 0n) return undefined;
  const base = Number(baseDelta < 0n ? -baseDelta : baseDelta) / 10 ** TOKEN_DECIMALS;
  const quote = Number(quoteDelta < 0n ? -quoteDelta : quoteDelta) / 10 ** TOKEN_DECIMALS;
  if (!Number.isFinite(base) || base <= 0) return undefined;
  return formatPriceAdaptive(quote / base);
};

const resolveExecutionPriceApprox = (args: {
  referencePrice?: number;
  deltaPrice?: string;
}): string | undefined => {
  const ref = parsePositiveNumber(args.referencePrice);
  const delta = parsePositiveNumber(args.deltaPrice);
  if (ref > 0 && delta > 0) {
    const ratio = delta / ref;
    if (ratio >= 0.2 && ratio <= 5) {
      return formatPriceAdaptive(delta);
    }
    return formatPriceAdaptive(ref);
  }
  if (ref > 0) return formatPriceAdaptive(ref);
  if (delta > 0) return formatPriceAdaptive(delta);
  return undefined;
};

async function main() {
  await initCodec();
  await initAccounts(20);

  const participants = buildParticipants(makerAccountsPerSide);
  const accountByRole = new Map<string, Account>();
  [...accountsBaseTokensFunded.entries()].slice(0, makerAccountsPerSide).forEach(([_, account], i) =>
    accountByRole.set(`base-maker-${i}`, account),
  );
  [...accountsQuoteTokensFunded.entries()].slice(0, makerAccountsPerSide).forEach(([_, account], i) =>
    accountByRole.set(`quote-maker-${i}`, account),
  );

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

  const markets = config.contracts.markets.map((market, index) => ({
    index,
    orderbookAddress: market.orderbook,
    baseVaultAddress: market.baseTokenVault,
    quoteVaultAddress: market.quoteTokenVault,
    baseTokenId: market.baseTokenId,
    quoteTokenId: market.quoteTokenId,
    baseSymbol: (market.baseSymbol ?? `BASE${index}`).toUpperCase(),
    quoteSymbol: (market.quoteSymbol ?? "USDC").toUpperCase(),
    orderbook: new Orderbook(
      orderbookCodec,
      varaEthApi,
      publicClient,
      market.orderbook,
      TOKEN_DECIMALS,
      TOKEN_DECIMALS,
    ),
  }));

  const recentActionsByMarket = new Map<string, ActionRow[]>();
  const tradeSeenAtByMarket = new Map<string, Map<string, string>>();
  const warnedTradeHistoryUnavailable = new Set<string>();

  const loadPersistedActions = async (): Promise<void> => {
    try {
      const raw = await readFile(historyFilePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedActionsV1>;
      const entries = parsed.entries ?? {};

      for (const [key, value] of Object.entries(entries)) {
        if (!Array.isArray(value)) continue;
        const normalized = value
          .filter((row) => row && typeof row.ts === "string" && typeof row.kind === "string")
          .slice(0, actionHistoryLimit);
        if (normalized.length > 0) {
          recentActionsByMarket.set(key, normalized);
        }
      }

      logger.info("Loaded persisted demo UI actions", {
        historyFilePath,
        marketsWithHistory: recentActionsByMarket.size,
      });
    } catch (error) {
      const message = String(error);
      if (message.includes("ENOENT")) {
        logger.info("No persisted demo UI actions found", { historyFilePath });
        return;
      }
      logger.warn("Failed to load persisted demo UI actions", {
        historyFilePath,
        error: message,
      });
    }
  };

  let persistInFlight = false;
  let persistTimer: NodeJS.Timeout | null = null;

  const persistActions = async (): Promise<void> => {
    if (persistInFlight) return;
    persistInFlight = true;
    try {
      await mkdir(path.dirname(historyFilePath), { recursive: true });
      const payload: PersistedActionsV1 = {
        version: 1,
        savedAt: new Date().toISOString(),
        entries: Object.fromEntries(recentActionsByMarket.entries()),
      };
      const tempPath = `${historyFilePath}.tmp`;
      await writeFile(tempPath, JSON.stringify(payload, null, 2), "utf8");
      await rename(tempPath, historyFilePath);
    } catch (error) {
      logger.warn("Failed to persist demo UI actions", {
        historyFilePath,
        error: String(error),
      });
    } finally {
      persistInFlight = false;
    }
  };

  const schedulePersistActions = (): void => {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void persistActions();
    }, 700);
  };

  const getRecentActions = (marketIndex: number, orderbookAddress: Address): ActionRow[] => {
    const key = marketActionKey(marketIndex, orderbookAddress);
    const direct = recentActionsByMarket.get(key);
    if (direct) return direct;

    const legacy = recentActionsByMarket.get(String(marketIndex));
    if (!legacy) return [];

    recentActionsByMarket.set(key, legacy);
    recentActionsByMarket.delete(String(marketIndex));
    schedulePersistActions();
    return legacy;
  };

  const pushRecentAction = (
    marketIndex: number,
    orderbookAddress: Address,
    action: ActionRow,
  ) => {
    const key = marketActionKey(marketIndex, orderbookAddress);
    const current = recentActionsByMarket.get(key) ?? [];
    current.unshift(action);
    if (current.length > actionHistoryLimit) current.length = actionHistoryLimit;
    recentActionsByMarket.set(key, current);
    schedulePersistActions();
  };

  const toTradeRows = (
    marketIndex: number,
    orderbookAddress: Address,
    trades: Awaited<ReturnType<Orderbook["tradesReverse"]>>,
  ): TradeRow[] => {
    const key = marketActionKey(marketIndex, orderbookAddress);
    const seenAt = tradeSeenAtByMarket.get(key) ?? new Map<string, string>();
    tradeSeenAtByMarket.set(key, seenAt);

    const sorted = [...trades].sort((a, b) => {
      if (a.seq === b.seq) return 0;
      return a.seq < b.seq ? -1 : 1;
    });
    const now = new Date().toISOString();
    const seqs = new Set<string>();
    const rows: TradeRow[] = [];

    for (const trade of sorted) {
      const seq = trade.seq.toString();
      seqs.add(seq);
      const ts = seenAt.get(seq) ?? now;
      if (!seenAt.has(seq)) {
        seenAt.set(seq, ts);
      }

      rows.push({
        seq,
        makerOrderId: trade.makerOrderId.toString(),
        takerOrderId: trade.takerOrderId.toString(),
        maker: trade.maker,
        taker: trade.taker,
        priceQuotePerBase: asPrice(trade.price),
        amountBase: asUnits(trade.amountBase, TOKEN_DECIMALS),
        amountQuote: asUnits(trade.amountQuote, TOKEN_DECIMALS),
        ts,
      });
    }

    if (seenAt.size > tradesPerMarket * 6) {
      for (const existing of seenAt.keys()) {
        if (!seqs.has(existing)) {
          seenAt.delete(existing);
        }
      }
    }

    rows.reverse();
    return rows;
  };

  const loadTradeRows = async (market: (typeof markets)[number]): Promise<{
    tradesCount: bigint;
    trades: Awaited<ReturnType<Orderbook["tradesReverse"]>>;
  }> => {
    try {
      const [tradesCount, trades] = await Promise.all([
        market.orderbook.tradesCount(),
        market.orderbook.tradesReverse(0, tradesPerMarket),
      ]);

      return { tradesCount, trades };
    } catch (error) {
      const key = `${market.index}:${market.orderbookAddress.toLowerCase()}`;
      if (!warnedTradeHistoryUnavailable.has(key)) {
        warnedTradeHistoryUnavailable.add(key);
        logger.warn("Trade history queries unavailable for market", {
          marketIndex: market.index,
          orderbook: market.orderbookAddress,
          error: String(error),
        });
      }
      return {
        tradesCount: 0n,
        trades: [],
      };
    }
  };

  await loadPersistedActions();

  const observeExecution = async (
    orderbook: Orderbook,
    actorAddress: Address,
    submit: () => Promise<bigint>,
  ): Promise<{
    orderId: bigint;
    executed: boolean;
    baseDelta: bigint;
    quoteDelta: bigint;
  }> => {
    const [baseBefore, quoteBefore] = await orderbook.balanceOf(actorAddress);
    const orderId = await submit();

    let baseAfter = baseBefore;
    let quoteAfter = quoteBefore;

    for (let i = 0; i < 12; i += 1) {
      await sleep(200);
      const [b, q] = await orderbook.balanceOf(actorAddress);
      baseAfter = b;
      quoteAfter = q;
      if (b !== baseBefore || q !== quoteBefore) break;
    }

    const baseDelta = baseAfter - baseBefore;
    const quoteDelta = quoteAfter - quoteBefore;
    const executed = baseDelta !== 0n || quoteDelta !== 0n;

    return {
      orderId,
      executed,
      baseDelta,
      quoteDelta,
    };
  };

  let snapshot: Snapshot = {
    updatedAt: new Date(0).toISOString(),
    refreshMs,
    source: {
      ethereumWs: config.transports.ethereumWs,
      varaEthWsRpc: config.transports.varaEthWsRpc,
    },
    participants,
    markets: [],
  };

  let lastError: string | undefined;
  let refreshing = false;

  const collectSnapshot = async (): Promise<Snapshot> => {
    const marketRows = await Promise.all(
      markets.map(async (market) => {
        const [bestBidRaw, bestAskRaw, openOrders, balances, tradeData] = await Promise.all([
          market.orderbook.bestBidPrice().then((x) => BigInt(x)),
          market.orderbook.bestAskPrice().then((x) => BigInt(x)),
          scanOpenOrders(
            market.orderbook,
            Math.max(openOrdersScanCount, ordersPerMarket),
          ),
          Promise.all(
            participants.map(async (participant): Promise<BalanceRow> => {
              const [base, quote] = await market.orderbook.balanceOf(participant.address);
              return {
                role: participant.role,
                address: participant.address,
                base: asUnits(base, TOKEN_DECIMALS),
                quote: asUnits(quote, TOKEN_DECIMALS),
              };
            }),
          ),
          loadTradeRows(market),
        ]);

        return {
          index: market.index,
          orderbook: market.orderbookAddress,
          baseVault: market.baseVaultAddress,
          quoteVault: market.quoteVaultAddress,
          baseTokenId: market.baseTokenId,
          quoteTokenId: market.quoteTokenId,
          baseSymbol: market.baseSymbol,
          quoteSymbol: market.quoteSymbol,
          bestBid: asPrice(bestBidRaw),
          bestAsk: asPrice(bestAskRaw),
          spreadBps: computeSpreadBps(bestBidRaw, bestAskRaw),
          orders: toOrderRows(openOrders, ordersPerMarket),
          depth: buildDepth(openOrders, depthLevels),
          balances,
          tradesCount: tradeData.tradesCount.toString(),
          trades: toTradeRows(
            market.index,
            market.orderbookAddress,
            tradeData.trades,
          ),
          recentActions: getRecentActions(market.index, market.orderbookAddress),
        } satisfies MarketSnapshot;
      }),
    );

    return {
      updatedAt: new Date().toISOString(),
      refreshMs,
      source: {
        ethereumWs: config.transports.ethereumWs,
        varaEthWsRpc: config.transports.varaEthWsRpc,
      },
      participants,
      markets: marketRows,
      warning: lastError,
    };
  };

  const refresh = async () => {
    if (refreshing) return;
    refreshing = true;
    try {
      snapshot = await collectSnapshot();
      lastError = undefined;
    } catch (error) {
      lastError = (error as Error)?.message ?? String(error);
      snapshot = {
        ...snapshot,
        warning: lastError,
        updatedAt: new Date().toISOString(),
      };
      logger.warn("Demo UI snapshot refresh failed", { error: lastError });
    } finally {
      refreshing = false;
    }
  };

  await refresh();
  setInterval(refresh, refreshMs).unref();

  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (reqUrl.pathname === "/api/snapshot") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(snapshot, null, 2));
      return;
    }

    if (reqUrl.pathname === "/api/trigger-order" && req.method === "POST") {
      try {
        const body = await readJsonBody<TriggerOrderBody>(req);
        const market = markets.find((m) => m.index === Number(body.market));
        if (!market) {
          throw new Error(`Unknown market index: ${body.market}`);
        }

        const side = (body.side ?? "").toLowerCase();
        if (side !== "buy" && side !== "sell") {
          throw new Error("side must be either 'buy' or 'sell'");
        }

        const amountBase = Number(body.amountBase);
        if (!Number.isFinite(amountBase) || amountBase <= 0) {
          throw new Error("amountBase must be a positive number");
        }

        const actorRole =
          body.actorRole ??
          (side === "buy" ? "quote-maker-0" : "base-maker-0");
        const actorAccount = accountByRole.get(actorRole);
        if (!actorAccount) {
          throw new Error(`Unknown actor role: ${actorRole}`);
        }

        const orderbook = new Orderbook(
          orderbookCodec,
          varaEthApi,
          publicClient,
          market.orderbookAddress,
          TOKEN_DECIMALS,
          TOKEN_DECIMALS,
        ).withSigner(makeSigner(actorAccount));

        const [bestBidBefore, bestAskBefore] = await Promise.all([
          market.orderbook.bestBidPrice().then((x) => BigInt(x)),
          market.orderbook.bestAskPrice().then((x) => BigInt(x)),
        ]);

        const maxQuote =
          side === "buy"
            ? Math.max(amountBase, Number(body.maxQuote ?? amountBase * 2))
            : 0;

        const result = await observeExecution(
          orderbook,
          actorAccount.address,
          () =>
            side === "buy"
              ? orderbook.placeBuyMarketOrder(amountBase, maxQuote, false)
              : orderbook.placeSellMarketOrder(amountBase, false),
        );

        const deltaExecutionPrice = executionPriceFromDeltas(
          result.baseDelta,
          result.quoteDelta,
        );
        const bookExecutionReference = side === "buy"
          ? fpPriceToNumber(bestAskBefore)
          : fpPriceToNumber(bestBidBefore);
        const executionPriceApprox = result.executed
          ? resolveExecutionPriceApprox({
              referencePrice: bookExecutionReference,
              deltaPrice: deltaExecutionPrice,
            })
          : undefined;

        pushRecentAction(market.index, market.orderbookAddress, {
          ts: new Date().toISOString(),
          kind: "market",
          status: result.executed ? "executed" : "submitted",
          actorRole,
          side,
          amountBase,
          orderId: result.orderId.toString(),
          baseDelta: asUnits(result.baseDelta, TOKEN_DECIMALS),
          quoteDelta: asUnits(result.quoteDelta, TOKEN_DECIMALS),
          executionPriceApprox,
          note: result.executed
            ? "Balance changed"
            : "Submitted (no immediate balance change observed)",
        });

        await refresh();

        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            ok: true,
            market: market.index,
            side,
            actorRole,
            orderId: result.orderId.toString(),
            amountBase,
            maxQuote,
            executed: result.executed,
            baseDelta: asUnits(result.baseDelta, TOKEN_DECIMALS),
            quoteDelta: asUnits(result.quoteDelta, TOKEN_DECIMALS),
          }),
        );
      } catch (error) {
        const message = (error as Error)?.message ?? String(error);
        logger.warn("Failed to trigger demo order", { error: message });
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: message }));
      }
      return;
    }

    if (reqUrl.pathname === "/api/execute-order" && req.method === "POST") {
      try {
        const body = await readJsonBody<ExecuteOrderBody>(req);
        const market = markets.find((m) => m.index === Number(body.market));
        if (!market) {
          throw new Error(`Unknown market index: ${body.market}`);
        }

        const orderId = Number(body.orderId);
        if (!Number.isFinite(orderId) || orderId <= 0) {
          throw new Error("orderId must be a positive number");
        }

        const sourceOrder = await market.orderbook.orderById(BigInt(orderId));
        if (!sourceOrder.exists) {
          throw new Error(`Order #${orderId} not found`);
        }
        const selectedRemainingBefore = sourceOrder.amountBase;

        const remainingUnits = Number(
          sourceOrder.amountBase / BigInt(10 ** TOKEN_DECIMALS),
        );
        if (!Number.isFinite(remainingUnits) || remainingUnits <= 0) {
          throw new Error(`Order #${orderId} has no remaining amount`);
        }

        const requestedAmount = Number(body.amountBase ?? remainingUnits);
        const amountBase = Math.max(
          1,
          Math.min(Math.floor(requestedAmount), Math.floor(remainingUnits)),
        );

        const makerSide = Number(sourceOrder.side);
        const takerSide: "buy" | "sell" = makerSide === 1 ? "buy" : "sell";
        const actorRole =
          body.actorRole ??
          (takerSide === "buy" ? "quote-maker-0" : "base-maker-0");
        const actorAccount = accountByRole.get(actorRole);
        if (!actorAccount) {
          throw new Error(`Unknown actor role: ${actorRole}`);
        }

        const orderbook = new Orderbook(
          orderbookCodec,
          varaEthApi,
          publicClient,
          market.orderbookAddress,
          TOKEN_DECIMALS,
          TOKEN_DECIMALS,
        ).withSigner(makeSigner(actorAccount));

        const refPrice = fpPriceToNumber(sourceOrder.limitPrice);
        const buyCrossPrice = refPrice + 0.000001;
        const sellCrossPrice = Math.max(0.000001, refPrice - 0.000001);

        const result = await observeExecution(
          orderbook,
          actorAccount.address,
          () =>
            takerSide === "buy"
              ? orderbook.placeBuyImmediateOrCancelOrder(
                  amountBase,
                  buyCrossPrice,
                  false,
                )
              : orderbook.placeSellImmediateOrCancelOrder(
                  amountBase,
                  sellCrossPrice,
                  false,
                ),
        );

        const selectedAfter = await market.orderbook.orderById(BigInt(orderId));
        const selectedRemainingAfter = selectedAfter.exists
          ? selectedAfter.amountBase
          : 0n;
        const selectedAffected =
          !selectedAfter.exists || selectedRemainingAfter < selectedRemainingBefore;
        const didExecute = selectedAffected || result.executed;

        pushRecentAction(market.index, market.orderbookAddress, {
          ts: new Date().toISOString(),
          kind: "take",
          status: didExecute ? "executed" : "failed",
          actorRole,
          side: takerSide,
          amountBase,
          orderId: result.orderId.toString(),
          selectedOrderId: orderId,
          selectedOrderSide: makerSide === 0 ? "buy" : "sell",
          baseDelta: asUnits(result.baseDelta, TOKEN_DECIMALS),
          quoteDelta: asUnits(result.quoteDelta, TOKEN_DECIMALS),
          executionPriceApprox: didExecute
            ? resolveExecutionPriceApprox({
                referencePrice: refPrice,
                deltaPrice: executionPriceFromDeltas(
                  result.baseDelta,
                  result.quoteDelta,
                ),
              })
            : undefined,
          note: selectedAffected
            ? "Selected order was reduced/filled"
            : didExecute
              ? "Trade executed, but selected order not reached (higher-priority levels were matched first)"
              : "No immediate execution observed",
        });

        await refresh();

        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            ok: true,
            market: market.index,
            selectedOrderId: orderId,
            selectedOrderSide: makerSide === 0 ? "buy" : "sell",
            takerSide,
            actorRole,
            amountBase,
            takerOrderId: result.orderId.toString(),
            executed: didExecute,
            selectedAffected,
            selectedRemainingBefore: asUnits(
              selectedRemainingBefore,
              TOKEN_DECIMALS,
            ),
            selectedRemainingAfter: asUnits(
              selectedRemainingAfter,
              TOKEN_DECIMALS,
            ),
            baseDelta: asUnits(result.baseDelta, TOKEN_DECIMALS),
            quoteDelta: asUnits(result.quoteDelta, TOKEN_DECIMALS),
          }),
        );
      } catch (error) {
        const message = (error as Error)?.message ?? String(error);
        logger.warn("Failed to execute selected order", { error: message });
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: message }));
      }
      return;
    }

    if (reqUrl.pathname === "/api/submit-limit-order" && req.method === "POST") {
      try {
        const body = await readJsonBody<SubmitLimitOrderBody>(req);
        const market = markets.find((m) => m.index === Number(body.market));
        if (!market) {
          throw new Error(`Unknown market index: ${body.market}`);
        }

        const side = (body.side ?? "").toLowerCase();
        if (side !== "buy" && side !== "sell") {
          throw new Error("side must be either 'buy' or 'sell'");
        }

        const amountBase = Number(body.amountBase);
        const priceQuotePerBase = Number(body.priceQuotePerBase);
        if (!Number.isFinite(amountBase) || amountBase <= 0) {
          throw new Error("amountBase must be a positive number");
        }
        if (!Number.isFinite(priceQuotePerBase) || priceQuotePerBase <= 0) {
          throw new Error("priceQuotePerBase must be a positive number");
        }

        const actorRole =
          body.actorRole ??
          (side === "buy" ? "quote-maker-0" : "base-maker-0");
        const actorAccount = accountByRole.get(actorRole);
        if (!actorAccount) {
          throw new Error(`Unknown actor role: ${actorRole}`);
        }

        const orderbook = new Orderbook(
          orderbookCodec,
          varaEthApi,
          publicClient,
          market.orderbookAddress,
          TOKEN_DECIMALS,
          TOKEN_DECIMALS,
        ).withSigner(makeSigner(actorAccount));

        const [bestBidBefore, bestAskBefore] = await Promise.all([
          market.orderbook.bestBidPrice().then((x) => BigInt(x)),
          market.orderbook.bestAskPrice().then((x) => BigInt(x)),
        ]);

        const result = await observeExecution(
          orderbook,
          actorAccount.address,
          () =>
            side === "buy"
              ? orderbook.placeBuyLimitOrder(
                  amountBase,
                  priceQuotePerBase,
                  false,
                )
              : orderbook.placeSellLimitOrder(
                  amountBase,
                  priceQuotePerBase,
                  false,
                ),
        );
        const limitMatched =
          side === "buy" ? result.baseDelta > 0n : result.quoteDelta > 0n;
        const bookExecutionReference = side === "buy"
          ? fpPriceToNumber(bestAskBefore)
          : fpPriceToNumber(bestBidBefore);

        pushRecentAction(market.index, market.orderbookAddress, {
          ts: new Date().toISOString(),
          kind: "limit",
          status: limitMatched ? "executed" : "submitted",
          actorRole,
          side,
          amountBase,
          orderId: result.orderId.toString(),
          baseDelta: asUnits(result.baseDelta, TOKEN_DECIMALS),
          quoteDelta: asUnits(result.quoteDelta, TOKEN_DECIMALS),
          executionPriceApprox: limitMatched
            ? resolveExecutionPriceApprox({
                referencePrice:
                  bookExecutionReference > 0
                    ? bookExecutionReference
                    : priceQuotePerBase,
                deltaPrice: executionPriceFromDeltas(
                  result.baseDelta,
                  result.quoteDelta,
                ),
              })
            : undefined,
          note: limitMatched
            ? "Limit matched immediately"
            : "Limit order placed on book",
        });

        await refresh();

        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            ok: true,
            market: market.index,
            side,
            actorRole,
            orderId: result.orderId.toString(),
            amountBase,
            priceQuotePerBase,
            executed: limitMatched,
            baseDelta: asUnits(result.baseDelta, TOKEN_DECIMALS),
            quoteDelta: asUnits(result.quoteDelta, TOKEN_DECIMALS),
          }),
        );
      } catch (error) {
        const message = (error as Error)?.message ?? String(error);
        logger.warn("Failed to submit limit order", { error: message });
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: message }));
      }
      return;
    }

    const unsafePath = reqUrl.pathname === "/" ? "/index.html" : reqUrl.pathname;
    const safePath = path.normalize(unsafePath).replace(/^(\.\.(\/|\\|$))+/, "");
    const filePath = path.join(publicDir, safePath);

    if (!filePath.startsWith(publicDir)) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Forbidden");
      return;
    }

    try {
      const body = await readFile(filePath);
      res.writeHead(200, { "Content-Type": contentType(filePath) });
      res.end(body);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
    }
  });

  server.listen(port, () => {
    logger.info("Demo UI started", {
      url: `http://127.0.0.1:${port}`,
      refreshMs,
      actionHistoryLimit,
      historyFilePath,
      makerAccountsPerSide,
      ordersPerMarket,
      depthLevels,
      openOrdersScanCount,
      tradesPerMarket,
    });
  });

  const onExit = () => {
    void persistActions();
  };
  process.on("beforeExit", onExit);
  process.on("SIGINT", () => {
    void persistActions().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void persistActions().finally(() => process.exit(0));
  });
}

main().catch((error) => {
  logger.error("Demo UI failed to start", { error: String(error) });
  process.exit(1);
});

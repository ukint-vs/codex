import http from "node:http";
import { readFile } from "node:fs/promises";
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
  PublicClient,
  webSocket,
} from "viem";

import { initAccounts, accountsBaseTokensFunded, accountsQuoteTokensFunded } from "../showcase/accounts.js";
import { initCodec, orderbookCodec } from "../showcase/codec.js";
import { config } from "../showcase/config.js";
import { logger } from "../showcase/logger.js";
import { Orderbook } from "../showcase/programs/index.js";
import { actorIdToAddress } from "../showcase/programs/util.js";
import {
  cancelOrder,
  getBalance,
  getCurrencyInfo,
  getDexStatus,
  getMarketOverview,
  getOrderbookDepth,
  getOrderInsight,
  getOrderStatus,
  getPriceRecommendation,
  getWalletOrdersOverview,
  listMarkets,
  listOrders,
  placeOrder,
  smartPlaceOrder,
  watchOrderStatus,
} from "../browser-agent/runtime.js";

const TOKEN_DECIMALS = 6;
const PRICE_DECIMALS = 30;
const DEFAULT_REFRESH_MS = 5000;
const DEFAULT_ORDERS_PER_MARKET = 20;
const DEFAULT_DEPTH_LEVELS = 20;
const DEFAULT_OPEN_ORDERS_SCAN_COUNT = 220;
const DEFAULT_TRADES_PER_MARKET = 300;
const DEFAULT_MAKER_ACCOUNTS_PER_SIDE = 4;
const LOCAL_VALIDATOR_FALLBACK =
  "0x70997970C51812dc3A010C7d01b50e0d17dC79C8" as Address;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");

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

type AgentToolRequest = {
  name: string;
  args?: Record<string, unknown>;
  walletAddress?: string;
};

type ToolResult = {
  ok: boolean;
  data?: unknown;
  message?: string;
  needsConfirmation?: boolean;
};

class CompatEthereumClient {
  public router: Pick<ReturnType<typeof getRouterClient>, "validators">;
  private routerClient: ReturnType<typeof getRouterClient>;
  private fallbackValidators: Address[];
  private signerRef?: ISigner;
  private chainId = 31337;

  constructor(
    private publicClient: PublicClient,
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
const makerAccountsPerSide = Math.max(
  1,
  Number(
    process.env.DEMO_UI_MAKER_ACCOUNTS_PER_SIDE
      ?? DEFAULT_MAKER_ACCOUNTS_PER_SIDE,
  ),
);
const assistantApiKey =
  process.env.DEMO_UI_LLM_API_KEY
  ?? process.env.OPENROUTER_API_KEY
  ?? process.env.OPENAI_API_KEY
  ?? process.env.ANTHROPIC_API_KEY
  ?? "";

const marketActionKey = (marketIndex: number, orderbookAddress: Address): string =>
  `${marketIndex}:${orderbookAddress.toLowerCase()}`;

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

const toolSchema = [
  {
    name: "list_markets",
    description:
      "List all configured DEX markets with marketIndex, symbols, orderbook and vault addresses.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: "get_balance",
    description:
      "Get user balance from Dex vault/orderbook for a wallet address on a selected market.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        walletAddress: { type: "string" },
        marketIndex: { type: "number" },
        scope: { type: "string", enum: ["vault", "orderbook", "both"] },
      },
      required: ["walletAddress"],
    },
  },
  {
    name: "place_order",
    description: "Place an order on Dex. Must be confirmed by user.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        walletAddress: { type: "string" },
        marketIndex: { type: "number" },
        side: { type: "string", enum: ["buy", "sell"] },
        orderType: {
          type: "string",
          enum: ["limit", "market", "fill_or_kill", "immediate_or_cancel"],
        },
        amountBase: { type: "number" },
        priceInQuotePerBase: { type: "number" },
        maxQuoteAmount: { type: "number" },
        confirm: { type: "boolean" },
      },
      required: ["side", "orderType", "amountBase"],
    },
  },
  {
    name: "cancel_order",
    description: "Cancel an order on Dex. Must be confirmed by user.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        walletAddress: { type: "string" },
        marketIndex: { type: "number" },
        orderId: { type: "string" },
        confirm: { type: "boolean" },
      },
      required: ["orderId"],
    },
  },
  {
    name: "get_order_status",
    description:
      "Get order details and status by order id (open, partially filled, filled, closed).",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        orderId: { type: "string" },
        marketIndex: { type: "number" },
      },
      required: ["orderId"],
    },
  },
  {
    name: "list_orders",
    description:
      "List orders with filters by wallet, status, and side. Use this for my open orders, recent orders, or order history queries.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        walletAddress: { type: "string" },
        marketIndex: { type: "number" },
        status: {
          type: "string",
          enum: ["any", "open", "partially_filled", "filled", "closed_or_not_found"],
        },
        side: { type: "string", enum: ["any", "buy", "sell"] },
        maxOrderId: { type: "number" },
        limit: { type: "number" },
      },
    },
  },
  {
    name: "watch_order_status",
    description:
      "Poll an order status until it reaches terminal state (filled/closed) or max polls.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        orderId: { type: "string" },
        marketIndex: { type: "number" },
        intervalMs: { type: "number" },
        maxPolls: { type: "number" },
      },
      required: ["orderId"],
    },
  },
  {
    name: "get_order_insight",
    description:
      "Get complete order details plus analytics (distance to mid-price and market context).",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        orderId: { type: "string" },
        marketIndex: { type: "number" },
      },
      required: ["orderId"],
    },
  },
  {
    name: "get_wallet_orders_overview",
    description:
      "Get complete wallet order summary: counts by status/side, open exposure, and recent orders.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        walletAddress: { type: "string" },
        marketIndex: { type: "number" },
        maxOrderId: { type: "number" },
        maxRows: { type: "number" },
      },
    },
  },
  {
    name: "get_orderbook_depth",
    description:
      "Get aggregated orderbook depth (bids and asks) with configurable levels.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        marketIndex: { type: "number" },
        levels: { type: "number" },
        maxOrderId: { type: "number" },
        maxRows: { type: "number" },
      },
    },
  },
  {
    name: "get_dex_status",
    description:
      "Get full DEX status snapshot: spread, liquidity imbalance, signer balances, and top depth.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        marketIndex: { type: "number" },
        maxOrderId: { type: "number" },
        maxRows: { type: "number" },
        depthLevels: { type: "number" },
      },
    },
  },
  {
    name: "get_market_overview",
    description: "Get top-of-book market data (best bid and best ask) for a selected market.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        marketIndex: { type: "number" },
      },
    },
  },
  {
    name: "get_price_recommendation",
    description:
      "Get recommended order price based on side and strategy using current market quotes.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        marketIndex: { type: "number" },
        side: { type: "string", enum: ["buy", "sell"] },
        strategy: { type: "string", enum: ["passive", "balanced", "aggressive"] },
      },
      required: ["side"],
    },
  },
  {
    name: "smart_place_order",
    description:
      "Place an order using automatic pricing strategy (passive/balanced/aggressive). Requires confirmation.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        walletAddress: { type: "string" },
        marketIndex: { type: "number" },
        side: { type: "string", enum: ["buy", "sell"] },
        amountBase: { type: "number" },
        strategy: { type: "string", enum: ["passive", "balanced", "aggressive"] },
        maxSlippageBps: { type: "number" },
        confirm: { type: "boolean" },
      },
      required: ["side", "amountBase"],
    },
  },
  {
    name: "get_currency_info",
    description:
      "Get currency metadata such as symbols, decimals, and vault/orderbook addresses.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        marketIndex: { type: "number" },
      },
    },
  },
] as const;

const executeTool = async (
  name: string,
  args: Record<string, unknown>,
  walletAddress?: string,
): Promise<ToolResult> => {
  try {
    if (name === "list_markets") {
      return await listMarkets();
    }
    if (name === "get_balance") {
      return await getBalance({
        walletAddress:
          (args.walletAddress as string | undefined) ?? walletAddress ?? "",
        marketIndex:
          typeof args.marketIndex === "number" ? args.marketIndex : undefined,
        scope:
          (args.scope as "vault" | "orderbook" | "both" | undefined) ?? "both",
      });
    }
    if (name === "place_order") {
      return await placeOrder({
        walletAddress: (args.walletAddress as string | undefined) ?? walletAddress,
        marketIndex:
          typeof args.marketIndex === "number" ? args.marketIndex : undefined,
        side: args.side as "buy" | "sell",
        orderType: args.orderType as
          | "limit"
          | "market"
          | "fill_or_kill"
          | "immediate_or_cancel",
        amountBase: Number(args.amountBase),
        priceInQuotePerBase:
          typeof args.priceInQuotePerBase === "number"
            ? args.priceInQuotePerBase
            : undefined,
        maxQuoteAmount:
          typeof args.maxQuoteAmount === "number" ? args.maxQuoteAmount : undefined,
        confirm: Boolean(args.confirm),
      });
    }
    if (name === "cancel_order") {
      return await cancelOrder({
        walletAddress: (args.walletAddress as string | undefined) ?? walletAddress,
        marketIndex:
          typeof args.marketIndex === "number" ? args.marketIndex : undefined,
        orderId: String(args.orderId),
        confirm: Boolean(args.confirm),
      });
    }
    if (name === "get_order_status") {
      return await getOrderStatus({
        orderId: String(args.orderId),
        marketIndex:
          typeof args.marketIndex === "number" ? args.marketIndex : undefined,
      });
    }
    if (name === "list_orders") {
      return await listOrders({
        walletAddress: (args.walletAddress as string | undefined) ?? walletAddress,
        marketIndex:
          typeof args.marketIndex === "number" ? args.marketIndex : undefined,
        status: args.status as
          | "any"
          | "open"
          | "partially_filled"
          | "filled"
          | "closed_or_not_found"
          | undefined,
        side: args.side as "any" | "buy" | "sell" | undefined,
        maxOrderId:
          typeof args.maxOrderId === "number" ? args.maxOrderId : undefined,
        limit: typeof args.limit === "number" ? args.limit : undefined,
      });
    }
    if (name === "watch_order_status") {
      return await watchOrderStatus({
        orderId: String(args.orderId),
        marketIndex:
          typeof args.marketIndex === "number" ? args.marketIndex : undefined,
        intervalMs:
          typeof args.intervalMs === "number" ? args.intervalMs : undefined,
        maxPolls: typeof args.maxPolls === "number" ? args.maxPolls : undefined,
      });
    }
    if (name === "get_order_insight") {
      return await getOrderInsight({
        orderId: String(args.orderId),
        marketIndex:
          typeof args.marketIndex === "number" ? args.marketIndex : undefined,
      });
    }
    if (name === "get_wallet_orders_overview") {
      return await getWalletOrdersOverview({
        walletAddress: (args.walletAddress as string | undefined) ?? walletAddress,
        marketIndex:
          typeof args.marketIndex === "number" ? args.marketIndex : undefined,
        maxOrderId:
          typeof args.maxOrderId === "number" ? args.maxOrderId : undefined,
        maxRows: typeof args.maxRows === "number" ? args.maxRows : undefined,
      });
    }
    if (name === "get_orderbook_depth") {
      return await getOrderbookDepth({
        marketIndex:
          typeof args.marketIndex === "number" ? args.marketIndex : undefined,
        levels: typeof args.levels === "number" ? args.levels : undefined,
        maxOrderId:
          typeof args.maxOrderId === "number" ? args.maxOrderId : undefined,
        maxRows: typeof args.maxRows === "number" ? args.maxRows : undefined,
      });
    }
    if (name === "get_dex_status") {
      return await getDexStatus({
        marketIndex:
          typeof args.marketIndex === "number" ? args.marketIndex : undefined,
        maxOrderId:
          typeof args.maxOrderId === "number" ? args.maxOrderId : undefined,
        maxRows: typeof args.maxRows === "number" ? args.maxRows : undefined,
        depthLevels:
          typeof args.depthLevels === "number" ? args.depthLevels : undefined,
      });
    }
    if (name === "get_market_overview") {
      return await getMarketOverview({
        marketIndex:
          typeof args.marketIndex === "number" ? args.marketIndex : undefined,
      });
    }
    if (name === "get_price_recommendation") {
      return await getPriceRecommendation({
        marketIndex:
          typeof args.marketIndex === "number" ? args.marketIndex : undefined,
        side: args.side as "buy" | "sell",
        strategy: args.strategy as "passive" | "balanced" | "aggressive" | undefined,
      });
    }
    if (name === "smart_place_order") {
      return await smartPlaceOrder({
        walletAddress: (args.walletAddress as string | undefined) ?? walletAddress,
        marketIndex:
          typeof args.marketIndex === "number" ? args.marketIndex : undefined,
        side: args.side as "buy" | "sell",
        amountBase: Number(args.amountBase),
        strategy: args.strategy as "passive" | "balanced" | "aggressive" | undefined,
        maxSlippageBps:
          typeof args.maxSlippageBps === "number" ? args.maxSlippageBps : undefined,
        confirm: Boolean(args.confirm),
      });
    }
    if (name === "get_currency_info") {
      return await getCurrencyInfo({
        marketIndex:
          typeof args.marketIndex === "number" ? args.marketIndex : undefined,
      });
    }

    return { ok: false, message: `Unknown tool: ${name}` };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Tool error",
    };
  }
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
  const runForSigner = createSignerTaskRunner();

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

  const tradeSeenAtByMarket = new Map<string, Map<string, string>>();
  const warnedTradeHistoryUnavailable = new Set<string>();

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
    let baseBefore = 0n;
    let quoteBefore = 0n;
    let baselineAvailable = false;

    try {
      [baseBefore, quoteBefore] = await orderbook.balanceOf(actorAddress);
      baselineAvailable = true;
    } catch (error) {
      logger.warn("Failed to read baseline balance for execution observation", {
        actorAddress,
        error: String(error),
      });
    }

    const orderId = await submit();

    if (!baselineAvailable) {
      return {
        orderId,
        executed: false,
        baseDelta: 0n,
        quoteDelta: 0n,
      };
    }

    let baseAfter = baseBefore;
    let quoteAfter = quoteBefore;

    for (let i = 0; i < 12; i += 1) {
      await sleep(200);
      try {
        const [b, q] = await orderbook.balanceOf(actorAddress);
        baseAfter = b;
        quoteAfter = q;
        if (b !== baseBefore || q !== quoteBefore) break;
      } catch {
        // transient read error while waiting for settlement
      }
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

    if (reqUrl.pathname === "/api/assistant/config") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ apiKey: assistantApiKey.trim() }));
      return;
    }

    if (reqUrl.pathname === "/api/agent/schema") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ tools: toolSchema }));
      return;
    }

    if (reqUrl.pathname === "/api/agent/tool" && req.method === "POST") {
      try {
        const body = await readJsonBody<AgentToolRequest>(req);
        const name = String(body.name ?? "").trim();
        if (!name) {
          throw new Error("Tool name is required");
        }
        const args = (body.args ?? {}) as Record<string, unknown>;
        const result = await executeTool(name, args, body.walletAddress);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(result));
      } catch (error) {
        const message = (error as Error)?.message ?? String(error);
        logger.warn("Failed to execute agent tool", { error: message });
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, message }));
      }
      return;
    }

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

        const maxQuote =
          side === "buy"
            ? Math.max(amountBase, Number(body.maxQuote ?? amountBase * 2))
            : 0;
        const result = await runForSigner(actorAccount.address, async () => {
          const orderbook = new Orderbook(
            orderbookCodec,
            varaEthApi,
            publicClient,
            market.orderbookAddress,
            TOKEN_DECIMALS,
            TOKEN_DECIMALS,
          ).withSigner(makeSigner(actorAccount));

          return observeExecution(
            orderbook,
            actorAccount.address,
            () =>
              side === "buy"
                ? orderbook.placeBuyMarketOrder(amountBase, maxQuote, false)
                : orderbook.placeSellMarketOrder(amountBase, false),
          );
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

        const refPrice = fpPriceToNumber(sourceOrder.limitPrice);
        const buyCrossPrice = refPrice + 0.000001;
        const sellCrossPrice = Math.max(0.000001, refPrice - 0.000001);
        const {
          result,
          selectedRemainingAfter,
          selectedAffected,
          didExecute,
        } = await runForSigner(actorAccount.address, async () => {
          const orderbook = new Orderbook(
            orderbookCodec,
            varaEthApi,
            publicClient,
            market.orderbookAddress,
            TOKEN_DECIMALS,
            TOKEN_DECIMALS,
          ).withSigner(makeSigner(actorAccount));

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

          return {
            result,
            selectedRemainingAfter,
            selectedAffected,
            didExecute: selectedAffected || result.executed,
          };
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

        const result = await runForSigner(actorAccount.address, async () => {
          const orderbook = new Orderbook(
            orderbookCodec,
            varaEthApi,
            publicClient,
            market.orderbookAddress,
            TOKEN_DECIMALS,
            TOKEN_DECIMALS,
          ).withSigner(makeSigner(actorAccount));

          return observeExecution(
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
        });
        const limitMatched =
          side === "buy" ? result.baseDelta > 0n : result.quoteDelta > 0n;

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
      makerAccountsPerSide,
      ordersPerMarket,
      depthLevels,
      openOrdersScanCount,
      tradesPerMarket,
    });
  });
}

main().catch((error) => {
  logger.error("Demo UI failed to start", { error: String(error) });
  process.exit(1);
});

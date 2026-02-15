import "dotenv/config";

import {
  createPublicClient,
  createWalletClient,
  isAddress,
  webSocket,
  type Address,
} from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import {
  EthereumClient,
  type ISigner,
  VaraEthApi,
  WsVaraEthProvider,
} from "@vara-eth/api";
import { walletClientToSigner } from "@vara-eth/api/signer";

import { config } from "../showcase/config.js";
import { initCodec, orderbookCodec, vaultCodec } from "../showcase/codec.js";
import { Orderbook, Vault } from "../showcase/programs/index.js";

type Scope = "vault" | "orderbook" | "both";
type Side = "buy" | "sell";
type OrderType = "limit" | "market" | "fill_or_kill" | "immediate_or_cancel";
type PriceStrategy = "passive" | "balanced" | "aggressive";
type OrderStatus = "open" | "partially_filled" | "filled" | "closed_or_not_found";
type OrderRow = {
  orderId: string;
  owner: Address;
  side: Side;
  status: OrderStatus;
  amountBase: bigint;
  filledBase: bigint;
  remainingBase: bigint;
  limitPriceRaw: bigint;
};

const DEFAULT_PRIVATE_KEY =
  (process.env.PRIVATE_KEY as `0x${string}` | undefined) ??
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const DECIMALS = 6;
const BASE_DECIMALS = 6;
const QUOTE_DECIMALS = 6;
const PRICE_PRECISION = 10n ** 30n;

function pow10(n: number): bigint {
  return 10n ** BigInt(n);
}

function toDisplay(amount: bigint, decimals: number = DECIMALS): string {
  const sign = amount < 0n ? "-" : "";
  const abs = amount < 0n ? -amount : amount;
  const scale = pow10(decimals);
  const whole = abs / scale;
  const frac = abs % scale;
  return `${sign}${whole.toString()}.${frac.toString().padStart(decimals, "0")}`;
}

function toDecimalString(
  numerator: bigint,
  denominator: bigint,
  precision: number = 8,
): string {
  if (denominator === 0n) return "0";
  const whole = numerator / denominator;
  let rem = numerator % denominator;
  let frac = "";
  for (let i = 0; i < precision; i += 1) {
    rem *= 10n;
    const d = rem / denominator;
    rem %= denominator;
    frac += d.toString();
  }
  return `${whole.toString()}.${frac}`;
}

function fixedPriceToQuotePerBase(limitPrice: bigint): string {
  // inverse of calculateLimitPrice():
  // limit = quoteAtoms * 1e30 / baseUnit
  // quotePerBase = limit * baseUnit / 1e30 / quoteUnit
  const numerator = limitPrice * pow10(BASE_DECIMALS);
  const denominator = PRICE_PRECISION * pow10(QUOTE_DECIMALS);
  return toDecimalString(numerator, denominator, 8);
}

function quotePerBaseToLimitPrice(price: number): bigint {
  const quoteAtoms = BigInt(Math.floor(price * 10 ** QUOTE_DECIMALS));
  const baseUnit = pow10(BASE_DECIMALS);
  return (quoteAtoms * PRICE_PRECISION) / baseUnit;
}

function shiftByBps(value: bigint, bps: number): bigint {
  return (value * BigInt(10_000 + bps)) / 10_000n;
}

function classifyOrderStatus(order: {
  exists: boolean;
  amountBase: bigint;
  filledBase: bigint;
}): OrderStatus {
  if (!order.exists) return "closed_or_not_found";
  if (order.amountBase <= 0n) return "open";
  if (order.filledBase >= order.amountBase) return "filled";
  if (order.filledBase > 0n) return "partially_filled";
  return "open";
}

function toOrderRow(order: {
  id: bigint;
  owner: Address;
  side: number;
  amountBase: bigint;
  filledBase: bigint;
  limitPrice: bigint;
  exists: boolean;
}): OrderRow {
  const remainingBase =
    order.amountBase > order.filledBase ? order.amountBase - order.filledBase : 0n;
  return {
    orderId: order.id.toString(),
    owner: order.owner,
    side: order.side === 0 ? "buy" : "sell",
    status: classifyOrderStatus(order),
    amountBase: order.amountBase,
    filledBase: order.filledBase,
    remainingBase,
    limitPriceRaw: order.limitPrice,
  };
}

async function scanExistingOrders(input?: {
  marketIndex?: number;
  maxOrderId?: number;
  maxRows?: number;
  walletAddress?: Address;
}): Promise<OrderRow[]> {
  const market = await resolveMarket(input?.marketIndex);
  const orderbook = market.orderbook;
  const maxOrderId = Math.max(
    1,
    Math.floor(
      input?.maxOrderId ??
        Number(process.env.BROWSER_AGENT_SCAN_MAX_ORDER_ID ?? 500),
    ),
  );
  const maxRows = Math.max(1, Math.min(5000, Math.floor(input?.maxRows ?? 1000)));
  const wallet = input?.walletAddress?.toLowerCase();

  const rows: OrderRow[] = [];
  for (let id = maxOrderId; id >= 1 && rows.length < maxRows; id -= 1) {
    const raw = await orderbook.orderById(BigInt(id));
    if (!raw.exists) continue;
    if (wallet && String(raw.owner).toLowerCase() !== wallet) continue;
    rows.push(toOrderRow(raw));
  }
  return rows;
}

function aggregateDepth(rows: OrderRow[], levels: number) {
  const asks = new Map<bigint, { size: bigint; orders: number }>();
  const bids = new Map<bigint, { size: bigint; orders: number }>();
  for (const row of rows) {
    if (row.status !== "open" && row.status !== "partially_filled") continue;
    if (row.remainingBase <= 0n) continue;
    const book = row.side === "sell" ? asks : bids;
    const cur = book.get(row.limitPriceRaw) ?? { size: 0n, orders: 0 };
    cur.size += row.remainingBase;
    cur.orders += 1;
    book.set(row.limitPriceRaw, cur);
  }

  const toLevels = (
    book: Map<bigint, { size: bigint; orders: number }>,
    ascending: boolean,
  ) =>
    [...book.entries()]
      .sort((a, b) => {
        if (a[0] === b[0]) return 0;
        return ascending ? (a[0] < b[0] ? -1 : 1) : (a[0] > b[0] ? -1 : 1);
      })
      .slice(0, levels)
      .map(([priceRaw, level]) => ({
        price: fixedPriceToQuotePerBase(priceRaw),
        sizeBase: toDisplay(level.size, BASE_DECIMALS),
        orders: level.orders,
        raw: {
          price: priceRaw.toString(),
          sizeBase: level.size.toString(),
        },
      }));

  return {
    asks: toLevels(asks, true),
    bids: toLevels(bids, false),
  };
}

type RuntimeState = {
  markets: Array<{
    index: number;
    orderbookAddress: Address;
    baseVaultAddress: Address;
    quoteVaultAddress: Address;
    baseSymbol: string;
    quoteSymbol: string;
    baseTokenId: string;
    quoteTokenId: string;
    orderbook: Orderbook;
    baseVault: Vault;
    quoteVault: Vault;
  }>;
  defaultMarketIndex: number;
  orderbook: Orderbook;
  baseVault: Vault;
  quoteVault: Vault;
  adminSigner: ISigner;
  adminAddress: Address;
  makerSigner: ISigner;
  makerAddress: Address;
  takerSigner: ISigner;
  takerAddress: Address;
};

let statePromise: Promise<RuntimeState> | undefined;

async function getState(): Promise<RuntimeState> {
  if (statePromise) return statePromise;
  statePromise = (async () => {
    const ethTransport = webSocket(config.transports.ethereumWs);
    const publicClient = createPublicClient({ transport: ethTransport });

    const adminAccount = privateKeyToAccount(DEFAULT_PRIVATE_KEY);
    const adminWalletClient = createWalletClient({
      account: adminAccount,
      transport: ethTransport,
    });
    const adminSigner: ISigner = walletClientToSigner(adminWalletClient);
    const adminAddress = (await adminSigner.getAddress()) as Address;

    const makerAccount = mnemonicToAccount(
      config.accounts.mnemonicForAccountDerivation,
      { path: "m/44'/60'/0'/0/1" },
    );
    const makerWalletClient = createWalletClient({
      account: makerAccount,
      transport: ethTransport,
    });
    const makerSigner: ISigner = walletClientToSigner(makerWalletClient);
    const makerAddress = (await makerSigner.getAddress()) as Address;

    const takerSigner = adminSigner;
    const takerAddress = adminAddress;

    await initCodec();

    const ethClient = new EthereumClient(publicClient, config.contracts.router);
    const varaEthApi = new VaraEthApi(
      new WsVaraEthProvider(config.transports.varaEthWsRpc),
      ethClient,
    );

    const markets = config.contracts.markets.map((market, index) => ({
      index,
      orderbookAddress: market.orderbook,
      baseVaultAddress: market.baseTokenVault,
      quoteVaultAddress: market.quoteTokenVault,
      baseSymbol: (market.baseSymbol ?? `BASE${index}`).toUpperCase(),
      quoteSymbol: (market.quoteSymbol ?? "QUOTE").toUpperCase(),
      baseTokenId: market.baseTokenId,
      quoteTokenId: market.quoteTokenId,
      orderbook: new Orderbook(
        orderbookCodec,
        varaEthApi,
        publicClient,
        market.orderbook,
        6,
        6,
      ),
      baseVault: new Vault(
        vaultCodec,
        varaEthApi,
        publicClient,
        market.baseTokenVault,
        6,
      ),
      quoteVault: new Vault(
        vaultCodec,
        varaEthApi,
        publicClient,
        market.quoteTokenVault,
        6,
      ),
    }));
    const defaultMarketIndex = 0;
    const primaryMarket = markets[defaultMarketIndex];

    return {
      markets,
      defaultMarketIndex,
      orderbook: primaryMarket.orderbook,
      baseVault: primaryMarket.baseVault,
      quoteVault: primaryMarket.quoteVault,
      adminSigner,
      adminAddress,
      makerSigner,
      makerAddress,
      takerSigner,
      takerAddress,
    };
  })();

  return statePromise;
}

function requireAddress(value: string): Address {
  if (!isAddress(value)) {
    throw new Error("Invalid wallet address.");
  }
  return value as Address;
}

function parseMarketIndex(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.floor(n);
}

async function resolveMarket(marketIndex?: number) {
  const state = await getState();
  const index = marketIndex ?? state.defaultMarketIndex;
  const market = state.markets.find((m) => m.index === index);
  if (!market) {
    throw new Error(
      `Unknown marketIndex ${index}. Available market indices: ${state.markets.map((m) => m.index).join(", ")}`,
    );
  }
  return market;
}

export async function getBalance(input: {
  walletAddress: string;
  scope?: Scope;
  marketIndex?: number;
}) {
  const market = await resolveMarket(parseMarketIndex(input.marketIndex));
  const { orderbook, baseVault, quoteVault } = market;
  const walletAddress = requireAddress(input.walletAddress);
  const scope = input.scope ?? "both";
  const data: Record<string, unknown> = {
    walletAddress,
    scope,
    marketIndex: market.index,
    market: {
      index: market.index,
      orderbookAddress: market.orderbookAddress,
      baseVaultAddress: market.baseVaultAddress,
      quoteVaultAddress: market.quoteVaultAddress,
      baseSymbol: market.baseSymbol,
      quoteSymbol: market.quoteSymbol,
    },
  };
  const errors: Record<string, string> = {};
  let hasSuccess = false;

  if (scope === "vault" || scope === "both") {
    try {
      const [baseAvailable, baseReserved] = await baseVault.getBalance(walletAddress);
      const [quoteAvailable, quoteReserved] = await quoteVault.getBalance(
        walletAddress,
      );
      data.vault = {
        base: {
          available: toDisplay(baseAvailable),
          reserved: toDisplay(baseReserved),
        },
        quote: {
          available: toDisplay(quoteAvailable),
          reserved: toDisplay(quoteReserved),
        },
      };
      hasSuccess = true;
    } catch (error) {
      errors.vault = error instanceof Error ? error.message : "Unknown vault error";
    }
  }

  if (scope === "orderbook" || scope === "both") {
    try {
      const [base, quote] = await orderbook.balanceOf(walletAddress);
      data.orderbook = {
        base: toDisplay(base),
        quote: toDisplay(quote),
      };
      hasSuccess = true;
    } catch (error) {
      errors.orderbook =
        error instanceof Error ? error.message : "Unknown orderbook error";
    }
  }

  if (Object.keys(errors).length > 0) data.errors = errors;

  return {
    ok: hasSuccess,
    data,
  };
}

export async function placeOrder(input: {
  walletAddress?: string;
  marketIndex?: number;
  side: Side;
  orderType: OrderType;
  amountBase: number;
  priceInQuotePerBase?: number;
  maxQuoteAmount?: number;
  confirm?: boolean;
}) {
  const { takerSigner, takerAddress } = await getState();
  const market = await resolveMarket(parseMarketIndex(input.marketIndex));
  const orderbook = market.orderbook;
  const confirm = Boolean(input.confirm);
  if (!confirm) {
    return {
      ok: false,
      needsConfirmation: true,
      data: {
        ...input,
        signerAddress: takerAddress,
        marketIndex: market.index,
        orderbookAddress: market.orderbookAddress,
      },
      message: "Order requires confirmation.",
    };
  }

  if (input.walletAddress && isAddress(input.walletAddress)) {
    const requested = input.walletAddress.toLowerCase();
    const signerAddr = takerAddress.toLowerCase();
    if (requested !== signerAddr) {
      return {
        ok: false,
        data: {
          requestedWallet: input.walletAddress,
          signerAddress: takerAddress,
        },
        message:
          "Server signer differs from requested walletAddress. Connect that wallet in app backend or use signer wallet.",
      };
    }
  }

  const scopedOrderbook = orderbook.withSigner(takerSigner);
  const [baseBefore, quoteBefore] = await scopedOrderbook.balanceOf(takerAddress);
  let orderId: bigint;
  if (
    (input.orderType === "limit" ||
      input.orderType === "fill_or_kill" ||
      input.orderType === "immediate_or_cancel") &&
    typeof input.priceInQuotePerBase !== "number"
  ) {
    throw new Error("priceInQuotePerBase is required for limit orders.");
  }
  if (
    input.side === "buy" &&
    input.orderType === "market" &&
    typeof input.maxQuoteAmount !== "number"
  ) {
    throw new Error("maxQuoteAmount is required for buy market orders.");
  }

  if (input.side === "buy" && input.orderType === "market") {
    orderId = await scopedOrderbook.placeBuyMarketOrder(
      input.amountBase,
      input.maxQuoteAmount!,
      false,
    );
  } else if (input.side === "sell" && input.orderType === "market") {
    orderId = await scopedOrderbook.placeSellMarketOrder(input.amountBase, false);
  } else if (input.side === "buy" && input.orderType === "limit") {
    orderId = await scopedOrderbook.placeBuyLimitOrder(
      input.amountBase,
      input.priceInQuotePerBase!,
      false,
    );
  } else if (input.side === "buy" && input.orderType === "fill_or_kill") {
    orderId = await scopedOrderbook.placeBuyFillOrKillOrder(
      input.amountBase,
      input.priceInQuotePerBase!,
    );
  } else if (input.side === "sell" && input.orderType === "fill_or_kill") {
    orderId = await scopedOrderbook.placeSellFillOrKillOrder(
      input.amountBase,
      input.priceInQuotePerBase!,
    );
  } else if (input.side === "buy" && input.orderType === "immediate_or_cancel") {
    orderId = await scopedOrderbook.placeBuyImmediateOrCancelOrder(
      input.amountBase,
      input.priceInQuotePerBase!,
      false,
    );
  } else if (input.side === "sell" && input.orderType === "immediate_or_cancel") {
    orderId = await scopedOrderbook.placeSellImmediateOrCancelOrder(
      input.amountBase,
      input.priceInQuotePerBase!,
      false,
    );
  } else {
    orderId = await scopedOrderbook.placeSellLimitOrder(
      input.amountBase,
      input.priceInQuotePerBase!,
      false,
    );
  }

  const order = await scopedOrderbook.orderById(orderId);
  const status = classifyOrderStatus(order);
  const remaining =
    order.amountBase > order.filledBase ? order.amountBase - order.filledBase : 0n;
  const [baseAfter, quoteAfter] = await scopedOrderbook.balanceOf(takerAddress);
  const baseDelta = baseAfter - baseBefore;
  const quoteDelta = quoteAfter - quoteBefore;
  const hadExecutionImpact = baseDelta !== 0n || quoteDelta !== 0n;

  let inferredOutcome:
    | "resting_or_pending"
    | "partially_filled"
    | "filled"
    | "likely_executed_or_canceled"
    | "terminal_unknown_no_balance_change";

  if (status === "filled") inferredOutcome = "filled";
  else if (status === "partially_filled") inferredOutcome = "partially_filled";
  else if (status === "open") inferredOutcome = "resting_or_pending";
  else if (hadExecutionImpact) inferredOutcome = "likely_executed_or_canceled";
  else inferredOutcome = "terminal_unknown_no_balance_change";

  return {
    ok: true,
    data: {
      orderId: orderId.toString(),
      signerAddress: takerAddress,
      marketIndex: market.index,
      orderbookAddress: market.orderbookAddress,
      status,
      inferredOutcome,
      statusDetail: {
        exists: order.exists,
        side: order.side === 0 ? "buy" : "sell",
        amountBase:
          status === "closed_or_not_found"
            ? null
            : toDisplay(order.amountBase, BASE_DECIMALS),
        filledBase:
          status === "closed_or_not_found"
            ? null
            : toDisplay(order.filledBase, BASE_DECIMALS),
        remainingBase:
          status === "closed_or_not_found"
            ? null
            : toDisplay(remaining, BASE_DECIMALS),
        limitPrice:
          status === "closed_or_not_found"
            ? null
            : fixedPriceToQuotePerBase(order.limitPrice),
        note:
          status === "closed_or_not_found"
            ? "Order is terminal or no longer available in active storage; detailed fill fields are unavailable from direct lookup."
            : undefined,
      },
      executionImpact: {
        hadExecutionImpact,
        baseBefore: toDisplay(baseBefore, BASE_DECIMALS),
        quoteBefore: toDisplay(quoteBefore, QUOTE_DECIMALS),
        baseAfter: toDisplay(baseAfter, BASE_DECIMALS),
        quoteAfter: toDisplay(quoteAfter, QUOTE_DECIMALS),
        deltaBase: toDisplay(baseDelta, BASE_DECIMALS),
        deltaQuote: toDisplay(quoteDelta, QUOTE_DECIMALS),
        raw: {
          baseDelta: baseDelta.toString(),
          quoteDelta: quoteDelta.toString(),
        },
      },
      ...input,
    },
  };
}

export async function getOrderStatus(input: {
  orderId: string;
  marketIndex?: number;
}) {
  const market = await resolveMarket(parseMarketIndex(input.marketIndex));
  const orderbook = market.orderbook;
  const orderId = BigInt(input.orderId);
  const order = await orderbook.orderById(orderId);

  const total = order.amountBase;
  const filled = order.filledBase;
  const remaining = total > filled ? total - filled : 0n;
  const status = classifyOrderStatus(order);

  return {
    ok: true,
    data: {
      orderId: input.orderId,
      marketIndex: market.index,
      orderbookAddress: market.orderbookAddress,
      exists: order.exists,
      owner: order.owner,
      side: order.side === 0 ? "buy" : "sell",
      amountBase:
        status === "closed_or_not_found"
          ? null
          : toDisplay(order.amountBase, BASE_DECIMALS),
      filledBase:
        status === "closed_or_not_found"
          ? null
          : toDisplay(order.filledBase, BASE_DECIMALS),
      remainingBase:
        status === "closed_or_not_found"
          ? null
          : toDisplay(remaining, BASE_DECIMALS),
      limitPrice:
        status === "closed_or_not_found"
          ? null
          : fixedPriceToQuotePerBase(order.limitPrice),
      raw: {
        amountBase:
          status === "closed_or_not_found" ? null : order.amountBase.toString(),
        filledBase:
          status === "closed_or_not_found" ? null : order.filledBase.toString(),
        remainingBase:
          status === "closed_or_not_found" ? null : remaining.toString(),
        limitPrice:
          status === "closed_or_not_found" ? null : order.limitPrice.toString(),
      },
      status,
      note:
        status === "closed_or_not_found"
          ? "Order is terminal or no longer available in active storage. Use balances and recent activity to infer final execution outcome."
          : undefined,
    },
  };
}

export async function listOrders(input?: {
  walletAddress?: string;
  marketIndex?: number;
  status?: OrderStatus | "any";
  side?: Side | "any";
  maxOrderId?: number;
  limit?: number;
}) {
  const { takerAddress } = await getState();
  const market = await resolveMarket(parseMarketIndex(input?.marketIndex));
  const orderbook = market.orderbook;
  const statusFilter = input?.status ?? "any";
  const sideFilter = input?.side ?? "any";
  const walletAddress = input?.walletAddress
    ? requireAddress(input.walletAddress)
    : undefined;
  const maxOrderId = Math.max(
    1,
    Math.floor(
      input?.maxOrderId ??
        Number(process.env.BROWSER_AGENT_SCAN_MAX_ORDER_ID ?? 500),
    ),
  );
  const limit = Math.max(1, Math.min(200, Math.floor(input?.limit ?? 30)));

  const orders: Array<Record<string, unknown>> = [];
  for (let id = maxOrderId; id >= 1 && orders.length < limit; id -= 1) {
    const row = await orderbook.orderById(BigInt(id));
    const status = classifyOrderStatus(row);
    const side = row.side === 0 ? "buy" : "sell";
    const owner = String(row.owner).toLowerCase() as Address;
    if (walletAddress && owner !== walletAddress.toLowerCase()) continue;
    if (statusFilter !== "any" && status !== statusFilter) continue;
    if (sideFilter !== "any" && side !== sideFilter) continue;

    const remaining = row.amountBase > row.filledBase ? row.amountBase - row.filledBase : 0n;
    orders.push({
      orderId: row.id.toString(),
      owner: row.owner,
      side,
      status,
      amountBase: toDisplay(row.amountBase, BASE_DECIMALS),
      filledBase: toDisplay(row.filledBase, BASE_DECIMALS),
      remainingBase: toDisplay(remaining, BASE_DECIMALS),
      limitPrice: fixedPriceToQuotePerBase(row.limitPrice),
      raw: {
        amountBase: row.amountBase.toString(),
        filledBase: row.filledBase.toString(),
        remainingBase: remaining.toString(),
        limitPrice: row.limitPrice.toString(),
      },
    });
  }

  return {
    ok: true,
    data: {
      walletAddress: walletAddress ?? takerAddress,
      marketIndex: market.index,
      orderbookAddress: market.orderbookAddress,
      statusFilter,
      sideFilter,
      scannedMaxOrderId: maxOrderId,
      returned: orders.length,
      orders,
    },
  };
}

export async function watchOrderStatus(input: {
  orderId: string;
  marketIndex?: number;
  intervalMs?: number;
  maxPolls?: number;
}) {
  const market = await resolveMarket(parseMarketIndex(input.marketIndex));
  const intervalMs = Math.max(200, Math.floor(input.intervalMs ?? 1500));
  const maxPolls = Math.max(1, Math.min(120, Math.floor(input.maxPolls ?? 20)));
  const history: Array<Record<string, unknown>> = [];
  let finalStatus: OrderStatus = "closed_or_not_found";

  for (let i = 0; i < maxPolls; i += 1) {
    const snap = await getOrderStatus({
      orderId: input.orderId,
      marketIndex: market.index,
    });
    const data = (snap.data ?? {}) as Record<string, unknown>;
    const status = (data.status as OrderStatus | undefined) ?? "closed_or_not_found";
    finalStatus = status;
    history.push({
      poll: i + 1,
      ts: new Date().toISOString(),
      status,
      filledBase: data.filledBase ?? null,
      remainingBase: data.remainingBase ?? null,
      exists: data.exists ?? false,
    });

    if (status === "filled" || status === "closed_or_not_found") break;
    if (i < maxPolls - 1) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  return {
    ok: true,
    data: {
      orderId: input.orderId,
      marketIndex: market.index,
      finalStatus,
      polls: history.length,
      intervalMs,
      history,
    },
  };
}

export async function getOrderbookDepth(input?: {
  marketIndex?: number;
  levels?: number;
  maxOrderId?: number;
  maxRows?: number;
}) {
  const market = await resolveMarket(parseMarketIndex(input?.marketIndex));
  const levels = Math.max(1, Math.min(200, Math.floor(input?.levels ?? 20)));
  const rows = await scanExistingOrders({
    marketIndex: market.index,
    maxOrderId: input?.maxOrderId,
    maxRows: input?.maxRows ?? 2000,
  });
  const depth = aggregateDepth(rows, levels);

  return {
    ok: true,
    data: {
      marketIndex: market.index,
      orderbookAddress: market.orderbookAddress,
      levels,
      scannedOrders: rows.length,
      depth,
    },
  };
}

export async function getWalletOrdersOverview(input?: {
  walletAddress?: string;
  marketIndex?: number;
  maxOrderId?: number;
  maxRows?: number;
}) {
  const { takerAddress } = await getState();
  const market = await resolveMarket(parseMarketIndex(input?.marketIndex));
  const walletAddress = input?.walletAddress
    ? requireAddress(input.walletAddress)
    : takerAddress;
  const rows = await scanExistingOrders({
    marketIndex: market.index,
    walletAddress,
    maxOrderId: input?.maxOrderId,
    maxRows: input?.maxRows ?? 2000,
  });

  const byStatus: Record<string, number> = {};
  const bySide: Record<string, number> = {};
  let openBaseRaw = 0n;
  let filledBaseRaw = 0n;
  let openNotionalRaw = 0n;

  for (const row of rows) {
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    bySide[row.side] = (bySide[row.side] ?? 0) + 1;
    filledBaseRaw += row.filledBase;
    if (row.status === "open" || row.status === "partially_filled") {
      openBaseRaw += row.remainingBase;
      openNotionalRaw +=
        (row.remainingBase * row.limitPriceRaw) / PRICE_PRECISION;
    }
  }

  return {
    ok: true,
    data: {
      walletAddress,
      marketIndex: market.index,
      orderbookAddress: market.orderbookAddress,
      discoveredOrders: rows.length,
      counts: {
        byStatus,
        bySide,
      },
      totals: {
        openBase: toDisplay(openBaseRaw, BASE_DECIMALS),
        filledBase: toDisplay(filledBaseRaw, BASE_DECIMALS),
        openNotionalQuote: toDisplay(openNotionalRaw, QUOTE_DECIMALS),
      },
      recentOrders: rows.slice(0, 20).map((row) => ({
        orderId: row.orderId,
        side: row.side,
        status: row.status,
        amountBase: toDisplay(row.amountBase, BASE_DECIMALS),
        filledBase: toDisplay(row.filledBase, BASE_DECIMALS),
        remainingBase: toDisplay(row.remainingBase, BASE_DECIMALS),
        limitPrice: fixedPriceToQuotePerBase(row.limitPriceRaw),
      })),
    },
  };
}

export async function getDexStatus(input?: {
  marketIndex?: number;
  maxOrderId?: number;
  maxRows?: number;
  depthLevels?: number;
}) {
  const { takerAddress } = await getState();
  const marketRef = await resolveMarket(parseMarketIndex(input?.marketIndex));
  const [marketOverview, balances, rows] = await Promise.all([
    getMarketOverview({ marketIndex: marketRef.index }),
    getBalance({ walletAddress: takerAddress, scope: "both", marketIndex: marketRef.index }),
    scanExistingOrders({
      marketIndex: marketRef.index,
      maxOrderId: input?.maxOrderId,
      maxRows: input?.maxRows ?? 2000,
    }),
  ]);
  const levels = Math.max(1, Math.min(100, Math.floor(input?.depthLevels ?? 10)));
  const depth = aggregateDepth(rows, levels);

  let buyOpen = 0n;
  let sellOpen = 0n;
  for (const row of rows) {
    if (row.status !== "open" && row.status !== "partially_filled") continue;
    if (row.side === "buy") buyOpen += row.remainingBase;
    else sellOpen += row.remainingBase;
  }
  const totalOpen = buyOpen + sellOpen;
  const imbalancePct =
    totalOpen > 0n ? Number((buyOpen * 10_000n) / totalOpen) / 100 : null;

  const bestBid = (marketOverview.data as Record<string, unknown>)?.bestBid ?? null;
  const bestAsk = (marketOverview.data as Record<string, unknown>)?.bestAsk ?? null;
  const spreadBps = (marketOverview.data as Record<string, unknown>)?.spreadBps ?? null;

  return {
    ok: true,
    data: {
      timestamp: new Date().toISOString(),
      marketIndex: marketRef.index,
      orderbookAddress: marketRef.orderbookAddress,
      market: {
        bestBid,
        bestAsk,
        spreadBps,
        hasBid: bestBid !== null,
        hasAsk: bestAsk !== null,
        isTwoSided: bestBid !== null && bestAsk !== null,
      },
      liquidity: {
        openBuyBase: toDisplay(buyOpen, BASE_DECIMALS),
        openSellBase: toDisplay(sellOpen, BASE_DECIMALS),
        imbalanceBuyPct: imbalancePct,
        discoveredOpenOrders: rows.filter(
          (row) => row.status === "open" || row.status === "partially_filled",
        ).length,
      },
      signerBalances: balances.data,
      depthTop: depth,
    },
  };
}

export async function getOrderInsight(input: {
  orderId: string;
  marketIndex?: number;
}) {
  const marketRef = await resolveMarket(parseMarketIndex(input.marketIndex));
  const [status, market] = await Promise.all([
    getOrderStatus({ orderId: input.orderId, marketIndex: marketRef.index }),
    getMarketOverview({ marketIndex: marketRef.index }),
  ]);
  const data = (status.data ?? {}) as Record<string, unknown>;
  const marketData = (market.data ?? {}) as Record<string, unknown>;
  const limitPrice = Number.parseFloat(String(data.limitPrice ?? "NaN"));
  const midPrice = Number.parseFloat(String(marketData.midPrice ?? "NaN"));
  let distanceBps: number | null = null;
  if (Number.isFinite(limitPrice) && Number.isFinite(midPrice) && midPrice > 0) {
    distanceBps = ((limitPrice - midPrice) / midPrice) * 10_000;
  }

  return {
    ok: true,
    data: {
      ...data,
      market: marketData,
      analytics: {
        distanceFromMidBps: distanceBps,
        isMarketTwoSided:
          marketData.bestBid !== null && marketData.bestAsk !== null,
      },
    },
  };
}

export async function getMarketOverview(input?: { marketIndex?: number }) {
  const market = await resolveMarket(parseMarketIndex(input?.marketIndex));
  const orderbook = market.orderbook;
  const bestBidRaw = await orderbook.bestBidPrice();
  const bestAskRaw = await orderbook.bestAskPrice();

  const bestBid = bestBidRaw ? BigInt(String(bestBidRaw)) : null;
  const bestAsk = bestAskRaw ? BigInt(String(bestAskRaw)) : null;
  const mid =
    bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2n : null;
  const spreadBps =
    bestBid !== null && bestAsk !== null && bestBid > 0n
      ? Number(((bestAsk - bestBid) * 10_000n) / bestBid)
      : null;

  return {
    ok: true,
    data: {
      marketIndex: market.index,
      orderbookAddress: market.orderbookAddress,
      bestBid: bestBid ? fixedPriceToQuotePerBase(bestBid) : null,
      bestAsk: bestAsk ? fixedPriceToQuotePerBase(bestAsk) : null,
      midPrice: mid ? fixedPriceToQuotePerBase(mid) : null,
      spreadBps,
      raw: {
        bestBid: bestBid ? bestBid.toString() : null,
        bestAsk: bestAsk ? bestAsk.toString() : null,
      },
    },
  };
}

export async function getPriceRecommendation(input: {
  marketIndex?: number;
  side: Side;
  strategy?: PriceStrategy;
}) {
  const marketRef = await resolveMarket(parseMarketIndex(input.marketIndex));
  const orderbook = marketRef.orderbook;
  const strategy: PriceStrategy = input.strategy ?? "balanced";

  const bestBidRaw = await orderbook.bestBidPrice();
  const bestAskRaw = await orderbook.bestAskPrice();
  const bestBid = bestBidRaw ? BigInt(String(bestBidRaw)) : null;
  const bestAsk = bestAskRaw ? BigInt(String(bestAskRaw)) : null;

  if (bestBid === null && bestAsk === null) {
    return {
      ok: false,
      message: "No market quotes available yet.",
      data: null,
    };
  }

  let recommended: bigint;
  let reason = "";
  if (input.side === "buy") {
    if (strategy === "aggressive" && bestAsk !== null) {
      recommended = bestAsk;
      reason = "Crosses current best ask for fastest execution.";
    } else if (strategy === "passive" && bestBid !== null) {
      recommended = shiftByBps(bestBid, -5);
      reason = "Near best bid to reduce price paid.";
    } else if (bestBid !== null && bestAsk !== null) {
      recommended = (bestBid + bestAsk) / 2n;
      reason = "Midpoint between best bid and ask.";
    } else {
      recommended = bestAsk ?? bestBid!;
      reason = "Single-sided book fallback.";
    }
  } else {
    if (strategy === "aggressive" && bestBid !== null) {
      recommended = bestBid;
      reason = "Crosses current best bid for fastest execution.";
    } else if (strategy === "passive" && bestAsk !== null) {
      recommended = shiftByBps(bestAsk, 5);
      reason = "Near best ask to improve sell price.";
    } else if (bestBid !== null && bestAsk !== null) {
      recommended = (bestBid + bestAsk) / 2n;
      reason = "Midpoint between best bid and ask.";
    } else {
      recommended = bestBid ?? bestAsk!;
      reason = "Single-sided book fallback.";
    }
  }

  return {
    ok: true,
    data: {
      side: input.side,
      marketIndex: marketRef.index,
      orderbookAddress: marketRef.orderbookAddress,
      strategy,
      recommendedPrice: fixedPriceToQuotePerBase(recommended),
      reason,
      market: {
        bestBid: bestBid ? fixedPriceToQuotePerBase(bestBid) : null,
        bestAsk: bestAsk ? fixedPriceToQuotePerBase(bestAsk) : null,
      },
    },
  };
}

export async function smartPlaceOrder(input: {
  walletAddress?: string;
  marketIndex?: number;
  side: Side;
  amountBase: number;
  strategy?: PriceStrategy;
  maxSlippageBps?: number;
  confirm?: boolean;
}) {
  const strategy: PriceStrategy = input.strategy ?? "balanced";
  const recommendation = await getPriceRecommendation({
    marketIndex: parseMarketIndex(input.marketIndex),
    side: input.side,
    strategy,
  });
  if (!recommendation.ok || !recommendation.data) {
    return {
      ok: false,
      message: "Could not compute price recommendation.",
      data: recommendation.data ?? null,
    };
  }

  const rec = recommendation.data as {
    recommendedPrice: string;
  };
  const price = Number(rec.recommendedPrice);
  const slippage = input.maxSlippageBps ?? 100;

  if (strategy === "aggressive") {
    if (input.side === "buy") {
      const maxQuote = Math.ceil(
        input.amountBase * price * (1 + slippage / 10_000),
      );
      return placeOrder({
        walletAddress: input.walletAddress,
        marketIndex: parseMarketIndex(input.marketIndex),
        side: "buy",
        orderType: "market",
        amountBase: input.amountBase,
        maxQuoteAmount: maxQuote,
        confirm: input.confirm,
      });
    }

    return placeOrder({
      walletAddress: input.walletAddress,
      marketIndex: parseMarketIndex(input.marketIndex),
      side: "sell",
      orderType: "market",
      amountBase: input.amountBase,
      confirm: input.confirm,
    });
  }

  return placeOrder({
    walletAddress: input.walletAddress,
    marketIndex: parseMarketIndex(input.marketIndex),
    side: input.side,
    orderType: "limit",
    amountBase: input.amountBase,
    priceInQuotePerBase: price,
    confirm: input.confirm,
  });
}

export async function listMarkets() {
  const { markets, defaultMarketIndex } = await getState();
  return {
    ok: true,
    data: {
      defaultMarketIndex,
      count: markets.length,
      markets: markets.map((market) => ({
        index: market.index,
        baseSymbol: market.baseSymbol,
        quoteSymbol: market.quoteSymbol,
        baseTokenId: market.baseTokenId,
        quoteTokenId: market.quoteTokenId,
        orderbookAddress: market.orderbookAddress,
        baseVaultAddress: market.baseVaultAddress,
        quoteVaultAddress: market.quoteVaultAddress,
      })),
    },
  };
}

export async function getCurrencyInfo(input?: { marketIndex?: number }) {
  const { markets } = await getState();
  const requestedMarket = await resolveMarket(parseMarketIndex(input?.marketIndex));
  return {
    ok: true,
    data: {
      marketIndex: requestedMarket.index,
      base: {
        symbol: requestedMarket.baseSymbol,
        decimals: BASE_DECIMALS,
        vaultAddress: requestedMarket.baseVaultAddress,
      },
      quote: {
        symbol: requestedMarket.quoteSymbol,
        decimals: QUOTE_DECIMALS,
        vaultAddress: requestedMarket.quoteVaultAddress,
      },
      orderbookAddress: requestedMarket.orderbookAddress,
      routerAddress: config.contracts.router,
      markets: markets.map((market) => ({
        index: market.index,
        orderbookAddress: market.orderbookAddress,
        baseVaultAddress: market.baseVaultAddress,
        quoteVaultAddress: market.quoteVaultAddress,
        baseSymbol: market.baseSymbol,
        quoteSymbol: market.quoteSymbol,
        baseTokenId: market.baseTokenId,
        quoteTokenId: market.quoteTokenId,
      })),
    },
  };
}

export async function cancelOrder(input: {
  walletAddress?: string;
  marketIndex?: number;
  orderId: string;
  confirm?: boolean;
}) {
  const { takerSigner, takerAddress } = await getState();
  const market = await resolveMarket(parseMarketIndex(input.marketIndex));
  const orderbook = market.orderbook;
  const confirm = Boolean(input.confirm);
  if (!confirm) {
    return {
      ok: false,
      needsConfirmation: true,
      data: {
        ...input,
        signerAddress: takerAddress,
        marketIndex: market.index,
        orderbookAddress: market.orderbookAddress,
      },
      message: "Cancellation requires confirmation.",
    };
  }

  if (input.walletAddress && isAddress(input.walletAddress)) {
    const requested = input.walletAddress.toLowerCase();
    const signerAddr = takerAddress.toLowerCase();
    if (requested !== signerAddr) {
      return {
        ok: false,
        data: {
          requestedWallet: input.walletAddress,
          signerAddress: takerAddress,
        },
        message:
          "Server signer differs from requested walletAddress. Connect that wallet in app backend or use signer wallet.",
      };
    }
  }

  await orderbook.withSigner(takerSigner).cancelOrder(BigInt(input.orderId));
  const post = await orderbook.orderById(BigInt(input.orderId));
  return {
    ok: true,
    data: {
      orderId: input.orderId,
      signerAddress: takerAddress,
      marketIndex: market.index,
      orderbookAddress: market.orderbookAddress,
      statusAfterCancel: classifyOrderStatus(post),
      existsAfterCancel: post.exists,
    },
  };
}

export async function seedSignerLiquidity(input?: {
  marketIndex?: number;
  mintBase?: number;
  mintQuote?: number;
  marketBase?: number;
  marketQuote?: number;
}) {
  const { adminSigner, takerAddress } = await getState();
  const market = await resolveMarket(parseMarketIndex(input?.marketIndex));
  const baseVault = market.baseVault;
  const quoteVault = market.quoteVault;
  const orderbook = market.orderbook;

  const mintBase = Math.max(0, input?.mintBase ?? 1000);
  const mintQuote = Math.max(0, input?.mintQuote ?? 1000);
  const marketBase = Math.max(0, input?.marketBase ?? 500);
  const marketQuote = Math.max(0, input?.marketQuote ?? 500);

  const mintBaseRaw = BigInt(Math.floor(mintBase * 10 ** DECIMALS));
  const mintQuoteRaw = BigInt(Math.floor(mintQuote * 10 ** DECIMALS));

  const baseScoped = baseVault.withSigner(adminSigner);
  const quoteScoped = quoteVault.withSigner(adminSigner);

  try {
    await baseScoped.addMarket(market.orderbookAddress);
  } catch {}
  try {
    await quoteScoped.addMarket(market.orderbookAddress);
  } catch {}

  if (mintBaseRaw > 0n) {
    await baseScoped.vaultDeposit(takerAddress, mintBaseRaw);
  }
  if (mintQuoteRaw > 0n) {
    await quoteScoped.vaultDeposit(takerAddress, mintQuoteRaw);
  }

  if (marketBase > 0) {
    await baseScoped.transferToMarket(market.orderbookAddress, marketBase);
  }
  if (marketQuote > 0) {
    await quoteScoped.transferToMarket(market.orderbookAddress, marketQuote);
  }

  const [obBase, obQuote] = await orderbook.balanceOf(takerAddress);

  return {
    ok: true,
    data: {
      signerAddress: takerAddress,
      marketIndex: market.index,
      orderbookAddress: market.orderbookAddress,
      minted: {
        base: mintBase,
        quote: mintQuote,
      },
      transferredToMarket: {
        base: marketBase,
        quote: marketQuote,
      },
      orderbookBalance: {
        base: toDisplay(obBase),
        quote: toDisplay(obQuote),
      },
    },
  };
}

export async function runSuccessfulExchange(input?: {
  amountBase?: number;
  priceInQuotePerBase?: number;
  confirm?: boolean;
  makerQuoteDeposit?: number;
  takerBaseDeposit?: number;
  makerBaseDeposit?: number;
  takerQuoteDeposit?: number;
}) {
  const confirm = Boolean(input?.confirm);
  const amountBase = Math.max(1, Math.ceil(input?.amountBase ?? 2));
  const priceInQuotePerBase = Math.max(0.000001, input?.priceInQuotePerBase ?? 1.01);
  const makerQuoteDeposit = Math.max(
    amountBase * priceInQuotePerBase,
    Math.ceil(
      input?.makerQuoteDeposit ??
        input?.takerQuoteDeposit ??
        amountBase * priceInQuotePerBase * 20,
    ),
  );
  const takerBaseDeposit = Math.max(
    amountBase,
    Math.ceil(input?.takerBaseDeposit ?? input?.makerBaseDeposit ?? amountBase * 10),
  );

  const {
    baseVault,
    quoteVault,
    orderbook,
    adminSigner,
    makerSigner,
    makerAddress,
    takerSigner,
    takerAddress,
  } = await getState();

  if (!confirm) {
    return {
      ok: false,
      needsConfirmation: true,
      message: "Successful exchange simulation requires confirmation.",
      data: {
        makerAddress,
        takerAddress,
        amountBase,
        priceInQuotePerBase,
      },
    };
  }

  const baseAdmin = baseVault.withSigner(adminSigner);
  const quoteAdmin = quoteVault.withSigner(adminSigner);

  try {
    await baseAdmin.addMarket(config.contracts.orderbook);
  } catch {}
  try {
    await quoteAdmin.addMarket(config.contracts.orderbook);
  } catch {}

  const makerQuoteRaw = BigInt(Math.floor(makerQuoteDeposit * 10 ** DECIMALS));
  const takerBaseRaw = BigInt(Math.floor(takerBaseDeposit * 10 ** DECIMALS));
  await quoteAdmin.vaultDeposit(makerAddress, makerQuoteRaw);
  await baseAdmin.vaultDeposit(takerAddress, takerBaseRaw);

  await quoteVault
    .withSigner(makerSigner)
    .transferToMarket(config.contracts.orderbook, makerQuoteDeposit);
  await baseVault
    .withSigner(takerSigner)
    .transferToMarket(config.contracts.orderbook, takerBaseDeposit);

  // Maker posts bid, taker crosses with market sell.
  const makerOrderId = await orderbook
    .withSigner(makerSigner)
    .placeBuyLimitOrder(amountBase, priceInQuotePerBase, false);
  const takerOrderId = await orderbook
    .withSigner(takerSigner)
    .placeSellMarketOrder(amountBase, true);

  const makerOrder = await orderbook.orderById(makerOrderId);
  const takerOrder = await orderbook.orderById(takerOrderId);
  const [makerBaseAfter, makerQuoteAfter] = await orderbook.balanceOf(makerAddress);
  const [takerBaseAfter, takerQuoteAfter] = await orderbook.balanceOf(takerAddress);

  return {
    ok: true,
    data: {
      makerAddress,
      takerAddress,
      amountBase,
      priceInQuotePerBase,
      makerOrderId: makerOrderId.toString(),
      takerOrderId: takerOrderId.toString(),
      makerOrder: {
        exists: makerOrder.exists,
        filledBase: makerOrder.filledBase.toString(),
      },
      takerOrder: {
        exists: takerOrder.exists,
        filledBase: takerOrder.filledBase.toString(),
      },
      orderbookBalanceAfter: {
        maker: {
          base: toDisplay(makerBaseAfter),
          quote: toDisplay(makerQuoteAfter),
        },
        taker: {
          base: toDisplay(takerBaseAfter),
          quote: toDisplay(takerQuoteAfter),
        },
      },
    },
  };
}

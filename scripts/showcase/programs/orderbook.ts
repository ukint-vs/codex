import {
  getMirrorClient,
  IInjectedTransaction,
  ISigner,
  type VaraEthApi,
} from "@vara-eth/api";
import { Address, hexToBytes, PublicClient } from "viem";

import type { Codec } from "../codec.js";
import { BaseProgram } from "./base.js";
import { logger } from "../logger.js";
import { actorIdToAddress, addressToActorId } from "./util.js";

export enum OrderKind {
  Limit = 0,
  Market = 1,
  FillOrKill = 2,
  ImmediateOrCancel = 3,
}

const SERVICE = "Orderbook";

enum MessageMethod {
  SubmitOrder = "SubmitOrder",
  PopulateDemoOrders = "PopulateDemoOrders",
  CancelOrder = "CancelOrder",
  WithdrawBase = "WithdrawBase",
  WithdrawQuote = "WithdrawQuote",
}

enum QueryMethod {
  BalanceOf = "BalanceOf",
  OrderById = "OrderById",
  BestAskPrice = "BestAskPrice",
  BestBidPrice = "BestBidPrice",
  Orders = "Orders",
  OrdersReverse = "OrdersReverse",
  Trades = "Trades",
  TradesCount = "TradesCount",
  TradesReverse = "TradesReverse",
}

export enum Side {
  Buy = 0,
  Sell = 1,
}

export class Orderbook extends BaseProgram {
  constructor(
    codec: Codec,
    varaEthApi: VaraEthApi,
    pc: PublicClient,
    address: Address,
    private baseDecimals: number,
    private quoteDecimals: number,
  ) {
    super(codec, varaEthApi, pc);
    this.client = getMirrorClient({
      address,
      publicClient: pc,
    });
  }

  bestAskPrice() {
    const payload = this.codec.encodeQueryFn(
      SERVICE,
      QueryMethod.BestAskPrice,
      [],
    );

    return this.readState(payload);
  }

  bestBidPrice() {
    const payload = this.codec.encodeQueryFn(
      SERVICE,
      QueryMethod.BestBidPrice,
      [],
    );

    return this.readState(payload);
  }

  async balanceOf(address: Address): Promise<[bigint, bigint]> {
    const payload = this.codec.encodeQueryFn(SERVICE, QueryMethod.BalanceOf, [
      addressToActorId(address),
    ]);

    const state = await this.readState(payload);

    return [BigInt(state[0]), BigInt(state[1])];
  }

  async populateDemoOrders(args: {
    seed: bigint;
    levels: number;
    ordersPerLevel: number;
    midPrice: bigint;
    tickBps: number;
    minAmountBase: bigint;
    maxAmountBase: bigint;
  }): Promise<{
    bidsInserted: number;
    asksInserted: number;
    firstOrderId: bigint;
    lastOrderId: bigint;
  }> {
    const payload = this.codec.encodeMessageFn(SERVICE, MessageMethod.PopulateDemoOrders, [
      args.seed,
      args.levels,
      args.ordersPerLevel,
      args.midPrice,
      args.tickBps,
      args.minAmountBase,
      args.maxAmountBase,
    ]);

    const txData: IInjectedTransaction = {
      payload,
      destination: this.client.address,
    };

    const tx = await this.varaEthApi.createInjectedTransaction(txData);
    const start = Date.now();

    logger.info("Sending Populate Demo Orders message", {
      messageId: tx.messageId,
      seed: args.seed.toString(),
      levels: args.levels,
      ordersPerLevel: args.ordersPerLevel,
    });

    await tx.sign(this.signer);
    const promise = await tx.sendAndWaitForPromise();
    const promiseReceivedTime = Date.now();

    if (promise.code.startsWith("0x01")) {
      const errorData = new TextDecoder().decode(hexToBytes(promise.payload));
      logger.error("Failed to populate demo orders", {
        messageId: tx.messageId,
        duration: `${(promiseReceivedTime - start) / 1000}s`,
        data: errorData,
      });
      throw new Error(`Failed to populate demo orders: ${errorData}`);
    }

    const [bidsInserted, asksInserted, firstOrderId, lastOrderId] =
      this.codec.decodeMsgReply(promise.payload);

    return {
      bidsInserted: Number(bidsInserted),
      asksInserted: Number(asksInserted),
      firstOrderId: BigInt(firstOrderId),
      lastOrderId: BigInt(lastOrderId),
    };
  }

  private async waitUntilOrderFulfilled(
    address: Address,
    side: Side,
    originalBaseBalance: bigint,
    originalQuoteBalance: bigint,
    orderDescription: string,
    trackingId: string,
    pollCount: number = 0,
    maxPolls: number = 24,
  ): Promise<[bigint, bigint]> {
    const [baseBalance, quoteBalance] = await this.balanceOf(address);

    let fulfilled = false;

    if (side === Side.Buy) {
      fulfilled = baseBalance > originalBaseBalance;
    } else {
      fulfilled = quoteBalance > originalQuoteBalance;
    }

    if (fulfilled) {
      logger.info(`${orderDescription} fulfilled`, {
        trackingId,
        baseChange: (baseBalance - originalBaseBalance).toString(),
        quoteChange: (quoteBalance - originalQuoteBalance).toString(),
      });
      return [baseBalance, quoteBalance];
    }

    if (pollCount >= maxPolls) {
      logger.info(
        `${orderDescription} not fulfilled after ${maxPolls} polls, giving up`,
        {
          trackingId,
        },
      );
      return [baseBalance, quoteBalance];
    }

    // Log only on first poll and then every 6th (~30s)
    if (pollCount === 0 || pollCount % 6 === 0) {
      logger.info(`${orderDescription} waiting for fulfillment...`, {
        trackingId,
        poll: pollCount,
      });
    }

    await new Promise((resolve) => setTimeout(resolve, 5000));
    return this.waitUntilOrderFulfilled(
      address,
      side,
      originalBaseBalance,
      originalQuoteBalance,
      orderDescription,
      trackingId,
      pollCount + 1,
      maxPolls,
    );
  }

  /**
   * Calculate limit price in fixed point format
   * @param priceInQuotePerBase - Price as quote tokens per base token (e.g., 2000 USDT per 1 ETH)
   * @returns Fixed point price
   */
  calculateLimitPrice(priceInQuotePerBase: number): bigint {
    const PRICE_PRECISION = BigInt(10 ** 30);
    const quotePerBaseAtoms = BigInt(
      Math.floor(priceInQuotePerBase * 10 ** this.quoteDecimals),
    );
    const baseUnit = BigInt(10 ** this.baseDecimals);
    return (quotePerBaseAtoms * PRICE_PRECISION) / baseUnit;
  }

  async orderById(orderId: bigint): Promise<{
    exists: boolean;
    id: bigint;
    owner: Address;
    side: number;
    limitPrice: bigint;
    amountBase: bigint;
    filledBase: bigint;
  }> {
    const payload = this.codec.encodeQueryFn(SERVICE, QueryMethod.OrderById, [
      orderId,
    ]);

    const state = await this.readState(payload);

    return {
      exists: state[0],
      id: BigInt(state[1]),
      owner: state[2] as Address,
      side: Number(state[3]),
      limitPrice: BigInt(state[4]),
      amountBase: BigInt(state[5]),
      filledBase: BigInt(state[6]),
    };
  }

  async orders(offset: number, count: number): Promise<
    {
      id: bigint;
      owner: Address;
      side: number;
      limitPrice: bigint;
      amountBase: bigint;
      reservedQuote: bigint;
    }[]
  > {
    const payload = this.codec.encodeQueryFn(SERVICE, QueryMethod.Orders, [
      offset,
      count,
    ]);

    const state = await this.readState(payload);

    return (state as unknown[]).map((row) => {
      const item = row as [unknown, unknown, unknown, unknown, unknown, unknown];
      return {
        id: BigInt(item[0] as bigint),
        owner: item[1] as Address,
        side: Number(item[2]),
        limitPrice: BigInt(item[3] as bigint),
        amountBase: BigInt(item[4] as bigint),
        reservedQuote: BigInt(item[5] as bigint),
      };
    });
  }

  async ordersReverse(offset: number, count: number): Promise<
    {
      id: bigint;
      owner: Address;
      side: number;
      limitPrice: bigint;
      amountBase: bigint;
      reservedQuote: bigint;
    }[]
  > {
    const payload = this.codec.encodeQueryFn(SERVICE, QueryMethod.OrdersReverse, [
      offset,
      count,
    ]);

    const state = await this.readState(payload);

    return (state as unknown[]).map((row) => {
      const item = row as [unknown, unknown, unknown, unknown, unknown, unknown];
      return {
        id: BigInt(item[0] as bigint),
        owner: item[1] as Address,
        side: Number(item[2]),
        limitPrice: BigInt(item[3] as bigint),
        amountBase: BigInt(item[4] as bigint),
        reservedQuote: BigInt(item[5] as bigint),
      };
    });
  }

  async tradesCount(): Promise<bigint> {
    const payload = this.codec.encodeQueryFn(SERVICE, QueryMethod.TradesCount, []);
    const state = await this.readState(payload);
    return BigInt(state);
  }

  async trades(offset: number, count: number): Promise<
    {
      seq: bigint;
      makerOrderId: bigint;
      takerOrderId: bigint;
      maker: Address;
      taker: Address;
      price: bigint;
      amountBase: bigint;
      amountQuote: bigint;
    }[]
  > {
    const payload = this.codec.encodeQueryFn(SERVICE, QueryMethod.Trades, [
      offset,
      count,
    ]);
    const state = await this.readState(payload);

    return (state as unknown[]).map((row) => {
      const item = row as [
        unknown,
        unknown,
        unknown,
        unknown,
        unknown,
        unknown,
        unknown,
        unknown,
      ];
      return {
        seq: BigInt(item[0] as bigint),
        makerOrderId: BigInt(item[1] as bigint),
        takerOrderId: BigInt(item[2] as bigint),
        maker: actorIdToAddress(item[3] as Address),
        taker: actorIdToAddress(item[4] as Address),
        price: BigInt(item[5] as bigint),
        amountBase: BigInt(item[6] as bigint),
        amountQuote: BigInt(item[7] as bigint),
      };
    });
  }

  async tradesReverse(offset: number, count: number): Promise<
    {
      seq: bigint;
      makerOrderId: bigint;
      takerOrderId: bigint;
      maker: Address;
      taker: Address;
      price: bigint;
      amountBase: bigint;
      amountQuote: bigint;
    }[]
  > {
    const payload = this.codec.encodeQueryFn(SERVICE, QueryMethod.TradesReverse, [
      offset,
      count,
    ]);
    const state = await this.readState(payload);

    return (state as unknown[]).map((row) => {
      const item = row as [
        unknown,
        unknown,
        unknown,
        unknown,
        unknown,
        unknown,
        unknown,
        unknown,
      ];
      return {
        seq: BigInt(item[0] as bigint),
        makerOrderId: BigInt(item[1] as bigint),
        takerOrderId: BigInt(item[2] as bigint),
        maker: actorIdToAddress(item[3] as Address),
        taker: actorIdToAddress(item[4] as Address),
        price: BigInt(item[5] as bigint),
        amountBase: BigInt(item[6] as bigint),
        amountQuote: BigInt(item[7] as bigint),
      };
    });
  }

  private generateOrderTrackingId(): string {
    return `order-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  private async submitOrder(
    side: Side,
    kind: OrderKind,
    limitPrice: bigint,
    amountBase: bigint,
    maxQuote: bigint,
    orderDescription: string,
    waitForFulfillment: boolean = true,
  ): Promise<bigint> {
    const id = this.generateOrderTrackingId();
    const userAddress = await this.signer.getAddress();
    const [originalBaseBalance, originalQuoteBalance] = await this.balanceOf(
      userAddress as Address,
    );

    const payload = this.codec.encodeMessageFn(
      SERVICE,
      MessageMethod.SubmitOrder,
      [side, kind, limitPrice, amountBase, maxQuote],
    );

    const txData: IInjectedTransaction = {
      payload,
      destination: this.client.address,
    };

    const tx = await this.varaEthApi.createInjectedTransaction(txData);

    const start = Date.now();

    logger.info(`Sending ${orderDescription}`, {
      id,
      messageId: tx.messageId,
      side: Side[side],
      kind: OrderKind[kind],
      amountBase: amountBase.toString(),
      limitPrice: limitPrice.toString(),
      maxQuote: maxQuote.toString(),
    });

    await tx.sign(this.signer);
    const promise = await tx.sendAndWaitForPromise();

    const promiseReceivedTime = Date.now();

    if (promise.code.startsWith("0x01")) {
      const errorData = new TextDecoder().decode(hexToBytes(promise.payload));
      logger.error(`Failed to place ${orderDescription}`, {
        id,
        messageId: tx.messageId,
        duration: `${(promiseReceivedTime - start) / 1000}s`,
        data: errorData,
      });
      throw new Error(`Failed to place ${orderDescription}: ${errorData}`);
    } else {
      const orderId = BigInt(this.codec.decodeMsgReply(promise.payload));
      logger.info(`Promise received for ${orderDescription}`, {
        id,
        messageId: tx.messageId,
        duration: `${(promiseReceivedTime - start) / 1000}s`,
        orderId: orderId.toString(),
      });

      if (waitForFulfillment) {
        await this.waitUntilOrderFulfilled(
          userAddress as Address,
          side,
          originalBaseBalance,
          originalQuoteBalance,
          orderDescription,
          id,
        );
      }

      return orderId;
    }
  }

  async placeBuyMarketOrder(
    amountBase: number,
    maxQuoteAmount: number,
    waitForFulfillment: boolean = true,
  ): Promise<bigint> {
    const _amountBase = BigInt(amountBase) * BigInt(10 ** this.baseDecimals);
    const _maxQuote = BigInt(maxQuoteAmount) * BigInt(10 ** this.quoteDecimals);

    return this.submitOrder(
      Side.Buy,
      OrderKind.Market,
      BigInt(0),
      _amountBase,
      _maxQuote,
      "Buy Market Order",
      waitForFulfillment,
    );
  }

  async placeSellMarketOrder(
    amountBase: number,
    waitForFulfillment: boolean = true,
  ): Promise<bigint> {
    const _amountBase = BigInt(amountBase) * BigInt(10 ** this.baseDecimals);

    return this.submitOrder(
      Side.Sell,
      OrderKind.Market,
      BigInt(0),
      _amountBase,
      BigInt(0),
      "Sell Market Order",
      waitForFulfillment,
    );
  }

  async placeBuyLimitOrder(
    amountBase: number,
    priceInQuotePerBase: number,
    waitForFulfillment: boolean = true,
  ): Promise<bigint> {
    const _amountBase = BigInt(amountBase) * BigInt(10 ** this.baseDecimals);
    const limitPrice = this.calculateLimitPrice(priceInQuotePerBase);

    return this.submitOrder(
      Side.Buy,
      OrderKind.Limit,
      limitPrice,
      _amountBase,
      BigInt(0),
      "Buy Limit Order",
      waitForFulfillment,
    );
  }

  async placeSellLimitOrder(
    amountBase: number,
    priceInQuotePerBase: number,
    waitForFulfillment: boolean = true,
  ): Promise<bigint> {
    const _amountBase = BigInt(amountBase) * BigInt(10 ** this.baseDecimals);
    const limitPrice = this.calculateLimitPrice(priceInQuotePerBase);

    return this.submitOrder(
      Side.Sell,
      OrderKind.Limit,
      limitPrice,
      _amountBase,
      BigInt(0),
      "Sell Limit Order",
      waitForFulfillment,
    );
  }

  async placeBuyFillOrKillOrder(
    amountBase: number,
    priceInQuotePerBase: number,
  ): Promise<bigint> {
    const _amountBase = BigInt(amountBase) * BigInt(10 ** this.baseDecimals);
    const limitPrice = this.calculateLimitPrice(priceInQuotePerBase);

    return this.submitOrder(
      Side.Buy,
      OrderKind.FillOrKill,
      limitPrice,
      _amountBase,
      BigInt(0),
      "Buy FillOrKill Order",
    );
  }

  async placeSellFillOrKillOrder(
    amountBase: number,
    priceInQuotePerBase: number,
  ): Promise<bigint> {
    const _amountBase = BigInt(amountBase) * BigInt(10 ** this.baseDecimals);
    const limitPrice = this.calculateLimitPrice(priceInQuotePerBase);

    return this.submitOrder(
      Side.Sell,
      OrderKind.FillOrKill,
      limitPrice,
      _amountBase,
      BigInt(0),
      "Sell FillOrKill Order",
    );
  }

  async placeBuyImmediateOrCancelOrder(
    amountBase: number,
    priceInQuotePerBase: number,
    waitForFulfillment: boolean = true,
  ): Promise<bigint> {
    const _amountBase = BigInt(amountBase) * BigInt(10 ** this.baseDecimals);
    const limitPrice = this.calculateLimitPrice(priceInQuotePerBase);

    return this.submitOrder(
      Side.Buy,
      OrderKind.ImmediateOrCancel,
      limitPrice,
      _amountBase,
      BigInt(0),
      "Buy ImmediateOrCancel Order",
      waitForFulfillment,
    );
  }

  async placeSellImmediateOrCancelOrder(
    amountBase: number,
    priceInQuotePerBase: number,
    waitForFulfillment: boolean = true,
  ): Promise<bigint> {
    const _amountBase = BigInt(amountBase) * BigInt(10 ** this.baseDecimals);
    const limitPrice = this.calculateLimitPrice(priceInQuotePerBase);

    return this.submitOrder(
      Side.Sell,
      OrderKind.ImmediateOrCancel,
      limitPrice,
      _amountBase,
      BigInt(0),
      "Sell ImmediateOrCancel Order",
      waitForFulfillment,
    );
  }

  async cancelOrder(orderId: bigint): Promise<void> {
    const payload = this.codec.encodeMessageFn(
      SERVICE,
      MessageMethod.CancelOrder,
      [orderId],
    );

    const txData: IInjectedTransaction = {
      payload,
      destination: this.client.address,
    };

    const tx = await this.varaEthApi.createInjectedTransaction(txData);

    const start = Date.now();

    logger.info("Sending Cancel Order message", {
      messageId: tx.messageId,
      orderId: orderId.toString(),
    });

    await tx.sign(this.signer);
    const promise = await tx.sendAndWaitForPromise();

    const promiseReceivedTime = Date.now();

    if (promise.code.startsWith("0x01")) {
      logger.error("Failed to cancel order", {
        messageId: tx.messageId,
        duration: `${(promiseReceivedTime - start) / 1000}s`,
        data: new TextDecoder().decode(hexToBytes(promise.payload)),
      });
      throw new Error("Failed to cancel order");
    } else {
      logger.info("Order cancelled successfully", {
        messageId: tx.messageId,
        duration: `${(promiseReceivedTime - start) / 1000}s`,
        orderId: orderId.toString(),
      });
    }
  }

  async withdrawBase(amount: number): Promise<void> {
    const _amount = BigInt(amount) * BigInt(10 ** this.baseDecimals);

    const payload = this.codec.encodeMessageFn(
      SERVICE,
      MessageMethod.WithdrawBase,
      [_amount],
    );

    const txData: IInjectedTransaction = {
      payload,
      destination: this.client.address,
    };

    const tx = await this.varaEthApi.createInjectedTransaction(txData);

    const start = Date.now();

    logger.info("Sending Withdraw Base message", {
      messageId: tx.messageId,
      amount: _amount.toString(),
    });

    await tx.sign(this.signer);
    const promise = await tx.sendAndWaitForPromise();

    const promiseReceivedTime = Date.now();

    if (promise.code.startsWith("0x01")) {
      logger.error("Failed to withdraw base", {
        messageId: tx.messageId,
        duration: `${(promiseReceivedTime - start) / 1000}s`,
        data: new TextDecoder().decode(hexToBytes(promise.payload)),
      });
      throw new Error("Failed to withdraw base");
    } else {
      logger.info("Base withdrawn successfully", {
        messageId: tx.messageId,
        duration: `${(promiseReceivedTime - start) / 1000}s`,
      });
    }
  }

  async withdrawQuote(amount: number): Promise<void> {
    const _amount = BigInt(amount) * BigInt(10 ** this.quoteDecimals);

    const payload = this.codec.encodeMessageFn(
      SERVICE,
      MessageMethod.WithdrawQuote,
      [_amount],
    );

    const txData: IInjectedTransaction = {
      payload,
      destination: this.client.address,
    };

    const tx = await this.varaEthApi.createInjectedTransaction(txData);

    const start = Date.now();

    logger.info("Sending Withdraw Quote message", {
      messageId: tx.messageId,
      amount: _amount.toString(),
    });

    await tx.sign(this.signer);
    const promise = await tx.sendAndWaitForPromise();

    const promiseReceivedTime = Date.now();

    if (promise.code.startsWith("0x01")) {
      logger.error("Failed to withdraw quote", {
        messageId: tx.messageId,
        duration: `${(promiseReceivedTime - start) / 1000}s`,
        data: new TextDecoder().decode(hexToBytes(promise.payload)),
      });
      throw new Error("Failed to withdraw quote");
    } else {
      logger.info("Quote withdrawn successfully", {
        messageId: tx.messageId,
        duration: `${(promiseReceivedTime - start) / 1000}s`,
      });
    }
  }
}

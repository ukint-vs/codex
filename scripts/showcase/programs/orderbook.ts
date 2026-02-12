import {
  getMirrorClient,
  IInjectedTransaction,
  ISigner,
  type VaraEthApi,
} from "@vara-eth/api";
import { Address, hexToBytes, PublicClient } from "viem";

import type { Codec } from "../codec.js";
import { BaseProgram } from "./base.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { addressToActorId } from "./util.js";

export enum OrderKind {
  Limit = 0,
  Market = 1,
  FillOrKill = 2,
  ImmediateOrCancel = 3,
}

const SERVICE = "Orderbook";

enum MessageMethod {
  SubmitOrder = "SubmitOrder",
  CancelOrder = "CancelOrder",
  WithdrawBase = "WithdrawBase",
  WithdrawQuote = "WithdrawQuote",
}

enum QueryMethod {
  BalanceOf = "BalanceOf",
  OrderById = "OrderById",
  BestAskPrice = "BestAskPrice",
  BestBidPrice = "BestBidPrice",
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
    private baseDecimals: number,
    private quoteDecimals: number,
  ) {
    super(codec, varaEthApi, pc);
    this.client = getMirrorClient({
      address: config.contracts.orderbook,
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
      logger.error(`Failed to place ${orderDescription}`, {
        id,
        messageId: tx.messageId,
        duration: `${(promiseReceivedTime - start) / 1000}s`,
        data: new TextDecoder().decode(hexToBytes(promise.payload)),
      });
      throw new Error(`Failed to place ${orderDescription}`);
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
    );
  }

  async placeSellMarketOrder(amountBase: number): Promise<bigint> {
    const _amountBase = BigInt(amountBase) * BigInt(10 ** this.baseDecimals);

    return this.submitOrder(
      Side.Sell,
      OrderKind.Market,
      BigInt(0),
      _amountBase,
      BigInt(0),
      "Sell Market Order",
    );
  }

  async placeBuyLimitOrder(
    amountBase: number,
    priceInQuotePerBase: number,
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
    );
  }

  async placeSellLimitOrder(
    amountBase: number,
    priceInQuotePerBase: number,
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
    );
  }

  async placeSellImmediateOrCancelOrder(
    amountBase: number,
    priceInQuotePerBase: number,
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

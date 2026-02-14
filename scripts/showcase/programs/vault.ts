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

const SERVICE = "Vault" as const;

enum MessageMethod {
  AddMarket = "AddMarket",
  TransferToMarket = "TransferToMarket",
  DebugDeposit = "DebugDeposit",
}

enum QueryMethod {
  GetBalance = "GetBalance",
  Admin = "Admin",
}

export class Vault extends BaseProgram {
  constructor(
    codec: Codec,
    varaEthApi: VaraEthApi,
    pc: PublicClient,
    address: Address,
    private decimals: number,
  ) {
    super(codec, varaEthApi, pc);
    logger.info(`Initializing Vault`, { address });
    this.client = getMirrorClient({
      address: address,
      publicClient: pc,
    });
  }

  async getBalance(address: Address): Promise<bigint> {
    const addr = addressToActorId(address);

    logger.info(`Getting balance for address`, { addr });
    const payload = this.codec.encodeQueryFn(SERVICE, QueryMethod.GetBalance, [
      addr,
    ]);

    const state = await this.readState(payload);

    logger.info(`Balance retrieved`, { value: state });

    return BigInt(state);
  }

  async queryAdmin(): Promise<Address> {
    const payload = this.codec.encodeQueryFn(SERVICE, QueryMethod.Admin, []);

    const state = await this.readState(payload);

    logger.info(`Admin retrieved`, { admin: state });

    return state;
  }

  async addMarket(marketAddress: Address): Promise<void> {
    const payload = this.codec.encodeMessageFn(
      SERVICE,
      MessageMethod.AddMarket,
      [addressToActorId(marketAddress)],
    );

    const txData: IInjectedTransaction = {
      payload,
      destination: this.client.address,
    };

    const tx = await this.varaEthApi.createInjectedTransaction(txData);

    const start = Date.now();

    logger.info("Sending Add Market message", {
      messageId: tx.messageId,
      marketAddress,
    });

    await tx.sign(this.signer);
    const promise = await tx.sendAndWaitForPromise();

    const promiseReceivedTime = Date.now();

    if (promise.code.startsWith("0x01")) {
      logger.error("Failed to add market", {
        messageId: tx.messageId,
        duration: `${(promiseReceivedTime - start) / 1000}s`,
        data: new TextDecoder().decode(hexToBytes(promise.payload)),
      });
      throw new Error("Failed to add market");
    } else {
      logger.info("Market added successfully", {
        messageId: tx.messageId,
        duration: `${(promiseReceivedTime - start) / 1000}s`,
        marketAddress,
      });
    }
  }

  async transferToMarket(
    marketAddress: Address,
    amount: number,
  ): Promise<void> {
    const _amount = BigInt(amount) * BigInt(10 ** this.decimals);

    const payload = this.codec.encodeMessageFn(
      SERVICE,
      MessageMethod.TransferToMarket,
      [addressToActorId(marketAddress), _amount],
    );

    const txData: IInjectedTransaction = {
      payload,
      destination: this.client.address,
    };

    const tx = await this.varaEthApi.createInjectedTransaction(txData);

    const start = Date.now();

    logger.info("Sending Transfer To Market message", {
      messageId: tx.messageId,
      marketAddress,
      amount: _amount.toString(),
    });

    await tx.sign(this.signer);
    const promise = await tx.sendAndWaitForPromise();

    const promiseReceivedTime = Date.now();

    if (promise.code.startsWith("0x01")) {
      logger.error("Failed to transfer to market", {
        messageId: tx.messageId,
        duration: `${(promiseReceivedTime - start) / 1000}s`,
        data: new TextDecoder().decode(hexToBytes(promise.payload)),
      });
      throw new Error("Failed to transfer to market");
    } else {
      logger.info("Transfer to market successful", {
        messageId: tx.messageId,
        duration: `${(promiseReceivedTime - start) / 1000}s`,
        marketAddress,
        amount: _amount.toString(),
      });
    }
  }

  async vaultDeposit(userAddress: Address, amount: bigint): Promise<void> {
    const _addr = addressToActorId(userAddress);

    const payload = this.codec.encodeMessageFn(
      SERVICE,
      MessageMethod.DebugDeposit,
      [_addr, amount],
    );

    const txData: IInjectedTransaction = {
      payload,
      destination: this.client.address,
    };

    const tx = await this.varaEthApi.createInjectedTransaction(txData);
    await tx.sign(this.signer);

    const start = Date.now();

    logger.info("Sending Vault Deposit message", {
      messageId: tx.messageId,
      userAddress,
      amount: amount.toString(),
    });

    const promise = await tx.sendAndWaitForPromise();

    const promiseReceivedTime = Date.now();

    if (promise.code.startsWith("0x01")) {
      logger.error("Failed to deposit to vault", {
        messageId: tx.messageId,
        duration: `${(promiseReceivedTime - start) / 1000}s`,
        data: new TextDecoder().decode(hexToBytes(promise.payload)),
      });
      throw new Error("Failed to deposit to vault");
    } else {
      logger.info("Vault deposit successful", {
        messageId: tx.messageId,
        duration: `${(promiseReceivedTime - start) / 1000}s`,
        userAddress,
        amount: amount.toString(),
      });
    }
  }
}

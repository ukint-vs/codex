import {
  getMirrorClient,
  ISigner,
  MirrorClient,
  VaraEthApi,
} from "@vara-eth/api";
import { Hex, hexToBytes, PublicClient, zeroAddress } from "viem";

import { Codec } from "../codec.js";
import { config } from "../config.js";

export class BaseProgram {
  protected client: MirrorClient;
  protected signer: ISigner;

  constructor(
    protected codec: Codec,
    protected varaEthApi: VaraEthApi,
    protected pc: PublicClient,
  ) {
    this.client = getMirrorClient({
      address: config.contracts.orderbook,
      publicClient: pc,
    });
  }

  withSigner(signer: ISigner) {
    this.signer = signer;
    this.client.setSigner(signer);

    return this;
  }

  protected account() {
    return this.signer
      ? this.signer.getAddress()
      : Promise.resolve(zeroAddress);
  }

  protected async readState(payload: Hex) {
    const state = await this.varaEthApi.call.program.calculateReplyForHandle(
      await this.account(),
      this.client.address,
      payload,
    );
    if ((state.code as any as string).startsWith("0x01")) {
      if (state.payload !== "0x") {
        throw new Error(new TextDecoder().decode(hexToBytes(state.payload)));
      } else {
        throw new Error(`Failed to read state. Reply code: ${state.code}`);
      }
    }
    return this.codec.decodeQueryReply(state.payload);
  }
}

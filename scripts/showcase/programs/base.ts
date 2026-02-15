import {
  getMirrorClient,
  ISigner,
  MirrorClient,
  VaraEthApi,
} from "@vara-eth/api";
import { Hex, hexToBytes, PublicClient, zeroAddress } from "viem";

import { Codec } from "../codec.js";
import { config } from "../config.js";

const READ_RETRIES = Math.max(
  0,
  Number(process.env.SHOWCASE_READ_RETRIES ?? 3),
);
const READ_RETRY_DELAY_MS = Math.max(
  10,
  Number(process.env.SHOWCASE_READ_RETRY_DELAY_MS ?? 80),
);

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
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= READ_RETRIES; attempt += 1) {
      const state = await this.varaEthApi.call.program.calculateReplyForHandle(
        zeroAddress,
        this.client.address,
        payload,
      );

      if (!(state.code as any as string).startsWith("0x01")) {
        return this.codec.decodeQueryReply(state.payload);
      }

      if (state.payload !== "0x") {
        throw new Error(new TextDecoder().decode(hexToBytes(state.payload)));
      }

      lastError = new Error(`Failed to read state. Reply code: ${state.code}`);
      if (attempt < READ_RETRIES) {
        await new Promise((resolve) =>
          setTimeout(resolve, READ_RETRY_DELAY_MS * (attempt + 1)),
        );
      }
    }

    throw lastError ?? new Error("Failed to read state");
  }
}

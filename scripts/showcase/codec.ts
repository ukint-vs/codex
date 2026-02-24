import { getFnNamePrefix, getServiceNamePrefix, Sails } from "sails-js";
import { SailsIdlParser } from "sails-js-parser";
import * as fs from "fs";
import type { Hex } from "viem";

export class Codec {
  private sails: Sails;

  constructor(parser: SailsIdlParser, idlPath: string) {
    this.sails = new Sails(parser);
    const idlContent = fs.readFileSync(idlPath, "utf-8");
    this.sails.parseIdl(idlContent);
  }

  private ensureService(name: string) {
    if (!this.sails.services[name]) {
      throw new Error(`Service '${name}' not found`);
    }
    return this.sails.services[name];
  }

  private ensureFunctionFn(serviceName: string, fnName: string) {
    const service = this.ensureService(serviceName);
    if (!service.functions[fnName]) {
      throw new Error(`Function '${fnName}' not found`);
    }
    return service.functions[fnName];
  }

  private ensureQueryFn(serviceName: string, fnName: string) {
    const service = this.ensureService(serviceName);
    if (!service.queries[fnName]) {
      throw new Error(`Query '${fnName}' not found`);
    }
    return service.queries[fnName];
  }

  public encodeMessageFn(serviceName: string, fnName: string, data: unknown[]) {
    const codec = this.ensureFunctionFn(serviceName, fnName);

    return codec.encodePayload(...data);
  }

  public decodeMsgReply(data: Hex) {
    const serviceName = getServiceNamePrefix(data);
    const fnName = getFnNamePrefix(data);

    const codec = this.ensureFunctionFn(serviceName, fnName);

    return codec.decodeResult(data);
  }

  public encodeQueryFn(serviceName: string, fnName: string, data: unknown[]) {
    const codec = this.ensureQueryFn(serviceName, fnName);

    return codec.encodePayload(...data);
  }

  public decodeQueryReply(data: Hex) {
    const serviceName = getServiceNamePrefix(data);
    const fnName = getFnNamePrefix(data);

    const codec = this.ensureQueryFn(serviceName, fnName);

    return codec.decodeResult(data);
  }
}

const PATH_TO_ORDERBOOK_IDL = "programs/orderbook/orderbook.idl";
const PATH_TO_VAULT_IDL = "programs/vault/vault.idl";

export let orderbookCodec: Codec;
export let vaultCodec: Codec;

export async function initCodec() {
  const parser = await SailsIdlParser.new();

  orderbookCodec = new Codec(parser, PATH_TO_ORDERBOOK_IDL);
  vaultCodec = new Codec(parser, PATH_TO_VAULT_IDL);
}

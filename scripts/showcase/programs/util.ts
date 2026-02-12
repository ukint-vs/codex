import { Address } from "viem";

export function addressToActorId(address: Address) {
  return address.length === 42
    ? `0x000000000000000000000000${address.slice(2)}`
    : address;
}

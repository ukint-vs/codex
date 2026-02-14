import { Address } from "viem";

export function addressToActorId(address: Address) {
  return address.length === 42
    ? `0x000000000000000000000000${address.slice(2)}`
    : address;
}

export function actorIdToAddress(actorId: Address): Address {
  const normalized = actorId.toLowerCase();

  if (
    normalized.length === 66 &&
    normalized.startsWith("0x000000000000000000000000")
  ) {
    return `0x${normalized.slice(-40)}` as Address;
  }

  return actorId;
}

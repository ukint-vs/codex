#![no_std]

extern crate alloc;

use sails_rs::alloy_primitives::Address;
use sails_rs::prelude::*;

pub type EthAddress = [u8; 20];
/// Canonical trader identity inside Gear programs.
pub type TraderId = ActorId;
/// Tokens remain 20-byte Ethereum addresses.
pub type TokenId = EthAddress; // Match existing tests usage
pub type OrderId = u128;
pub type Price = u128;
pub type Quantity = u128;

pub const DEFAULT_PRICE_SCALE: u128 = 1;

pub fn mul_div_ceil(a: u128, b: u128, denom: u128) -> u128 {
    if denom == 0 {
        panic!("DivisionByZero");
    }
    let prod = a.checked_mul(b).expect("MathOverflow");
    let rounded = prod
        .checked_add(denom.saturating_sub(1))
        .expect("MathOverflow");
    rounded / denom
}

pub fn actor_to_eth(actor: ActorId) -> EthAddress {
    Address::from(actor).into()
}

pub fn eth_to_actor(addr: EthAddress) -> ActorId {
    ActorId::from(Address::from(addr))
}

pub fn normalize_actor(actor: ActorId) -> ActorId {
    eth_to_actor(actor_to_eth(actor))
}

#[derive(Clone, Debug, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum Side {
    Buy,
    Sell,
}

#[derive(Clone, Debug, PartialEq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct Order {
    pub id: OrderId,
    pub trader: TraderId,
    pub side: Side,
    pub price: Price,
    pub quantity: Quantity,
    pub created_at: u64,
}

// --- Constants ---

// Fee rate in basis points (e.g. 30 = 0.3%)
// This must match the Vault's configuration.
pub const FEE_RATE_BPS: u128 = 30;

// Gas constants
// Estimate gas for Vault operations.
// Reserve/Unlock are simple updates. Settle is more complex.
pub const GAS_FOR_RESERVE: u64 = 5_000_000_000;
pub const GAS_FOR_UNLOCK: u64 = 5_000_000_000;
pub const GAS_FOR_SETTLE: u64 = 15_000_000_000;

// Reply deposit to cover the cost of the reply message itself.
pub const REPLY_DEPOSIT: u128 = 0;

#![no_std]

extern crate alloc;

use alloc::vec::Vec;
use sails_rs::{
    alloy_sol_types::{abi::token::WordToken, private::SolTypeValue, sol_data, SolValue, Word},
    prelude::*,
};

#[derive(
    Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Encode, Decode, TypeInfo, Default,
)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct Address(pub H160);

impl Address {
    pub const fn from_bytes(bytes: [u8; 20]) -> Self {
        Address(H160(bytes))
    }
}

/// Canonical trader identity inside Gear programs.
pub type TraderId = Address;
/// Tokens remain 20-byte Ethereum addresses.
pub type TokenId = Address;
pub type OrderId = u128;
pub type Price = u128;
pub type Quantity = u128;

impl SolValue for Address {
    type SolType = sol_data::Address;
}

impl SolTypeValue<sol_data::Address> for Address {
    #[inline]
    fn stv_to_tokens(&self) -> WordToken {
        let mut word = [0u8; 32];
        word[12..].copy_from_slice(self.0.as_fixed_bytes());
        WordToken(Word::from(word))
    }

    #[inline]
    fn stv_abi_encode_packed_to(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(self.0.as_fixed_bytes());
    }

    #[inline]
    fn stv_eip712_data_word(&self) -> Word {
        <Address as SolTypeValue<sol_data::Address>>::stv_to_tokens(self).0
    }
}

impl SolTypeValue<sol_data::Address> for &Address {
    #[inline]
    fn stv_to_tokens(&self) -> WordToken {
        <Address as SolTypeValue<sol_data::Address>>::stv_to_tokens(self)
    }

    #[inline]
    fn stv_abi_encode_packed_to(&self, out: &mut Vec<u8>) {
        <Address as SolTypeValue<sol_data::Address>>::stv_abi_encode_packed_to(self, out)
    }

    #[inline]
    fn stv_eip712_data_word(&self) -> Word {
        <Address as SolTypeValue<sol_data::Address>>::stv_eip712_data_word(self)
    }
}

// --- Conversions ---

impl From<ActorId> for Address {
    fn from(value: ActorId) -> Self {
        Address(value.to_address_lossy())
    }
}

impl From<Address> for ActorId {
    fn from(value: Address) -> Self {
        ActorId::from(value.0)
    }
}

impl From<H160> for Address {
    fn from(value: H160) -> Self {
        Address(value)
    }
}

impl From<Address> for H160 {
    fn from(value: Address) -> Self {
        value.0
    }
}

impl From<[u8; 20]> for Address {
    fn from(bytes: [u8; 20]) -> Self {
        Address(H160::from(bytes))
    }
}

impl From<u64> for Address {
    fn from(value: u64) -> Self {
        Address(ActorId::from(value).to_address_lossy())
    }
}

impl From<sails_rs::alloy_primitives::Address> for Address {
    fn from(value: sails_rs::alloy_primitives::Address) -> Self {
        Address(H160::from(value.0 .0))
    }
}

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

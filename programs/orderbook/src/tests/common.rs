#![allow(dead_code)]
use crate::TokenId;
use dex_common::Address;
use sails_rs::{ActorId, U256};
pub const BUYER_ID: Address = Address::from_bytes([21u8; 20]);
pub const SELLER_ID: Address = Address::from_bytes([22u8; 20]);
pub const BUYER2_ID: Address = Address::from_bytes([23u8; 20]);
pub const SELLER2_ID: Address = Address::from_bytes([24u8; 20]);

pub const BASE_TOKEN_ID: TokenId = Address::from_bytes([20u8; 20]);
pub const QUOTE_TOKEN_ID: TokenId = Address::from_bytes([30u8; 20]);
pub const BASE_VAULT_ID: TokenId = Address::from_bytes([40u8; 20]);
pub const QUOTE_VAULT_ID: TokenId = Address::from_bytes([40u8; 20]);

pub const BUY: u16 = 0;
pub const SELL: u16 = 1;

pub const LIMIT: u16 = 0;
pub const MARKET: u16 = 1;
pub const FOK: u16 = 2;
pub const IOC: u16 = 3;

const PRICE_PRECISION: u128 = 1_000_000_000_000_000_000_000_000_000_000_000; // 1e30
pub const BASE_DECIMALS: u32 = 18;
pub const QUOTE_DECIMALS: u32 = 6;

pub fn base_vault() -> ActorId {
    ActorId::from(BASE_VAULT_ID)
}

pub fn quote_vault() -> ActorId {
    ActorId::from(QUOTE_VAULT_ID)
}

pub fn buyer() -> ActorId {
    ActorId::from(BUYER_ID)
}

pub fn seller() -> ActorId {
    ActorId::from(SELLER_ID)
}

pub fn buyer2() -> ActorId {
    ActorId::from(BUYER2_ID)
}

pub fn seller2() -> ActorId {
    ActorId::from(SELLER2_ID)
}

pub fn eth_wei(x: u128) -> u128 {
    x * 10u128.pow(BASE_DECIMALS)
}

pub fn eth_frac(num: u128, den: u128) -> u128 {
    eth_wei(1) * num / den
}

// price_fp = (quote_atoms_per_1_base_unit * PRICE_PRECISION)
pub fn price_fp_usdt_per_eth(usdt_per_eth: u128) -> u128 {
    // quote atoms per 1 ETH (micro-USDT per ETH)
    let quote_per_eth_atoms = U256::from(usdt_per_eth) * U256::from(10u128.pow(QUOTE_DECIMALS));
    let base_unit = U256::from(10u128.pow(BASE_DECIMALS)); // wei per 1 ETH

    // (quote_per_eth_atoms * PRICE_PRECISION) / base_unit
    let price_fp = quote_per_eth_atoms * U256::from(PRICE_PRECISION) / base_unit;

    price_fp.low_u128()
}

pub fn quote_floor_atoms(base_atoms: u128, price_fp: u128) -> u128 {
    let mul = U256::from(base_atoms) * U256::from(price_fp);
    let q = mul / U256::from(PRICE_PRECISION);
    q.low_u128()
}

pub fn quote_ceil_atoms(base_atoms: u128, price_fp: u128) -> u128 {
    let mul = U256::from(base_atoms) * U256::from(price_fp);
    let pp = U256::from(PRICE_PRECISION);
    let q = mul / pp;
    let rem = mul % pp;
    if rem.is_zero() {
        q.low_u128()
    } else {
        (q + U256::one()).low_u128()
    }
}

pub fn usdt_micro(x: u128) -> u128 {
    x * 10u128.pow(QUOTE_DECIMALS)
}

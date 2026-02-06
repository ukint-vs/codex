#![allow(dead_code)]
use clob_common::TokenId;
use orderbook_client::{
    orderbook::*, Orderbook as OrderbookClient, OrderbookCtors, OrderbookProgram,
};
use sails_rs::{client::*, gtest::*};
use sails_rs::{prelude::*, ActorId};
use vault_client::{vault::*, Vault as VualtClient, VaultCtors, VaultProgram};
pub(crate) const ORDERBOOK_WASM: &str = "../../target/wasm32-gear/release/orderbook.opt.wasm";
pub(crate) const VAULT_WASM: &str = "../../target/wasm32-gear/release/vault_app.opt.wasm";

pub(crate) const ADMIN_ID: u64 = 100;
pub(crate) const BUYER_ID: u64 = 101;
pub(crate) const SELLER_ID: u64 = 102;
pub(crate) const BUYER2_ID: u64 = 3;
pub(crate) const SELLER2_ID: u64 = 4;
pub(crate) const BASE_TOKEN_ID: TokenId = [20u8; 20];
pub(crate) const QUOTE_TOKEN_ID: TokenId = [30u8; 20];
pub(crate) const VAULT_ID: u64 = 10;

const PRICE_PRECISION: u128 = 1_000_000_000_000_000_000_000_000_000_000_000; // 1e30
pub const BASE_DECIMALS: u32 = 18;
pub const QUOTE_DECIMALS: u32 = 6;

pub fn buyer() -> ActorId {
    ActorId::from(BUYER_ID)
}
pub fn seller() -> ActorId {
    ActorId::from(SELLER_ID)
}

pub fn eth_wei(x: u128) -> u128 {
    x * 10u128.pow(BASE_DECIMALS)
}

pub fn buyer2() -> ActorId {
    ActorId::from(BUYER2_ID)
}
pub fn seller2() -> ActorId {
    ActorId::from(SELLER2_ID)
}

pub fn vault() -> ActorId {
    ActorId::from(VAULT_ID)
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
pub async fn setup_programs(
    max_trades: u32,
    max_preview_scans: u32,
) -> (
    GtestEnv,
    Actor<OrderbookProgram, sails_rs::client::GtestEnv>,
    Actor<VaultProgram, sails_rs::client::GtestEnv>,
) {
    let system = System::new();
    system.init_logger();
    system.mint_to(ADMIN_ID, 100_000_000_000_000_000);
    system.mint_to(buyer(), 100_000_000_000_000_000);
    system.mint_to(seller(), 100_000_000_000_000_000);

    let env = GtestEnv::new(system, ADMIN_ID.into());

    // Vault
    let vault_code_id = env.system().submit_code_file(VAULT_WASM);
    let vault_program = env
        .deploy::<vault_client::VaultProgram>(vault_code_id, b"salt".to_vec())
        .create()
        .await
        .unwrap();

    // OrderBook
    let orderbook_code_id = env.system().submit_code_file(ORDERBOOK_WASM);
    let orderbook_program = env
        .deploy::<orderbook_client::OrderbookProgram>(orderbook_code_id, b"salt".to_vec())
        .create(
            vault_program.id(),
            BASE_TOKEN_ID,
            QUOTE_TOKEN_ID,
            max_trades,
            max_preview_scans,
        )
        .await
        .unwrap();

    // Auth
    let mut vault = vault_program.vault();
    vault.add_market(orderbook_program.id()).await.unwrap();

    (env, orderbook_program, vault_program)
}

pub async fn setup_orderbook(
    max_trades: u32,
    max_preview_scans: u32,
) -> Actor<OrderbookProgram, sails_rs::client::GtestEnv> {
    let system = System::new();
    system.init_logger();
    system.mint_to(ADMIN_ID, 100_000_000_000_000_000);
    // Fund trader actor IDs so gtest can send messages.
    system.mint_to(buyer(), 100_000_000_000_000_000);
    system.mint_to(seller(), 100_000_000_000_000_000);
    system.mint_to(buyer2(), 100_000_000_000_000_000);
    system.mint_to(seller2(), 100_000_000_000_000_000);
    system.mint_to(vault(), 100_000_000_000_000_000);

    let env = GtestEnv::new(system, ADMIN_ID.into());
    // Deploy OrderBook passing the vault_id
    let program_code_id = env.system().submit_code_file(ORDERBOOK_WASM);

    env.deploy::<orderbook_client::OrderbookProgram>(program_code_id, b"salt".to_vec())
        .create(
            vault(),
            BASE_TOKEN_ID,
            QUOTE_TOKEN_ID,
            max_trades,
            max_preview_scans,
        )
        .await
        .unwrap()
}

pub async fn assert_balance(
    program: &Actor<OrderbookProgram, GtestEnv>,
    who: ActorId,
    base: u128,
    quote: u128,
) {
    let b = program.orderbook().balance_of(who).await.unwrap();
    assert_eq!(b.0, base);
    assert_eq!(b.1, quote);
}

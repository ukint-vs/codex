use dex_common::Address;
use orderbook_client::orderbook::Orderbook; // Explicit trait import
use orderbook_client::{orderbook::OrderbookImpl, OrderbookCtors, OrderbookProgram};
use sails_rs::{
    client::{Deployment, GtestEnv, Service},
    gtest::{Program, System},
    prelude::*,
    ActorId,
};

/// Convert ActorId to orderbook_client::Address.
fn oc_id(id: ActorId) -> orderbook_client::Address {
    orderbook_client::Address(id.to_address_lossy())
}

pub(crate) const ORDERBOOK_WASM: &str = "../../target/wasm32-gear/release/orderbook.opt.wasm";
pub(crate) const VAULT_WASM: &str = "../../target/wasm32-gear/release/vault_app.opt.wasm";

pub(crate) const ADMIN_ID: u64 = 100;
pub(crate) const BUYER_ID: u64 = 101;
pub(crate) const TOKEN_BASE: Address = Address::from_bytes([11u8; 20]);
pub(crate) const TOKEN_QUOTE: Address = Address::from_bytes([12u8; 20]);

fn buyer() -> Address {
    Address::from(BUYER_ID)
}

async fn setup_programs() -> (GtestEnv, ActorId, ActorId, ActorId) {
    let system = System::new();
    system.init_logger();
    system.mint_to(ADMIN_ID, 100_000_000_000_000_000);
    system.mint_to(BUYER_ID, 100_000_000_000_000_000);

    let remoting = GtestEnv::new(system, ADMIN_ID.into());
    let system_ref = remoting.system();

    // Vault Deployments (Raw) - per-token
    let base_vault_program = Program::from_file(system_ref, VAULT_WASM);
    let base_vault_id = base_vault_program.id();
    let base_ctor = ("Create", (ActorId::from(TOKEN_BASE),)).encode();
    base_vault_program.send_bytes(ADMIN_ID, base_ctor);

    let quote_vault_program = Program::from_file(system_ref, VAULT_WASM);
    let quote_vault_id = quote_vault_program.id();
    let quote_ctor = ("Create", (ActorId::from(TOKEN_QUOTE),)).encode();
    quote_vault_program.send_bytes(ADMIN_ID, quote_ctor);

    // OrderBook Deployment (Client)
    let code_orderbook = system_ref.submit_code_file(ORDERBOOK_WASM);
    let orderbook_actor = Deployment::<OrderbookProgram, _>::new(
        remoting.clone(),
        code_orderbook,
        b"book_salt".to_vec(),
    )
    .create(
        oc_id(base_vault_id),
        oc_id(quote_vault_id),
        orderbook_client::Address(TOKEN_BASE.0),
        orderbook_client::Address(TOKEN_QUOTE.0),
        1000,
        1000,
    )
    .await
    .unwrap();
    let orderbook_id = orderbook_actor.id();

    // Vault: add_market (Raw)
    let payload = ("Vault", "AddMarket", (oc_id(orderbook_id))).encode();
    let base_prg = system_ref
        .get_program(base_vault_id)
        .expect("Base vault program not found");
    let mid = base_prg.send_bytes(ADMIN_ID, payload.clone());
    let res = system_ref.run_next_block();
    assert!(res.succeed.contains(&mid), "add_market failed (base)");

    let quote_prg = system_ref
        .get_program(quote_vault_id)
        .expect("Quote vault program not found");
    let mid = quote_prg.send_bytes(ADMIN_ID, payload);
    let res = system_ref.run_next_block();
    assert!(res.succeed.contains(&mid), "add_market failed (quote)");

    (remoting, base_vault_id, quote_vault_id, orderbook_id)
}

fn orderbook_service_for(
    remoting: &GtestEnv,
    orderbook_id: ActorId,
    trader: ActorId,
) -> Service<OrderbookImpl, GtestEnv> {
    Service::<OrderbookImpl, _>::new(
        remoting.clone().with_actor_id(trader),
        orderbook_id,
        "Orderbook",
    )
}

// Helper for raw vault calls
fn send_vault(system: &System, from: u64, vault_id: ActorId, method: &str, args: impl Encode) {
    let payload = ("Vault", method, args).encode();
    let program = system
        .get_program(vault_id)
        .expect("Vault program not found");
    let mid = program.send_bytes(from, payload);
    let res = system.run_next_block();
    assert!(res.succeed.contains(&mid), "Vault call {} failed", method);
}

// Helper for raw vault calls that expect error
fn send_vault_fail(system: &System, from: u64, vault_id: ActorId, method: &str, args: impl Encode) {
    let payload = ("Vault", method, args).encode();
    let program = system
        .get_program(vault_id)
        .expect("Vault program not found");
    let mid = program.send_bytes(from, payload);
    let res = system.run_next_block();
    assert!(
        !res.succeed.contains(&mid),
        "Vault call {} succeeded but should fail",
        method
    );
}

#[tokio::test]
async fn test_transfer_to_market_insufficient_funds() {
    let (remoting, _base_vault_id, quote_vault_id, orderbook_id) = setup_programs().await;
    let system = remoting.system();

    // Deposit 100
    send_vault(
        system,
        ADMIN_ID,
        quote_vault_id,
        "VaultDeposit",
        (buyer(), 100u128),
    );

    // Try to transfer 200 (fails)
    send_vault_fail(
        system,
        BUYER_ID,
        quote_vault_id,
        "TransferToMarket",
        (orderbook_id, 200u128),
    );
}

#[tokio::test]
async fn test_orderbook_deposit_unauthorized_direct() {
    let (remoting, _base_vault_id, _quote_vault_id, orderbook_id) = setup_programs().await;
    let mut orderbook_buyer = orderbook_service_for(&remoting, orderbook_id, BUYER_ID.into());

    // Buyer tries to call deposit directly on OrderBook (fails)
    orderbook_buyer
        .deposit(
            oc_id(BUYER_ID.into()),
            orderbook_client::Address(TOKEN_QUOTE.0),
            100u128,
        )
        .await
        .unwrap_err();
}

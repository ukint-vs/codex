use clob_common::{eth_to_actor, TokenId};
use orderbook_client::orderbook::Orderbook; // Explicit trait import
use orderbook_client::{orderbook::OrderbookImpl, OrderbookCtors, OrderbookProgram};
use sails_rs::{
    client::{Deployment, GtestEnv, Service},
    gtest::{Program, System},
    hex,
    prelude::*,
    ActorId,
};

pub(crate) const ORDERBOOK_WASM: &str = "../../target/wasm32-gear/release/orderbook.opt.wasm";
pub(crate) const VAULT_WASM: &str = "../../target/wasm32-gear/release/vault_app.opt.wasm";

pub(crate) const ADMIN_ID: u64 = 100;
pub(crate) const BUYER_ID: u64 = 101;
pub(crate) const TOKEN_BASE: TokenId = [11u8; 20];
pub(crate) const TOKEN_QUOTE: TokenId = [12u8; 20];

fn buyer() -> ActorId {
    ActorId::from(BUYER_ID)
}

async fn setup_programs() -> (GtestEnv, ActorId, ActorId, ActorId) {
    let system = System::new();
    system.init_logger();
    system.mint_to(ADMIN_ID, 100_000_000_000_000_000);
    system.mint_to(buyer(), 100_000_000_000_000_000);

    let remoting = GtestEnv::new(system, ADMIN_ID.into());
    let system_ref = remoting.system();

    // Vault Deployments (Raw) - per-token
    let base_vault_program = Program::from_file(system_ref, VAULT_WASM);
    let base_vault_id = base_vault_program.id();
    let base_ctor = ("Create", (eth_to_actor(TOKEN_BASE),)).encode();
    base_vault_program.send_bytes(ADMIN_ID, base_ctor);

    let quote_vault_program = Program::from_file(system_ref, VAULT_WASM);
    let quote_vault_id = quote_vault_program.id();
    let quote_ctor = ("Create", (eth_to_actor(TOKEN_QUOTE),)).encode();
    quote_vault_program.send_bytes(ADMIN_ID, quote_ctor);

    // OrderBook Deployment (Client)
    let code_orderbook = system_ref.submit_code_file(ORDERBOOK_WASM);
    let orderbook_actor = Deployment::<OrderbookProgram, _>::new(
        remoting.clone(),
        code_orderbook,
        b"book_salt".to_vec(),
    )
    .create(
        base_vault_id,
        quote_vault_id,
        TOKEN_BASE,
        TOKEN_QUOTE,
        1000,
        1000,
    )
    .await
    .unwrap();
    let orderbook_id = orderbook_actor.id();

    // Vault: add_market (Raw)
    let payload = ("Vault", "AddMarket", (orderbook_id)).encode();
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

// Helper to query vault balance
fn get_vault_balance(system: &System, vault_id: ActorId, user: ActorId) -> u128 {
    let payload = ("Vault", "GetBalance", (user,)).encode();
    let program = system
        .get_program(vault_id)
        .expect("Vault program not found");
    let mid = program.send_bytes(ADMIN_ID, payload);
    let res = system.run_next_block();
    assert!(res.succeed.contains(&mid));

    // Find the reply
    let log = res
        .log
        .iter()
        .find(|l| l.destination() == ADMIN_ID.into() && l.source() == vault_id)
        .expect("No reply log found");

    // Try to decode with Service/Method wrapper first
    if let Ok((_, _, available)) = <(String, String, u128)>::decode(&mut log.payload()) {
        return available;
    }

    // Try raw
    <u128>::decode(&mut log.payload()).unwrap_or_else(|_| {
        println!(
            "Failed to decode payload: {:?} (Hex: {})",
            log.payload(),
            hex::encode(log.payload())
        );
        std::panic!("Failed to decode Balance");
    })
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
async fn test_withdraw_to_vault_insufficient_funds() {
    let (remoting, _base_vault_id, quote_vault_id, orderbook_id) = setup_programs().await;
    let system = remoting.system();
    let mut orderbook_buyer = orderbook_service_for(&remoting, orderbook_id, buyer());

    // Deposit and Transfer 100 to OrderBook
    send_vault(
        system,
        ADMIN_ID,
        quote_vault_id,
        "VaultDeposit",
        (buyer(), 100u128),
    );
    send_vault(
        system,
        BUYER_ID,
        quote_vault_id,
        "TransferToMarket",
        (orderbook_id, 100u128),
    );

    // Try to withdraw 200 from OrderBook (fails)
    orderbook_buyer.withdraw_quote(200u128).await.unwrap_err();
}

#[tokio::test]
async fn test_orderbook_deposit_unauthorized_direct() {
    let (remoting, _base_vault_id, _quote_vault_id, orderbook_id) = setup_programs().await;
    let mut orderbook_buyer = orderbook_service_for(&remoting, orderbook_id, buyer());

    // Buyer tries to call deposit directly on OrderBook (fails)
    orderbook_buyer
        .deposit(buyer(), TOKEN_QUOTE, 100u128)
        .await
        .unwrap_err();
}

#[tokio::test]
async fn test_full_cycle_consistency() {
    let (remoting, _base_vault_id, quote_vault_id, orderbook_id) = setup_programs().await;
    let system = remoting.system();
    let mut orderbook_buyer = orderbook_service_for(&remoting, orderbook_id, buyer());

    // 1. Deposit to Vault
    send_vault(
        system,
        ADMIN_ID,
        quote_vault_id,
        "VaultDeposit",
        (buyer(), 1000u128),
    );

    // 2. Push to OrderBook
    send_vault(
        system,
        BUYER_ID,
        quote_vault_id,
        "TransferToMarket",
        (orderbook_id, 400u128),
    );

    // Check balances
    let v_avail = get_vault_balance(system, quote_vault_id, buyer());
    let (ob_base, ob_quote) = orderbook_buyer.balance_of(buyer()).await.unwrap();
    assert_eq!(v_avail, 600);
    assert_eq!(ob_base, 0);
    assert_eq!(ob_quote, 400);

    // 3. Withdraw back to Vault
    orderbook_buyer.withdraw_quote(150u128).await.unwrap();

    // Check balances
    let v_avail_after = get_vault_balance(system, quote_vault_id, buyer());
    let (ob_base_after, ob_quote_after) = orderbook_buyer.balance_of(buyer()).await.unwrap();
    assert_eq!(v_avail_after, 750);
    assert_eq!(ob_base_after, 0);
    assert_eq!(ob_quote_after, 250);
}

#[tokio::test]
async fn test_transfer_to_market_rolls_back_when_market_does_not_reply() {
    let (remoting, base_vault_id, quote_vault_id, _orderbook_id) = setup_programs().await;
    let system = remoting.system();

    send_vault(
        system,
        ADMIN_ID,
        quote_vault_id,
        "VaultDeposit",
        (buyer(), 1000u128),
    );

    // Use a non-orderbook target: Vault will send an Orderbook::Deposit payload to a vault
    // program, which must not ACK the orderbook deposit call.
    let bad_orderbook = base_vault_id;

    send_vault(
        system,
        ADMIN_ID,
        quote_vault_id,
        "AddMarket",
        (bad_orderbook,),
    );

    // This call targets a non-orderbook program. No valid deposit ACK is produced,
    // and vault must roll balances back.
    send_vault(
        system,
        BUYER_ID,
        quote_vault_id,
        "TransferToMarket",
        (bad_orderbook, 400u128),
    );

    // Async reply handling can land in later blocks; wait until rollback is observed.
    let mut final_avail = 0u128;
    for _ in 0..20 {
        system.run_next_block();
        final_avail = get_vault_balance(system, quote_vault_id, buyer());
        if final_avail == 1000u128 {
            break;
        }
    }

    assert_eq!(
        final_avail, 1000u128,
        "Expected rollback to restore available funds"
    );
}

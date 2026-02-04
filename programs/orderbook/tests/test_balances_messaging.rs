use clob_common::TokenId;
use orderbook_client::order_book::OrderBook; // Explicit trait import
use orderbook_client::{order_book::OrderBookImpl, OrderbookCtors, OrderbookProgram};
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

async fn setup_programs() -> (GtestEnv, ActorId, ActorId) {
    let system = System::new();
    system.init_logger();
    system.mint_to(ADMIN_ID, 100_000_000_000_000_000);
    system.mint_to(buyer(), 100_000_000_000_000_000);

    let remoting = GtestEnv::new(system, ADMIN_ID.into());
    let system_ref = remoting.system();

    // Vault Deployment (Raw)
    let vault_program = Program::from_file(system_ref, VAULT_WASM);
    let vault_id = vault_program.id();
    let encoded_ctor = ("Create", ()).encode();
    vault_program.send_bytes(ADMIN_ID, encoded_ctor);

    // OrderBook Deployment (Client)
    let code_orderbook = system_ref.submit_code_file(ORDERBOOK_WASM);
    let orderbook_actor = Deployment::<OrderbookProgram, _>::new(
        remoting.clone(),
        code_orderbook,
        b"book_salt".to_vec(),
    )
    .create(vault_id)
    .await
    .unwrap();
    let orderbook_id = orderbook_actor.id();

    // Vault: add_market (Raw)
    let payload = ("Vault", "AddMarket", (orderbook_id)).encode();
    let vault_prg = system_ref
        .get_program(vault_id)
        .expect("Vault program not found");
    let mid = vault_prg.send_bytes(ADMIN_ID, payload);
    let res = system_ref.run_next_block();
    assert!(res.succeed.contains(&mid), "add_market failed");

    (remoting, vault_id, orderbook_id)
}

fn orderbook_service_for(
    remoting: &GtestEnv,
    orderbook_id: ActorId,
    trader: ActorId,
) -> Service<OrderBookImpl, GtestEnv> {
    Service::<OrderBookImpl, _>::new(
        remoting.clone().with_actor_id(trader),
        orderbook_id,
        "OrderBook".into(),
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
fn get_vault_balance(
    system: &System,
    vault_id: ActorId,
    user: ActorId,
    token: TokenId,
) -> (u128, u128) {
    let payload = ("Vault", "GetBalance", (user, token)).encode();
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
    match <(String, String, (u128, u128))>::decode(&mut log.payload()) {
        Ok((_, _, (avail, reserved))) => return (avail, reserved),
        Err(_) => {}
    }

    // Try raw
    match <(u128, u128)>::decode(&mut log.payload()) {
        Ok((avail, reserved)) => return (avail, reserved),
        Err(_) => {
            println!(
                "Failed to decode payload: {:?} (Hex: {})",
                log.payload(),
                hex::encode(log.payload())
            );
            std::panic!("Failed to decode Balance");
        }
    }
}

#[tokio::test]
async fn test_transfer_to_market_insufficient_funds() {
    let (remoting, vault_id, orderbook_id) = setup_programs().await;
    let system = remoting.system();

    // Deposit 100
    send_vault(
        system,
        BUYER_ID,
        vault_id,
        "VaultDeposit",
        (buyer(), TOKEN_QUOTE, 100u128),
    );

    // Try to transfer 200 (fails)
    send_vault_fail(
        system,
        BUYER_ID,
        vault_id,
        "TransferToMarket",
        (orderbook_id, TOKEN_QUOTE, 200u128),
    );
}

#[tokio::test]
async fn test_withdraw_to_vault_insufficient_funds() {
    let (remoting, vault_id, orderbook_id) = setup_programs().await;
    let system = remoting.system();
    let mut orderbook_buyer = orderbook_service_for(&remoting, orderbook_id, buyer());

    // Deposit and Transfer 100 to OrderBook
    send_vault(
        system,
        BUYER_ID,
        vault_id,
        "VaultDeposit",
        (buyer(), TOKEN_QUOTE, 100u128),
    );
    send_vault(
        system,
        BUYER_ID,
        vault_id,
        "TransferToMarket",
        (orderbook_id, TOKEN_QUOTE, 100u128),
    );

    // Try to withdraw 200 from OrderBook (fails)
    orderbook_buyer
        .withdraw_to_vault(TOKEN_QUOTE, 200u128)
        .await
        .unwrap_err();
}

#[tokio::test]
async fn test_orderbook_deposit_unauthorized_direct() {
    let (remoting, _vault_id, orderbook_id) = setup_programs().await;
    let mut orderbook_buyer = orderbook_service_for(&remoting, orderbook_id, buyer());

    // Buyer tries to call deposit directly on OrderBook (fails)
    orderbook_buyer
        .deposit(buyer(), TOKEN_QUOTE, 100u128)
        .await
        .unwrap_err();
}

#[tokio::test]
async fn test_full_cycle_consistency() {
    let (remoting, vault_id, orderbook_id) = setup_programs().await;
    let system = remoting.system();
    let mut orderbook_buyer = orderbook_service_for(&remoting, orderbook_id, buyer());

    // 1. Deposit to Vault
    send_vault(
        system,
        BUYER_ID,
        vault_id,
        "VaultDeposit",
        (buyer(), TOKEN_QUOTE, 1000u128),
    );

    // 2. Push to OrderBook
    send_vault(
        system,
        BUYER_ID,
        vault_id,
        "TransferToMarket",
        (orderbook_id, TOKEN_QUOTE, 400u128),
    );

    // Check balances
    let (v_avail, _) = get_vault_balance(system, vault_id, buyer(), TOKEN_QUOTE);
    let ob_bal = orderbook_buyer
        .get_balance(buyer(), TOKEN_QUOTE)
        .await
        .unwrap();
    assert_eq!(v_avail, 600);
    assert_eq!(ob_bal, 400);

    // 3. Withdraw back to Vault
    orderbook_buyer
        .withdraw_to_vault(TOKEN_QUOTE, 150u128)
        .await
        .unwrap();

    // Check balances
    let (v_avail_after, _) = get_vault_balance(system, vault_id, buyer(), TOKEN_QUOTE);
    let ob_bal_after = orderbook_buyer
        .get_balance(buyer(), TOKEN_QUOTE)
        .await
        .unwrap();
    assert_eq!(v_avail_after, 750);
    assert_eq!(ob_bal_after, 250);
}

#[tokio::test]
async fn test_pause_and_emergency_exit() {
    let (remoting, vault_id, orderbook_id) = setup_programs().await;
    let system = remoting.system();
    let mut orderbook_buyer = orderbook_service_for(&remoting, orderbook_id, buyer());
    let mut orderbook_admin =
        orderbook_service_for(&remoting, orderbook_id, ActorId::from(ADMIN_ID));

    // 1. Initial funding
    send_vault(
        system,
        BUYER_ID,
        vault_id,
        "VaultDeposit",
        (buyer(), TOKEN_QUOTE, 1000u128),
    );
    send_vault(
        system,
        BUYER_ID,
        vault_id,
        "TransferToMarket",
        (orderbook_id, TOKEN_QUOTE, 1000u128),
    );

    // 2. Pause the program (Admin only)
    orderbook_admin.pause(true).await.unwrap();

    // 3. Normal withdraw should fail
    orderbook_buyer
        .withdraw_to_vault(TOKEN_QUOTE, 100u128)
        .await
        .unwrap_err();

    // 4. Emergency withdraw should work
    orderbook_buyer
        .register_emergency_exit(TOKEN_QUOTE, 600u128)
        .await
        .unwrap();

    // Check internal balance (1000 - 600 = 400)
    let ob_bal = orderbook_buyer
        .get_balance(buyer(), TOKEN_QUOTE)
        .await
        .unwrap();
    assert_eq!(ob_bal, 400);

    // 5. Unpause
    orderbook_admin.pause(false).await.unwrap();

    // 6. Normal withdraw should work again
    orderbook_buyer
        .withdraw_to_vault(TOKEN_QUOTE, 400u128)
        .await
        .unwrap();

    let ob_bal_final = orderbook_buyer
        .get_balance(buyer(), TOKEN_QUOTE)
        .await
        .unwrap();
    assert_eq!(ob_bal_final, 0);
}

use clob_common::TokenId;
use orderbook_client::{
    order_book::OrderBookImpl, OrderbookCtors, OrderbookProgram,
};
use orderbook_client::order_book::OrderBook; // Explicit trait import
use sails_rs::{
    client::{Deployment, GtestEnv, Service},
    gtest::{Program, System},
    prelude::*,
    ActorId,
};

pub(crate) const ORDERBOOK_WASM: &str = "../../target/wasm32-gear/release/orderbook.opt.wasm";
pub(crate) const VAULT_WASM: &str = "../../target/wasm32-gear/release/vault_app.opt.wasm";

pub(crate) const ADMIN_ID: u64 = 100;
pub(crate) const BUYER_ID: u64 = 101;
pub(crate) const SELLER_ID: u64 = 102;
pub(crate) const TOKEN_BASE: TokenId = [11u8; 20];
pub(crate) const TOKEN_QUOTE: TokenId = [12u8; 20];

fn buyer() -> ActorId {
    ActorId::from(BUYER_ID)
}

fn seller() -> ActorId {
    ActorId::from(SELLER_ID)
}

async fn setup_programs() -> (GtestEnv, ActorId, ActorId) {
    let system = System::new();
    system.init_logger();
    system.mint_to(ADMIN_ID, 100_000_000_000_000_000);
    system.mint_to(buyer(), 100_000_000_000_000_000);
    system.mint_to(seller(), 100_000_000_000_000_000);

    let remoting = GtestEnv::new(system, ADMIN_ID.into());
    let system_ref = remoting.system();

    // Vault Deployment (Raw)
    let vault_program = Program::from_file(system_ref, VAULT_WASM);
    let vault_id = vault_program.id();
    let encoded_ctor = ("Create", ()).encode();
    let mid = vault_program.send_bytes(ADMIN_ID, encoded_ctor);
    let res = system_ref.run_next_block();
    assert!(res.succeed.contains(&mid), "Vault init failed");

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
    let vault_prg = system_ref.get_program(vault_id).expect("Vault program not found");
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
    let program = system.get_program(vault_id).expect("Vault program not found");
    let mid = program.send_bytes(from, payload);
    let res = system.run_next_block();
    assert!(res.succeed.contains(&mid), "Vault call {} failed", method);
}

#[tokio::test]
async fn test_batching_continuation() {
    let (remoting, vault_id, orderbook_id) = setup_programs().await;
    let system = remoting.system();
    let mut orderbook_seller = orderbook_service_for(&remoting, orderbook_id, seller());
    let mut orderbook_buyer = orderbook_service_for(&remoting, orderbook_id, buyer());

    // Fund Seller and Transfer Base
    send_vault(system, SELLER_ID, vault_id, "VaultDeposit", (seller(), TOKEN_BASE, 1000u128));
    send_vault(system, SELLER_ID, vault_id, "TransferToMarket", (orderbook_id, TOKEN_BASE, 1000u128));

    // Fund Buyer and Transfer Quote
    send_vault(system, BUYER_ID, vault_id, "VaultDeposit", (buyer(), TOKEN_QUOTE, 100000u128));
    send_vault(system, BUYER_ID, vault_id, "TransferToMarket", (orderbook_id, TOKEN_QUOTE, 100000u128));

    // Place 70 Sell orders (Makers) @ 100
    for _ in 0..70 {
        orderbook_seller
            .place_order(100u128, 1u128, false, TOKEN_BASE, TOKEN_QUOTE)
            .await
            .unwrap();
    }

    // Place 1 Buy order (Taker) for 70 @ 100
    // Should match 50, then trigger continuation for remaining 20.
    orderbook_buyer
        .place_order(100u128, 70u128, true, TOKEN_BASE, TOKEN_QUOTE)
        .await
        .unwrap();

    let buy_order_id = 71;
    let (found, _, _, _, qty) = orderbook_buyer.get_order(buy_order_id).await.unwrap();

    if found {
        println!("Order partially filled, remaining qty: {}", qty);
        assert_eq!(qty, 0, "Expected order to be fully filled via continuation");
    } else {
        println!("Order fully filled (or not found)");
    }
}

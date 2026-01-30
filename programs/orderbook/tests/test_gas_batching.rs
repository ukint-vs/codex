use clob_common::TokenId;
use orderbook_client::{
    order_book::OrderBook as OrderBookServiceTrait, order_book::OrderBookImpl, OrderbookCtors,
    OrderbookProgram,
};
use sails_rs::{
    client::{Deployment, GtestEnv, Service},
    gtest::System,
    prelude::*,
    ActorId,
};
use vault_client::{vault::Vault as VaultServiceTrait, vault::VaultImpl, VaultCtors, VaultProgram};

pub(crate) const ORDERBOOK_WASM: &str = "../../target/wasm32-gear/release/orderbook.opt.wasm";
pub(crate) const VAULT_WASM: &str = "../../target/wasm32-gear/release/vault_app.opt.wasm";

pub(crate) const ADMIN_ID: u64 = 10;
pub(crate) const BUYER_ID: u64 = 1;
pub(crate) const SELLER_ID: u64 = 2;
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

    let code_vault = system.submit_code_file(VAULT_WASM);
    let remoting = GtestEnv::new(system, ADMIN_ID.into());

    let vault_actor =
        Deployment::<VaultProgram, _>::new(remoting.clone(), code_vault, b"vault_salt".to_vec())
            .create()
            .await
            .unwrap();
    let vault_id = vault_actor.id();

    let code_orderbook = remoting.system().submit_code_file(ORDERBOOK_WASM);
    let orderbook_actor = Deployment::<OrderbookProgram, _>::new(
        remoting.clone(),
        code_orderbook,
        b"book_salt".to_vec(),
    )
    .create(vault_id)
    .await
    .unwrap();
    let orderbook_id = orderbook_actor.id();

    let mut vault_service =
        Service::<VaultImpl, _>::new(remoting.clone(), vault_id, "Vault".into());
    vault_service.add_market(orderbook_id).await.unwrap();

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

#[tokio::test]
async fn test_batching_continuation() {
    let (remoting, vault_id, orderbook_id) = setup_programs().await;
    let mut vault_service =
        Service::<VaultImpl, _>::new(remoting.clone(), vault_id, "Vault".into());
    let mut orderbook_seller = orderbook_service_for(&remoting, orderbook_id, seller());
    let mut orderbook_buyer = orderbook_service_for(&remoting, orderbook_id, buyer());

    // Fund
    vault_service
        .vault_deposit(seller(), TOKEN_BASE, 1000u128)
        .await
        .unwrap();
    vault_service
        .vault_deposit(buyer(), TOKEN_QUOTE, 100000u128)
        .await
        .unwrap();

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
        // If gtest runs fully, we expect 0.
        // If gtest stops after 1 batch, we expect 20.
        // Based on previous run, it likely runs fully or until gas limit.
        // 70 should be well within gas limit if 129 passed.
        assert_eq!(qty, 0, "Expected order to be fully filled via continuation");
    } else {
        println!("Order fully filled (or not found)");
        // Success
    }
}

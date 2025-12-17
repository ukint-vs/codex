use clob_common::{actor_to_eth, TokenId};
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
pub(crate) const ETH_CALLER_ID: u64 = 99;
pub(crate) const TOKEN_BASE: TokenId = [11u8; 20];
pub(crate) const TOKEN_QUOTE: TokenId = [12u8; 20];

fn buyer() -> ActorId {
    ActorId::from(BUYER_ID)
}

fn seller() -> ActorId {
    ActorId::from(SELLER_ID)
}

fn eth_caller() -> ActorId {
    ActorId::from(ETH_CALLER_ID)
}

/// Helper to deploy Vault and OrderBook and authorize the book in the vault.
async fn setup_programs() -> (GtestEnv, ActorId, ActorId) {
    let system = System::new();
    system.init_logger();
    system.mint_to(ADMIN_ID, 100_000_000_000_000_000);
    // Fund trader actor IDs so gtest can send messages.
    system.mint_to(buyer(), 100_000_000_000_000_000);
    system.mint_to(seller(), 100_000_000_000_000_000);
    system.mint_to(eth_caller(), 100_000_000_000_000_000);

    let code_vault = system.submit_code_file(VAULT_WASM);
    let remoting = GtestEnv::new(system, ADMIN_ID.into());

    // Deploy Vault
    let vault_actor =
        Deployment::<VaultProgram, _>::new(remoting.clone(), code_vault, b"vault_salt".to_vec())
            .create()
            .await
            .unwrap();
    let vault_id = vault_actor.id();

    // Deploy OrderBook passing the vault_id
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

    // Authorize OrderBook in Vault
    let mut vault_service =
        Service::<VaultImpl, _>::new(remoting.clone(), vault_id, "Vault".into());
    vault_service.add_market(orderbook_id).await.unwrap();

    let mut orderbook_admin =
        Service::<OrderBookImpl, _>::new(remoting.clone(), orderbook_id, "OrderBook".into());
    orderbook_admin
        .set_eth_orderbook_caller(eth_caller())
        .await
        .unwrap();

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
async fn place_order_reserves_funds() {
    let (remoting, vault_id, orderbook_id) = setup_programs().await;
    let mut vault_service =
        Service::<VaultImpl, _>::new(remoting.clone(), vault_id, "Vault".into());
    let mut orderbook_buyer = orderbook_service_for(&remoting, orderbook_id, buyer());

    // Fund buyer and seller in Vault
    vault_service
        .vault_deposit(buyer(), TOKEN_QUOTE, 2_000u128)
        .await
        .unwrap();

    vault_service
        .vault_deposit(seller(), TOKEN_BASE, 10u128)
        .await
        .unwrap();
    let (buyer_avail, buyer_res) = vault_service
        .get_balance(buyer(), TOKEN_QUOTE)
        .await
        .unwrap();
    assert_eq!(buyer_avail, 2_000);
    assert_eq!(buyer_res, 0);
    let (seller_avail, seller_res) = vault_service
        .get_balance(seller(), TOKEN_BASE)
        .await
        .unwrap();
    assert_eq!(seller_avail, 10);
    assert_eq!(seller_res, 0);

    // Place a buy order; should reserve funds via Vault
    orderbook_buyer
        .place_order(100u128, 5u128, true, TOKEN_BASE, TOKEN_QUOTE)
        .await
        .unwrap();
}

#[tokio::test]
async fn cancel_order_unlocks_funds() {
    let (remoting, vault_id, orderbook_id) = setup_programs().await;
    let mut vault_service =
        Service::<VaultImpl, _>::new(remoting.clone(), vault_id, "Vault".into());
    let mut orderbook_buyer = orderbook_service_for(&remoting, orderbook_id, buyer());

    // Fund buyer in Vault
    vault_service
        .vault_deposit(buyer(), TOKEN_QUOTE, 1_000u128)
        .await
        .unwrap();

    // Place a buy order (order_id will be 1)
    orderbook_buyer
        .place_order(50u128, 2u128, true, TOKEN_BASE, TOKEN_QUOTE)
        .await
        .unwrap();

    // Cancel the order and expect unlock to succeed
    orderbook_buyer
        .cancel_order(1u128, TOKEN_BASE, TOKEN_QUOTE)
        .await
        .unwrap();
}

#[tokio::test]
async fn test_settle_trade() {
    let (remoting, vault_id, orderbook_id) = setup_programs().await;
    let mut vault_service =
        Service::<VaultImpl, _>::new(remoting.clone(), vault_id, "Vault".into());
    let mut orderbook_seller = orderbook_service_for(&remoting, orderbook_id, seller());
    let mut orderbook_buyer = orderbook_service_for(&remoting, orderbook_id, buyer());

    // 1. Configure Vault Fee
    vault_service.update_fee_rate(30u128).await.unwrap();

    // 2. Fund Users
    vault_service
        .vault_deposit(buyer(), TOKEN_QUOTE, 1000u128)
        .await
        .unwrap();
    vault_service
        .vault_deposit(seller(), TOKEN_BASE, 10u128)
        .await
        .unwrap();

    // 3. Place Sell Order (Maker)
    orderbook_seller
        .place_order(100u128, 10u128, false, TOKEN_BASE, TOKEN_QUOTE)
        .await
        .unwrap();

    // 4. Place Buy Order (Taker)
    orderbook_buyer
        .place_order(100u128, 10u128, true, TOKEN_BASE, TOKEN_QUOTE)
        .await
        .unwrap();

    // Assert orders consumed
    assert_eq!(orderbook_buyer.order_counter().await.unwrap(), 2);
    let best_bid = orderbook_buyer.best_bid().await.unwrap();
    let best_ask = orderbook_buyer.best_ask().await.unwrap();
    assert_eq!(best_bid.0, false);
    assert_eq!(best_ask.0, false);
}

#[tokio::test]
async fn place_order_fails_without_balance() {
    let (remoting, _vault_id, orderbook_id) = setup_programs().await;
    let mut orderbook_buyer = orderbook_service_for(&remoting, orderbook_id, buyer());

    // No deposits; reserve should fail and surface an error
    orderbook_buyer
        .place_order(1_000u128, 1_000u128, true, TOKEN_BASE, TOKEN_QUOTE)
        .await
        .unwrap_err();
}

#[tokio::test]
async fn place_order_eth_reserves_funds() {
    let (remoting, vault_id, orderbook_id) = setup_programs().await;
    let mut vault_service =
        Service::<VaultImpl, _>::new(remoting.clone(), vault_id, "Vault".into());
    let mut orderbook_eth = orderbook_service_for(&remoting, orderbook_id, eth_caller());

    vault_service
        .vault_deposit(buyer(), TOKEN_QUOTE, 1_000u128)
        .await
        .unwrap();

    let user = actor_to_eth(buyer());
    orderbook_eth
        .place_order_eth(user, 100u128, 5u128, true, TOKEN_BASE, TOKEN_QUOTE)
        .await
        .unwrap();

    let (avail, reserved) = vault_service
        .get_balance(buyer(), TOKEN_QUOTE)
        .await
        .unwrap();
    assert_eq!(avail, 500);
    assert_eq!(reserved, 500);
}

#[tokio::test]
async fn place_order_eth_requires_authorized_caller() {
    let (remoting, vault_id, orderbook_id) = setup_programs().await;
    let mut vault_service =
        Service::<VaultImpl, _>::new(remoting.clone(), vault_id, "Vault".into());
    let mut orderbook_buyer = orderbook_service_for(&remoting, orderbook_id, buyer());

    vault_service
        .vault_deposit(buyer(), TOKEN_QUOTE, 1_000u128)
        .await
        .unwrap();

    let user = actor_to_eth(buyer());
    orderbook_buyer
        .place_order_eth(user, 100u128, 5u128, true, TOKEN_BASE, TOKEN_QUOTE)
        .await
        .unwrap_err();
}

#[tokio::test]
async fn test_partial_match() {
    let (remoting, vault_id, orderbook_id) = setup_programs().await;
    let mut vault_service =
        Service::<VaultImpl, _>::new(remoting.clone(), vault_id, "Vault".into());
    let mut orderbook_seller = orderbook_service_for(&remoting, orderbook_id, seller());
    let mut orderbook_buyer = orderbook_service_for(&remoting, orderbook_id, buyer());

    vault_service
        .vault_deposit(buyer(), TOKEN_QUOTE, 2000u128)
        .await
        .unwrap();
    vault_service
        .vault_deposit(seller(), TOKEN_BASE, 20u128)
        .await
        .unwrap();

    // Sell 20 @ 100
    orderbook_seller
        .place_order(100u128, 20u128, false, TOKEN_BASE, TOKEN_QUOTE)
        .await
        .unwrap();

    // Buy 5 @ 100
    orderbook_buyer
        .place_order(100u128, 5u128, true, TOKEN_BASE, TOKEN_QUOTE)
        .await
        .unwrap();

    // Best ask should now be 15 @ 100
    let best_ask = orderbook_buyer.best_ask().await.unwrap();
    assert_eq!(best_ask, (true, 100u128, 15u128));

    // Best bid should be empty
    let best_bid = orderbook_buyer.best_bid().await.unwrap();
    assert_eq!(best_bid.0, false);
}

#[tokio::test]
async fn test_price_priority() {
    let (remoting, vault_id, orderbook_id) = setup_programs().await;
    let mut vault_service =
        Service::<VaultImpl, _>::new(remoting.clone(), vault_id, "Vault".into());
    let mut orderbook_seller = orderbook_service_for(&remoting, orderbook_id, seller());
    let mut orderbook_buyer = orderbook_service_for(&remoting, orderbook_id, buyer());

    vault_service
        .vault_deposit(seller(), TOKEN_BASE, 20u128)
        .await
        .unwrap();
    vault_service
        .vault_deposit(buyer(), TOKEN_QUOTE, 2000u128)
        .await
        .unwrap();

    // Sell 10 @ 110 (worse price)
    orderbook_seller
        .place_order(110u128, 10u128, false, TOKEN_BASE, TOKEN_QUOTE)
        .await
        .unwrap();

    // Sell 10 @ 100 (better price)
    orderbook_seller
        .place_order(100u128, 10u128, false, TOKEN_BASE, TOKEN_QUOTE)
        .await
        .unwrap();

    // Buy 10 @ 110. Should match with 100 first.
    orderbook_buyer
        .place_order(110u128, 10u128, true, TOKEN_BASE, TOKEN_QUOTE)
        .await
        .unwrap();

    // Best ask should now be 10 @ 110
    let best_ask = orderbook_buyer.best_ask().await.unwrap();
    assert_eq!(best_ask, (true, 110u128, 10u128));
}

#[tokio::test]
async fn test_taker_price_improvement_leak() {
    let (remoting, vault_id, orderbook_id) = setup_programs().await;
    let mut vault_service =
        Service::<VaultImpl, _>::new(remoting.clone(), vault_id, "Vault".into());
    let mut orderbook_seller = orderbook_service_for(&remoting, orderbook_id, seller());
    let mut orderbook_buyer = orderbook_service_for(&remoting, orderbook_id, buyer());

    // Seller has 10 Base
    vault_service
        .vault_deposit(seller(), TOKEN_BASE, 10u128)
        .await
        .unwrap();
    // Buyer has 1000 Quote
    vault_service
        .vault_deposit(buyer(), TOKEN_QUOTE, 1000u128)
        .await
        .unwrap();

    // 1. Maker Sell Order: 10 @ 80
    orderbook_seller
        .place_order(80u128, 10u128, false, TOKEN_BASE, TOKEN_QUOTE)
        .await
        .unwrap();

    // 2. Taker Buy Order: 10 @ 100 (should unlock improvement)
    orderbook_buyer
        .place_order(100u128, 10u128, true, TOKEN_BASE, TOKEN_QUOTE)
        .await
        .unwrap();

    // Check Buyer Balance in Quote Token
    let (available, reserved) = vault_service
        .get_balance(buyer(), TOKEN_QUOTE)
        .await
        .unwrap();
    assert_eq!(
        reserved, 0,
        "Reserved funds leaked in vault! (Expected 0, found {})",
        reserved
    );
    assert_eq!(
        available, 200,
        "Price improvement not returned to available balance! (Expected 200, found {})",
        available
    );
}

#[tokio::test]
async fn test_full_e2e_flow() {
    let (remoting, vault_id, orderbook_id) = setup_programs().await;
    let mut vault_service =
        Service::<VaultImpl, _>::new(remoting.clone(), vault_id, "Vault".into());
    let mut orderbook_seller = orderbook_service_for(&remoting, orderbook_id, seller());
    let mut orderbook_buyer = orderbook_service_for(&remoting, orderbook_id, buyer());

    // 1. Initial Funding
    vault_service
        .vault_deposit(buyer(), TOKEN_QUOTE, 5000u128)
        .await
        .unwrap();
    vault_service
        .vault_deposit(seller(), TOKEN_BASE, 100u128)
        .await
        .unwrap();

    // 2. Place Maker Sell Order: 50 @ 100
    orderbook_seller
        .place_order(100u128, 50u128, false, TOKEN_BASE, TOKEN_QUOTE)
        .await
        .unwrap();

    // 3. Place Taker Buy Order: 20 @ 120 (Price improvement)
    // Reserved: 20 * 120 = 2400
    // Matched: 20 @ 100 = 2000
    // Fee (30bps): 2000 * 0.003 = 6
    // Buyer pays 2000, receives 20 Base. Improvement 400 unlocked.
    // Seller receives 2000 - 6 = 1994 Quote, pays 20 Base.
    orderbook_buyer
        .place_order(120u128, 20u128, true, TOKEN_BASE, TOKEN_QUOTE)
        .await
        .unwrap();

    // 4. Verify Buyer Balances
    // Quote: 5000 - 2000 = 3000 Available, 0 Reserved
    let (bq_avail, bq_res) = vault_service
        .get_balance(buyer(), TOKEN_QUOTE)
        .await
        .unwrap();
    assert_eq!(bq_avail, 3000);
    assert_eq!(bq_res, 0);
    // Base: 0 + 20 = 20 Available
    let (bb_avail, _) = vault_service
        .get_balance(buyer(), TOKEN_BASE)
        .await
        .unwrap();
    assert_eq!(bb_avail, 20);

    // 5. Verify Seller Balances
    // Base: 100 - 20 (matched) - 30 (remaining maker) = 50 Available, 30 Reserved
    let (sb_avail, sb_res) = vault_service
        .get_balance(seller(), TOKEN_BASE)
        .await
        .unwrap();
    assert_eq!(sb_avail, 50);
    assert_eq!(sb_res, 30);
    // Quote: 0 + 1994 = 1994 Available
    let (sq_avail, _) = vault_service
        .get_balance(seller(), TOKEN_QUOTE)
        .await
        .unwrap();
    assert_eq!(sq_avail, 1994);

    // 6. Verify Treasury
    let treasury = vault_service.get_treasury(TOKEN_QUOTE).await.unwrap();
    assert_eq!(treasury, 6);

    // 7. Final Withdrawal
    vault_service
        .vault_withdraw(buyer(), TOKEN_QUOTE, 1000u128)
        .await
        .unwrap();
    let (final_bq, _) = vault_service
        .get_balance(buyer(), TOKEN_QUOTE)
        .await
        .unwrap();
    assert_eq!(final_bq, 2000);
}

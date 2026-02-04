use clob_common::{actor_to_eth, TokenId};
use orderbook_client::{
    order_book::OrderBookImpl, OrderbookCtors, OrderbookProgram,
};
use orderbook_client::order_book::OrderBook;
use sails_rs::{
    client::{Deployment, GtestEnv, Service},
    gtest::{Program, System},
    prelude::*,
    ActorId,
    hex,
};

pub(crate) const ORDERBOOK_WASM: &str = "../../target/wasm32-gear/release/orderbook.opt.wasm";
pub(crate) const VAULT_WASM: &str = "../../target/wasm32-gear/release/vault_app.opt.wasm";

pub(crate) const ADMIN_ID: u64 = 100;
pub(crate) const BUYER_ID: u64 = 101;
pub(crate) const SELLER_ID: u64 = 102;
pub(crate) const ETH_CALLER_ID: u64 = 199;
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

// Helper for raw vault calls
fn send_vault(system: &System, from: u64, vault_id: ActorId, method: &str, args: impl Encode) {
    let payload = ("Vault", method, args).encode();
    let program = system.get_program(vault_id).expect("Vault program not found");
    let mid = program.send_bytes(from, payload);
    let res = system.run_next_block();
    assert!(res.succeed.contains(&mid), "Vault call {} failed", method);
}

// Helper to query vault balance
fn get_vault_balance(system: &System, vault_id: ActorId, user: ActorId, token: TokenId) -> (u128, u128) {
    let payload = ("Vault", "GetBalance", (user, token)).encode();
    let program = system.get_program(vault_id).expect("Vault program not found");
    let mid = program.send_bytes(ADMIN_ID, payload);
    let res = system.run_next_block();
    assert!(res.succeed.contains(&mid));
    let log = res.log.iter().find(|l| l.destination() == ADMIN_ID.into() && l.source() == vault_id).expect("No reply");
    
    println!("DEBUG: GetBalance Payload: {:?}", hex::encode(log.payload()));

    // Try to decode with Service/Method wrapper first
    match <(String, String, (u128, u128))>::decode(&mut log.payload()) {
        Ok((_, _, (avail, reserved))) => return (avail, reserved),
        Err(_) => {}
    }

    // Try raw
    match <(u128, u128)>::decode(&mut log.payload()) {
        Ok((avail, reserved)) => return (avail, reserved),
        Err(_) => {
             println!("Failed to decode payload: {:?} (Hex: {})", log.payload(), hex::encode(log.payload()));
             std::panic!("Failed to decode Balance");
        }
    }
}

async fn setup_programs() -> (GtestEnv, ActorId, ActorId) {
    let system = System::new();
    system.init_logger();
    system.mint_to(ADMIN_ID, 100_000_000_000_000_000);
    system.mint_to(buyer(), 100_000_000_000_000_000);
    system.mint_to(seller(), 100_000_000_000_000_000);
    system.mint_to(eth_caller(), 100_000_000_000_000_000);

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

    // Authorize OrderBook in Vault (Raw)
    send_vault(system_ref, ADMIN_ID, vault_id, "AddMarket", orderbook_id);

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
    let system = remoting.system();
    let mut orderbook_buyer = orderbook_service_for(&remoting, orderbook_id, buyer());

    // Fund buyer and seller in Vault and transfer to OrderBook
    send_vault(system, BUYER_ID, vault_id, "VaultDeposit", (buyer(), TOKEN_QUOTE, 2_000u128));
    send_vault(system, BUYER_ID, vault_id, "TransferToMarket", (orderbook_id, TOKEN_QUOTE, 2_000u128));

    send_vault(system, SELLER_ID, vault_id, "VaultDeposit", (seller(), TOKEN_BASE, 10u128));
    send_vault(system, SELLER_ID, vault_id, "TransferToMarket", (orderbook_id, TOKEN_BASE, 10u128));

    // Verify balances in OrderBook
    let buyer_bal = orderbook_buyer
        .get_balance(buyer(), TOKEN_QUOTE)
        .await
        .unwrap();
    assert_eq!(buyer_bal, 2_000);

    let seller_bal = orderbook_buyer
        .get_balance(seller(), TOKEN_BASE)
        .await
        .unwrap();
    assert_eq!(seller_bal, 10);

    // Place a buy order; should reserve funds internally
    orderbook_buyer
        .place_order(100u128, 5u128, true, TOKEN_BASE, TOKEN_QUOTE)
        .await
        .unwrap();

    let buyer_bal_after = orderbook_buyer
        .get_balance(buyer(), TOKEN_QUOTE)
        .await
        .unwrap();
    // 5 * 100 = 500 reserved
    assert_eq!(buyer_bal_after, 1500);
}

#[tokio::test]
async fn cancel_order_unlocks_funds() {
    let (remoting, vault_id, orderbook_id) = setup_programs().await;
    let system = remoting.system();
    let mut orderbook_buyer = orderbook_service_for(&remoting, orderbook_id, buyer());

    // Fund buyer and transfer to OrderBook
    send_vault(system, BUYER_ID, vault_id, "VaultDeposit", (buyer(), TOKEN_QUOTE, 1_000u128));
    send_vault(system, BUYER_ID, vault_id, "TransferToMarket", (orderbook_id, TOKEN_QUOTE, 1_000u128));

    // Place a buy order (order_id will be 1)
    orderbook_buyer
        .place_order(50u128, 2u128, true, TOKEN_BASE, TOKEN_QUOTE)
        .await
        .unwrap();

    let bal_after_place = orderbook_buyer
        .get_balance(buyer(), TOKEN_QUOTE)
        .await
        .unwrap();
    assert_eq!(bal_after_place, 900); // 50 * 2 = 100 reserved

    // Cancel the order and expect unlock to happen internally
    orderbook_buyer
        .cancel_order(1u128, TOKEN_BASE, TOKEN_QUOTE)
        .await
        .unwrap();

    let bal_after_cancel = orderbook_buyer
        .get_balance(buyer(), TOKEN_QUOTE)
        .await
        .unwrap();
    assert_eq!(bal_after_cancel, 1000);
}

#[tokio::test]
async fn test_settle_trade() {
    let (remoting, vault_id, orderbook_id) = setup_programs().await;
    let system = remoting.system();
    let mut orderbook_seller = orderbook_service_for(&remoting, orderbook_id, seller());
    let mut orderbook_buyer = orderbook_service_for(&remoting, orderbook_id, buyer());

    // 1. Configure Vault Fee
    send_vault(system, ADMIN_ID, vault_id, "UpdateFeeRate", 30u128);

    // 2. Fund Users and Transfer
    send_vault(system, BUYER_ID, vault_id, "VaultDeposit", (buyer(), TOKEN_QUOTE, 1000u128));
    send_vault(system, BUYER_ID, vault_id, "TransferToMarket", (orderbook_id, TOKEN_QUOTE, 1000u128));

    send_vault(system, SELLER_ID, vault_id, "VaultDeposit", (seller(), TOKEN_BASE, 10u128));
    send_vault(system, SELLER_ID, vault_id, "TransferToMarket", (orderbook_id, TOKEN_BASE, 10u128));

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

    // 5. Verify Balances in OrderBook
    // Buyer: receives 10 Base
    let b_base = orderbook_buyer
        .get_balance(buyer(), TOKEN_BASE)
        .await
        .unwrap();
    assert_eq!(b_base, 10);
    // Buyer: spent 1000 Quote. 0 left.
    let b_quote = orderbook_buyer
        .get_balance(buyer(), TOKEN_QUOTE)
        .await
        .unwrap();
    assert_eq!(b_quote, 0);

    // Seller: receives 1000 - fee Quote.
    // Fee = 1000 * 30 / 10000 = 3
    let s_quote = orderbook_buyer
        .get_balance(seller(), TOKEN_QUOTE)
        .await
        .unwrap();
    assert_eq!(s_quote, 997);

    // 6. Verify treasury in OrderBook
    // (We don't have a get_treasury in OrderBook IDL yet, but we could add it or check via state)
    // Actually, matched fees should be in treasury.
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
    let system = remoting.system();
    let mut orderbook_eth = orderbook_service_for(&remoting, orderbook_id, eth_caller());

    send_vault(system, BUYER_ID, vault_id, "VaultDeposit", (buyer(), TOKEN_QUOTE, 1_000u128));
    send_vault(system, BUYER_ID, vault_id, "TransferToMarket", (orderbook_id, TOKEN_QUOTE, 1_000u128));

    let user = actor_to_eth(buyer());
    orderbook_eth
        .place_order_eth(user, 100u128, 5u128, true, TOKEN_BASE, TOKEN_QUOTE)
        .await
        .unwrap();

    let bal = orderbook_eth
        .get_balance(buyer(), TOKEN_QUOTE)
        .await
        .unwrap();
    assert_eq!(bal, 500); // 5 * 100 = 500 reserved
}

#[tokio::test]
async fn place_order_eth_requires_authorized_caller() {
    let (remoting, vault_id, orderbook_id) = setup_programs().await;
    let system = remoting.system();
    let mut orderbook_buyer = orderbook_service_for(&remoting, orderbook_id, buyer());

    send_vault(system, BUYER_ID, vault_id, "VaultDeposit", (buyer(), TOKEN_QUOTE, 1_000u128));

    let user = actor_to_eth(buyer());
    orderbook_buyer
        .place_order_eth(user, 100u128, 5u128, true, TOKEN_BASE, TOKEN_QUOTE)
        .await
        .unwrap_err();
}

#[tokio::test]
async fn test_partial_match() {
    let (remoting, vault_id, orderbook_id) = setup_programs().await;
    let system = remoting.system();
    let mut orderbook_seller = orderbook_service_for(&remoting, orderbook_id, seller());
    let mut orderbook_buyer = orderbook_service_for(&remoting, orderbook_id, buyer());

    send_vault(system, BUYER_ID, vault_id, "VaultDeposit", (buyer(), TOKEN_QUOTE, 2000u128));
    send_vault(system, BUYER_ID, vault_id, "TransferToMarket", (orderbook_id, TOKEN_QUOTE, 2000u128));

    send_vault(system, SELLER_ID, vault_id, "VaultDeposit", (seller(), TOKEN_BASE, 20u128));
    send_vault(system, SELLER_ID, vault_id, "TransferToMarket", (orderbook_id, TOKEN_BASE, 20u128));

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
    let system = remoting.system();
    let mut orderbook_seller = orderbook_service_for(&remoting, orderbook_id, seller());
    let mut orderbook_buyer = orderbook_service_for(&remoting, orderbook_id, buyer());

    send_vault(system, SELLER_ID, vault_id, "VaultDeposit", (seller(), TOKEN_BASE, 20u128));
    send_vault(system, SELLER_ID, vault_id, "TransferToMarket", (orderbook_id, TOKEN_BASE, 20u128));

    send_vault(system, BUYER_ID, vault_id, "VaultDeposit", (buyer(), TOKEN_QUOTE, 2000u128));
    send_vault(system, BUYER_ID, vault_id, "TransferToMarket", (orderbook_id, TOKEN_QUOTE, 2000u128));

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
    let system = remoting.system();
    let mut orderbook_seller = orderbook_service_for(&remoting, orderbook_id, seller());
    let mut orderbook_buyer = orderbook_service_for(&remoting, orderbook_id, buyer());

    // Seller has 10 Base
    send_vault(system, SELLER_ID, vault_id, "VaultDeposit", (seller(), TOKEN_BASE, 10u128));
    send_vault(system, SELLER_ID, vault_id, "TransferToMarket", (orderbook_id, TOKEN_BASE, 10u128));

    // Buyer has 1000 Quote
    send_vault(system, BUYER_ID, vault_id, "VaultDeposit", (buyer(), TOKEN_QUOTE, 1000u128));
    send_vault(system, BUYER_ID, vault_id, "TransferToMarket", (orderbook_id, TOKEN_QUOTE, 1000u128));

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

    // Check Buyer Balance in Quote Token (Price improvement matched at 80, but reserved at 100)
    let available = orderbook_buyer
        .get_balance(buyer(), TOKEN_QUOTE)
        .await
        .unwrap();
    assert_eq!(
        available, 200,
        "Price improvement not returned to available balance! (Expected 200, found {})",
        available
    );
}

#[tokio::test]
async fn test_full_e2e_flow() {
    let (remoting, vault_id, orderbook_id) = setup_programs().await;
    let system = remoting.system();
    let mut orderbook_seller = orderbook_service_for(&remoting, orderbook_id, seller());
    let mut orderbook_buyer = orderbook_service_for(&remoting, orderbook_id, buyer());

    // 1. Initial Funding & Transfer
    send_vault(system, BUYER_ID, vault_id, "VaultDeposit", (buyer(), TOKEN_QUOTE, 5000u128));
    send_vault(system, BUYER_ID, vault_id, "TransferToMarket", (orderbook_id, TOKEN_QUOTE, 5000u128));

    send_vault(system, SELLER_ID, vault_id, "VaultDeposit", (seller(), TOKEN_BASE, 100u128));
    send_vault(system, SELLER_ID, vault_id, "TransferToMarket", (orderbook_id, TOKEN_BASE, 100u128));

    // 2. Place Maker Sell Order: 50 @ 100
    orderbook_seller
        .place_order(100u128, 50u128, false, TOKEN_BASE, TOKEN_QUOTE)
        .await
        .unwrap();

    // 3. Place Taker Buy Order: 20 @ 120 (Price improvement)
    orderbook_buyer
        .place_order(120u128, 20u128, true, TOKEN_BASE, TOKEN_QUOTE)
        .await
        .unwrap();

    // 4. Verify Buyer Balances in OrderBook
    // Quote: 5000 - 2000 = 3000
    let bq_avail = orderbook_buyer
        .get_balance(buyer(), TOKEN_QUOTE)
        .await
        .unwrap();
    assert_eq!(bq_avail, 3000);

    // Base: 0 + 20 = 20
    let bb_avail = orderbook_buyer
        .get_balance(buyer(), TOKEN_BASE)
        .await
        .unwrap();
    assert_eq!(bb_avail, 20);

    // 5. Verify Seller Balances in OrderBook
    // Base: 100 - 20 (matched) - 30 (reserved for remaining order) = 50
    let sb_avail = orderbook_seller
        .get_balance(seller(), TOKEN_BASE)
        .await
        .unwrap();
    assert_eq!(sb_avail, 50);

    // Quote: 0 + 1994 = 1994 (after 30bps fee on 2000)
    let sq_avail = orderbook_seller
        .get_balance(seller(), TOKEN_QUOTE)
        .await
        .unwrap();
    assert_eq!(sq_avail, 1994);

    // 6. Test Withdrawal back to Vault
    orderbook_buyer
        .withdraw_to_vault(TOKEN_QUOTE, 1000u128)
        .await
        .unwrap();

    // Check Vault balance
    let (v_bq_avail, _) = get_vault_balance(system, vault_id, buyer(), TOKEN_QUOTE);
    assert_eq!(v_bq_avail, 1000);

    // Check internal balance
    let bq_rem = orderbook_buyer
        .get_balance(buyer(), TOKEN_QUOTE)
        .await
        .unwrap();
    assert_eq!(bq_rem, 2000);
}
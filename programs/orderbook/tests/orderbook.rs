use clob_common::TokenId;
use orderbook_client::{
    orderbook::*, Orderbook as OrderbookClient, OrderbookCtors, OrderbookProgram,
};

use sails_rs::{client::*, gtest::*};
use sails_rs::{prelude::*, ActorId};
pub(crate) const ORDERBOOK_WASM: &str = "../../target/wasm32-gear/release/orderbook.opt.wasm";

pub(crate) const ADMIN_ID: u64 = 10;
pub(crate) const BUYER_ID: u64 = 1;
pub(crate) const SELLER_ID: u64 = 2;
pub(crate) const BUYER2_ID: u64 = 3;
pub(crate) const SELLER2_ID: u64 = 4;
pub(crate) const VAULT_ID: u64 = 10;
pub(crate) const BASE_TOKEN_ID: TokenId = [20u8; 20];
pub(crate) const QUOTE_TOKEN_ID: TokenId = [30u8; 20];

fn buyer() -> ActorId {
    ActorId::from(BUYER_ID)
}

fn seller() -> ActorId {
    ActorId::from(SELLER_ID)
}

fn buyer2() -> ActorId {
    ActorId::from(BUYER2_ID)
}
fn seller2() -> ActorId {
    ActorId::from(SELLER2_ID)
}

fn vault() -> ActorId {
    ActorId::from(VAULT_ID)
}

const PRICE_PRECISION: u128 = 1_000_000_000_000_000_000_000_000_000_000_000; // 1e30
const BASE_DECIMALS: u32 = 18;
const QUOTE_DECIMALS: u32 = 6;

fn eth_wei(x: u128) -> u128 {
    x * 10u128.pow(BASE_DECIMALS)
}

fn eth_frac(num: u128, den: u128) -> u128 {
    eth_wei(1) * num / den
}

fn usdt_micro(x: u128) -> u128 {
    x * 10u128.pow(QUOTE_DECIMALS)
}

// price_fp = (quote_atoms_per_1_base_unit * PRICE_PRECISION)
fn price_fp_usdt_per_eth(usdt_per_eth: u128) -> u128 {
    // quote atoms per 1 ETH (micro-USDT per ETH)
    let quote_per_eth_atoms = U256::from(usdt_per_eth) * U256::from(10u128.pow(QUOTE_DECIMALS));
    let base_unit = U256::from(10u128.pow(BASE_DECIMALS)); // wei per 1 ETH

    // (quote_per_eth_atoms * PRICE_PRECISION) / base_unit
    let price_fp = quote_per_eth_atoms * U256::from(PRICE_PRECISION) / base_unit;

    price_fp.low_u128()
}

fn quote_floor_atoms(base_atoms: u128, price_fp: u128) -> u128 {
    let mul = U256::from(base_atoms) * U256::from(price_fp);
    let q = mul / U256::from(PRICE_PRECISION);
    q.low_u128()
}

fn quote_ceil_atoms(base_atoms: u128, price_fp: u128) -> u128 {
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

async fn setup_orderbook(
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

    let env = GtestEnv::new(system, ADMIN_ID.into());
    // Deploy OrderBook passing the vault_id
    let program_code_id = env.system().submit_code_file(ORDERBOOK_WASM);

    env.deploy::<orderbook_client::OrderbookProgram>(program_code_id, b"salt".to_vec())
        .create(
            vault(),
            vault(),
            BASE_TOKEN_ID,
            QUOTE_TOKEN_ID,
            max_trades,
            max_preview_scans,
        )
        .await
        .unwrap()
}

async fn assert_balance(
    program: &Actor<OrderbookProgram, GtestEnv>,
    who: ActorId,
    base: u128,
    quote: u128,
) {
    let b = program.orderbook().balance_of(who).await.unwrap();
    assert_eq!(b.0, base);
    assert_eq!(b.1, quote);
}

#[tokio::test]
async fn market_buy_strict_partial_fill_refunds_unused_budget() {
    let program = setup_orderbook(1000, 1000).await;
    let mut c = program.orderbook();

    let price = price_fp_usdt_per_eth(2_000);
    let ask_amount = eth_frac(1, 2); // 0.5 ETH
    let buy_amount = eth_frac(2, 5); // 0.4 ETH

    // Maker: place ask 0.5 ETH @ 2000 USDT/ETH
    c.deposit(seller(), BASE_TOKEN_ID, eth_wei(1))
        .with_actor_id(vault())
        .await
        .unwrap();
    let ask_id = c
        .submit_order(
            /*side=*/ 1, /*kind=*/ 0, price, ask_amount, /*max_quote=*/ 0,
        )
        .with_actor_id(seller())
        .await
        .unwrap();

    // Taker: deposit quote and do a strict Market BUY with a max_quote budget
    c.deposit(buyer(), QUOTE_TOKEN_ID, usdt_micro(10_000))
        .with_actor_id(vault())
        .await
        .unwrap();

    let spent = quote_floor_atoms(buy_amount, price);
    let budget = spent + usdt_micro(100); // extra budget that must be refunded

    c.submit_order(
        /*side=*/ 0, /*kind=*/ 1, /*limit_price=*/ 0, buy_amount,
        /*max_quote=*/ budget,
    )
    .with_actor_id(buyer())
    .await
    .unwrap();

    // Buyer receives base and spends exactly `spent` quote (budget remainder refunded)
    assert_balance(&program, buyer(), buy_amount, usdt_micro(10_000) - spent).await;
    // Seller had 1 ETH, locked 0.5 ETH into the ask, then sold 0.4 ETH and received `spent` quote
    assert_balance(&program, seller(), eth_wei(1) - ask_amount, spent).await;

    // Best ask price stays the same because the order is only partially filled
    assert_eq!(c.best_ask_price().await.unwrap(), price);

    // Order #1 is the original ask; it must have remaining_base = 0.1 ETH
    let (found, id, owner, side_io, p, remaining_base, reserved_quote) =
        c.order_by_id(ask_id).await.unwrap();

    assert!(found);
    assert_eq!(id, ask_id);
    assert_eq!(owner, seller());
    assert_eq!(side_io, 1); // SELL
    assert_eq!(p, price);
    assert_eq!(remaining_base, ask_amount - buy_amount);
    assert_eq!(reserved_quote, 0);
}

#[tokio::test]
async fn market_buy_strict_budget_exceeded_reverts_without_state_change() {
    let program = setup_orderbook(1000, 1000).await;
    let mut c = program.orderbook();

    let price = price_fp_usdt_per_eth(2_000);
    let ask_amount = eth_frac(1, 2); // 0.5 ETH
    let buy_amount = eth_frac(2, 5); // 0.4 ETH

    // Maker ask
    c.deposit(seller(), BASE_TOKEN_ID, eth_wei(1))
        .with_actor_id(vault())
        .await
        .unwrap();
    let ask_id = c
        .submit_order(1, 0, price, ask_amount, 0)
        .with_actor_id(seller())
        .await
        .unwrap();

    // Buyer deposits quote
    c.deposit(buyer(), QUOTE_TOKEN_ID, usdt_micro(10_000))
        .with_actor_id(vault())
        .await
        .unwrap();

    // Budget is deliberately too small: spent - 1
    let spent = quote_floor_atoms(buy_amount, price);
    let too_small_budget = spent - 1;

    let res = c
        .submit_order(0, 1, 0, buy_amount, too_small_budget)
        .with_actor_id(buyer())
        .await;

    assert!(res.is_err(), "Expected Market BUY budget check to fail");

    // Buyer balance must remain unchanged
    assert_balance(&program, buyer(), 0, usdt_micro(10_000)).await;

    // Seller state must be unchanged (ask still resting, no quote received)
    assert_balance(&program, seller(), eth_wei(1) - ask_amount, 0).await;
    assert_eq!(c.best_ask_price().await.unwrap(), price);

    // Ask order must still be intact
    let (found, _id, _owner, _side_io, _p, remaining_base, _rq) =
        c.order_by_id(ask_id).await.unwrap();
    assert!(found);
    assert_eq!(remaining_base, ask_amount);
}

#[tokio::test]
async fn market_sell_matches_bid_and_decrements_reserved_quote() {
    let program = setup_orderbook(1000, 1000).await;
    let mut c = program.orderbook();

    let price = price_fp_usdt_per_eth(1_900);
    let bid_amount = eth_frac(1, 2); // 0.5 ETH
    let sell_amount = eth_frac(2, 5); // 0.4 ETH

    // Buyer places a bid (locks quote)
    c.deposit(buyer(), QUOTE_TOKEN_ID, usdt_micro(10_000))
        .with_actor_id(vault())
        .await
        .unwrap();
    let bid_id = c
        .submit_order(0, 0, price, bid_amount, 0)
        .with_actor_id(buyer())
        .await
        .unwrap();

    let locked = quote_ceil_atoms(bid_amount, price);

    // Seller market sells into the bid
    c.deposit(seller(), BASE_TOKEN_ID, eth_wei(1))
        .with_actor_id(vault())
        .await
        .unwrap();

    let got = quote_floor_atoms(sell_amount, price);

    c.submit_order(
        /*side=*/ 1,
        /*kind=*/ 1,
        /*limit_price=*/ 0,
        sell_amount,
        /*max_quote=*/ 0,
    )
    .with_actor_id(seller())
    .await
    .unwrap();

    // Seller: sold 0.4 ETH and received `got` quote
    assert_balance(&program, seller(), eth_wei(1) - sell_amount, got).await;

    // Buyer: quote was already locked when placing the bid; base is credited now
    assert_balance(&program, buyer(), sell_amount, usdt_micro(10_000) - locked).await;

    // Bid order #1 must be partially filled: remaining_base decreased, reserved_quote decreased by `got`
    let (found, _id, _owner, side_io, _p, remaining_base, reserved_quote) =
        c.order_by_id(bid_id).await.unwrap();
    assert!(found);
    assert_eq!(side_io, 0); // BUY
    assert_eq!(remaining_base, bid_amount - sell_amount);
    assert_eq!(reserved_quote, locked - got);

    // Best bid stays because order still has remaining_base > 0
    assert_eq!(c.best_bid_price().await.unwrap(), price);
}

#[tokio::test]
async fn ioc_buy_partial_fill_refunds_remainder_and_does_not_place_resting() {
    let program = setup_orderbook(1000, 1000).await;
    let mut c = program.orderbook();

    let price = price_fp_usdt_per_eth(2_000);
    let ask_amount = eth_frac(3, 10); // 0.3 ETH
    let buy_amount = eth_frac(1, 2); // 0.5 ETH (more than available)

    // Seller places ask 0.3 ETH @ 2000
    c.deposit(seller(), BASE_TOKEN_ID, eth_wei(1))
        .with_actor_id(vault())
        .await
        .unwrap();
    c.submit_order(1, 0, price, ask_amount, 0)
        .with_actor_id(seller())
        .await
        .unwrap();

    // Buyer IOC buys 0.5 ETH @ 2000; only 0.3 ETH is available
    c.deposit(buyer(), QUOTE_TOKEN_ID, usdt_micro(10_000))
        .with_actor_id(vault())
        .await
        .unwrap();

    let spent = quote_floor_atoms(ask_amount, price);

    c.submit_order(
        /*side=*/ 0, /*kind=*/ 3, /*limit_price=*/ price, buy_amount,
        /*max_quote=*/ 0,
    )
    .with_actor_id(buyer())
    .await
    .unwrap();

    // Buyer receives only 0.3 ETH and spends only `spent` quote; remainder is refunded
    assert_balance(&program, buyer(), ask_amount, usdt_micro(10_000) - spent).await;

    // Seller sold 0.3 ETH and received `spent` quote
    assert_balance(&program, seller(), eth_wei(1) - ask_amount, spent).await;

    // The ask must be fully consumed => best ask becomes 0
    assert_eq!(c.best_ask_price().await.unwrap(), 0);

    // IOC must not place any resting order on the bid side
    assert_eq!(c.best_bid_price().await.unwrap(), 0);

    // Ask order #1 should be removed
    let (found, ..) = c.order_by_id(1).await.unwrap();
    assert!(!found);
}
#[tokio::test]
async fn limit_buy_places_and_reserves_quote_ceil() {
    let program = setup_orderbook(1000, 1000).await;
    let mut c = program.orderbook();

    let price = price_fp_usdt_per_eth(1_900);
    let bid_amount = eth_frac(1, 2); // 0.5 ETH

    c.deposit(buyer(), QUOTE_TOKEN_ID, usdt_micro(10_000))
        .with_actor_id(vault())
        .await
        .unwrap();

    // Place limit bid 0.5 ETH @ 1900
    let bid_id = c
        .submit_order(
            /*side=*/ 0, /*kind=*/ 0, price, bid_amount, /*max_quote=*/ 0,
        )
        .with_actor_id(buyer())
        .await
        .unwrap();

    // For a BUY limit, reserved quote must be ceil(base * price / PRICE_PRECISION)
    let reserved = quote_ceil_atoms(bid_amount, price);
    // Quote is locked by subtracting from free balance
    assert_balance(&program, buyer(), 0, usdt_micro(10_000) - reserved).await;

    assert_eq!(c.best_bid_price().await.unwrap(), price);

    // Order #1 must exist with reserved_quote = `reserved`
    let (found, id, owner, side_io, p, remaining_base, reserved_quote) =
        c.order_by_id(bid_id).await.unwrap();
    assert!(found);
    assert_eq!(id, bid_id);
    assert_eq!(owner, buyer());
    assert_eq!(side_io, 0); // BUY
    assert_eq!(p, price);
    assert_eq!(remaining_base, bid_amount);
    assert_eq!(reserved_quote, reserved);
}

#[tokio::test]
async fn fok_buy_rejects_without_mutating_book_or_balances() {
    let program = setup_orderbook(1000, 1000).await;
    let mut c = program.orderbook();

    let price = price_fp_usdt_per_eth(2_000);
    let ask_amount = eth_frac(1, 2); // 0.5 ETH
    let buy_amount = eth_wei(1); // 1 ETH (not enough liquidity)

    // Seller places ask 0.5
    c.deposit(seller(), BASE_TOKEN_ID, eth_wei(1))
        .with_actor_id(vault())
        .await
        .unwrap();
    c.submit_order(1, 0, price, ask_amount, 0)
        .with_actor_id(seller())
        .await
        .unwrap();

    // Buyer deposits quote and submits FOK buy 1.0 ETH @ 2000
    c.deposit(buyer(), QUOTE_TOKEN_ID, usdt_micro(10_000))
        .with_actor_id(vault())
        .await
        .unwrap();

    c.submit_order(
        /*side=*/ 0, /*kind=*/ 2, /*limit_price=*/ price, buy_amount,
        /*max_quote=*/ 0,
    )
    .with_actor_id(buyer())
    .await
    .unwrap();

    // Buyer must remain unchanged (no fills, and any temporary locks must be reverted)
    assert_balance(&program, buyer(), 0, usdt_micro(10_000)).await;

    // Seller must remain unchanged (ask still resting, no quote received)
    assert_balance(&program, seller(), eth_wei(1) - ask_amount, 0).await;
    assert_eq!(c.best_ask_price().await.unwrap(), price);

    let (found, _id, _owner, _side, _p, remaining_base, _rq) = c.order_by_id(1).await.unwrap();
    assert!(found);
    assert_eq!(remaining_base, ask_amount);
}

#[tokio::test]
async fn limit_sell_places_and_locks_base() {
    let max_trades = 1000;
    let max_preview_scans = 1000;
    let program = setup_orderbook(max_trades, max_preview_scans).await;
    let mut service_client = program.orderbook();

    let expected_price_fp = price_fp_usdt_per_eth(2_000);
    let expected_remaining_base = eth_frac(1, 2); // 0.5 ETH

    service_client
        .deposit(seller(), BASE_TOKEN_ID, eth_wei(1))
        .with_actor_id(vault())
        .await
        .unwrap();

    let ask_id = service_client
        .submit_order(
            /*side=*/ 1,
            /*kind=*/ 0,
            expected_price_fp,
            expected_remaining_base,
            /*max_quote=*/ 0,
        )
        .with_actor_id(seller())
        .await
        .unwrap();

    assert_balance(&program, seller(), eth_wei(1) - expected_remaining_base, 0).await;

    assert_eq!(
        service_client.best_ask_price().await.unwrap(),
        expected_price_fp
    );

    let (found, id, owner, side_io, price, remaining_base, reserved_quote) =
        service_client.order_by_id(ask_id).await.unwrap();
    assert!(found);
    assert_eq!(id, ask_id);
    assert_eq!(owner, seller());
    assert_eq!(side_io, 1); // SELL
    assert_eq!(price, expected_price_fp);
    assert_eq!(remaining_base, expected_remaining_base);
    assert_eq!(reserved_quote, 0);
}

#[tokio::test]
async fn market_buy_strict_fills_across_two_price_levels_best_to_worse() {
    let program = setup_orderbook(1000, 1000).await;
    let mut c = program.orderbook();

    let price_1990 = price_fp_usdt_per_eth(1_990);
    let price_2000 = price_fp_usdt_per_eth(2_000);

    let ask1 = eth_frac(3, 10); // 0.3 ETH @ 1990
    let ask2 = eth_frac(1, 5); // 0.2 ETH @ 2000
    let buy = eth_frac(9, 20); // 0.45 ETH => consumes ask1 fully + 0.15 from ask2
    let fill2 = buy - ask1; // 0.15 ETH

    // Seller1 places ask 0.3 @ 1990
    c.deposit(seller(), BASE_TOKEN_ID, eth_wei(1))
        .with_actor_id(vault())
        .await
        .unwrap();
    let ask1_id = c
        .submit_order(1, 0, price_1990, ask1, 0)
        .with_actor_id(seller())
        .await
        .unwrap();

    // Seller2 places ask 0.2 @ 2000
    c.deposit(seller2(), BASE_TOKEN_ID, eth_wei(1))
        .with_actor_id(vault())
        .await
        .unwrap();
    let ask2_id = c
        .submit_order(1, 0, price_2000, ask2, 0)
        .with_actor_id(seller2())
        .await
        .unwrap();

    // Buyer deposits quote and performs strict Market BUY
    c.deposit(buyer(), QUOTE_TOKEN_ID, usdt_micro(10_000))
        .with_actor_id(vault())
        .await
        .unwrap();

    let spent1 = quote_floor_atoms(ask1, price_1990);
    let spent2 = quote_floor_atoms(fill2, price_2000);
    let spent_total = spent1 + spent2;

    let budget = spent_total + usdt_micro(50); // unused budget must be refunded

    c.submit_order(0, 1, 0, buy, budget)
        .with_actor_id(buyer())
        .await
        .unwrap();

    // Buyer: receives full base and spends exactly spent_total (refund unused budget)
    assert_balance(&program, buyer(), buy, usdt_micro(10_000) - spent_total).await;

    // Sellers: base was locked at placement; quote credited by fills
    assert_balance(&program, seller(), eth_wei(1) - ask1, spent1).await;
    assert_balance(&program, seller2(), eth_wei(1) - ask2, spent2).await;

    // Ask1 fully consumed -> removed
    let (found1, ..) = c.order_by_id(ask1_id).await.unwrap();
    assert!(!found1);

    // Ask2 partially consumed -> remains with 0.05 ETH
    let (found2, _id, owner, side_io, p, remaining_base, rq) =
        c.order_by_id(ask2_id).await.unwrap();
    assert!(found2);
    assert_eq!(owner, seller2());
    assert_eq!(side_io, 1); // SELL
    assert_eq!(p, price_2000);
    assert_eq!(remaining_base, ask2 - fill2);
    assert_eq!(rq, 0);

    // Best ask should now be the 2000 level
    assert_eq!(c.best_ask_price().await.unwrap(), price_2000);
}

#[tokio::test]
async fn market_buy_strict_fifo_within_same_price_level() {
    let program = setup_orderbook(1000, 1000).await;
    let mut c = program.orderbook();

    let price = price_fp_usdt_per_eth(2_000);

    let ask_a = eth_frac(1, 5); // 0.2 ETH (first in FIFO)
    let ask_b = eth_frac(1, 5); // 0.2 ETH (second in FIFO)
    let buy = eth_frac(1, 4); // 0.25 ETH -> fills ask_a fully + 0.05 from ask_b
    let fill_b = buy - ask_a; // 0.05 ETH

    // Seller1 places first ask
    c.deposit(seller(), BASE_TOKEN_ID, eth_wei(1))
        .with_actor_id(vault())
        .await
        .unwrap();
    let ask_a_id = c
        .submit_order(1, 0, price, ask_a, 0)
        .with_actor_id(seller())
        .await
        .unwrap();

    // Seller2 places second ask at same price (must be behind FIFO)
    c.deposit(seller2(), BASE_TOKEN_ID, eth_wei(1))
        .with_actor_id(vault())
        .await
        .unwrap();
    let ask_b_id = c
        .submit_order(1, 0, price, ask_b, 0)
        .with_actor_id(seller2())
        .await
        .unwrap();

    // Buyer deposits quote
    c.deposit(buyer(), QUOTE_TOKEN_ID, usdt_micro(10_000))
        .with_actor_id(vault())
        .await
        .unwrap();

    let spent_a = quote_floor_atoms(ask_a, price);
    let spent_b = quote_floor_atoms(fill_b, price);
    let spent_total = spent_a + spent_b;
    let budget = spent_total + usdt_micro(25);

    c.submit_order(0, 1, 0, buy, budget)
        .with_actor_id(buyer())
        .await
        .unwrap();

    // Buyer gets 0.25 ETH, spends exactly floor-sum
    assert_balance(&program, buyer(), buy, usdt_micro(10_000) - spent_total).await;

    // FIFO: first ask is gone, second ask remains with 0.15 ETH
    let (found_a, ..) = c.order_by_id(ask_a_id).await.unwrap();
    assert!(!found_a);

    let (found_b, _id, owner, side_io, p, remaining_base, rq) =
        c.order_by_id(ask_b_id).await.unwrap();
    assert!(found_b);
    assert_eq!(owner, seller2());
    assert_eq!(side_io, 1);
    assert_eq!(p, price);
    assert_eq!(remaining_base, ask_b - fill_b);
    assert_eq!(rq, 0);

    // Sellers get credited quote
    assert_balance(&program, seller(), eth_wei(1) - ask_a, spent_a).await;
    assert_balance(&program, seller2(), eth_wei(1) - ask_b, spent_b).await;

    // Best ask stays on the same price level
    assert_eq!(c.best_ask_price().await.unwrap(), price);
}

#[tokio::test]
async fn market_sell_consumes_multiple_bids_best_to_worse_and_updates_reserved_quote() {
    let program = setup_orderbook(1000, 1000).await;
    let mut c = program.orderbook();

    let price_1900 = price_fp_usdt_per_eth(1_900);
    let price_1890 = price_fp_usdt_per_eth(1_890);

    let bid1 = eth_frac(2, 5); // 0.4 ETH @ 1900 (best bid)
    let bid2 = eth_frac(3, 10); // 0.3 ETH @ 1890
    let sell = eth_frac(3, 5); // 0.6 ETH -> fills bid1 fully + 0.2 from bid2
    let fill2 = sell - bid1; // 0.2 ETH
    let rem2 = bid2 - fill2; // 0.1 ETH

    // Buyer1 places best bid
    c.deposit(buyer(), QUOTE_TOKEN_ID, usdt_micro(10_000))
        .with_actor_id(vault())
        .await
        .unwrap();
    let bid1_id = c
        .submit_order(0, 0, price_1900, bid1, 0)
        .with_actor_id(buyer())
        .await
        .unwrap();
    let locked1 = quote_ceil_atoms(bid1, price_1900);

    // Buyer2 places worse bid
    c.deposit(buyer2(), QUOTE_TOKEN_ID, usdt_micro(10_000))
        .with_actor_id(vault())
        .await
        .unwrap();
    let bid2_id = c
        .submit_order(0, 0, price_1890, bid2, 0)
        .with_actor_id(buyer2())
        .await
        .unwrap();
    let locked2 = quote_ceil_atoms(bid2, price_1890);

    // Seller market sells 0.6 ETH
    c.deposit(seller(), BASE_TOKEN_ID, eth_wei(1))
        .with_actor_id(vault())
        .await
        .unwrap();

    let got1 = quote_floor_atoms(bid1, price_1900);
    let got2 = quote_floor_atoms(fill2, price_1890);
    let got_total = got1 + got2;

    c.submit_order(1, 1, 0, sell, 0)
        .with_actor_id(seller())
        .await
        .unwrap();

    // Seller: base reduced by sell amount, quote increased by got_total
    assert_balance(&program, seller(), eth_wei(1) - sell, got_total).await;

    // Buyer1: base credited, quote stayed locked (it was already subtracted on placement)
    assert_balance(&program, buyer(), bid1, usdt_micro(10_000) - locked1).await;

    // Buyer2: base credited for partial fill; quote is still locked for the order
    assert_balance(&program, buyer2(), fill2, usdt_micro(10_000) - locked2).await;

    // Bid1 fully consumed -> removed
    let (found1, ..) = c.order_by_id(bid1_id).await.unwrap();
    assert!(!found1);

    // Bid2 remains with remaining_base and reserved_quote reduced by got2
    let (found2, _id, owner, side_io, p, remaining_base, reserved_quote) =
        c.order_by_id(bid2_id).await.unwrap();
    assert!(found2);
    assert_eq!(owner, buyer2());
    assert_eq!(side_io, 0); // BUY
    assert_eq!(p, price_1890);
    assert_eq!(remaining_base, rem2);
    assert_eq!(reserved_quote, locked2 - got2);

    // Best bid should now be 1890 (since 1900 was fully consumed)
    assert_eq!(c.best_bid_price().await.unwrap(), price_1890);
}

#[tokio::test]
async fn limit_buy_partial_fill_across_two_asks_then_places_remainder_bid() {
    let program = setup_orderbook(1000, 1000).await;
    let mut c = program.orderbook();

    // Price levels: both are <= limit price (crossing)
    let ask_price_1950 = price_fp_usdt_per_eth(1_950);
    let ask_price_1990 = price_fp_usdt_per_eth(1_990);
    let limit_price_2000 = price_fp_usdt_per_eth(2_000);

    // Two makers provide 0.2 + 0.2 = 0.4 ETH liquidity
    let ask1_amount = eth_frac(1, 5); // 0.2 ETH @ 1950
    let ask2_amount = eth_frac(1, 5); // 0.2 ETH @ 1990

    // Taker wants 1.0 ETH at limit 2000 -> fills 0.4 ETH, places 0.6 ETH as resting bid @ 2000
    let buy_amount = eth_wei(1); // 1.0 ETH
    let filled_base = ask1_amount + ask2_amount; // 0.4 ETH
    let remaining_base = buy_amount - filled_base; // 0.6 ETH (3/5)

    // --- Maker #1 places ask 0.2 ETH @ 1950
    c.deposit(seller(), BASE_TOKEN_ID, eth_wei(1))
        .with_actor_id(vault())
        .await
        .unwrap();
    let ask1_id = c
        .submit_order(
            /*side=*/ 1,
            /*kind=*/ 0,
            ask_price_1950,
            ask1_amount,
            /*max_quote=*/ 0,
        )
        .with_actor_id(seller())
        .await
        .unwrap();

    // --- Maker #2 places ask 0.2 ETH @ 1990
    c.deposit(seller2(), BASE_TOKEN_ID, eth_wei(1))
        .with_actor_id(vault())
        .await
        .unwrap();
    let ask2_id = c
        .submit_order(
            /*side=*/ 1,
            /*kind=*/ 0,
            ask_price_1990,
            ask2_amount,
            /*max_quote=*/ 0,
        )
        .with_actor_id(seller2())
        .await
        .unwrap();

    // --- Buyer deposits quote and submits Limit BUY 1.0 ETH @ 2000
    c.deposit(buyer(), QUOTE_TOKEN_ID, usdt_micro(10_000))
        .with_actor_id(vault())
        .await
        .unwrap();
    // What sellers should receive (engine uses floor for fills)
    let spent1 = quote_floor_atoms(ask1_amount, ask_price_1950); // 0.2 * 1950
    let spent2 = quote_floor_atoms(ask2_amount, ask_price_1990); // 0.2 * 1990
    let spent_total = spent1 + spent2;

    // What buyer locks for the limit order (contract uses ceil at limit)
    let locked_total = quote_ceil_atoms(buy_amount, limit_price_2000);

    // Submit the limit order (should partially fill + place remainder)
    let bid_id = c
        .submit_order(
            /*side=*/ 0,
            /*kind=*/ 0,
            limit_price_2000,
            buy_amount,
            /*max_quote=*/ 0,
        )
        .with_actor_id(buyer())
        .await
        .unwrap();
    // --- Balance checks

    // Buyer receives filled base (0.4 ETH)
    // refund policy:  price-improvement extra immediately (recommended):
    // quote_free = initial - spent_total
    assert_balance(
        &program,
        buyer(),
        filled_base,
        usdt_micro(10_000) - locked_total,
    )
    .await;
    // Sellers: base was subtracted on placement (locked), so final base_free is 1 ETH - ask_amount.
    // Quote credited from fills.
    assert_balance(&program, seller(), eth_wei(1) - ask1_amount, spent1).await;
    assert_balance(&program, seller2(), eth_wei(1) - ask2_amount, spent2).await;

    // --- Book checks

    // Both asks were fully consumed -> no asks remain
    assert_eq!(c.best_ask_price().await.unwrap(), 0);

    // Resting bid at 2000 must exist
    assert_eq!(c.best_bid_price().await.unwrap(), limit_price_2000);

    // ask1 removed
    let (found1, ..) = c.order_by_id(ask1_id).await.unwrap();
    assert!(!found1);

    // ask2 removed
    let (found2, ..) = c.order_by_id(ask2_id).await.unwrap();
    assert!(!found2);

    // bid exists with remaining_base = 0.6 ETH and reserved_quote = remaining_quote
    let (found, id, owner, side_io, p, rem_base, reserved_q) = c.order_by_id(bid_id).await.unwrap();
    assert!(found);
    assert_eq!(id, bid_id);
    assert_eq!(owner, buyer());
    assert_eq!(side_io, 0); // BUY
    assert_eq!(p, limit_price_2000);
    assert_eq!(rem_base, remaining_base);
    assert_eq!(reserved_q, locked_total - spent_total);
}

#[tokio::test]
async fn stress_1000_makers_one_taker_market_buy_strict_consumes_all() {
    // Engine limits must allow 1000 trades and preview scans
    let program = setup_orderbook(/*max_trades=*/ 2000, /*max_preview_scans=*/ 2000).await;
    let mut c = program.orderbook();

    let price = price_fp_usdt_per_eth(2_000);

    // Split 1 ETH into 1000 exact chunks: 1e18 / 1000 = 1e15 wei (exact)
    let total_base = eth_wei(1);
    let chunk_base = total_base / 1000;
    assert_eq!(chunk_base * 1000, total_base);

    // Maker deposits exactly 1 ETH, then places 1000 asks at the same price.
    c.deposit(seller(), BASE_TOKEN_ID, total_base)
        .with_actor_id(vault())
        .await
        .unwrap();

    let mut first_ask_id: u64 = 0;
    for i in 0..1000u64 {
        let ask_id = c
            .submit_order(
                /*side=*/ 1, // SELL
                /*kind=*/ 0, // LIMIT
                /*limit_price=*/ price, /*amount_base=*/ chunk_base,
                /*max_quote=*/ 0,
            )
            .with_actor_id(seller())
            .await
            .unwrap();

        if i == 0 {
            first_ask_id = ask_id;
        }
    }

    // Seller should have all base locked in the book now (free base = 0).
    assert_balance(&program, seller(), /*base=*/ 0, /*quote=*/ 0).await;
    assert_eq!(c.best_ask_price().await.unwrap(), price);

    // Buyer deposits quote and submits strict Market BUY for the full 1 ETH.
    let initial_quote = usdt_micro(10_000);
    c.deposit(buyer(), QUOTE_TOKEN_ID, initial_quote)
        .with_actor_id(vault())
        .await
        .unwrap();

    // Important: spent_total must be Σ floor(chunk_base * price / 1e30) over 1000 trades.
    let spent_per_trade = quote_floor_atoms(chunk_base, price);
    let spent_total = spent_per_trade * 1000;

    // Give an explicit budget above spent_total to validate refund logic.
    let budget = spent_total + usdt_micro(100);
    assert!(budget <= initial_quote);

    c.submit_order(
        /*side=*/ 0, // BUY
        /*kind=*/ 1, // MARKET
        /*limit_price=*/ 0, /*amount_base=*/ total_base, /*max_quote=*/ budget,
    )
    .with_actor_id(buyer())
    .await
    .unwrap();

    // Buyer receives full base and spends exactly spent_total (unused budget refunded).
    assert_balance(
        &program,
        buyer(),
        /*base=*/ total_base,
        /*quote=*/ initial_quote - spent_total,
    )
    .await;

    // Seller sold all base and receives spent_total quote.
    assert_balance(
        &program,
        seller(),
        /*base=*/ 0,
        /*quote=*/ spent_total,
    )
    .await;

    // Book must be empty on asks.
    assert_eq!(c.best_ask_price().await.unwrap(), 0);

    // The first ask must be removed.
    let (found, ..) = c.order_by_id(first_ask_id).await.unwrap();
    assert!(!found);
}

#[tokio::test]
async fn one_big_market_buy_matches_n_small_asks() {
    let n = 9000;

    // Engine must allow at least n trades/scans in a single call.
    let program = setup_orderbook(
        /*max_trades=*/ n + 50,
        /*max_preview_scans=*/ n + 50,
    )
    .await;
    let mut c = program.orderbook();

    let price = price_fp_usdt_per_eth(2_000);

    // Pick a total_base that is exactly divisible by n.
    // 1 ETH (1e18 wei) is not divisible by every n, so we round DOWN to a multiple of n.
    let one_eth = eth_wei(1);
    let chunk_base = one_eth / (n as u128);
    assert!(
        chunk_base > 0,
        "N_MATCHES too large: chunk_base became zero"
    );

    let total_base = chunk_base * (n as u128); // divisible by construction
    assert!(total_base > 0);

    // Maker: deposit total_base and place n asks at the same price (FIFO).
    c.deposit(seller(), BASE_TOKEN_ID, total_base)
        .with_actor_id(vault())
        .await
        .unwrap();
    let mut first_id: u64 = 0;
    let mut last_id: u64 = 0;

    for i in 0..n {
        let ask_id = c
            .submit_order(
                /*side=*/ 1, // SELL
                /*kind=*/ 0, // LIMIT
                /*limit_price=*/ price, /*amount_base=*/ chunk_base,
                /*max_quote=*/ 0,
            )
            .with_actor_id(seller())
            .await
            .unwrap();

        if i == 0 {
            first_id = ask_id;
        }
        last_id = ask_id;
    }
    // Seller's free base must be 0 after locking everything in asks.
    assert_balance(&program, seller(), /*base=*/ 0, /*quote=*/ 0).await;
    assert_eq!(c.best_ask_price().await.unwrap(), price);

    // Buyer: deposit quote and submit one big strict Market BUY for total_base.
    let initial_quote = usdt_micro(10_000);
    c.deposit(buyer(), QUOTE_TOKEN_ID, initial_quote)
        .with_actor_id(vault())
        .await
        .unwrap();

    // IMPORTANT: spent_total is SUM of per-trade floor, not floor(total).
    let spent_per_trade = quote_floor_atoms(chunk_base, price);
    let spent_total = spent_per_trade * (n as u128);

    // Give some extra budget to ensure unused max_quote is refunded.
    let budget = spent_total + usdt_micro(100);
    assert!(
        budget <= initial_quote,
        "Increase initial_quote or lower N_MATCHES"
    );
    c.submit_order(
        /*side=*/ 0, // BUY
        /*kind=*/ 1, // MARKET
        /*limit_price=*/ 0, /*amount_base=*/ total_base, /*max_quote=*/ budget,
    )
    .with_actor_id(buyer())
    .await
    .unwrap();

    // Buyer receives all base and spends exactly spent_total quote.
    assert_balance(
        &program,
        buyer(),
        /*base=*/ total_base,
        /*quote=*/ initial_quote - spent_total,
    )
    .await;
    // Seller sold all base and receives spent_total quote.
    assert_balance(
        &program,
        seller(),
        /*base=*/ 0,
        /*quote=*/ spent_total,
    )
    .await;

    // Book must be empty now.
    assert_eq!(c.best_ask_price().await.unwrap(), 0);

    // Spot check that first and last orders are removed.
    let (found_first, ..) = c.order_by_id(first_id).await.unwrap();
    assert!(!found_first);

    let (found_last, ..) = c.order_by_id(last_id).await.unwrap();
    assert!(!found_last);
}

#[tokio::test]
async fn cancel_limit_buy_unlocks_reserved_quote_and_removes_order() {
    let program = setup_orderbook(1000, 1000).await;
    let mut c = program.orderbook();

    let initial_quote = usdt_micro(10_000);
    let price = price_fp_usdt_per_eth(1_900);
    let amount = eth_frac(1, 2); // 0.5 ETH

    c.deposit(buyer(), QUOTE_TOKEN_ID, initial_quote)
        .with_actor_id(vault())
        .await
        .unwrap();

    let order_id = c
        .submit_order(0, 0, price, amount, 0)
        .with_actor_id(buyer())
        .await
        .unwrap();

    let reserved = quote_ceil_atoms(amount, price);
    assert_balance(&program, buyer(), 0, initial_quote - reserved).await;

    c.cancel_order(order_id)
        .with_actor_id(buyer())
        .await
        .unwrap();

    assert_balance(&program, buyer(), 0, initial_quote).await;
    assert_eq!(c.best_bid_price().await.unwrap(), 0);
    let (found, ..) = c.order_by_id(order_id).await.unwrap();
    assert!(!found);
}

#[tokio::test]
async fn cancel_limit_sell_unlocks_locked_base_and_removes_order() {
    let program = setup_orderbook(1000, 1000).await;
    let mut c = program.orderbook();

    let initial_base = eth_wei(1);
    let price = price_fp_usdt_per_eth(2_000);
    let amount = eth_frac(3, 10); // 0.3 ETH

    c.deposit(seller(), BASE_TOKEN_ID, initial_base)
        .with_actor_id(vault())
        .await
        .unwrap();

    let order_id = c
        .submit_order(1, 0, price, amount, 0)
        .with_actor_id(seller())
        .await
        .unwrap();

    assert_balance(&program, seller(), initial_base - amount, 0).await;

    c.cancel_order(order_id)
        .with_actor_id(seller())
        .await
        .unwrap();

    assert_balance(&program, seller(), initial_base, 0).await;
    assert_eq!(c.best_ask_price().await.unwrap(), 0);
    let (found, ..) = c.order_by_id(order_id).await.unwrap();
    assert!(!found);
}

#[tokio::test]
async fn limit_buy_rejects_when_quote_balance_insufficient() {
    let program = setup_orderbook(1000, 1000).await;
    let mut c = program.orderbook();

    let initial_quote = usdt_micro(100);
    let price = price_fp_usdt_per_eth(2_000);
    let amount = eth_frac(1, 2); // requires much more than 100 USDT

    c.deposit(buyer(), QUOTE_TOKEN_ID, initial_quote)
        .with_actor_id(vault())
        .await
        .unwrap();

    let res = c
        .submit_order(0, 0, price, amount, 0)
        .with_actor_id(buyer())
        .await;
    assert!(res.is_err(), "Expected insufficient quote balance");

    assert_balance(&program, buyer(), 0, initial_quote).await;
    assert_eq!(c.best_bid_price().await.unwrap(), 0);
}

#[cfg(feature = "debug")]
#[tokio::test]
async fn populate_demo_orders_rejects_unauthorized_caller() {
    let program = setup_orderbook(1000, 1000).await;
    let mut c = program.orderbook();

    let res = c
        .populate_demo_orders(
            /*seed=*/ 42,
            /*levels=*/ 2,
            /*orders_per_level=*/ 2,
            /*mid_price=*/ price_fp_usdt_per_eth(2_000),
            /*tick_bps=*/ 100,
            /*min_amount_base=*/ eth_frac(1, 100),
            /*max_amount_base=*/ eth_frac(1, 50),
        )
        .with_actor_id(buyer())
        .await;

    assert!(res.is_err(), "Expected unauthorized populate to fail");
}

#[cfg(feature = "debug")]
#[tokio::test]
async fn populate_demo_orders_rejects_when_market_not_empty() {
    let program = setup_orderbook(1000, 1000).await;
    let mut c = program.orderbook();

    let price = price_fp_usdt_per_eth(2_000);
    c.deposit(seller(), BASE_TOKEN_ID, eth_wei(1))
        .with_actor_id(vault())
        .await
        .unwrap();
    c.submit_order(1, 0, price, eth_frac(1, 10), 0)
        .with_actor_id(seller())
        .await
        .unwrap();

    let res = c
        .populate_demo_orders(
            7,
            2,
            2,
            price_fp_usdt_per_eth(2_000),
            100,
            eth_frac(1, 100),
            eth_frac(1, 50),
        )
        .with_actor_id(ActorId::from(ADMIN_ID))
        .await;

    assert!(
        res.is_err(),
        "Expected populate to fail on non-empty market"
    );
}

#[cfg(feature = "debug")]
#[tokio::test]
async fn populate_demo_orders_is_reproducible_for_same_seed() {
    let params = (
        99u64,
        3u16,
        4u16,
        price_fp_usdt_per_eth(2_000),
        100u16,
        eth_frac(1, 100),
        eth_frac(1, 50),
    );

    let (out_a, bid_a, ask_a) = {
        let program = setup_orderbook(1000, 1000).await;
        let mut c = program.orderbook();
        let out = c
            .populate_demo_orders(
                params.0, params.1, params.2, params.3, params.4, params.5, params.6,
            )
            .with_actor_id(ActorId::from(ADMIN_ID))
            .await
            .unwrap();
        let bid = c.best_bid_price().await.unwrap();
        let ask = c.best_ask_price().await.unwrap();
        (out, bid, ask)
    };

    let (out_b, bid_b, ask_b) = {
        let program = setup_orderbook(1000, 1000).await;
        let mut c = program.orderbook();
        let out = c
            .populate_demo_orders(
                params.0, params.1, params.2, params.3, params.4, params.5, params.6,
            )
            .with_actor_id(ActorId::from(ADMIN_ID))
            .await
            .unwrap();
        let bid = c.best_bid_price().await.unwrap();
        let ask = c.best_ask_price().await.unwrap();
        (out, bid, ask)
    };

    assert_eq!(out_a, out_b);
    assert_eq!(bid_a, bid_b);
    assert_eq!(ask_a, ask_b);
}

#[cfg(feature = "debug")]
#[tokio::test]
async fn populate_demo_orders_creates_expected_top_of_book() {
    let program = setup_orderbook(1000, 1000).await;
    let mut c = program.orderbook();

    let mid = price_fp_usdt_per_eth(2_000);
    let (bids, asks, first_id, last_id) = c
        .populate_demo_orders(
            /*seed=*/ 123,
            /*levels=*/ 4,
            /*orders_per_level=*/ 3,
            /*mid_price=*/ mid,
            /*tick_bps=*/ 100,
            /*min_amount_base=*/ eth_frac(1, 20),
            /*max_amount_base=*/ eth_frac(1, 20),
        )
        .with_actor_id(ActorId::from(ADMIN_ID))
        .await
        .unwrap();

    assert_eq!(bids, 12);
    assert_eq!(asks, 12);
    assert_eq!(first_id, 1);
    assert_eq!(last_id, 24);

    let expected_best_bid =
        ((U256::from(mid) * U256::from(9_900u32)) / U256::from(10_000u32)).low_u128();
    let expected_best_ask =
        ((U256::from(mid) * U256::from(10_100u32)) / U256::from(10_000u32)).low_u128();
    assert_eq!(c.best_bid_price().await.unwrap(), expected_best_bid);
    assert_eq!(c.best_ask_price().await.unwrap(), expected_best_ask);

    let (found_first, ..) = c.order_by_id(first_id).await.unwrap();
    let (found_last, ..) = c.order_by_id(last_id).await.unwrap();
    assert!(found_first);
    assert!(found_last);
}

#[cfg(feature = "debug")]
#[tokio::test]
async fn populate_demo_orders_seeded_depth_executes_real_market_order() {
    let program = setup_orderbook(1000, 1000).await;
    let mut c = program.orderbook();

    let (.., first_order_id, _last_order_id) = c
        .populate_demo_orders(
            /*seed=*/ 777,
            /*levels=*/ 2,
            /*orders_per_level=*/ 2,
            /*mid_price=*/ price_fp_usdt_per_eth(2_000),
            /*tick_bps=*/ 100,
            /*min_amount_base=*/ eth_frac(1, 10),
            /*max_amount_base=*/ eth_frac(1, 10),
        )
        .with_actor_id(ActorId::from(ADMIN_ID))
        .await
        .unwrap();

    let best_ask_before = c.best_ask_price().await.unwrap();

    let initial_quote = usdt_micro(1_000_000);
    c.deposit(buyer(), QUOTE_TOKEN_ID, initial_quote)
        .with_actor_id(vault())
        .await
        .unwrap();

    c.submit_order(
        /*side=*/ 0, // BUY
        /*kind=*/ 1, // MARKET
        /*limit_price=*/ 0, // ignored
        /*amount_base=*/ eth_frac(21, 100),
        /*max_quote=*/ initial_quote,
    )
    .with_actor_id(buyer())
    .await
    .unwrap();

    let best_ask_after = c.best_ask_price().await.unwrap();
    assert!(
        best_ask_after > best_ask_before,
        "Expected level-1 ask to be consumed"
    );

    let (buyer_base, buyer_quote) = c.balance_of(buyer()).await.unwrap();
    assert!(buyer_base > 0);
    assert!(buyer_quote < initial_quote);

    let (found_first, ..) = c.order_by_id(first_order_id).await.unwrap();
    assert!(
        !found_first,
        "Expected first seeded ask to be fully consumed"
    );
}

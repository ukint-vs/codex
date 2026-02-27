use sails_rs::{cell::RefCell, gstd::services::Service, Syscall};

use crate::tests::common::*;
use crate::{state::State, Orderbook};
use vault_client::mockall::MockVault;
macro_rules! setup_ob {
    ($state:ident, $ob:ident) => {
        setup_ob!($state, $ob, 1000, 1000);
    };
    ($state:ident, $ob:ident, $max_trades:expr, $max_preview_scans:expr) => {
        let $state = RefCell::new(State::new(
            BASE_VAULT_ID,
            QUOTE_VAULT_ID,
            BASE_TOKEN_ID,
            QUOTE_TOKEN_ID,
            $max_trades,
            $max_preview_scans,
        ));
        let base_vault = MockVault::new();
        let quote_vault = MockVault::new();
        let mut $ob = Orderbook::new(&$state, base_vault, quote_vault).expose(&[]);
    };
}

macro_rules! deposit_base {
    ($ob:expr, $who:expr, $amount:expr) => {{
        Syscall::with_message_source(base_vault());
        assert!($ob.deposit($who, BASE_TOKEN_ID, $amount));
    }};
}

macro_rules! deposit_quote {
    ($ob:expr, $who:expr, $amount:expr) => {{
        Syscall::with_message_source(quote_vault());
        assert!($ob.deposit($who, QUOTE_TOKEN_ID, $amount));
    }};
}

macro_rules! submit {
    ($ob:expr, $caller:expr, $side:expr, $kind:expr, $price:expr, $amount:expr, $maxq:expr) => {{
        Syscall::with_message_source($caller);
        $ob.submit_order($side, $kind, $price, $amount, $maxq)
    }};
}

macro_rules! assert_balance {
    ($ob:expr, $who:expr, base=$base:expr, quote=$quote:expr) => {{
        let (b_base, b_quote) = $ob.balance_of($who);
        assert_eq!(b_base, $base);
        assert_eq!(b_quote, $quote);
    }};
}

macro_rules! assert_best {
    ($ob:expr, bid=$bid:expr, ask=$ask:expr) => {{
        assert_eq!($ob.best_bid_price(), $bid);
        assert_eq!($ob.best_ask_price(), $ask);
    }};
}

macro_rules! assert_order {
    ($ob:expr, $oid:expr, owner=$owner:expr, side=$side:expr, price=$price:expr, base=$base:expr, rq=$rq:expr) => {{
        let (found, id, owner, side_io, p, remaining_base, reserved_quote) = $ob.order_by_id($oid);
        assert!(found);
        assert_eq!(id, $oid);
        assert_eq!(owner, $owner);
        assert_eq!(side_io, $side);
        assert_eq!(p, $price);
        assert_eq!(remaining_base, $base);
        assert_eq!(reserved_quote, $rq);
    }};
}

macro_rules! assert_not_found {
    ($ob:expr, $oid:expr) => {{
        let (found, ..) = $ob.order_by_id($oid);
        assert!(!found);
    }};
}

#[test]
fn limit_sell_places_and_locks_base() {
    setup_ob!(state, ob);

    let price = price_fp_usdt_per_eth(2_000);
    let ask_amount = eth_frac(1, 2); // 0.5 ETH
    let initial_base = eth_wei(1);

    deposit_base!(ob, SELLER_ID, initial_base);

    let ask_id = submit!(ob, seller(), SELL, LIMIT, price, ask_amount, 0).unwrap();

    assert_balance!(ob, SELLER_ID, base = initial_base - ask_amount, quote = 0);
    assert_best!(ob, bid = 0, ask = price);
    assert_order!(
        ob,
        ask_id,
        owner = SELLER_ID,
        side = SELL,
        price = price,
        base = ask_amount,
        rq = 0
    );
}

#[test]
fn limit_buy_places_and_reserves_quote_ceil() {
    setup_ob!(state, ob);

    let price = price_fp_usdt_per_eth(1_900);
    let bid_amount = eth_frac(1, 2); // 0.5 ETH
    let initial_quote = usdt_micro(10_000);

    deposit_quote!(ob, BUYER_ID, initial_quote);

    let bid_id = submit!(ob, buyer(), BUY, LIMIT, price, bid_amount, 0).unwrap();

    let reserved = quote_ceil_atoms(bid_amount, price);

    assert_balance!(ob, BUYER_ID, base = 0, quote = initial_quote - reserved);
    assert_best!(ob, bid = price, ask = 0);
    assert_order!(
        ob,
        bid_id,
        owner = BUYER_ID,
        side = BUY,
        price = price,
        base = bid_amount,
        rq = reserved
    );
}

#[test]
fn limit_orders_non_crossing_rest_on_book() {
    setup_ob!(state, ob);

    // Make best ask = 2000
    let ask_price = price_fp_usdt_per_eth(2_000);
    let ask_amount = eth_frac(1, 5); // 0.2
    let initial_base = eth_wei(1);

    deposit_base!(ob, SELLER_ID, initial_base);
    let ask_id = submit!(ob, seller(), SELL, LIMIT, ask_price, ask_amount, 0).unwrap();

    assert_eq!(ob.best_ask_price(), ask_price);

    // Place bid BELOW ask (non-crossing): bid should rest
    let bid_price = price_fp_usdt_per_eth(1_900);
    let bid_amount = eth_frac(1, 4); // 0.25
    let initial_quote = usdt_micro(10_000);

    deposit_quote!(ob, BUYER_ID, initial_quote);
    let bid_id = submit!(ob, buyer(), BUY, LIMIT, bid_price, bid_amount, 0).unwrap();

    assert_best!(ob, bid = bid_price, ask = ask_price);

    // Orders remain intact
    assert_order!(
        ob,
        ask_id,
        owner = SELLER_ID,
        side = SELL,
        price = ask_price,
        base = ask_amount,
        rq = 0
    );

    let reserved = quote_ceil_atoms(bid_amount, bid_price);
    assert_order!(
        ob,
        bid_id,
        owner = BUYER_ID,
        side = BUY,
        price = bid_price,
        base = bid_amount,
        rq = reserved
    );
}

#[test]
fn limit_buy_partial_fill_across_two_asks_then_places_remainder_bid() {
    setup_ob!(state, ob);

    let ask_price_1950 = price_fp_usdt_per_eth(1_950);
    let ask_price_1990 = price_fp_usdt_per_eth(1_990);
    let limit_price_2000 = price_fp_usdt_per_eth(2_000);

    let ask1_amount = eth_frac(1, 5); // 0.2 @ 1950
    let ask2_amount = eth_frac(1, 5); // 0.2 @ 1990

    let buy_amount = eth_wei(1); // 1.0
    let filled_base = ask1_amount + ask2_amount; // 0.4
    let remaining_base = buy_amount - filled_base; // 0.6

    // makers
    let initial_base = eth_wei(1);
    deposit_base!(ob, SELLER_ID, initial_base);
    let ask1_id = submit!(ob, seller(), SELL, LIMIT, ask_price_1950, ask1_amount, 0).unwrap();

    deposit_base!(ob, SELLER2_ID, initial_base);
    let ask2_id = submit!(ob, seller2(), SELL, LIMIT, ask_price_1990, ask2_amount, 0).unwrap();

    // taker
    let initial_quote = usdt_micro(10_000);
    deposit_quote!(ob, BUYER_ID, initial_quote);

    let spent1 = quote_floor_atoms(ask1_amount, ask_price_1950);
    let spent2 = quote_floor_atoms(ask2_amount, ask_price_1990);
    let spent_total = spent1 + spent2;

    let locked_total = quote_ceil_atoms(buy_amount, limit_price_2000);

    let bid_id = submit!(ob, buyer(), BUY, LIMIT, limit_price_2000, buy_amount, 0).unwrap();

    // Buyer: received filled base; free quote decreased by total lock (remainder stays reserved in resting bid)
    assert_balance!(
        ob,
        BUYER_ID,
        base = filled_base,
        quote = initial_quote - locked_total
    );

    // Sellers: base locked at placement, quote credited by fills
    assert_balance!(
        ob,
        SELLER_ID,
        base = initial_base - ask1_amount,
        quote = spent1
    );
    assert_balance!(
        ob,
        SELLER2_ID,
        base = initial_base - ask2_amount,
        quote = spent2
    );

    // Both asks consumed
    assert_best!(ob, bid = limit_price_2000, ask = 0);

    assert_not_found!(ob, ask1_id);
    assert_not_found!(ob, ask2_id);

    // resting bid remains
    assert_order!(
        ob,
        bid_id,
        owner = BUYER_ID,
        side = BUY,
        price = limit_price_2000,
        base = remaining_base,
        rq = locked_total - spent_total
    );
}

#[test]
fn limit_sell_partial_fill_across_two_bids_then_places_remainder_ask() {
    setup_ob!(state, ob);

    let bid_price_2100 = price_fp_usdt_per_eth(2_100);
    let bid_price_2050 = price_fp_usdt_per_eth(2_050);
    let sell_limit_2000 = price_fp_usdt_per_eth(2_000);

    let bid1_amount = eth_frac(1, 5); // 0.2
    let bid2_amount = eth_frac(1, 5); // 0.2
    let filled_base = bid1_amount + bid2_amount; // 0.4

    let sell_amount = eth_wei(1); // 1.0
    let remaining_base = sell_amount - filled_base; // 0.6

    let initial_quote = usdt_micro(10_000);

    // Bid #1
    deposit_quote!(ob, BUYER_ID, initial_quote);
    let bid1_id = submit!(ob, buyer(), BUY, LIMIT, bid_price_2100, bid1_amount, 0).unwrap();

    // Bid #2
    deposit_quote!(ob, BUYER2_ID, initial_quote);
    let bid2_id = submit!(ob, buyer2(), BUY, LIMIT, bid_price_2050, bid2_amount, 0).unwrap();

    // Seller crosses with limit sell
    let initial_base = eth_wei(1);
    deposit_base!(ob, SELLER_ID, initial_base);

    let got1 = quote_floor_atoms(bid1_amount, bid_price_2100);
    let got2 = quote_floor_atoms(bid2_amount, bid_price_2050);
    let got_total = got1 + got2;

    let ask_id = submit!(ob, seller(), SELL, LIMIT, sell_limit_2000, sell_amount, 0).unwrap();

    // Seller: locked full 1 ETH => free base becomes 0; quote credited
    assert_balance!(ob, SELLER_ID, base = 0, quote = got_total);

    // Bid1 fully filled => removed, buyer quote = initial - got1
    assert_balance!(
        ob,
        BUYER_ID,
        base = bid1_amount,
        quote = initial_quote - got1
    );
    assert_not_found!(ob, bid1_id);

    // Bid2 fully filled => removed, buyer2 quote = initial - got2
    assert_balance!(
        ob,
        BUYER2_ID,
        base = bid2_amount,
        quote = initial_quote - got2
    );
    assert_not_found!(ob, bid2_id);

    // Remaining ask rests @ 2000
    assert_best!(ob, bid = 0, ask = sell_limit_2000);

    assert_order!(
        ob,
        ask_id,
        owner = SELLER_ID,
        side = SELL,
        price = sell_limit_2000,
        base = remaining_base,
        rq = 0
    );
}

#[test]
fn limit_buy_full_fill_price_improvement_refunds_difference() {
    setup_ob!(state, ob);

    let ask_price = price_fp_usdt_per_eth(1_800);
    let limit_price = price_fp_usdt_per_eth(2_000);
    let amount = eth_frac(1, 2); // 0.5

    let initial_quote = usdt_micro(10_000);
    let initial_seller_base = eth_wei(1);

    // Maker ask
    deposit_base!(ob, SELLER_ID, initial_seller_base);
    let ask_id = submit!(ob, seller(), SELL, LIMIT, ask_price, amount, 0).unwrap();

    // Taker limit buy
    deposit_quote!(ob, BUYER_ID, initial_quote);
    let bid_id = submit!(ob, buyer(), BUY, LIMIT, limit_price, amount, 0).unwrap();

    let spent = quote_floor_atoms(amount, ask_price);

    assert_balance!(ob, BUYER_ID, base = amount, quote = initial_quote - spent);
    assert_balance!(
        ob,
        SELLER_ID,
        base = initial_seller_base - amount,
        quote = spent
    );

    assert_best!(ob, bid = 0, ask = 0);

    assert_not_found!(ob, ask_id);
    assert_not_found!(ob, bid_id);
}

#[test]
fn limit_sell_full_fill_at_bid_price_refunds_bid_difference() {
    setup_ob!(state, ob);

    let bid_price = price_fp_usdt_per_eth(2_100);
    let sell_limit = price_fp_usdt_per_eth(2_000);
    let amount = eth_frac(1, 2); // 0.5

    let initial_quote = usdt_micro(10_000);
    let initial_seller_base = eth_wei(1);

    // Maker bid
    deposit_quote!(ob, BUYER_ID, initial_quote);
    let bid_id = submit!(ob, buyer(), BUY, LIMIT, bid_price, amount, 0).unwrap();

    // Seller crosses
    deposit_base!(ob, SELLER_ID, initial_seller_base);

    let got = quote_floor_atoms(amount, bid_price);

    let ask_id = submit!(ob, seller(), SELL, LIMIT, sell_limit, amount, 0).unwrap();

    assert_balance!(
        ob,
        SELLER_ID,
        base = initial_seller_base - amount,
        quote = got
    );
    assert_balance!(ob, BUYER_ID, base = amount, quote = initial_quote - got);

    assert_best!(ob, bid = 0, ask = 0);

    assert_not_found!(ob, bid_id);
    assert_not_found!(ob, ask_id);
}

#[test]
fn limit_buy_fifo_within_same_price_level_full_fill_removes_taker_and_preserves_resting() {
    setup_ob!(state, ob);

    let price = price_fp_usdt_per_eth(2_000);

    let ask_a = eth_frac(1, 5); // 0.2 (first)
    let ask_b = eth_frac(1, 5); // 0.2 (second)
    let buy = eth_frac(1, 4); // 0.25 => 0.2 + 0.05
    let fill_b = buy - ask_a; // 0.05

    let initial_quote = usdt_micro(10_000);
    let initial_base = eth_wei(1);

    deposit_base!(ob, SELLER_ID, initial_base);
    let ask_a_id = submit!(ob, seller(), SELL, LIMIT, price, ask_a, 0).unwrap();

    deposit_base!(ob, SELLER2_ID, initial_base);
    let ask_b_id = submit!(ob, seller2(), SELL, LIMIT, price, ask_b, 0).unwrap();

    deposit_quote!(ob, BUYER_ID, initial_quote);
    let bid_id = submit!(ob, buyer(), BUY, LIMIT, price, buy, 0).unwrap();

    let spent_a = quote_floor_atoms(ask_a, price);
    let spent_b = quote_floor_atoms(fill_b, price);

    assert_balance!(
        ob,
        BUYER_ID,
        base = buy,
        quote = initial_quote - (spent_a + spent_b)
    );
    // FIFO: first ask removed, second remains with reduced base
    assert_not_found!(ob, ask_a_id);
    assert_order!(
        ob,
        ask_b_id,
        owner = SELLER2_ID,
        side = SELL,
        price = price,
        base = ask_b - fill_b,
        rq = 0
    );

    // taker removed
    assert_not_found!(ob, bid_id);

    assert_balance!(ob, SELLER_ID, base = initial_base - ask_a, quote = spent_a);
    assert_balance!(ob, SELLER2_ID, base = initial_base - ask_b, quote = spent_b);

    assert_best!(ob, bid = 0, ask = price);
}

#[test]
fn limit_sell_fifo_within_same_price_level_partial_consumes_second_bid_and_updates_reserved_quote()
{
    setup_ob!(state, ob);

    let price = price_fp_usdt_per_eth(1_900);

    let bid_a = eth_frac(1, 5); // 0.2 (first)
    let bid_b = eth_frac(1, 5); // 0.2 (second)
    let sell = eth_frac(1, 4); // 0.25
    let fill_b = sell - bid_a; // 0.05

    let initial_quote = usdt_micro(10_000);
    let initial_base = eth_wei(1);

    // Place two bids same price => FIFO
    deposit_quote!(ob, BUYER_ID, initial_quote);
    let bid_a_id = submit!(ob, buyer(), BUY, LIMIT, price, bid_a, 0).unwrap();
    let locked_a = quote_ceil_atoms(bid_a, price);

    deposit_quote!(ob, BUYER2_ID, initial_quote);
    let bid_b_id = submit!(ob, buyer2(), BUY, LIMIT, price, bid_b, 0).unwrap();
    let locked_b = quote_ceil_atoms(bid_b, price);

    // Seller crosses
    deposit_base!(ob, SELLER_ID, initial_base);
    let ask_id = submit!(
        ob,
        seller(),
        SELL,
        LIMIT,
        price_fp_usdt_per_eth(1_800),
        sell,
        0
    )
    .unwrap();

    // taker full filled => removed
    assert_not_found!(ob, ask_id);

    let got_a = quote_floor_atoms(bid_a, price);
    let got_b = quote_floor_atoms(fill_b, price);

    assert_balance!(
        ob,
        SELLER_ID,
        base = initial_base - sell,
        quote = got_a + got_b
    );

    // Bid A fully filled => removed + refund leftover
    assert_balance!(ob, BUYER_ID, base = bid_a, quote = initial_quote - got_a);
    assert_not_found!(ob, bid_a_id);
    assert!(locked_a >= got_a);

    // Bid B partially filled => remains, reserved reduced by got_b
    assert_balance!(
        ob,
        BUYER2_ID,
        base = fill_b,
        quote = initial_quote - locked_b
    );
    assert_order!(
        ob,
        bid_b_id,
        owner = BUYER2_ID,
        side = BUY,
        price = price,
        base = bid_b - fill_b,
        rq = locked_b - got_b
    );

    assert_best!(ob, bid = price, ask = 0);
}

#[test]
fn cancel_limit_buy_unlocks_reserved_quote_and_removes_order() {
    setup_ob!(state, ob);

    let price = price_fp_usdt_per_eth(1_900);
    let bid_amount = eth_frac(1, 2);
    let initial_quote = usdt_micro(10_000);

    deposit_quote!(ob, BUYER_ID, initial_quote);

    let bid_id = submit!(ob, buyer(), BUY, LIMIT, price, bid_amount, 0).unwrap();
    let reserved = quote_ceil_atoms(bid_amount, price);

    assert_balance!(ob, BUYER_ID, base = 0, quote = initial_quote - reserved);
    assert_best!(ob, bid = price, ask = 0);

    ob.cancel_order(bid_id);

    assert_balance!(ob, BUYER_ID, base = 0, quote = initial_quote);
    assert_best!(ob, bid = 0, ask = 0);
    assert_not_found!(ob, bid_id);
}

#[test]
fn cancel_limit_sell_unlocks_locked_base_and_removes_order() {
    setup_ob!(state, ob);

    let price = price_fp_usdt_per_eth(2_000);
    let ask_amount = eth_frac(1, 2);
    let initial_base = eth_wei(1);

    deposit_base!(ob, SELLER_ID, initial_base);

    let ask_id = submit!(ob, seller(), SELL, LIMIT, price, ask_amount, 0).unwrap();

    assert_balance!(ob, SELLER_ID, base = initial_base - ask_amount, quote = 0);
    assert_best!(ob, bid = 0, ask = price);

    ob.cancel_order(ask_id);

    assert_balance!(ob, SELLER_ID, base = initial_base, quote = 0);
    assert_best!(ob, bid = 0, ask = 0);
    assert_not_found!(ob, ask_id);
}

#[test]
fn cancel_limit_buy_after_partial_fill_unlocks_leftover_reserved_quote() {
    setup_ob!(state, ob);

    let ask_price = price_fp_usdt_per_eth(1_950);
    let limit_price = price_fp_usdt_per_eth(2_000);

    let ask_amount = eth_frac(2, 5); // 0.4
    let buy_amount = eth_wei(1); // 1.0

    let initial_quote = usdt_micro(10_000);
    let initial_base = eth_wei(1);

    // Maker ask 0.4 @ 1950
    deposit_base!(ob, SELLER_ID, initial_base);
    let ask_id = submit!(ob, seller(), SELL, LIMIT, ask_price, ask_amount, 0).unwrap();

    // Buyer places LIMIT BUY 1.0 @ 2000 => partial fill + remainder rests as bid
    deposit_quote!(ob, BUYER_ID, initial_quote);
    let bid_id = submit!(ob, buyer(), BUY, LIMIT, limit_price, buy_amount, 0).unwrap();

    let spent = quote_floor_atoms(ask_amount, ask_price);
    let locked = quote_ceil_atoms(buy_amount, limit_price);
    // While resting: buyer free quote = initial - locked; base credited 0.4
    assert_balance!(
        ob,
        BUYER_ID,
        base = ask_amount,
        quote = initial_quote - locked
    );

    // Ask consumed
    assert_not_found!(ob, ask_id);

    // Now cancel the resting bid => releases leftover reserved_quote
    Syscall::with_message_source(buyer());
    ob.cancel_order(bid_id);

    // After cancel: buyer quote should be initial - spent, base stays 0.4
    assert_balance!(
        ob,
        BUYER_ID,
        base = ask_amount,
        quote = initial_quote - spent
    );
    assert_best!(ob, bid = 0, ask = 0);
    assert_not_found!(ob, bid_id);

    assert!(locked >= spent);
}

#[test]
fn cancel_limit_sell_after_partial_fill_unlocks_leftover_base() {
    setup_ob!(state, ob);

    let price = price_fp_usdt_per_eth(2_000);

    let bid_price = price_fp_usdt_per_eth(2_100);
    let sell_limit = price_fp_usdt_per_eth(2_000);

    let bid_amount = eth_frac(2, 5); // 0.4
    let sell_amount = eth_wei(1); // 1.0
    let remaining_base = sell_amount - bid_amount; // 0.6

    let initial_quote = usdt_micro(10_000);
    let initial_seller_base = eth_wei(1);

    // Maker bid 0.4 @ 2100
    deposit_quote!(ob, BUYER_ID, initial_quote);
    let bid_id = submit!(ob, buyer(), BUY, LIMIT, bid_price, bid_amount, 0).unwrap();

    // Seller places LIMIT SELL 1.0 @ 2000 => fills 0.4, remainder rests as ask 0.6 @ 2000
    deposit_base!(ob, SELLER_ID, initial_seller_base);
    let ask_id = submit!(ob, seller(), SELL, LIMIT, sell_limit, sell_amount, 0).unwrap();
    // Bid consumed
    assert_not_found!(ob, bid_id);

    let got = quote_floor_atoms(bid_amount, bid_price);

    // Seller locked full 1.0 at placement => free base = 0; quote credited by got
    assert_balance!(ob, SELLER_ID, base = 0, quote = got);

    // Resting ask exists with remaining_base 0.6
    assert_order!(
        ob,
        ask_id,
        owner = SELLER_ID,
        side = SELL,
        price = price,
        base = remaining_base,
        rq = 0
    );

    assert_best!(ob, bid = 0, ask = sell_limit);

    // Cancel => unlock remaining_base back to free base (seller sold 0.4, so should end with 0.6)
    Syscall::with_message_source(seller());
    ob.cancel_order(ask_id);

    assert_balance!(ob, SELLER_ID, base = remaining_base, quote = got);
    assert_best!(ob, bid = 0, ask = 0);
    assert_not_found!(ob, ask_id);
}

#[test]
#[should_panic(expected = "insufficient quote")]
fn limit_buy_fails_without_sufficient_quote_balance() {
    setup_ob!(state, ob);

    let price = price_fp_usdt_per_eth(2_000);
    let bid_amount = eth_frac(1, 2);

    // no deposit => should fail
    let _ = submit!(ob, buyer(), BUY, LIMIT, price, bid_amount, 0);
}

#[test]
#[should_panic(expected = "insufficient base")]
fn limit_sell_fails_without_sufficient_base_balance() {
    setup_ob!(state, ob);

    let price = price_fp_usdt_per_eth(2_000);
    let ask_amount = eth_frac(1, 2);

    // no deposit => should fail
    let _ = submit!(ob, seller(), SELL, LIMIT, price, ask_amount, 0);
}

#[test]
fn limit_order_rejects_zero_amount() {
    setup_ob!(state, ob);

    let price = price_fp_usdt_per_eth(2_000);

    deposit_quote!(ob, BUYER_ID, usdt_micro(10_000));
    let res = submit!(ob, buyer(), BUY, LIMIT, price, /*base=*/ 0, 0);
    assert!(res.is_err());
}

#[test]
fn limit_order_rejects_zero_price() {
    setup_ob!(state, ob);

    deposit_quote!(ob, BUYER_ID, usdt_micro(10_000));
    let res = submit!(
        ob,
        buyer(),
        BUY,
        LIMIT,
        /*price=*/ 0,
        eth_frac(1, 2),
        0
    );
    assert!(res.is_err());
}

#[tokio::test]
#[should_panic(expected = "Order not found")]
async fn cancel_panics_if_order_not_found() {
    setup_ob!(state, ob);

    Syscall::with_message_source(buyer());
    ob.cancel_order(42);
}

#[tokio::test]
#[should_panic(expected = "Not order owner")]
async fn cancel_panics_if_not_owner() {
    setup_ob!(state, ob);

    // place a BUY LIMIT by BUYER_ID
    let price = price_fp_usdt_per_eth(1_900);
    let bid_amount = eth_frac(1, 2);
    let initial_quote = usdt_micro(10_000);

    deposit_quote!(ob, BUYER_ID, initial_quote);
    let bid_id = submit!(ob, buyer(), BUY, LIMIT, price, bid_amount, 0).unwrap();

    // different caller tries to cancel
    Syscall::with_message_source(buyer2());
    ob.cancel_order(bid_id);
}

#[tokio::test]
async fn limit_buy_with_nonzero_max_quote_is_err() {
    setup_ob!(state, ob);

    let price = price_fp_usdt_per_eth(2_000);
    let bid_amount = eth_frac(1, 2);
    let initial_quote = usdt_micro(10_000);

    deposit_quote!(ob, BUYER_ID, initial_quote);

    let res = submit!(
        ob,
        buyer(),
        BUY,
        LIMIT,
        price,
        bid_amount,
        /*max_quote=*/ 1
    );
    assert!(res.is_err());
    assert_best!(ob, bid = 0, ask = 0);
}

#[tokio::test]
async fn limit_sell_with_nonzero_max_quote_is_err() {
    setup_ob!(state, ob);

    let price = price_fp_usdt_per_eth(2_000);
    let ask_amount = eth_frac(1, 2);
    let initial_base = eth_wei(1);

    deposit_base!(ob, SELLER_ID, initial_base);

    let res = submit!(
        ob,
        seller(),
        SELL,
        LIMIT,
        price,
        ask_amount,
        /*max_quote=*/ 1
    );
    assert!(res.is_err());

    assert_best!(ob, bid = 0, ask = 0);
}

#[test]
#[should_panic(expected = "Invalid side")]
fn submit_order_invalid_side_panics() {
    setup_ob!(state, ob);
    let _ = submit!(ob, buyer(), /* invalid */ 9, LIMIT, 1, 1, 0);
}

#[test]
#[should_panic(expected = "Invalid kind")]
fn submit_order_invalid_kind_panics() {
    setup_ob!(state, ob);
    let _ = submit!(ob, buyer(), BUY, /* invalid */ 9, 1, 1, 0);
}

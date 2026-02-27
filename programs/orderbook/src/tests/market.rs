use crate::tests::common::*;
use crate::{state::State, Orderbook};
use sails_rs::{cell::RefCell, gstd::services::Service, gstd::Syscall};
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

#[tokio::test]
async fn market_buy_partial_fill_preserves_resting_ask_and_refunds_unused_budget() {
    setup_ob!(state, ob);

    let ask_price = price_fp_usdt_per_eth(2_000);

    let maker_base = eth_wei(1);
    let ask_amount = eth_wei(1); // maker posts 1.0
    let buy_amount = eth_frac(1, 2); // taker buys 0.5

    let initial_quote = usdt_micro(10_000);
    let max_quote = initial_quote; // lock full budget, refund unused

    // maker: LIMIT SELL 1.0 @ 2000
    deposit_base!(ob, SELLER_ID, maker_base);
    Syscall::with_message_source(seller());
    let ask_id = ob
        .submit_order(SELL, LIMIT, ask_price, ask_amount, 0)
        .unwrap();

    // taker: MARKET BUY 0.5 with budget=max_quote
    deposit_quote!(ob, BUYER_ID, initial_quote);
    Syscall::with_message_source(buyer());
    let taker_id = ob
        .submit_order(
            BUY, MARKET, /*limit_price ignored*/ 0, buy_amount, max_quote,
        )
        .unwrap();

    let spent = quote_floor_atoms(buy_amount, ask_price);

    // buyer: got base, quote decreased only by spent (budget refunded)
    assert_balance!(
        ob,
        BUYER_ID,
        base = buy_amount,
        quote = initial_quote - spent
    );

    // maker: base was fully locked at placement (1.0), remains 0 free; quote credited by spent
    assert_balance!(ob, SELLER_ID, base = 0, quote = spent);

    // ask remains with 0.5 base
    assert_order!(
        ob,
        ask_id,
        owner = SELLER_ID,
        side = SELL,
        price = ask_price,
        base = ask_amount - buy_amount,
        rq = 0
    );

    // market taker order never rests
    assert_not_found!(ob, taker_id);

    assert_best!(ob, bid = 0, ask = ask_price);
}

#[tokio::test]
async fn market_buy_full_fill_removes_ask_and_refunds_budget() {
    setup_ob!(state, ob);

    let ask_price = price_fp_usdt_per_eth(1_900);

    let maker_base = eth_wei(1);
    let ask_amount = eth_frac(1, 5); // 0.2
    let buy_amount = ask_amount; // buy all

    let initial_quote = usdt_micro(10_000);
    let max_quote = initial_quote;

    deposit_base!(ob, SELLER_ID, maker_base);
    Syscall::with_message_source(seller());
    let ask_id = ob
        .submit_order(SELL, LIMIT, ask_price, ask_amount, 0)
        .unwrap();

    deposit_quote!(ob, BUYER_ID, initial_quote);
    Syscall::with_message_source(buyer());
    let taker_id = ob
        .submit_order(BUY, MARKET, 0, buy_amount, max_quote)
        .unwrap();

    let spent = quote_floor_atoms(buy_amount, ask_price);

    assert_balance!(
        ob,
        BUYER_ID,
        base = buy_amount,
        quote = initial_quote - spent
    );
    assert_balance!(ob, SELLER_ID, base = maker_base - ask_amount, quote = spent);

    assert_not_found!(ob, ask_id);
    assert_not_found!(ob, taker_id);

    assert_best!(ob, bid = 0, ask = 0);
}

#[tokio::test]
async fn market_buy_rejects_zero_max_quote() {
    setup_ob!(state, ob);

    // have some quote, but max_quote=0 is invalid for market buy
    let initial_quote = usdt_micro(10_000);
    deposit_quote!(ob, BUYER_ID, initial_quote);

    Syscall::with_message_source(buyer());
    let res = ob.submit_order(BUY, MARKET, 0, eth_frac(1, 2), /*max_quote=*/ 0);
    assert!(res.is_err());

    assert_best!(ob, bid = 0, ask = 0);
}

#[tokio::test]
async fn market_buy_budget_exceeded_is_err() {
    setup_ob!(state, ob);

    let ask_price = price_fp_usdt_per_eth(2_000);
    let ask_amount = eth_frac(1, 2); // 0.5
    let buy_amount = ask_amount;

    let initial_quote = usdt_micro(10_000);

    // maker ask
    deposit_base!(ob, SELLER_ID, eth_wei(1));
    Syscall::with_message_source(seller());
    ob.submit_order(SELL, LIMIT, ask_price, ask_amount, 0)
        .unwrap();

    // set max_quote too small
    let required = quote_floor_atoms(buy_amount, ask_price);
    let max_quote = required - 1;

    deposit_quote!(ob, BUYER_ID, initial_quote);

    Syscall::with_message_source(buyer());
    let res = ob.submit_order(BUY, MARKET, 0, buy_amount, max_quote);
    assert!(res.is_err());
}

#[tokio::test]
async fn market_buy_insufficient_liquidity_is_err() {
    setup_ob!(state, ob);

    // no asks in book => strict market buy should fail
    let initial_quote = usdt_micro(10_000);
    deposit_quote!(ob, BUYER_ID, initial_quote);

    Syscall::with_message_source(buyer());
    let res = ob.submit_order(
        BUY,
        MARKET,
        0,
        eth_frac(1, 2),
        /*max_quote=*/ initial_quote,
    );
    assert!(res.is_err());
}

#[tokio::test]
async fn market_sell_no_liquidity_cancels_all() {
    setup_ob!(state, ob);

    let initial_base = eth_wei(1);

    deposit_base!(ob, SELLER_ID, initial_base);
    let before: (u128, u128) = ob.balance_of(SELLER_ID);

    // no bids => market sell should cancel everything, leaving balances unchanged
    Syscall::with_message_source(seller());
    let taker_id = ob
        .submit_order(
            SELL,
            MARKET,
            0,
            initial_base,
            /*max_quote must be 0*/ 0,
        )
        .unwrap();

    assert_eq!(ob.balance_of(SELLER_ID), before);
    assert_not_found!(ob, taker_id);
    assert_best!(ob, bid = 0, ask = 0);
}

#[tokio::test]
async fn market_sell_partial_fill_unlocks_remaining_base_and_does_not_rest() {
    setup_ob!(state, ob);

    let bid_price = price_fp_usdt_per_eth(2_100);
    let bid_amount = eth_frac(2, 5); // 0.4

    let sell_amount = eth_wei(1); // 1.0 market sell => fills 0.4 then cancels 0.6
    let remaining_base = sell_amount - bid_amount;

    let initial_quote = usdt_micro(10_000);
    let initial_seller_base = eth_wei(1);

    // maker bid 0.4 @ 2100
    deposit_quote!(ob, BUYER_ID, initial_quote);
    Syscall::with_message_source(buyer());
    let bid_id = ob
        .submit_order(BUY, LIMIT, bid_price, bid_amount, 0)
        .unwrap();

    // taker market sell 1.0
    deposit_base!(ob, SELLER_ID, initial_seller_base);
    Syscall::with_message_source(seller());
    let taker_id = ob.submit_order(SELL, MARKET, 0, sell_amount, 0).unwrap();

    let got = quote_floor_atoms(bid_amount, bid_price);

    // seller: receives quote for filled part, remaining base unlocked
    assert_balance!(ob, SELLER_ID, base = remaining_base, quote = got);

    // bid consumed
    assert_not_found!(ob, bid_id);

    // taker market order never rests
    assert_not_found!(ob, taker_id);

    assert_best!(ob, bid = 0, ask = 0);
}

#[tokio::test]
async fn market_sell_with_nonzero_max_quote_is_err() {
    setup_ob!(state, ob);

    let initial_base = eth_wei(1);
    deposit_base!(ob, SELLER_ID, initial_base);

    Syscall::with_message_source(seller());
    let res = ob.submit_order(SELL, MARKET, 0, eth_frac(1, 2), /*invalid*/ 1);
    assert!(res.is_err());
}

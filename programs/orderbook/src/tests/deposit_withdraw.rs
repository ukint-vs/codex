extern crate gstd;
use dex_common::Address;
use gstd::errors::{Error, ErrorReplyPayload, ErrorReplyReason};
use sails_rs::{cell::RefCell, client::PendingCall, gstd::services::Service, Syscall};

use crate::tests::common::*;
use crate::{state::State, Orderbook};
use vault_client::mockall::MockVault;
macro_rules! assert_balance {
    ($ob:expr, $who:expr, base=$base:expr, quote=$quote:expr) => {{
        let (b_base, b_quote) = $ob.balance_of($who);
        assert_eq!(b_base, $base);
        assert_eq!(b_quote, $quote);
    }};
}
#[test]
fn deposit_base_allowed_updates_balance_and_returns_true() {
    let state = RefCell::new(State::new(
        BASE_VAULT_ID,
        QUOTE_VAULT_ID,
        BASE_TOKEN_ID,
        QUOTE_TOKEN_ID,
        1000,
        1000,
    ));
    let mut ob = Orderbook::new(&state, MockVault::new(), MockVault::new()).expose(&[]);

    Syscall::with_message_source(base_vault());
    let ok = ob.deposit(SELLER_ID, BASE_TOKEN_ID, eth_wei(1));

    assert!(ok);
    assert_balance!(ob, SELLER_ID, base = eth_wei(1), quote = 0);
}

#[test]
fn deposit_quote_allowed_updates_balance_and_returns_true() {
    let state = RefCell::new(State::new(
        BASE_VAULT_ID,
        QUOTE_VAULT_ID,
        BASE_TOKEN_ID,
        QUOTE_TOKEN_ID,
        1000,
        1000,
    ));
    let mut ob = Orderbook::new(&state, MockVault::new(), MockVault::new()).expose(&[]);

    Syscall::with_message_source(quote_vault());
    let ok = ob.deposit(BUYER_ID, QUOTE_TOKEN_ID, usdt_micro(10_000));

    assert!(ok);
    assert_balance!(ob, BUYER_ID, base = 0, quote = usdt_micro(10_000));
}

#[test]
#[should_panic(expected = "Not allowed to deposit")]
fn deposit_base_wrong_caller_panics() {
    let state = RefCell::new(State::new(
        BASE_VAULT_ID,
        QUOTE_VAULT_ID,
        BASE_TOKEN_ID,
        QUOTE_TOKEN_ID,
        1000,
        1000,
    ));
    let mut ob = Orderbook::new(&state, MockVault::new(), MockVault::new()).expose(&[]);

    Syscall::with_message_source(seller());
    ob.deposit(SELLER_ID, BASE_TOKEN_ID, eth_wei(1));
}

#[test]
#[should_panic(expected = "Not allowed to deposit")]
fn deposit_quote_wrong_caller_panics() {
    let state = RefCell::new(State::new(
        BASE_VAULT_ID,
        QUOTE_VAULT_ID,
        BASE_TOKEN_ID,
        QUOTE_TOKEN_ID,
        1000,
        1000,
    ));
    let mut ob = Orderbook::new(&state, MockVault::new(), MockVault::new()).expose(&[]);

    Syscall::with_message_source(buyer());
    ob.deposit(BUYER_ID, QUOTE_TOKEN_ID, usdt_micro(1_000));
}

#[test]
#[should_panic(expected = "Invalid token")]
fn deposit_invalid_token_panics() {
    let state = RefCell::new(State::new(
        BASE_VAULT_ID,
        QUOTE_VAULT_ID,
        BASE_TOKEN_ID,
        QUOTE_TOKEN_ID,
        1000,
        1000,
    ));
    let mut ob = Orderbook::new(&state, MockVault::new(), MockVault::new()).expose(&[]);

    Syscall::with_message_source(base_vault());

    let invalid_token: Address = Address::from([9u8; 20]);
    ob.deposit(SELLER_ID, invalid_token, 1);
}

#[tokio::test]
async fn withdraw_base_success_calls_vault_and_decreases_balance() {
    let state = RefCell::new(State::new(
        BASE_VAULT_ID,
        QUOTE_VAULT_ID,
        BASE_TOKEN_ID,
        QUOTE_TOKEN_ID,
        1000,
        1000,
    ));

    let amount = eth_frac(1, 2); // 0.5 ETH

    let mut mock_base_vault = MockVault::new();
    mock_base_vault
        .expect_vault_deposit()
        .withf(move |addr, a| addr.0 == SELLER_ID.0 && *a == amount)
        .times(1)
        .returning(|_addr, _amount| PendingCall::from_output(()));

    let mock_quote_vault = MockVault::new();

    let mut ob = Orderbook::new(&state, mock_base_vault, mock_quote_vault).expose(&[]);

    Syscall::with_message_source(base_vault());
    ob.deposit(SELLER_ID, BASE_TOKEN_ID, eth_wei(1));
    Syscall::with_message_source(seller());
    ob.withdraw_base(amount).await;

    assert_balance!(ob, SELLER_ID, base = eth_wei(1) - amount, quote = 0);
}

#[tokio::test]
async fn withdraw_base_failure_rolls_back_balance() {
    let state = RefCell::new(State::new(
        BASE_VAULT_ID,
        QUOTE_VAULT_ID,
        BASE_TOKEN_ID,
        QUOTE_TOKEN_ID,
        1000,
        1000,
    ));

    let amount = eth_frac(1, 2);

    let mut mock_base_vault = MockVault::new();
    mock_base_vault
        .expect_vault_deposit()
        .times(1)
        .returning(|_addr, _amount| {
            PendingCall::from_error(Error::ErrorReply(
                ErrorReplyPayload(b"panic".to_vec()),
                ErrorReplyReason::Unsupported,
            ))
        });

    let mock_quote_vault = MockVault::new();

    let mut ob = Orderbook::new(&state, mock_base_vault, mock_quote_vault).expose(&[]);

    Syscall::with_message_source(base_vault());
    ob.deposit(SELLER_ID, BASE_TOKEN_ID, eth_wei(1));

    Syscall::with_message_source(seller());
    ob.withdraw_base(amount).await;

    assert_balance!(ob, SELLER_ID, base = eth_wei(1), quote = 0);
}

#[tokio::test]
#[should_panic]
async fn withdraw_base_insufficient_funds_panics() {
    let state = RefCell::new(State::new(
        BASE_VAULT_ID,
        QUOTE_VAULT_ID,
        BASE_TOKEN_ID,
        QUOTE_TOKEN_ID,
        1000,
        1000,
    ));

    let mut ob = Orderbook::new(&state, MockVault::new(), MockVault::new()).expose(&[]);

    Syscall::with_message_source(seller());
    ob.withdraw_base(1).await;
}

#[tokio::test]
async fn withdraw_quote_success_calls_vault_and_decreases_balance() {
    let state = RefCell::new(State::new(
        BASE_VAULT_ID,
        QUOTE_VAULT_ID,
        BASE_TOKEN_ID,
        QUOTE_TOKEN_ID,
        1000,
        1000,
    ));

    let amount = usdt_micro(4_000);

    let mock_base_vault = MockVault::new();

    let mut mock_quote_vault = MockVault::new();
    mock_quote_vault
        .expect_vault_deposit()
        .withf(move |addr, a| addr.0 == BUYER_ID.0 && *a == amount)
        .times(1)
        .returning(|_addr, _amount| PendingCall::from_output(()));

    let mut ob = Orderbook::new(&state, mock_base_vault, mock_quote_vault).expose(&[]);

    Syscall::with_message_source(quote_vault());
    ob.deposit(BUYER_ID, QUOTE_TOKEN_ID, usdt_micro(10_000));

    Syscall::with_message_source(buyer());
    ob.withdraw_quote(amount).await;

    assert_balance!(ob, BUYER_ID, base = 0, quote = usdt_micro(10_000) - amount);
}

#[tokio::test]
async fn withdraw_quote_failure_rolls_back_balance() {
    let state = RefCell::new(State::new(
        BASE_VAULT_ID,
        QUOTE_VAULT_ID,
        BASE_TOKEN_ID,
        QUOTE_TOKEN_ID,
        1000,
        1000,
    ));

    let amount = usdt_micro(4_000);

    let mock_base_vault = MockVault::new();

    let mut mock_quote_vault = MockVault::new();
    mock_quote_vault
        .expect_vault_deposit()
        .times(1)
        .returning(|_addr, _amount| {
            PendingCall::from_error(Error::ErrorReply(
                ErrorReplyPayload(b"panic".to_vec()),
                ErrorReplyReason::Unsupported,
            ))
        });

    let mut ob = Orderbook::new(&state, mock_base_vault, mock_quote_vault).expose(&[]);

    Syscall::with_message_source(quote_vault());
    ob.deposit(BUYER_ID, QUOTE_TOKEN_ID, usdt_micro(10_000));

    Syscall::with_message_source(buyer());
    ob.withdraw_quote(amount).await;

    assert_balance!(ob, BUYER_ID, base = 0, quote = usdt_micro(10_000));
}

#[tokio::test]
#[should_panic]
async fn withdraw_quote_insufficient_funds_panics() {
    let state = RefCell::new(State::new(
        BASE_VAULT_ID,
        QUOTE_VAULT_ID,
        BASE_TOKEN_ID,
        QUOTE_TOKEN_ID,
        1000,
        1000,
    ));

    let mut ob = Orderbook::new(&state, MockVault::new(), MockVault::new()).expose(&[]);

    Syscall::with_message_source(buyer());
    ob.withdraw_quote(1).await;
}

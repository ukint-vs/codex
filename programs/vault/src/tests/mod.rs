use crate::orderbook_client::ob_client::orderbook::io::Deposit as ObDepositCall;
use crate::{
    market_gateway::MarketGateway,
    state::{QuarantineEntry, UserBalance, VaultState},
    VaultService,
};
use dex_common::Address;
use sails_rs::gstd::services::Service;
use sails_rs::prelude::*;
use sails_rs::{
    cell::RefCell,
    client::{GstdEnv, PendingCall},
    ActorId, Syscall,
};

pub const ADMIN_ID: Address = Address::from_bytes([21u8; 20]);
pub const TOKEN_ID: Address = Address::from_bytes([20u8; 20]);
pub const USER_ID: Address = Address::from_bytes([7u8; 20]);
pub const MARKET_ID: Address = Address::from_bytes([5u8; 20]);

pub fn admin() -> ActorId {
    ActorId::from(ADMIN_ID)
}

pub fn user() -> ActorId {
    ActorId::from(USER_ID)
}

fn user_balance(amount: u128) -> UserBalance {
    UserBalance {
        amount,
        quarantined: Vec::new(),
    }
}

fn quarantine(amount: u128, release_timestamp: u64) -> QuarantineEntry {
    QuarantineEntry {
        amount,
        release_timestamp,
    }
}

fn fresh_state() -> RefCell<VaultState> {
    RefCell::new(VaultState {
        admin: Some(ADMIN_ID),
        token: TOKEN_ID,
        ..Default::default()
    })
}

#[derive(Clone, Copy)]
enum Mode {
    Ok,
    Err,
}

#[derive(Clone, Copy)]
struct MockMarketGateway {
    mode: Mode,
}

impl MockMarketGateway {
    fn new(mode: Mode) -> Self {
        MockMarketGateway { mode }
    }
}

impl MarketGateway for MockMarketGateway {
    fn deposit_to_market(
        &self,
        _market_id: Address,
        _user: Address,
        _token: Address,
        _amount: u128,
    ) -> PendingCall<ObDepositCall, GstdEnv> {
        match self.mode {
            Mode::Ok => PendingCall::from_output(true),
            Mode::Err => PendingCall::from_error(gstd::errors::Error::ErrorReply(
                gstd::errors::ErrorReplyPayload(b"ob-fail".to_vec()),
                gstd::errors::ErrorReplyReason::Unsupported,
            )),
        }
    }
}

#[test]
fn add_market() {
    let state = fresh_state();
    let mut vault = VaultService::new(&state, MockMarketGateway::new(Mode::Ok)).expose(&[]);

    let program_id = Address::from_bytes([5u8; 20]);
    Syscall::with_message_source(admin());
    vault.add_market(program_id);
    assert!(vault.is_authorized(program_id));
}

#[test]
#[should_panic(expected = "Unauthorized: Not Admin")]
fn add_market_wrong_admin() {
    let state = fresh_state();
    let mut vault = VaultService::new(&state, MockMarketGateway::new(Mode::Ok)).expose(&[]);

    let wrong_admin = ActorId::from(1000);
    Syscall::with_message_source(wrong_admin);
    vault.add_market(MARKET_ID);
}

#[test]
fn update_fee_rate_admin_sets_value() {
    let state = fresh_state();
    let mut vault = VaultService::new(&state, MockMarketGateway::new(Mode::Ok)).expose(&[]);

    Syscall::with_message_source(admin());
    vault.update_fee_rate(500);

    assert_eq!(state.borrow().fee_rate_bps, 500);
}

#[test]
#[should_panic(expected = "Unauthorized: Not Admin")]
fn update_fee_rate_wrong_admin_panics() {
    let state = fresh_state();
    let mut vault = VaultService::new(&state, MockMarketGateway::new(Mode::Ok)).expose(&[]);

    let wrong_admin = ActorId::from(1000);
    Syscall::with_message_source(wrong_admin);
    vault.update_fee_rate(500);
}

#[test]
#[should_panic(expected = "InvalidRate")]
fn update_fee_rate_invalid_rate_panics() {
    let state = fresh_state();
    let mut vault = VaultService::new(&state, MockMarketGateway::new(Mode::Ok)).expose(&[]);

    Syscall::with_message_source(admin());
    vault.update_fee_rate(10001);
}

#[test]
fn set_quarantine_period_admin_sets_value() {
    let state = fresh_state();
    let mut vault = VaultService::new(&state, MockMarketGateway::new(Mode::Ok)).expose(&[]);

    Syscall::with_message_source(admin());
    vault.set_quarantine_period(123);

    assert_eq!(state.borrow().quarantine_period, 123);
}

#[test]
#[should_panic(expected = "Unauthorized: Not Admin")]
fn set_quarantine_period_wrong_admin_panics() {
    let state = fresh_state();
    let mut vault = VaultService::new(&state, MockMarketGateway::new(Mode::Ok)).expose(&[]);

    let wrong_admin = ActorId::from(1000);
    Syscall::with_message_source(wrong_admin);
    vault.set_quarantine_period(123);
}

#[tokio::test]
#[should_panic(expected = "UnauthorizedMarket")]
async fn transfer_to_market_panics_if_market_not_registered() {
    let state = fresh_state();
    let gateway = MockMarketGateway::new(Mode::Ok);
    let mut vault = VaultService::new(&state, gateway).expose(&[]);

    state
        .borrow_mut()
        .balances
        .insert(USER_ID, user_balance(100));

    Syscall::with_message_source(user());
    vault.transfer_to_market(MARKET_ID, 10).await;
}

#[tokio::test]
#[should_panic(expected = "InsufficientBalance")]
async fn transfer_to_market_insufficient_balance_panics() {
    let state = fresh_state();
    let gateway = MockMarketGateway::new(Mode::Ok);
    let mut vault = VaultService::new(&state, gateway).expose(&[]);

    Syscall::with_message_source(admin());
    vault.add_market(MARKET_ID);

    state.borrow_mut().balances.insert(USER_ID, user_balance(5));

    Syscall::with_message_source(user());
    vault.transfer_to_market(MARKET_ID, 10).await;
}

#[tokio::test]
async fn transfer_to_market_ok_deducts_balance_calls_gateway() {
    let state = fresh_state();
    let gateway = MockMarketGateway::new(Mode::Ok);
    let mut vault = VaultService::new(&state, gateway).expose(&[]);

    Syscall::with_message_source(admin());
    vault.add_market(MARKET_ID);

    state
        .borrow_mut()
        .balances
        .insert(USER_ID, user_balance(100));

    Syscall::with_message_source(user());
    vault.transfer_to_market(MARKET_ID, 40).await;

    assert_eq!(state.borrow().balances.get(&USER_ID).unwrap().amount, 60);
}

#[tokio::test]
async fn transfer_to_market_releases_matured_quarantine_before_spend() {
    let state = fresh_state();
    Syscall::with_block_timestamp(1_000);

    {
        let mut s = state.borrow_mut();
        s.balances.insert(
            USER_ID,
            UserBalance {
                amount: 50,
                quarantined: vec![quarantine(50, 999)],
            },
        );
    }

    let gateway = MockMarketGateway::new(Mode::Ok);
    let mut vault = VaultService::new(&state, gateway).expose(&[]);

    Syscall::with_message_source(admin());
    vault.add_market(MARKET_ID);

    Syscall::with_message_source(user());
    vault.transfer_to_market(MARKET_ID, 50).await;

    let balance = state.borrow().balances.get(&USER_ID).unwrap().clone();
    assert_eq!(balance.amount, 0);
    assert!(balance.quarantined.is_empty());
}

#[tokio::test]
async fn transfer_to_market_releases_only_caller_quarantine() {
    let state = fresh_state();
    Syscall::with_block_timestamp(1_000);

    let user2 = Address::from_bytes([8u8; 20]);
    {
        let mut s = state.borrow_mut();
        s.balances.insert(
            USER_ID,
            UserBalance {
                amount: 11,
                quarantined: vec![quarantine(11, 999)],
            },
        );
        s.balances.insert(
            user2,
            UserBalance {
                amount: 22,
                quarantined: vec![quarantine(22, 999)],
            },
        );
    }

    let gateway = MockMarketGateway::new(Mode::Ok);
    let mut vault = VaultService::new(&state, gateway).expose(&[]);

    Syscall::with_message_source(admin());
    vault.add_market(MARKET_ID);

    Syscall::with_message_source(user());
    vault.transfer_to_market(MARKET_ID, 11).await;

    let s = state.borrow();
    let user1_balance = s.balances.get(&USER_ID).unwrap();
    let user2_balance = s.balances.get(&user2).unwrap();

    assert_eq!(user1_balance.amount, 0);
    assert!(user1_balance.quarantined.is_empty());

    assert_eq!(user2_balance.amount, 22);
    assert_eq!(user2_balance.quarantined.len(), 1);
    assert_eq!(user2_balance.quarantined[0].amount, 22);
}

#[tokio::test]
async fn transfer_to_market_releases_only_matured_prefix() {
    let state = fresh_state();
    Syscall::with_block_timestamp(1_000);

    {
        let mut s = state.borrow_mut();
        s.balances.insert(
            USER_ID,
            UserBalance {
                amount: 60,
                quarantined: vec![
                    quarantine(10, 900),
                    quarantine(20, 1_000),
                    quarantine(30, 1_001),
                ],
            },
        );
    }

    let gateway = MockMarketGateway::new(Mode::Ok);
    let mut vault = VaultService::new(&state, gateway).expose(&[]);

    Syscall::with_message_source(admin());
    vault.add_market(MARKET_ID);

    Syscall::with_message_source(user());
    vault.transfer_to_market(MARKET_ID, 30).await;

    let balance = state.borrow().balances.get(&USER_ID).unwrap().clone();
    assert_eq!(balance.amount, 30);
    assert_eq!(balance.quarantined.len(), 1);
    assert_eq!(balance.quarantined[0].amount, 30);
    assert_eq!(balance.quarantined[0].release_timestamp, 1_001);
}

#[tokio::test]
#[should_panic(expected = "InsufficientBalance")]
async fn transfer_to_market_blocks_amount_above_transferable_with_unmatured_quarantine() {
    let state = fresh_state();
    Syscall::with_block_timestamp(1_000);

    {
        let mut s = state.borrow_mut();
        s.balances.insert(
            USER_ID,
            UserBalance {
                amount: 100,
                quarantined: vec![quarantine(50, 2_000)],
            },
        );
    }

    let gateway = MockMarketGateway::new(Mode::Ok);
    let mut vault = VaultService::new(&state, gateway).expose(&[]);

    Syscall::with_message_source(admin());
    vault.add_market(MARKET_ID);

    Syscall::with_message_source(user());
    vault.transfer_to_market(MARKET_ID, 60).await;
}

#[tokio::test]
#[should_panic(expected = "InsufficientBalance")]
async fn transfer_to_market_over_quarantined_balance_does_not_overflow() {
    let state = fresh_state();
    Syscall::with_block_timestamp(1_000);

    {
        let mut s = state.borrow_mut();
        s.balances.insert(
            USER_ID,
            UserBalance {
                amount: 50,
                quarantined: vec![quarantine(30, 2_000), quarantine(40, 2_100)],
            },
        );
    }

    let gateway = MockMarketGateway::new(Mode::Ok);
    let mut vault = VaultService::new(&state, gateway).expose(&[]);

    Syscall::with_message_source(admin());
    vault.add_market(MARKET_ID);

    Syscall::with_message_source(user());
    vault.transfer_to_market(MARKET_ID, 1).await;
}

#[tokio::test]
async fn transfer_to_market_gateway_error_balance_doesnt_change() {
    let state = fresh_state();
    let gateway = MockMarketGateway::new(Mode::Err);
    let mut vault = VaultService::new(&state, gateway).expose(&[]);

    Syscall::with_message_source(admin());
    vault.add_market(MARKET_ID);

    state
        .borrow_mut()
        .balances
        .insert(USER_ID, user_balance(100));

    Syscall::with_message_source(user());
    vault.transfer_to_market(MARKET_ID, 10).await;

    assert_eq!(vault.get_balance(USER_ID), 100);
}

#[test]
#[should_panic(expected = "Unauthorized: Program not authorized")]
fn vault_withdraw_unauthorized_program_panics_when_caller_not_user() {
    let state = fresh_state();
    let mut vault = VaultService::new(&state, MockMarketGateway::new(Mode::Ok)).expose(&[]);

    let outsider = ActorId::from(9999);
    Syscall::with_message_source(outsider);

    vault.vault_withdraw(USER_ID, 1);
}

#[test]
#[should_panic(expected = "UserNotFound")]
fn vault_withdraw_user_not_found_panics() {
    let state = fresh_state();
    let mut vault = VaultService::new(&state, MockMarketGateway::new(Mode::Ok)).expose(&[]);

    Syscall::with_message_source(user());
    vault.vault_withdraw(USER_ID, 1);
}

#[test]
#[should_panic(expected = "InsufficientBalance")]
fn vault_withdraw_insufficient_balance_panics() {
    let state = fresh_state();
    state.borrow_mut().balances.insert(USER_ID, user_balance(5));

    let mut vault = VaultService::new(&state, MockMarketGateway::new(Mode::Ok)).expose(&[]);

    Syscall::with_message_source(user());
    vault.vault_withdraw(USER_ID, 10);
}

#[test]
fn vault_withdraw_user_succeeds_and_deducts_balance() {
    let state = fresh_state();
    state
        .borrow_mut()
        .balances
        .insert(USER_ID, user_balance(100));

    let mut vault = VaultService::new(&state, MockMarketGateway::new(Mode::Ok)).expose(&[]);

    Syscall::with_message_source(user());
    vault.vault_withdraw(USER_ID, 40);

    assert_eq!(vault.get_balance(USER_ID), 60);
}

#[test]
fn vault_withdraw_authorized_market_can_withdraw_for_user() {
    let state = fresh_state();
    state
        .borrow_mut()
        .balances
        .insert(USER_ID, user_balance(100));

    let mut vault = VaultService::new(&state, MockMarketGateway::new(Mode::Ok)).expose(&[]);

    Syscall::with_message_source(admin());
    vault.add_market(MARKET_ID);

    Syscall::with_message_source(ActorId::from(MARKET_ID));
    vault.vault_withdraw(USER_ID, 20);

    assert_eq!(state.borrow().balances.get(&USER_ID).unwrap().amount, 80);
}

#[test]
fn vault_withdraw_does_not_release_matured_quarantine() {
    let state = fresh_state();
    Syscall::with_block_timestamp(1_000);

    state.borrow_mut().balances.insert(
        USER_ID,
        UserBalance {
            amount: 100,
            quarantined: vec![quarantine(50, 999)],
        },
    );

    let mut vault = VaultService::new(&state, MockMarketGateway::new(Mode::Ok)).expose(&[]);

    Syscall::with_message_source(user());
    vault.vault_withdraw(USER_ID, 40);

    let balance = state.borrow().balances.get(&USER_ID).unwrap().clone();
    assert_eq!(balance.amount, 60);
    assert_eq!(balance.quarantined.len(), 1);
    assert_eq!(balance.quarantined[0].amount, 50);
}

#[test]
fn vault_deposit_allows_admin_via_ensure_authorized_program() {
    let state = fresh_state();
    let mut vault = VaultService::new(&state, MockMarketGateway::new(Mode::Ok)).expose(&[]);

    Syscall::with_message_source(admin());
    vault.vault_deposit(USER_ID, 123);

    assert_eq!(state.borrow().balances.get(&USER_ID).unwrap().amount, 123);
}

#[test]
fn vault_deposit_with_quarantine_tracks_entry_and_total() {
    let state = fresh_state();
    state.borrow_mut().quarantine_period = 100;

    let mut vault = VaultService::new(&state, MockMarketGateway::new(Mode::Ok)).expose(&[]);

    Syscall::with_block_timestamp(1_000);
    Syscall::with_message_source(admin());
    vault.vault_deposit(USER_ID, 42);

    let balance = state.borrow().balances.get(&USER_ID).unwrap().clone();
    assert_eq!(balance.amount, 42);
    assert_eq!(balance.quarantined.len(), 1);
    assert_eq!(balance.quarantined[0].amount, 42);
    assert_eq!(balance.quarantined[0].release_timestamp, 1_100);
}

#[test]
fn admin_getter_returns_admin_when_set() {
    let state = fresh_state();
    let vault = VaultService::new(&state, MockMarketGateway::new(Mode::Ok)).expose(&[]);

    assert_eq!(vault.admin(), ADMIN_ID);
}

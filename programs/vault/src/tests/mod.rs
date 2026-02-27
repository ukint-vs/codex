use crate::orderbook_client::ob_client::orderbook::io::Deposit as ObDepositCall;
use crate::{
    market_gateway::MarketGateway,
    state::{QuarantinedDeposit, VaultState},
    VaultService,
};
use dex_common::Address;
use sails_rs::gstd::services::Service;
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
    let state = RefCell::new(VaultState {
        admin: Some(ADMIN_ID),
        token: TOKEN_ID,
        ..Default::default()
    });

    let mut vault = VaultService::new(&state, MockMarketGateway::new(Mode::Ok)).expose(&[]);

    let program_id = Address::from_bytes([5u8; 20]);
    Syscall::with_message_source(admin());
    vault.add_market(program_id);
    assert!(vault.is_authorized(program_id))
}

#[test]
#[should_panic(expected = "Unauthorized: Not Admin")]
fn add_market_wrong_admin() {
    let state = fresh_state();

    let mut vault = VaultService::new(&state, MockMarketGateway::new(Mode::Ok)).expose(&[]);

    let program_id = Address::from_bytes([5u8; 20]);
    let wrong_admin = ActorId::from(1000);
    Syscall::with_message_source(wrong_admin);
    vault.add_market(program_id);
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

    state.borrow_mut().balances.insert(USER_ID, 100);

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

    state.borrow_mut().balances.insert(USER_ID, 5);

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

    state.borrow_mut().balances.insert(USER_ID, 100);

    Syscall::with_message_source(user());
    vault.transfer_to_market(MARKET_ID, 40).await;

    assert_eq!(state.borrow().balances.get(&USER_ID).copied().unwrap(), 60);
}

#[tokio::test]
async fn transfer_to_market_releases_matured_quarantine_before_spend() {
    let state = fresh_state();

    // now = 1_000
    Syscall::with_block_timestamp(1_000);

    {
        let mut s = state.borrow_mut();
        s.quarantined_deposits.push(QuarantinedDeposit {
            user: USER_ID,
            amount: 50,
            deposit_timestamp: 10,
            release_timestamp: 999,
        });
    }
    let gateway = MockMarketGateway::new(Mode::Ok);
    let mut vault = VaultService::new(&state, gateway).expose(&[]);

    Syscall::with_message_source(admin());
    vault.add_market(MARKET_ID);

    // balance before release = 0
    assert_eq!(
        state.borrow().balances.get(&USER_ID).copied().unwrap_or(0),
        0
    );

    Syscall::with_message_source(user());
    vault.transfer_to_market(MARKET_ID, 50).await;

    assert_eq!(
        state.borrow().balances.get(&USER_ID).copied().unwrap_or(0),
        0
    );

    assert!(state.borrow().quarantined_deposits.is_empty());
}

#[tokio::test]
async fn transfer_to_market_releases_only_matured_prefix() {
    let state = fresh_state();
    Syscall::with_block_timestamp(1_000);

    {
        let mut s = state.borrow_mut();
        s.quarantined_deposits.push(QuarantinedDeposit {
            user: USER_ID,
            amount: 10,
            deposit_timestamp: 10,
            release_timestamp: 900,
        });
        s.quarantined_deposits.push(QuarantinedDeposit {
            user: USER_ID,
            amount: 20,
            deposit_timestamp: 10,
            release_timestamp: 1_000,
        });
        s.quarantined_deposits.push(QuarantinedDeposit {
            user: USER_ID,
            amount: 30,
            deposit_timestamp: 10,
            release_timestamp: 1_001,
        });
    }

    let gateway = MockMarketGateway::new(Mode::Ok);
    let mut vault = VaultService::new(&state, gateway).expose(&[]);

    Syscall::with_message_source(admin());
    vault.add_market(MARKET_ID);

    Syscall::with_message_source(user());
    vault.transfer_to_market(MARKET_ID, 30).await;

    // Balance is 0,  30 in quarantine
    assert_eq!(
        state.borrow().balances.get(&USER_ID).copied().unwrap_or(0),
        0
    );
    assert_eq!(state.borrow().quarantined_deposits.len(), 1);
    assert_eq!(state.borrow().quarantined_deposits[0].amount, 30);
}

#[tokio::test]
async fn transfer_to_market_gateway_error_balance_doesnt_change() {
    let state = fresh_state();
    let gateway = MockMarketGateway::new(Mode::Err);
    let mut vault = VaultService::new(&state, gateway).expose(&[]);

    Syscall::with_message_source(admin());
    vault.add_market(MARKET_ID);

    state.borrow_mut().balances.insert(USER_ID, 100);

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
    state.borrow_mut().balances.insert(USER_ID, 5);

    let mut vault = VaultService::new(&state, MockMarketGateway::new(Mode::Ok)).expose(&[]);

    Syscall::with_message_source(user());
    vault.vault_withdraw(USER_ID, 10);
}

#[test]
fn vault_withdraw_user_succeeds_and_deducts_balance() {
    let state = fresh_state();
    state.borrow_mut().balances.insert(USER_ID, 100);

    let mut vault = VaultService::new(&state, MockMarketGateway::new(Mode::Ok)).expose(&[]);

    Syscall::with_message_source(user());
    vault.vault_withdraw(USER_ID, 40);

    let balance = vault.get_balance(USER_ID);
    assert_eq!(balance, 60);
}

#[test]
fn vault_withdraw_authorized_market_can_withdraw_for_user() {
    let state = fresh_state();
    state.borrow_mut().balances.insert(USER_ID, 100);

    let mut vault = VaultService::new(&state, MockMarketGateway::new(Mode::Ok)).expose(&[]);

    // authorize market
    Syscall::with_message_source(admin());
    vault.add_market(MARKET_ID);

    // caller = MARKET_ID (authorized program), withdraw for USER_ID
    Syscall::with_message_source(ActorId::from(MARKET_ID));
    vault.vault_withdraw(USER_ID, 20);

    assert_eq!(state.borrow().balances.get(&USER_ID).copied().unwrap(), 80);
}

#[test]
fn vault_withdraw_releases_matured_quarantine_then_withdraws() {
    let state = fresh_state();
    Syscall::with_block_timestamp(1_000);

    state
        .borrow_mut()
        .quarantined_deposits
        .push(QuarantinedDeposit {
            user: USER_ID,
            amount: 50,
            deposit_timestamp: 10,
            release_timestamp: 999,
        });

    let mut vault = VaultService::new(&state, MockMarketGateway::new(Mode::Ok)).expose(&[]);

    Syscall::with_message_source(user());
    vault.vault_withdraw(USER_ID, 50);

    assert_eq!(
        state.borrow().balances.get(&USER_ID).copied().unwrap_or(0),
        0
    );
    assert!(state.borrow().quarantined_deposits.is_empty());
}

#[tokio::test]
async fn transfer_to_market_does_not_release_unmatured_quarantine() {
    let state = fresh_state();
    Syscall::with_block_timestamp(1_000);

    state
        .borrow_mut()
        .quarantined_deposits
        .push(QuarantinedDeposit {
            user: USER_ID,
            amount: 50,
            deposit_timestamp: 10,
            release_timestamp: 2_000,
        });

    let gateway = MockMarketGateway::new(Mode::Ok);
    let mut vault = VaultService::new(&state, gateway).expose(&[]);

    Syscall::with_message_source(admin());
    vault.add_market(MARKET_ID);

    // balance for transfer
    state.borrow_mut().balances.insert(USER_ID, 100);

    Syscall::with_message_source(user());
    vault.transfer_to_market(MARKET_ID, 10).await;

    assert_eq!(state.borrow().balances.get(&USER_ID).copied().unwrap(), 90);
    assert_eq!(state.borrow().quarantined_deposits.len(), 1);
    assert_eq!(state.borrow().quarantined_deposits[0].amount, 50);
}

#[tokio::test]
async fn release_matured_quarantine_releases_for_multiple_users_on_any_callsite() {
    let state = fresh_state();
    Syscall::with_block_timestamp(1_000);

    let user2: Address = Address::from_bytes([8u8; 20]);

    {
        let mut s = state.borrow_mut();
        s.quarantined_deposits.push(QuarantinedDeposit {
            user: USER_ID,
            amount: 11,
            deposit_timestamp: 1,
            release_timestamp: 999,
        });
        s.quarantined_deposits.push(QuarantinedDeposit {
            user: user2,
            amount: 22,
            deposit_timestamp: 2,
            release_timestamp: 999,
        });
    }

    let gateway = MockMarketGateway::new(Mode::Ok);
    let mut vault = VaultService::new(&state, gateway).expose(&[]);

    Syscall::with_message_source(admin());
    vault.add_market(MARKET_ID);

    Syscall::with_message_source(user());
    vault.transfer_to_market(MARKET_ID, 0).await;

    assert_eq!(
        state.borrow().balances.get(&USER_ID).copied().unwrap_or(0),
        11
    );
    assert_eq!(
        state.borrow().balances.get(&user2).copied().unwrap_or(0),
        22
    );
    assert!(state.borrow().quarantined_deposits.is_empty());
}

#[test]
fn vault_deposit_allows_admin_via_ensure_authorized_program() {
    let state = fresh_state();
    let mut vault = VaultService::new(&state, MockMarketGateway::new(Mode::Ok)).expose(&[]);

    Syscall::with_message_source(admin());
    vault.vault_deposit(USER_ID, 123);

    assert_eq!(state.borrow().balances.get(&USER_ID).copied().unwrap(), 123);
}

#[test]
fn vault_deposit_with_quarantine_inserts_quarantined_deposit() {
    let state = fresh_state();
    state.borrow_mut().quarantine_period = 100;

    let mut vault = VaultService::new(&state, MockMarketGateway::new(Mode::Ok)).expose(&[]);

    Syscall::with_block_timestamp(1_000);
    Syscall::with_message_source(admin());
    vault.vault_deposit(USER_ID, 42);

    let q = &state.borrow().quarantined_deposits;
    assert_eq!(q.len(), 1);
    assert_eq!(q[0].user, USER_ID);
    assert_eq!(q[0].amount, 42);
    assert_eq!(q[0].deposit_timestamp, 1_000);
    assert_eq!(q[0].release_timestamp, 1_100);

    assert_eq!(
        state.borrow().balances.get(&USER_ID).copied().unwrap_or(0),
        0
    );
}

#[test]
fn admin_getter_returns_admin_when_set() {
    let state = fresh_state();
    let vault = VaultService::new(&state, MockMarketGateway::new(Mode::Ok)).expose(&[]);

    assert_eq!(vault.admin(), ADMIN_ID);
}

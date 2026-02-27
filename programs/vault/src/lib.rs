#![no_std]

use dex_common::{Address, TokenId};
use sails_rs::{cell::RefCell, gstd::Syscall, prelude::*};

mod state;
use state::*;

mod market_gateway;
mod orderbook_client;
#[cfg(test)]
mod tests;
use crate::market_gateway::{MarketGateway, SailsMarketGateway};

// --- Events ---

#[sails_rs::event]
#[derive(Clone, Debug, PartialEq, Encode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum Events {
    Deposit {
        user: Address,
        token: TokenId,
        amount: u128,
        balance_after: u128,
    },
    Withdrawal {
        user: Address,
        token: TokenId,
        amount: u128,
        status: String,
    },
    FeesClaimed {
        token: TokenId,
        amount: u128,
    },
    QuarantineReleased {
        user: Address,
        token: TokenId,
        amount: u128,
        balance_after: u128,
    },
}

pub struct VaultProgram {
    state: RefCell<VaultState>,
}

#[program]
impl VaultProgram {
    #[export]
    pub fn create(token_id: Address) -> Self {
        let source = Syscall::message_source().into();
        let state = VaultState {
            admin: Some(source),
            token: token_id,
            ..VaultState::default()
        };
        Self {
            state: RefCell::new(state),
        }
    }

    pub fn vault(&self) -> VaultService<'_, SailsMarketGateway> {
        VaultService::new(&self.state, SailsMarketGateway)
    }
}

pub struct VaultService<'a, G> {
    state: &'a RefCell<VaultState>,
    gateway: G,
}

impl<'a, G> VaultService<'a, G> {
    pub fn new(state: &'a RefCell<VaultState>, gateway: G) -> Self {
        Self { state, gateway }
    }

    #[inline]
    fn get_mut(&self) -> sails_rs::cell::RefMut<'_, VaultState> {
        self.state.borrow_mut()
    }

    #[inline]
    fn get(&self) -> sails_rs::cell::Ref<'_, VaultState> {
        self.state.borrow()
    }
}

#[service(events = Events)]
impl<'a, G> VaultService<'a, G>
where
    G: MarketGateway,
{
    fn release_matured_quarantine(&self) {
        let now = Syscall::block_timestamp();
        let mut state = self.get_mut();
        if state.quarantined_deposits.is_empty() {
            return;
        }

        let token = state.token;
        let matured_count = state
            .quarantined_deposits
            .partition_point(|q| q.release_timestamp <= now);
        if matured_count == 0 {
            return;
        }

        let matured: Vec<_> = state.quarantined_deposits.drain(..matured_count).collect();
        for q in matured {
            let balance = state.balances.entry(q.user).or_default();
            *balance = balance.checked_add(q.amount).expect("MathOverflow");
            let balance_after = *balance;

            self.emit_eth_event(Events::QuarantineReleased {
                user: q.user,
                token,
                amount: q.amount,
                balance_after,
            })
            .expect("EmitEventFailed");
            let mut emitter = self.emitter();
            emitter
                .emit_event(Events::QuarantineReleased {
                    user: q.user,
                    token,
                    amount: q.amount,
                    balance_after,
                })
                .expect("EmitEventFailed");
        }
    }
    // Admin function to authorize an OrderBook program
    #[export]
    pub fn add_market(&mut self, program_id: Address) {
        let mut state = self.get_mut();
        if state.admin != Some(Syscall::message_source().into()) {
            panic!("Unauthorized: Not Admin");
        }
        state.registered_orderbooks.insert(program_id);
    }

    #[export]
    pub fn update_fee_rate(&mut self, new_rate: u128) {
        let mut state = self.get_mut();
        if state.admin != Some(Syscall::message_source().into()) {
            panic!("Unauthorized: Not Admin");
        }
        if new_rate > 10000 {
            panic!("InvalidRate");
        }
        state.fee_rate_bps = new_rate;
    }

    #[export]
    pub fn set_quarantine_period(&mut self, period: u64) {
        let mut state = self.get_mut();
        if state.admin != Some(Syscall::message_source().into()) {
            panic!("Unauthorized: Not Admin");
        }
        state.quarantine_period = period;
    }

    fn ensure_authorized_program(&self) {
        let state = self.get();
        let caller = Syscall::message_source().into();

        if state.admin == Some(caller) {
            return;
        }
        if !state.registered_orderbooks.contains(&caller) {
            panic!("Unauthorized: Program not authorized");
        }
    }

    fn ensure_authorized_program_or_user(&self, user: Address) {
        let caller: Address = Syscall::message_source().into();

        if caller == user {
            return;
        }
        self.ensure_authorized_program();
    }

    #[export]
    pub fn vault_deposit(&mut self, user: Address, amount: u128) {
        self.ensure_authorized_program();
        self.vault_deposit_unchecked(user, amount);
    }

    /// Debug/testing helper to mint balance without requiring market/admin routing.
    /// Only available when compiled with the `debug` feature.
    #[export]
    pub fn debug_deposit(&mut self, _user: Address, _amount: u128) {
        #[cfg(not(feature = "debug"))]
        {
            panic!("DebugFeatureDisabled");
        }
        #[cfg(feature = "debug")]
        {
            let state = self.get();
            let caller = Syscall::message_source().into();
            if state.admin != Some(caller) && caller != _user {
                panic!("UnauthorizedDebugDeposit");
            }
            drop(state);
            self.vault_deposit_unchecked(_user, _amount);
        }
    }

    fn vault_deposit_unchecked(&mut self, user: Address, amount: u128) {
        let mut state = self.get_mut();
        let token = state.token;

        if state.quarantine_period == 0 {
            let balance = state.balances.entry(user).or_default();
            *balance = balance.checked_add(amount).expect("MathOverflow");
            let balance_after = *balance;

            // Emitting event with token
            self.emit_eth_event(Events::Deposit {
                user,
                token,
                amount,
                balance_after,
            })
            .expect("EmitEventFailed");
            let mut emitter = self.emitter();
            emitter
                .emit_event(Events::Deposit {
                    user,
                    token,
                    amount,
                    balance_after,
                })
                .expect("EmitEventFailed");
        } else {
            let now = Syscall::block_timestamp();
            let quarantine_period = state.quarantine_period;
            let release_timestamp = now.saturating_add(quarantine_period);
            let idx = state
                .quarantined_deposits
                .partition_point(|q| q.release_timestamp <= release_timestamp);
            state.quarantined_deposits.insert(
                idx,
                QuarantinedDeposit {
                    user,
                    amount,
                    deposit_timestamp: now,
                    release_timestamp,
                },
            );
        }
    }

    #[export]
    pub fn vault_withdraw(&mut self, user: Address, amount: u128) {
        self.ensure_authorized_program_or_user(user);
        self.release_matured_quarantine();
        self.vault_withdraw_unchecked(user, amount);
    }

    fn vault_withdraw_unchecked(&mut self, user: Address, amount: u128) {
        let mut state = self.get_mut();
        let token = state.token;
        let balance = state.balances.get_mut(&user).expect("UserNotFound");

        if *balance < amount {
            panic!("InsufficientBalance");
        }

        *balance = balance.checked_sub(amount).expect("MathOverflow");

        self.emit_eth_event(Events::Withdrawal {
            user,
            token,
            amount,
            status: "Initiated".into(),
        })
        .expect("EmitEventFailed");
        let mut emitter = self.emitter();
        emitter
            .emit_event(Events::Withdrawal {
                user,
                token,
                amount,
                status: "Initiated".into(),
            })
            .expect("EmitEventFailed");
    }

    #[export]
    pub async fn transfer_to_market(&mut self, market_id: Address, amount: u128) {
        let user = Syscall::message_source().into();
        self.ensure_authorized_program_or_user(user);
        self.release_matured_quarantine();
        let token = {
            let mut state = self.get_mut();
            if !state.registered_orderbooks.contains(&market_id) {
                panic!("UnauthorizedMarket");
            }

            // 1. Verify and deduct balance
            let balance = state.balances.get_mut(&user).expect("UserNotFound");

            if *balance < amount {
                panic!("InsufficientBalance");
            }

            *balance = balance.checked_sub(amount).expect("MathOverflow");
            state.token
        };

        let result = self
            .gateway
            .deposit_to_market(market_id, user, token, amount)
            .await;

        if result.is_err() {
            let mut state = self.get_mut();
            let balance = state.balances.get_mut(&user).expect("UserNotFound");
            *balance += amount;
        }
    }

    #[export]
    pub fn vault_force_exit(&mut self, user: Address, amount: u128) {
        self.ensure_authorized_program_or_user(user);
        self.release_matured_quarantine();
        let mut state = self.get_mut();
        let token = state.token;
        let balance = state.balances.get_mut(&user).expect("UserNotFound");

        let to_deduct = if *balance < amount { *balance } else { amount };

        *balance = balance.checked_sub(to_deduct).expect("MathOverflow");

        self.emit_eth_event(Events::Withdrawal {
            user,
            token,
            amount: to_deduct,
            status: "ForceExit".into(),
        })
        .expect("EmitEventFailed");

        let mut emitter = self.emitter();
        emitter
            .emit_event(Events::Withdrawal {
                user,
                token,
                amount: to_deduct,
                status: "ForceExit".into(),
            })
            .expect("EmitEventFailed");
    }

    // --- Queries ---
    #[export]
    pub fn admin(&self) -> Address {
        self.get().admin.unwrap_or_default()
    }

    #[export]
    pub fn is_authorized(&self, program_id: Address) -> bool {
        let state = self.get();
        state.admin == Some(program_id) || state.registered_orderbooks.contains(&program_id)
    }

    #[export]
    pub fn get_balance(&self, user: Address) -> u128 {
        let state = self.get();
        state.balances.get(&user).copied().unwrap_or(0)
    }
}

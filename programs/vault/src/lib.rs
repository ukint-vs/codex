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

fn quarantined_total(entries: &[QuarantineEntry]) -> u128 {
    entries
        .iter()
        .try_fold(0u128, |acc, entry| acc.checked_add(entry.amount))
        .expect("MathOverflow")
}

fn transfer_available(balance: &UserBalance) -> u128 {
    balance
        .amount
        .saturating_sub(quarantined_total(&balance.quarantined))
}

fn quarantine_release_events(
    total_balance: u128,
    matured: &[QuarantineEntry],
    active_after: u128,
) -> Vec<(u128, u128)> {
    let matured_total = quarantined_total(matured);
    let active_before = active_after
        .checked_add(matured_total)
        .expect("MathOverflow");

    let mut released_so_far = 0u128;
    let mut released_events = Vec::with_capacity(matured.len());
    for released in matured {
        released_so_far = released_so_far
            .checked_add(released.amount)
            .expect("MathOverflow");
        let active_quarantine_now = active_before
            .checked_sub(released_so_far)
            .expect("MathOverflow");
        let balance_after = total_balance.saturating_sub(active_quarantine_now);
        released_events.push((released.amount, balance_after));
    }
    released_events
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
    fn release_matured_quarantine_for_user(&self, user: Address) {
        let now = Syscall::block_timestamp();
        let (token, released_events) = {
            let mut state = self.get_mut();
            let token = state.token;
            let Some(balance) = state.balances.get_mut(&user) else {
                return;
            };
            if balance.quarantined.is_empty() {
                return;
            }

            let matured_count = balance
                .quarantined
                .partition_point(|q| q.release_timestamp <= now);
            if matured_count == 0 {
                return;
            }

            let matured: Vec<_> = balance.quarantined.drain(..matured_count).collect();
            let active_after = quarantined_total(&balance.quarantined);
            let released_events = quarantine_release_events(balance.amount, &matured, active_after);
            (token, released_events)
        };

        for (amount, balance_after) in released_events {
            self.emit_eth_event(Events::QuarantineReleased {
                user,
                token,
                amount,
                balance_after,
            })
            .expect("EmitEventFailed");
            let mut emitter = self.emitter();
            emitter
                .emit_event(Events::QuarantineReleased {
                    user,
                    token,
                    amount,
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
        let quarantine_period = state.quarantine_period;
        let balance = state.balances.entry(user).or_default();
        balance.amount = balance.amount.checked_add(amount).expect("MathOverflow");
        let balance_after = balance.amount;

        if quarantine_period == 0 {
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
            let release_timestamp = now.saturating_add(quarantine_period);
            let idx = balance
                .quarantined
                .partition_point(|q| q.release_timestamp <= release_timestamp);
            balance.quarantined.insert(
                idx,
                QuarantineEntry {
                    amount,
                    release_timestamp,
                },
            );
        }
    }

    #[export]
    pub fn vault_withdraw(&mut self, user: Address, amount: u128) {
        self.ensure_authorized_program_or_user(user);
        self.vault_withdraw_unchecked(user, amount);
    }

    fn vault_withdraw_unchecked(&mut self, user: Address, amount: u128) {
        let mut state = self.get_mut();
        let token = state.token;
        let balance = state.balances.get_mut(&user).expect("UserNotFound");

        if balance.amount < amount {
            panic!("InsufficientBalance");
        }

        balance.amount = balance.amount.checked_sub(amount).expect("MathOverflow");

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
        self.release_matured_quarantine_for_user(user);
        let token = {
            let mut state = self.get_mut();
            if !state.registered_orderbooks.contains(&market_id) {
                panic!("UnauthorizedMarket");
            }

            let balance = state.balances.get_mut(&user).expect("UserNotFound");
            let transferable = transfer_available(balance);
            if transferable < amount {
                panic!("InsufficientBalance");
            }

            balance.amount = balance.amount.checked_sub(amount).expect("MathOverflow");
            state.token
        };

        let result = self
            .gateway
            .deposit_to_market(market_id, user, token, amount)
            .await;

        if result.is_err() {
            let mut state = self.get_mut();
            let balance = state.balances.get_mut(&user).expect("UserNotFound");
            balance.amount = balance.amount.checked_add(amount).expect("MathOverflow");
        }
    }

    #[export]
    pub fn vault_force_exit(&mut self, user: Address, amount: u128) {
        self.ensure_authorized_program_or_user(user);
        let mut state = self.get_mut();
        let token = state.token;
        let balance = state.balances.get_mut(&user).expect("UserNotFound");

        let to_deduct = if balance.amount < amount {
            balance.amount
        } else {
            amount
        };

        balance.amount = balance.amount.checked_sub(to_deduct).expect("MathOverflow");

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
        state.balances.get(&user).map(|b| b.amount).unwrap_or(0)
    }
}

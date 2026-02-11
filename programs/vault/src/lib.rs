#![no_std]

use clob_common::{actor_to_eth, TokenId};
use sails_rs::{cell::RefCell, gstd::debug, gstd::exec, gstd::msg, prelude::*};

mod state;
use state::*;

// --- Events ---

#[sails_rs::event]
#[derive(Clone, Debug, PartialEq, Encode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum Events {
    Deposit {
        user: [u8; 20],
        token: TokenId,
        amount: u128,
        balance_after: u128,
    },
    Withdrawal {
        user: [u8; 20],
        token: TokenId,
        amount: u128,
        status: String,
    },
    FeesClaimed {
        token: TokenId,
        amount: u128,
    },
    QuarantineReleased {
        user: [u8; 20],
        token: TokenId,
        amount: u128,
        balance_after: u128,
    },
}

pub struct VaultProgram {
    state: RefCell<VaultState>,
}

fn reply_ok() {
    // Empty reply is enough for callers; depositless on ethexe.
    msg::reply((), 0).expect("ReplyFailed");
}

fn actor_addr(actor: ActorId) -> [u8; 20] {
    actor_to_eth(actor)
}

fn locked_balance_of(state: &VaultState, user: ActorId) -> u128 {
    let in_transit = state
        .locked_in_transit
        .iter()
        .filter(|((u, _), _)| *u == user)
        .try_fold(0u128, |acc, (_, amount)| acc.checked_add(*amount))
        .expect("MathOverflow");
    in_transit
}

fn decode_orderbook_deposit_ack(reply: &[u8]) -> bool {
    let mut wrapped = reply;
    if let Ok((service, method, ack)) = <(String, String, bool)>::decode(&mut wrapped) {
        return wrapped.is_empty() && service == "Orderbook" && method == "Deposit" && ack;
    }

    let mut raw = reply;
    if let Ok(ack) = bool::decode(&mut raw) {
        return raw.is_empty() && ack;
    }

    false
}

#[program]
impl VaultProgram {
    #[export]
    pub fn create(token_id: ActorId) -> Self {
        let state = VaultState {
            admin: Some(sails_rs::gstd::msg::source()),
            token: actor_to_eth(token_id),
            ..VaultState::default()
        };
        Self {
            state: RefCell::new(state),
        }
    }

    pub fn vault(&self) -> VaultService<'_> {
        VaultService::new(&self.state)
    }
}

pub struct VaultService<'a> {
    state: &'a RefCell<VaultState>,
}

impl<'a> VaultService<'a> {
    pub fn new(state: &'a RefCell<VaultState>) -> Self {
        Self { state }
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
impl<'a> VaultService<'a> {
    fn release_matured_quarantine(&self) {
        let now = exec::block_timestamp();
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
                user: actor_addr(q.user),
                token,
                amount: q.amount,
                balance_after,
            })
            .expect("EmitEventFailed");
            let mut emitter = self.emitter();
            emitter
                .emit_event(Events::QuarantineReleased {
                    user: actor_addr(q.user),
                    token,
                    amount: q.amount,
                    balance_after,
                })
                .expect("EmitEventFailed");
        }
    }
    // Admin function to authorize an OrderBook program
    #[export]
    pub fn add_market(&mut self, program_id: ActorId) {
        let mut state = self.get_mut();
        if state.admin != Some(sails_rs::gstd::msg::source()) {
            panic!("Unauthorized: Not Admin");
        }
        debug!(
            "Vault::add_market caller={:?} program_id={:?}",
            msg::source(),
            program_id
        );
        state.registered_orderbooks.insert(program_id);
        reply_ok();
    }

    #[export]
    pub fn update_fee_rate(&mut self, new_rate: u128) {
        let mut state = self.get_mut();
        if state.admin != Some(msg::source()) {
            panic!("Unauthorized: Not Admin");
        }
        if new_rate > 10000 {
            panic!("InvalidRate");
        }
        state.fee_rate_bps = new_rate;
        reply_ok();
    }

    #[export]
    pub fn set_quarantine_period(&mut self, period: u64) {
        let mut state = self.get_mut();
        if state.admin != Some(msg::source()) {
            panic!("Unauthorized: Not Admin");
        }
        state.quarantine_period = period;
        reply_ok();
    }

    /// Enable/disable debug minting helpers (intended for test environments).
    #[export]
    pub fn set_debug_mode(&mut self, enabled: bool) {
        let mut state = self.get_mut();
        if state.admin != Some(msg::source()) {
            panic!("Unauthorized: Not Admin");
        }
        state.debug_mode = enabled;
        reply_ok();
    }

    // Admin function to claim accumulated fees
    #[export]
    pub fn claim_fees(&mut self) {
        let mut state = self.get_mut();

        if state.admin != Some(msg::source()) {
            panic!("Unauthorized: Not Admin");
        }

        let amount = state.treasury;
        if amount == 0 {
            // No fees to claim, return early to save gas/noise
            return;
        }
        state.treasury = 0;

        let token = state.token;
        self.emit_eth_event(Events::FeesClaimed { token, amount })
            .expect("EmitEventFailed");
        let mut emitter = self.emitter();
        emitter
            .emit_event(Events::FeesClaimed { token, amount })
            .expect("EmitEventFailed");
        reply_ok();
    }

    fn ensure_authorized_program(&self) {
        let state = self.get();
        let caller = sails_rs::gstd::msg::source();
        debug!(
            "Vault::ensure_authorized_program caller={:?} admin={:?} authorized_set={:?}",
            caller,
            state.admin,
            state.registered_orderbooks.contains(&caller)
        );
        if state.admin == Some(caller) {
            return;
        }
        if !state.registered_orderbooks.contains(&caller) {
            panic!("Unauthorized: Program not authorized");
        }
    }

    fn ensure_authorized_program_or_user(&self, user: ActorId) {
        let caller = sails_rs::gstd::msg::source();
        if caller == user {
            return;
        }
        self.ensure_authorized_program();
    }

    #[export]
    pub fn vault_deposit(&mut self, user: ActorId, amount: u128) {
        self.ensure_authorized_program();
        self.vault_deposit_unchecked(user, amount);
    }

    /// Debug/testing helper to mint balance without requiring market/admin routing.
    /// Must be explicitly enabled by admin via `set_debug_mode(true)`.
    #[export]
    pub fn debug_deposit(&mut self, user: ActorId, amount: u128) {
        let state = self.get();
        let caller = msg::source();
        if !state.debug_mode {
            panic!("DebugModeDisabled");
        }
        if state.admin != Some(caller) && caller != user {
            panic!("UnauthorizedDebugDeposit");
        }
        drop(state);
        self.vault_deposit_unchecked(user, amount);
    }

    fn vault_deposit_unchecked(&mut self, user: ActorId, amount: u128) {
        let mut state = self.get_mut();
        let token = state.token;

        debug!(
            "Vault::vault_deposit caller={:?} user={:?} token={:?} amount={}",
            sails_rs::gstd::msg::source(),
            user,
            token,
            amount
        );
        if state.quarantine_period == 0 {
            let balance = state.balances.entry(user).or_default();
            *balance = balance.checked_add(amount).expect("MathOverflow");
            let balance_after = *balance;

            // Emitting event with token
            self.emit_eth_event(Events::Deposit {
                user: actor_addr(user),
                token,
                amount,
                balance_after,
            })
            .expect("EmitEventFailed");
            let mut emitter = self.emitter();
            emitter
                .emit_event(Events::Deposit {
                    user: actor_addr(user),
                    token,
                    amount,
                    balance_after,
                })
                .expect("EmitEventFailed");
        } else {
            let now = exec::block_timestamp();
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
        reply_ok();
    }

    #[export]
    pub fn vault_withdraw(&mut self, user: ActorId, amount: u128) {
        self.ensure_authorized_program_or_user(user);
        self.release_matured_quarantine();
        self.vault_withdraw_unchecked(user, amount);
    }

    fn vault_withdraw_unchecked(&mut self, user: ActorId, amount: u128) {
        let mut state = self.get_mut();
        let token = state.token;
        let balance = state.balances.get_mut(&user).expect("UserNotFound");

        if *balance < amount {
            panic!("InsufficientBalance");
        }

        *balance = balance.checked_sub(amount).expect("MathOverflow");

        self.emit_eth_event(Events::Withdrawal {
            user: actor_addr(user),
            token,
            amount,
            status: "Initiated".into(),
        })
        .expect("EmitEventFailed");
        let mut emitter = self.emitter();
        emitter
            .emit_event(Events::Withdrawal {
                user: actor_addr(user),
                token,
                amount,
                status: "Initiated".into(),
            })
            .expect("EmitEventFailed");
        reply_ok();
    }

    #[export]
    pub async fn transfer_to_market(&mut self, market_id: ActorId, amount: u128) {
        let user = msg::source();
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
            let in_transit = state
                .locked_in_transit
                .entry((user, market_id))
                .or_insert(0);
            *in_transit = in_transit.checked_add(amount).expect("MathOverflow");
            state.token
        };

        // 2. Send deposit message to OrderBook using the current service envelope.
        // Payload is ("Orderbook", "Deposit", (user, token, amount)).
        let payload = ("Orderbook", "Deposit", (user, token, amount)).encode();

        let result = msg::send_bytes_for_reply(market_id, payload, 0)
            .expect("SendFailed")
            .await;

        let deposit_acked = match result {
            Ok(reply) => decode_orderbook_deposit_ack(&reply),
            Err(_) => false,
        };

        if !deposit_acked {
            let mut state = self.get_mut();
            let balance = state.balances.get_mut(&user).expect("UserNotFound");
            *balance = balance.checked_add(amount).expect("MathOverflow");

            let key = (user, market_id);
            let in_transit = state
                .locked_in_transit
                .get_mut(&key)
                .expect("TransitMissing");
            *in_transit = in_transit.checked_sub(amount).expect("MathOverflow");
            if *in_transit == 0 {
                state.locked_in_transit.remove(&key);
            }

            debug!("OrderbookDepositFailed");
            reply_ok();
            return;
        }

        {
            let mut state = self.get_mut();
            let key = (user, market_id);
            let in_transit = state
                .locked_in_transit
                .get_mut(&key)
                .expect("TransitMissing");
            *in_transit = in_transit.checked_sub(amount).expect("MathOverflow");
            if *in_transit == 0 {
                state.locked_in_transit.remove(&key);
            }
        }

        reply_ok();
    }

    #[export]
    pub fn vault_force_exit(&mut self, user: ActorId, amount: u128) {
        self.ensure_authorized_program_or_user(user);
        self.release_matured_quarantine();
        let mut state = self.get_mut();
        let token = state.token;
        let balance = state.balances.get_mut(&user).expect("UserNotFound");

        let to_deduct = if *balance < amount { *balance } else { amount };

        *balance = balance.checked_sub(to_deduct).expect("MathOverflow");

        self.emit_eth_event(Events::Withdrawal {
            user: actor_addr(user),
            token,
            amount: to_deduct,
            status: "ForceExit".into(),
        })
        .expect("EmitEventFailed");

        let mut emitter = self.emitter();
        emitter
            .emit_event(Events::Withdrawal {
                user: actor_addr(user),
                token,
                amount: to_deduct,
                status: "ForceExit".into(),
            })
            .expect("EmitEventFailed");

        reply_ok();
    }

    // --- Queries ---
    #[export]
    pub fn admin(&self) -> ActorId {
        self.get().admin.unwrap_or(ActorId::from([0u8; 32]))
    }

    #[export]
    pub fn is_authorized(&self, program_id: ActorId) -> bool {
        let state = self.get();
        state.admin == Some(program_id) || state.registered_orderbooks.contains(&program_id)
    }

    #[export]
    pub fn get_balance(&self, user: ActorId) -> (u128, u128) {
        let state = self.get();
        let available = state.balances.get(&user).copied().unwrap_or(0);
        let locked = locked_balance_of(&state, user);
        (available, locked)
    }

    #[export]
    pub fn get_treasury(&self) -> u128 {
        self.get().treasury
    }

    #[export]
    pub fn debug_mode(&self) -> bool {
        self.get().debug_mode
    }
}

#[cfg(test)]
mod tests {
    use super::decode_orderbook_deposit_ack;
    use sails_rs::prelude::*;

    #[test]
    fn decode_ack_accepts_valid_wrapped_tuple() {
        let reply = (String::from("Orderbook"), String::from("Deposit"), true).encode();
        assert!(decode_orderbook_deposit_ack(&reply));
    }

    #[test]
    fn decode_ack_rejects_wrapped_tuple_with_trailing_bytes() {
        let mut reply = (String::from("Orderbook"), String::from("Deposit"), true).encode();
        reply.push(0xAB);
        assert!(!decode_orderbook_deposit_ack(&reply));
    }

    #[test]
    fn decode_ack_rejects_wrong_wrapped_service_or_method() {
        let wrong_service = (String::from("Vault"), String::from("Deposit"), true).encode();
        let wrong_method = (String::from("Orderbook"), String::from("Other"), true).encode();
        assert!(!decode_orderbook_deposit_ack(&wrong_service));
        assert!(!decode_orderbook_deposit_ack(&wrong_method));
    }

    #[test]
    fn decode_ack_accepts_valid_raw_bool() {
        let reply = true.encode();
        assert!(decode_orderbook_deposit_ack(&reply));
    }

    #[test]
    fn decode_ack_rejects_raw_bool_with_trailing_bytes() {
        let mut reply = true.encode();
        reply.push(0x01);
        assert!(!decode_orderbook_deposit_ack(&reply));
    }

    #[test]
    fn decode_ack_rejects_malformed_payload() {
        let reply = vec![0xFF, 0xAA, 0x10];
        assert!(!decode_orderbook_deposit_ack(&reply));
    }
}

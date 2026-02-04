#![no_std]

use ::alloy_sol_types::{sol, SolCall, SolType};
use clob_common::{actor_to_eth, eth_to_actor, mul_div_ceil, EthAddress, TokenId};
use sails_rs::{
    collections::{HashMap, HashSet},
    gstd::debug,
    gstd::msg,
    prelude::*,
};

sol! {
    struct EthDeposit {
        address user;
        address token;
        uint256 amount;
    }

    interface IVault {
        function releaseFunds(address user, address token, uint256 amount);
        function cancelForceExit(address user, address token, uint256 amount);
    }
}

// --- Events ---

#[sails_rs::event]
#[derive(Clone, Debug, PartialEq, Encode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum Events {
    Deposit {
        user: [u8; 32],
        token: TokenId,
        amount: u128,
        balance_after: u128,
    },
    Withdrawal {
        user: [u8; 32],
        token: TokenId,
        amount: u128,
        status: String,
    },
    FundsReserved {
        user: [u8; 32],
        token: TokenId,
        amount: u128,
    },
    FundsUnlocked {
        user: [u8; 32],
        token: TokenId,
        amount: u128,
    },
    TradeSettled {
        buyer: [u8; 32],
        seller: [u8; 32],
        base_token: TokenId,
        quote_token: TokenId,
        price: u128,
        quantity: u128,
        fee: u128,
    },
    FeesClaimed {
        token: TokenId,
        amount: u128,
    },
}

// --- State ---

#[derive(Clone, Debug, Default, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct Balance {
    pub available: u128,
    pub reserved: u128,
}

#[derive(Default)]
pub struct VaultState {
    pub balances: HashMap<ActorId, HashMap<TokenId, Balance>>,
    pub treasury: HashMap<TokenId, u128>,
    pub fee_rate_bps: u128, // Basis points (e.g., 30 = 0.3%)
    pub authorized_programs: HashSet<ActorId>,
    pub admin: Option<ActorId>,
    pub eth_vault_caller: Option<ActorId>,
}

static mut STATE: Option<VaultState> = None;

impl VaultState {
    pub fn get_mut() -> &'static mut Self {
        unsafe { STATE.get_or_insert(Default::default()) }
    }
}

pub struct VaultProgram;

fn reply_ok() {
    // Empty reply is enough for callers; depositless on ethexe.
    msg::reply((), 0).expect("ReplyFailed");
}

fn actor_bytes(actor: ActorId) -> [u8; 32] {
    let mut out = [0u8; 32];
    out.copy_from_slice(actor.as_ref());
    out
}

fn actor_eth_bytes(actor: ActorId) -> [u8; 32] {
    let eth: EthAddress = actor_to_eth(actor);
    let mut out = [0u8; 32];
    out[12..].copy_from_slice(&eth);
    out
}

pub fn encode_release_funds(user: ActorId, token: TokenId, amount: u128) -> Vec<u8> {
    let user: EthAddress = actor_to_eth(user);
    let call = IVault::releaseFundsCall {
        user: user.into(),
        token: token.into(),
        amount: ::alloy_sol_types::private::U256::from(amount),
    };
    call.abi_encode()
}

pub fn encode_cancel_force_exit(user: ActorId, token: TokenId, amount: u128) -> Vec<u8> {
    let user: EthAddress = actor_to_eth(user);
    let call = IVault::cancelForceExitCall {
        user: user.into(),
        token: token.into(),
        amount: ::alloy_sol_types::private::U256::from(amount),
    };
    call.abi_encode()
}

#[program]
impl VaultProgram {
    #[export]
    pub fn create() -> Self {
        let state = VaultState::get_mut();
        state.admin = Some(sails_rs::gstd::msg::source());
        VaultProgram
    }

    pub fn vault(&self) -> VaultService {
        VaultService
    }
}

pub struct VaultService;

#[service(events = Events)]
impl VaultService {
    fn ensure_eth_caller(&self) {
        let state = VaultState::get_mut();
        if state.eth_vault_caller != Some(msg::source()) {
            panic!("UnauthorizedEthCaller");
        }
    }
    // Admin function to authorize an OrderBook program
    #[export]
    pub fn add_market(&mut self, program_id: ActorId) {
        let state = VaultState::get_mut();
        if state.admin != Some(sails_rs::gstd::msg::source()) {
            panic!("Unauthorized: Not Admin");
        }
        debug!(
            "Vault::add_market caller={:?} program_id={:?}",
            msg::source(),
            program_id
        );
        state.authorized_programs.insert(program_id);
        reply_ok();
    }

    #[export]
    pub fn update_fee_rate(&mut self, new_rate: u128) {
        let state = VaultState::get_mut();
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
    pub fn set_eth_vault_caller(&mut self, program_id: ActorId) {
        let state = VaultState::get_mut();
        if state.admin != Some(msg::source()) {
            panic!("Unauthorized: Not Admin");
        }
        state.eth_vault_caller = Some(program_id);
        reply_ok();
    }

    // Admin function to claim accumulated fees
    #[export]
    pub fn claim_fees(&mut self, token: TokenId) {
        let state = VaultState::get_mut();
        if state.admin != Some(msg::source()) {
            panic!("Unauthorized: Not Admin");
        }

        let amount = state.treasury.remove(&token).unwrap_or(0);
        if amount == 0 {
            // No fees to claim, return early to save gas/noise
            return;
        }

        self.emit_eth_event(Events::FeesClaimed { token, amount })
            .expect("EmitEventFailed");
        let mut emitter = self.emitter();
        emitter
            .emit_event(Events::FeesClaimed { token, amount })
            .expect("EmitEventFailed");
        reply_ok();
    }

    fn ensure_authorized(&self, user: Option<ActorId>) {
        let state = VaultState::get_mut();
        let caller = sails_rs::gstd::msg::source();
        debug!(
            "Vault::ensure_authorized caller={:?} admin={:?} user={:?} authorized_set={:?}",
            caller,
            state.admin,
            user,
            state.authorized_programs.contains(&caller)
        );
        if state.admin == Some(caller) {
            return;
        }
        if state.eth_vault_caller == Some(caller) {
            return;
        }
        if let Some(u) = user {
            if u == caller {
                return;
            }
        }
        if !state.authorized_programs.contains(&caller) {
            panic!("Unauthorized: Program not authorized");
        }
    }

    #[export]
    pub fn eth_deposit(&mut self, payload: Vec<u8>) {
        self.ensure_eth_caller();
        let decoded = EthDeposit::abi_decode(&payload, true).expect("Failed to decode ABI payload");

        let user: [u8; 20] = decoded.user.into();
        let token: [u8; 20] = decoded.token.into();
        let amount: u128 = decoded.amount.try_into().expect("Amount overflow");

        // Ethereum-side deposits are validated on L1; only the configured L1 caller may submit them.
        self.vault_deposit_unchecked(eth_to_actor(user), token, amount);
    }

    #[export]
    pub fn eth_withdraw(&mut self, payload: Vec<u8>) {
        self.ensure_eth_caller();
        let decoded = EthDeposit::abi_decode(&payload, true).expect("Failed to decode ABI payload");

        let user: [u8; 20] = decoded.user.into();
        let token: [u8; 20] = decoded.token.into();
        let amount: u128 = decoded.amount.try_into().expect("Amount overflow");

        // L1-validated ingress; only the configured L1 caller may submit it.
        self.vault_withdraw_unchecked(eth_to_actor(user), token, amount);
    }

    #[export]
    pub fn vault_deposit(&mut self, user: ActorId, token: TokenId, amount: u128) {
        self.ensure_authorized(Some(user));
        self.vault_deposit_unchecked(user, token, amount);
    }

    fn vault_deposit_unchecked(&mut self, user: ActorId, token: TokenId, amount: u128) {
        debug!(
            "Vault::vault_deposit caller={:?} user={:?} token={:?} amount={}",
            sails_rs::gstd::msg::source(),
            user,
            token,
            amount
        );
        let state = VaultState::get_mut();
        let user_balances = state.balances.entry(user).or_default();
        let tokens_for_user = user_balances.len();
        let balance = user_balances.entry(token).or_default();

        balance.available = balance.available.checked_add(amount).expect("MathOverflow");

        let balance_after = balance.available;
        debug!(
            "Vault::vault_deposit stored available={} reserved={} tokens_for_user={}",
            balance.available,
            balance.reserved,
            tokens_for_user + 1 // entry will be present after insert
        );

        self.emit_eth_event(Events::Deposit {
            user: actor_eth_bytes(user),
            token,
            amount,
            balance_after,
        })
        .expect("EmitEventFailed");
        let mut emitter = self.emitter();
        emitter
            .emit_event(Events::Deposit {
                user: actor_bytes(user),
                token,
                amount,
                balance_after,
            })
            .expect("EmitEventFailed");
        reply_ok();
    }

    #[export]
    pub fn vault_withdraw(&mut self, user: ActorId, token: TokenId, amount: u128) {
        self.ensure_authorized(Some(user));
        self.vault_withdraw_unchecked(user, token, amount);
    }

    fn vault_withdraw_unchecked(&mut self, user: ActorId, token: TokenId, amount: u128) {
        let state = VaultState::get_mut();
        let user_balances = state.balances.get_mut(&user).expect("UserNotFound");
        let balance = user_balances.get_mut(&token).expect("TokenNotFound");

        if balance.available < amount {
            panic!("InsufficientBalance");
        }

        balance.available = balance.available.checked_sub(amount).expect("MathOverflow");

        // Cross-chain release
        if let Some(eth_dest) = state.eth_vault_caller {
            let payload = encode_release_funds(user, token, amount);
            msg::send(eth_dest, payload, 0).expect("Failed to send cross-chain message");
        }

        self.emit_eth_event(Events::Withdrawal {
            user: actor_eth_bytes(user),
            token,
            amount,
            status: "Initiated".into(),
        })
        .expect("EmitEventFailed");
        let mut emitter = self.emitter();
        emitter
            .emit_event(Events::Withdrawal {
                user: actor_bytes(user),
                token,
                amount,
                status: "Initiated".into(),
            })
            .expect("EmitEventFailed");
        reply_ok();
    }

    #[export]
    pub async fn transfer_to_market(&mut self, market_id: ActorId, token: TokenId, amount: u128) {
        let user = msg::source();
        self.ensure_authorized(Some(user)); // User can transfer their own funds

        let state = VaultState::get_mut();
        if !state.authorized_programs.contains(&market_id) {
            panic!("UnauthorizedMarket");
        }

        // 1. Verify and deduct balance
        let user_balances = state.balances.get_mut(&user).expect("UserNotFound");
        let balance = user_balances.get_mut(&token).expect("TokenNotFound");

        if balance.available < amount {
            panic!("InsufficientBalance");
        }

        balance.available = balance.available.checked_sub(amount).expect("MathOverflow");

        // 2. Send deposit message to OrderBook
        // TODO: switch to OrderBook client once deposit method is exposed there.
        // Raw encoding of ("OrderBook", "Deposit", (user, token, amount))
        let payload = ("OrderBook", "Deposit", (user, token, amount)).encode();

        let result = msg::send_bytes_for_reply(market_id, payload, 0)
            .expect("SendFailed")
            .await;

        if result.is_err() {
            // Revert balance change if market deposit failed
            let state = VaultState::get_mut();
            let balance = state
                .balances
                .get_mut(&user)
                .and_then(|b| b.get_mut(&token))
                .expect("User and token balance must exist here");
            balance.available = balance.available.checked_add(amount).expect("MathOverflow");
            debug!("OrderBookDepositFailed");
            reply_ok();
            return;
        }

        reply_ok();
    }

    #[export]
    pub fn vault_force_exit(&mut self, user: ActorId, token: TokenId, amount: u128) {
        self.ensure_authorized(Some(user));
        let state = VaultState::get_mut();
        let user_balances = state.balances.get_mut(&user).expect("UserNotFound");
        let balance = user_balances.get_mut(&token).expect("TokenNotFound");

        let to_deduct = if balance.available < amount {
            balance.available
        } else {
            amount
        };

        balance.available = balance
            .available
            .checked_sub(to_deduct)
            .expect("MathOverflow");

        if let Some(eth_dest) = state.eth_vault_caller {
            let payload = encode_cancel_force_exit(user, token, to_deduct);
            msg::send(eth_dest, payload, 0).expect("Failed to send cross-chain message");
        }

        self.emit_eth_event(Events::Withdrawal {
            user: actor_eth_bytes(user),
            token,
            amount: to_deduct,
            status: "ForceExit".into(),
        })
        .expect("EmitEventFailed");

        let mut emitter = self.emitter();
        emitter
            .emit_event(Events::Withdrawal {
                user: actor_bytes(user),
                token,
                amount: to_deduct,
                status: "ForceExit".into(),
            })
            .expect("EmitEventFailed");

        reply_ok();
    }

    #[export]
    pub fn vault_reserve_funds(&mut self, user: ActorId, token: TokenId, amount: u128) {
        let caller = msg::source();
        debug!(
            "Vault::vault_reserve_funds caller={:?} user={:?} token={:?} amount={}",
            caller, user, token, amount
        );
        self.ensure_authorized(None); // Reserve must be from an authorized program (OrderBook)

        let state = VaultState::get_mut();

        if !state.balances.contains_key(&user) {
            debug!("Vault: UserNotFound: {:?}", user);
            panic!("UserNotFound");
        }
        let user_balances = state.balances.get_mut(&user).unwrap();

        if !user_balances.contains_key(&token) {
            debug!("Vault: TokenNotFound: {:?} for user {:?}", token, user);
            panic!("TokenNotFound");
        }
        let balance = user_balances.get_mut(&token).unwrap();

        debug!("Vault: Balance available={}", balance.available);

        if balance.available < amount {
            debug!(
                "Vault: InsufficientBalance: {} < {}",
                balance.available, amount
            );
            panic!("InsufficientBalance");
        }

        balance.available = balance.available.checked_sub(amount).expect("MathOverflow");
        balance.reserved = balance.reserved.checked_add(amount).expect("MathOverflow");

        self.emit_eth_event(Events::FundsReserved {
            user: actor_eth_bytes(user),
            token,
            amount,
        })
        .expect("EmitEventFailed");
        let mut emitter = self.emitter();
        emitter
            .emit_event(Events::FundsReserved {
                user: actor_bytes(user),
                token,
                amount,
            })
            .expect("EmitEventFailed");
        reply_ok();
    }

    #[export]
    pub fn vault_unlock_funds(&mut self, user: ActorId, token: TokenId, amount: u128) {
        self.ensure_authorized(None); // Unlock must be from an authorized program

        let state = VaultState::get_mut();
        let user_balances = state.balances.get_mut(&user).expect("UserNotFound");
        let balance = user_balances.get_mut(&token).expect("TokenNotFound");

        if balance.reserved < amount {
            panic!("InsufficientBalance");
        }

        balance.reserved = balance.reserved.checked_sub(amount).expect("MathOverflow");
        balance.available = balance.available.checked_add(amount).expect("MathOverflow");

        self.emit_eth_event(Events::FundsUnlocked {
            user: actor_eth_bytes(user),
            token,
            amount,
        })
        .expect("EmitEventFailed");
        let mut emitter = self.emitter();
        emitter
            .emit_event(Events::FundsUnlocked {
                user: actor_bytes(user),
                token,
                amount,
            })
            .expect("EmitEventFailed");
        reply_ok();
    }

    #[export]
    pub fn vault_settle_trade(
        &mut self,
        buyer: ActorId,
        seller: ActorId,
        base_token: TokenId,
        quote_token: TokenId,
        price: u128,
        quantity: u128, // Base amount
        fee: u128,      // Quote amount
        price_scale: u128,
    ) {
        self.ensure_authorized(None); // Settle must be from an authorized program

        let cost = mul_div_ceil(price, quantity, price_scale);
        let state = VaultState::get_mut();

        // Verification Phase
        let buyer_has_funds = state
            .balances
            .get(&buyer)
            .and_then(|m| m.get(&quote_token))
            .map(|b| b.reserved >= cost)
            .unwrap_or(false);
        if !buyer_has_funds {
            panic!("InsufficientBalance: Buyer");
        }

        let seller_has_funds = state
            .balances
            .get(&seller)
            .and_then(|m| m.get(&base_token))
            .map(|b| b.reserved >= quantity)
            .unwrap_or(false);
        if !seller_has_funds {
            panic!("InsufficientBalance: Seller");
        }

        // Fee Verification
        let state = VaultState::get_mut();
        let expected_fee = cost.checked_mul(state.fee_rate_bps).expect("MathOverflow") / 10000;

        if fee < expected_fee {
            panic!("InsufficientFee: Expected {}", expected_fee);
        }

        if cost < fee {
            panic!("InsufficientBalance: Fee");
        }
        let seller_proceeds = cost.checked_sub(fee).expect("MathOverflow");

        // Fee Accounting
        if fee > 0 {
            let treasury_balance = state.treasury.entry(quote_token).or_default();
            *treasury_balance = treasury_balance.checked_add(fee).expect("MathOverflow");
        }

        // Execution Phase
        // Buyer Quote: Reserved -= Cost
        let b_q = state
            .balances
            .get_mut(&buyer)
            .unwrap()
            .get_mut(&quote_token)
            .unwrap();
        b_q.reserved = b_q.reserved.checked_sub(cost).expect("MathOverflow");

        // Seller Quote: Available += Proceeds
        let s_q = state
            .balances
            .entry(seller)
            .or_default()
            .entry(quote_token)
            .or_default();
        s_q.available = s_q
            .available
            .checked_add(seller_proceeds)
            .expect("MathOverflow");

        // Seller Base: Reserved -= Quantity
        let s_b = state
            .balances
            .get_mut(&seller)
            .unwrap()
            .get_mut(&base_token)
            .unwrap();
        s_b.reserved = s_b.reserved.checked_sub(quantity).expect("MathOverflow");

        // Buyer Base: Available += Quantity
        let b_b = state
            .balances
            .entry(buyer)
            .or_default()
            .entry(base_token)
            .or_default();
        b_b.available = b_b.available.checked_add(quantity).expect("MathOverflow");

        self.emit_eth_event(Events::TradeSettled {
            buyer: actor_eth_bytes(buyer),
            seller: actor_eth_bytes(seller),
            base_token,
            quote_token,
            price,
            quantity,
            fee,
        })
        .expect("EmitEventFailed");
        let mut emitter = self.emitter();
        emitter
            .emit_event(Events::TradeSettled {
                buyer: actor_bytes(buyer),
                seller: actor_bytes(seller),
                base_token,
                quote_token,
                price,
                quantity,
                fee,
            })
            .expect("EmitEventFailed");
        reply_ok();
    }

    // --- Queries ---
    #[export]
    pub fn admin(&self) -> ActorId {
        VaultState::get_mut()
            .admin
            .unwrap_or(ActorId::from([0u8; 32]))
    }

    #[export]
    pub fn eth_vault_caller(&self) -> ActorId {
        VaultState::get_mut()
            .eth_vault_caller
            .unwrap_or(ActorId::from([0u8; 32]))
    }

    #[export]
    pub fn is_authorized(&self, program_id: ActorId) -> bool {
        let state = VaultState::get_mut();
        state.admin == Some(program_id) || state.authorized_programs.contains(&program_id)
    }

    #[export]
    pub fn get_balance(&self, user: ActorId, token: TokenId) -> (u128, u128) {
        let state = VaultState::get_mut();
        debug!(
            "Vault::get_balance user_raw={:?} normalized={:?} token={:?} existing_keys={}",
            user,
            actor_to_eth(user),
            token,
            state.balances.len()
        );
        state
            .balances
            .get(&user)
            .and_then(|m| m.get(&token))
            .map(|b| {
                debug!(
                    "Vault::get_balance hit user={:?} token={:?} available={} reserved={}",
                    user, token, b.available, b.reserved
                );
                (b.available, b.reserved)
            })
            .unwrap_or((0, 0))
    }

    #[export]
    pub fn get_treasury(&self, token: TokenId) -> u128 {
        let state = VaultState::get_mut();
        *state.treasury.get(&token).unwrap_or(&0)
    }
}

#[cfg(test)]
mod tests {
    extern crate std;

    use super::*;
    use vault_client::vault::io::VaultReserveFunds;

    #[test]
    fn reserve_payload_decodes() {
        const ROUTE: &[u8; 6] = &[0x14, b'V', b'a', b'u', b'l', b't'];
        let mut payload = "Vault".encode();
        payload.extend(VaultReserveFunds::encode_params(
            ActorId::from(1u64),
            [12u8; 20],
            5u128,
        ));
        assert!(payload.starts_with(ROUTE));
    }
}

use dex_common::{Address, TokenId};
use sails_rs::collections::{BTreeMap, BTreeSet};
use sails_rs::prelude::*;

#[derive(Clone, Debug, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct QuarantineEntry {
    pub amount: u128,
    pub release_timestamp: u64,
}

#[derive(Clone, Debug, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct UserBalance {
    /// Total user balance in the vault, including quarantined funds.
    pub amount: u128,
    /// Quarantined sub-balances locked for `transfer_to_market`.
    pub quarantined: Vec<QuarantineEntry>,
}

impl Default for UserBalance {
    fn default() -> Self {
        Self {
            amount: 0,
            quarantined: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct WithdrawalRequest {
    pub user: Address,
    pub amount: u128,
    pub request_id: u64,
    pub timestamp: u64,
}

#[derive(Default)]
pub struct VaultState {
    /// Token this Vault manages (e.g. USDC address)
    pub token: TokenId,
    /// Per-user total balances and quarantine entries.
    pub balances: BTreeMap<Address, UserBalance>,
    /// Authorized Orderbook programs
    pub registered_orderbooks: BTreeSet<Address>,
    /// Pending withdrawal requests
    pub pending_withdrawals: Vec<WithdrawalRequest>,
    /// Quarantine duration in seconds/blocks
    pub quarantine_period: u64,
    /// Admin
    pub admin: Option<Address>,
    /// Fee rate in BPS
    pub fee_rate_bps: u128,
}

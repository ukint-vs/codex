use clob_common::TokenId;
use sails_rs::collections::{BTreeMap, BTreeSet};
use sails_rs::prelude::*;

#[derive(Clone, Debug, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct QuarantinedDeposit {
    pub user: ActorId,
    pub amount: u128,
    pub deposit_timestamp: u64,
    pub release_timestamp: u64,
}

#[derive(Clone, Debug, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct WithdrawalRequest {
    pub user: ActorId,
    pub amount: u128,
    pub request_id: u64,
    pub timestamp: u64,
}

#[derive(Default)]
pub struct VaultState {
    /// Token this Vault manages (e.g. USDC address)
    pub token: TokenId,
    /// User available balances
    pub balances: BTreeMap<ActorId, u128>,
    /// Deposits waiting for quarantine period
    pub quarantined_deposits: Vec<QuarantinedDeposit>,
    /// Authorized Orderbook programs
    pub registered_orderbooks: BTreeSet<ActorId>,
    /// Pending withdrawal requests
    pub pending_withdrawals: Vec<WithdrawalRequest>,
    /// Quarantine duration in seconds/blocks
    pub quarantine_period: u64,
    /// Admin
    pub admin: Option<ActorId>,
    /// Treasury for fees - kept from original (implied)
    pub treasury: u128,
    /// Fee rate in BPS
    pub fee_rate_bps: u128,
}

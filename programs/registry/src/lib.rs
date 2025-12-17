#![no_std]

use clob_common::TokenId;
use sails_rs::{collections::HashMap, gstd::msg, prelude::*};

#[derive(Clone, Debug, PartialEq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct MarketInfo {
    pub orderbook_id: ActorId,
    pub vault_id: ActorId,
}

#[derive(Default)]
pub struct RegistryState {
    pub markets: HashMap<(TokenId, TokenId), MarketInfo>,
    pub admin: Option<ActorId>,
}

static mut STATE: Option<RegistryState> = None;

impl RegistryState {
    pub fn get_mut() -> &'static mut Self {
        unsafe { STATE.get_or_insert(Default::default()) }
    }
}

pub struct RegistryProgram;

#[program]
impl RegistryProgram {
    #[export]
    pub fn create() -> Self {
        let state = RegistryState::get_mut();
        state.admin = Some(msg::source());
        RegistryProgram
    }

    pub fn registry(&self) -> RegistryService {
        RegistryService
    }
}

pub struct RegistryService;

#[service]
impl RegistryService {
    #[export]
    pub fn register_market(
        &mut self,
        base_token: TokenId,
        quote_token: TokenId,
        orderbook_id: ActorId,
        vault_id: ActorId,
    ) {
        let state = RegistryState::get_mut();
        if state.admin != Some(msg::source()) {
            panic!("Unauthorized");
        }

        state.markets.insert(
            (base_token, quote_token),
            MarketInfo {
                orderbook_id,
                vault_id,
            },
        );
    }

    pub fn get_market(&self, base_token: TokenId, quote_token: TokenId) -> Option<MarketInfo> {
        let state = RegistryState::get_mut();
        state.markets.get(&(base_token, quote_token)).cloned()
    }
}

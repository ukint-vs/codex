#![no_std]

use core::cell::RefCell;

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

pub struct RegistryProgram {
    state: RefCell<RegistryState>,
}

#[program]
impl RegistryProgram {
    #[export]
    pub fn create() -> Self {
        Self {
            state: RefCell::new(RegistryState {
                admin: Some(msg::source()),
                ..Default::default()
            }),
        }
    }

    pub fn registry(&self) -> RegistryService<'_> {
        RegistryService::new(&self.state)
    }
}

pub struct RegistryService<'a> {
    state: &'a RefCell<RegistryState>,
}

impl<'a> RegistryService<'a> {
    pub fn new(state: &'a RefCell<RegistryState>) -> Self {
        Self { state }
    }

    #[inline]
    pub fn get_mut(&self) -> sails_rs::cell::RefMut<'_, RegistryState> {
        self.state.borrow_mut()
    }

    #[inline]
    pub fn get(&self) -> sails_rs::cell::Ref<'_, RegistryState> {
        self.state.borrow()
    }
}

#[service]
impl<'a> RegistryService<'a> {
    #[export]
    pub fn register_market(
        &mut self,
        base_token: TokenId,
        quote_token: TokenId,
        orderbook_id: ActorId,
        vault_id: ActorId,
    ) {
        let mut state = self.get_mut();
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
        let state = self.get();
        state.markets.get(&(base_token, quote_token)).cloned()
    }
}

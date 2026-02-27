#![no_std]
use dex_common::{Address, TokenId};
use matching_engine::{Book, IncomingOrder, MatchError, OrderId, Side};
use sails_rs::{cell::RefCell, client::*, gstd::Syscall, prelude::*};

use crate::state::{kind_from_io, side_from_io, Asset, OrderKindIO, SideIO};
use vault_client::{vault::Vault, *};

use vault_client::vault::VaultImpl;
use vault_client::Vault as VaultClient;
mod orderbook;
mod state;

#[cfg(test)]
mod tests;

pub struct Orderbook<'a, BaseVaultClient, QuoteVaultClient> {
    state: &'a RefCell<state::State>,
    base_vault: BaseVaultClient,
    quote_vault: QuoteVaultClient,
}
impl<'a, BaseVaultClient, QuoteVaultClient> Orderbook<'a, BaseVaultClient, QuoteVaultClient>
where
    BaseVaultClient: Vault<Env = GstdEnv>,
    QuoteVaultClient: Vault<Env = GstdEnv>,
{
    pub fn new(
        state: &'a RefCell<state::State>,
        base_vault: BaseVaultClient,
        quote_vault: QuoteVaultClient,
    ) -> Self {
        Self {
            state,
            base_vault,
            quote_vault,
        }
    }

    #[inline]
    pub fn get_mut(&self) -> sails_rs::cell::RefMut<'_, state::State> {
        self.state.borrow_mut()
    }

    #[inline]
    pub fn get(&self) -> sails_rs::cell::Ref<'_, state::State> {
        self.state.borrow()
    }
}

#[sails_rs::service]
impl<'a, BaseVaultClient, QuoteVaultClient> Orderbook<'a, BaseVaultClient, QuoteVaultClient>
where
    BaseVaultClient: Vault<Env = GstdEnv>,
    QuoteVaultClient: Vault<Env = GstdEnv>,
{
    #[export]
    pub fn deposit(&mut self, account: Address, token: TokenId, amount: u128) -> bool {
        let mut st = self.get_mut();
        let caller: Address = Syscall::message_source().into();
        if token == st.base_token_id {
            if caller != st.base_vault_id {
                panic!("Not allowed to deposit")
            }
            st.deposit(account, Asset::Base, U256::from(amount));
        } else if token == st.quote_token_id {
            if caller != st.quote_vault_id {
                panic!("Not allowed to deposit")
            }
            st.deposit(account, Asset::Quote, U256::from(amount));
        } else {
            panic!("Invalid token");
        }
        true
    }

    #[export]
    pub async fn withdraw_base(&mut self, amount: u128) {
        let caller: Address = Syscall::message_source().into();
        {
            let mut st = self.get_mut();
            st.withdraw(caller, Asset::Base, U256::from(amount));
        };

        let result = self
            .base_vault
            .vault_deposit(vault_client::Address(caller.0), amount)
            .await;

        if result.is_err() {
            let mut st = self.get_mut();
            st.deposit(caller, Asset::Base, U256::from(amount));
        }
    }

    #[export]
    pub async fn withdraw_quote(&mut self, amount: u128) {
        let caller: Address = Syscall::message_source().into();
        {
            let mut st = self.get_mut();
            st.withdraw(caller, Asset::Quote, U256::from(amount));
        };
        let result = self
            .quote_vault
            .vault_deposit(vault_client::Address(caller.0), amount)
            .await;

        if result.is_err() {
            let mut st = self.get_mut();
            st.deposit(caller, Asset::Quote, U256::from(amount));
        }
    }

    /// Submits an order and immediately matches against the book.
    /// Limit remainder is placed as resting order inside the book.
    #[export(unwrap_result)]
    pub fn submit_order(
        &mut self,
        side: SideIO,
        kind: OrderKindIO,
        limit_price: u128,
        amount_base: u128,
        max_quote: u128,
    ) -> Result<OrderId, MatchError> {
        let caller = Syscall::message_source().into();
        let mut st = self.get_mut();
        let order_id = st.alloc_order_id();

        let incoming = IncomingOrder {
            id: order_id,
            owner: caller,
            side: side_from_io(side),
            kind: kind_from_io(kind),
            limit_price: U256::from(limit_price),
            amount_base: U256::from(amount_base),
            max_quote: U256::from(max_quote),
        };
        let (locked_base, locked_quote) = st.lock_taker_funds(&incoming);
        let limits = st.limits;
        let report = matching_engine::execute(&mut st.book, &incoming, limits)?;
        st.settle_execution(&incoming, &report, locked_base, locked_quote);
        Ok(order_id)
    }

    #[export]
    pub fn cancel_order(&mut self, order_id: u64) {
        let caller = Syscall::message_source().into();
        let mut st = self.get_mut();

        let Some(view) = st.book.peek_order(order_id) else {
            panic!("Order not found");
        };
        if view.owner != caller {
            panic!("Not order owner");
        }

        let maker = st.book.cancel(order_id).expect("Order not found");

        // Unlock remaining locked funds back to caller.
        match maker.side {
            Side::Sell => {
                st.unlock(caller, Asset::Base, maker.remaining_base);
            }
            Side::Buy => {
                st.unlock(caller, Asset::Quote, maker.reserved_quote);
            }
        }
    }

    #[export]
    pub fn best_bid_price(&self) -> u128 {
        self.get()
            .book
            .best_price(Side::Buy)
            .map(|x| x.low_u128())
            .unwrap_or(0)
    }

    #[export]
    pub fn best_ask_price(&self) -> u128 {
        self.get()
            .book
            .best_price(Side::Sell)
            .map(|x| x.low_u128())
            .unwrap_or(0)
    }

    #[export]
    pub fn balance_of(&self, who: Address) -> (u128, u128) {
        let st = self.get();
        let b = st.balances.get(&who).cloned().unwrap_or_default();
        (b.base.low_u128(), b.quote.low_u128())
    }

    #[export]
    pub fn order_by_id(&self, order_id: u64) -> (bool, u64, Address, u16, u128, u128, u128) {
        let st = self.get();

        // Tuple-only ABI: return (found, fields...). If not found -> found=false and zeros.
        let Some(o) = st.book.peek_order(order_id) else {
            return (false, 0, Address::default(), 0, 0, 0, 0);
        };

        let side_io: u16 = match o.side {
            Side::Buy => 0,
            Side::Sell => 1,
        };

        (
            true,
            o.id,
            o.owner,
            side_io,
            o.price.low_u128(),
            o.remaining_base.low_u128(),
            o.reserved_quote.low_u128(),
        )
    }
}

#[derive(Default)]
pub struct OrderBookProgram {
    base_vault_id: Address,
    quote_vault_id: Address,
    state: RefCell<state::State>,
}

#[sails_rs::program]
impl OrderBookProgram {
    pub fn create(
        base_vault_id: Address,
        quote_vault_id: Address,
        base_token_id: TokenId,
        quote_token_id: TokenId,
        max_trades: u32,
        max_preview_scans: u32,
    ) -> Self {
        Self {
            base_vault_id,
            quote_vault_id,
            state: RefCell::new(state::State::new(
                base_vault_id,
                quote_vault_id,
                base_token_id,
                quote_token_id,
                max_trades,
                max_preview_scans,
            )),
        }
    }

    pub fn orderbook(&self) -> Orderbook<'_, Service<VaultImpl>, Service<VaultImpl>> {
        let base_vault = VaultProgram::client(self.base_vault_id.into()).vault();
        let quote_vault = VaultProgram::client(self.quote_vault_id.into()).vault();
        Orderbook::new(&self.state, base_vault, quote_vault)
    }
}

#![no_std]
use clob_common::TokenId;
#[cfg(feature = "debug")]
use clob_common::{eth_to_actor, SHOWCASE_PREFUNDED_ETH_ADDRESSES};
use matching_engine::{Book, IncomingOrder, MatchError, OrderId, OrderKind, Side};
use sails_rs::{cell::RefCell, gstd::msg, prelude::*};

use crate::state::{kind_from_io, side_from_io, Asset, OrderKindIO, SideIO};
use vault_client::vault::io as vault_io;
mod orderbook;
mod state;

#[cfg(feature = "debug")]
const DEMO_MAX_TOTAL_ORDERS: u32 = 2_000;
#[cfg(feature = "debug")]
const BPS_SCALE: u32 = 10_000;
#[cfg(feature = "debug")]
const DEMO_SEED_FALLBACK: u64 = 0x9E37_79B9_7F4A_7C15;
#[cfg(feature = "debug")]
const SHOWCASE_PREFUND_BASE_ATOMS: u128 = 10_000_000_000_000;
#[cfg(feature = "debug")]
const SHOWCASE_PREFUND_QUOTE_ATOMS: u128 = 10_000_000_000_000;
#[cfg(feature = "debug")]
const SHOWCASE_INIT_LEVELS: u16 = 10;
#[cfg(feature = "debug")]
const SHOWCASE_INIT_ORDERS_PER_LEVEL: u16 = 10;
#[cfg(feature = "debug")]
const SHOWCASE_INIT_TICK_BPS: u16 = 50;
#[cfg(feature = "debug")]
const SHOWCASE_INIT_MIN_BASE_ATOMS: u128 = 2_000_000;
#[cfg(feature = "debug")]
const SHOWCASE_INIT_MAX_BASE_ATOMS: u128 = 20_000_000;
#[cfg(feature = "debug")]
const SHOWCASE_MAKERS_PER_SIDE: usize = SHOWCASE_PREFUNDED_ETH_ADDRESSES.len() / 2;
#[cfg(feature = "debug")]
const VARA_TOKEN_ID: TokenId = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x10,
];
#[cfg(feature = "debug")]
const USDC_TOKEN_ID: TokenId = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x01,
];
#[cfg(feature = "debug")]
const ETH_TOKEN_ID: TokenId = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x11,
];
#[cfg(feature = "debug")]
const MID_PRICE_1E30: u128 = 1_000_000_000_000_000_000_000_000_000_000;
#[cfg(feature = "debug")]
const MID_PRICE_VARA_USDC_1E30: u128 = 1_165_000_000_000_000_000_000_000_000;
#[cfg(feature = "debug")]
const MID_PRICE_ETH_USDC_1E30: u128 = 2_055_000_000_000_000_000_000_000_000_000_000;
#[cfg(feature = "debug")]
const MID_PRICE_USDC_VARA_1E30: u128 = 858_369_098_000_000_000_000_000_000_000_000;

pub struct Orderbook<'a> {
    state: &'a RefCell<state::State>,
}

type TradeHistoryEntry = (u64, u64, u64, ActorId, ActorId, u128, u128, u128);

impl<'a> Orderbook<'a> {
    pub fn new(state: &'a RefCell<state::State>) -> Self {
        Self { state }
    }

    #[inline]
    pub fn get_mut(&self) -> sails_rs::cell::RefMut<'_, state::State> {
        self.state.borrow_mut()
    }

    #[inline]
    pub fn get(&self) -> sails_rs::cell::Ref<'_, state::State> {
        self.state.borrow()
    }

    fn submit_order_for_owner(
        st: &mut state::State,
        owner: ActorId,
        side: Side,
        kind: OrderKind,
        limit_price: u128,
        amount_base: u128,
        max_quote: u128,
    ) -> Result<OrderId, MatchError> {
        let order_id = st.alloc_order_id();
        let incoming = IncomingOrder {
            id: order_id,
            owner,
            side,
            kind,
            limit_price: U256::from(limit_price),
            amount_base: U256::from(amount_base),
            max_quote: U256::from(max_quote),
        };

        let (locked_base, locked_quote) = st.lock_taker_funds(&incoming);
        let limits = st.limits;
        let report = matching_engine::execute(&mut st.book, &incoming, limits)?;
        st.settle_execution(&incoming, &report, locked_base, locked_quote);
        st.append_executed_trades(&report.trades);
        Ok(order_id)
    }

    fn trade_to_io(trade: &state::ExecutedTrade) -> TradeHistoryEntry {
        (
            trade.seq,
            trade.maker_order_id,
            trade.taker_order_id,
            trade.maker,
            trade.taker,
            trade.price,
            trade.amount_base,
            trade.amount_quote,
        )
    }

    #[cfg(feature = "debug")]
    fn next_rng_u64(state: &mut u64) -> u64 {
        let mut x = *state;
        if x == 0 {
            x = DEMO_SEED_FALLBACK;
        }
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        *state = x;
        x
    }

    #[cfg(feature = "debug")]
    fn next_rng_u128(state: &mut u64) -> u128 {
        (u128::from(Self::next_rng_u64(state)) << 64) | u128::from(Self::next_rng_u64(state))
    }

    #[cfg(feature = "debug")]
    fn seeded_actor(seed: u64, side: Side, level: u16, index: u16) -> ActorId {
        let side_salt = match side {
            Side::Buy => 0xA5A5_5A5A_F0F0_0F0F,
            Side::Sell => 0x5A5A_A5A5_0F0F_F0F0,
        };

        let mut s = seed
            ^ side_salt
            ^ (u64::from(level) << 16)
            ^ (u64::from(index) << 40)
            ^ 0xD1B5_4A32_C9E8_761F;
        if s == 0 {
            s = DEMO_SEED_FALLBACK;
        }

        let mut out = [0u8; 32];
        for chunk in out.chunks_exact_mut(8) {
            chunk.copy_from_slice(&Self::next_rng_u64(&mut s).to_le_bytes());
        }
        ActorId::from(out)
    }

    #[cfg(feature = "debug")]
    fn seeded_amount(state: &mut u64, min_amount_base: u128, max_amount_base: u128) -> u128 {
        let span = max_amount_base
            .checked_sub(min_amount_base)
            .and_then(|x| x.checked_add(1))
            .expect("InvalidAmountRange");

        let rnd = Self::next_rng_u128(state) % span;
        min_amount_base + rnd
    }

    #[cfg(feature = "debug")]
    fn level_prices(mid_price: u128, tick_bps: u16, level: u16) -> (u128, u128) {
        let offset = u32::from(tick_bps)
            .checked_mul(u32::from(level))
            .expect("TickOverflow");

        let ask_factor = BPS_SCALE.checked_add(offset).expect("TickOverflow");
        let bid_factor = BPS_SCALE.checked_sub(offset).expect("TickTooWide");

        let mid = U256::from(mid_price);
        let ask = (mid * U256::from(ask_factor)) / U256::from(BPS_SCALE);
        let bid = (mid * U256::from(bid_factor)) / U256::from(BPS_SCALE);

        (bid.low_u128(), ask.low_u128())
    }

    #[cfg(feature = "debug")]
    fn showcase_mid_price(base_token_id: TokenId, quote_token_id: TokenId) -> u128 {
        if base_token_id == VARA_TOKEN_ID && quote_token_id == USDC_TOKEN_ID {
            MID_PRICE_VARA_USDC_1E30
        } else if base_token_id == ETH_TOKEN_ID && quote_token_id == USDC_TOKEN_ID {
            MID_PRICE_ETH_USDC_1E30
        } else if base_token_id == USDC_TOKEN_ID && quote_token_id == VARA_TOKEN_ID {
            MID_PRICE_USDC_VARA_1E30
        } else {
            MID_PRICE_1E30
        }
    }

    #[cfg(feature = "debug")]
    fn seed_showcase_prefunds(st: &mut state::State) {
        for address in SHOWCASE_PREFUNDED_ETH_ADDRESSES {
            let actor = eth_to_actor(address);
            st.deposit(actor, Asset::Base, U256::from(SHOWCASE_PREFUND_BASE_ATOMS));
            st.deposit(
                actor,
                Asset::Quote,
                U256::from(SHOWCASE_PREFUND_QUOTE_ATOMS),
            );
        }
    }

    #[cfg(feature = "debug")]
    fn seed_showcase_orderbook(st: &mut state::State) {
        Self::seed_showcase_prefunds(st);

        if st.book.best_price(Side::Buy).is_some() || st.book.best_price(Side::Sell).is_some() {
            return;
        }

        let per_side = u32::from(SHOWCASE_INIT_LEVELS)
            .checked_mul(u32::from(SHOWCASE_INIT_ORDERS_PER_LEVEL))
            .expect("TooManyOrders");
        let total = per_side.checked_mul(2).expect("TooManyOrders");
        if total > DEMO_MAX_TOTAL_ORDERS {
            panic!("TooManyOrders");
        }

        let mid_price = Self::showcase_mid_price(st.base_token_id, st.quote_token_id);
        let mut rng_state = DEMO_SEED_FALLBACK
            ^ (u64::from(st.base_token_id[19]) << 8)
            ^ (u64::from(st.quote_token_id[19]) << 16);

        for level in 1..=SHOWCASE_INIT_LEVELS {
            let (bid_price, ask_price) =
                Self::level_prices(mid_price, SHOWCASE_INIT_TICK_BPS, level);
            if bid_price == 0 || ask_price == 0 || ask_price <= bid_price {
                continue;
            }

            for i in 0..SHOWCASE_INIT_ORDERS_PER_LEVEL {
                let maker_slot = (usize::from(level) + usize::from(i)) % SHOWCASE_MAKERS_PER_SIDE;
                let ask_owner = eth_to_actor(SHOWCASE_PREFUNDED_ETH_ADDRESSES[maker_slot * 2]);
                let bid_owner =
                    eth_to_actor(SHOWCASE_PREFUNDED_ETH_ADDRESSES[(maker_slot * 2) + 1]);

                let ask_amount = Self::seeded_amount(
                    &mut rng_state,
                    SHOWCASE_INIT_MIN_BASE_ATOMS,
                    SHOWCASE_INIT_MAX_BASE_ATOMS,
                );
                let bid_amount = Self::seeded_amount(
                    &mut rng_state,
                    SHOWCASE_INIT_MIN_BASE_ATOMS,
                    SHOWCASE_INIT_MAX_BASE_ATOMS,
                );

                Self::submit_order_for_owner(
                    st,
                    ask_owner,
                    Side::Sell,
                    OrderKind::Limit,
                    ask_price,
                    ask_amount,
                    0,
                )
                .expect("InitSeedAskFailed");

                Self::submit_order_for_owner(
                    st,
                    bid_owner,
                    Side::Buy,
                    OrderKind::Limit,
                    bid_price,
                    bid_amount,
                    0,
                )
                .expect("InitSeedBidFailed");
            }
        }
    }
}

#[sails_rs::service]
impl<'a> Orderbook<'a> {
    #[export]
    pub fn deposit(&mut self, account: ActorId, token: TokenId, amount: u128) -> bool {
        let mut st = self.get_mut();
        let caller = sails_rs::gstd::msg::source();
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
        let caller = msg::source();
        let base_vault_id = {
            let mut st = self.get_mut();
            st.withdraw(caller, Asset::Base, U256::from(amount));
            st.base_vault_id
        };
        let payload = vault_io::VaultDeposit::encode_params_with_prefix("Vault", caller, amount);
        let result = msg::send_bytes_for_reply(base_vault_id, payload, 0)
            .expect("SendFailed")
            .await;

        if result.is_err() {
            let mut st = self.get_mut();
            st.deposit(caller, Asset::Base, U256::from(amount));
        }
    }

    #[export]
    pub async fn withdraw_quote(&mut self, amount: u128) {
        let caller = msg::source();
        let quote_vault_id = {
            let mut st = self.get_mut();
            st.withdraw(caller, Asset::Quote, U256::from(amount));
            st.quote_vault_id
        };
        let payload = vault_io::VaultDeposit::encode_params_with_prefix("Vault", caller, amount);
        let result = msg::send_bytes_for_reply(quote_vault_id, payload, 0)
            .expect("SendFailed")
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
        let caller = sails_rs::gstd::msg::source();
        let mut st = self.get_mut();
        Orderbook::submit_order_for_owner(
            &mut st,
            caller,
            side_from_io(side),
            kind_from_io(kind),
            limit_price,
            amount_base,
            max_quote,
        )
    }

    #[export]
    pub fn populate_demo_orders(
        &mut self,
        seed: u64,
        levels: u16,
        orders_per_level: u16,
        mid_price: u128,
        tick_bps: u16,
        min_amount_base: u128,
        max_amount_base: u128,
    ) -> (u32, u32, u64, u64) {
        #[cfg(not(feature = "debug"))]
        {
            let _ = (
                seed,
                levels,
                orders_per_level,
                mid_price,
                tick_bps,
                min_amount_base,
                max_amount_base,
            );
            panic!("DebugFeatureDisabled");
        }

        #[cfg(feature = "debug")]
        {
            if levels == 0 || orders_per_level == 0 {
                panic!("InvalidPopulateShape");
            }
            if mid_price == 0 || tick_bps == 0 {
                panic!("InvalidPopulatePricing");
            }
            if min_amount_base == 0 || min_amount_base > max_amount_base {
                panic!("InvalidPopulateAmountRange");
            }

            let per_side = u32::from(levels)
                .checked_mul(u32::from(orders_per_level))
                .expect("TooManyOrders");
            let total = per_side.checked_mul(2).expect("TooManyOrders");
            if total > DEMO_MAX_TOTAL_ORDERS {
                panic!("TooManyOrders");
            }

            let caller = msg::source();
            {
                let st = self.get();
                if st.admin != Some(caller) {
                    panic!("UnauthorizedPopulateDemo");
                }
                if st.book.best_price(Side::Buy).is_some()
                    || st.book.best_price(Side::Sell).is_some()
                {
                    panic!("MarketNotEmpty");
                }
            }

            let mut rng_state = if seed == 0 { DEMO_SEED_FALLBACK } else { seed };
            let mut bids_inserted = 0u32;
            let mut asks_inserted = 0u32;
            let mut first_order_id = 0u64;
            let mut last_order_id = 0u64;

            for level in 1..=levels {
                let (bid_price, ask_price) = Orderbook::level_prices(mid_price, tick_bps, level);
                if bid_price == 0 || ask_price == 0 || ask_price <= bid_price {
                    panic!("InvalidPopulatePriceLevel");
                }

                for i in 0..orders_per_level {
                    let owner = Orderbook::seeded_actor(seed, Side::Sell, level, i);
                    let amount_base =
                        Orderbook::seeded_amount(&mut rng_state, min_amount_base, max_amount_base);

                    let mut st = self.get_mut();
                    st.deposit(owner, Asset::Base, U256::from(amount_base));
                    let order_id = Orderbook::submit_order_for_owner(
                        &mut st,
                        owner,
                        Side::Sell,
                        OrderKind::Limit,
                        ask_price,
                        amount_base,
                        0,
                    )
                    .expect("PopulateOrderFailed");
                    drop(st);

                    if first_order_id == 0 {
                        first_order_id = order_id;
                    }
                    last_order_id = order_id;
                    asks_inserted = asks_inserted.saturating_add(1);
                }

                for i in 0..orders_per_level {
                    let owner = Orderbook::seeded_actor(seed, Side::Buy, level, i);
                    let amount_base =
                        Orderbook::seeded_amount(&mut rng_state, min_amount_base, max_amount_base);
                    let quote_to_lock = matching_engine::calc_quote_ceil(
                        U256::from(amount_base),
                        U256::from(bid_price),
                    )
                    .expect("PopulateMathError");

                    let mut st = self.get_mut();
                    st.deposit(owner, Asset::Quote, quote_to_lock);
                    let order_id = Orderbook::submit_order_for_owner(
                        &mut st,
                        owner,
                        Side::Buy,
                        OrderKind::Limit,
                        bid_price,
                        amount_base,
                        0,
                    )
                    .expect("PopulateOrderFailed");
                    drop(st);

                    if first_order_id == 0 {
                        first_order_id = order_id;
                    }
                    last_order_id = order_id;
                    bids_inserted = bids_inserted.saturating_add(1);
                }
            }

            (bids_inserted, asks_inserted, first_order_id, last_order_id)
        }
    }

    #[export]
    pub fn cancel_order(&mut self, order_id: u64) {
        let caller = msg::source();
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
    pub fn balance_of(&self, who: ActorId) -> (u128, u128) {
        let st = self.get();
        let b = st.balances.get(&who).cloned().unwrap_or_default();
        (b.base.low_u128(), b.quote.low_u128())
    }

    #[export]
    pub fn order_by_id(&self, order_id: u64) -> (bool, u64, ActorId, u16, u128, u128, u128) {
        let st = self.get();

        // Tuple-only ABI: return (found, fields...). If not found -> found=false and zeros.
        let Some(o) = st.book.peek_order(order_id) else {
            return (false, 0, ActorId::zero(), 0, 0, 0, 0);
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

    #[export]
    pub fn orders(&self, offset: u32, count: u32) -> Vec<(u64, ActorId, u16, u128, u128, u128)> {
        let state = self.get();

        state
            .book
            .orders(offset, count)
            .into_iter()
            .map(|order| {
                let side_io: u16 = match order.side {
                    Side::Buy => 0,
                    Side::Sell => 1,
                };

                (
                    order.id,
                    order.owner,
                    side_io,
                    order.price.low_u128(),
                    order.remaining_base.low_u128(),
                    order.reserved_quote.low_u128(),
                )
            })
            .collect()
    }

    #[export]
    pub fn orders_reverse(
        &self,
        offset: u32,
        count: u32,
    ) -> Vec<(u64, ActorId, u16, u128, u128, u128)> {
        let state = self.get();

        state
            .book
            .orders_reverse(offset, count)
            .into_iter()
            .map(|order| {
                let side_io: u16 = match order.side {
                    Side::Buy => 0,
                    Side::Sell => 1,
                };

                (
                    order.id,
                    order.owner,
                    side_io,
                    order.price.low_u128(),
                    order.remaining_base.low_u128(),
                    order.reserved_quote.low_u128(),
                )
            })
            .collect()
    }

    #[export]
    pub fn trades_count(&self) -> u64 {
        self.get().executed_trades.len() as u64
    }

    #[export]
    pub fn trades(&self, offset: u32, count: u32) -> Vec<TradeHistoryEntry> {
        self.get()
            .executed_trades
            .iter()
            .skip(offset as usize)
            .take(count as usize)
            .map(Orderbook::trade_to_io)
            .collect()
    }

    #[export]
    pub fn trades_reverse(&self, offset: u32, count: u32) -> Vec<TradeHistoryEntry> {
        self.get()
            .executed_trades
            .iter()
            .rev()
            .skip(offset as usize)
            .take(count as usize)
            .map(Orderbook::trade_to_io)
            .collect()
    }
}

#[derive(Default)]
pub struct OrderBookProgram {
    state: RefCell<state::State>,
}

#[sails_rs::program]
impl OrderBookProgram {
    pub fn create(
        base_vault_id: ActorId,
        quote_vault_id: ActorId,
        base_token_id: TokenId,
        quote_token_id: TokenId,
        max_trades: u32,
        max_preview_scans: u32,
    ) -> Self {
        #[cfg(feature = "debug")]
        let mut state = state::State::new(
            msg::source(),
            base_vault_id,
            quote_vault_id,
            base_token_id,
            quote_token_id,
            max_trades,
            max_preview_scans,
        );
        #[cfg(not(feature = "debug"))]
        let state = state::State::new(
            msg::source(),
            base_vault_id,
            quote_vault_id,
            base_token_id,
            quote_token_id,
            max_trades,
            max_preview_scans,
        );
        #[cfg(feature = "debug")]
        Orderbook::seed_showcase_orderbook(&mut state);

        Self {
            state: RefCell::new(state),
        }
    }

    pub fn orderbook(&self) -> Orderbook<'_> {
        Orderbook::new(&self.state)
    }
}

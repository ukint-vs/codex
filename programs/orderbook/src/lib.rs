#![no_std]

extern crate alloc;

pub mod state;

use alloc::vec::Vec;
use clob_common::{
    actor_to_eth, eth_to_actor, mul_div_ceil, EthAddress, Order, OrderId, Price, Quantity, Side,
    TokenId, TraderId, DEFAULT_PRICE_SCALE, FEE_RATE_BPS,
};
use sails_rs::{
    collections::{BTreeMap, HashMap},
    gstd::{debug, msg},
    hex,
    prelude::*,
};
use state::arena::{Arena, Index};
use state::linked_list::{OrderNode, OrderQueue};
use vault_client::vault::io::{VaultReserveFunds, VaultSettleTrade, VaultUnlockFunds};

// --- Events ---

#[sails_rs::event]
#[derive(Clone, Debug, PartialEq, Encode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum Events {
    OrderPlaced {
        order_id: OrderId,
        price: Price,
        quantity: Quantity,
        is_buy: u32,
    },
    OrderCanceled {
        order_id: OrderId,
    },
    TradeExecuted {
        maker_order_id: OrderId,
        taker_order_id: OrderId,
        price: Price,
        quantity: Quantity,
        maker: [u8; 32],
        taker: [u8; 32],
    },
}

// --- State ---

#[derive(Default)]
pub struct OrderBookState {
    pub bids: BTreeMap<Price, OrderQueue>,
    pub asks: BTreeMap<Price, OrderQueue>,
    pub arena: Arena<OrderNode>,
    pub order_indices: HashMap<OrderId, Index>,
    pub vault_id: ActorId,
    pub admin: Option<ActorId>,
    pub eth_orderbook_caller: Option<ActorId>,
    pub order_counter: u128,
    pub market_scales: HashMap<(TokenId, TokenId), u128>,
}

static mut STATE: Option<OrderBookState> = None;

impl OrderBookState {
    pub fn get_mut() -> &'static mut Self {
        unsafe { STATE.get_or_insert(Default::default()) }
    }
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

pub struct OrderBookProgram;

#[program]
impl OrderBookProgram {
    #[export]
    pub fn create(vault_id: ActorId) -> Self {
        let state = OrderBookState::get_mut();
        state.vault_id = vault_id;
        state.admin = Some(msg::source());
        OrderBookProgram
    }

    pub fn order_book(&self) -> OrderBookService {
        OrderBookService
    }
}

pub struct OrderBookService;

#[service(events = Events)]
impl OrderBookService {
    fn caller_trader() -> TraderId {
        let trader = msg::source();
        debug!("OrderBook::caller_trader source={:?}", trader);
        trader
    }

    fn order_to_tuple(order: &Order) -> (TraderId, bool, Price, Quantity) {
        (
            order.trader,
            matches!(order.side, Side::Buy),
            order.price,
            order.quantity,
        )
    }

    fn ensure_admin(&self) {
        let state = OrderBookState::get_mut();
        if state.admin != Some(msg::source()) {
            panic!("Unauthorized");
        }
    }

    fn market_scale_value(&self, base_token: TokenId, quote_token: TokenId) -> u128 {
        let state = OrderBookState::get_mut();
        state
            .market_scales
            .get(&(base_token, quote_token))
            .copied()
            .unwrap_or(DEFAULT_PRICE_SCALE)
    }

    fn ensure_eth_caller(&self) {
        let state = OrderBookState::get_mut();
        if state.eth_orderbook_caller != Some(msg::source()) {
            panic!("UnauthorizedEthCaller");
        }
    }

    fn calculate_total_qty(queue: &OrderQueue, arena: &Arena<OrderNode>) -> Quantity {
        let mut total = 0;
        let mut current = queue.head;
        while let Some(idx) = current {
            if let Some(node) = arena.get(idx) {
                total += node.order.quantity;
                current = node.next;
            } else {
                break;
            }
        }
        total
    }

    fn peek_first_order(queue: &OrderQueue, arena: &Arena<OrderNode>) -> Option<Order> {
        queue
            .head
            .and_then(|idx| arena.get(idx).map(|node| node.order.clone()))
    }

    #[export]
    pub fn set_vault(&mut self, new_vault: ActorId) {
        self.ensure_admin();
        let state = OrderBookState::get_mut();
        state.vault_id = new_vault;
    }

    #[export]
    pub fn set_eth_orderbook_caller(&mut self, program_id: ActorId) {
        self.ensure_admin();
        let state = OrderBookState::get_mut();
        state.eth_orderbook_caller = Some(program_id);
    }

    #[export]
    pub fn set_market_scale(
        &mut self,
        base_token: TokenId,
        quote_token: TokenId,
        price_scale: u128,
    ) {
        self.ensure_admin();
        if price_scale == 0 {
            panic!("InvalidPriceScale");
        }
        let state = OrderBookState::get_mut();
        state
            .market_scales
            .insert((base_token, quote_token), price_scale);
    }

    #[export]
    pub fn admin(&self) -> ActorId {
        OrderBookState::get_mut()
            .admin
            .unwrap_or(ActorId::from([0u8; 32]))
    }

    #[export]
    pub fn vault(&self) -> ActorId {
        OrderBookState::get_mut().vault_id
    }

    #[export]
    pub fn order_counter(&self) -> u128 {
        OrderBookState::get_mut().order_counter
    }

    #[export]
    pub fn get_order(&self, order_id: OrderId) -> (bool, TraderId, bool, Price, Quantity) {
        let state = OrderBookState::get_mut();
        if let Some(idx) = state.order_indices.get(&order_id) {
            if let Some(node) = state.arena.get(*idx) {
                let (trader, is_buy, price, qty) = Self::order_to_tuple(&node.order);
                return (true, trader, is_buy, price, qty);
            }
        }
        (false, ActorId::from([0u8; 32]), false, 0, 0)
    }

    #[export]
    pub fn best_bid(&self) -> (bool, Price, Quantity) {
        let state = OrderBookState::get_mut();
        if let Some((price, queue)) = state.bids.iter().next_back() {
            let total_qty = Self::calculate_total_qty(queue, &state.arena);
            (true, *price, total_qty)
        } else {
            (false, 0, 0)
        }
    }

    #[export]
    pub fn best_ask(&self) -> (bool, Price, Quantity) {
        let state = OrderBookState::get_mut();
        if let Some((price, queue)) = state.asks.iter().next() {
            let total_qty = Self::calculate_total_qty(queue, &state.arena);
            (true, *price, total_qty)
        } else {
            (false, 0, 0)
        }
    }

    #[export]
    pub fn market_scale(&self, base_token: TokenId, quote_token: TokenId) -> u128 {
        self.market_scale_value(base_token, quote_token)
    }

    async fn place_order_internal(
        &mut self,
        trader: TraderId,
        price: Price,
        quantity: Quantity,
        is_buy: bool,
        base_token: TokenId,
        quote_token: TokenId,
    ) {
        let price_scale = self.market_scale_value(base_token, quote_token);
        if price_scale == 0 {
            panic!("InvalidPriceScale");
        }
        let side = if is_buy { Side::Buy } else { Side::Sell };

        // 1. Calculate required amount
        let (required_amount, required_token) = match side {
            Side::Buy => (mul_div_ceil(price, quantity, price_scale), quote_token),
            Side::Sell => (quantity, base_token),
        };

        // 2. Reserve Funds
        let state = OrderBookState::get_mut();
        let vault_id = state.vault_id;

        // Encode using generated Vault IO helpers to match routing
        let payload = VaultReserveFunds::encode_params_with_prefix(
            "Vault",
            trader,
            required_token,
            required_amount,
        );
        debug!(
            "OrderBook::place_order reserve payload_hex=0x{}",
            hex::encode(&payload)
        );

        msg::send_bytes_for_reply(vault_id, payload, 0)
            .expect("SendFailed")
            .await
            .expect("ReserveFailed");

        // 3. Add Order to Book
        let state = OrderBookState::get_mut();
        state.order_counter += 1;
        let order_id = state.order_counter;

        let order = Order {
            id: order_id,
            trader,
            side: side.clone(),
            price,
            quantity,
            created_at: 0,
        };

        let queue = match side {
            Side::Buy => state.bids.entry(price).or_default(),
            Side::Sell => state.asks.entry(price).or_default(),
        };

        let idx = queue.push_back(&mut state.arena, order.clone());
        state.order_indices.insert(order_id, idx);

        self.emit_eth_event(Events::OrderPlaced {
            order_id,
            price,
            quantity,
            is_buy: if is_buy { 1 } else { 0 },
        })
        .unwrap();
        let mut emitter = self.emitter();
        emitter
            .emit_event(Events::OrderPlaced {
                order_id,
                price,
                quantity,
                is_buy: if is_buy { 1 } else { 0 },
            })
            .unwrap();

        // 4. Match Orders
        let _ = self.match_orders(base_token, quote_token).await;
    }

    #[export]
    pub async fn place_order(
        &mut self,
        price: Price,
        quantity: Quantity,
        is_buy: bool,
        base_token: TokenId,
        quote_token: TokenId,
    ) {
        let src = msg::source();
        debug!("OrderBook::place_order msg::source={:?}", src);
        let trader = Self::caller_trader();
        self.place_order_internal(trader, price, quantity, is_buy, base_token, quote_token)
            .await;
    }

    #[export]
    pub async fn place_order_eth(
        &mut self,
        user: EthAddress,
        price: Price,
        quantity: Quantity,
        is_buy: bool,
        base_token: TokenId,
        quote_token: TokenId,
    ) {
        let src = msg::source();
        debug!(
            "OrderBook::place_order_eth msg::source={:?} user={:?}",
            src, user
        );
        self.ensure_eth_caller();
        let trader = eth_to_actor(user);
        self.place_order_internal(trader, price, quantity, is_buy, base_token, quote_token)
            .await;
    }

    async fn cancel_order_internal(
        &mut self,
        caller: TraderId,
        order_id: OrderId,
        base_token: TokenId,
        quote_token: TokenId,
    ) {
        let state = OrderBookState::get_mut();

        let idx = *state.order_indices.get(&order_id).expect("OrderNotFound");
        let node = state.arena.get(idx).expect("OrderNodeNotFound");
        let order = node.order.clone();

        if order.trader != caller {
            core::panic!("Unauthorized");
        }

        // Remove from book
        let queue = match order.side {
            Side::Buy => state.bids.get_mut(&order.price),
            Side::Sell => state.asks.get_mut(&order.price),
        };

        if let Some(q) = queue {
            q.remove(&mut state.arena, idx);
            if q.head.is_none() {
                match order.side {
                    Side::Buy => {
                        state.bids.remove(&order.price);
                    }
                    Side::Sell => {
                        state.asks.remove(&order.price);
                    }
                }
            }
        }

        state.order_indices.remove(&order_id);

        // Unlock Funds
        let price_scale = self.market_scale_value(base_token, quote_token);
        if price_scale == 0 {
            panic!("InvalidPriceScale");
        }
        let (unlock_amount, unlock_token) = match order.side {
            Side::Buy => (
                mul_div_ceil(order.price, order.quantity, price_scale),
                quote_token,
            ),
            Side::Sell => (order.quantity, base_token),
        };

        let vault_id = state.vault_id;
        let payload = VaultUnlockFunds::encode_params_with_prefix(
            "Vault",
            caller,
            unlock_token,
            unlock_amount,
        );

        msg::send_bytes_for_reply(vault_id, payload, 0)
            .expect("SendFailed")
            .await
            .expect("UnlockFailed");

        self.emit_eth_event(Events::OrderCanceled { order_id })
            .unwrap();
        let mut emitter = self.emitter();
        emitter
            .emit_event(Events::OrderCanceled { order_id })
            .unwrap();
    }

    #[export]
    pub async fn cancel_order(
        &mut self,
        order_id: OrderId,
        base_token: TokenId,
        quote_token: TokenId,
    ) {
        let caller = Self::caller_trader();
        self.cancel_order_internal(caller, order_id, base_token, quote_token)
            .await;
    }

    #[export]
    pub async fn cancel_order_eth(
        &mut self,
        user: EthAddress,
        order_id: OrderId,
        base_token: TokenId,
        quote_token: TokenId,
    ) {
        self.ensure_eth_caller();
        let caller = eth_to_actor(user);
        self.cancel_order_internal(caller, order_id, base_token, quote_token)
            .await;
    }

    #[export]
    pub async fn continue_matching(&mut self, base_token: TokenId, quote_token: TokenId) {
        let program_id = sails_rs::gstd::exec::program_id();
        if msg::source() != program_id {
            // Only allow self-calls
            return;
        }
        let _ = self.match_orders(base_token, quote_token).await;
    }

    async fn match_orders(&mut self, base_token: TokenId, quote_token: TokenId) -> Result<(), ()> {
        let mut matches_count = 0;
        const MAX_MATCHES: u32 = 50;
        let price_scale = self.market_scale_value(base_token, quote_token);
        if price_scale == 0 {
            panic!("InvalidPriceScale");
        }

        loop {
            if matches_count >= MAX_MATCHES {
                debug!("OrderBook: Max matches reached, triggering ContinueMatching.");

                // Send deferred matching message to Self
                let payload = ("OrderBook", "ContinueMatching", (base_token, quote_token));

                // We use send (not send_for_reply) because we don't need to wait for it here
                // Note: sails routing expects Service/Method/Args tuple.
                // Since we are inside the same program, we can address Self.
                let program_id = sails_rs::gstd::exec::program_id();
                msg::send(program_id, payload, 0).expect("Failed to send ContinueMatching");

                break;
            }

            let match_data = {
                let state = OrderBookState::get_mut();

                let best_bid_entry = state.bids.iter_mut().next_back();
                let best_ask_entry = state.asks.iter_mut().next();

                if let (Some((bid_price, bids_queue)), Some((ask_price, asks_queue))) =
                    (best_bid_entry, best_ask_entry)
                {
                    if *bid_price >= *ask_price {
                        let bid_order = Self::peek_first_order(bids_queue, &state.arena);
                        let ask_order = Self::peek_first_order(asks_queue, &state.arena);

                        if let (Some(bid_order), Some(ask_order)) = (bid_order, ask_order) {
                            Some((*bid_price, *ask_price, bid_order, ask_order))
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                } else {
                    None
                }
            };

            if let Some((_bid_price, _ask_price, bid_order, ask_order)) = match_data {
                let trade_price = if bid_order.id < ask_order.id {
                    bid_order.price // Maker price (Bid)
                } else {
                    ask_order.price // Maker price (Ask)
                };

                let trade_quantity = core::cmp::min(bid_order.quantity, ask_order.quantity);
                let cost = mul_div_ceil(trade_price, trade_quantity, price_scale);
                let fee = cost.checked_mul(FEE_RATE_BPS).expect("MathOverflow") / 10000;
                debug!(
                    "OrderBook: match_orders price={} qty={} cost={} fee={}",
                    trade_price, trade_quantity, cost, fee
                );

                let state = OrderBookState::get_mut();
                let vault_id = state.vault_id;

                let payload = VaultSettleTrade::encode_params_with_prefix(
                    "Vault",
                    bid_order.trader,
                    ask_order.trader,
                    base_token,
                    quote_token,
                    trade_price,
                    trade_quantity,
                    fee,
                    price_scale,
                );

                msg::send_bytes_for_reply(vault_id, payload, 0)
                    .expect("SendFailed")
                    .await
                    .expect("SettleFailed");

                // Price improvement for Taker Buyer
                if bid_order.id > ask_order.id && trade_price < bid_order.price {
                    let improvement_per_unit = bid_order
                        .price
                        .checked_sub(trade_price)
                        .expect("MathUnderflow");
                    let total_improvement =
                        mul_div_ceil(improvement_per_unit, trade_quantity, price_scale);
                    if total_improvement > 0 {
                        let unlock_payload = VaultUnlockFunds::encode_params_with_prefix(
                            "Vault",
                            bid_order.trader,
                            quote_token,
                            total_improvement,
                        );
                        msg::send_bytes_for_reply(vault_id, unlock_payload, 0)
                            .expect("SendFailed")
                            .await
                            .expect("UnlockImprovementFailed");
                    }
                }

                let maker_order_id = if bid_order.id < ask_order.id {
                    bid_order.id
                } else {
                    ask_order.id
                };
                let taker_order_id = if bid_order.id < ask_order.id {
                    ask_order.id
                } else {
                    bid_order.id
                };
                let maker_actor = if bid_order.id < ask_order.id {
                    bid_order.trader
                } else {
                    ask_order.trader
                };
                let taker_actor = if bid_order.id < ask_order.id {
                    ask_order.trader
                } else {
                    bid_order.trader
                };

                self.emit_eth_event(Events::TradeExecuted {
                    maker_order_id,
                    taker_order_id,
                    price: trade_price,
                    quantity: trade_quantity,
                    maker: actor_eth_bytes(maker_actor),
                    taker: actor_eth_bytes(taker_actor),
                })
                .unwrap();
                let mut emitter = self.emitter();
                emitter
                    .emit_event(Events::TradeExecuted {
                        maker_order_id,
                        taker_order_id,
                        price: trade_price,
                        quantity: trade_quantity,
                        maker: actor_bytes(maker_actor),
                        taker: actor_bytes(taker_actor),
                    })
                    .unwrap();

                matches_count += 1;

                let state = OrderBookState::get_mut();

                // Update orders in arena
                let mut bid_filled = false;
                let mut ask_filled = false;

                if let Some(idx) = state.order_indices.get(&bid_order.id).copied() {
                    if let Some(node) = state.arena.get_mut(idx) {
                        node.order.quantity -= trade_quantity;
                        if node.order.quantity == 0 {
                            bid_filled = true;
                        }
                    }
                }

                if let Some(idx) = state.order_indices.get(&ask_order.id).copied() {
                    if let Some(node) = state.arena.get_mut(idx) {
                        node.order.quantity -= trade_quantity;
                        if node.order.quantity == 0 {
                            ask_filled = true;
                        }
                    }
                }

                if bid_filled {
                    if let Some(idx) = state.order_indices.remove(&bid_order.id) {
                        if let Some(queue) = state.bids.get_mut(&bid_order.price) {
                            queue.remove(&mut state.arena, idx);
                            if queue.head.is_none() {
                                state.bids.remove(&bid_order.price);
                            }
                        }
                    }
                }

                if ask_filled {
                    if let Some(idx) = state.order_indices.remove(&ask_order.id) {
                        if let Some(queue) = state.asks.get_mut(&ask_order.price) {
                            queue.remove(&mut state.arena, idx);
                            if queue.head.is_none() {
                                state.asks.remove(&ask_order.price);
                            }
                        }
                    }
                }
            } else {
                break;
            }
        }
        Ok(())
    }
}
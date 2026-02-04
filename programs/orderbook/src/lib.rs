#![no_std]

extern crate alloc;

pub mod state;
pub mod varint;

use clob_common::{
    eth_to_actor, mul_div_ceil, EthAddress, Order, OrderId, Price, Quantity, Side, TokenId,
    TraderId, DEFAULT_PRICE_SCALE, FEE_RATE_BPS,
};
use sails_rs::{
    collections::{BTreeMap, HashMap},
    gstd::{debug, msg},
    prelude::*,
};
use state::arena::{Arena, Index};
use state::linked_list::{OrderNode, OrderQueue};
use varint::VarintWriter;

pub const MATCH_GAS_THRESHOLD: u64 = 300_000_000;

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
    Deposit {
        user: [u8; 32],
        token: TokenId,
        amount: u128,
    },
    Withdrawal {
        user: [u8; 32],
        token: TokenId,
        amount: u128,
    },
    TradesExecuted {
        count: u32,
        // Header: [taker (32 bytes)]
        // Body: [Varint Encoded (maker_id, taker_id, price, quantity)...]
        data: Vec<u8>,
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
    pub balances: HashMap<ActorId, HashMap<TokenId, u128>>,
    pub treasury: HashMap<TokenId, u128>,
    pub pending_withdrawals: HashMap<ActorId, HashMap<TokenId, u128>>,
    pub paused: bool,
    pub program_id: ActorId,
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

fn reply_ok() {
    msg::reply((), 0).expect("ReplyFailed");
}

pub struct OrderBookProgram;

#[program]
impl OrderBookProgram {
    #[export]
    pub fn create(vault_id: ActorId) -> Self {
        let state = OrderBookState::get_mut();
        state.vault_id = vault_id;
        state.admin = Some(msg::source());
        state.program_id = sails_rs::gstd::exec::program_id();
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

    fn ensure_not_paused(&self) {
        let state = OrderBookState::get_mut();
        if state.paused && state.admin != Some(msg::source()) {
            panic!("ProgramPaused");
        }
    }

    #[export]
    pub fn debug_seed_orders(&mut self, count: u64, price: u128) {
        let state = OrderBookState::get_mut();
        let source = Self::caller_trader();

        for _ in 0..count {
            state.order_counter += 1;
            let order_id = state.order_counter;

            let order = Order {
                id: order_id,
                trader: source,
                side: Side::Sell,
                price,
                quantity: 1_000_000, // 1 * DECIMALS
                created_at: 0,
            };

            // Directly insert to queue
            let queue = state.asks.entry(order.price).or_default();
            let idx = queue.push_back(&mut state.arena, order);
            state.order_indices.insert(order_id, idx);
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

    #[export]
    pub fn deposit(&mut self, user: ActorId, token: TokenId, amount: u128) {
        let state = OrderBookState::get_mut();
        if msg::source() != state.vault_id {
            panic!("Unauthorized: Only Vault can deposit");
        }
        let user_balances = state.balances.entry(user).or_default();
        let balance = user_balances.entry(token).or_default();
        *balance = balance.checked_add(amount).expect("MathOverflow");

        let mut emitter = self.emitter();
        emitter
            .emit_event(Events::Deposit {
                user: actor_bytes(user),
                token,
                amount,
            })
            .unwrap();

        reply_ok();
    }

    #[export]
    pub async fn withdraw_to_vault(&mut self, token: TokenId, amount: u128) {
        self.ensure_not_paused();
        let trader = Self::caller_trader();
        let state = OrderBookState::get_mut();

        let user_balances = state.balances.get_mut(&trader).expect("UserNotFound");
        let balance = user_balances.get_mut(&token).expect("TokenNotFound");

        if *balance < amount {
            panic!("InsufficientBalance");
        }

        // 1. Move to pending
        *balance = balance.checked_sub(amount).expect("MathOverflow");
        let pending = state
            .pending_withdrawals
            .entry(trader)
            .or_default()
            .entry(token)
            .or_default();
        *pending = pending.checked_add(amount).expect("MathOverflow");

        let vault_id = state.vault_id;
        let payload = ("Vault", "VaultDeposit", (trader, token, amount)).encode();

        let reply_result = msg::send_bytes_for_reply(vault_id, payload, 0);

        if let Err(e) = reply_result {
            debug!("OrderBook: Failed to send Withdrawal message: {:?}", e);
            // Revert pending
            *balance = balance.checked_add(amount).expect("MathOverflow");
            if let Some(user_pending) = state.pending_withdrawals.get_mut(&trader) {
                if let Some(token_pending) = user_pending.get_mut(&token) {
                    *token_pending = token_pending.saturating_sub(amount);
                }
            }
            return;
        }

        let res = reply_result.unwrap().await;

        let state = OrderBookState::get_mut();
        // 2. Remove from pending regardless of outcome
        if let Some(user_pending) = state.pending_withdrawals.get_mut(&trader) {
            if let Some(token_pending) = user_pending.get_mut(&token) {
                *token_pending = token_pending.saturating_sub(amount);
            }
        }

        if res.is_ok() {
            // 3a. Success: Emit event
            let mut emitter = self.emitter();
            emitter
                .emit_event(Events::Withdrawal {
                    user: actor_bytes(trader),
                    token,
                    amount,
                })
                .unwrap();
        } else {
            // 3b. Failure: Revert from pending to available
            let user_balances = state.balances.entry(trader).or_default();
            let bal = user_balances.entry(token).or_default();
            *bal = bal.checked_add(amount).expect("MathOverflow");

            debug!("OrderBook: Withdrawal to Vault failed, funds reverted to local balance.");
        }

        reply_ok();
    }

    #[export]
    pub fn get_balance(&self, user: ActorId, token: TokenId) -> u128 {
        let state = OrderBookState::get_mut();
        state
            .balances
            .get(&user)
            .and_then(|m| m.get(&token))
            .copied()
            .unwrap_or(0)
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

        // 2. Reserve Funds (Internal)
        let state = OrderBookState::get_mut();
        let user_balances = state.balances.entry(trader).or_default();
        let balance = user_balances.entry(required_token).or_default();

        if *balance < required_amount {
            panic!(
                "InsufficientBalance: Required {}, available {}",
                required_amount, *balance
            );
        }

        *balance = balance.checked_sub(required_amount).expect("MathOverflow");

        // 3. Add Order to Book
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
        self.ensure_not_paused();
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
        self.ensure_not_paused();
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

        // 2. Return Funds (Internal)
        let price_scale = self.market_scale_value(base_token, quote_token);
        let (unlock_amount, unlock_token) = match order.side {
            Side::Buy => (
                mul_div_ceil(order.price, order.quantity, price_scale),
                quote_token,
            ),
            Side::Sell => (order.quantity, base_token),
        };

        let state = OrderBookState::get_mut();
        let user_balances = state.balances.entry(order.trader).or_default();
        let balance = user_balances.entry(unlock_token).or_default();
        *balance = balance.checked_add(unlock_amount).expect("MathOverflow");

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
        let state = OrderBookState::get_mut(); // Access state to get cached ID
        let program_id = state.program_id;
        if msg::source() != program_id {
            // Only allow self-calls
            return;
        }
        let _ = self.match_orders(base_token, quote_token).await;
    }

    async fn match_orders(&mut self, base_token: TokenId, quote_token: TokenId) -> Result<(), ()> {
        let price_scale = self.market_scale_value(base_token, quote_token);
        if price_scale == 0 {
            panic!("InvalidPriceScale");
        }

        let state = OrderBookState::get_mut();
        let mut batch_treasury_updates: HashMap<TokenId, u128> = HashMap::new();
        let mut batch_balance_updates: HashMap<ActorId, HashMap<TokenId, u128>> = HashMap::new();

        // Batched byte buffer
        let mut batch_count: u32 = 0;
        let mut batch_writer = VarintWriter::with_capacity(4096);
        let mut batch_taker = [0u8; 32]; // Single taker

        let mut loop_counter: u32 = 0;
        loop {
            // Check remaining gas every 20 iterations
            loop_counter += 1;
            if loop_counter >= 20 {
                loop_counter = 0;
                if sails_rs::gstd::exec::gas_available() < MATCH_GAS_THRESHOLD {
                    debug!("OrderBook: Gas low, triggering continue_matching.");
                    // Commit batched updates before breaking
                    for (token, amount) in batch_treasury_updates {
                        let tr = state.treasury.entry(token).or_default();
                        *tr = tr.checked_add(amount).expect("MathOverflow");
                    }
                    for (user, tokens) in batch_balance_updates {
                        let user_bal = state.balances.entry(user).or_default();
                        for (token, amount) in tokens {
                            let b = user_bal.entry(token).or_default();
                            *b = b.checked_add(amount).expect("MathOverflow");
                        }
                    }

                    if batch_count > 0 {
                        let mut emitter = self.emitter();
                        emitter
                            .emit_event(Events::TradesExecuted {
                                count: batch_count,
                                data: batch_writer.buf.clone(),
                            })
                            .unwrap();
                        // Reset batch
                        batch_count = 0;
                        batch_writer.buf.clear();
                    }

                    let payload = ("OrderBook", "ContinueMatching", (base_token, quote_token));
                    let program_id = state.program_id;
                    msg::send(program_id, payload, 0).expect("Failed to send ContinueMatching");
                    break;
                }
            }

            let match_data = {
                let best_bid_entry = state.bids.iter_mut().next_back();
                let best_ask_entry = state.asks.iter_mut().next();

                if let (Some((bid_price, bids_queue)), Some((ask_price, asks_queue))) =
                    (best_bid_entry, best_ask_entry)
                {
                    if *bid_price >= *ask_price {
                        let bid_order = bids_queue.iter(&state.arena).next().cloned();
                        let ask_order = asks_queue.iter(&state.arena).next().cloned();

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

                // --- Internal Settlement ---

                // 1. Maker/Taker roles
                let (maker, taker, maker_side) = if bid_order.id < ask_order.id {
                    (bid_order.trader, ask_order.trader, Side::Buy)
                } else {
                    (ask_order.trader, bid_order.trader, Side::Sell)
                };

                // 2. Update Maker Balance
                let (received_token, received_amount) = match maker_side {
                    Side::Buy => (base_token, trade_quantity),
                    Side::Sell => (quote_token, cost.checked_sub(fee).expect("MathOverflow")),
                };
                {
                    let user_bal = batch_balance_updates.entry(maker).or_default();
                    let b = user_bal.entry(received_token).or_default();
                    *b = b.checked_add(received_amount).expect("MathOverflow");
                }

                if matches!(maker_side, Side::Sell) && fee > 0 {
                    let tr = batch_treasury_updates.entry(quote_token).or_default();
                    *tr = tr.checked_add(fee).expect("MathOverflow");
                }

                // 3. Update Taker Balance
                let (t_received_token, t_received_amount) = match maker_side {
                    Side::Buy => (quote_token, cost.checked_sub(fee).expect("MathOverflow")), // Taker is Seller
                    Side::Sell => (base_token, trade_quantity), // Taker is Buyer
                };
                {
                    let user_bal = batch_balance_updates.entry(taker).or_default();
                    let b = user_bal.entry(t_received_token).or_default();
                    *b = b.checked_add(t_received_amount).expect("MathOverflow");
                }

                if matches!(maker_side, Side::Buy) && fee > 0 {
                    let tr = batch_treasury_updates.entry(quote_token).or_default();
                    *tr = tr.checked_add(fee).expect("MathOverflow");
                }

                // 4. Price improvement for Taker Buyer
                if bid_order.id > ask_order.id && trade_price < bid_order.price {
                    let improvement_per_unit = bid_order
                        .price
                        .checked_sub(trade_price)
                        .expect("MathUnderflow");
                    let total_improvement =
                        mul_div_ceil(improvement_per_unit, trade_quantity, price_scale);
                    if total_improvement > 0 {
                        let user_bal = batch_balance_updates.entry(bid_order.trader).or_default();
                        let b = user_bal.entry(quote_token).or_default();
                        *b = b.checked_add(total_improvement).expect("MathOverflow");
                    }
                }
                // --- End Internal Settlement ---

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
                let (_maker_actor, taker_actor) = if bid_order.id < ask_order.id {
                    (bid_order.trader, ask_order.trader)
                } else {
                    (ask_order.trader, bid_order.trader)
                };

                let taker_bytes = actor_bytes(taker_actor);

                // Flush if taker changes
                if batch_count > 0 && batch_taker != taker_bytes {
                    let mut emitter = self.emitter();
                    emitter
                        .emit_event(Events::TradesExecuted {
                            count: batch_count,
                            data: batch_writer.buf.clone(),
                        })
                        .unwrap();
                    batch_count = 0;
                    batch_writer.buf.clear();
                }

                if batch_count == 0 {
                    batch_taker = taker_bytes;
                    // Write Header: Taker (32 bytes)
                    batch_writer.write_bytes(&batch_taker);
                }

                batch_writer.write_u128(maker_order_id);
                batch_writer.write_u128(taker_order_id);
                batch_writer.write_u128(trade_price);
                batch_writer.write_u128(trade_quantity);
                batch_count += 1;

                // Threshold check: roughly 200 items or 4KB
                if batch_count >= 250 || batch_writer.buf.len() > 3000 {
                    let mut emitter = self.emitter();
                    emitter
                        .emit_event(Events::TradesExecuted {
                            count: batch_count,
                            data: batch_writer.buf.clone(),
                        })
                        .unwrap();
                    batch_count = 0;
                    batch_writer.buf.clear();
                }

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
                // No more matches, commit treasury updates
                for (token, amount) in batch_treasury_updates {
                    let tr = state.treasury.entry(token).or_default();
                    *tr = tr.checked_add(amount).expect("MathOverflow");
                }
                for (user, tokens) in batch_balance_updates {
                    let user_bal = state.balances.entry(user).or_default();
                    for (token, amount) in tokens {
                        let b = user_bal.entry(token).or_default();
                        *b = b.checked_add(amount).expect("MathOverflow");
                    }
                }
                break;
            }
        }

        // Flush remaining trades in batch
        if batch_count > 0 {
            let mut emitter = self.emitter();
            emitter
                .emit_event(Events::TradesExecuted {
                    count: batch_count,
                    data: batch_writer.buf.clone(),
                })
                .unwrap();
        }
        Ok(())
    }

    #[export]
    pub fn pause(&mut self, paused: bool) {
        self.ensure_admin();
        OrderBookState::get_mut().paused = paused;
    }

    /// Registers an emergency exit for a user.
    ///
    /// This function reduces the user's internal balance and emits a Withdrawal event,
    /// but it does NOT transfer any funds out of the contract.
    /// It is intended to be used when the contract is paused, allowing users to signal
    /// their intent to withdraw so that an off-chain process or migration utility can
    /// reimburse them or migrate their funds.
    #[export]
    pub fn register_emergency_exit(&mut self, token: TokenId, amount: u128) {
        let state = OrderBookState::get_mut();
        if !state.paused {
            panic!("OnlyInPausedState");
        }
        let trader = Self::caller_trader();
        let user_balances = state.balances.get_mut(&trader).expect("UserNotFound");
        let balance = user_balances.get_mut(&token).expect("TokenNotFound");

        if *balance < amount {
            panic!("InsufficientBalance");
        }

        *balance = balance.checked_sub(amount).expect("MathOverflow");

        // Emergency withdraw just emits event and updates internal state.
        // In a real scenario, this might send to an "Emergency Vault" or simply
        // leave the funds in a state where a separate migration program can claim them.
        // For now, we'll emit a Withdrawal event.
        let mut emitter = self.emitter();
        emitter
            .emit_event(Events::Withdrawal {
                user: actor_bytes(trader),
                token,
                amount,
            })
            .unwrap();
        reply_ok();
    }
}

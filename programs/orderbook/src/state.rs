use clob_common::TokenId;
use sails_rs::{collections::HashMap, prelude::*, U256};

use matching_engine::{
    Completion, EngineLimits, ExecutionReport, IncomingOrder, OrderId, OrderKind, Side, Trade,
};

use crate::orderbook::OrderBook;

/// TEMPORARY ABI workaround.
///
/// We currently cannot expose `Side` and `OrderKind` (and/or other rich types like `U256`) directly
/// through exported contract methods due to interface/codec constraints.
pub type SideIO = u16;
pub type OrderKindIO = u16;
const MAX_EXECUTED_TRADE_HISTORY: usize = 512;
const MAX_RECORDED_TRADES_PER_EXECUTION: usize = 32;

pub fn side_from_io(x: SideIO) -> Side {
    match x {
        0 => Side::Buy,
        1 => Side::Sell,
        _ => panic!("Invalid side"),
    }
}

pub fn kind_from_io(x: OrderKindIO) -> OrderKind {
    match x {
        0 => OrderKind::Limit,
        1 => OrderKind::Market,
        2 => OrderKind::FillOrKill,
        3 => OrderKind::ImmediateOrCancel,
        _ => panic!("Invalid kind"),
    }
}

#[derive(Clone, Debug, Default)]
pub struct AccountBalances {
    pub base: U256,
    pub quote: U256,
}

#[derive(Clone, Debug)]
pub struct ExecutedTrade {
    pub seq: u64,
    pub maker_order_id: OrderId,
    pub taker_order_id: OrderId,
    pub maker: ActorId,
    pub taker: ActorId,
    pub price: u128,
    pub amount_base: u128,
    pub amount_quote: u128,
}

#[derive(Default, Debug)]
pub struct State {
    pub admin: Option<ActorId>,
    pub next_order_id: OrderId,
    pub next_trade_seq: u64,
    pub limits: EngineLimits,
    pub book: OrderBook,
    pub balances: HashMap<ActorId, AccountBalances>,
    pub executed_trades: Vec<ExecutedTrade>,
    pub protocol_fee_quote: U256,
    pub base_token_id: TokenId,
    pub quote_token_id: TokenId,
    pub base_vault_id: ActorId,
    pub quote_vault_id: ActorId,
}

#[derive(Debug, Clone, Copy)]
pub enum Asset {
    Base,
    Quote,
}

impl State {
    pub fn new(
        admin: ActorId,
        base_vault_id: ActorId,
        quote_vault_id: ActorId,
        base_token_id: TokenId,
        quote_token_id: TokenId,
        max_trades: u32,
        max_preview_scans: u32,
    ) -> Self {
        Self {
            admin: Some(admin),
            next_order_id: 1,
            next_trade_seq: 1,
            limits: EngineLimits {
                max_trades,
                max_preview_scans,
            },
            book: OrderBook::new(),
            balances: HashMap::with_capacity(100_000),
            executed_trades: Vec::new(),
            protocol_fee_quote: U256::zero(),
            base_token_id,
            quote_token_id,
            base_vault_id,
            quote_vault_id,
        }
    }

    pub fn alloc_order_id(&mut self) -> OrderId {
        let id = self.next_order_id;
        self.next_order_id = self.next_order_id.saturating_add(1);
        id
    }

    pub fn balance_mut(&mut self, who: ActorId) -> &mut AccountBalances {
        self.balances.entry(who).or_default()
    }

    pub fn append_executed_trades(&mut self, trades: &[Trade]) {
        if trades.len() > MAX_RECORDED_TRADES_PER_EXECUTION {
            return;
        }

        for tr in trades {
            let seq = self.next_trade_seq;
            self.next_trade_seq = self.next_trade_seq.saturating_add(1);

            self.executed_trades.push(ExecutedTrade {
                seq,
                maker_order_id: tr.maker_order_id,
                taker_order_id: tr.taker_order_id,
                maker: tr.maker,
                taker: tr.taker,
                price: tr.price.low_u128(),
                amount_base: tr.amount_base.low_u128(),
                amount_quote: tr.amount_quote.low_u128(),
            });

            if self.executed_trades.len() > MAX_EXECUTED_TRADE_HISTORY {
                let _ = self.executed_trades.remove(0);
            }
        }
    }

    fn lock(&mut self, who: ActorId, asset: Asset, amount: U256) {
        if amount.is_zero() {
            return;
        }
        let b = self.balance_mut(who);
        match asset {
            Asset::Base => b.base = b.base.checked_sub(amount).expect("insufficient base"),
            Asset::Quote => b.quote = b.quote.checked_sub(amount).expect("insufficient quote"),
        }
    }

    pub fn unlock(&mut self, who: ActorId, asset: Asset, amount: U256) {
        if amount.is_zero() {
            return;
        }
        let b = self.balance_mut(who);
        match asset {
            Asset::Base => b.base = b.base.checked_add(amount).expect("base overflow"),
            Asset::Quote => b.quote = b.quote.checked_add(amount).expect("quote overflow"),
        }
    }

    pub fn deposit(&mut self, who: ActorId, asset: Asset, amount: U256) {
        self.unlock(who, asset, amount);
    }

    pub fn withdraw(&mut self, who: ActorId, asset: Asset, amount: U256) {
        self.lock(who, asset, amount);
    }

    pub fn lock_taker_funds(&mut self, order: &IncomingOrder) -> (U256, U256) {
        match order.side {
            Side::Sell => {
                self.lock(order.owner, Asset::Base, order.amount_base);
                (order.amount_base, U256::zero())
            }
            Side::Buy => {
                let lock_quote = match order.kind {
                    OrderKind::Market => order.max_quote,
                    _ => matching_engine::calc_quote_ceil(order.amount_base, order.limit_price)
                        .expect("Math error"),
                };
                self.lock(order.owner, Asset::Quote, lock_quote);
                (U256::zero(), lock_quote)
            }
        }
    }

    pub fn settle_execution(
        &mut self,
        order: &IncomingOrder,
        rep: &ExecutionReport,
        locked_base: U256,
        locked_quote: U256,
    ) {
        let taker_side = order.side;
        let maker_side = order.side.opposite();

        let mut taker_spent_quote = U256::zero();
        let mut taker_spent_base = U256::zero();
        // 1) Apply trades: credit balances
        for tr in &rep.trades {
            match taker_side {
                Side::Buy => {
                    taker_spent_quote = taker_spent_quote
                        .checked_add(tr.amount_quote)
                        .expect("quote add overflow");
                }
                Side::Sell => {
                    taker_spent_base = taker_spent_base
                        .checked_add(tr.amount_base)
                        .expect("quote add overflow");
                }
            }

            // credit taker receive
            match taker_side {
                Side::Buy => self.unlock(tr.taker, Asset::Base, tr.amount_base),
                Side::Sell => self.unlock(tr.taker, Asset::Quote, tr.amount_quote),
            }

            // credit maker receive
            match maker_side {
                Side::Sell => self.unlock(tr.maker, Asset::Quote, tr.amount_quote),
                Side::Buy => self.unlock(tr.maker, Asset::Base, tr.amount_base),
            }
        }

        // 2) Refund/unlock taker leftovers
        match rep.completion {
            Completion::Rejected => {
                // FOK fail => orderbook wasn't mutated => unlock
                self.unlock(order.owner, Asset::Base, locked_base);
                self.unlock(order.owner, Asset::Quote, locked_quote);
            }

            Completion::Cancelled { remaining_base } => match taker_side {
                Side::Sell => {
                    // SELL: unlock remaining base
                    self.unlock(order.owner, Asset::Base, remaining_base);
                }
                Side::Buy => {
                    // BUY: refund = locked_quote - spent_quote
                    let refund = locked_quote
                        .checked_sub(taker_spent_quote)
                        .expect("refund underflow");
                    self.unlock(order.owner, Asset::Quote, refund);
                }
            },

            Completion::Filled => {
                // BUY: dust because ceil lock vs floor fills
                if taker_side == Side::Buy {
                    let extra = locked_quote
                        .checked_sub(taker_spent_quote)
                        .expect("extra underflow");
                    self.unlock(order.owner, Asset::Quote, extra);
                }
            }

            Completion::Placed {
                remaining_base: _,
                remaining_quote,
            } => match taker_side {
                Side::Sell => {
                    // Remaining base is now a resting SELL order => stays locked.
                    // Sold base is already deducted by the original lock.
                    // => refund nothing
                }
                Side::Buy => {
                    // Remaining quote stays reserved in the resting BUY order.
                    // Refund anything beyond spent + remaining reserved.
                    let used = taker_spent_quote
                        .checked_add(remaining_quote)
                        .expect("used overflow");
                    let extra = locked_quote.checked_sub(used).expect("extra underflow");
                    self.unlock(order.owner, Asset::Quote, extra);
                }
            },
        }
    }
}

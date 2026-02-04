use sails_rs::{prelude::*, U256};

pub type OrderId = u64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum Side {
    Buy,
    Sell,
}

impl Side {
    pub fn opposite(self) -> Side {
        match self {
            Side::Buy => Side::Sell,
            Side::Sell => Side::Buy,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum OrderKind {
    Limit,
    Market,
    FillOrKill,
    ImmediateOrCancel,
}

/// Incoming (taker) order.
/// For Market orders, `limit_price` is ignored.
#[derive(Debug, Clone, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct IncomingOrder {
    pub id: OrderId,
    pub side: Side,
    pub kind: OrderKind,
    pub limit_price: U256,
    pub amount_base: U256,
    pub owner: ActorId,
    // budget for Market BUY (else 0)
    pub max_quote: U256,
}

/// Minimal view of a resting (maker) order stored in the book.
#[derive(Debug, Clone, Copy)]
pub struct MakerView {
    pub id: OrderId,
    pub owner: ActorId,
    pub side: Side,
    pub price: U256,
    pub remaining_base: U256,
    /// For maker BUY orders: remaining reserved quote in escrow (to refund on cancel).
    /// For maker SELL orders: must be 0.
    pub reserved_quote: U256,
}

/// Remainder that should be inserted as a resting order (Limit only).
#[derive(Debug, Clone)]
pub struct RestingOrder {
    pub id: OrderId,
    pub owner: ActorId,
    pub side: Side,
    pub price: U256,
    pub remaining_base: U256,
    pub remaining_quote: U256,
}

/// Trade (fill) produced by matching.
#[derive(Debug, Clone, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct Trade {
    pub maker_order_id: OrderId,
    pub taker_order_id: OrderId,
    pub maker: ActorId,
    pub taker: ActorId,
    pub price: U256,
    pub amount_base: U256,
    pub amount_quote: U256,
}

#[derive(Default, Debug, Clone, Copy, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct EngineLimits {
    pub max_trades: u32,
    pub max_preview_scans: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum Completion {
    Filled,
    /// FOK fail: no book mutation
    Rejected,
    /// Remainder cancelled (Market/IOC)
    Cancelled {
        remaining_base: U256,
    },
    /// Limit remainder inserted as resting
    Placed {
        remaining_base: U256,
        remaining_quote: U256,
    },
}

#[derive(Debug, Clone, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct ExecutionReport {
    pub trades: Vec<Trade>,
    pub completion: Completion,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MatchError {
    InvalidOrder(InvalidOrderReason),
    MulOverflow,
    AddOverflow,
    SubUnderflow,
    MarketBuyInsufficientLiquidity,
    MarketBuyBudgetCheckInconsistent,
    MarketBuyLiquidityCheckInconsistent,
    MarketBuyMaxQuoteExceeded,

    BrokenBook(BookInvariant),

    FokCheckInconsistent,
    TradeLimitReached { max_trades: u32 },
    ScanLimitReached { max_scanned: u32 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BookInvariant {
    BestPriceHasNoHead,
    LevelHeadMissingMaker,
    NextInLevelMissingMaker,
    MakerSideMismatch,
    MakerPriceMismatch,
    NextPriceDidNotAdvance,
    NextInLevelSelfLoop,
    MakerZeroRemaining,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InvalidOrderReason {
    ZeroAmountBase,
    ZeroLimitPriceForNonMarket,
    PreviewOnlyForFok,
    FokRequiresLimitPrice,
    ZeroMaxQuoteForMarketBuy,
    MaxQuoteOnlyForMarketBuy,
    PreviewOnlyForMarketBuyBudget,
    MarketBuyMaxQuoteExceeded,
}

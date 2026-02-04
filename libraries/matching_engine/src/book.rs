use sails_rs::U256;

use crate::types::{MakerView, RestingOrder, Side};

/// Book interface required by the matching engine.
pub trait Book {
    /// Handle is typically `Index` from intrusive arena.
    type Handle: Copy + Eq;

    /// Best price on maker side (opposite of taker):
    /// - maker Sell (asks): lowest price
    /// - maker Buy  (bids): highest price
    fn best_price(&self, maker_side: Side) -> Option<U256>;

    /// Next worse price after `price` on maker side.
    /// - asks: next higher price
    /// - bids: next lower price
    fn next_price(&self, maker_side: Side, price: U256) -> Option<U256>;

    /// FIFO head at a given price level.
    fn level_head(&self, maker_side: Side, price: U256) -> Option<Self::Handle>;

    /// Next order within the SAME price level (FIFO).
    fn next_in_level(&self, h: Self::Handle) -> Option<Self::Handle>;

    /// Read maker fields.
    fn get_maker(&self, h: Self::Handle) -> Option<MakerView>;

    /// Update maker remaining (partial fill).
    fn set_maker_remaining(&mut self, h: Self::Handle, new_remaining_base: U256);

    /// Update maker reserved quote (for buy orders)
    fn set_maker_reserved_quote(&mut self, h: Self::Handle, new_reserved_quote: U256);

    /// Remove maker (full fill).
    fn remove_maker(&mut self, h: Self::Handle);

    /// Insert Limit remainder as a resting order.
    fn insert_resting(&mut self, o: RestingOrder);
}

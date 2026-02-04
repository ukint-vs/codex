use sails_rs::{
    collections::BTreeMap,
    ops::Bound::{Excluded, Unbounded},
    U256,
};

use intrusive_arena::{Arena, Index, List, Node};

use matching_engine::{Book, MakerView, OrderId, RestingOrder, Side};

#[derive(Debug, Default)]
struct PriceLevel {
    // FIFO via intrusive list
    fifo: List,
}

#[derive(Debug, Default)]
pub struct OrderBook {
    arena: Arena<Node<MakerView>>,
    // maker Side::Buy
    bids: BTreeMap<U256, PriceLevel>,
    // maker Side::Sell
    asks: BTreeMap<U256, PriceLevel>,
    // for cancel
    by_id: BTreeMap<OrderId, Index>,
}

impl OrderBook {
    pub fn new() -> Self {
        Self::default()
    }

    fn side_map(&self, side: Side) -> &BTreeMap<U256, PriceLevel> {
        match side {
            Side::Buy => &self.bids,
            Side::Sell => &self.asks,
        }
    }

    pub fn push_maker(&mut self, maker: MakerView) -> Index {
        let side = maker.side;
        let price = maker.price;

        let (map, arena, by_id) = match side {
            Side::Buy => (&mut self.bids, &mut self.arena, &mut self.by_id),
            Side::Sell => (&mut self.asks, &mut self.arena, &mut self.by_id),
        };

        let level = map.entry(price).or_insert_with(PriceLevel::default);
        let idx = level.fifo.push_back(arena, maker);
        by_id.insert(maker.id, idx);
        idx
    }

    pub fn cancel(&mut self, order_id: OrderId) -> Option<MakerView> {
        let idx = self.by_id.remove(&order_id)?;
        let maker = self.arena.get(idx)?.value;
        self.remove_by_handle(idx);
        Some(maker)
    }

    fn remove_by_handle(&mut self, h: Index) {
        let maker = match self.arena.get(h) {
            Some(n) => n.value,
            None => return,
        };

        let side = maker.side;
        let price = maker.price;

        match side {
            Side::Buy => {
                let Some(level) = self.bids.get_mut(&price) else {
                    return;
                };
                let _ = level.fifo.remove(&mut self.arena, h);
                if level.fifo.head.is_none() {
                    self.bids.remove(&price);
                }
            }
            Side::Sell => {
                let Some(level) = self.asks.get_mut(&price) else {
                    return;
                };
                let _ = level.fifo.remove(&mut self.arena, h);
                if level.fifo.head.is_none() {
                    self.asks.remove(&price);
                }
            }
        }
    }

    pub fn peek_order(&self, order_id: OrderId) -> Option<MakerView> {
        let idx = *self.by_id.get(&order_id)?;
        let node = self.arena.get(idx)?;
        Some(node.value)
    }
}

impl Book for OrderBook {
    type Handle = Index;

    fn best_price(&self, maker_side: Side) -> Option<U256> {
        match maker_side {
            Side::Buy => self.bids.last_key_value().map(|(p, _)| *p),
            Side::Sell => self.asks.first_key_value().map(|(p, _)| *p),
        }
    }

    fn next_price(&self, maker_side: Side, price: U256) -> Option<U256> {
        match maker_side {
            Side::Buy => self
                .bids
                .range((Unbounded, Excluded(price)))
                .next_back()
                .map(|(p, _)| *p),
            Side::Sell => self
                .asks
                .range((Excluded(price), Unbounded))
                .next()
                .map(|(p, _)| *p),
        }
    }

    fn level_head(&self, maker_side: Side, price: U256) -> Option<Self::Handle> {
        let lvl = self.side_map(maker_side).get(&price)?;
        lvl.fifo.head
    }

    fn next_in_level(&self, h: Self::Handle) -> Option<Self::Handle> {
        let node = self.arena.get(h)?;
        node.next
    }

    fn get_maker(&self, h: Self::Handle) -> Option<MakerView> {
        let node = self.arena.get(h)?;
        Some(node.value)
    }

    fn set_maker_remaining(&mut self, h: Self::Handle, new_remaining_base: U256) {
        if let Some(node) = self.arena.get_mut(h) {
            node.value.remaining_base = new_remaining_base;
        }
    }

    fn remove_maker(&mut self, h: Self::Handle) {
        let maker = match self.arena.get(h) {
            Some(n) => n.value,
            None => return,
        };
        self.by_id.remove(&maker.id);
        self.remove_by_handle(h);
    }

    fn set_maker_reserved_quote(&mut self, h: Self::Handle, new_reserved_quote: U256) {
        if let Some(node) = self.arena.get_mut(h) {
            node.value.reserved_quote = new_reserved_quote;
        }
    }

    fn insert_resting(&mut self, o: RestingOrder) {
        self.push_maker(MakerView {
            id: o.id,
            owner: o.owner,
            side: o.side,
            price: o.price,
            remaining_base: o.remaining_base,
            reserved_quote: o.remaining_quote,
        });
    }
}

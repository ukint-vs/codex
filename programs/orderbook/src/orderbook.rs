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
        let maker = self
            .arena
            .get(h)
            .unwrap_or_else(|| panic!("Remove_by_handle called with invalid handle"))
            .value;

        let side = maker.side;
        let price = maker.price;

        match side {
            Side::Buy => {
                let level = self
                    .bids
                    .get_mut(&price)
                    .unwrap_or_else(|| panic!("Missing bid level",));
                let _ = level.fifo.remove(&mut self.arena, h);
                if level.fifo.head.is_none() {
                    self.bids.remove(&price);
                }
            }
            Side::Sell => {
                let level = self
                    .asks
                    .get_mut(&price)
                    .unwrap_or_else(|| panic!("Missing ask level",));
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
        let maker = self
            .arena
            .get(h)
            .unwrap_or_else(|| panic!("Remove_maker called with invalid handle"))
            .value;
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

#[cfg(test)]
mod tests {
    use super::*;
    use dex_common::Address;
    use matching_engine::{Book, RestingOrder, Side};

    fn mk(
        id: OrderId,
        owner: Address,
        side: Side,
        price: u128,
        remaining_base: u128,
        reserved_quote: u128,
    ) -> MakerView {
        MakerView {
            id,
            owner,
            side,
            price: U256::from(price),
            remaining_base: U256::from(remaining_base),
            reserved_quote: U256::from(reserved_quote),
        }
    }

    // 1) FIFO in the same price level
    #[test]
    fn fifo_ordering_within_level_buy() {
        let mut ob = OrderBook::new();

        let p = U256::from(100u128);

        let h1 = ob.push_maker(mk(1, Address::default(), Side::Buy, 100, 10, 5));
        let h2 = ob.push_maker(mk(2, Address::default(), Side::Buy, 100, 11, 6));
        let h3 = ob.push_maker(mk(3, Address::default(), Side::Buy, 100, 12, 7));

        let head = ob.level_head(Side::Buy, p).expect("head");
        assert_eq!(ob.get_maker(head).unwrap().id, 1);

        // FIFO: 1 -> 2 -> 3 -> None
        let n1 = ob.next_in_level(head).expect("next 1");
        assert_eq!(ob.get_maker(n1).unwrap().id, 2);

        let n2 = ob.next_in_level(n1).expect("next 2");
        assert_eq!(ob.get_maker(n2).unwrap().id, 3);

        assert!(ob.next_in_level(n2).is_none());

        assert_ne!(h1, h2);
        assert_ne!(h2, h3);
    }

    #[test]
    fn best_and_next_price_buy_descending() {
        let mut ob = OrderBook::new();

        ob.push_maker(mk(1, Address::default(), Side::Buy, 100, 1, 0));
        ob.push_maker(mk(2, Address::default(), Side::Buy, 200, 1, 0));
        ob.push_maker(mk(3, Address::default(), Side::Buy, 150, 1, 0));

        assert_eq!(ob.best_price(Side::Buy), Some(U256::from(200u128)));

        assert_eq!(
            ob.next_price(Side::Buy, U256::from(200u128)),
            Some(U256::from(150u128))
        );
        assert_eq!(
            ob.next_price(Side::Buy, U256::from(150u128)),
            Some(U256::from(100u128))
        );
        assert_eq!(ob.next_price(Side::Buy, U256::from(100u128)), None);

        assert_eq!(
            ob.next_price(Side::Buy, U256::from(175u128)),
            Some(U256::from(150u128))
        );
    }

    #[test]
    fn best_and_next_price_sell_ascending() {
        let mut ob = OrderBook::new();

        ob.push_maker(mk(1, Address::default(), Side::Sell, 300, 1, 0));
        ob.push_maker(mk(2, Address::default(), Side::Sell, 200, 1, 0));
        ob.push_maker(mk(3, Address::default(), Side::Sell, 250, 1, 0));

        assert_eq!(ob.best_price(Side::Sell), Some(U256::from(200u128)));

        assert_eq!(
            ob.next_price(Side::Sell, U256::from(200u128)),
            Some(U256::from(250u128))
        );
        assert_eq!(
            ob.next_price(Side::Sell, U256::from(250u128)),
            Some(U256::from(300u128))
        );
        assert_eq!(ob.next_price(Side::Sell, U256::from(300u128)), None);

        assert_eq!(
            ob.next_price(Side::Sell, U256::from(225u128)),
            Some(U256::from(250u128))
        );
    }

    #[test]
    fn cancel_removes_id_and_level_when_last() {
        let mut ob = OrderBook::new();

        ob.push_maker(mk(10, Address::default(), Side::Buy, 111, 5, 9));

        assert!(ob.peek_order(10).is_some());
        assert_eq!(ob.best_price(Side::Buy), Some(U256::from(111u128)));

        let canceled = ob.cancel(10).expect("must cancel");
        assert_eq!(canceled.id, 10);

        assert!(ob.peek_order(10).is_none());
        assert_eq!(ob.best_price(Side::Buy), None);
    }

    #[test]
    fn cancel_keeps_level_when_not_last() {
        let mut ob = OrderBook::new();

        let p = 777u128;
        ob.push_maker(mk(1, Address::default(), Side::Sell, p, 1, 0));
        ob.push_maker(mk(2, Address::default(), Side::Sell, p, 1, 0));

        assert_eq!(ob.best_price(Side::Sell), Some(U256::from(p)));

        let c = ob.cancel(1).unwrap();
        assert_eq!(c.id, 1);

        assert!(ob.peek_order(2).is_some());
        assert_eq!(ob.best_price(Side::Sell), Some(U256::from(p)));

        let head = ob.level_head(Side::Sell, U256::from(p)).unwrap();
        assert_eq!(ob.get_maker(head).unwrap().id, 2);
    }
    #[test]
    fn remove_maker_removes_id_and_level_when_last() {
        let mut ob = OrderBook::new();

        let h = ob.push_maker(mk(42, Address::default(), Side::Sell, 999, 1, 0));
        assert!(ob.peek_order(42).is_some());
        assert_eq!(ob.best_price(Side::Sell), Some(U256::from(999u128)));

        ob.remove_maker(h);

        assert!(ob.peek_order(42).is_none());
        assert_eq!(ob.best_price(Side::Sell), None);
    }

    #[test]
    fn set_remaining_and_reserved_mutate_maker() {
        let mut ob = OrderBook::new();

        let h = ob.push_maker(mk(1, Address::default(), Side::Buy, 123, 10, 50));
        let m0 = ob.get_maker(h).unwrap();
        assert_eq!(m0.remaining_base, U256::from(10u128));
        assert_eq!(m0.reserved_quote, U256::from(50u128));

        ob.set_maker_remaining(h, U256::from(7u128));
        ob.set_maker_reserved_quote(h, U256::from(33u128));

        let m1 = ob.get_maker(h).unwrap();
        assert_eq!(m1.remaining_base, U256::from(7u128));
        assert_eq!(m1.reserved_quote, U256::from(33u128));
    }

    #[test]
    fn insert_resting_inserts_as_maker() {
        let mut ob = OrderBook::new();

        let o = RestingOrder {
            id: 7,
            owner: Address::default(),
            side: Side::Buy,
            price: U256::from(555u128),
            remaining_base: U256::from(12u128),
            remaining_quote: U256::from(99u128),
        };

        ob.insert_resting(o);

        let v = ob.peek_order(7).expect("inserted");
        assert_eq!(v.id, 7);
        assert_eq!(v.side, Side::Buy);
        assert_eq!(v.price, U256::from(555u128));
        assert_eq!(v.remaining_base, U256::from(12u128));
        assert_eq!(v.reserved_quote, U256::from(99u128));

        assert_eq!(ob.best_price(Side::Buy), Some(U256::from(555u128)));
    }

    #[test]
    #[should_panic(expected = "Remove_maker called with invalid handle")]
    fn remove_maker_panics_on_invalid_handle() {
        let mut ob = OrderBook::new();
        let h = ob.push_maker(MakerView {
            id: 1,
            owner: Address::default(),
            side: Side::Buy,
            price: U256::from(100u128),
            remaining_base: U256::from(1u128),
            reserved_quote: U256::from(0u128),
        });
        ob.remove_maker(h);
        ob.remove_maker(h);
    }

    #[test]
    #[should_panic(expected = "Remove_by_handle called with invalid handle")]
    fn remove_by_handle_panics_on_invalid_handle() {
        let mut ob = OrderBook::new();

        let h = ob.push_maker(MakerView {
            id: 1,
            owner: Address::default(),
            side: Side::Buy,
            price: U256::from(100u128),
            remaining_base: U256::from(1u128),
            reserved_quote: U256::from(0u128),
        });
        ob.remove_maker(h);

        ob.remove_by_handle(h);
    }

    #[test]
    #[should_panic(expected = "Missing bid level")]
    fn remove_by_handle_panics_if_bid_level_missing() {
        let mut ob = OrderBook::new();
        let price = U256::from(123u128);

        let h = ob.push_maker(MakerView {
            id: 10,
            owner: Address::default(),
            side: Side::Buy,
            price,
            remaining_base: U256::from(1u128),
            reserved_quote: U256::from(0u128),
        });

        ob.bids.remove(&price);

        ob.remove_by_handle(h);
    }

    #[test]
    #[should_panic(expected = "Missing ask level")]
    fn remove_by_handle_panics_if_ask_level_missing() {
        let mut ob = OrderBook::new();
        let price = U256::from(456u128);

        let h = ob.push_maker(MakerView {
            id: 11,
            owner: Address::default(),
            side: Side::Sell,
            price,
            remaining_base: U256::from(1u128),
            reserved_quote: U256::from(0u128),
        });

        ob.asks.remove(&price);

        ob.remove_by_handle(h);
    }
}

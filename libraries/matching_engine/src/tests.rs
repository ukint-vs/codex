extern crate std;
use sails_rs::{
    collections::{BTreeMap, VecDeque},
    ops::Bound::{Excluded, Unbounded},
    prelude::*,
    U256,
};
use std::panic;

use crate::{
    book::Book,
    engine::{execute, preview_fillable},
    math::calc_quote_floor,
    types::{
        BookInvariant, Completion, EngineLimits, IncomingOrder, MakerView, MatchError, OrderKind,
        RestingOrder, Side,
    },
};

/// Simple handle for MockBook: points to (side, price level, index within FIFO queue).
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
struct H {
    side: Side,
    price: U256,
    idx: usize,
}

/// A minimal orderbook implementation for engine tests.
/// - bids: highest price is best
/// - asks: lowest price is best
/// - FIFO within each price via VecDeque
#[derive(Default)]
struct MockBook {
    bids: BTreeMap<U256, VecDeque<MakerView>>,
    asks: BTreeMap<U256, VecDeque<MakerView>>,
}

impl MockBook {
    fn new() -> Self {
        Self::default()
    }

    fn side_map(&self, side: Side) -> &BTreeMap<U256, VecDeque<MakerView>> {
        match side {
            Side::Buy => &self.bids,
            Side::Sell => &self.asks,
        }
    }

    fn side_map_mut(&mut self, side: Side) -> &mut BTreeMap<U256, VecDeque<MakerView>> {
        match side {
            Side::Buy => &mut self.bids,
            Side::Sell => &mut self.asks,
        }
    }

    fn push_maker(&mut self, maker: MakerView) {
        let q = self
            .side_map_mut(maker.side)
            .entry(maker.price)
            .or_default();
        q.push_back(maker);
    }

    fn peek_level(&self, side: Side, price: U256) -> Option<&VecDeque<MakerView>> {
        self.side_map(side).get(&price)
    }

    fn maker_remaining_at_head(&self, side: Side, price: U256) -> Option<U256> {
        self.peek_level(side, price)
            .and_then(|q| q.front())
            .map(|m| m.remaining_base)
    }
}

impl Book for MockBook {
    type Handle = H;

    fn best_price(&self, side: Side) -> Option<U256> {
        match side {
            Side::Buy => self.bids.last_key_value().map(|(p, _)| *p),
            Side::Sell => self.asks.first_key_value().map(|(p, _)| *p),
        }
    }

    fn next_price(&self, maker_side: Side, price: U256) -> Option<U256> {
        match maker_side {
            Side::Buy => {
                // bids: next worse = next LOWER
                self.bids
                    .range((Unbounded, Excluded(price)))
                    .next_back()
                    .map(|(p, _)| *p)
            }
            Side::Sell => {
                // asks: next worse = next HIGHER
                self.asks
                    .range((Excluded(price), Unbounded))
                    .next()
                    .map(|(p, _)| *p)
            }
        }
    }

    fn level_head(&self, side: Side, price: U256) -> Option<Self::Handle> {
        let q = self.side_map(side).get(&price)?;
        if q.is_empty() {
            return None;
        }
        Some(H {
            side,
            price,
            idx: 0,
        })
    }

    fn next_in_level(&self, h: Self::Handle) -> Option<Self::Handle> {
        let q = self.side_map(h.side).get(&h.price)?;
        let next = h.idx + 1;
        if next < q.len() {
            Some(H { idx: next, ..h })
        } else {
            None
        }
    }

    fn get_maker(&self, h: Self::Handle) -> Option<MakerView> {
        let q = self.side_map(h.side).get(&h.price)?;
        q.get(h.idx).cloned()
    }

    fn set_maker_remaining(&mut self, h: Self::Handle, new_remaining: U256) {
        // engine in execution always updates head, so we enforce idx==0
        debug_assert_eq!(h.idx, 0);
        let q = self
            .side_map_mut(h.side)
            .get_mut(&h.price)
            .expect("level exists");
        let m = q.front_mut().expect("head exists");
        m.remaining_base = new_remaining;
    }

    fn remove_maker(&mut self, h: Self::Handle) {
        debug_assert_eq!(h.idx, 0);
        let map = self.side_map_mut(h.side);
        let q = map.get_mut(&h.price).expect("level exists");
        let _ = q.pop_front().expect("head exists");
        if q.is_empty() {
            map.remove(&h.price);
        }
    }

    fn set_maker_reserved_quote(&mut self, h: Self::Handle, new_reserved_quote: U256) {
        debug_assert_eq!(h.idx, 0);

        let q = self
            .side_map_mut(h.side)
            .get_mut(&h.price)
            .expect("level exists");
        let m = q.front_mut().expect("head exists");
        m.reserved_quote = new_reserved_quote;
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

fn u(x: u64) -> U256 {
    U256::from(x)
}

fn maker(id: u64, side: Side, price: u64, base: u64, owner: u64) -> MakerView {
    let reserved_quote = if side == Side::Buy {
        // reserve uses ceil (up)
        crate::math::calc_quote_ceil(u(base), u(price)).unwrap()
    } else {
        U256::zero()
    };
    MakerView {
        id,
        owner: owner.into(),
        side,
        price: u(price),
        remaining_base: u(base),
        reserved_quote,
    }
}

fn taker(
    id: u64,
    side: Side,
    kind: OrderKind,
    limit_price: u64,
    base: u64,
    owner: u64,
    max_quote: u64,
) -> IncomingOrder {
    IncomingOrder {
        id,
        owner: owner.into(),
        side,
        kind,
        limit_price: u(limit_price),
        amount_base: u(base),
        max_quote: u(max_quote),
    }
}

#[test]
fn limit_no_cross_places_remainder() {
    let mut book = MockBook::new();
    // best ask = 100
    book.push_maker(maker(1, Side::Sell, 100, 10, 1));

    let limits = EngineLimits {
        max_trades: 100,
        max_preview_scans: 1_000,
    };
    let order = taker(10, Side::Buy, OrderKind::Limit, 90, 7, 9, 0);

    let rep = execute(&mut book, &order, limits).unwrap();
    assert!(rep.trades.is_empty());

    match rep.completion {
        Completion::Placed { remaining_base, .. } => assert_eq!(remaining_base, u(7)),
        x => panic!("unexpected completion: {:?}", x),
    }

    // remainder should appear as resting bid at 90
    assert_eq!(book.maker_remaining_at_head(Side::Buy, u(90)), Some(u(7)));
}

#[test]
fn limit_cross_partially_then_place_remainder() {
    let mut book = MockBook::new();
    book.push_maker(maker(1, Side::Sell, 100, 5, 1));

    let limits = EngineLimits {
        max_trades: 100,
        max_preview_scans: 1_000,
    };
    let order = taker(10, Side::Buy, OrderKind::Limit, 100, 8, 9, 0);

    let rep = execute(&mut book, &order, limits).unwrap();
    assert_eq!(rep.trades.len(), 1);
    assert_eq!(rep.trades[0].price, u(100));
    assert_eq!(rep.trades[0].amount_base, u(5));

    match rep.completion {
        Completion::Placed { remaining_base, .. } => assert_eq!(remaining_base, u(3)),
        x => panic!("unexpected completion: {:?}", x),
    }

    // ask(100) consumed, remainder placed on bid(100)
    assert!(book.peek_level(Side::Sell, u(100)).is_none());
    assert_eq!(book.maker_remaining_at_head(Side::Buy, u(100)), Some(u(3)));
}

#[test]
fn ioc_cross_partially_then_cancel_remainder() {
    let mut book = MockBook::new();
    book.push_maker(maker(1, Side::Sell, 100, 5, 1));

    let limits = EngineLimits {
        max_trades: 100,
        max_preview_scans: 1_000,
    };
    let order = taker(10, Side::Buy, OrderKind::ImmediateOrCancel, 100, 8, 9, 0);

    let rep = execute(&mut book, &order, limits).unwrap();
    assert_eq!(rep.trades.len(), 1);

    match rep.completion {
        Completion::Cancelled { remaining_base } => assert_eq!(remaining_base, u(3)),
        x => panic!("unexpected completion: {:?}", x),
    }

    // no resting order should be inserted
    assert!(book.peek_level(Side::Buy, u(100)).is_none());
}

#[test]
fn market_sell_consumes_best_bids_in_order() {
    let mut book = MockBook::new();
    book.push_maker(maker(1, Side::Buy, 99, 10, 1));
    book.push_maker(maker(2, Side::Buy, 98, 10, 2));

    let limits = EngineLimits {
        max_trades: 100,
        max_preview_scans: 1_000,
    };
    let order = taker(10, Side::Sell, OrderKind::Market, 0, 15, 9, 0);

    let rep = execute(&mut book, &order, limits).unwrap();
    assert_eq!(rep.trades.len(), 2);

    // first trade at best bid 99
    assert_eq!(rep.trades[0].price, u(99));
    assert_eq!(rep.trades[0].amount_base, u(10));
    // second trade at 98
    assert_eq!(rep.trades[1].price, u(98));
    assert_eq!(rep.trades[1].amount_base, u(5));

    match rep.completion {
        Completion::Filled => {}
        x => panic!("unexpected completion: {:?}", x),
    }

    // bid(99) removed, bid(98) left with 5
    assert!(book.peek_level(Side::Buy, u(99)).is_none());
    assert_eq!(book.maker_remaining_at_head(Side::Buy, u(98)), Some(u(5)));
}

#[test]
fn fok_rejects_without_mutating_book() {
    let mut book = MockBook::new();
    book.push_maker(maker(1, Side::Sell, 100, 5, 1));

    let limits = EngineLimits {
        max_trades: 100,
        max_preview_scans: 10_000,
    };
    let order = taker(10, Side::Buy, OrderKind::FillOrKill, 100, 8, 9, 0);

    let rep = execute(&mut book, &order, limits).unwrap();
    assert!(rep.trades.is_empty());
    assert!(matches!(rep.completion, Completion::Rejected));

    // book unchanged
    assert_eq!(book.maker_remaining_at_head(Side::Sell, u(100)), Some(u(5)));
}

#[test]
fn fok_fills_across_levels() {
    let mut book = MockBook::new();
    book.push_maker(maker(1, Side::Sell, 100, 5, 1));
    book.push_maker(maker(2, Side::Sell, 101, 5, 2));

    let limits = EngineLimits {
        max_trades: 100,
        max_preview_scans: 10_000,
    };
    let order = taker(10, Side::Buy, OrderKind::FillOrKill, 101, 8, 9, 0);

    let rep = execute(&mut book, &order, limits).unwrap();
    assert_eq!(rep.trades.len(), 2);
    assert_eq!(rep.trades[0].price, u(100));
    assert_eq!(rep.trades[0].amount_base, u(5));
    assert_eq!(rep.trades[1].price, u(101));
    assert_eq!(rep.trades[1].amount_base, u(3));

    assert!(matches!(rep.completion, Completion::Filled));

    // ask(100) removed, ask(101) left with 2
    assert!(book.peek_level(Side::Sell, u(100)).is_none());
    assert_eq!(book.maker_remaining_at_head(Side::Sell, u(101)), Some(u(2)));
}

#[test]
fn fifo_same_price_consumes_in_order() {
    let mut book = MockBook::new();
    book.push_maker(maker(1, Side::Sell, 100, 3, 1));
    book.push_maker(maker(2, Side::Sell, 100, 3, 2));

    let limits = EngineLimits {
        max_trades: 100,
        max_preview_scans: 10_000,
    };
    let order = taker(10, Side::Buy, OrderKind::Market, 0, 4, 9, 1_000_000);

    let rep = execute(&mut book, &order, limits).unwrap();
    assert_eq!(rep.trades.len(), 2);

    assert_eq!(rep.trades[0].maker_order_id, 1);
    assert_eq!(rep.trades[0].amount_base, u(3));
    assert_eq!(rep.trades[1].maker_order_id, 2);
    assert_eq!(rep.trades[1].amount_base, u(1));

    // maker(2) now has 2 remaining at same price
    assert_eq!(book.maker_remaining_at_head(Side::Sell, u(100)), Some(u(2)));
}

#[test]
fn preview_scan_limit_hits() {
    let mut book = MockBook::new();
    for i in 0..20u64 {
        book.push_maker(maker(100 + i, Side::Sell, 100, 1, 1));
    }

    let order = taker(10, Side::Buy, OrderKind::FillOrKill, 100, 20, 9, 0);

    let err = preview_fillable(&book, &order, 5).unwrap_err();
    assert!(matches!(err, MatchError::ScanLimitReached { .. }));
}

#[test]
fn broken_book_best_price_without_head_is_error() {
    let mut book = MockBook::new();
    // Manually insert empty level to violate invariants.
    book.asks.insert(u(100), VecDeque::new());

    let limits = EngineLimits {
        max_trades: 100,
        max_preview_scans: 1_000,
    };
    let order = taker(10, Side::Buy, OrderKind::Market, 0, 1, 9, 1_000_000);

    let err = execute(&mut book, &order, limits).unwrap_err();
    assert!(matches!(
        err,
        MatchError::BrokenBook(BookInvariant::BestPriceHasNoHead)
    ));
}

#[test]
fn quote_is_floor_like_engine() {
    let mut book = MockBook::new();
    book.push_maker(maker(1, Side::Sell, 123, 10, 1));

    let limits = EngineLimits {
        max_trades: 100,
        max_preview_scans: 1_000,
    };
    let order = taker(10, Side::Buy, OrderKind::Market, 0, 7, 9, 1_000_000);

    let rep = execute(&mut book, &order, limits).unwrap();
    assert_eq!(rep.trades.len(), 1);

    let t = &rep.trades[0];
    let expected = calc_quote_floor(t.amount_base, t.price).unwrap();
    assert_eq!(t.amount_quote, expected);
}

#[test]
fn invalid_zero_amount_is_rejected() {
    let mut book = MockBook::new();
    let limits = EngineLimits {
        max_trades: 100,
        max_preview_scans: 1_000,
    };

    let order = taker(1, Side::Buy, OrderKind::Market, 0, 0, 9, 1_000_000);
    let err = execute(&mut book, &order, limits).unwrap_err();
    assert!(matches!(err, MatchError::InvalidOrder(_)));
}

#[test]
fn invalid_non_market_zero_limit_price() {
    let mut book = MockBook::new();
    let limits = EngineLimits {
        max_trades: 100,
        max_preview_scans: 1_000,
    };

    let order = taker(1, Side::Buy, OrderKind::Limit, 0, 10, 9, 0);
    let err = execute(&mut book, &order, limits).unwrap_err();
    assert!(matches!(err, MatchError::InvalidOrder(_)));
}

#[test]
fn limit_buy_does_not_take_worse_than_limit() {
    let mut book = MockBook::new();
    book.push_maker(maker(1, Side::Sell, 101, 10, 1)); // worse than limit
    book.push_maker(maker(2, Side::Sell, 100, 2, 2)); // equal to limit

    let limits = EngineLimits {
        max_trades: 100,
        max_preview_scans: 1_000,
    };
    let order = taker(10, Side::Buy, OrderKind::Limit, 100, 5, 9, 0);

    let rep = execute(&mut book, &order, limits).unwrap();
    assert_eq!(rep.trades.len(), 1);
    assert_eq!(rep.trades[0].price, u(100));
    assert_eq!(rep.trades[0].amount_base, u(2));

    // ask 101 untouched
    assert_eq!(
        book.maker_remaining_at_head(Side::Sell, u(101)),
        Some(u(10))
    );
}
#[test]
fn trade_limit_reached() {
    let mut book = MockBook::new();
    for i in 0..10u64 {
        book.push_maker(maker(100 + i, Side::Sell, 100, 1, 1));
    }

    let limits = EngineLimits {
        max_trades: 3,
        max_preview_scans: 1_000,
    };
    let order = taker(10, Side::Buy, OrderKind::Market, 0, 10, 9, 1_000_000);

    let err = execute(&mut book, &order, limits).unwrap_err();
    assert!(matches!(err, MatchError::TradeLimitReached { .. }));
}

#[test]
fn trade_prices_monotonic_for_buy() {
    let mut book = MockBook::new();
    book.push_maker(maker(1, Side::Sell, 100, 3, 1));
    book.push_maker(maker(2, Side::Sell, 101, 3, 2));
    book.push_maker(maker(3, Side::Sell, 102, 3, 3));

    let limits = EngineLimits {
        max_trades: 100,
        max_preview_scans: 1_000,
    };
    let order = taker(10, Side::Buy, OrderKind::Market, 0, 7, 9, 1_000_000);

    let rep = execute(&mut book, &order, limits).unwrap();
    for w in rep.trades.windows(2) {
        assert!(w[0].price <= w[1].price);
    }
}

#[test]
fn trade_prices_monotonic_for_sell() {
    let mut book = MockBook::new();
    book.push_maker(maker(1, Side::Buy, 105, 3, 1));
    book.push_maker(maker(2, Side::Buy, 104, 3, 2));
    book.push_maker(maker(3, Side::Buy, 103, 3, 3));

    let limits = EngineLimits {
        max_trades: 100,
        max_preview_scans: 1_000,
    };
    let order = taker(10, Side::Sell, OrderKind::Market, 0, 7, 9, 0);

    let rep = execute(&mut book, &order, limits).unwrap();
    for w in rep.trades.windows(2) {
        assert!(w[0].price >= w[1].price);
    }
}

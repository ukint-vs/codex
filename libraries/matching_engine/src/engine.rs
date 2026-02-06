use sails_rs::{Vec, U256};

use crate::{
    book::Book,
    math::{calc_quote_ceil, calc_quote_floor},
    types::{
        BookInvariant, Completion, EngineLimits, ExecutionReport, IncomingOrder,
        InvalidOrderReason, MakerView, MatchError, OrderKind, RestingOrder, Side, Trade,
    },
};

fn crosses(taker_side: Side, taker_limit: U256, maker_price: U256) -> bool {
    match taker_side {
        Side::Buy => maker_price <= taker_limit,
        Side::Sell => maker_price >= taker_limit,
    }
}

fn validate(order: &IncomingOrder) -> Result<(), MatchError> {
    if order.amount_base.is_zero() {
        return Err(MatchError::InvalidOrder(InvalidOrderReason::ZeroAmountBase));
    }

    // Limit / IOC / FOK must have limit_price != 0
    if order.kind != OrderKind::Market && order.limit_price.is_zero() {
        return Err(MatchError::InvalidOrder(
            InvalidOrderReason::ZeroLimitPriceForNonMarket,
        ));
    }

    if order.kind == OrderKind::Market {
        match order.side {
            Side::Buy => {
                if order.max_quote.is_zero() {
                    return Err(MatchError::InvalidOrder(
                        InvalidOrderReason::ZeroMaxQuoteForMarketBuy,
                    ));
                }
            }
            Side::Sell => {
                if !order.max_quote.is_zero() {
                    return Err(MatchError::InvalidOrder(
                        InvalidOrderReason::MaxQuoteOnlyForMarketBuy,
                    ));
                }
            }
        }
    } else if !order.max_quote.is_zero() {
        return Err(MatchError::InvalidOrder(
            InvalidOrderReason::MaxQuoteOnlyForMarketBuy,
        ));
    }

    Ok(())
}

fn validate_maker_view(
    maker: &MakerView,
    expected_side: Side,
    expected_price: U256,
) -> Result<(), MatchError> {
    if maker.side != expected_side {
        return Err(MatchError::BrokenBook(BookInvariant::MakerSideMismatch));
    }
    if maker.price != expected_price {
        return Err(MatchError::BrokenBook(BookInvariant::MakerPriceMismatch));
    }
    if maker.remaining_base.is_zero() {
        return Err(MatchError::BrokenBook(BookInvariant::MakerZeroRemaining));
    }
    Ok(())
}

pub fn preview_market_buy_budget_strict<B: Book>(
    book: &B,
    order: &IncomingOrder,
    limits: EngineLimits,
) -> Result<(), MatchError> {
    if order.kind != OrderKind::Market || order.side != Side::Buy {
        return Err(MatchError::InvalidOrder(
            InvalidOrderReason::PreviewOnlyForMarketBuyBudget,
        ));
    }
    if order.max_quote.is_zero() {
        return Err(MatchError::InvalidOrder(
            InvalidOrderReason::ZeroMaxQuoteForMarketBuy,
        ));
    }

    let maker_side = Side::Sell; // asks
    let mut remaining = order.amount_base;
    let mut required_quote = U256::zero();

    let mut scanned: u32 = 0;
    let mut price_opt = book.best_price(maker_side);

    while let Some(price) = price_opt {
        let mut h = book
            .level_head(maker_side, price)
            .ok_or(MatchError::BrokenBook(BookInvariant::BestPriceHasNoHead))?;

        loop {
            scanned += 1;
            if scanned > limits.max_preview_scans {
                return Err(MatchError::ScanLimitReached {
                    max_scanned: limits.max_preview_scans,
                });
            }

            let maker = book
                .get_maker(h)
                .ok_or(MatchError::BrokenBook(BookInvariant::LevelHeadMissingMaker))?;
            validate_maker_view(&maker, maker_side, price)?;

            let fill = remaining.min(maker.remaining_base);

            let q = calc_quote_floor(fill, price)?;
            required_quote = required_quote
                .checked_add(q)
                .ok_or(MatchError::AddOverflow)?;

            if required_quote > order.max_quote {
                return Err(MatchError::MarketBuyMaxQuoteExceeded);
            }

            remaining = remaining
                .checked_sub(fill)
                .ok_or(MatchError::SubUnderflow)?;
            if remaining.is_zero() {
                return Ok(());
            }

            match book.next_in_level(h) {
                Some(next) => {
                    if next == h {
                        return Err(MatchError::BrokenBook(BookInvariant::NextInLevelSelfLoop));
                    }
                    h = next;
                }
                None => break,
            }
        }

        price_opt = book.next_price(maker_side, price);
        if let Some(next_price) = price_opt {
            if next_price == price {
                return Err(MatchError::BrokenBook(
                    BookInvariant::NextPriceDidNotAdvance,
                ));
            }
        }
    }

    Err(MatchError::MarketBuyInsufficientLiquidity)
}

/// Preview fillability for FOK without mutating the book.
pub fn preview_fillable<B: Book>(
    book: &B,
    order: &IncomingOrder,
    max_scanned: u32,
) -> Result<bool, MatchError> {
    if order.kind != OrderKind::FillOrKill {
        return Err(MatchError::InvalidOrder(
            InvalidOrderReason::PreviewOnlyForFok,
        ));
    }

    let maker_side = order.side.opposite();
    let mut remaining = order.amount_base;

    let mut scanned = 0;

    // start from best maker price
    let mut price_opt = book.best_price(maker_side);
    while let Some(price) = price_opt {
        // FOK is price-bounded: once prices stop crossing, no further levels can help
        if !crosses(order.side, order.limit_price, price) {
            return Ok(false);
        }
        // level must have a head; otherwise book is inconsistent
        let mut h = book
            .level_head(maker_side, price)
            .ok_or(MatchError::BrokenBook(BookInvariant::BestPriceHasNoHead))?;
        loop {
            scanned += 1;

            if scanned > max_scanned {
                return Err(MatchError::ScanLimitReached { max_scanned });
            }

            let maker = book
                .get_maker(h)
                .ok_or(MatchError::BrokenBook(BookInvariant::LevelHeadMissingMaker))?;

            validate_maker_view(&maker, maker_side, price)?;
            let fill = remaining.min(maker.remaining_base);

            remaining = remaining
                .checked_sub(fill)
                .ok_or(MatchError::SubUnderflow)?;
            if remaining.is_zero() {
                return Ok(true);
            }
            match book.next_in_level(h) {
                Some(next) => {
                    if next == h {
                        return Err(MatchError::BrokenBook(BookInvariant::NextInLevelSelfLoop));
                    }
                    h = next;
                }
                None => break, // end of level
            }
        }
        price_opt = book.next_price(maker_side, price);
        if let Some(next_price) = price_opt {
            if next_price == price {
                return Err(MatchError::BrokenBook(
                    BookInvariant::NextPriceDidNotAdvance,
                ));
            }
        }
    }

    Ok(false)
}

/// Matching algorithm:
/// - price-time priority (best price, FIFO within level)
/// - Market ignores limit_price
/// - Limit places remainder
/// - IOC cancels remainder
/// - FOK prechecks via preview_fillable; if not fillable => no mutations
pub fn execute<B: Book>(
    book: &mut B,
    order: &IncomingOrder,
    limits: EngineLimits,
) -> Result<ExecutionReport, MatchError> {
    validate(order)?;

    let is_strict_market_buy = order.kind == OrderKind::Market && order.side == Side::Buy;
    if is_strict_market_buy {
        preview_market_buy_budget_strict(book, order, limits)?;
    }

    // FOK precheck: MUST NOT mutate the book when failing
    if order.kind == OrderKind::FillOrKill {
        let ok = preview_fillable(book, order, limits.max_preview_scans)?;
        if !ok {
            return Ok(ExecutionReport {
                trades: Vec::new(),
                completion: Completion::Rejected,
            });
        }
    }

    let maker_side = order.side.opposite();
    let mut remaining = order.amount_base;
    let mut trades: Vec<Trade> = Vec::new();
    let mut spent_quote = U256::zero();
    let track_limit_buy_quote = order.kind == OrderKind::Limit && order.side == Side::Buy;
    let mut remaining_quote = if track_limit_buy_quote {
        // reserve for whole order on LIMIT price (ceil)
        calc_quote_ceil(order.amount_base, order.limit_price)?
    } else {
        U256::zero()
    };

    while !remaining.is_zero() {
        if trades.len() >= limits.max_trades as usize {
            return Err(MatchError::TradeLimitReached {
                max_trades: limits.max_trades,
            });
        }

        let price = match book.best_price(maker_side) {
            Some(p) => p,
            None => break, // no liquidity
        };

        // Market: no price bound
        if order.kind != OrderKind::Market && !crosses(order.side, order.limit_price, price) {
            break;
        }

        let h = book
            .level_head(maker_side, price)
            .ok_or(MatchError::BrokenBook(BookInvariant::BestPriceHasNoHead))?;

        let maker = book
            .get_maker(h)
            .ok_or(MatchError::BrokenBook(BookInvariant::LevelHeadMissingMaker))?;

        validate_maker_view(&maker, maker_side, price)?;

        let fill = remaining.min(maker.remaining_base);

        let quote = calc_quote_floor(fill, price)?;
        if is_strict_market_buy {
            spent_quote = spent_quote
                .checked_add(quote)
                .ok_or(MatchError::AddOverflow)?;
            if spent_quote > order.max_quote {
                // after successfull preview it must be impossible
                return Err(MatchError::MarketBuyBudgetCheckInconsistent);
            }
        }

        if track_limit_buy_quote {
            remaining_quote = remaining_quote
                .checked_sub(quote)
                .ok_or(MatchError::SubUnderflow)?;
        }

        trades.push(Trade {
            maker_order_id: maker.id,
            taker_order_id: order.id,
            maker: maker.owner,
            taker: order.owner,
            price,
            amount_base: fill,
            amount_quote: quote,
        });

        // update maker
        let maker_new = maker
            .remaining_base
            .checked_sub(fill)
            .ok_or(MatchError::SubUnderflow)?;

        if maker.side == Side::Buy {
            // maker buys base and pays quote from reserved
            let new_rq = maker
                .reserved_quote
                .checked_sub(quote)
                .ok_or(MatchError::SubUnderflow)?;
            book.set_maker_reserved_quote(h, new_rq);
        }

        if maker_new.is_zero() {
            book.remove_maker(h);
        } else {
            book.set_maker_remaining(h, maker_new);
        }

        // update taker
        remaining = remaining
            .checked_sub(fill)
            .ok_or(MatchError::SubUnderflow)?;
    }

    // finalize
    if is_strict_market_buy && !remaining.is_zero() {
        // after successfull preview it must be impossible
        return Err(MatchError::MarketBuyLiquidityCheckInconsistent);
    }
    if remaining.is_zero() {
        return Ok(ExecutionReport {
            trades,
            completion: Completion::Filled,
        });
    }
    match order.kind {
        OrderKind::Limit => {
            let remaining_quote = if track_limit_buy_quote {
                remaining_quote
            } else {
                U256::zero()
            };
            book.insert_resting(RestingOrder {
                id: order.id,
                owner: order.owner,
                side: order.side,
                price: order.limit_price,
                remaining_base: remaining,
                remaining_quote,
            });

            Ok(ExecutionReport {
                trades,
                completion: Completion::Placed {
                    remaining_base: remaining,
                    remaining_quote,
                },
            })
        }
        OrderKind::Market | OrderKind::ImmediateOrCancel => Ok(ExecutionReport {
            trades,
            completion: Completion::Cancelled {
                remaining_base: remaining,
            },
        }),
        OrderKind::FillOrKill => Err(MatchError::FokCheckInconsistent),
    }
}

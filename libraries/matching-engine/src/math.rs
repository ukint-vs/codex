use sails_rs::U256;

use crate::types::MatchError;
// 1e30 precision
const PRICE_PRECISION: u128 = 1_000_000_000_000_000_000_000_000_000_000_000;
/// quote = floor(base * price / PRICE_PRECISION)
pub fn calc_quote_floor(base: U256, price: U256) -> Result<U256, MatchError> {
    let mul = base.checked_mul(price).ok_or(MatchError::MulOverflow)?;
    let precision: U256 = U256::from(PRICE_PRECISION);
    Ok(mul / precision)
}

/// quote = ceil(base * price / PRICE_PRECISION)
pub fn calc_quote_ceil(base: U256, price: U256) -> Result<U256, MatchError> {
    let mul = base.checked_mul(price).ok_or(MatchError::MulOverflow)?;
    let precision: U256 = U256::from(PRICE_PRECISION);
    let q = mul / precision;
    let rem = mul % precision;
    if rem.is_zero() {
        Ok(q)
    } else {
        q.checked_add(U256::one()).ok_or(MatchError::AddOverflow)
    }
}

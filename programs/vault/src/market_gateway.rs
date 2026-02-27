#![allow(dead_code)]

use dex_common::{Address, TokenId};
use sails_rs::client::{GstdEnv, PendingCall, Program};
use sails_rs::ActorId;

use crate::orderbook_client;

use crate::orderbook_client::ob_client::Orderbook as OrderbookProgramExt;
use crate::orderbook_client::ob_client::OrderbookProgram;
use orderbook_client::ob_client::Address as ObAddress;

use crate::orderbook_client::ob_client::orderbook::Orderbook as OrderbookSvc;

use crate::orderbook_client::ob_client::orderbook::io::Deposit as ObDepositCall;

pub trait MarketGateway {
    fn deposit_to_market(
        &self,
        market_id: Address,
        user: Address,
        token: TokenId,
        amount: u128,
    ) -> PendingCall<ObDepositCall, GstdEnv>;
}

#[derive(Clone, Copy, Default)]
pub struct SailsMarketGateway;

impl MarketGateway for SailsMarketGateway {
    fn deposit_to_market(
        &self,
        market_id: Address,
        user: Address,
        token: TokenId,
        amount: u128,
    ) -> PendingCall<ObDepositCall, GstdEnv> {
        let mut ob = OrderbookProgram::client(ActorId::from(market_id)).orderbook();

        ob.deposit(ObAddress(user.0), ObAddress(token.0), amount)
    }
}

use clob_common::TokenId;
use orderbook_client::order_book::OrderBook;
use orderbook_client::{order_book::OrderBookImpl, OrderbookCtors, OrderbookProgram};
use sails_rs::{
    client::{Deployment, GtestEnv, Service},
    gtest::{Program, System},
    prelude::*,
    ActorId,
};

pub(crate) const ORDERBOOK_WASM: &str = "../../target/wasm32-gear/release/orderbook.opt.wasm";
pub(crate) const VAULT_WASM: &str = "../../target/wasm32-gear/release/vault_app.opt.wasm";

pub(crate) const ADMIN_ID: u64 = 100;
pub(crate) const BUYER_ID: u64 = 101;
pub(crate) const SELLER_ID: u64 = 102;
pub(crate) const TOKEN_BASE: TokenId = [11u8; 20];
pub(crate) const TOKEN_QUOTE: TokenId = [12u8; 20];
const DECIMALS: u128 = 1_000_000;

fn buyer() -> ActorId {
    ActorId::from(BUYER_ID)
}
fn seller() -> ActorId {
    ActorId::from(SELLER_ID)
}

async fn setup_programs() -> (GtestEnv, ActorId, ActorId) {
    let system = System::new();
    system.init_logger();
    system.mint_to(ADMIN_ID, 100_000_000_000_000_000);
    system.mint_to(buyer(), 100_000_000_000_000_000);
    system.mint_to(seller(), 100_000_000_000_000_000);

    let remoting = GtestEnv::new(system, ADMIN_ID.into());
    let system_ref = remoting.system();

    // Vault
    let vault_program = Program::from_file(system_ref, VAULT_WASM);
    let vault_id = vault_program.id();
    vault_program.send_bytes(ADMIN_ID, ("Create", ()).encode());

    // OrderBook
    let code_orderbook = system_ref.submit_code_file(ORDERBOOK_WASM);
    let orderbook_actor = Deployment::<OrderbookProgram, _>::new(
        remoting.clone(),
        code_orderbook,
        b"bench_salt".to_vec(),
    )
    .create(vault_id)
    .await
    .unwrap();
    let orderbook_id = orderbook_actor.id();

    // Auth
    let payload = ("Vault", "AddMarket", (orderbook_id)).encode();
    let vault_prg = system_ref
        .get_program(vault_id)
        .expect("Vault program not found");
    vault_prg.send_bytes(ADMIN_ID, payload);
    system_ref.run_next_block();

    (remoting, vault_id, orderbook_id)
}

fn service_for(
    remoting: &GtestEnv,
    orderbook_id: ActorId,
    trader: ActorId,
) -> Service<OrderBookImpl, GtestEnv> {
    Service::<OrderBookImpl, _>::new(
        remoting.clone().with_actor_id(trader),
        orderbook_id,
        "OrderBook".into(),
    )
}

fn send_vault(system: &System, from: u64, vault_id: ActorId, method: &str, args: impl Encode) {
    let payload = ("Vault", method, args).encode();
    let program = system
        .get_program(vault_id)
        .expect("Vault program not found");
    program.send_bytes(from, payload);
    system.run_next_block();
}

#[tokio::test]
async fn benchmark_matching_costs() {
    println!("\n=== BENCHMARK: DIFF METHOD (Fees, Events, Updates) ===");

    // Scenario A: 10 matches (Baseline)
    let count_a = 10;
    let gas_a = run_benchmark_scenario(count_a).await;
    println!("Gas ({} matches): {}", count_a, gas_a);

    // Scenario B: 60 matches (Delta 50)
    let count_b = 60;
    let gas_b = run_benchmark_scenario(count_b).await;
    println!("Gas ({} matches): {}", count_b, gas_b);

    if gas_b <= gas_a {
        println!(
            "WARNING: Gas usage did not increase linearly (Gas{}={} <= Gas{}={}). Refunds/variance?",
            count_b, gas_b, count_a, gas_a
        );
        let raw_per_match = gas_b / count_b as u128;
        println!("Fallback Avg (incl. overhead): {}", raw_per_match);
        return;
    }

    let delta_gas = gas_b - gas_a;
    let delta_count = (count_b - count_a) as u128;
    let gas_per_match = delta_gas / delta_count;

    println!("Delta Gas ({} - {}): {}", count_b, count_a, delta_gas);
    println!("Avg Gas Per Match (Marginal Cost): {}", gas_per_match);

    let safety_buffer = 5_000_000_000;
    let fixed_overhead = gas_a.saturating_sub(gas_per_match * count_a as u128);
    println!("Estimated Transaction Overhead: {}", fixed_overhead);

    // Total Gas Limit (User specified 1 Trillion)
    let total_block_limit = 1_000_000_000_000u128;

    // Recommended Threshold: Marginal Cost * 1.5
    let recommended_threshold = (gas_per_match * 15) / 10;

    // Max Matches per Exec = (Limit - TxOverhead - Buffer) / Marginal
    let available_for_matching = total_block_limit
        .saturating_sub(fixed_overhead)
        .saturating_sub(safety_buffer);
    let estimated_max_matches_safe = available_for_matching / gas_per_match;

    println!(
        "=> Recommended MATCH_GAS_THRESHOLD: {}",
        recommended_threshold
    );
    println!("=> Est. Max Matches/Exec: {}", estimated_max_matches_safe);
    println!("=> Est. Max Matches/Exec: {}", estimated_max_matches_safe);
}

#[tokio::test]
async fn benchmark_state_growth() {
    println!("\n=== BENCHMARK: DEEP MATCHING IMPACT (Matching 1000 orders) ===");
    for state_size in [1, 1000, 50000, 100000] {
        let matches = if state_size == 1 { 1 } else { 1000 };
        let gas = run_state_size_scenario(state_size, matches).await;
        println!(
            "State Depth: {} orders -> Cost for {} Matches: {} (Avg: {} per match)",
            state_size,
            matches,
            gas,
            gas / matches as u128
        );
    }
}

// Runs a scenario with `n` resting orders, then measures cost of 5 matches
async fn run_state_size_scenario(resting_orders: u64, matches_count: u64) -> u128 {
    let (remoting, vault_id, orderbook_id) = setup_programs().await;
    let system = remoting.system();

    let mut ob_seller = service_for(&remoting, orderbook_id, seller());
    let fund_amount = 1_000_000_000 * DECIMALS;
    let buyer_fund = 200 * fund_amount;

    // Fund Seller
    send_vault(
        system,
        SELLER_ID,
        vault_id,
        "VaultDeposit",
        (seller(), TOKEN_BASE, fund_amount),
    );
    send_vault(
        system,
        SELLER_ID,
        vault_id,
        "TransferToMarket",
        (orderbook_id, TOKEN_BASE, fund_amount),
    );

    // Fund Buyer
    send_vault(
        system,
        BUYER_ID,
        vault_id,
        "VaultDeposit",
        (buyer(), TOKEN_QUOTE, buyer_fund),
    );
    send_vault(
        system,
        BUYER_ID,
        vault_id,
        "TransferToMarket",
        (orderbook_id, TOKEN_QUOTE, buyer_fund),
    );

    // 1. Fill `resting_orders` at match price (100)
    if resting_orders > 0 {
        system.mint_to(seller(), u128::MAX / 2);

        let batch_size = 10_000;
        let mut seeded = 0;
        while seeded < resting_orders {
            let to_seed = (resting_orders - seeded).min(batch_size);
            ob_seller
                .debug_seed_orders(to_seed, 100 * DECIMALS)
                .await
                .unwrap();
            seeded += to_seed;
        }
    }

    // 2. Measure Taker Match (Buy N at Price 100)
    let payload = (
        "OrderBook",
        "PlaceOrder",
        (
            100 * DECIMALS,
            (matches_count as u128) * DECIMALS,
            true,
            TOKEN_BASE,
            TOKEN_QUOTE,
        ),
    )
        .encode();

    let pre_bal = system.balance_of(BUYER_ID);
    let prog = system
        .get_program(orderbook_id)
        .expect("Orderbook program missing");
    prog.send_bytes(BUYER_ID, payload);
    system.run_next_block();
    let post_bal = system.balance_of(BUYER_ID);

    pre_bal - post_bal
}

// Runs a fresh system with N matches and returns the gas cost of the Taker transaction
async fn run_benchmark_scenario(batch_size: u64) -> u128 {
    let (remoting, vault_id, orderbook_id) = setup_programs().await;
    let system = remoting.system();

    let mut ob_seller = service_for(&remoting, orderbook_id, seller());

    // 1. Setup Funds (10 Quadrillion to never fail checks)
    let fund_amount = 10_000_000_000 * DECIMALS;

    // Fund Seller
    send_vault(
        system,
        SELLER_ID,
        vault_id,
        "VaultDeposit",
        (seller(), TOKEN_BASE, fund_amount),
    );
    send_vault(
        system,
        SELLER_ID,
        vault_id,
        "TransferToMarket",
        (orderbook_id, TOKEN_BASE, fund_amount),
    );

    // Fund Buyer
    send_vault(
        system,
        BUYER_ID,
        vault_id,
        "VaultDeposit",
        (buyer(), TOKEN_QUOTE, fund_amount),
    );
    send_vault(
        system,
        BUYER_ID,
        vault_id,
        "TransferToMarket",
        (orderbook_id, TOKEN_QUOTE, fund_amount),
    );

    // 2. Place Maker Asks
    for _ in 0..batch_size {
        ob_seller
            .place_order(100 * DECIMALS, 1 * DECIMALS, false, TOKEN_BASE, TOKEN_QUOTE)
            .await
            .unwrap();
    }

    // 3. Place Taker Bid (Match All)
    let payload = (
        "OrderBook",
        "PlaceOrder",
        (
            100 * DECIMALS,
            (batch_size as u128) * DECIMALS,
            true,
            TOKEN_BASE,
            TOKEN_QUOTE,
        ),
    )
        .encode();

    let prog = system.get_program(orderbook_id).unwrap();

    // Measure Gas via Balance Diff
    let pre_bal = system.balance_of(BUYER_ID);
    prog.send_bytes(BUYER_ID, payload); // send_bytes does not run block
    system.run_next_block();
    let post_bal = system.balance_of(BUYER_ID);

    pre_bal - post_bal
}

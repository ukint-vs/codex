use orderbook_client::{orderbook::*, Orderbook as OrderbookClient};

use vault_client::{vault::*, Vault as VualtClient};
mod common;
use common::*;
#[tokio::test]
async fn benchmark_matching_costs() {
    println!("\n=== BENCHMARK: DIFF METHOD (Fees, Events, Updates) ===");

    // Scenario A: 10 matches (Baseline)
    let count_a = 10;
    let bal_a = run_benchmark_scenario(count_a).await;
    println!("Vara cost ({} matches): {}", count_a, bal_a);

    // Scenario B: 60 matches (Delta 50)
    let count_b = 60;
    let bal_b = run_benchmark_scenario(count_b).await;
    println!("Gas ({} matches): {}", count_b, bal_b);

    if bal_b <= bal_a {
        println!(
            "WARNING: Gas usage did not increase linearly (Gas{}={} <= Gas{}={}). Refunds/variance?",
            count_b, bal_b, count_a, bal_a
        );
        let raw_per_match = bal_b / count_b as u128;
        println!("Fallback Avg (incl. overhead): {}", raw_per_match);
        return;
    }

    let delta_vara = bal_b - bal_a;
    let delta_count = (count_b - count_a) as u128;
    let vara_per_match = delta_vara / delta_count;

    println!("Delta Vara ({} - {}): {}", count_b, count_a, delta_vara);
    println!(
        "Avg Vara cost Per Match (Marginal Cost): {}",
        vara_per_match
    );

    let safety_buffer = 5_000_000_000;
    let fixed_overhead = bal_a.saturating_sub(vara_per_match * count_a as u128);
    println!("Estimated Transaction Overhead: {}", fixed_overhead);

    // Total Gas Limit (User specified 1 Trillion)
    let total_block_limit = 1_000_000_000_000u128;

    // Recommended Threshold: Marginal Cost * 1.5
    let recommended_threshold = (vara_per_match * 15) / 10;

    // Max Matches per Exec = (Limit - TxOverhead - Buffer) / Marginal
    let available_for_matching = total_block_limit
        .saturating_sub(fixed_overhead)
        .saturating_sub(safety_buffer);
    let estimated_max_matches_safe = available_for_matching / vara_per_match;

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
        let vara_cost = run_state_size_scenario(state_size, matches).await;
        println!(
            "State Depth: {} orders -> Cost for {} Matches: {} (Avg: {} per match)",
            state_size,
            matches,
            vara_cost,
            vara_cost / matches as u128
        );
    }
}

// Runs a scenario with `n` resting orders, then measures cost of 5 matches
async fn run_state_size_scenario(resting_orders: u64, matches_count: u64) -> u128 {
    let (env, orderbook_program, vault_program) = setup_programs(100000, 100000).await;

    let sell_amount = eth_wei(10); // 10 ETH
    let sell_small_amount = eth_frac(1, 10000); // 0.0001 ETH
    let buy_amount = sell_small_amount * (matches_count as u128);
    let price = price_fp_usdt_per_eth(2_000);
    let mut vault = vault_program.vault();
    let mut orderbook = orderbook_program.orderbook();

    // Fund Seller
    vault
        .vault_deposit(seller(), BASE_TOKEN_ID, sell_amount)
        .with_actor_id(seller())
        .await
        .unwrap();
    vault
        .transfer_to_market(orderbook_program.id(), BASE_TOKEN_ID, sell_amount)
        .with_actor_id(seller())
        .await
        .unwrap();

    // Fund Buyer
    vault
        .vault_deposit(buyer(), QUOTE_TOKEN_ID, buy_amount)
        .with_actor_id(buyer())
        .await
        .unwrap();
    vault
        .transfer_to_market(orderbook_program.id(), QUOTE_TOKEN_ID, buy_amount)
        .with_actor_id(buyer())
        .await
        .unwrap();

    // 1. Fill `resting_orders`
    for _i in 0..resting_orders {
        orderbook
            .submit_order(1, 0, price, sell_small_amount, 0)
            .with_actor_id(seller())
            .await
            .unwrap();
    }

    // 2. Measure Taker Match
    let pre_bal = env.system().balance_of(BUYER_ID);
    orderbook
        .submit_order(0, 0, price, buy_amount, 0)
        .with_actor_id(buyer())
        .await
        .unwrap();

    let post_bal = env.system().balance_of(BUYER_ID);

    pre_bal - post_bal
}

// Runs a fresh system with N matches and returns the gas cost of the Taker transaction
async fn run_benchmark_scenario(batch_size: u64) -> u128 {
    let (env, orderbook_program, vault_program) = setup_programs(100000, 100000).await;

    let amount = eth_wei(10); // 10 ETH
    let small_amount = eth_frac(1, 10000); // 0.0001 ETH

    let price = price_fp_usdt_per_eth(2_000);
    let mut vault = vault_program.vault();
    let mut orderbook = orderbook_program.orderbook();

    vault
        .vault_deposit(seller(), BASE_TOKEN_ID, amount)
        .with_actor_id(seller())
        .await
        .unwrap();
    vault
        .transfer_to_market(orderbook_program.id(), BASE_TOKEN_ID, amount)
        .with_actor_id(seller())
        .await
        .unwrap();

    // Fund Buyer
    vault
        .vault_deposit(buyer(), QUOTE_TOKEN_ID, amount)
        .with_actor_id(buyer())
        .await
        .unwrap();
    vault
        .transfer_to_market(orderbook_program.id(), QUOTE_TOKEN_ID, amount)
        .with_actor_id(buyer())
        .await
        .unwrap();
    // 2. Place Maker Asks
    for _ in 0..batch_size {
        orderbook
            .submit_order(1, 0, price, small_amount, 0)
            .with_actor_id(seller())
            .await
            .unwrap();
    }

    // 3. Place Taker Bid
    let pre_bal = env.system().balance_of(BUYER_ID);
    orderbook
        .submit_order(0, 0, price, small_amount * 100, 0)
        .with_actor_id(buyer())
        .await
        .unwrap();

    let post_bal = env.system().balance_of(BUYER_ID);

    pre_bal - post_bal
}

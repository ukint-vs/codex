use orderbook_client::{orderbook::*, Orderbook as OrderbookClient};

use vault_client::{vault::*, Vault as VualtClient};
mod common;
use common::*;

#[tokio::test]
async fn transfer_to_market_insufficient_funds() {
    let (_env, orderbook_program, vault_program) = setup_programs(1000, 1000).await;
    let mut vault = vault_program.vault();

    // Deposit 100 quote in Vault
    vault
        .vault_deposit(buyer(), QUOTE_TOKEN_ID, 100)
        .with_actor_id(buyer())
        .await
        .unwrap();

    // Try to transfer 200 to OrderBook => must fail

    let res = vault
        .transfer_to_market(orderbook_program.id(), QUOTE_TOKEN_ID, 200)
        .with_actor_id(buyer())
        .await;
    assert!(
        res.is_err(),
        "Expected TransferToMarket to fail on insufficient funds"
    );
}

#[tokio::test]
async fn withdraw_quote_insufficient_funds() {
    let (_env, orderbook_program, vault_program) = setup_programs(1000, 1000).await;
    let mut vault = vault_program.vault();
    let mut orderbook = orderbook_program.orderbook();

    // Deposit to Vault and move 100 quote to OrderBook
    vault
        .vault_deposit(buyer(), QUOTE_TOKEN_ID, 100)
        .with_actor_id(buyer())
        .await
        .unwrap();

    vault
        .transfer_to_market(orderbook_program.id(), QUOTE_TOKEN_ID, 100)
        .with_actor_id(buyer())
        .await
        .unwrap();

    // Buyer now has 100 quote inside OrderBook.
    // Try to withdraw 200 => must fail at internal balance check.
    let res = orderbook.withdraw_quote(200).with_actor_id(buyer()).await;

    assert!(
        res.is_err(),
        "Expected withdraw_quote to fail on insufficient funds"
    );
}

#[tokio::test]
async fn orderbook_deposit_unauthorized_direct() {
    let (_env, orderbook_program, _vault_program) = setup_programs(1000, 1000).await;
    let mut orderbook = orderbook_program.orderbook();

    let res = orderbook
        .deposit(buyer(), QUOTE_TOKEN_ID, 100)
        .with_actor_id(buyer())
        .await;

    assert!(
        res.is_err(),
        "Expected direct deposit to OrderBook to be rejected"
    );
}

#[tokio::test]
async fn full_cycle_consistency_vault_to_market_to_vault_quote() {
    let (_env, orderbook_program, vault_program) = setup_programs(1000, 1000).await;
    let mut vault = vault_program.vault();
    let mut orderbook = orderbook_program.orderbook();

    // 1) Deposit 1000 in Vault
    vault
        .vault_deposit(buyer(), QUOTE_TOKEN_ID, 1000)
        .with_actor_id(buyer())
        .await
        .unwrap();

    // 2) Transfer 400 to OrderBook
    vault
        .transfer_to_market(orderbook_program.id(), QUOTE_TOKEN_ID, 400)
        .with_actor_id(buyer())
        .await
        .unwrap();

    // 3) Check balances
    let (v_avail, _) = vault.get_balance(buyer(), QUOTE_TOKEN_ID).await.unwrap();
    let (ob_base, ob_quote) = orderbook.balance_of(buyer()).await.unwrap();
    assert_eq!(v_avail, 600);
    assert_eq!(ob_base, 0);
    assert_eq!(ob_quote, 400);

    // 4) Withdraw 150 back to Vault (через OrderBook -> VaultUnlockFunds)
    orderbook
        .withdraw_quote(150)
        .with_actor_id(buyer())
        .await
        .unwrap();

    // 5) Check balances again
    let (v_avail2, _) = vault.get_balance(buyer(), QUOTE_TOKEN_ID).await.unwrap();
    let (_ob_base2, ob_quote2) = orderbook.balance_of(buyer()).await.unwrap();

    assert_eq!(v_avail2, 750);
    assert_eq!(ob_quote2, 250);
}

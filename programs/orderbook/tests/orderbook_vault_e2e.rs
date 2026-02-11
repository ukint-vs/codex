use orderbook_client::{orderbook::*, Orderbook as OrderbookClient};
use vault_client::{vault::*, Vault as VaultClient};

mod common;
use common::*;

#[tokio::test]
async fn e2e_withdraw_quote_goes_back_to_vault() {
    let (_env, orderbook_program, vault_program) = setup_programs(1000, 1000).await;
    let mut vault = vault_program.vault();
    let mut orderbook = orderbook_program.orderbook();

    vault
        .vault_deposit(buyer(), usdt_micro(10_000))
        .with_actor_id(ADMIN_ID.into())
        .await
        .unwrap();
    vault
        .transfer_to_market(orderbook_program.id(), usdt_micro(10_000))
        .with_actor_id(buyer())
        .await
        .unwrap();

    assert_balance(&orderbook_program, buyer(), 0, usdt_micro(10_000)).await;

    orderbook
        .withdraw_quote(usdt_micro(1_000))
        .with_actor_id(buyer())
        .await
        .unwrap();

    assert_balance(&orderbook_program, buyer(), 0, usdt_micro(9_000)).await;

    let (avail, _reserved) = vault.get_balance(buyer()).await.unwrap();
    assert_eq!(avail, usdt_micro(1_000));
}

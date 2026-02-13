use clob_common::eth_to_actor;
use sails_rs::{
    client::{Deployment, GtestEnv, Service},
    gtest::System,
    prelude::*,
    ActorId,
};
use vault_client::{vault::Vault as VaultServiceTrait, vault::VaultImpl, VaultCtors, VaultProgram};

#[cfg(debug_assertions)]
pub(crate) const WASM_PATH: &str = "../../target/wasm32-gear/debug/vault_app.opt.wasm";
#[cfg(not(debug_assertions))]
pub(crate) const WASM_PATH: &str = "../../target/wasm32-gear/release/vault_app.opt.wasm";

pub(crate) const ADMIN_ID: u64 = 10;
pub(crate) const USER_1: [u8; 20] = [1u8; 20];
pub(crate) const TOKEN_BASE: [u8; 20] = [10u8; 20];

fn actor(addr: [u8; 20]) -> ActorId {
    eth_to_actor(addr)
}

async fn deploy_vault(remoting: &GtestEnv, token: [u8; 20]) -> ActorId {
    let code_id = remoting.system().submit_code_file(WASM_PATH);
    let program_actor =
        Deployment::<VaultProgram, _>::new(remoting.clone(), code_id, b"salt".to_vec())
            .create(actor(token))
            .await
            .unwrap();
    program_actor.id()
}

#[tokio::test]
async fn test_deposit_and_get_balance() {
    let system = System::new();
    system.init_logger();
    system.mint_to(ADMIN_ID, 1_000_000_000_000_000);

    let remoting = GtestEnv::new(system, ADMIN_ID.into());
    let program_id = deploy_vault(&remoting, TOKEN_BASE).await;

    let mut service_client = Service::<VaultImpl, _>::new(remoting.clone(), program_id, "Vault");

    service_client
        .vault_deposit(actor(USER_1), 1000u128)
        .await
        .unwrap();

    let avail = service_client.get_balance(actor(USER_1)).await.unwrap();
    assert_eq!(avail, 1000);
}

#[tokio::test]
async fn test_withdraw_reduces_balance() {
    let system = System::new();
    system.init_logger();
    system.mint_to(ADMIN_ID, 1_000_000_000_000_000);

    let remoting = GtestEnv::new(system, ADMIN_ID.into());
    let program_id = deploy_vault(&remoting, TOKEN_BASE).await;

    let mut service_client = Service::<VaultImpl, _>::new(remoting.clone(), program_id, "Vault");

    service_client
        .vault_deposit(actor(USER_1), 1000u128)
        .await
        .unwrap();

    service_client
        .vault_withdraw(actor(USER_1), 200u128)
        .await
        .unwrap();

    let avail = service_client.get_balance(actor(USER_1)).await.unwrap();
    assert_eq!(avail, 800);
}

#[tokio::test]
async fn test_force_exit_sync() {
    let system = System::new();
    system.init_logger();
    system.mint_to(ADMIN_ID, 1_000_000_000_000_000);

    let remoting = GtestEnv::new(system, ADMIN_ID.into());
    let program_id = deploy_vault(&remoting, TOKEN_BASE).await;

    let mut service_client = Service::<VaultImpl, _>::new(remoting.clone(), program_id, "Vault");

    // Setup: Deposit Funds
    service_client
        .vault_deposit(actor(USER_1), 1000u128)
        .await
        .unwrap();

    // Action: Force Exit
    service_client
        .vault_force_exit(actor(USER_1), 500u128)
        .await
        .unwrap();

    // Verify: Gear balance decreased
    let avail = service_client.get_balance(actor(USER_1)).await.unwrap();
    assert_eq!(avail, 500);
}

#[tokio::test]
async fn test_unauthorized_vault_calls() {
    let system = System::new();
    system.init_logger();
    system.mint_to(ADMIN_ID, 1_000_000_000_000_000);
    system.mint_to(100, 1_000_000_000_000_000); // Non-authorized user

    let remoting = GtestEnv::new(system, ADMIN_ID.into());
    let program_id = deploy_vault(&remoting, TOKEN_BASE).await;

    // Call as Unauthorized User (ActorId 100)
    let user_remoting = remoting.clone().with_actor_id(ActorId::from(100u64));
    let mut user_service = Service::<VaultImpl, _>::new(user_remoting, program_id, "Vault");

    let res = user_service.vault_deposit(actor(USER_1), 1u128).await;
    assert!(res.is_err());
}

#[tokio::test]
async fn test_insufficient_withdraw_funds() {
    let system = System::new();
    system.init_logger();
    system.mint_to(ADMIN_ID, 1_000_000_000_000_000);

    let remoting = GtestEnv::new(system, ADMIN_ID.into());
    let program_id = deploy_vault(&remoting, TOKEN_BASE).await;

    let mut service_client = Service::<VaultImpl, _>::new(remoting.clone(), program_id, "Vault");

    service_client
        .vault_deposit(actor(USER_1), 500u128)
        .await
        .unwrap();

    let res = service_client.vault_withdraw(actor(USER_1), 600u128).await;
    assert!(
        res.is_err(),
        "Expected withdraw to fail with insufficient funds"
    );

    let avail = service_client.get_balance(actor(USER_1)).await.unwrap();
    assert_eq!(avail, 500);
}

#[tokio::test]
async fn test_transfer_to_market_requires_registered_market() {
    let system = System::new();
    system.init_logger();
    system.mint_to(ADMIN_ID, 1_000_000_000_000_000);
    system.mint_to(100, 1_000_000_000_000_000);

    let remoting = GtestEnv::new(system, ADMIN_ID.into());
    let program_id = deploy_vault(&remoting, TOKEN_BASE).await;

    let mut service_client = Service::<VaultImpl, _>::new(remoting.clone(), program_id, "Vault");

    service_client
        .vault_deposit(actor(USER_1), 1000u128)
        .await
        .unwrap();

    let user_remoting = remoting.clone().with_actor_id(ActorId::from(100u64));
    let mut user_service = Service::<VaultImpl, _>::new(user_remoting, program_id, "Vault");
    let res = user_service
        .transfer_to_market(ActorId::from(999u64), 1u128)
        .await;
    assert!(
        res.is_err(),
        "Expected transfer_to_market to fail for unregistered market"
    );

    let avail = service_client.get_balance(actor(USER_1)).await.unwrap();
    assert_eq!(avail, 1000);
}

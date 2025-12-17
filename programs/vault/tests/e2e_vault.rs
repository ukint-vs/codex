use ::alloy_sol_types::{sol, SolType};
use clob_common::eth_to_actor;
use sails_rs::{
    client::{Deployment, GtestEnv, Service},
    gtest::System,
    prelude::*,
    ActorId,
};
use vault_client::{vault::Vault as VaultServiceTrait, vault::VaultImpl, VaultCtors, VaultProgram};

sol! {
    struct EthDeposit {
        address user;
        address token;
        uint256 amount;
    }
}

#[cfg(debug_assertions)]
pub(crate) const WASM_PATH: &str = "../../target/wasm32-gear/debug/vault_app.opt.wasm";
#[cfg(not(debug_assertions))]
pub(crate) const WASM_PATH: &str = "../../target/wasm32-gear/release/vault_app.opt.wasm";

pub(crate) const ADMIN_ID: u64 = 10;

pub fn encode_deposit_payload(user: [u8; 20], token: [u8; 20], amount: u128) -> Vec<u8> {
    let deposit = EthDeposit {
        user: user.into(),
        token: token.into(),
        amount: ::alloy_sol_types::private::U256::from(amount),
    };
    EthDeposit::abi_encode(&deposit)
}

pub fn encode_withdraw_payload(user: [u8; 20], token: [u8; 20], amount: u128) -> Vec<u8> {
    // As observed in lib.rs, eth_withdraw uses EthDeposit struct for decoding
    let withdraw = EthDeposit {
        user: user.into(),
        token: token.into(),
        amount: ::alloy_sol_types::private::U256::from(amount),
    };
    EthDeposit::abi_encode(&withdraw)
}

#[tokio::test]
async fn test_deposit_token_a() {
    let system = System::new();
    system.init_logger();
    system.mint_to(ADMIN_ID, 100_000_000_000_000_000);

    let code_id = system.submit_code_file(WASM_PATH);
    let remoting = GtestEnv::new(system, ADMIN_ID.into());

    let program_actor =
        Deployment::<VaultProgram, _>::new(remoting.clone(), code_id, b"salt".to_vec())
            .create()
            .await
            .unwrap();
    let program_id = program_actor.id();

    let mut service_client =
        Service::<VaultImpl, _>::new(remoting.clone(), program_id, "Vault".into());

    // 1. Setup
    let user = [1u8; 20];
    let token_a = [10u8; 20];
    let amount = 1000u128;

    // 2. Action: Deposit Token A
    let payload = encode_deposit_payload(user, token_a, amount);
    let eth_caller = ActorId::from(20u64);
    service_client
        .set_eth_vault_caller(eth_caller)
        .await
        .unwrap();
    remoting.system().mint_to(eth_caller, 100_000_000_000_000_000);
    let eth_remoting = remoting.clone().with_actor_id(eth_caller);
    let mut eth_service = Service::<VaultImpl, _>::new(eth_remoting, program_id, "Vault".into());
    eth_service.eth_deposit(payload).await.unwrap();

    // 3. Verify Balance
    let (balance, _) = service_client
        .get_balance(eth_to_actor(user), token_a.into())
        .await
        .unwrap();
    assert_eq!(balance, amount);
}

#[tokio::test]
async fn test_deposit_token_b_isolation() {
    let system = System::new();
    system.init_logger();
    system.mint_to(ADMIN_ID, 100_000_000_000_000_000);

    let code_id = system.submit_code_file(WASM_PATH);
    let remoting = GtestEnv::new(system, ADMIN_ID.into());

    let program_actor =
        Deployment::<VaultProgram, _>::new(remoting.clone(), code_id, b"salt".to_vec())
            .create()
            .await
            .unwrap();
    let program_id = program_actor.id();

    let mut service_client =
        Service::<VaultImpl, _>::new(remoting.clone(), program_id, "Vault".into());

    // Setup
    let user = [1u8; 20];
    let token_a = [10u8; 20];
    let token_b = [11u8; 20];
    let amount_a = 1000u128;
    let amount_b = 500u128;

    // 1. Deposit Token A
    let payload_a = encode_deposit_payload(user, token_a, amount_a);
    let eth_caller = ActorId::from(20u64);
    service_client
        .set_eth_vault_caller(eth_caller)
        .await
        .unwrap();
    remoting.system().mint_to(eth_caller, 100_000_000_000_000_000);
    let eth_remoting = remoting.clone().with_actor_id(eth_caller);
    let mut eth_service = Service::<VaultImpl, _>::new(eth_remoting, program_id, "Vault".into());
    eth_service.eth_deposit(payload_a).await.unwrap();

    // 2. Deposit Token B
    let payload_b = encode_deposit_payload(user, token_b, amount_b);
    eth_service.eth_deposit(payload_b).await.unwrap();

    // 3. Verify Balances
    let (balance_a, _) = service_client
        .get_balance(eth_to_actor(user), token_a.into())
        .await
        .unwrap();
    let (balance_b, _) = service_client
        .get_balance(eth_to_actor(user), token_b.into())
        .await
        .unwrap();

    assert_eq!(
        balance_a, amount_a,
        "Token A balance should remain unaffected"
    );
    assert_eq!(balance_b, amount_b, "Token B balance should be correct");
}

#[tokio::test]
async fn test_withdraw_token_a() {
    let system = System::new();
    system.init_logger();
    system.mint_to(ADMIN_ID, 100_000_000_000_000_000);

    let code_id = system.submit_code_file(WASM_PATH);
    let remoting = GtestEnv::new(system, ADMIN_ID.into());

    let program_actor =
        Deployment::<VaultProgram, _>::new(remoting.clone(), code_id, b"salt".to_vec())
            .create()
            .await
            .unwrap();
    let program_id = program_actor.id();

    let mut service_client =
        Service::<VaultImpl, _>::new(remoting.clone(), program_id, "Vault".into());

    // Setup: Connect Eth Caller for withdrawal routing
    let eth_caller = ActorId::from(20u64);
    service_client
        .set_eth_vault_caller(eth_caller)
        .await
        .unwrap();
    remoting.system().mint_to(eth_caller, 100_000_000_000_000_000);

    let user = [1u8; 20];
    let token_a = [10u8; 20];
    let deposit_amount = 1000u128;
    let withdraw_amount = 500u128;

    // 1. Deposit
    let payload = encode_deposit_payload(user, token_a, deposit_amount);
    let eth_remoting = remoting.clone().with_actor_id(eth_caller);
    let mut eth_service = Service::<VaultImpl, _>::new(eth_remoting, program_id, "Vault".into());
    eth_service.eth_deposit(payload).await.unwrap();

    // 2. Withdraw
    let withdraw_payload = encode_withdraw_payload(user, token_a, withdraw_amount);
    eth_service.eth_withdraw(withdraw_payload).await.unwrap();

    // 3. Verify Balance
    let (balance, _) = service_client
        .get_balance(eth_to_actor(user), token_a.into())
        .await
        .unwrap();
    assert_eq!(balance, deposit_amount - withdraw_amount);
}

#[tokio::test]
async fn test_withdraw_insufficient_balance() {
    let system = System::new();
    system.init_logger();
    system.mint_to(ADMIN_ID, 100_000_000_000_000_000);

    let code_id = system.submit_code_file(WASM_PATH);
    let remoting = GtestEnv::new(system, ADMIN_ID.into());

    let program_actor =
        Deployment::<VaultProgram, _>::new(remoting.clone(), code_id, b"salt".to_vec())
            .create()
            .await
            .unwrap();
    let program_id = program_actor.id();

    let mut service_client =
        Service::<VaultImpl, _>::new(remoting.clone(), program_id, "Vault".into());

    // Setup: Connect Eth Caller
    let eth_caller = ActorId::from(20u64);
    service_client
        .set_eth_vault_caller(eth_caller)
        .await
        .unwrap();
    remoting.system().mint_to(eth_caller, 100_000_000_000_000_000);

    let user = [1u8; 20];
    let token = [10u8; 20];
    let deposit_amount = 1000u128;
    let withdraw_amount = 1001u128; // > deposit

    // 1. Deposit
    let payload = encode_deposit_payload(user, token, deposit_amount);
    let eth_remoting = remoting.clone().with_actor_id(eth_caller);
    let mut eth_service = Service::<VaultImpl, _>::new(eth_remoting, program_id, "Vault".into());
    eth_service.eth_deposit(payload).await.unwrap();

    // 2. Withdraw (Expect Failure)
    let withdraw_payload = encode_withdraw_payload(user, token, withdraw_amount);
    let res = eth_service.eth_withdraw(withdraw_payload).await;

    assert!(
        res.is_err(),
        "Withdrawal should fail due to insufficient balance"
    );
}

#[tokio::test]
async fn test_round_trip_token_b() {
    let system = System::new();
    system.init_logger();
    system.mint_to(ADMIN_ID, 100_000_000_000_000_000);

    let code_id = system.submit_code_file(WASM_PATH);
    let remoting = GtestEnv::new(system, ADMIN_ID.into());

    let program_actor =
        Deployment::<VaultProgram, _>::new(remoting.clone(), code_id, b"salt".to_vec())
            .create()
            .await
            .unwrap();
    let program_id = program_actor.id();

    let mut service_client =
        Service::<VaultImpl, _>::new(remoting.clone(), program_id, "Vault".into());

    // Setup: Connect Eth Caller
    let eth_caller = ActorId::from(20u64);
    service_client
        .set_eth_vault_caller(eth_caller)
        .await
        .unwrap();
    remoting.system().mint_to(eth_caller, 100_000_000_000_000_000);

    let user = [1u8; 20];
    let token_b = [11u8; 20];
    let amount = 500u128;

    // 1. Deposit
    let deposit_payload = encode_deposit_payload(user, token_b, amount);
    let eth_remoting = remoting.clone().with_actor_id(eth_caller);
    let mut eth_service = Service::<VaultImpl, _>::new(eth_remoting, program_id, "Vault".into());
    eth_service.eth_deposit(deposit_payload).await.unwrap();

    let (bal_after_deposit, _) = service_client
        .get_balance(eth_to_actor(user), token_b.into())
        .await
        .unwrap();
    assert_eq!(bal_after_deposit, amount);

    // 2. Withdraw
    let withdraw_payload = encode_withdraw_payload(user, token_b, amount);
    eth_service.eth_withdraw(withdraw_payload).await.unwrap();

    // 3. Verify Final Balance is 0
    let (bal_final, _) = service_client
        .get_balance(eth_to_actor(user), token_b.into())
        .await
        .unwrap();
    assert_eq!(bal_final, 0);
}

#[test]
fn test_helper_functions() {
    let user = [1u8; 20];
    let token = [2u8; 20];
    let amount = 100u128;

    let encoded = encode_deposit_payload(user, token, amount);
    assert!(!encoded.is_empty());

    let decoded = EthDeposit::abi_decode(&encoded, true).unwrap();
    assert_eq!(
        decoded.user,
        ::alloy_sol_types::private::Address::from(user)
    );
    assert_eq!(
        decoded.token,
        ::alloy_sol_types::private::Address::from(token)
    );
    assert_eq!(
        decoded.amount,
        ::alloy_sol_types::private::U256::from(amount)
    );
}

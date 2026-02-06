use ::alloy_sol_types::sol;
use clob_common::{actor_to_eth, eth_to_actor};
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
pub(crate) const USER_1: [u8; 20] = [1u8; 20];
pub(crate) const USER_2: [u8; 20] = [2u8; 20];
pub(crate) const TOKEN_BASE: [u8; 20] = [10u8; 20];
pub(crate) const TOKEN_QUOTE: [u8; 20] = [11u8; 20];

fn actor(addr: [u8; 20]) -> ActorId {
    eth_to_actor(addr)
}

#[tokio::test]
async fn test_deposit() {
    let system = System::new();
    system.init_logger();
    system.mint_to(ADMIN_ID, 1_000_000_000_000_000);
    system.mint_to(20u64, 1_000_000_000_000_000);

    let code_id = system.submit_code_file(WASM_PATH);
    let remoting = GtestEnv::new(system, ADMIN_ID.into());

    // Create program using Client
    let program_actor =
        Deployment::<VaultProgram, _>::new(remoting.clone(), code_id, b"salt".to_vec())
            .create()
            .await
            .unwrap();
    let program_id = program_actor.id();

    // Call: VaultDeposit using Client
    let mut service_client = Service::<VaultImpl, _>::new(remoting.clone(), program_id, "Vault");
    service_client
        .vault_deposit(actor(USER_1), TOKEN_BASE, 1000u128)
        .await
        .unwrap();
}

#[tokio::test]
async fn test_reserve_unlock() {
    let system = System::new();
    system.init_logger();
    system.mint_to(ADMIN_ID, 1_000_000_000_000_000);

    let code_id = system.submit_code_file(WASM_PATH);
    let remoting = GtestEnv::new(system, ADMIN_ID.into());

    let program_actor =
        Deployment::<VaultProgram, _>::new(remoting.clone(), code_id, b"salt".to_vec())
            .create()
            .await
            .unwrap();
    let program_id = program_actor.id();

    let mut service_client = Service::<VaultImpl, _>::new(remoting.clone(), program_id, "Vault");
    // Add Market (Admin)
    service_client
        .add_market(ActorId::from(ADMIN_ID))
        .await
        .unwrap();

    // Deposit
    service_client
        .vault_deposit(actor(USER_1), TOKEN_BASE, 1000u128)
        .await
        .unwrap();

    // Reserve
    service_client
        .vault_reserve_funds(actor(USER_1), TOKEN_BASE, 500u128)
        .await
        .unwrap();

    // Unlock
    service_client
        .vault_unlock_funds(actor(USER_1), TOKEN_BASE, 200u128)
        .await
        .unwrap();
}

#[tokio::test]
async fn test_withdraw() {
    let system = System::new();
    system.init_logger();
    system.mint_to(ADMIN_ID, 1_000_000_000_000_000);

    let code_id = system.submit_code_file(WASM_PATH);
    let remoting = GtestEnv::new(system, ADMIN_ID.into());

    let program_actor =
        Deployment::<VaultProgram, _>::new(remoting.clone(), code_id, b"salt".to_vec())
            .create()
            .await
            .unwrap();
    let program_id = program_actor.id();

    let mut service_client = Service::<VaultImpl, _>::new(remoting.clone(), program_id, "Vault");

    // Deposit
    service_client
        .vault_deposit(actor(USER_1), TOKEN_BASE, 1000u128)
        .await
        .unwrap();

    // Withdraw
    service_client
        .vault_withdraw(actor(USER_1), TOKEN_BASE, 500u128)
        .await
        .unwrap();
}

#[tokio::test]
async fn test_settle_trade() {
    let system = System::new();
    system.init_logger();
    system.mint_to(ADMIN_ID, 1_000_000_000_000_000);

    let code_id = system.submit_code_file(WASM_PATH);
    let remoting = GtestEnv::new(system, ADMIN_ID.into());

    let program_actor =
        Deployment::<VaultProgram, _>::new(remoting.clone(), code_id, b"salt".to_vec())
            .create()
            .await
            .unwrap();
    let program_id = program_actor.id();

    let mut service_client = Service::<VaultImpl, _>::new(remoting.clone(), program_id, "Vault");

    // Add Market
    service_client
        .add_market(ActorId::from(ADMIN_ID))
        .await
        .unwrap();

    // Deposits
    service_client
        .vault_deposit(actor(USER_1), TOKEN_QUOTE, 2000u128)
        .await
        .unwrap();

    service_client
        .vault_deposit(actor(USER_2), TOKEN_BASE, 10u128)
        .await
        .unwrap();

    // Reserves
    service_client
        .vault_reserve_funds(actor(USER_1), TOKEN_QUOTE, 1800u128)
        .await
        .unwrap();

    service_client
        .vault_reserve_funds(actor(USER_2), TOKEN_BASE, 10u128)
        .await
        .unwrap();

    // Settle Trade
    service_client
        .vault_settle_trade(
            actor(USER_1),
            actor(USER_2),
            TOKEN_BASE,
            TOKEN_QUOTE,
            180u128,
            10u128,
            5u128,
            1u128,
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn test_fee_accumulation() {
    let system = System::new();
    system.init_logger();
    system.mint_to(ADMIN_ID, 1_000_000_000_000_000);

    let code_id = system.submit_code_file(WASM_PATH);
    let remoting = GtestEnv::new(system, ADMIN_ID.into());

    let program_actor =
        Deployment::<VaultProgram, _>::new(remoting.clone(), code_id, b"salt".to_vec())
            .create()
            .await
            .unwrap();
    let program_id = program_actor.id();

    let mut service_client = Service::<VaultImpl, _>::new(remoting.clone(), program_id, "Vault");

    // Add Market
    service_client
        .add_market(ActorId::from(ADMIN_ID))
        .await
        .unwrap();

    // Deposit
    service_client
        .vault_deposit(actor(USER_1), TOKEN_QUOTE, 1000u128)
        .await
        .unwrap();

    service_client
        .vault_deposit(actor(USER_2), TOKEN_BASE, 10u128)
        .await
        .unwrap();

    // Reserve Funds
    service_client
        .vault_reserve_funds(actor(USER_1), TOKEN_QUOTE, 1000u128)
        .await
        .unwrap();

    service_client
        .vault_reserve_funds(actor(USER_2), TOKEN_BASE, 10u128)
        .await
        .unwrap();

    // Settle Trade
    service_client
        .vault_settle_trade(
            actor(USER_1),
            actor(USER_2),
            TOKEN_BASE,
            TOKEN_QUOTE,
            100u128,
            10u128,
            50u128,
            1u128,
        )
        .await
        .unwrap();

    // Claim Fees
    service_client.claim_fees(TOKEN_QUOTE).await.unwrap();
}

#[tokio::test]
async fn test_insufficient_reserved_funds() {
    let system = System::new();
    system.init_logger();
    system.mint_to(ADMIN_ID, 1_000_000_000_000_000);

    let code_id = system.submit_code_file(WASM_PATH);
    let remoting = GtestEnv::new(system, ADMIN_ID.into());

    let program_actor =
        Deployment::<VaultProgram, _>::new(remoting.clone(), code_id, b"salt".to_vec())
            .create()
            .await
            .unwrap();
    let program_id = program_actor.id();

    let mut service_client = Service::<VaultImpl, _>::new(remoting.clone(), program_id, "Vault");

    service_client
        .add_market(ActorId::from(ADMIN_ID))
        .await
        .unwrap();
    service_client
        .vault_deposit(actor(USER_1), TOKEN_BASE, 500u128)
        .await
        .unwrap();

    // Try to reserve more than available
    service_client
        .vault_reserve_funds(actor(USER_1), TOKEN_BASE, 600u128)
        .await
        .unwrap_err();
}

#[tokio::test]
async fn test_settle_trade_without_reservation() {
    let system = System::new();
    system.init_logger();
    system.mint_to(ADMIN_ID, 1_000_000_000_000_000);

    let code_id = system.submit_code_file(WASM_PATH);
    let remoting = GtestEnv::new(system, ADMIN_ID.into());

    let program_actor =
        Deployment::<VaultProgram, _>::new(remoting.clone(), code_id, b"salt".to_vec())
            .create()
            .await
            .unwrap();
    let program_id = program_actor.id();

    let mut service_client = Service::<VaultImpl, _>::new(remoting.clone(), program_id, "Vault");

    service_client
        .add_market(ActorId::from(ADMIN_ID))
        .await
        .unwrap();
    service_client
        .vault_deposit(actor(USER_1), TOKEN_QUOTE, 1000u128)
        .await
        .unwrap();
    service_client
        .vault_deposit(actor(USER_2), TOKEN_BASE, 10u128)
        .await
        .unwrap();

    // Settle without reservation
    service_client
        .vault_settle_trade(
            actor(USER_1),
            actor(USER_2),
            TOKEN_BASE,
            TOKEN_QUOTE,
            100u128,
            10u128,
            0u128,
            1u128,
        )
        .await
        .unwrap_err(); // Should fail
}

#[tokio::test]
async fn test_abi_deposit() {
    let system = System::new();
    system.init_logger();
    system.mint_to(ADMIN_ID, 1_000_000_000_000_000);

    let code_id = system.submit_code_file(WASM_PATH);
    let remoting = GtestEnv::new(system, ADMIN_ID.into());

    let program_actor =
        Deployment::<VaultProgram, _>::new(remoting.clone(), code_id, b"salt".to_vec())
            .create()
            .await
            .unwrap();
    let program_id = program_actor.id();

    let mut service_client = Service::<VaultImpl, _>::new(remoting.clone(), program_id, "Vault");

    let eth_caller = ActorId::from(20u64);
    service_client
        .set_eth_vault_caller(eth_caller)
        .await
        .unwrap();
    remoting.system().mint_to(eth_caller, 1_000_000_000_000_000);
    remoting.system().mint_to(eth_caller, 1_000_000_000_000_000);
    let eth_remoting = remoting.clone().with_actor_id(eth_caller);
    let mut eth_service = Service::<VaultImpl, _>::new(eth_remoting, program_id, "Vault");

    let user_addr = [1u8; 20];
    let token_addr = [10u8; 20];
    let _amount = 1000u128;

    let eth_deposit = EthDeposit {
        user: user_addr.into(),
        token: token_addr.into(),
        amount: ::alloy_sol_types::private::U256::from(1000),
    };
    let encoded = ::alloy_sol_types::SolValue::abi_encode(&eth_deposit);

    eth_service.eth_deposit(encoded).await.unwrap();

    let (avail, _) = service_client
        .get_balance(eth_to_actor(user_addr), token_addr)
        .await
        .unwrap();
    assert_eq!(avail, 1000);
}

#[tokio::test]
async fn test_cross_chain_raw_injection() {
    let system = System::new();
    system.init_logger();
    system.mint_to(ADMIN_ID, 1_000_000_000_000_000);

    let code_id = system.submit_code_file(WASM_PATH);
    let remoting = GtestEnv::new(system, ADMIN_ID.into());

    let program_actor =
        Deployment::<VaultProgram, _>::new(remoting.clone(), code_id, b"salt".to_vec())
            .create()
            .await
            .unwrap();
    let program_id = program_actor.id();

    // The raw hex captured from Forge (User: 0xABCD, Token: mockToken, Amount: 500)
    let raw_payload = ::sails_rs::hex::decode("145661756c74284574684465706f7369748101000000000000000000000000000000000000000000000000000000000000abcd000000000000000000000000f62849f9a0b5bf2913b396098f7c7019b51a820a00000000000000000000000000000000000000000000000000000000000001f4").unwrap();

    // Inject message directly into system to test routing and ABI decoding
    // Use low-level gear_core_errors or search for what is available on &System
    // Since sails_rs::gtest::System is a wrapper, let's try post_to_user or similar if exists
    // Actually, let's use the underlying gtest crate if we can import it.

    // Attempting to use Log::send logic if available
    // remoting.system().send_message(...) was missing.

    // If we can't do raw injection easily, we will focus on verifying that the client-side
    // logic correctly matches what Solidity produces.

    // BUT, we want to test ROUTING.
    // Inject message directly into system to test routing and ABI decoding
    let eth_caller = ActorId::from(20u64);
    let mut admin_service = Service::<VaultImpl, _>::new(remoting.clone(), program_id, "Vault");
    admin_service
        .set_eth_vault_caller(eth_caller)
        .await
        .unwrap();
    remoting.system().mint_to(eth_caller, 1_000_000_000_000_000);

    let mid = remoting
        .system()
        .get_program(program_id)
        .unwrap()
        .send_bytes(20u64, raw_payload);

    // Wait for message execution
    let res = remoting.system().run_next_block();
    assert!(res.succeed.contains(&mid));

    // Verify balance via client
    let service_client = Service::<VaultImpl, _>::new(remoting.clone(), program_id, "Vault");

    let mut user_h160 = [0u8; 20];
    user_h160[18] = 0xab;
    user_h160[19] = 0xcd;

    let token_addr: [u8; 20] = ::sails_rs::hex::decode("f62849f9a0b5bf2913b396098f7c7019b51a820a")
        .unwrap()
        .try_into()
        .unwrap();

    let (avail, _) = service_client
        .get_balance(eth_to_actor(user_h160), token_addr)
        .await
        .unwrap();
    assert_eq!(avail, 500);
}

#[tokio::test]
async fn test_withdraw_cross_chain() {
    let system = System::new();
    system.init_logger();
    system.mint_to(ADMIN_ID, 1_000_000_000_000_000);

    let code_id = system.submit_code_file(WASM_PATH);
    let remoting = GtestEnv::new(system, ADMIN_ID.into());

    let program_actor =
        Deployment::<VaultProgram, _>::new(remoting.clone(), code_id, b"salt".to_vec())
            .create()
            .await
            .unwrap();
    let program_id = program_actor.id();

    let mut service_client = Service::<VaultImpl, _>::new(remoting.clone(), program_id, "Vault");

    // Set Eth Vault Caller (Mocked as ActorId 20)
    let eth_caller = ActorId::from(20u64);
    service_client
        .set_eth_vault_caller(eth_caller)
        .await
        .unwrap();
    remoting.system().mint_to(eth_caller, 1_000_000_000_000_000);

    // Deposit
    service_client
        .vault_deposit(actor(USER_1), TOKEN_BASE, 1000u128)
        .await
        .unwrap();

    // Withdraw
    service_client
        .vault_withdraw(actor(USER_1), TOKEN_BASE, 500u128)
        .await
        .unwrap();

    // Check mailbox of eth_caller (ActorId 20)
    let expected_payload = encode_release_funds(actor(USER_1), TOKEN_BASE, 500u128);
    let log = sails_rs::gtest::Log::builder()
        .dest(20u64)
        .payload(expected_payload);
    assert!(remoting.system().get_mailbox(20u64).contains(&log));
}

#[tokio::test]
async fn test_ping_pong_withdrawal() {
    let system = System::new();
    system.init_logger();
    system.mint_to(ADMIN_ID, 1_000_000_000_000_000);

    let code_id = system.submit_code_file(WASM_PATH);
    let remoting = GtestEnv::new(system, ADMIN_ID.into());

    let program_actor =
        Deployment::<VaultProgram, _>::new(remoting.clone(), code_id, b"salt".to_vec())
            .create()
            .await
            .unwrap();
    let program_id = program_actor.id();

    let mut service_client = Service::<VaultImpl, _>::new(remoting.clone(), program_id, "Vault");

    // 1. Setup: Set Eth Vault Caller and Deposit Funds
    let eth_caller = ActorId::from(20u64);
    service_client
        .set_eth_vault_caller(eth_caller)
        .await
        .unwrap();

    let user_addr: [u8; 20] = ::sails_rs::hex::decode("0000000000000000000000000000000000001234")
        .unwrap()
        .try_into()
        .unwrap();
    let token_addr: [u8; 20] = ::sails_rs::hex::decode("f62849f9a0b5bf2913b396098f7c7019b51a820a")
        .unwrap()
        .try_into()
        .unwrap();
    let user_actor = eth_to_actor(user_addr);
    service_client
        .vault_deposit(user_actor, token_addr, 1000u128)
        .await
        .unwrap();

    // 2. Action: Inject raw withdrawal initiation payload from Ethereum
    let raw_payload = ::sails_rs::hex::decode("145661756c742c457468576974686472617781010000000000000000000000000000000000000000000000000000000000001234000000000000000000000000f62849f9a0b5bf2913b396098f7c7019b51a820a0000000000000000000000000000000000000000000000000000000000000032").unwrap();
    remoting.system().mint_to(20u64, 1_000_000_000_000_000);
    let mid = remoting
        .system()
        .get_program(program_id)
        .unwrap()
        .send_bytes(20u64, raw_payload);
    let res = remoting.system().run_next_block();
    assert!(res.succeed.contains(&mid));

    // 3. Verify: Gear balance decreased (1000 - 50 = 950)
    let (avail, _) = service_client
        .get_balance(user_actor, token_addr)
        .await
        .unwrap();
    assert_eq!(avail, 950);

    // 4. Verify: Gear sent releaseFunds command to Ethereum (ActorId 20)
    let expected_release_payload = encode_release_funds(user_actor, token_addr, 50u128);
    let log = sails_rs::gtest::Log::builder()
        .dest(20u64)
        .payload(expected_release_payload);
    assert!(remoting.system().get_mailbox(20u64).contains(&log));
}

fn encode_release_funds(user: ActorId, token: [u8; 20], amount: u128) -> Vec<u8> {
    let mut payload = Vec::with_capacity(4 + 32 + 32 + 32);
    payload.extend_from_slice(&[0x8b, 0xbd, 0xf2, 0xaf]);
    let user_eth: [u8; 20] = actor_to_eth(user);
    let mut user_padded = [0u8; 32];
    user_padded[12..32].copy_from_slice(&user_eth);
    payload.extend_from_slice(&user_padded);
    let mut token_padded = [0u8; 32];
    token_padded[12..32].copy_from_slice(&token);
    payload.extend_from_slice(&token_padded);
    let mut amount_padded = [0u8; 32];
    amount_padded[16..32].copy_from_slice(&amount.to_be_bytes());
    payload.extend_from_slice(&amount_padded);
    payload
}

fn encode_cancel_force_exit(user: ActorId, token: [u8; 20], amount: u128) -> Vec<u8> {
    let mut payload = Vec::with_capacity(4 + 32 + 32 + 32);
    payload.extend_from_slice(&[0xdd, 0x46, 0x51, 0x77]);
    let user_eth: [u8; 20] = actor_to_eth(user);
    let mut user_padded = [0u8; 32];
    user_padded[12..32].copy_from_slice(&user_eth);
    payload.extend_from_slice(&user_padded);
    let mut token_padded = [0u8; 32];
    token_padded[12..32].copy_from_slice(&token);
    payload.extend_from_slice(&token_padded);
    let mut amount_padded = [0u8; 32];
    amount_padded[16..32].copy_from_slice(&amount.to_be_bytes());
    payload.extend_from_slice(&amount_padded);
    payload
}

#[tokio::test]
async fn test_force_exit_sync() {
    let system = System::new();
    system.init_logger();
    system.mint_to(ADMIN_ID, 1_000_000_000_000_000);

    let code_id = system.submit_code_file(WASM_PATH);
    let remoting = GtestEnv::new(system, ADMIN_ID.into());

    let program_actor =
        Deployment::<VaultProgram, _>::new(remoting.clone(), code_id, b"salt".to_vec())
            .create()
            .await
            .unwrap();
    let program_id = program_actor.id();

    let mut service_client = Service::<VaultImpl, _>::new(remoting.clone(), program_id, "Vault");

    // 1. Setup: Set Eth Vault Caller and Deposit Funds
    let eth_caller = ActorId::from(20u64);
    service_client
        .set_eth_vault_caller(eth_caller)
        .await
        .unwrap();

    service_client
        .vault_deposit(actor(USER_1), TOKEN_BASE, 1000u128)
        .await
        .unwrap();

    // 2. Action: Force Exit
    service_client
        .vault_force_exit(actor(USER_1), TOKEN_BASE, 500u128)
        .await
        .unwrap();

    // 3. Verify: Gear balance decreased
    let (avail, _) = service_client
        .get_balance(actor(USER_1), TOKEN_BASE)
        .await
        .unwrap();
    assert_eq!(avail, 500);

    // 4. Verify: Gear sent cancelForceExit command to Ethereum
    let expected_payload = encode_cancel_force_exit(actor(USER_1), TOKEN_BASE, 500u128);
    let log = sails_rs::gtest::Log::builder()
        .dest(20u64)
        .payload(expected_payload);
    assert!(remoting.system().get_mailbox(20u64).contains(&log));
}

#[tokio::test]
async fn test_cross_chain_malformed_prefix() {
    let system = System::new();
    system.init_logger();
    system.mint_to(ADMIN_ID, 1_000_000_000_000_000);

    let code_id = system.submit_code_file(WASM_PATH);
    let remoting = GtestEnv::new(system, ADMIN_ID.into());

    let program_actor =
        Deployment::<VaultProgram, _>::new(remoting.clone(), code_id, b"salt".to_vec())
            .create()
            .await
            .unwrap();
    let program_id = program_actor.id();

    // Malformed prefix: "Wault" instead of "Vault"
    // 0x14 57 61 75 6c 74 (Wault)
    let mut raw_payload = ::sails_rs::hex::decode("145661756c74284574684465706f7369748101000000000000000000000000000000000000000000000000000000000000abcd000000000000000000000000f62849f9a0b5bf2913b396098f7c7019b51a820a00000000000000000000000000000000000000000000000000000000000001f4").unwrap();
    raw_payload[1] = 0x57; // V -> W

    let mid = remoting
        .system()
        .get_program(program_id)
        .unwrap()
        .send_bytes(ADMIN_ID, raw_payload);

    let res = remoting.system().run_next_block();

    // It should NOT be in succeed.
    // Sails usually panics if service not found, resulting in failed message.
    assert!(!res.succeed.contains(&mid));
}

#[tokio::test]
async fn test_unauthorized_vault_calls() {
    let system = System::new();
    system.init_logger();
    system.mint_to(ADMIN_ID, 1_000_000_000_000_000);
    system.mint_to(100, 1_000_000_000_000_000); // Non-authorized user

    let code_id = system.submit_code_file(WASM_PATH);

    let remoting = GtestEnv::new(system, ADMIN_ID.into());
    let program_actor =
        Deployment::<VaultProgram, _>::new(remoting.clone(), code_id, b"salt".to_vec())
            .create()
            .await
            .unwrap();
    let program_id = program_actor.id();

    // Call as Unauthorized User (ActorId 100)
    let user_remoting = remoting.clone().with_actor_id(ActorId::from(100u64));
    let mut user_service = Service::<VaultImpl, _>::new(user_remoting, program_id, "Vault");

    let res = user_service
        .vault_reserve_funds(actor(USER_1), TOKEN_BASE, 1u128)
        .await;

    assert!(res.is_err());
}

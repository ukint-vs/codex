use ::alloy_sol_types::{sol, SolCall, SolValue};
use clob_common::eth_to_actor;
use sails_rs::{
    client::{Deployment, GtestEnv, Service},
    gtest::System,
    prelude::*,
    ActorId,
};
use vault_client::{vault::Vault as VaultServiceTrait, vault::VaultImpl, VaultCtors, VaultProgram};

sol! {
    // These match the event structures in Vault.sol
    struct EthDeposit {
        address user;
        address token;
        uint256 amount;
    }

    interface IVault {
        function releaseFunds(address user, address token, uint256 amount);
        function cancelForceExit(address user, address token, uint256 amount);
    }
}

pub(crate) const WASM_PATH: &str = "../../target/wasm32-gear/debug/vault_app.opt.wasm";
pub(crate) const ADMIN_ID: u64 = 10;

#[tokio::test]
async fn test_full_cross_chain_cycle_simulation() {
    let system = System::new();
    system.init_logger();

    let user_addr = [0x01u8; 20];
    let token_addr = [0x0Au8; 20];
    let amount = 1000u128;
    let user_actor = eth_to_actor(user_addr);

    system.mint_to(ADMIN_ID, 100_000_000_000_000);
    system.mint_to(user_actor, 100_000_000_000_000);

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

    // Setup: Connect Eth Caller (Bridge simulation)
    let eth_bridge_id = ActorId::from(20u64);
    remoting
        .system()
        .mint_to(eth_bridge_id, 100_000_000_000_000);
    service_client
        .set_eth_vault_caller(eth_bridge_id)
        .await
        .unwrap();

    // 1. L1 -> L2 Deposit Simulation
    let deposit_data = EthDeposit {
        user: user_addr.into(),
        token: token_addr.into(),
        amount: ::alloy_sol_types::private::U256::from(amount),
    };
    let deposit_payload = deposit_data.abi_encode();

    // Send the cross-chain message
    let eth_remoting = remoting.clone().with_actor_id(eth_bridge_id);
    let mut eth_service = Service::<VaultImpl, _>::new(eth_remoting, program_id, "Vault".into());
    eth_service.eth_deposit(deposit_payload).await.unwrap();

    // Verify L2 Balance
    let (available, _) = service_client
        .get_balance(user_actor, token_addr.into())
        .await
        .unwrap();
    assert_eq!(available, amount);

    // 2. L2 -> L1 Withdrawal Simulation
    // User initiates withdrawal on Gear
    let user_remoting = remoting.clone().with_actor_id(user_actor);
    let mut user_service = Service::<VaultImpl, _>::new(user_remoting, program_id, "Vault".into());

    user_service
        .vault_withdraw(user_actor, token_addr.into(), amount)
        .await
        .unwrap();

    // Verify L2 Balance is now 0
    let (bal_after, _) = service_client
        .get_balance(user_actor, token_addr.into())
        .await
        .unwrap();
    assert_eq!(bal_after, 0);

    // 3. Verify outgoing message to L1 Bridge
    let mailbox = remoting.system().get_mailbox(20u64);

    let expected_call = IVault::releaseFundsCall {
        user: user_addr.into(),
        token: token_addr.into(),
        amount: ::alloy_sol_types::private::U256::from(amount),
    };
    let expected_payload = expected_call.abi_encode();

    let log = sails_rs::gtest::Log::builder()
        .dest(20u64)
        .payload(expected_payload);

    assert!(mailbox.contains(&log));
}

#[tokio::test]

async fn test_force_exit_cancellation_simulation() {
    let system = System::new();

    system.init_logger();

    let user_addr = [0x02u8; 20];

    let token_addr = [0x0Bu8; 20];

    let amount = 500u128;

    let user_actor = eth_to_actor(user_addr);

    system.mint_to(ADMIN_ID, 100_000_000_000_000);

    system.mint_to(user_actor, 100_000_000_000_000);

    let code_id = system.submit_code_file(WASM_PATH);

    let remoting = GtestEnv::new(system, ADMIN_ID.into());

    let program_actor =
        Deployment::<VaultProgram, _>::new(remoting.clone(), code_id, b"salt2".to_vec())
            .create()
            .await
            .unwrap();

    let program_id = program_actor.id();

    let mut service_client =
        Service::<VaultImpl, _>::new(remoting.clone(), program_id, "Vault".into());

    // Setup: Connect Eth Caller

    let eth_bridge_id = ActorId::from(20u64);
    remoting
        .system()
        .mint_to(eth_bridge_id, 100_000_000_000_000);

    service_client
        .set_eth_vault_caller(eth_bridge_id)
        .await
        .unwrap();

    // 1. Initial Deposit

    let deposit_data = EthDeposit {
        user: user_addr.into(),

        token: token_addr.into(),

        amount: ::alloy_sol_types::private::U256::from(amount),
    };

    let eth_remoting = remoting.clone().with_actor_id(eth_bridge_id);
    let mut eth_service = Service::<VaultImpl, _>::new(eth_remoting, program_id, "Vault".into());
    eth_service
        .eth_deposit(deposit_data.abi_encode())
        .await
        .unwrap();

    // 2. Simulate Force Exit Sync from L1

    // In a real scenario, the bridge calls 'vault_force_exit' when it sees the L1 event

    // The bridge is usually the Admin or an authorized program.

    service_client
        .vault_force_exit(user_actor, token_addr.into(), amount)
        .await
        .unwrap();

    // 3. Verify L2 Balance is deducted

    let (available, _) = service_client
        .get_balance(user_actor, token_addr.into())
        .await
        .unwrap();

    assert_eq!(available, 0);

    // 4. Verify outgoing 'cancelForceExit' message to L1 Bridge

    let mailbox = remoting.system().get_mailbox(20u64);

    let expected_call = IVault::cancelForceExitCall {
        user: user_addr.into(),

        token: token_addr.into(),

        amount: ::alloy_sol_types::private::U256::from(amount),
    };

    let expected_payload = expected_call.abi_encode();

    let log = sails_rs::gtest::Log::builder()
        .dest(20u64)
        .payload(expected_payload);

    assert!(mailbox.contains(&log));
}

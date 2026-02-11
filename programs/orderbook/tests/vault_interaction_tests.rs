use clob_common::{eth_to_actor, TokenId};
use orderbook_client::OrderbookCtors;
use sails_rs::{
    client::{Deployment, GtestEnv},
    gtest::{Program, System},
    prelude::*,
    ActorId,
};

pub(crate) const ORDERBOOK_WASM: &str = "../../target/wasm32-gear/release/orderbook.opt.wasm";
pub(crate) const VAULT_WASM: &str = "../../target/wasm32-gear/release/vault_app.opt.wasm";

pub(crate) const ADMIN_ID: u64 = 100;
pub(crate) const BUYER_ID: u64 = 101;
pub(crate) const TOKEN_BASE: TokenId = [11u8; 20];
pub(crate) const TOKEN_QUOTE: TokenId = [12u8; 20];

fn buyer() -> ActorId {
    ActorId::from(BUYER_ID)
}

async fn setup_programs() -> (GtestEnv, ActorId, ActorId, ActorId) {
    let system = System::new();
    system.init_logger();
    system.mint_to(ADMIN_ID, 100_000_000_000_000_000);
    system.mint_to(buyer(), 100_000_000_000_000_000);

    let remoting = GtestEnv::new(system, ADMIN_ID.into());
    let system_ref = remoting.system();

    let base_vault_program = Program::from_file(system_ref, VAULT_WASM);
    let base_vault_id = base_vault_program.id();
    let base_ctor = ("Create", (eth_to_actor(TOKEN_BASE),)).encode();
    base_vault_program.send_bytes(ADMIN_ID, base_ctor);

    let quote_vault_program = Program::from_file(system_ref, VAULT_WASM);
    let quote_vault_id = quote_vault_program.id();
    let quote_ctor = ("Create", (eth_to_actor(TOKEN_QUOTE),)).encode();
    quote_vault_program.send_bytes(ADMIN_ID, quote_ctor);

    let code_orderbook = system_ref.submit_code_file(ORDERBOOK_WASM);
    let orderbook_actor = Deployment::<orderbook_client::OrderbookProgram, _>::new(
        remoting.clone(),
        code_orderbook,
        b"book_salt".to_vec(),
    )
    .create(
        base_vault_id,
        quote_vault_id,
        TOKEN_BASE,
        TOKEN_QUOTE,
        1000,
        1000,
    )
    .await
    .unwrap();
    let orderbook_id = orderbook_actor.id();

    let payload = ("Vault", "AddMarket", (orderbook_id)).encode();
    let base_prg = system_ref
        .get_program(base_vault_id)
        .expect("Base vault program not found");
    let mid = base_prg.send_bytes(ADMIN_ID, payload.clone());
    let res = system_ref.run_next_block();
    assert!(res.succeed.contains(&mid), "add_market failed (base)");

    let quote_prg = system_ref
        .get_program(quote_vault_id)
        .expect("Quote vault program not found");
    let mid = quote_prg.send_bytes(ADMIN_ID, payload);
    let res = system_ref.run_next_block();
    assert!(res.succeed.contains(&mid), "add_market failed (quote)");

    (remoting, base_vault_id, quote_vault_id, orderbook_id)
}

fn send_vault(system: &System, from: u64, vault_id: ActorId, method: &str, args: impl Encode) {
    let payload = ("Vault", method, args).encode();
    let program = system
        .get_program(vault_id)
        .expect("Vault program not found");
    let mid = program.send_bytes(from, payload);
    let res = system.run_next_block();
    assert!(res.succeed.contains(&mid), "Vault call {} failed", method);
}

fn get_vault_balance(system: &System, vault_id: ActorId, user: ActorId) -> (u128, u128) {
    let payload = ("Vault", "GetBalance", (user,)).encode();
    let program = system
        .get_program(vault_id)
        .expect("Vault program not found");
    let mid = program.send_bytes(ADMIN_ID, payload);
    let res = system.run_next_block();
    assert!(res.succeed.contains(&mid));
    let log = res
        .log
        .iter()
        .find(|l| l.destination() == ADMIN_ID.into() && l.source() == vault_id)
        .expect("No reply log found");

    match <(String, String, (u128, u128))>::decode(&mut log.payload()) {
        Ok((_, _, (avail, locked))) => (avail, locked),
        Err(_) => <(u128, u128)>::decode(&mut log.payload()).expect("Failed to decode balance"),
    }
}

#[tokio::test]
async fn transfer_to_market_moves_funds_out_of_vault() {
    let (remoting, _base_vault_id, quote_vault_id, orderbook_id) = setup_programs().await;
    let system = remoting.system();

    send_vault(
        system,
        ADMIN_ID,
        quote_vault_id,
        "VaultDeposit",
        (buyer(), 1_000u128),
    );
    send_vault(
        system,
        BUYER_ID,
        quote_vault_id,
        "TransferToMarket",
        (orderbook_id, 400u128),
    );

    let (avail, locked) = get_vault_balance(system, quote_vault_id, buyer());
    assert_eq!(avail, 600u128);
    assert_eq!(locked, 0u128);
}

#[tokio::test]
async fn second_transfer_respects_reduced_available_balance() {
    let (remoting, _base_vault_id, quote_vault_id, orderbook_id) = setup_programs().await;
    let system = remoting.system();

    send_vault(
        system,
        ADMIN_ID,
        quote_vault_id,
        "VaultDeposit",
        (buyer(), 1_000u128),
    );
    send_vault(
        system,
        BUYER_ID,
        quote_vault_id,
        "TransferToMarket",
        (orderbook_id, 700u128),
    );

    let payload = ("Vault", "TransferToMarket", (orderbook_id, 400u128)).encode();
    let prg = system
        .get_program(quote_vault_id)
        .expect("Quote vault program not found");
    let mid = prg.send_bytes(BUYER_ID, payload);
    let res = system.run_next_block();
    assert!(
        !res.succeed.contains(&mid),
        "Expected insufficient balance failure"
    );

    let (avail, locked) = get_vault_balance(system, quote_vault_id, buyer());
    assert_eq!(avail, 300u128);
    assert_eq!(locked, 0u128);
}

use sails_client_gen::ClientGenerator;
use std::{env, path::PathBuf};

fn main() {
    sails_rs::build_wasm();
    // build orderbook client
    let out_dir_path = PathBuf::from(env::var("OUT_DIR").unwrap());
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let workspace_root = manifest_dir.parent().unwrap();
    let orderbook_idl = workspace_root.join("orderbook/orderbook.idl");

    // Generate client code from IDL file
    ClientGenerator::from_idl_path(&orderbook_idl)
        .with_mocks("mocks")
        .generate_to(out_dir_path.join("orderbook_client.rs"))
        .unwrap();
}

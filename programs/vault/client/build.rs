use sails_client_gen::ClientGenerator;
use std::{env, fs, path::PathBuf};

fn main() {
    let out_dir_path = PathBuf::from(env::var("OUT_DIR").unwrap());
    let idl_file_path = out_dir_path.join("vault.idl");

    // Generate IDL file for the program
    sails_idl_gen::generate_idl_to_file::<vault_app::VaultProgram>(&idl_file_path).unwrap();

    // Generate client code from IDL file
    ClientGenerator::from_idl_path(&idl_file_path)
        .with_mocks("mocks")
        .generate_to(out_dir_path.join("vault_client.rs"))
        .unwrap();

    // Also copy IDL to the program directory for deployment tooling.
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let dest = manifest_dir.parent().unwrap().join("vault.idl");
    let _ = fs::copy(&idl_file_path, &dest);
}

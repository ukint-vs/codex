# Local Development Setup Scripts

## setup-local-env.sh

Automated script to set up a complete local Vara.Eth development environment.

### What it does

1. Builds the project (`cargo build --release`)
2. Validates dependencies (anvil >= 1.5.0)
3. Checks and clears required ports (9944, 8545)
4. Starts Vara.Eth node with embedded Anvil
5. Deploys program code (Orderbook & Vault)
6. Creates mirror programs on Ethereum
7. Keeps node running until stopped

### Prerequisites

- [Foundry](https://book.getfoundry.sh/getting-started/installation) installed
- Vara.Eth binary built or downloaded
- Rust toolchain with `wasm32-gear` target

### Usage

```bash
# Required: Set path to Vara.Eth binary
export PATH_TO_VARA_ETH_BIN=/path/to/vara-eth-binary

# Optional: Create .env file in project root
# BLOCK_TIME=1
# SENDER_ADDRESS=0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc
# PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

# Run the script
./scripts/setup-local-env.sh

# Skip build if already compiled
SKIP_BUILD=1 ./scripts/setup-local-env.sh
```

### Outputs

The script exports and displays:
- **KEY_STORE**: Path to node keys
- **ROUTER_ADDRESS**: Ethereum router contract address
- **ORDERBOOK_CODE_ID**: Deployed Orderbook code ID
- **VAULT_CODE_ID**: Deployed Vault code ID
- **ORDERBOOK_PROGRAM_ADDRESS**: Created Orderbook program address
- **VAULT_PROGRAM_ADDRESS**: Created Vault program address

Logs are written to `vara-eth.log` in the project root.

### Cleanup

Press `Ctrl+C` to stop. The script automatically:
- Stops the Vara.Eth node
- Stops the Anvil node
- Cleans up processes on ports 9944 and 8545

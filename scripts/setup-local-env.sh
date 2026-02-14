#!/bin/bash
set -e

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source utilities
source "$SCRIPT_DIR/utils.sh"
source "$SCRIPT_DIR/deploy.sh"

# Load .env file if it exists
ENV_FILE="$SCRIPT_DIR/../.env"
if [ -f "$ENV_FILE" ]; then
    log_info "Loading environment variables from .env file..."
    set -a  # automatically export all variables
    source "$ENV_FILE"
    set +a
    log_info ".env file loaded successfully"
else
    log_warn ".env file not found at $ENV_FILE"
fi

# Check all necessary environment variables at the beginning
log_info "Validating environment variables..."

# Check PATH_TO_VARA_ETH_BIN
if [ -z "$PATH_TO_VARA_ETH_BIN" ]; then
    log_error "PATH_TO_VARA_ETH_BIN environment variable is not set"
    log_info "Usage: export PATH_TO_VARA_ETH_BIN=/path/to/vara-eth-binary"
    exit 1
fi

# Validate the binary path immediately
validate_binary "$PATH_TO_VARA_ETH_BIN" "Vara.Eth" || exit 1

# Check anvil availability early
check_anvil_version "1.5.0" || exit 1

# Set BLOCK_TIME with default
BLOCK_TIME=${BLOCK_TIME:-1}
log_info "Block time set to: $BLOCK_TIME seconds"

# Optional: Validate BLOCK_TIME is a number
if ! [[ "$BLOCK_TIME" =~ ^[0-9]+$ ]]; then
    log_error "BLOCK_TIME must be a positive integer, got: $BLOCK_TIME"
    exit 1
fi

log_info "All environment variables validated successfully"

# Step 1: Build the project if SKIP_BUILD is not set
if [ -z "$SKIP_BUILD" ]; then
    log_info "Building orderbook (debug feature enabled)..."
    cargo build --release -p orderbook --features debug
    log_info "Building vault (debug feature enabled)..."
    cargo build --release -p vault-app --features debug
    log_info "Build completed successfully"
else
    log_warn "Skipping build (SKIP_BUILD is set)"
fi

# Step 2: Check if required ports are available
log_info "Checking if required ports are available..."

RPC_PORT=9944
ANVIL_PORT=8545

# Check RPC port
if ! check_port $RPC_PORT; then
    log_error "Port $RPC_PORT is already in use"
    read -p "Do you want to kill the process using port $RPC_PORT? (y/N): " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        kill_port $RPC_PORT
    else
        log_error "Cannot proceed with port $RPC_PORT in use"
        exit 1
    fi
fi

# Check Anvil port
if ! check_port $ANVIL_PORT; then
    log_error "Port $ANVIL_PORT is already in use"
    read -p "Do you want to kill the process using port $ANVIL_PORT? (y/N): " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        kill_port $ANVIL_PORT
    else
        log_error "Cannot proceed with port $ANVIL_PORT in use"
        exit 1
    fi
fi

log_info "Ports $RPC_PORT and $ANVIL_PORT are available"

# Step 3: Set up log file
LOG_FILE="vara-eth.log"
rm -f "$LOG_FILE"
log_info "Logs will be written to: $LOG_FILE"

# Step 4: Parse output variables
KEY_STORE=""
ROUTER_ADDRESS=""
VALIDATOR_ADDRESS=""

# Function to cleanup on exit
cleanup() {
    if [ ! -z "$NODE_PID" ]; then
        log_info "Stopping Vara.Eth node (PID: $NODE_PID)..."
        kill $NODE_PID 2>/dev/null || true
        wait $NODE_PID 2>/dev/null || true
    fi

    # Stop Anvil node if it's running on port 8545
    local anvil_pid=$(lsof -ti:8545 2>/dev/null)
    if [ ! -z "$anvil_pid" ]; then
        log_info "Stopping Anvil node (PID: $anvil_pid) on port 8545..."
        kill $anvil_pid 2>/dev/null || true
    fi
}

trap cleanup EXIT INT TERM

# Step 5: Run the node
log_info "Starting Vara.Eth node..."
RUST_LOG=debug "$PATH_TO_VARA_ETH_BIN" run --dev --block-time "$BLOCK_TIME" --rpc-port 9944 >> "$LOG_FILE" 2>&1 &
NODE_PID=$!

log_info "Node started with PID: $NODE_PID"

# Step 6: Monitor logs and extract variables
log_info "Monitoring node output for key directory and router address..."

TIMEOUT=60
ELAPSED=0
FOUND_KEY_STORE=false
FOUND_ROUTER=false
FOUND_VALIDATOR=false

while [ $ELAPSED -lt $TIMEOUT ]; do
    if [ ! -z "$NODE_PID" ] && ! kill -0 $NODE_PID 2>/dev/null; then
        log_error "Node process died unexpectedly. Check $LOG_FILE for details."
        exit 1
    fi

    # Read the log file and parse for required information
    if [ -f "$LOG_FILE" ]; then
        # Extract Key directory
        if [ "$FOUND_KEY_STORE" = false ]; then
            KEY_STORE=$(grep -m 1 "Key directory:" "$LOG_FILE" | sed -n 's/.*Key directory: \(\/.*\)/\1/p' | tr -d '\r\n' | xargs)
            if [ ! -z "$KEY_STORE" ]; then
                log_info "Key Store: $KEY_STORE"
                FOUND_KEY_STORE=true
            fi
        fi

        # Extract Ethereum router address (BSD/macOS compatible)
        if [ "$FOUND_ROUTER" = false ]; then
            ROUTER_ADDRESS=$(grep -m 1 "Ethereum router address:" "$LOG_FILE" | grep -o '0x[a-fA-F0-9]\{40\}' | tr -d '\r\n' | xargs)
            if [ ! -z "$ROUTER_ADDRESS" ]; then
                log_info "Router Address: $ROUTER_ADDRESS"
                FOUND_ROUTER=true
            fi
        fi

        # Extract validator address
        if [ "$FOUND_VALIDATOR" = false ]; then
            VALIDATOR_ADDRESS=$(grep -m 1 "Validator:" "$LOG_FILE" | grep -o '0x[a-fA-F0-9]\{40\}' | tr -d '\r\n' | xargs)
            if [ ! -z "$VALIDATOR_ADDRESS" ]; then
                log_info "Validator Address: $VALIDATOR_ADDRESS"
                FOUND_VALIDATOR=true
            fi
        fi

        # Check if required values are found
        if [ "$FOUND_KEY_STORE" = true ] && [ "$FOUND_ROUTER" = true ]; then
            log_info "Successfully extracted all required information"
            break
        fi
    fi

    sleep 1
    ELAPSED=$((ELAPSED + 1))
done

# Check if we got everything
if [ "$FOUND_KEY_STORE" = false ]; then
    log_error "Timeout: Failed to extract key directory from node output"
    exit 1
fi

if [ "$FOUND_ROUTER" = false ]; then
    log_error "Timeout: Failed to extract router address from node output"
    exit 1
fi

# Export variables for potential use by other scripts
export KEY_STORE
export ROUTER_ADDRESS
export VALIDATOR_ADDRESS

log_info "========================================="
log_info "Vara.Eth Node Setup Complete"
log_info "========================================="
log_info "Key Store: $KEY_STORE"
log_info "Router Address: $ROUTER_ADDRESS"
if [ ! -z "$VALIDATOR_ADDRESS" ]; then
    log_info "Validator Address: $VALIDATOR_ADDRESS"
fi
log_info "RPC Port: 9944"
log_info "Block Time: $BLOCK_TIME seconds"
log_info "Log File: $LOG_FILE"
log_info "========================================="

# Step 7: Deploy program codes
log_info "Deploying program codes..."

# Set default values
ANVIL_WS_RPC="ws://127.0.0.1:8545"
PRIVATE_KEY_FOR_DEPLOY=${PRIVATE_KEY:-"0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"}
if [ -z "$SENDER_ADDRESS" ]; then
    if command -v cast >/dev/null 2>&1; then
        SENDER_ADDRESS=$(cast wallet address --private-key "$PRIVATE_KEY_FOR_DEPLOY" 2>/dev/null | tr -d '\r\n' | xargs)
    fi
fi
# Fallback to first local account if address derivation is unavailable.
SENDER_ADDRESS=${SENDER_ADDRESS:-"0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"}

log_info "Using SENDER_ADDRESS: $SENDER_ADDRESS"
log_info "Using PRIVATE_KEY_FOR_DEPLOY: [redacted]"
log_info "Using ANVIL_WS_RPC: $ANVIL_WS_RPC"

# Define program paths
ORDERBOOK_WASM="./target/wasm32-gear/release/orderbook.opt.wasm"
VAULT_WASM="./target/wasm32-gear/release/vault_app.opt.wasm"

# Deploy Orderbook
log_info "Deploying Orderbook code..."
set +e  # Temporarily disable exit on error to handle it ourselves
ORDERBOOK_CODE_ID=$(deploy_code "$PATH_TO_VARA_ETH_BIN" "$ORDERBOOK_WASM" "$ROUTER_ADDRESS" "$SENDER_ADDRESS" "$KEY_STORE" "$ANVIL_WS_RPC")
deploy_exit_code=$?
set -e  # Re-enable exit on error

if [ $deploy_exit_code -ne 0 ] || [ -z "$ORDERBOOK_CODE_ID" ]; then
    log_error "Failed to deploy Orderbook code"
    exit 1
fi
log_info "Orderbook Code ID: $ORDERBOOK_CODE_ID"
export ORDERBOOK_CODE_ID

# Deploy Vault
log_info "Deploying Vault code..."
set +e  # Temporarily disable exit on error to handle it ourselves
VAULT_CODE_ID=$(deploy_code "$PATH_TO_VARA_ETH_BIN" "$VAULT_WASM" "$ROUTER_ADDRESS" "$SENDER_ADDRESS" "$KEY_STORE" "$ANVIL_WS_RPC")
deploy_exit_code=$?
set -e  # Re-enable exit on error

if [ $deploy_exit_code -ne 0 ] || [ -z "$VAULT_CODE_ID" ]; then
    log_error "Failed to deploy Vault code"
    exit 1
fi
log_info "Vault Code ID: $VAULT_CODE_ID"
export VAULT_CODE_ID

log_info "========================================="
log_info "Code Deployment Complete"
log_info "Orderbook Code ID: $ORDERBOOK_CODE_ID"
log_info "Vault Code ID: $VAULT_CODE_ID"
log_info "========================================="

# Step 8: Create mirror programs
create_programs() {
    log_info "Creating mirror programs..."
    ETH_RPC_HTTP="http://127.0.0.1:8545"

    log_info "Using ETH_RPC_HTTP: $ETH_RPC_HTTP"

    MARKET_COUNT=${MARKET_COUNT:-3}

    # Create Vault mirror program(s)
    log_info "Creating Vault mirror programs..."
    source "$SCRIPT_DIR/helpers.sh"

    # Creating Quote Token Vault
    set +e
    QUOTE_VAULT_INIT_PAYLOAD=$(create_quote_vault_init_payload)
    log_info "Quote Vault Init Payload: $QUOTE_VAULT_INIT_PAYLOAD"
    QUOTE_TOKEN_VAULT_PROGRAM_ADDRESS=$(create_mirror_program "$VAULT_CODE_ID" "$ROUTER_ADDRESS" "$PRIVATE_KEY_FOR_DEPLOY" "$ETH_RPC_HTTP" "$QUOTE_VAULT_INIT_PAYLOAD")
    program_exit_code=$?
    set -e

    if [ $program_exit_code -ne 0 ] || [ -z "$QUOTE_TOKEN_VAULT_PROGRAM_ADDRESS" ]; then
        log_error "Failed to create Quote Token Vault mirror program"
        exit 1
    fi
    log_info "Quote Token Vault Program Address: $QUOTE_TOKEN_VAULT_PROGRAM_ADDRESS"
    export QUOTE_TOKEN_VAULT_PROGRAM_ADDRESS

    local -a BASE_TOKEN_VAULT_PROGRAM_ADDRESSES=()
    local -a ORDERBOOK_PROGRAM_ADDRESSES=()
    local -a MARKET_BASE_TOKEN_IDS_ARRAY=()

    for ((i=0; i<MARKET_COUNT; i++)); do
        local base_token_id
        base_token_id=$(get_base_token_id "$i")
        MARKET_BASE_TOKEN_IDS_ARRAY+=("$base_token_id")

        set +e
        BASE_VAULT_INIT_PAYLOAD=$(create_base_vault_init_payload "$base_token_id")
        log_info "Base Vault[$i] Init Payload: $BASE_VAULT_INIT_PAYLOAD"
        base_vault_address=$(create_mirror_program "$VAULT_CODE_ID" "$ROUTER_ADDRESS" "$PRIVATE_KEY_FOR_DEPLOY" "$ETH_RPC_HTTP" "$BASE_VAULT_INIT_PAYLOAD")
        program_exit_code=$?
        set -e

        if [ $program_exit_code -ne 0 ] || [ -z "$base_vault_address" ]; then
            log_error "Failed to create Base Token Vault mirror program for market $i"
            exit 1
        fi
        BASE_TOKEN_VAULT_PROGRAM_ADDRESSES+=("$base_vault_address")
        log_info "Base Token Vault[$i] Program Address: $base_vault_address"

        set +e
        ORDERBOOK_INIT_PAYLOAD=$(create_orderbook_init_payload "$base_vault_address" "$QUOTE_TOKEN_VAULT_PROGRAM_ADDRESS" "$base_token_id" "$QUOTE_TOKEN_ID")
        log_info "Orderbook[$i] Init Payload: $ORDERBOOK_INIT_PAYLOAD"
        orderbook_address=$(create_mirror_program "$ORDERBOOK_CODE_ID" "$ROUTER_ADDRESS" "$PRIVATE_KEY_FOR_DEPLOY" "$ETH_RPC_HTTP" "$ORDERBOOK_INIT_PAYLOAD")
        program_exit_code=$?
        set -e

        if [ $program_exit_code -ne 0 ] || [ -z "$orderbook_address" ]; then
            log_error "Failed to create Orderbook mirror program for market $i"
            exit 1
        fi
        ORDERBOOK_PROGRAM_ADDRESSES+=("$orderbook_address")
        log_info "Orderbook[$i] Program Address: $orderbook_address"

        payload=$(create_vault_add_market_payload "$orderbook_address")
        send_message $PATH_TO_VARA_ETH_BIN "ws://127.0.0.1:9944" "$base_vault_address" \
            "$payload" "$SENDER_ADDRESS" "$KEY_STORE" "$ETH_RPC_HTTP" "$ROUTER_ADDRESS"
        send_message $PATH_TO_VARA_ETH_BIN "ws://127.0.0.1:9944" "$QUOTE_TOKEN_VAULT_PROGRAM_ADDRESS" \
            "$payload" "$SENDER_ADDRESS" "$KEY_STORE" "$ETH_RPC_HTTP" "$ROUTER_ADDRESS"
    done

    ORDERBOOK_PROGRAM_ADDRESS="${ORDERBOOK_PROGRAM_ADDRESSES[0]}"
    BASE_TOKEN_VAULT_PROGRAM_ADDRESS="${BASE_TOKEN_VAULT_PROGRAM_ADDRESSES[0]}"
    BASE_TOKEN_ID="${MARKET_BASE_TOKEN_IDS_ARRAY[0]}"

    ORDERBOOK_MARKET_ADDRESSES=$(IFS=,; echo "${ORDERBOOK_PROGRAM_ADDRESSES[*]}")
    BASE_TOKEN_VAULT_ADDRESSES=$(IFS=,; echo "${BASE_TOKEN_VAULT_PROGRAM_ADDRESSES[*]}")
    MARKET_BASE_TOKEN_IDS=$(IFS=,; echo "${MARKET_BASE_TOKEN_IDS_ARRAY[*]}")

    export ORDERBOOK_PROGRAM_ADDRESS
    export BASE_TOKEN_VAULT_PROGRAM_ADDRESS
    export ORDERBOOK_MARKET_ADDRESSES
    export BASE_TOKEN_VAULT_ADDRESSES
    export MARKET_BASE_TOKEN_IDS
    export BASE_TOKEN_ID

    log_info "========================================="
    log_info "Mirror Programs Created"
    log_info "========================================="
    log_info "Orderbook Program (legacy/market0): $ORDERBOOK_PROGRAM_ADDRESS"
    log_info "Base Token Vault (legacy/market0): $BASE_TOKEN_VAULT_PROGRAM_ADDRESS"
    log_info "Quote Token Vault Program: $QUOTE_TOKEN_VAULT_PROGRAM_ADDRESS"
    log_info "ORDERBOOK_MARKET_ADDRESSES: $ORDERBOOK_MARKET_ADDRESSES"
    log_info "BASE_TOKEN_VAULT_ADDRESSES: $BASE_TOKEN_VAULT_ADDRESSES"
    log_info "MARKET_BASE_TOKEN_IDS: $MARKET_BASE_TOKEN_IDS"
    log_info "========================================="
}

create_programs

# Step 9: Update .env file with contract addresses
log_info "Updating .env file with contract addresses..."
update_env_var "$ENV_FILE" "ORDERBOOK_ADDRESS" "$ORDERBOOK_PROGRAM_ADDRESS"
update_env_var "$ENV_FILE" "BASE_TOKEN_VAULT_ADDRESS" "$BASE_TOKEN_VAULT_PROGRAM_ADDRESS"
update_env_var "$ENV_FILE" "QUOTE_TOKEN_VAULT_ADDRESS" "$QUOTE_TOKEN_VAULT_PROGRAM_ADDRESS"
update_env_var "$ENV_FILE" "ORDERBOOK_MARKET_ADDRESSES" "$ORDERBOOK_MARKET_ADDRESSES"
update_env_var "$ENV_FILE" "BASE_TOKEN_VAULT_ADDRESSES" "$BASE_TOKEN_VAULT_ADDRESSES"
update_env_var "$ENV_FILE" "MARKET_BASE_TOKEN_IDS" "$MARKET_BASE_TOKEN_IDS"
update_env_var "$ENV_FILE" "ROUTER_ADDRESS" "$ROUTER_ADDRESS"
update_env_var "$ENV_FILE" "ETHEREUM_WS_RPC" "ws://127.0.0.1:8545"
update_env_var "$ENV_FILE" "VARA_ETH_WS_RPC" "ws://127.0.0.1:9944"
if [ ! -z "$VALIDATOR_ADDRESS" ]; then
    update_env_var "$ENV_FILE" "VALIDATOR_ADDRESS" "$VALIDATOR_ADDRESS"
fi

log_info "========================================="
log_info ".env file updated successfully"
log_info "========================================="

# Keep the script running and monitoring the node
log_info "Node is running. Press Ctrl+C to stop."
wait $NODE_PID

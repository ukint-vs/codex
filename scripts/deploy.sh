#!/bin/bash

# Deployment-specific functions for Vara.Eth programs

# Deploy a WASM program and extract the Code ID
# Usage: deploy_code <binary_path> <wasm_path> <router_address> <sender_address> <key_store> <anvil_ws_rpc>
# Returns: Code ID (prints to stdout)
deploy_code() {
    local binary_path="$1"
    local wasm_path="$2"
    local router_address="$3"
    local sender_address="$4"
    local key_store="$5"
    local anvil_ws_rpc="$6"

    # Validate WASM file exists
    if [ ! -f "$wasm_path" ]; then
        log_error "WASM file not found at: $wasm_path"
        return 1
    fi

    # Create temporary file for output
    local temp_output=$(mktemp)

    # Run the upload command and capture output to file
    "$binary_path" tx \
        --ethereum-rpc "$anvil_ws_rpc" \
        --ethereum-router "$router_address" \
        --sender "$sender_address" \
        --key-store "$key_store" \
        upload "$wasm_path" -w > "$temp_output" 2>&1

    local exit_code=$?

    # Extract Code ID from output (compatible with BSD/macOS grep)
    # The output uses "Code id:" (lowercase 'id')
    local code_id=$(grep -o 'Code id: *0x[a-fA-F0-9]*' "$temp_output" | sed 's/Code id: *//' | head -1 || true)

    if [ -z "$code_id" ]; then
        log_error "Failed to extract Code ID from deployment output (exit code: $exit_code)"
        echo "=== Deployment Output ===" >&2
        cat "$temp_output" >&2
        echo "========================" >&2
        rm -f "$temp_output"
        return 1
    fi

    # If we successfully extracted a code ID, consider it successful regardless of exit code
    if [ $exit_code -ne 0 ]; then
        log_warn "Deployment command returned exit code $exit_code, but Code ID was extracted successfully"
    fi

    rm -f "$temp_output"
    echo "$code_id"
    return 0
}

# Create a mirror program using forge script
# Usage: create_mirror_program <code_id> <router_address> <private_key> <rpc_url> [abi_interface]
# Returns: Program address (prints to stdout)
create_mirror_program() {
    local code_id="$1"
    local router_address="$2"
    local private_key="$3"
    local rpc_url="$4"
    local init_payload="$5"
    local abi_interface="${6:-}"

    # Create temporary file for output
    local log_file="$(pwd)/mirror_deploy_$(date +%s).log"
    touch "$log_file"

    # Set environment variables for the forge script
    export CODE_ID="$code_id"
    export ROUTER_ADDRESS="$router_address"
    export PRIVATE_KEY="$private_key"
    if [ ! -z "$abi_interface" ]; then
        export ABI_INTERFACE="$abi_interface"
    fi

    # Run forge script
    cd ethereum
    INIT_PAYLOAD="$init_payload" forge script script/CreateMirrorProgram.s.sol \
        --rpc-url "$rpc_url" \
        --broadcast \
        --via-ir >> "$log_file" 2>&1
    local exit_code=$?
    cd ..

    # Unset environment variables
    unset CODE_ID ROUTER_ADDRESS PRIVATE_KEY ABI_INTERFACE

    # Extract program address from output
    # Look for "Program created: 0x..."
    local program_address=$(grep -o 'Program created: *0x[a-fA-F0-9]*' "$log_file" | sed 's/Program created: *//' | head -1 || true)

    if [ -z "$program_address" ]; then
        log_error "Failed to extract program address from forge output (exit code: $exit_code)"
        echo "=== Forge Script Output ===" >&2
        cat "$log_file" >&2
        echo "===========================" >&2
        return 1
    fi

    # If we successfully extracted a program address, consider it successful
    if [ $exit_code -ne 0 ]; then
        log_warn "Forge script returned exit code $exit_code, but program address was extracted successfully"
    fi

    rm -f "$log_file"
    echo "$program_address"
    return 0
}


send_message() {
    local binary_path="$1"
    local varaeth_ws_rpc="$2"
    local address="$3"
    local payload="$4"
    local sender_address="$5"
    local key_store="$6"
    local ethereum_rpc="$7"
    local router="$8"

    local log_file="$(pwd)/send_message_$(date +%s).log"
    touch "$log_file"

    echo "$binary_path" tx --sender "$sender_address" --key-store "$key_store" --ethereum-rpc "$ethereum_rpc" --ethereum-router "$router" send-message -i -w -r "$varaeth_ws_rpc" "$address" "$payload" 0

    "$binary_path" tx --sender "$sender_address" --key-store "$key_store" \
        --ethereum-rpc "$ethereum_rpc" --ethereum-router "$router" \
        send-message -i -w -r "$varaeth_ws_rpc" "$address" "$payload" 0 \
         >> "$log_file" 2>&1

    local exit_code=$?

    if [ $exit_code -ne 0 ]; then
        log_error "Failed to send message (exit code: $exit_code)"
        echo "=== Forge Script Output ===" >&2
        cat "$log_file" >&2
        echo "===========================" >&2
        return 1
    fi

    # rm -rf "$log_file"

    return 0
}

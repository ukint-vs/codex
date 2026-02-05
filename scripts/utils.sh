#!/bin/bash

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Log functions
log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Compare two semantic versions
# Returns 0 if ver1 >= ver2, 1 otherwise
version_compare() {
    local IFS=.
    local i ver1=($1) ver2=($2)

    for ((i=0; i<${#ver1[@]}; i++)); do
        if [[ -z ${ver2[i]} ]]; then
            ver2[i]=0
        fi
        if ((10#${ver1[i]} > 10#${ver2[i]})); then
            return 0
        fi
        if ((10#${ver1[i]} < 10#${ver2[i]})); then
            return 1
        fi
    done
    return 0
}

# Check if anvil is installed and meets minimum version requirement
check_anvil_version() {
    local required_version="$1"

    log_info "Checking anvil version..."
    if ! command -v anvil &> /dev/null; then
        log_error "anvil not found. Please install foundry: https://book.getfoundry.sh/getting-started/installation"
        return 1
    fi

    local anvil_version=$(anvil --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)

    if version_compare "$anvil_version" "$required_version"; then
        log_info "Anvil version $anvil_version meets requirement (>= $required_version)"
        return 0
    else
        log_error "Anvil version $anvil_version is below required version $required_version"
        return 1
    fi
}

# Validate that a binary path exists and is executable
validate_binary() {
    local binary_path="$1"
    local binary_name="$2"

    if [ -z "$binary_path" ]; then
        log_error "$binary_name path is not set"
        return 1
    fi

    if [ ! -f "$binary_path" ]; then
        log_error "$binary_name binary not found at: $binary_path"
        return 1
    fi

    if [ ! -x "$binary_path" ]; then
        log_error "$binary_name binary is not executable: $binary_path"
        return 1
    fi

    log_info "Using $binary_name binary: $binary_path"
    return 0
}

# Check if a port is in use
# Usage: check_port <port_number>
# Returns: 0 if port is free, 1 if port is in use
check_port() {
    local port="$1"

    if lsof -Pi :$port -sTCP:LISTEN -t >/dev/null 2>&1 ; then
        return 1
    else
        return 0
    fi
}

# Kill process using a specific port
# Usage: kill_port <port_number>
kill_port() {
    local port="$1"

    local pid=$(lsof -ti:$port)
    if [ ! -z "$pid" ]; then
        log_warn "Killing process $pid using port $port..."
        kill -9 $pid 2>/dev/null || true
        sleep 1
        return 0
    fi
    return 1
}

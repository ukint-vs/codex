BASE_TOKEN_ID="0000000000000000000000000000000000000010"
QUOTE_TOKEN_ID="0000000000000000000000000000000000000001"

get_base_token_id() {
    local idx="${1:-0}"
    local value=$((16 + idx))
    printf "%040x" "$value"
    return 0
}

create_orderbook_init_payload() {
    local base_vault_id="000000000000000000000000${1#0x}"
    local quote_vault_id="000000000000000000000000${2#0x}"
    local base_token_id="${3:-$BASE_TOKEN_ID}"
    local quote_token_id="${4:-$QUOTE_TOKEN_ID}"

    local max_trades="ffffffff"
    local max_preview_scans="ffffffff"

    local payload
    payload=$(echo -n "$base_vault_id$quote_vault_id$base_token_id$quote_token_id$max_trades$max_preview_scans")

    echo "0x18437265617465$payload"
    return 0
}

create_base_vault_init_payload() {
    local base_token_id="${1:-$BASE_TOKEN_ID}"
    echo "0x18437265617465000000000000000000000000$base_token_id"
    return 0
}

create_quote_vault_init_payload() {
    local quote_token_id="${1:-$QUOTE_TOKEN_ID}"
    echo "0x18437265617465000000000000000000000000$quote_token_id"
    return 0
}

create_vault_add_market_payload() {
    local market_id="000000000000000000000000${1#0x}"

    local vault="145661756c74"
    local addmarket="244164644d61726b6574"

    echo "0x$vault$addmarket$market_id"
    return 0
}

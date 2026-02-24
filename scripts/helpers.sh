BASE_TOKEN_ID="0000000000000000000000000000000000000000"
QUOTE_TOKEN_ID="0000000000000000000000000000000000000001"

create_orderbook_init_payload() {
    base_vault_id="000000000000000000000000${1#0x}"
    quote_vault_id="000000000000000000000000${2#0x}"

    base_token_id="$BASE_TOKEN_ID"
    quote_token_id="$QUOTE_TOKEN_ID"

    max_trades="ffffffff"
    max_preview_scans="ffffffff"

    payload=$(echo -n "$base_vault_id$quote_vault_id$base_token_id$quote_token_id$max_trades$max_preview_scans")

    echo "0x18437265617465$payload"
    return 0
}

create_base_vault_init_payload() {
    echo "0x18437265617465000000000000000000000000$BASE_TOKEN_ID"
    return 0
}

create_quote_vault_init_payload() {
    echo "0x18437265617465000000000000000000000000$QUOTE_TOKEN_ID"
    return 0
}

create_vault_add_market_payload() {
    market_id="000000000000000000000000${1#0x}"

    vault="145661756c74"
    addmarket="244164644d61726b6574"

    echo "0x$vault$addmarket$market_id"
    return 0
}

# Gear CLOB

Decentralized CLOB stack built around Gear programs, Vara.Eth mirrors, and a TypeScript demo UI with an in-browser AI trading assistant.

## Current Architecture

### On-chain (Gear programs)
- `programs/orderbook`: order matching and orderbook storage.
  - Uses `libraries/matching_engine` for execution logic (`limit`, `market`, `fill_or_kill`, `immediate_or_cancel`).
  - Uses `libraries/intrusive_arena` for FIFO per-price queues and O(1)-style cancel by index.
  - Tracks balances inside orderbook state and exposes trade history (`trades`, `trades_reverse`).
- `programs/vault`: single-token vault per program.
  - Tracks balances, optional deposit quarantine, authorized orderbooks, force-exit path, and treasury fields.
  - Supports transfer into a market via `transfer_to_market`, with rollback if the orderbook deposit ack fails.
- `programs/registry`: optional market registry mapping `(base_token, quote_token)` to orderbook and vault actor IDs.

### Shared Rust libraries
- `libraries/clob-common`: shared token/address types and actor<->eth conversion helpers.
- `libraries/matching_engine`: matching engine primitives and execution loop limits.
- `libraries/intrusive_arena`: intrusive list/arena structures used by orderbook storage.

### Ethereum contracts (bridge-facing)
- `ethereum/src/Vault.sol` (`VaultCaller`): ERC-20 custody, L1 withdrawal limits/pause, force-exit controls, Sails payload encoding.
- `ethereum/src/Orderbook.sol` (`OrderbookCaller`): L1 entrypoints for place/cancel/continue calls encoded for Sails routes.

### Off-chain runtime
- `scripts/showcase/*`: codec + mirror clients + scripts for market setup, liquidity seeding, and demos.
- `scripts/demo-ui/server.ts`: snapshot collector, static UI host, order action API, assistant tool API.
- `scripts/browser-agent/runtime.ts`: callable tool implementations for balances, orders, depth, market status, and execution actions.
- `scripts/demo-ui/public/*`: live market board + assistant sidebar UI.

## Implemented Core Flows

### Vault to market funding
1. Deposit/mint into vault (`vault_deposit` / `debug_deposit`).
2. Move vault balance into orderbook via `transfer_to_market(market_id, amount)`.
3. Vault sends `("Orderbook","Deposit",(user,token,amount))`; on failed ack, balance is restored in vault.

### Order lifecycle
1. User submits `submit_order(side, kind, limit_price, amount_base, max_quote)`.
2. Orderbook locks taker funds from local balances.
3. `matching_engine::execute` matches against best prices with engine limits.
4. Settlement updates taker/maker balances and keeps residuals locked for resting orders.
5. Trade entries are appended to execution history and queryable via `trades*`.

### Withdrawals from orderbook
- `withdraw_base` / `withdraw_quote` deduct orderbook balances and send deposit messages back to vault.
- If reply fails, orderbook re-credits user balance.

### L1 safety path
- `VaultCaller` implements:
  - daily per-token release caps,
  - emergency pause for `releaseFunds`,
  - force-exit initiation/claim/cancel workflow.
- See `docs/ASSET_SAFETY.md` for force-exit details.

## Demo UI + AI Assistant

### Market UI features
- Live multi-market snapshot polling (`/api/snapshot`).
- Aggregated depth ladder with click-to-prefill pricing.
- Limit and market order forms.
- Take selected resting order.
- Trade tape and price chart (`Ticks`/`Candles`).
- Auto-trading mode for demo market activity.

### Assistant architecture
- UI sidebar chat in `scripts/demo-ui/public/index.html` + `scripts/demo-ui/public/app.js`.
- Agent orchestration in `scripts/demo-ui/public/agent.js`.
- Tool schema endpoint: `GET /api/agent/schema`.
- Tool execution endpoint: `POST /api/agent/tool`.
- Assistant key endpoint: `GET /api/assistant/config`.

### Assistant capabilities (current tool surface)
- Read tools:
  - `list_markets`
  - `get_live_snapshot`
  - `get_balance`
  - `get_order_status`
  - `list_orders`
  - `watch_order_status`
  - `get_order_insight`
  - `get_wallet_orders_overview`
  - `get_orderbook_depth`
  - `get_dex_status`
  - `get_market_overview`
  - `get_price_recommendation`
  - `get_currency_info`
- Write tools:
  - `place_order`
  - `cancel_order`
  - `smart_place_order`

### Assistant behavior/safety
- Deterministic intent router for common requests (market switch, balances, order status, depth, status).
- Explicit confirmation gate for write actions (`confirm=false` preflight, then user confirmation).
- Pending confirmation actions expire after 5 minutes.
- Post-action enrichment: after place/cancel, agent fetches `get_order_status` and `get_order_insight`.
- Provider support: OpenRouter (default), OpenAI, Anthropic.
- Retry/backoff for transient provider/tool failures.

## Local Development

### Requirements
- Rust + Cargo
- Node.js + pnpm
- Foundry (`forge`) for Solidity tests

### Minimal env for scripts
Set at least:
- `PRIVATE_KEY`
- `ROUTER_ADDRESS`
- `ORDERBOOK_ADDRESS`
- `BASE_TOKEN_VAULT_ADDRESS`
- `QUOTE_TOKEN_VAULT_ADDRESS`

Optional transport overrides:
- `ETHEREUM_WS_RPC` (or legacy local `ETH_RPC_WS`)
- `VARA_ETH_WS_RPC` (or legacy local `RPC_URL`)

Multi-market optional inputs:
- `ORDERBOOK_MARKET_ADDRESSES`
- `BASE_TOKEN_VAULT_ADDRESSES`
- `QUOTE_TOKEN_VAULT_ADDRESSES`
- `MARKET_BASE_TOKEN_IDS`
- `MARKET_QUOTE_TOKEN_IDS`
- `MARKET_BASE_SYMBOLS`
- `MARKET_QUOTE_SYMBOLS`

### Run
- `pnpm demo:ui` - start UI server.
- `pnpm demo:auto-trader` - run standalone market activity bot.
- `pnpm demo:live` - run UI + auto-trader together.

## Assistant Configuration

- `DEMO_UI_LLM_API_KEY` is read by the demo UI server and returned to the browser client.
- Fallback lookup order:
  - `DEMO_UI_LLM_API_KEY`
  - `OPENROUTER_API_KEY`
  - `OPENAI_API_KEY`
  - `ANTHROPIC_API_KEY`

Demo note: because the key is exposed to the browser by `/api/assistant/config`, this setup is intended for local/demo use, not production key management.

## Demo UI Env Knobs

- `DEMO_UI_PORT` (default `4180`)
- `DEMO_UI_REFRESH_MS` (default `5000`)
- `DEMO_UI_ORDERS_PER_MARKET` (default `20`)
- `DEMO_UI_DEPTH_LEVELS` (default `20`)
- `DEMO_UI_OPEN_ORDERS_SCAN_COUNT` (default `220`)
- `DEMO_UI_TRADES_PER_MARKET` (default `300`)
- `DEMO_UI_MAKER_ACCOUNTS_PER_SIDE` (default `4`)
- `DEMO_UI_STORAGE_SCAN_PAGE_SIZE` (default `250`)
- `DEMO_UI_STORAGE_SCAN_MAX_ORDERS` (default `10000`)

## Testing

- Solidity tests: `forge test`
- Rust tests (example): `cargo test -p vault-app`

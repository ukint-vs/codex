# Gear CLOB

A decentralized Central Limit Order Book (CLOB) with a Gear/Vara matching engine and Ethereum L1 entrypoints for deposits, withdrawals, and order submission.

## Architecture (Implemented)

### L1 (Ethereum)
- **VaultCaller (`ethereum/src/Vault.sol`):** Holds ERC-20 assets and bridges deposits/withdrawals to Gear using `SailsCodec` payloads.
- **OrderbookCaller (`ethereum/src/Orderbook.sol`):** Bridges order placement/cancellation to Gear using `SailsCodec` payloads.
- **Router/Mirror (`VAR_ETH_PROGRAM`):** Sails-compatible program address that accepts `sendMessage` from L1 and routes it to Gear programs.

### L2 (Gear)
- **Vault program (`programs/vault`):** Balance ledger with available/reserved funds, fee treasury, and cross-chain release calls.
- **OrderBook program (`programs/orderbook`):** Matching engine and order lifecycle.
- **Registry program (`programs/registry`):** Maps (base, quote) pairs to orderbook/vault actors.
- **Common types (`libraries/clob-common`):** Shared types and pricing helpers.

## Cross-Chain Flows (Implemented)

### Deposit (L1 -> Gear)
1. User calls `VaultCaller.deposit(token, amount)` on Ethereum.
2. `VaultCaller` transfers ERC-20s to itself and sends `SailsCodec.encode("Vault","EthDeposit", abi.encode(...))` to the Gear router.
3. `Vault` program handles `eth_deposit` and credits `available` balance.

### Withdrawal (Gear -> L1)
1. User calls `VaultCaller.initiateWithdrawal(token, amount)` on Ethereum.
2. `VaultCaller` sends `SailsCodec.encode("Vault","EthWithdraw", abi.encode(...))` to the Gear router.
3. `Vault` program handles `eth_withdraw`, decrements `available`, and sends an ABI-encoded `releaseFunds` call to `eth_vault_caller`.
4. `VaultCaller.releaseFunds` enforces limits and transfers ERC-20s to the user.

### Orders (L1 -> Gear)
1. User calls `OrderbookCaller.placeOrder(...)` or `cancelOrder(...)`.
2. `OrderbookCaller` sends `SailsCodec.encode("OrderBook","PlaceOrderEth", ...)` or `CancelOrderEth`.
3. `OrderBook` reserves funds via `VaultReserveFunds`, appends orders, and runs the matching loop.

## OrderBook Behavior Notes

- **Price/time priority:** Best price first; FIFO within a price level using `Vec<Order>`.
- **Maker selection:** The maker is the order with the smaller `order_id` (older insertion).
- **Max matches per call:** 10, with a self-message continuation.
- **Price scaling:** Per-market scale via `set_market_scale`; default is 1.
- **Fees:** `OrderBook` computes fees using `FEE_RATE_BPS` (currently 30). `Vault` validates against its `fee_rate_bps`, which must be configured to match.

## Vault Safety Features (L1)
- **Strict Origin Verification:** Only the configured Gear router can trigger `releaseFunds`.
- **Per-Token Daily Limits:** Optional caps on withdrawals.
- **Emergency Pause:** Owner can halt `releaseFunds`.
- **Force Exit:** Users can initiate a force exit with a 7-day delay; `Vault` can cancel it via `cancelForceExit`. See [docs/ASSET_SAFETY.md](docs/ASSET_SAFETY.md) for details.

### ⚠️ Warning: State Desynchronization Risk
If `releaseFunds` reverts on Ethereum (e.g., daily limit reached), Gear balances have already been decremented by `eth_withdraw`. There is no automated rollback today; users must check limits before withdrawing.

## Development

### Requirements
- Rust & Cargo
- Foundry (Forge & Cast)
- Node.js (for deployment scripts)

### Testing
- **Solidity:** `forge test`
- **Gear Programs:** `cargo test -p vault-app`

## Demo UI
- Start the live dashboard: `pnpm demo:ui`
- Open in browser: `http://127.0.0.1:4180`
- Source: live reads from configured orderbook/vault contracts via `@vara-eth/api`
- CEX-style features:
  - Aggregated bid/ask ladder (click a level to prefill limit form)
  - Limit order entry (`Place Limit`)
  - Market order entry (`Send Market`)
  - `Take` on a resting order id
  - Live trade tape + execution price chart with `Ticks`/`Candles` modes
- `Recent Orders` shows resting/open orders only. Executions appear in `Trade Tape`.

Optional env:
- `DEMO_UI_PORT` (default: `4180`)
- `DEMO_UI_REFRESH_MS` (default: `1500`)
- `DEMO_UI_SCAN_MAX_ORDER_ID` (default: `450`)
- `DEMO_UI_ORDERS_PER_MARKET` (default: `20`)
- `DEMO_UI_DEPTH_LEVELS` (default: `20`)
- `DEMO_UI_OPEN_ORDERS_SCAN_COUNT` (default: `220`)

## Deployment (Hoodi Testnet)

The system is deployed on the Hoodi Testnet (Ethereum-compatible) and linked to the Vara Testnet.

- **Router:** `0xBC888a8B050B9B76a985d91c815d2c4f2131a58A`
- **VaultCaller (Ethereum):** `0xbd90D06b389C48c9f1112FE3b4B132CC49FDB89e`
- **Mirror (Gear Vault Proxy):** `0xf4cc277a2a22a55650d038da6b675b145da01a89`
- **WVARA Token:** `0x2C960bd5347C2Eb4d9bBEA0CB9671C5b641Dcbb9`

### Verification Links
- [VaultCaller on Explorer](https://hoodi.etherscan.io/address/0xbd90D06b389C48c9f1112FE3b4B132CC49FDB89e)
- [Mirror on Explorer](https://hoodi.etherscan.io/address/0xf4cc277a2a22a55650d038da6b675b145da01a89)
- [Router on Explorer](https://hoodi.etherscan.io/address/0xBC888a8B050B9B76a985d91c815d2c4f2131a58A)

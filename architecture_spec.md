# Gear CLOB Architecture Spec (Implemented)

This document describes the current on-chain implementation in `programs/` and `ethereum/`.

## Components

- **OrderBook program (Gear):** Matching engine + order lifecycle. `programs/orderbook`.
- **Vault program (Gear):** Balance ledger, reserve/unlock/settle, and L1 release calls. `programs/vault`.
- **Registry program (Gear):** Maps market pairs to OrderBook/Vault actors. `programs/registry`.
- **OrderbookCaller (Ethereum):** L1 entrypoint for placing/canceling orders on Gear. `ethereum/src/Orderbook.sol`.
- **VaultCaller (Ethereum):** L1 vault that holds ERC-20s and bridges deposits/withdrawals. `ethereum/src/Vault.sol`.
- **Common types:** `libraries/clob-common` defines shared types and pricing helpers.

## Identity Model

- **TraderId = ActorId:** On Gear, the canonical trader identity is the 32-byte ActorId.
- **EthAddress = [u8; 20]:** Token IDs remain 20-byte Ethereum addresses.
- **L1 entrypoints:** `OrderbookCaller` and `VaultCaller` encode L1 requests using `SailsCodec` and the Gear programs whitelist the caller via `eth_orderbook_caller` / `eth_vault_caller`.

## OrderBook (Gear)

### State

```rust
pub struct OrderBookState {
    pub bids: BTreeMap<Price, OrderQueue>,
    pub asks: BTreeMap<Price, OrderQueue>,
    pub arena: Arena<OrderNode>,
    pub order_indices: HashMap<OrderId, Index>,
    pub vault_id: ActorId,
    pub admin: Option<ActorId>,
    pub eth_orderbook_caller: Option<ActorId>,
    pub order_counter: u128,
    pub market_scales: HashMap<(TokenId, TokenId), u128>,
}
```

### Order Model

```rust
pub struct OrderNode {
    pub order: Order,
    pub next: Option<Index>,
    pub prev: Option<Index>,
}

pub struct Order {
    pub id: OrderId,
    pub trader: TraderId,
    pub side: Side,
    pub price: Price,
    pub quantity: Quantity,
    pub created_at: u64,
}
```

### Price/Time Priority

- **Price priority:** Best bid = highest price; best ask = lowest price.
- **Time priority:** Orders at the same price are stored in a doubly-linked list (`OrderQueue`) backed by an `Arena`.
- **Maker selection:** The maker is the order with the lower `order_id` (older in insertion order), and the trade price is the maker's price.

### Placement Flow

1. Compute required amount using the market scale.
2. Reserve funds in the Vault via `VaultReserveFunds`.
3. Append order to the tail of the `OrderQueue` for that price, allocating a node in the `Arena`.
4. Emit `OrderPlaced` (Gear + Ethereum-compatible event).
5. Invoke matching.

### Cancellation Flow

1. Verify caller is the original trader.
2. Remove from `OrderQueue` (O(1) using stored index from `order_indices`) and deallocate from `Arena`.
3. Unlock reserved funds in Vault via `VaultUnlockFunds`.
4. Emit `OrderCanceled`.

### Matching Loop

- **Max matches per call:** 50 (`MAX_MATCHES`).
- **Continuation:** If the limit is reached, send a self-message (`ContinueMatching`) to resume later.
- **Trade parameters:**
  - `trade_price`: maker's price (older order id).
  - `trade_quantity`: min(bid.qty, ask.qty).
  - `cost = ceil(price * qty / price_scale)`.
  - `fee = cost * FEE_RATE_BPS / 10_000` (constant in `clob-common`).
- **Settlement:** Send `VaultSettleTrade` with `price_scale` and `fee`.
- **Price improvement:** If the bid is the taker and executes below its limit price, the buyer is refunded the difference via `VaultUnlockFunds`.
- **Order updates:** Quantities are decremented; fully filled orders are removed from queue and arena.

### Market Scaling

- `market_scales[(base, quote)]` sets the price scale (default = 1).
- Used for cost rounding via `mul_div_ceil`.

## Vault (Gear)

### State

```rust
pub struct VaultState {
    pub balances: HashMap<ActorId, HashMap<TokenId, Balance>>,
    pub treasury: HashMap<TokenId, u128>,
    pub fee_rate_bps: u128,
    pub authorized_programs: HashSet<ActorId>,
    pub admin: Option<ActorId>,
    pub eth_vault_caller: Option<ActorId>,
}
```

### Balance Model

```rust
pub struct Balance {
    pub available: u128,
    pub reserved: u128,
}
```

### Authorization

Vault methods accept calls from:
- The admin,
- The configured `eth_vault_caller` (L1 bridge),
- Authorized programs (OrderBook).

### Deposits & Withdrawals

- `eth_deposit` / `eth_withdraw` decode ABI payloads sent by `VaultCaller` via `SailsCodec`.
- `vault_deposit` / `vault_withdraw` can be called by the user, admin, or an authorized program.
- `vault_withdraw` sends an ABI-encoded `releaseFunds` call to `eth_vault_caller` (if configured).
- `vault_force_exit` reduces available balance and sends `cancelForceExit` to L1.

### Reserve / Unlock / Settle

- **Reserve:** move `available -> reserved`.
- **Unlock:** move `reserved -> available`.
- **Settle:** verify buyer and seller reserves, verify fee is at least `fee_rate_bps`, then:
  - buyer quote reserved -= cost
  - seller base reserved -= quantity
  - buyer base available += quantity
  - seller quote available += cost - fee
  - treasury[quote] += fee

## L1 Encoding & Routing

- `VaultCaller` uses `SailsCodec.encode("Vault", "EthDeposit", abi.encode(user, token, amount))`.
- `VaultCaller` uses `SailsCodec.encode("Vault", "EthWithdraw", abi.encode(user, token, amount))`.
- `OrderbookCaller` uses `SailsCodec.encode("OrderBook", "PlaceOrderEth", abi.encodePacked(...))`.
- Gear programs use generated IO helpers to prefix routes (e.g., `"Vault"` + method selector).

## Complexity Notes

- Per-price cancellation is **O(1)** due to doubly-linked list + index map.
- Matching is **O(1)** per match for best price lookup, plus linked list head access.
- Continuation prevents long loops from exceeding gas limits.

# Gear CLOB MVP Roadmap\n
# MVP Technical Roadmap

## Feature Prioritization

### P0: Core Infrastructure & Asset Safety
*These features are essential for a launchable, secure alpha.*
- **Cross-Chain Vault:** Full lifecycle of Deposit -> Virtual Balance -> Withdrawal -> Release.
- **Emergency Force Exit (L1):** A trustless mechanism on Ethereum to recover funds if the Gear program or bridge stops responding.
- **Mirror Contract Hardening:** Finalize `OrderbookCaller.sol` and ensure robust error handling for bridge messages.

### P1: Scalable Matching Engine
*Ensures the engine can handle high volume without gas-limit reverts.*
- **LinkedList Data Structures:** Implement the O(1) orderbook structures defined in the Matching Engine spec.
- **Gas-Aware Matching Loop:** Implement the `MAX_MATCHES_PER_BLOCK` logic with `ContinueMatching` self-calls.
- **Partial Fill Handling:** Correctly update state and price improvements for partial matches.

### P2: Integration & Developer Experience
*Required for building a frontend and allowing external bots to participate.*
- **TypeScript Client SDK:** High-level wrapper for `sails-js` and `viem` to facilitate order placement/cancellation.
- **Orderbook Indexer:** A lightweight service to track Gear events and expose a REST/GraphQL API for orderbook depth and history.

### P3: Trading Refinements
- **Market Orders:** Support for "Fill or Kill" (FOK) and "Immediate or Cancel" (IOC) logic.
- **Admin Dashboard:** Tools for updating fee rates and managing authorized programs.

## Implementation Timeline (Phased)

1.  **Phase A (Infrastructure):** L1 Force Exit + Vault Program Refinement.
2.  **Phase B (Engine):** Scalable Orderbook Implementation + Matching Loop.
3.  **Phase C (Tooling):** SDK + Indexer.
4.  **Phase D (Verification):** Full E2E Testnet Load Testing.

## Proposed Development Tracks

### Track 1: L1 Safety & Vault Hardening
- **Objective:** Ensure user funds are safe even in edge cases.
- **Key Tasks:**
    - Implement `ForceExit` in `VaultCaller.sol`.
    - Finalize `OrderbookCaller.sol` callbacks.
    - Audit and harden Mirror -> Gear message routing.

### Track 2: High-Performance Matching Engine
- **Objective:** Build a robust, scalable engine on Gear.
- **Key Tasks:**
    - Refactor `programs/orderbook` to use Linked List structures.
    - Implement `match_orders` with `MAX_MATCHES_PER_BLOCK`.
    - Add comprehensive unit tests for partial fills and price improvement.

### Track 3: Cross-Chain Settlement Integration
- **Objective:** Connect the engine to the L2 Vault securely.
- **Key Tasks:**
    - Implement `authorized_programs` check in L2 Vault.
    - Ensure atomic `Reserve -> Settle` flow between programs.
    - Implement batch trade confirmations for L1 event syncing.

### Track 4: Client Ecosystem & Indexing
- **Objective:** Enable external participants and UI.
- **Key Tasks:**
    - Build `gear-clob-sdk` (TypeScript).
    - Develop `orderbook-indexer` (Node.js/Rust) for real-time depth updates.
    - Create a CLI tool for placing/canceling orders.

## Success Criteria for MVP

1.  **Non-Custodial Security:** Users can always withdraw their funds via the Ethereum L1 Force Exit, even if Gear validators go offline.
2.  **Deterministic Fairness:** All trades are executed in strict Price/Time priority, verifiable on-chain (Gear).
3.  **WASM Optimization:** Matching engine remains functional and gas-safe with 1000+ orders at a single price level.
4.  **Low Latency:** User orders are acknowledged and processed within the next Gear block (<1s).
# Gap Analysis: Path to MVP

## 1. Smart Contracts (Ethereum L1)

### Critical Gaps (Must-Have for MVP)
- **OrderbookCaller Stub:** The `OrderbookCaller.sol` contract is currently empty. It acts as the L1 entry point (via Mirror) but logic for event handling or user confirmation is missing.
- **Force Exit / Emergency Withdrawal:** There is no "Escape Hatch". If the Gear program halts or the bridge goes down, user funds are locked in `Vault.sol` indefinitely. We need a time-locked or proof-based force exit mechanism on L1.

### Improvements (Nice-to-Have)
- **Batch Operations:** `Vault.sol` handles single user/token operations. Batch settlement could optimize gas.

## 2. Gear Programs (Rust/WASM)

### Critical Gaps (Must-Have for MVP)
- **Scalable Data Structures:** The `Vec<Order>` in `OrderBookState` is O(N) for insertion/deletion at a price level. This is a DoS vector. We need a paginated or linked-list structure.
- **Dynamic Fee Configuration:** Fees are hardcoded (`FEE_RATE_BPS`). An admin function to update this (synchronized with L1 state if needed) is required.
- **Executor Model Definition:** The `continue_matching` logic relies on self-messaging. We need to formalize if an off-chain "Executor" bot is required to keep the engine turning or if self-messaging is sufficient (and safe from gas-limit griefing).

### Improvements (Nice-to-Have)
- **Market Orders:** Currently, the code implies limit orders. Explicit support for "Fill or Kill" or "Immediate or Cancel" would be valuable.
- **Maker/Taker Rebates:** The current fee model is simple. Advanced fee schedules would require more complex state.

## 3. Integration & Infrastructure

### Critical Gaps (Must-Have for MVP)
- **Client SDK:** No TypeScript SDK exists to abstract the `alloy-sol-types` encoding for `place_order` and `cancel_order`. Frontend developers cannot easily interact with the system.
- **Indexer:** No off-chain indexer to track the orderbook state. Users can only see their own orders or query the contract state directly (which is slow). A subgraph or custom indexer is needed to display the "Depth Chart".

## Summary
The "Core" logic (Vault + Orderbook Matching) is 80% there. The "Periphery" (SDKs, Indexers, Safety Hatches) is 0-20% there.
**Primary Focus for MVP:** Safety (Force Exit) + Usability (SDK/Indexer).

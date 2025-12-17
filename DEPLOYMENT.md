# Testnet Deployment Guide

This guide details how to deploy the Gear CLOB system to the **Ethereum Hoodi** and **Vara.eth** testnets.

## Prerequisites

- **Node.js** (v18+)
- **Rust** (stable) & **Cargo** (for building WASM if needed)
- **Foundry** (for L1 contracts)
- **ethexe** binary (Gear Ethereum Executor CLI)

## 1. Environment Setup

Copy the example environment file and configure your credentials:

```bash
cp deploy/clob/.env.example .env
```

**Required Variables in `.env`:**

| Variable | Description |
| :--- | :--- |
| `PRIVATE_KEY` | Ethereum private key (used for both L1 and L2 deployments) |
| `ETH_RPC` | Ethereum Hoodi RPC URL (e.g., `https://hoodi-reth-rpc.gear-tech.io`) |
| `RPC_WS` | Vara.eth WebSocket URL (e.g., `ws://vara-eth-validator-1.gear-tech.io:9944`) |
| `ROUTER_ADDRESS` | Pre-deployed Router address on Hoodi |
| `ETHEXE_BIN` | Path to your local `ethexe` binary |
| `VAULT_PROGRAM_ID` | L2 Vault Program ID (required for L1 deploy) |
| `ORDERBOOK_PROGRAM_ID` | L2 Orderbook Program ID (required for L1 deploy) |
| `VAULT_CALLER_ADDRESS` | L1 VaultCaller address (set after L1 deploy) |
| `ORDERBOOK_CALLER_ADDRESS` | L1 OrderbookCaller address (set after L1 deploy) |
| `WRITE_DEPLOYMENTS` | Optional: set to `false` to skip writing `deployments.json` |

## 2. Deployment

We provide a single script to orchestrate the deployment across both chains.

### Full End-to-End Deployment

This script will:
1.  Upload Gear programs (Vault & Orderbook) to Vara.eth.
2.  Initialize them and capture the Program IDs.
3.  Deploy the L1 `VaultCaller` and `OrderbookCaller` contracts to Hoodi, linked to the L2 programs.
4.  Optionally save artifacts to `deploy/clob/deployments.json` (set `WRITE_DEPLOYMENTS=true`).

```bash
cd deploy/clob
npm install
npx tsx deploy-full.ts
```

### Modular Deployment

You can also run the phases independently:

**Phase 1: L2 Deployment (Vara.eth)**
```bash
npx tsx deploy-l2.ts
```

**Phase 2: L1 Deployment (Hoodi)**
*Requires `VAULT_PROGRAM_ID` and `ORDERBOOK_PROGRAM_ID` in `.env`.*
```bash
npx tsx deploy-l1.ts
```

## 3. Verification

After deployment, verify the IDs in `.env`. If you enabled `WRITE_DEPLOYMENTS=true`, you can also check `deploy/clob/deployments.json`.

```json
VAULT_PROGRAM_ID=0x...        # L2 Vault Program ID
ORDERBOOK_PROGRAM_ID=0x...    # L2 Orderbook Program ID
VAULT_CALLER_ADDRESS=0x...    # L1 VaultCaller
ORDERBOOK_CALLER_ADDRESS=0x...# L1 OrderbookCaller
```

## 4. Troubleshooting

- **"Execution Reverted" during L2 Deployment:**
    - Check that your `PRIVATE_KEY` has sufficient Hoodi ETH.
    - Verify `ROUTER_ADDRESS` is correct and up-to-date.
    - Ensure your `ethexe` binary is compatible with the current testnet version.

- **"L2 Program ID not found":**
    - Ensure you ran `deploy-l2.ts` successfully before running `deploy-l1.ts`.

# CLOB deploy scripts (vara-eth)

These scripts follow a step-by-step deploy flow: upload WASM, create programs via the router, initialize with Sails payloads, and authorize the orderbook in the vault.

## Prereqs
- Node 18+
- Rust toolchain
- Foundry (for EVM ABI helpers)
- `ethexe` binary (build it in the `gear` repo, set `ETHEXE_BIN=/path/to/ethexe`; defaults to `/Users/ukintvs/Documents/projects/gear/target/release/ethexe`)
- `SENDER_ADDRESS` (optional; defaults to address derived from `PRIVATE_KEY`)

## Build WASM + IDL
```
cargo build -p vault-app -p orderbook --release
cargo build -p vault-client -p orderbook-client   # copies vault.idl/orderbook.idl into programs/
```

## Install deploy deps
```
npm install --prefix deploy/clob --legacy-peer-deps
```

## Env (.env)
Create or update `.env` in the project root:
```
PRIVATE_KEY=0x...
ROUTER_ADDRESS=0x579D6098197517140e5aec47c78d6f7181916dd6
ETH_RPC=https://hoodi-reth-rpc.gear-tech.io
ETH_RPC_WS=wss://hoodi-reth-rpc.gear-tech.io/ws
RPC_WS=ws://vara-eth-validator-1.gear-tech.io:9944
CHAIN_ID=560048
```

## Deployment Steps
*Note: Many commands now use the `@vara-eth/api` library directly, leveraging `PRIVATE_KEY` for signing transactions. `ethexe-cli` is still used as a fallback for WASM code uploading.*

### 1. Upload Code
Upload the WASM files to the router to get Code IDs (uses `ethexe tx upload -w -j` under the hood).
```bash
npm run upload:vault --prefix deploy/clob
npm run upload:ob --prefix deploy/clob
```
Add the printed `CODE_ID`s to `.env`:
```
VAULT_CODE_ID=0x...
ORDERBOOK_CODE_ID=0x...
```

### 2. Deploy Vault
Create and initialize the Vault program (uses `ethexe tx create` / `tx send-message`).
```bash
npm run create:vault --prefix deploy/clob
# Add VAULT_PROGRAM_ID=0x... to .env
npm run init:vault --prefix deploy/clob
```

### 3. Deploy Orderbook
Create and initialize the Orderbook program (linking it to the Vault; uses `ethexe tx create` / `tx send-message`).
```bash
npm run create:ob --prefix deploy/clob
# Add ORDERBOOK_PROGRAM_ID=0x... to .env
npm run init:ob --prefix deploy/clob
```

### 4. Authorize
Authorize the Orderbook in the Vault so it can manage funds (uses `ethexe tx send-message -w`).
```bash
npm run auth:ob --prefix deploy/clob
```

## Interaction scripts (manual ops)
All scripts accept Ethereum-style (20-byte) addresses or 32-byte actor IDs; they will pad to 32 bytes where needed. Set `WATCH_REPLIES=false` if your RPC cannot do subscriptions.

- Deposit into Vault (user, token, amount in wei):
  ```bash
  npm run vault:deposit --prefix deploy/clob -- 0xUSER 0xTOKEN 1000000000000000000
  ```
- Add market in Vault (orderbook id optional, defaults to `ORDERBOOK_PROGRAM_ID`):
  ```bash
  npm run vault:add-market --prefix deploy/clob -- 0xORDERBOOK
  ```
- Place order (user, side buy|sell, price, quantity, base token, quote token):
  ```bash
  npm run ob:place --prefix deploy/clob -- 0xUSER buy 1000000 500000000000000000 0xBASE 0xQUOTE
  ```
- Cancel order (user, orderId, base token, quote token):
  ```bash
  npm run ob:cancel --prefix deploy/clob -- 0xUSER 1 0xBASE 0xQUOTE
  ```
- Trigger matching loop for a market (base, quote):
  ```bash
  npm run ob:continue --prefix deploy/clob -- 0xBASE 0xQUOTE
  ```
- Top up executable balance (WVARA, wei units):
  ```bash
  npm run topup:exec --prefix deploy/clob -- 0xMIRROR 1000000000000000000
  ```
- Top up owned balance (ETH, wei units):
  ```bash
  npm run topup:owned --prefix deploy/clob -- 0xMIRROR 1000000000000000000
  ```
- Read vault mirror state (uses `ethexe tx query`):
  ```bash
  npm run read:vault --prefix deploy/clob
  ```
- Read vault via queries (admin/auth/balance/treasury; optional args user token program):
  ```bash
  # admin + optional authorized check + balance and treasury if args provided
  npm run read:vault:q --prefix deploy/clob -- 0xUSER 0xTOKEN 0xPROGRAM
  ```
- Read orderbook via queries (admin, vault, order counter, best bid/ask, optional order lookup):
  ```bash
  # optional args: orderId baseToken quoteToken
  npm run read:ob --prefix deploy/clob -- 1 0xBASE 0xQUOTE
  ```

## Sample end-to-end scenarios

**Scenario A: Create new IDs and init**
1) Upload WASM: `npm run upload:vault --prefix deploy/clob` → set `VAULT_CODE_ID`, `npm run upload:ob --prefix deploy/clob` → set `ORDERBOOK_CODE_ID`.
2) Create programs: `npm run create:vault --prefix deploy/clob`, `npm run create:ob --prefix deploy/clob` → set `VAULT_PROGRAM_ID`, `ORDERBOOK_PROGRAM_ID`.
3) Top up executable balances (e.g. 0.1 WVARA each):  
   `npm run topup:exec --prefix deploy/clob -- <VAULT_PROGRAM_ID> 100000000000000000`  
   `npm run topup:exec --prefix deploy/clob -- <ORDERBOOK_PROGRAM_ID> 100000000000000000`
4) Init: `npm run init:vault --prefix deploy/clob`, `npm run init:ob --prefix deploy/clob`
5) Authorize: `npm run auth:ob --prefix deploy/clob`

**Scenario B: Deposit and place a buy order**
1) Deposit quote token:  
   `npm run vault:deposit --prefix deploy/clob -- 0xUSER 0xQUOTE 1000000000000000000`
2) Add market (if not already):  
   `npm run vault:add-market --prefix deploy/clob -- 0xORDERBOOK`
3) Place order with required amount `price * quantity <= deposited`:  
   `npm run ob:place --prefix deploy/clob -- 0xUSER buy 1000000 1000000000000 0xBASE 0xQUOTE`
4) Inspect state:  
   `npm run read:vault:q --prefix deploy/clob -- 0xUSER 0xQUOTE` (check reserved)  
   `npm run read:ob --prefix deploy/clob -- 1`

**Scenario C: Cancel and unlock**
1) Cancel: `npm run ob:cancel --prefix deploy/clob -- 0xUSER 1 0xBASE 0xQUOTE`
2) Verify reserved back to available: `npm run read:vault:q --prefix deploy/clob -- 0xUSER 0xQUOTE`

## Optional: deploy EVM ABI helpers
Foundry scripts (under `deploy/clob`):
```
forge script ethereum/script/DeployVaultAbi.s.sol --broadcast --rpc-url $ETH_RPC
forge script ethereum/script/DeployOrderbookAbi.s.sol --broadcast --rpc-url $ETH_RPC
```
Requires `PRIVATE_KEY` in env. These deploy Solidity ABI wrappers (`VaultAbi`, `OrderbookAbi`) if you need on-chain facades.

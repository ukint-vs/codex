# Demo UI Hosting on DigitalOcean (Ubuntu + Docker Compose + Let's Encrypt)

This deployment bundle runs the existing demo UI server (`pnpm demo:ui`) behind Caddy with:
- automatic HTTPS certificates from Let's Encrypt
- free temporary hostname via `sslip.io`
- HTTP Basic Auth on all routes (UI + APIs)

The stack is UI-only (no auto-trader service).

## 1) Prerequisites

- DigitalOcean droplet with Ubuntu 22.04 or 24.04.
- Public IPv4 attached to the droplet.
- Ports open:
  - Droplet firewall: `22`, `80`, `443`
  - DigitalOcean network firewall (if enabled): allow inbound TCP `22`, `80`, `443`
- This repository checked out on the droplet.

## 2) One-time host bootstrap

Run as root (or with sudo) on Ubuntu:

```bash
cd /path/to/gear-clob
sudo bash deploy/demo-ui/scripts/bootstrap-ubuntu.sh "$USER"
```

After script completion, re-login so Docker group membership is applied.

## 3) Configure app runtime (`app.env`)

Create app env file:

```bash
cp deploy/demo-ui/app.env.example deploy/demo-ui/app.env
```

Edit `deploy/demo-ui/app.env` and set required values:
- `PRIVATE_KEY`
- `ROUTER_ADDRESS`
- `ORDERBOOK_ADDRESS`
- `BASE_TOKEN_VAULT_ADDRESS`
- `QUOTE_TOKEN_VAULT_ADDRESS`
- `ETHEREUM_WS_RPC`
- `VARA_ETH_WS_RPC`

Important: explicitly set `ETHEREUM_WS_RPC` and `VARA_ETH_WS_RPC` for hosted deployment.

## 4) Generate proxy env (`deploy.env`) and auth

Run:

```bash
bash deploy/demo-ui/scripts/init-env.sh
```

The script will:
- detect public IPv4
- default `DOMAIN` to `<public-ip>.sslip.io`
- prompt for Let's Encrypt email
- prompt for Basic Auth username/password
- generate `BASIC_AUTH_HASH` with Caddy
- write `deploy/demo-ui/deploy.env`
- validate required keys in `app.env`

If you edit `BASIC_AUTH_HASH` manually, keep Docker Compose escaping: write each `$` as `$$`.

## 5) Deploy

```bash
bash deploy/demo-ui/scripts/deploy.sh
```

This will:
- pull Caddy image
- build demo-ui image (`--no-cache` on first deploy)
- start containers in background

## 6) Verify HTTPS + auth

```bash
bash deploy/demo-ui/scripts/verify.sh
```

Checks performed:
- TLS endpoint reachable on `https://$DOMAIN`
- unauthenticated `/api/snapshot` returns `401`
- authenticated `/api/snapshot` returns `200` and includes `updatedAt`

## 7) Operations

### Switch RPC in web UI (no redeploy)

The header includes runtime RPC controls:
- `Ethereum WS RPC`
- `Vara WS RPC`
- `Apply RPC` / `Use Defaults`

This updates backend RPC connections in-memory and takes effect immediately.
Use this for switching between public testnet RPCs and host-local RPC bridges.

### View logs

```bash
docker compose -f deploy/demo-ui/docker-compose.yml logs -f caddy
docker compose -f deploy/demo-ui/docker-compose.yml logs -f demo-ui
```

### Restart services

```bash
docker compose -f deploy/demo-ui/docker-compose.yml up -d
```

### Update after code changes

```bash
bash deploy/demo-ui/scripts/update.sh
```

## 8) Troubleshooting

- ACME/certificate issue:
  - verify `DOMAIN` resolves to droplet public IPv4
  - verify inbound `80/443` are open in UFW and DigitalOcean firewall
  - check Caddy logs for challenge failures
- Site not reachable:
  - run `docker compose -f deploy/demo-ui/docker-compose.yml ps`
  - inspect Caddy logs
- Demo UI startup failure:
  - check `demo-ui` logs for missing env keys or RPC connection errors
  - verify `ETHEREUM_WS_RPC` and `VARA_ETH_WS_RPC` are reachable from the droplet

## 9) Rotation tasks

### Change Basic Auth password

```bash
bash deploy/demo-ui/scripts/init-env.sh
bash deploy/demo-ui/scripts/deploy.sh
```

### Rotate app secrets

- Update `deploy/demo-ui/app.env`
- Re-deploy:

```bash
bash deploy/demo-ui/scripts/deploy.sh
```

### Move from `sslip.io` to real domain

1. Create DNS `A` record for your domain/subdomain pointing to droplet IPv4.
2. Update `DOMAIN=` in `deploy/demo-ui/deploy.env`.
3. Re-deploy:

```bash
bash deploy/demo-ui/scripts/deploy.sh
```

Caddy will request a new Let's Encrypt certificate for the updated hostname.

## 10) Local node mode (host `setup-local-env.sh` + Docker demo-ui)

`scripts/setup-local-env.sh` runs Vara.Eth + Anvil on host ports `9944` and `8545`.
Because `demo-ui` runs in a container, do not use `127.0.0.1` for RPC in `app.env`.

Use:

```env
ETHEREUM_WS_RPC=ws://host.docker.internal:8545
VARA_ETH_WS_RPC=ws://host.docker.internal:9944
```

Recommended flow:

1. Start local node on host (keep it running in tmux/screen):

```bash
cd /path/to/gear-clob
export PATH_TO_VARA_ETH_BIN=/path/to/vara-eth
SKIP_BUILD=1 ./scripts/setup-local-env.sh
```

2. Sync addresses from root `.env` into `deploy/demo-ui/app.env` and replace RPC endpoints with `host.docker.internal`.

3. Re-deploy demo stack:

```bash
bash deploy/demo-ui/scripts/deploy.sh
```

4. Validate from container:

```bash
docker compose -f deploy/demo-ui/docker-compose.yml exec demo-ui sh -lc 'getent hosts host.docker.internal && nc -vz host.docker.internal 8545 && nc -vz host.docker.internal 9944'
```

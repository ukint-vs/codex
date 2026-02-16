#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${DEPLOY_DIR}/../.." && pwd)"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker command not found."
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "git command not found."
  exit 1
fi

echo "[1/4] Pulling latest code with ff-only..."
git -C "$REPO_ROOT" pull --ff-only

echo "[2/4] Pulling latest Caddy image..."
docker compose -f "${DEPLOY_DIR}/docker-compose.yml" pull caddy

echo "[3/4] Rebuilding demo-ui image..."
docker compose -f "${DEPLOY_DIR}/docker-compose.yml" build demo-ui

echo "[4/4] Restarting stack..."
docker compose -f "${DEPLOY_DIR}/docker-compose.yml" up -d
docker compose -f "${DEPLOY_DIR}/docker-compose.yml" ps

echo
echo "Update completed."
echo "ACME cert state was preserved in Docker volumes (caddy_data/caddy_config)."

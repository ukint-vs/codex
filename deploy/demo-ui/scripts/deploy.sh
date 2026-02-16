#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
FIRST_DEPLOY_MARKER="${DEPLOY_DIR}/.first_deploy_done"

cd "$DEPLOY_DIR"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker command not found."
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "docker compose plugin is not available."
  exit 1
fi

if [[ ! -f "${DEPLOY_DIR}/app.env" ]]; then
  echo "Missing ${DEPLOY_DIR}/app.env"
  echo "Create it from app.env.example."
  exit 1
fi

if [[ ! -f "${DEPLOY_DIR}/deploy.env" ]]; then
  echo "Missing ${DEPLOY_DIR}/deploy.env"
  echo "Generate it with scripts/init-env.sh."
  exit 1
fi

echo "[1/4] Pulling Caddy image..."
docker compose pull caddy

echo "[2/4] Building demo-ui image..."
if [[ -f "${FIRST_DEPLOY_MARKER}" ]]; then
  docker compose build demo-ui
else
  docker compose build --no-cache demo-ui
fi

echo "[3/4] Starting services..."
docker compose up -d

if [[ ! -f "${FIRST_DEPLOY_MARKER}" ]]; then
  touch "${FIRST_DEPLOY_MARKER}"
fi

echo "[4/4] Current service state:"
docker compose ps

echo
echo "Deployment completed."
echo "Follow logs:"
echo "  docker compose -f ${DEPLOY_DIR}/docker-compose.yml logs -f caddy"
echo "  docker compose -f ${DEPLOY_DIR}/docker-compose.yml logs -f demo-ui"

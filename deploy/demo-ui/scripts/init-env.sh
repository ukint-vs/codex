#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DEPLOY_ENV="${DEPLOY_DIR}/deploy.env"
DEPLOY_ENV_EXAMPLE="${DEPLOY_DIR}/deploy.env.example"
APP_ENV="${DEPLOY_DIR}/app.env"
APP_ENV_EXAMPLE="${DEPLOY_DIR}/app.env.example"

required_app_keys=(
  "PRIVATE_KEY"
  "ROUTER_ADDRESS"
  "ORDERBOOK_ADDRESS"
  "BASE_TOKEN_VAULT_ADDRESS"
  "QUOTE_TOKEN_VAULT_ADDRESS"
  "ETHEREUM_WS_RPC"
  "VARA_ETH_WS_RPC"
)

detect_public_ipv4() {
  curl -4fsS https://api.ipify.org 2>/dev/null \
    || curl -4fsS https://ifconfig.me 2>/dev/null \
    || curl -4fsS https://icanhazip.com 2>/dev/null \
    || true
}

is_ipv4() {
  [[ "$1" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]
}

has_non_empty_env_key() {
  local key="$1"
  local value
  value="$(awk -F= -v k="$key" '
    /^[[:space:]]*#/ { next }
    $1 == k {
      $1 = ""
      sub(/^=/, "")
      print
      exit
    }
  ' "$APP_ENV")"
  [[ -n "${value//[[:space:]]/}" ]]
}

if ! command -v docker >/dev/null 2>&1; then
  echo "docker command not found. Install Docker first."
  exit 1
fi

if [[ ! -f "$APP_ENV" ]]; then
  if [[ -f "$APP_ENV_EXAMPLE" ]]; then
    cp "$APP_ENV_EXAMPLE" "$APP_ENV"
    echo "Created ${APP_ENV} from example. Fill required values and run again."
  else
    echo "Missing ${APP_ENV}. Create it before continuing."
  fi
  exit 1
fi

missing=()
for key in "${required_app_keys[@]}"; do
  if ! has_non_empty_env_key "$key"; then
    missing+=("$key")
  fi
done

if (( ${#missing[@]} > 0 )); then
  echo "app.env is missing required non-empty keys:"
  for key in "${missing[@]}"; do
    echo "  - ${key}"
  done
  exit 1
fi

PUBLIC_IP="$(detect_public_ipv4 | tr -d '\r\n')"
if is_ipv4 "$PUBLIC_IP"; then
  DEFAULT_DOMAIN="${PUBLIC_IP}.sslip.io"
else
  DEFAULT_DOMAIN="example.sslip.io"
  echo "Could not auto-detect public IPv4; using placeholder default domain."
fi

DEFAULT_EMAIL="ops@example.com"
DEFAULT_USER="demo"

read -r -p "Domain [${DEFAULT_DOMAIN}]: " DOMAIN_INPUT
DOMAIN="${DOMAIN_INPUT:-$DEFAULT_DOMAIN}"

read -r -p "Let's Encrypt email [${DEFAULT_EMAIL}]: " EMAIL_INPUT
LETSENCRYPT_EMAIL="${EMAIL_INPUT:-$DEFAULT_EMAIL}"

read -r -p "Basic auth user [${DEFAULT_USER}]: " USER_INPUT
BASIC_AUTH_USER="${USER_INPUT:-$DEFAULT_USER}"

read -r -s -p "Basic auth password: " BASIC_AUTH_PASSWORD
echo
if [[ -z "${BASIC_AUTH_PASSWORD}" ]]; then
  echo "Password cannot be empty."
  exit 1
fi

read -r -s -p "Confirm password: " BASIC_AUTH_PASSWORD_CONFIRM
echo
if [[ "${BASIC_AUTH_PASSWORD}" != "${BASIC_AUTH_PASSWORD_CONFIRM}" ]]; then
  echo "Password confirmation does not match."
  exit 1
fi

echo "Generating bcrypt hash with Caddy..."
BASIC_AUTH_HASH="$(docker run --rm caddy:2.10-alpine caddy hash-password --plaintext "${BASIC_AUTH_PASSWORD}")"
BASIC_AUTH_HASH_ESCAPED="${BASIC_AUTH_HASH//\$/\$\$}"

if [[ -z "${BASIC_AUTH_HASH}" ]]; then
  echo "Failed to generate BASIC_AUTH_HASH."
  exit 1
fi

if [[ ! -f "$DEPLOY_ENV_EXAMPLE" ]]; then
  echo "Warning: ${DEPLOY_ENV_EXAMPLE} not found. Writing ${DEPLOY_ENV} directly."
fi

cat >"$DEPLOY_ENV" <<EOF
DOMAIN=${DOMAIN}
LETSENCRYPT_EMAIL=${LETSENCRYPT_EMAIL}
BASIC_AUTH_USER=${BASIC_AUTH_USER}
BASIC_AUTH_HASH=${BASIC_AUTH_HASH_ESCAPED}
EOF

chmod 600 "$DEPLOY_ENV"

echo
echo "Wrote ${DEPLOY_ENV}"
echo "Validated required app.env keys."
echo "Next: bash deploy/demo-ui/scripts/deploy.sh"

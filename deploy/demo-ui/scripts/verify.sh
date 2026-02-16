#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DEPLOY_ENV="${DEPLOY_DIR}/deploy.env"

read_env_key() {
  local file="$1"
  local key="$2"
  awk -F= -v k="$key" '
    /^[[:space:]]*#/ { next }
    $1 == k {
      $1 = ""
      sub(/^=/, "")
      print
      exit
    }
  ' "$file"
}

if [[ ! -f "$DEPLOY_ENV" ]]; then
  echo "Missing ${DEPLOY_ENV}"
  exit 1
fi

DOMAIN="$(read_env_key "$DEPLOY_ENV" "DOMAIN" | tr -d '\r\n')"
AUTH_USER="$(read_env_key "$DEPLOY_ENV" "BASIC_AUTH_USER" | tr -d '\r\n')"

if [[ -z "$DOMAIN" || -z "$AUTH_USER" ]]; then
  echo "DOMAIN or BASIC_AUTH_USER is missing in deploy.env"
  exit 1
fi

AUTH_PASS="${BASIC_AUTH_PASSWORD:-}"
if [[ -z "$AUTH_PASS" ]]; then
  read -r -s -p "Basic auth password for ${AUTH_USER}: " AUTH_PASS
  echo
fi

if [[ -z "$AUTH_PASS" ]]; then
  echo "Password is required."
  exit 1
fi

echo "Checking TLS certificate for https://${DOMAIN} ..."
if command -v openssl >/dev/null 2>&1; then
  TLS_INFO="$(echo | openssl s_client -connect "${DOMAIN}:443" -servername "${DOMAIN}" 2>/dev/null \
    | openssl x509 -noout -issuer -subject -dates 2>/dev/null || true)"
  if [[ -n "$TLS_INFO" ]]; then
    echo "$TLS_INFO"
  else
    echo "Could not read certificate details yet. Continuing with HTTP checks."
  fi
fi

echo "Verifying unauthenticated access is blocked..."
UNAUTH_CODE="$(curl -sS -o /dev/null -w "%{http_code}" "https://${DOMAIN}/api/snapshot" || true)"
if [[ "$UNAUTH_CODE" != "401" ]]; then
  echo "Expected 401 for unauthenticated /api/snapshot, got: ${UNAUTH_CODE}"
  exit 1
fi

echo "Verifying authenticated API access..."
TMP_BODY="$(mktemp)"
AUTH_CODE="$(curl -sS -u "${AUTH_USER}:${AUTH_PASS}" -o "$TMP_BODY" -w "%{http_code}" "https://${DOMAIN}/api/snapshot" || true)"
if [[ "$AUTH_CODE" != "200" ]]; then
  rm -f "$TMP_BODY"
  echo "Expected 200 for authenticated /api/snapshot, got: ${AUTH_CODE}"
  exit 1
fi

if ! grep -q '"updatedAt"' "$TMP_BODY"; then
  rm -f "$TMP_BODY"
  echo "Authenticated snapshot response missing updatedAt."
  exit 1
fi

rm -f "$TMP_BODY"

echo "Verification passed:"
echo "  - HTTPS endpoint reachable"
echo "  - Unauthenticated /api/snapshot returns 401"
echo "  - Authenticated /api/snapshot returns 200 with updatedAt"

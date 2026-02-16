#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo bash $0 [target_user]"
  exit 1
fi

TARGET_USER="${1:-${SUDO_USER:-}}"

echo "[1/6] Installing base packages..."
apt-get update
apt-get install -y ca-certificates curl gnupg lsb-release ufw

echo "[2/6] Configuring Docker apt repository..."
install -m 0755 -d /etc/apt/keyrings
rm -f /etc/apt/keyrings/docker.asc /etc/apt/keyrings/docker.gpg
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

ARCH="$(dpkg --print-architecture)"
CODENAME="$(. /etc/os-release && echo "${VERSION_CODENAME}")"
cat >/etc/apt/sources.list.d/docker.list <<EOF
deb [arch=${ARCH} signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${CODENAME} stable
EOF

echo "[3/6] Installing Docker Engine + Compose plugin..."
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

echo "[4/6] Enabling Docker service..."
systemctl enable --now docker

echo "[5/6] Adding user to docker group..."
if [[ -n "${TARGET_USER}" ]] && id "${TARGET_USER}" >/dev/null 2>&1; then
  usermod -aG docker "${TARGET_USER}"
  echo "Added ${TARGET_USER} to docker group."
else
  echo "Could not infer target user. Re-run with explicit username: sudo bash $0 <user>"
fi

echo "[6/6] Configuring firewall (ufw)..."
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp

if ufw status | grep -qi "inactive"; then
  ufw --force enable
fi

echo
ufw status verbose
echo
echo "Bootstrap complete."
echo "Next:"
echo "1) Re-login so docker group membership is applied."
echo "2) In this repo, create deploy env files:"
echo "   cp deploy/demo-ui/app.env.example deploy/demo-ui/app.env"
echo "   bash deploy/demo-ui/scripts/init-env.sh"
echo "3) Deploy:"
echo "   bash deploy/demo-ui/scripts/deploy.sh"

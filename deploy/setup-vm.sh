#!/usr/bin/env bash
# One-shot setup for a fresh Ubuntu 24.04 VM (1 vCPU / 2 GB is enough). Creates its OWN fresh testnet
# deployment (vault, 2 auditors, arbiter, relayer, tUSDC) with the faucet, so no keys live in the repo.
# Usage:  git clone https://github.com/Shinigami-tech/milestone-vault && cd milestone-vault && sudo bash deploy/setup-vm.sh
set -euo pipefail
cd "$(dirname "$0")/.."
APP_DIR=$(pwd)
IP=$(curl -s4 ifconfig.me || hostname -I | awk '{print $1}')

echo "==> Installing Docker and Node.js 22"
apt-get update -y
DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl gnupg iptables-persistent
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
if ! command -v node >/dev/null; then curl -fsSL https://deb.nodesource.com/setup_22.x | bash -; apt-get install -y nodejs; fi

echo "==> App dependencies and the audit sandbox image"
npm ci --omit=dev --omit=optional || npm install --omit=dev --omit=optional
docker build -t mv-auditor-sandbox auditor/sandbox

echo "==> Containment layer 2: sandboxes can never reach the cloud metadata service"
iptables -C DOCKER-USER -d 169.254.169.254 -j DROP 2>/dev/null || iptables -I DOCKER-USER -d 169.254.169.254 -j DROP
netfilter-persistent save || true

echo "==> Fresh testnet deployment"
if [ ! -f .env ]; then
  MV_EXTRA_ENV="PUBLIC_URL=http://$IP:8090
SITES_URL=http://172.17.0.1:8090/sites
MV_ALLOW_HOSTS=172.17.0.1" node scripts/setup-testnet.mjs
fi

echo "==> systemd service"
cat > /etc/systemd/system/milestone-vault.service <<UNIT
[Unit]
Description=Milestone Vault (deal room + 2 auditor agents)
After=docker.service network-online.target
Requires=docker.service
[Service]
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
ExecStart=$(command -v node) app/server.mjs
Restart=always
User=root
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now milestone-vault
command -v ufw >/dev/null && ufw allow 8090/tcp || true
echo "==> Done: http://$IP:8090"

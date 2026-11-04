#!/bin/bash
# Cloud "startup script" (Vultr, DigitalOcean user-data, …): installs Milestone Vault on first boot, no SSH.
# Also opens a one-time page on port 8091 to paste an optional NEAR AI Cloud key (verified before saving),
# and auto-updates from GitHub every 5 minutes (the .env with testnet keys is untracked and never touched).
exec > /var/log/milestone-vault-setup.log 2>&1
set -x
export DEBIAN_FRONTEND=noninteractive
apt-get update -y && apt-get install -y git
git clone https://github.com/Shinigami-tech/milestone-vault /opt/milestone-vault
cd /opt/milestone-vault && bash deploy/setup-vm.sh

cat > /opt/mv-keyform.mjs <<'JS'
import http from "node:http"; import fs from "node:fs"; import { execSync } from "node:child_process";
const ENV = "/opt/milestone-vault/.env";
const page = (msg = "") => `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width"><body style="font:16px system-ui;max-width:560px;margin:60px auto">
<h2>Milestone Vault · NEAR AI Cloud key (optional)</h2><p>Paste a NEAR AI Cloud API key from <b>cloud.near.ai → API Keys</b>. It is checked before saving. The auditors then write their notes with verifiable private inference (TEE). Verdicts never depend on it.</p>
<form method=post><input name=key type=password style="width:100%;padding:10px" required><p><input name=model placeholder="model id (optional)" style="width:100%;padding:10px"></p><button style="padding:10px 18px">Save</button></form><p>${msg}</p>`;
http.createServer((req, res) => {
  if (req.method !== "POST") { res.writeHead(200, { "content-type": "text/html" }); return res.end(page()); }
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", async () => {
    const p = new URLSearchParams(b); const key = (p.get("key") || "").trim(); const model = (p.get("model") || "").trim();
    let ok = false; try { ok = (await fetch("https://cloud-api.near.ai/v1/models", { headers: { Authorization: "Bearer " + key } })).ok; } catch {}
    if (!/^[A-Za-z0-9_\-\.]{16,}$/.test(key) || !ok) { res.writeHead(400, { "content-type": "text/html" }); return res.end(page("NEAR AI Cloud rejected this key.")); }
    let env = fs.readFileSync(ENV, "utf8").replace(/^NEARAI_API_KEY=.*$/m, "NEARAI_API_KEY=" + key);
    if (model) env = env.replace(/^NEARAI_MODEL=.*$/m, "NEARAI_MODEL=" + model);
    fs.writeFileSync(ENV, env, { mode: 0o600 }); execSync("systemctl restart milestone-vault");
    res.writeHead(200, { "content-type": "text/html" }); res.end("<p style='font:16px system-ui;margin:60px'>Saved. The auditors now write TEE-signed notes. You can close this tab.</p>");
    setTimeout(() => execSync("systemctl disable --now mv-keyform"), 1500);
  });
}).listen(8091);
JS
cat > /etc/systemd/system/mv-keyform.service <<'UNIT'
[Unit]
Description=Milestone Vault one-time NEAR AI key form
After=network-online.target
[Service]
ExecStart=/usr/bin/node /opt/mv-keyform.mjs
[Install]
WantedBy=multi-user.target
UNIT

cat > /opt/mv-update.sh <<'SH'
#!/bin/bash
cd /opt/milestone-vault || exit 0
old=$(git rev-parse HEAD); git fetch -q origin && git reset -q --hard origin/HEAD || exit 0
new=$(git rev-parse HEAD); [ "$old" = "$new" ] && exit 0
git diff --name-only "$old" "$new" | grep -q '^auditor/sandbox/' && docker build -q -t mv-auditor-sandbox auditor/sandbox
git diff --name-only "$old" "$new" | grep -q '^package' && (npm ci --omit=dev --omit=optional || npm install --omit=dev --omit=optional)
systemctl restart milestone-vault
SH
chmod +x /opt/mv-update.sh
cat > /etc/systemd/system/mv-update.service <<'UNIT'
[Unit]
Description=Milestone Vault auto-update
[Service]
Type=oneshot
ExecStart=/opt/mv-update.sh
UNIT
cat > /etc/systemd/system/mv-update.timer <<'UNIT'
[Unit]
Description=Milestone Vault auto-update every 5 minutes
[Timer]
OnBootSec=3min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
UNIT
command -v ufw >/dev/null && ufw allow 8091/tcp || true
systemctl daemon-reload && systemctl enable --now mv-keyform mv-update.timer
echo SETUP_DONE

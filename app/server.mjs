// Milestone Vault web app: the demo "deal room" plus the auditor agent running in the same process.
// The client and freelancer buttons sign with DEMO testnet accounts from .env so a judge can try the
// whole flow without a wallet. The auditor signs with its own function-call key only.
import express from "express";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createAuditor } from "../auditor/agent.mjs";
import { llmEnabled, modelName } from "../auditor/engine/llm.mjs";
import { CONTAINMENT_POLICY } from "../auditor/engine/sandbox.mjs";
import { runAttack } from "../lib/attack.mjs";
import { account, accountUrl, call, provider, toYocto, txUrl, VAULT, view, NETWORK, EXPLORER } from "../lib/near.mjs";

const PORT = +process.env.PORT || 8090;
const DATA = process.env.MV_DATA || new URL("../data", import.meta.url).pathname;
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
// The address the SANDBOX uses to reach the demo sites (inside Docker, the host is 172.17.0.1).
const SITES_URL = (process.env.SITES_URL || `${PUBLIC_URL}/sites`).replace(/\/$/, "");
const ALLOW = (process.env.MV_ALLOW_HOSTS || "").split(",").map((s) => s.trim()).filter(Boolean);
mkdirSync(DATA, { recursive: true });

if (!VAULT) { console.error("VAULT_CONTRACT is not set. Run: npm run build:contract && npm run setup:testnet"); process.exit(1); }

const bus = new EventEmitter(); bus.setMaxListeners(100);
const history = [];
const emit = (ev) => { const e = { t: Date.now(), ...ev }; history.push(e); if (history.length > 500) history.shift(); bus.emit("ev", e); };

const client = account(process.env.DEMO_CLIENT_ACCOUNT, process.env.DEMO_CLIENT_KEY);
const freelancer = account(process.env.DEMO_FREELANCER_ACCOUNT, process.env.DEMO_FREELANCER_KEY);
const auditor = createAuditor({ dataDir: DATA, allowHosts: ALLOW, publicUrl: PUBLIC_URL, emit });

const VERSIONS = {
  v1: { file: "v1.html", label: "First draft (rushed)" },
  trap: { file: "trap.html", label: "Polished, with a pasted 'analytics' snippet" },
  v2: { file: "v2.html", label: "Final version" },
};

const app = express();
app.use(express.json({ limit: "20kb" }));
app.use(express.static(new URL("../web", import.meta.url).pathname));
app.use("/sites", express.static(new URL("../demo/sites", import.meta.url).pathname));
app.use("/evidence", express.static(join(DATA, "evidence"), { setHeaders: (r) => r.set("Content-Type", "application/json") }));
app.use("/runs", express.static(join(DATA, "runs")));

async function balance(id) {
  try { const a = await provider.viewAccount({ accountId: id, finality: "optimistic" }); return Number(BigInt(a.amount) / 10n ** 20n) / 10000; } catch { return null; }
}

app.get("/api/info", async (req, res) => {
  res.json({
    network: NETWORK, explorer: EXPLORER, vault: VAULT, vaultUrl: accountUrl(VAULT),
    auditor: process.env.AUDITOR_ACCOUNT, auditorUrl: accountUrl(process.env.AUDITOR_ACCOUNT),
    client: process.env.DEMO_CLIENT_ACCOUNT, freelancer: process.env.DEMO_FREELANCER_ACCOUNT,
    demo: Boolean(client && freelancer), llm: llmEnabled() ? modelName() : null, policy: CONTAINMENT_POLICY,
    versions: Object.fromEntries(Object.entries(VERSIONS).map(([k, v]) => [k, { ...v, url: `${PUBLIC_URL}/sites/${v.file}` }])),
  });
});

app.get("/api/balances", async (req, res) => {
  const [c, f, v] = await Promise.all([balance(process.env.DEMO_CLIENT_ACCOUNT), balance(process.env.DEMO_FREELANCER_ACCOUNT), balance(VAULT)]);
  res.json({ client: c, freelancer: f, vault: v });
});

app.get("/api/jobs", async (req, res) => { try { res.json(await view("get_jobs", {})); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get("/api/jobs/:id", async (req, res) => { try { res.json(await view("get_job", { job_id: req.params.id })); } catch (e) { res.status(500).json({ error: e.message }); } });

app.post("/api/demo/job", async (req, res) => {
  if (!client) return res.status(400).json({ error: "Demo accounts are not configured" });
  const amount = 2; // NEAR, testnet
  const job = {
    freelancer: process.env.DEMO_FREELANCER_ACCOUNT,
    title: "Daily Grind coffee shop website",
    criteria: { min_overall: 75, min_accessibility: 90, min_mobile: 90, min_seo: 80, max_broken_links: 0, forbid_malicious_scripts: true },
    milestones: [{ title: "Mobile-ready landing page", amount: toYocto(amount) }],
    deadline_secs: 7 * 24 * 3600,
  };
  try {
    emit({ type: "log", line: `Client locks ${amount} NEAR in the vault for "${job.title}"…` });
    const tx = await call(client, "create_job", { job }, { deposit: toYocto(amount) });
    emit({ type: "job_created", jobId: tx.value, amount, tx: tx.url, criteria: job.criteria });
    res.json({ jobId: tx.value, tx: tx.url });
  } catch (e) { emit({ type: "log", line: `create_job failed: ${e.message}` }); res.status(500).json({ error: e.message, tx: e.url }); }
});

app.post("/api/demo/submit", async (req, res) => {
  if (!freelancer) return res.status(400).json({ error: "Demo accounts are not configured" });
  const v = VERSIONS[req.body?.version];
  if (!v) return res.status(400).json({ error: "Unknown version" });
  const jobId = String(req.body?.jobId ?? "");
  const url = `${SITES_URL}/${v.file}`;
  try {
    const tx = await call(freelancer, "submit", { job_id: jobId, milestone: 0, url });
    emit({ type: "submitted", jobId, milestone: 0, version: req.body.version, label: v.label, url: `${PUBLIC_URL}/sites/${v.file}`, tx: tx.url });
    res.json({ tx: tx.url });
  } catch (e) { emit({ type: "log", line: `submit failed: ${e.message}` }); res.status(500).json({ error: e.message, tx: e.url }); }
});

let attacking = false;
app.post("/api/demo/attack", async (req, res) => {
  if (attacking) return res.status(409).json({ error: "Attack already running" });
  attacking = true;
  res.json({ started: true });
  try { await runAttack((ev) => emit(ev)); } catch (e) { emit({ type: "attack_done", held: null, error: e.message }); } finally { attacking = false; }
});

app.get("/api/events", (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();
  const send = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  const since = +req.query.since || Date.now();
  history.filter((e) => e.t >= since).forEach(send);
  bus.on("ev", send);
  const ping = setInterval(() => res.write(": ping\n\n"), 15000);
  req.on("close", () => { clearInterval(ping); bus.off("ev", send); });
});

app.listen(PORT, () => {
  console.log(`Milestone Vault on ${PUBLIC_URL} · vault ${VAULT} (${NETWORK}) · auditor ${auditor.enabled ? process.env.AUDITOR_ACCOUNT : "off"} · summary: ${llmEnabled() ? "NEAR AI " + modelName() : "rules"}`);
  if (auditor.enabled) auditor.start(4000);
});

export { txUrl };

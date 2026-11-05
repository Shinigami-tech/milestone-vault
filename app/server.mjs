// Milestone Vault web app: the demo "deal room" plus two independent auditor agents running in the
// same process. The client and freelancer buttons sign with DEMO testnet accounts from .env so a
// judge can try the whole flow without a wallet. Each auditor signs with its own function-call key.
import express from "express";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createAuditor } from "../auditor/agent.mjs";
import { llmEnabled, modelName, pickModel } from "../auditor/engine/llm.mjs";
import { CONTAINMENT_POLICY } from "../auditor/engine/sandbox.mjs";
import { runAttack } from "../lib/attack.mjs";
import { gaslessSubmit, RELAY_METHODS } from "../lib/relayer.mjs";
import { statementCsv } from "../lib/statement.mjs";
import { account, accountUrl, call, provider, toYocto, txUrl, VAULT, view, viewOn, NETWORK, EXPLORER } from "../lib/near.mjs";

const PORT = +process.env.PORT || 8090;
const DATA = process.env.MV_DATA || new URL("../data", import.meta.url).pathname;
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
// The address the SANDBOX uses to reach the demo sites (inside Docker, the host is 172.17.0.1).
const SITES_URL = (process.env.SITES_URL || `${PUBLIC_URL}/sites`).replace(/\/$/, "");
const ALLOW = (process.env.MV_ALLOW_HOSTS || "").split(",").map((s) => s.trim()).filter(Boolean);
const TUSDC = process.env.TUSDC_CONTRACT || "";
const CHALLENGE_SECS = +process.env.MV_CHALLENGE_SECS || 45; // demo-sized; real jobs would use days
const DEMO_NEAR = 0.5; // testnet NEAR per demo milestone
mkdirSync(DATA, { recursive: true });

if (!VAULT) { console.error("VAULT_CONTRACT is not set. Run: npm run build:contract && npm run build:token && npm run setup:testnet"); process.exit(1); }

const bus = new EventEmitter(); bus.setMaxListeners(100);
const history = [];
const emit = (ev) => { const e = { t: Date.now(), ...ev }; history.push(e); if (history.length > 800) history.shift(); bus.emit("ev", e); };

const client = account(process.env.DEMO_CLIENT_ACCOUNT, process.env.DEMO_CLIENT_KEY);
const freelancer = account(process.env.DEMO_FREELANCER_ACCOUNT, process.env.DEMO_FREELANCER_KEY);
const auditors = [
  createAuditor({ id: "A", accountId: process.env.AUDITOR_A_ACCOUNT, key: process.env.AUDITOR_A_KEY, dataDir: DATA, allowHosts: ALLOW, publicUrl: PUBLIC_URL, emit, keeper: true }),
  createAuditor({ id: "B", accountId: process.env.AUDITOR_B_ACCOUNT, key: process.env.AUDITOR_B_KEY, dataDir: DATA, allowHosts: ALLOW, publicUrl: PUBLIC_URL, emit }),
];

const VERSIONS = {
  v1: { file: "v1.html", label: "First draft (rushed)" },
  trap: { file: "trap.html", label: "Polished, with a pasted 'analytics' snippet" },
  v2: { file: "v2.html", label: "Final version" },
};

const app = express();
app.use(express.json({ limit: "20kb" }));
app.use(express.static(new URL("../web", import.meta.url).pathname));
app.use("/sites", express.static(new URL("../demo/sites", import.meta.url).pathname));
const json = { setHeaders: (r) => r.set("Content-Type", "application/json") };
app.use("/evidence", express.static(join(DATA, "evidence"), json));
app.use("/attestations", express.static(join(DATA, "attestations"), json));
app.use("/runs", express.static(join(DATA, "runs")));

async function nearBalance(id) {
  try { const a = await provider.viewAccount({ accountId: id, finality: "optimistic" }); return Number(BigInt(a.amount) / 10n ** 20n) / 10000; } catch { return null; }
}
async function usdcBalance(id) {
  if (!TUSDC || !id) return null;
  try { return Number(await viewOn(TUSDC, "ft_balance_of", { account_id: id })) / 1e6; } catch { return null; }
}

app.get("/api/info", async (req, res) => {
  let config = null; try { config = await view("get_config", {}); } catch {}
  res.json({
    network: NETWORK, explorer: EXPLORER, vault: VAULT, vaultUrl: accountUrl(VAULT), config,
    auditors: auditors.map((a) => ({ id: a.id, account: a.accountId, url: accountUrl(a.accountId), enabled: a.enabled })),
    client: process.env.DEMO_CLIENT_ACCOUNT, freelancer: process.env.DEMO_FREELANCER_ACCOUNT,
    arbiter: process.env.ARBITER_ACCOUNT, relayer: process.env.RELAYER_ACCOUNT, relayMethods: RELAY_METHODS, token: TUSDC, tokenUrl: TUSDC && accountUrl(TUSDC),
    challengeSecs: CHALLENGE_SECS, demoNear: DEMO_NEAR, demo: Boolean(client && freelancer), llm: llmEnabled() ? modelName() : null, policy: CONTAINMENT_POLICY,
    versions: Object.fromEntries(Object.entries(VERSIONS).map(([k, v]) => [k, { ...v, url: `${PUBLIC_URL}/sites/${v.file}` }])),
  });
});

app.get("/api/balances", async (req, res) => {
  const ids = { client: process.env.DEMO_CLIENT_ACCOUNT, freelancer: process.env.DEMO_FREELANCER_ACCOUNT, vault: VAULT, auditorA: process.env.AUDITOR_A_ACCOUNT, auditorB: process.env.AUDITOR_B_ACCOUNT, relayer: process.env.RELAYER_ACCOUNT };
  const out = {};
  await Promise.all(Object.entries(ids).map(async ([k, id]) => { out[k] = { near: await nearBalance(id), usdc: await usdcBalance(id) }; }));
  res.json(out);
});

app.get("/api/jobs", async (req, res) => { try { res.json(await view("get_jobs", {})); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get("/api/jobs/:id", async (req, res) => { try { res.json(await view("get_job", { job_id: req.params.id })); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get("/api/jobs/:id/statement.csv", async (req, res) => {
  try {
    const job = await view("get_job", { job_id: req.params.id });
    if (!job) return res.status(404).send("No such job");
    res.set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="milestone-vault-job-${job.id}.csv"` });
    res.send(statementCsv(job, { explorer: EXPLORER, vault: VAULT, publicUrl: PUBLIC_URL }));
  } catch (e) { res.status(500).send(e.message); }
});

// Demo money recycler: judges can click "Lock" as often as they like. When the demo client runs low,
// the demo freelancer sends its testnet NEAR back, and tUSDC is topped up from the open testnet faucet.
async function ensureDemoFunds(usdc) {
  try {
    if (usdc) {
      if ((await usdcBalance(process.env.DEMO_CLIENT_ACCOUNT)) < 100) await call(client, "mint", { account_id: process.env.DEMO_CLIENT_ACCOUNT, amount: "1000000000" }, { receiverId: TUSDC });
      return;
    }
    const c = await nearBalance(process.env.DEMO_CLIENT_ACCOUNT), f = await nearBalance(process.env.DEMO_FREELANCER_ACCOUNT);
    if (c < 3 && f > 4) {
      const back = Math.floor((f - 3) * 100) / 100;
      const { actions } = await import("near-api-js");
      await freelancer.signAndSendTransaction({ receiverId: process.env.DEMO_CLIENT_ACCOUNT, actions: [actions.transfer(BigInt(toYocto(back)))] });
      emit({ type: "log", line: `Demo recycler: freelancer returned ${back} testnet NEAR to the client so the demo keeps working.` });
    }
  } catch (e) { emit({ type: "log", line: `Demo recycler skipped: ${e.message}` }); }
}

const CRITERIA = { min_overall: 75, min_accessibility: 90, min_mobile: 90, min_seo: 80, max_broken_links: 0, forbid_malicious_scripts: true };
async function createDemoJob(usdc) {
  const base = {
    freelancer: process.env.DEMO_FREELANCER_ACCOUNT,
    title: "Daily Grind coffee shop website",
    criteria: CRITERIA,
    deadline_secs: 7 * 24 * 3600,
    challenge_secs: CHALLENGE_SECS,
  };
  await ensureDemoFunds(usdc);
  let tx, amountLabel;
  if (usdc) {
    // 50 tUSDC for the milestone + 6 audits × 0.25 tUSDC for the auditors (6 decimals)
    const job = { ...base, milestones: [{ title: "Mobile-ready landing page", amount: "50000000" }], audit_fee: "250000", audit_budget: "1500000" };
    amountLabel = "50 tUSDC (+1.5 tUSDC audit budget)";
    emit({ type: "log", line: `Client locks ${amountLabel} in the vault via ft_transfer_call…` });
    tx = await call(client, "ft_transfer_call", { receiver_id: VAULT, amount: "51500000", msg: JSON.stringify(job) }, { deposit: "1", gas: "150000000000000", receiverId: TUSDC });
    const jobs = await view("get_jobs", {});
    tx.value = jobs[jobs.length - 1].id;
  } else {
    const job = { ...base, milestones: [{ title: "Mobile-ready landing page", amount: toYocto(DEMO_NEAR) }], audit_fee: toYocto(0.01), audit_budget: toYocto(0.06) };
    amountLabel = `${DEMO_NEAR} NEAR (+0.06 NEAR audit budget)`;
    emit({ type: "log", line: `Client locks ${amountLabel} in the vault for "${base.title}"…` });
    tx = await call(client, "create_job", { job }, { deposit: toYocto(DEMO_NEAR + 0.06) });
  }
  emit({ type: "job_created", jobId: tx.value, amount: amountLabel, currency: usdc ? "tUSDC" : "NEAR", tx: tx.url, criteria: CRITERIA, challengeSecs: CHALLENGE_SECS });
  return { jobId: tx.value, tx: tx.url };
}
app.post("/api/demo/job", async (req, res) => {
  if (!client) return res.status(400).json({ error: "Demo accounts are not configured" });
  try { res.json(await createDemoJob(req.body?.currency === "usdc" && TUSDC)); }
  catch (e) { emit({ type: "log", line: `create_job failed: ${e.message}` }); res.status(500).json({ error: e.message, tx: e.url }); }
});

app.post("/api/demo/submit", async (req, res) => {
  if (!freelancer) return res.status(400).json({ error: "Demo accounts are not configured" });
  const v = VERSIONS[req.body?.version];
  if (!v) return res.status(400).json({ error: "Unknown version" });
  const jobId = String(req.body?.jobId ?? "");
  const url = `${SITES_URL}/${v.file}`;
  try {
    const before = await nearBalance(process.env.DEMO_FREELANCER_ACCOUNT);
    // Gasless: the freelancer signs a meta transaction; our relayer pays the gas.
    const tx = await gaslessSubmit(freelancer, { job_id: jobId, milestone: 0, url });
    emit({ type: "submitted", jobId, milestone: 0, version: req.body.version, label: v.label, url: `${PUBLIC_URL}/sites/${v.file}`, tx: tx.url, gasless: true, relayer: process.env.RELAYER_ACCOUNT, freelancerNearBefore: before });
    res.json({ tx: tx.url });
  } catch (e) { emit({ type: "log", line: `submit failed: ${e.message}` }); res.status(500).json({ error: e.message, tx: e.url }); }
});

app.post("/api/demo/dispute", async (req, res) => {
  if (!client) return res.status(400).json({ error: "Demo accounts are not configured" });
  try {
    const tx = await call(client, "dispute", { job_id: String(req.body?.jobId ?? ""), milestone: 0, reason: String(req.body?.reason || "The menu prices on the site are wrong").slice(0, 200) });
    emit({ type: "disputed", jobId: req.body?.jobId, milestone: 0, tx: tx.url });
    res.json({ tx: tx.url });
  } catch (e) { res.status(500).json({ error: e.message, tx: e.url }); }
});

const arbiter = account(process.env.ARBITER_ACCOUNT, process.env.ARBITER_KEY);
app.post("/api/demo/resolve", async (req, res) => {
  if (!arbiter) return res.status(400).json({ error: "Arbiter is not configured" });
  try {
    const pay = Boolean(req.body?.pay);
    const tx = await call(arbiter, "resolve", { job_id: String(req.body?.jobId ?? ""), milestone: 0, pay }, { gas: "150000000000000" });
    emit({ type: "resolved", jobId: req.body?.jobId, milestone: 0, pay, tx: tx.url });
    res.json({ tx: tx.url });
  } catch (e) { res.status(500).json({ error: e.message, tx: e.url }); }
});

let attacking = false;
app.post("/api/demo/attack", async (req, res) => {
  if (attacking) return res.status(409).json({ error: "Attack already running" });
  attacking = true;
  res.json({ started: true });
  try {
    // The quorum/collusion attacks need a job with an open milestone: make one if the vault has none,
    // so a judge on a fresh demo always sees every attack.
    const jobs = (await view("get_jobs", {})) || [];
    const hasOpen = jobs.some((j) => j.milestones.some((m) => m.status === "Open" || m.status === "Rejected"));
    if (!hasOpen && client) {
      emit({ type: "log", line: "Attack lab: creating a fresh escrow job so the quorum attacks have money to aim at…" });
      await createDemoJob(false);
    }
    await runAttack((ev) => emit(ev), { freelancer, trapUrl: `${SITES_URL}/trap.html` });
  } catch (e) { emit({ type: "attack_done", held: null, error: e.message }); } finally { attacking = false; }
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
  console.log(`Milestone Vault on ${PUBLIC_URL} · vault ${VAULT} (${NETWORK}) · auditors ${auditors.filter((a) => a.enabled).map((a) => a.accountId).join(", ") || "off"} · note: ${llmEnabled() ? "NEAR AI " + modelName() : "rules"}`);
  auditors.forEach((a, i) => a.enabled && setTimeout(() => a.start(5000), i * 1500));
  if (llmEnabled()) pickModel().then((m) => console.log(`NEAR AI Cloud model: ${m}`)).catch((e) => console.warn(`NEAR AI Cloud model check failed: ${e.message}`));
});

export { txUrl };

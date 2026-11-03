// Milestone Vault UI: talks to the local API and follows the auditor over Server-Sent Events.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const short = (id) => (id && id.length > 26 ? id.slice(0, 12) + "…" + id.slice(-10) : id || "");
let info = null, jobId = null, criteria = null, lastBal = {};

const CRIT_ROWS = [
  ["Overall score", "min_overall", (v) => v.overall, "≥"],
  ["Accessibility", "min_accessibility", (v) => v.scores.Accessibility, "≥"],
  ["Mobile", "min_mobile", (v) => v.scores.Mobile, "≥"],
  ["SEO", "min_seo", (v) => v.scores.SEO, "≥"],
];

fetch("/api/info").then((r) => r.json()).then((j) => {
  info = j;
  $("#net").textContent = j.network;
  $("#vaultLink").textContent = j.vault + " ↗"; $("#vaultLink").href = j.vaultUrl;
  $("#clientId").textContent = short(j.client); $("#devId").textContent = short(j.freelancer); $("#auditorId").textContent = short(j.auditor);
  if (!j.demo) { $("#lock").disabled = true; $("#lock").textContent = "Demo accounts not configured"; }
  $("#versions").innerHTML = Object.entries(j.versions).map(([k, v]) => `<div class="v"><button type="button" data-v="${k}" disabled>${esc(k === "v1" ? "Draft" : k === "trap" ? "Polished" : "Final")}<small>${esc(v.label)}</small></button><a href="${esc(v.url)}" target="_blank" rel="noopener" aria-label="Open ${esc(v.label)}">↗</a></div>`).join("");
  document.querySelectorAll("#versions button").forEach((b) => b.addEventListener("click", () => submit(b.dataset.v)));
  restore();
});

async function restore() {
  const jobs = await fetch("/api/jobs").then((r) => r.json()).catch(() => []);
  const open = [...(jobs || [])].reverse().find((j) => j.milestones.some((m) => !["Released", "Refunded"].includes(m.status)));
  if (open) setJob(open);
}

function setJob(job) {
  jobId = job.id; criteria = job.criteria;
  const m = job.milestones[0];
  $("#locked").textContent = ["Released", "Refunded"].includes(m.status) ? 0 : (Number(BigInt(m.amount) / 10n ** 21n) / 1000);
  status(m.status);
  $("#criteria").innerHTML = [
    ["Overall", `≥ ${criteria.min_overall}`], ["Accessibility", `≥ ${criteria.min_accessibility}`], ["Mobile", `≥ ${criteria.min_mobile}`],
    ["SEO", `≥ ${criteria.min_seo}`], ["Broken links", `≤ ${criteria.max_broken_links}`], ["Hostile scripts / AI traps", criteria.forbid_malicious_scripts ? "none" : "allowed"],
  ].map(([k, v]) => `<li><span>${k}</span><b>${v}</b></li>`).join("");
  $("#lock").disabled = true; $("#lock").textContent = `Job #${jobId} funded`;
  document.querySelectorAll("#versions button").forEach((b) => (b.disabled = !["Open", "Rejected"].includes(m.status)));
}

function status(s) {
  const p = $("#status");
  const map = { Open: ["Funded · waiting for work", "wait"], Submitted: ["Auditing…", "wait"], Rejected: ["Not paid · needs fixes", "bad"], Paying: ["Paying…", "ok"], Released: ["Paid to freelancer", "ok"], Refunded: ["Refunded", "bad"] };
  const [t, c] = map[s] || [s, ""];
  p.textContent = t; p.className = "pill " + c;
}

function chain(text, url, cls = "info") {
  const ol = $("#chain"); ol.querySelector(".empty")?.remove();
  const li = document.createElement("li"); li.className = cls;
  li.innerHTML = `<span>${esc(text)}</span>${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">tx ↗</a>` : ""}`;
  ol.prepend(li);
}

function line(text, cls = "") {
  const c = $("#console"); if (c.firstChild?.textContent === "Waiting for a submission…") c.innerHTML = "";
  const d = document.createElement("div"); d.className = cls; d.textContent = text; c.appendChild(d); c.scrollTop = c.scrollHeight;
}

async function balances() {
  const b = await fetch("/api/balances").then((r) => r.json()).catch(() => ({}));
  for (const [k, el] of [["client", "#clientBal"], ["freelancer", "#devBal"]]) {
    if (b[k] == null) continue;
    $(el).textContent = b[k].toFixed(2);
    if (lastBal[k] != null && b[k] > lastBal[k] + 0.5) { $(el).parentElement.classList.remove("up"); void $(el).offsetWidth; $(el).parentElement.classList.add("up"); }
    lastBal[k] = b[k];
  }
}
balances(); setInterval(balances, 5000);

$("#lock").addEventListener("click", async () => {
  $("#lock").disabled = true; $("#lock").textContent = "Signing on NEAR…";
  const r = await fetch("/api/demo/job", { method: "POST" }).then((r) => r.json());
  if (r.error) { $("#lock").disabled = false; $("#lock").textContent = "Lock 2 NEAR for the website"; return line("✖ " + r.error, "blk"); }
  const job = await fetch(`/api/jobs/${r.jobId}`).then((r) => r.json());
  setJob(job); balances();
});

async function submit(v) {
  document.querySelectorAll("#versions button").forEach((b) => (b.disabled = true));
  $("#verdict").hidden = true; $("#phone").hidden = true;
  const r = await fetch("/api/demo/submit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobId, version: v }) }).then((r) => r.json());
  if (r.error) { line("✖ " + r.error, "blk"); document.querySelectorAll("#versions button").forEach((b) => (b.disabled = false)); }
}

// ------------------------------------------------------------- live events
const es = new EventSource("/api/events");
es.onmessage = (m) => handle(JSON.parse(m.data));
let threats = [];

function handle(e) {
  const t = new Date(e.t).toLocaleTimeString([], { hour12: false });
  switch (e.type) {
    case "job_created": chain(`Client locked ${e.amount} NEAR (job #${e.jobId})`, e.tx); line(`${t}  Job #${e.jobId} funded on chain`, "ok"); break;
    case "submitted": chain(`Freelancer submitted: ${e.label}`, e.tx); status("Submitted"); line(`${t}  Freelancer submitted "${e.label}"`); threats = []; spin(); break;
    case "log": line(`${t}  ${e.line}`, /^✔/.test(e.line) ? "ok" : /^✖|error/i.test(e.line) ? "blk" : /^⚠/.test(e.line) ? "inj" : /Sandbox .* (started|destroyed)|On chain|Signing/.test(e.line) ? "" : "dim"); break;
    case "blocked": line(`${t}  ⛔ BLOCKED ${e.rule}: ${e.method} ${e.url}`, "blk"); threats.push({ kind: "net", rule: e.rule, text: `${e.method} ${e.url}` }); break;
    case "injection": line(`${t}  ⚠ Hidden instruction (ignored): "${e.text}"`, "inj"); threats.push({ kind: "inj", text: e.text }); break;
    case "shot": if (e.device === "mobile") { $("#shot").src = e.src; $("#phone").hidden = false; } break;
    case "verdict": verdict(e); break;
    case "reported":
      chain(e.passed ? "Auditor: passed → paid to freelancer" : "Auditor: not passed → sent back for fixes", e.tx, e.passed ? "good" : "bad");
      door(e.passed);
      setTimeout(async () => { const job = await fetch(`/api/jobs/${e.jobId}`).then((r) => r.json()); setJob(job); balances(); }, 2500);
      break;
    case "audit_error": line(`${t}  ✖ ${e.message}`, "blk"); break;
    case "attack_try": attempt(e.title); break;
    case "attack_result": attemptDone(e); break;
    case "attack_done": $("#attack").disabled = false; $("#held").hidden = false; $("#held").textContent = e.held ? `All ${e.total} attacks failed. The escrowed funds did not move.` : e.error || "Some attempts could not run (network). Try again."; break;
  }
}

function spin() { const d = $("#door"); d.className = "door"; void d.offsetWidth; d.classList.add("spin"); }
function door(ok) { const d = $("#door"); d.classList.add(ok ? "open" : "shut"); }

function verdict(v) {
  $("#verdict").hidden = false;
  $("#vTitle").textContent = v.passed ? "✔ Passed: payment released" : "✖ Not passed: no payment";
  $("#vTitle").className = "v-title " + (v.passed ? "ok" : "bad");
  const rows = CRIT_ROWS.map(([name, key, get]) => { const need = criteria?.[key]; const got = get(v); const ok = got >= need; return `<tr><td>${name}</td><td>≥ ${need}</td><td>${got}</td><td class="${ok ? "y" : "n"}">${ok ? "✓ pass" : "✗ fail"}</td></tr>`; });
  const broken = (v.fails.find((f) => /broken link/.test(f)) || "").match(/^(\d+)/)?.[1] || 0;
  rows.push(`<tr><td>Broken links</td><td>≤ ${criteria?.max_broken_links ?? 0}</td><td>${broken}</td><td class="${+broken <= (criteria?.max_broken_links ?? 0) ? "y" : "n"}">${+broken <= (criteria?.max_broken_links ?? 0) ? "✓ pass" : "✗ fail"}</td></tr>`);
  const hostile = threats.length;
  rows.push(`<tr><td>Hostile scripts / AI traps</td><td>none</td><td>${hostile}</td><td class="${hostile ? "n" : "y"}">${hostile ? "✗ fail" : "✓ pass"}</td></tr>`);
  $("#checks").innerHTML = rows.join("");
  const nets = [...new Map(threats.filter((x) => x.kind === "net").map((x) => [x.rule + x.text.split("?")[0], x])).values()];
  const injs = threats.filter((x) => x.kind === "inj");
  $("#threats").innerHTML = [
    ...nets.map((x) => `<div class="threat net"><b>⛔ Blocked in sandbox · ${esc(x.rule)}</b>${esc(x.text)}</div>`),
    ...injs.map((x) => `<div class="threat inj"><b>⚠ Prompt injection found · ignored</b><q>${esc(x.text)}</q></div>`),
  ].join("");
  $("#summary").textContent = v.summary + (v.summaryBy === "near-ai" ? "  — note by NEAR AI" : "");
  $("#evidence").href = v.evidence; $("#hash").textContent = v.hash.slice(0, 16) + "…";
}

$("#attack").addEventListener("click", async () => {
  $("#attack").disabled = true; $("#attempts").innerHTML = ""; $("#held").hidden = true;
  const r = await fetch("/api/demo/attack", { method: "POST" }).then((r) => r.json());
  if (r.error) { $("#attack").disabled = false; $("#held").hidden = false; $("#held").textContent = r.error; }
});
function attempt(title) {
  const li = document.createElement("li"); li.innerHTML = `<span class="st">trying…</span><span>${esc(title)}</span>`; $("#attempts").appendChild(li);
}
function attemptDone(e) {
  const li = [...$("#attempts").children].find((l) => l.textContent.includes(e.title) && l.querySelector(".st").textContent === "trying…");
  if (!li) return;
  li.className = e.blocked ? "blocked" : "";
  li.innerHTML = `<span class="st">${e.blocked === true ? "⛔ BLOCKED" : e.blocked === null ? "⚠ ERROR" : "!! SUCCEEDED"}</span><span>${esc(e.title)}<small>${esc(e.reason)}${e.tx ? ` · <a href="${esc(e.tx)}" target="_blank" rel="noopener">tx ↗</a>` : ""}</small></span>`;
}

// Milestone Vault UI: talks to the local API and follows the two auditors over Server-Sent Events.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const short = (id) => (id && id.length > 26 ? id.slice(0, 12) + "…" + id.slice(-10) : id || "");
let info = null, jobId = null, job = null, criteria = null, lastBal = {}, windowTimer = null;

const CRIT_ROWS = [
  ["Overall score", "min_overall", (v) => v.overall],
  ["Accessibility", "min_accessibility", (v) => v.scores.Accessibility],
  ["Mobile", "min_mobile", (v) => v.scores.Mobile],
  ["SEO", "min_seo", (v) => v.scores.SEO],
];
const isUsdc = (j) => Boolean(j?.token);
const fmt = (j, x) => isUsdc(j) ? (Number(BigInt(x)) / 1e6).toFixed(2) : (Number(BigInt(x) / 10n ** 21n) / 1000).toString();
const cur = (j) => (isUsdc(j) ? "tUSDC" : "NEAR");

fetch("/api/info").then((r) => r.json()).then((j) => {
  info = j;
  $("#net").textContent = j.network;
  $("#vaultLink").textContent = j.vault + " ↗"; $("#vaultLink").href = j.vaultUrl;
  $("#clientId").textContent = short(j.client); $("#devId").textContent = short(j.freelancer);
  $("#auditorId").innerHTML = j.auditors.map((a) => `<a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.id)}: ${esc(short(a.account))}</a>`).join(" · ");
  if (!j.demo) { for (const b of ["#lock", "#lockUsdc"]) $(b).disabled = true; $("#lock").textContent = "Demo accounts not configured"; }
  if (!j.token) $("#lockUsdc").hidden = true;
  $("#versions").innerHTML = Object.entries(j.versions).map(([k, v]) => `<div class="v"><button type="button" data-v="${k}" disabled>${esc(k === "v1" ? "Draft" : k === "trap" ? "Polished" : "Final")}<small>${esc(v.label)}</small></button><a href="${esc(here(v.url))}" target="_blank" rel="noopener" aria-label="Open ${esc(v.label)}">↗</a></div>`).join("");
  document.querySelectorAll("#versions button").forEach((b) => b.addEventListener("click", () => submit(b.dataset.v)));
  restore();
});

async function restore() {
  const jobs = await fetch("/api/jobs").then((r) => r.json()).catch(() => []);
  const open = [...(jobs || [])].reverse().find((j) => j.milestones.some((m) => !["Released", "Refunded"].includes(m.status)));
  if (open) setJob(open);
}
const refresh = async (id = jobId) => { if (id == null) return; setJob(await fetch(`/api/jobs/${id}`).then((r) => r.json())); balances(); };

function setJob(j) {
  job = j; jobId = j.id; criteria = j.criteria;
  const m = j.milestones[0];
  $("#locked").textContent = ["Released", "Refunded"].includes(m.status) ? 0 : fmt(j, m.amount);
  $("#lockedCur").textContent = `${cur(j)} locked`;
  status(m.status, m);
  $("#criteria").innerHTML = [
    ["Overall", `≥ ${criteria.min_overall}`], ["Accessibility", `≥ ${criteria.min_accessibility}`], ["Mobile", `≥ ${criteria.min_mobile}`],
    ["SEO", `≥ ${criteria.min_seo}`], ["Broken links", `≤ ${criteria.max_broken_links}`], ["Hostile scripts / AI traps", criteria.forbid_malicious_scripts ? "none" : "allowed"],
    ["Challenge window", `${j.challenge_secs}s`], ["Audit fee", `${fmt(j, j.audit_fee)} ${cur(j)} / audit`],
  ].map(([k, v]) => `<li><span>${k}</span><b>${v}</b></li>`).join("");
  for (const b of ["#lock", "#lockUsdc"]) $(b).disabled = false; // a new job can be opened any time
  document.querySelectorAll("#versions button").forEach((b) => (b.disabled = !["Open", "Rejected"].includes(m.status)));
  const pass = m.votes.filter((v) => v.passed).length;
  $("#votes").hidden = !m.votes.length;
  $("#votes").innerHTML = m.votes.map((v) => `<span class="${v.passed ? "y" : "n"}">${esc(info?.auditors.find((a) => a.account === v.auditor)?.id || short(v.auditor))}: ${v.passed ? "✔" : "✖"} ${v.overall}</span>`).join(" ") + ` <b>${pass}/${info?.config?.quorum ?? 2} pass</b>`;
  $("#csv").hidden = false; $("#csv").href = `/api/jobs/${jobId}/statement.csv`;
  $("#dispute").hidden = m.status !== "Approved";
  clearInterval(windowTimer);
  if (m.status === "Approved") {
    const tick = () => {
      const left = Math.max(0, Math.ceil((Number(BigInt(m.release_at) / 1_000_000n) - Date.now()) / 1000));
      $("#window").hidden = false; $("#window").textContent = left ? `Challenge window: ${left}s left for the client to dispute` : "Window closed · releasing…";
      if (!left) { clearInterval(windowTimer); $("#dispute").hidden = true; setTimeout(() => refresh(), 6000); }
    };
    tick(); windowTimer = setInterval(tick, 1000);
  } else $("#window").hidden = true;
}

function status(s) {
  const p = $("#status");
  const map = { Open: ["Funded · waiting for work", "wait"], Submitted: ["Auditing…", "wait"], Rejected: ["Not paid · needs fixes", "bad"], Approved: ["Approved · challenge window", "ok"], Disputed: ["Disputed · arbiter decides", "bad"], Paying: ["Paying…", "ok"], Released: ["Paid to freelancer", "ok"], Refunded: ["Refunded", "bad"] };
  const [t, c] = map[s] || [s, ""];
  p.textContent = t; p.className = "pill " + c;
}

function chain(text, url, cls = "info") {
  const ol = $("#chain"); ol.querySelector(".empty")?.remove();
  const li = document.createElement("li"); li.className = cls;
  li.innerHTML = `<span>${esc(text)}</span>${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">tx ↗</a>` : ""}`;
  ol.prepend(li);
}

function line(text, cls = "", who = "") {
  const c = $("#console"); if (c.firstChild?.textContent === "Waiting for a submission…") c.innerHTML = "";
  const d = document.createElement("div"); d.className = cls + (who ? " a" + who : ""); d.textContent = (who ? `[${who}] ` : "") + text; c.appendChild(d); c.scrollTop = c.scrollHeight;
}

async function balances() {
  const b = await fetch("/api/balances").then((r) => r.json()).catch(() => ({}));
  for (const [k, el, u] of [["client", "#clientBal", "#clientUsdc"], ["freelancer", "#devBal", "#devUsdc"]]) {
    if (!b[k]) continue;
    if (b[k].near != null) $(el).textContent = b[k].near.toFixed(2);
    if (b[k].usdc != null) $(u).textContent = b[k].usdc.toFixed(2);
    const total = (b[k].near || 0) + (b[k].usdc || 0) / 100;
    if (lastBal[k] != null && total > lastBal[k] + 0.3) { $(el).parentElement.classList.remove("up"); void $(el).offsetWidth; $(el).parentElement.classList.add("up"); }
    lastBal[k] = total;
  }
}
balances(); setInterval(balances, 5000);

for (const sel of ["#lock", "#lockUsdc"]) $(sel).addEventListener("click", async (ev) => {
  const btn = ev.currentTarget, label = btn.textContent;
  for (const b of ["#lock", "#lockUsdc"]) $(b).disabled = true; btn.textContent = "Signing on NEAR…";
  $("#chain").innerHTML = '<li class="empty">Transactions appear here.</li>'; $("#verdict").hidden = true; $("#phone").hidden = true;
  const r = await fetch("/api/demo/job", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ currency: btn.dataset.cur }) }).then((r) => r.json());
  btn.textContent = label;
  if (r.error) { for (const b of ["#lock", "#lockUsdc"]) $(b).disabled = false; return line("✖ " + r.error, "blk"); }
  refresh(r.jobId);
});

$("#dispute").addEventListener("click", async () => {
  $("#dispute").disabled = true;
  const r = await fetch("/api/demo/dispute", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobId }) }).then((r) => r.json());
  $("#dispute").disabled = false;
  if (r.error) line("✖ " + r.error, "blk"); else refresh();
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
let threats = {};

function handle(e) {
  const t = new Date(e.t).toLocaleTimeString([], { hour12: false });
  const who = e.auditor || "";
  switch (e.type) {
    case "job_created": chain(`Client locked ${e.amount} (job #${e.jobId})`, e.tx); line(`${t}  Job #${e.jobId} funded on chain`, "ok"); break;
    case "submitted": chain(`Freelancer submitted "${e.label}" · gas paid by relayer`, e.tx); status("Submitted"); line(`${t}  Freelancer submitted "${e.label}" (meta transaction, relayer paid the gas)`); threats = {}; spin(); refresh(); break;
    case "log": line(`${t}  ${e.line.replace(/^Auditor [AB] /, "")}`, /✔/.test(e.line) ? "ok" : /✖|error/i.test(e.line) ? "blk" : /⚠/.test(e.line) ? "inj" : /🔏/.test(e.line) ? "ok" : /Sandbox .* (started|destroyed)|On chain|signs/.test(e.line) ? "" : "dim", who); break;
    case "blocked":
      if (e.benign) { line(`${t}  ◌ contained (privacy, not an attack): ${e.url}`, "dim", who); break; }
      line(`${t}  ⛔ BLOCKED ${e.rule}: ${e.method} ${e.url}`, "blk", who); (threats[who] ||= []).push({ kind: "net", rule: e.rule, text: `${e.method} ${e.url}` }); break;
    case "injection": line(`${t}  ⚠ Hidden instruction (ignored): "${e.text}"`, "inj", who); (threats[who] ||= []).push({ kind: "inj", text: e.text }); break;
    case "shot": if (e.device === "mobile") { $("#shot").src = e.src; $("#phone").hidden = false; } break;
    case "verdict": verdict(e); break;
    case "reported":
      chain(`Auditor ${who}: ${e.passed ? "pass" : "fail"} → ${e.status}`, e.tx, e.passed ? "good" : "bad");
      if (["Approved", "Paying", "Released"].includes(e.status)) door(true); else if (e.status === "Rejected") door(false);
      setTimeout(() => refresh(e.jobId), 2000);
      break;
    case "released": chain("Challenge window over → paid to freelancer", e.tx, "good"); setTimeout(() => refresh(e.jobId), 2500); break;
    case "disputed": chain("Client disputed the payout → arbiter decides", e.tx, "bad"); refresh(e.jobId); break;
    case "resolved": chain(`Arbiter: ${e.pay ? "pay" : "send back for fixes"}`, e.tx, e.pay ? "good" : "bad"); refresh(e.jobId); break;
    case "audit_error": line(`${t}  ✖ ${e.message}`, "blk", who); break;
    case "attack_try": attempt(e.title); break;
    case "attack_result": attemptDone(e); break;
    case "attack_done": $("#attack").disabled = false; $("#held").hidden = false; $("#held").textContent = e.held ? `All ${e.total} attacks failed. The escrowed funds did not move.` : e.error || "Some attempts could not run (network). Try again."; break;
  }
}

function spin() { const d = $("#door"); d.className = "door"; void d.offsetWidth; d.classList.add("spin"); }
function door(ok) { const d = $("#door"); d.classList.add(ok ? "open" : "shut"); }

// Links to the demo server's own files follow the address the page was opened on (HTTPS via Vercel or the VM).
function here(u) { try { const x = new URL(u, location.href); return x.pathname.startsWith("/evidence/") || x.pathname.startsWith("/attestations/") || x.pathname.startsWith("/sites/") ? x.pathname + x.search : u; } catch { return u; } }

function verdict(v) {
  $("#verdict").hidden = false;
  $("#vTitle").textContent = `Auditor ${v.auditor}: ` + (v.passed ? "✔ passed (needs the other auditor too)" : "✖ not passed");
  $("#vTitle").className = "v-title " + (v.passed ? "ok" : "bad");
  const rows = CRIT_ROWS.map(([name, key, get]) => { const need = criteria?.[key]; const got = get(v); const ok = got >= need; return `<tr><td>${name}</td><td>≥ ${need}</td><td>${got}</td><td class="${ok ? "y" : "n"}">${ok ? "✓ pass" : "✗ fail"}</td></tr>`; });
  const broken = (v.fails.find((f) => /broken link/.test(f)) || "").match(/^(\d+)/)?.[1] || 0;
  rows.push(`<tr><td>Broken links</td><td>≤ ${criteria?.max_broken_links ?? 0}</td><td>${broken}</td><td class="${+broken <= (criteria?.max_broken_links ?? 0) ? "y" : "n"}">${+broken <= (criteria?.max_broken_links ?? 0) ? "✓ pass" : "✗ fail"}</td></tr>`);
  const mine = threats[v.auditor] || [];
  rows.push(`<tr><td>Hostile scripts / AI traps</td><td>none</td><td>${mine.length}</td><td class="${mine.length ? "n" : "y"}">${mine.length ? "✗ fail" : "✓ pass"}</td></tr>`);
  $("#checks").innerHTML = rows.join("");
  const nets = [...new Map(mine.filter((x) => x.kind === "net").map((x) => [x.rule + x.text.split("?")[0], x])).values()];
  const injs = mine.filter((x) => x.kind === "inj");
  $("#threats").innerHTML = [
    ...nets.map((x) => `<div class="threat net"><b>⛔ Blocked in sandbox · ${esc(x.rule)}</b>${esc(x.text)}</div>`),
    ...injs.map((x) => `<div class="threat inj"><b>⚠ Prompt injection found · ignored</b><q>${esc(x.text)}</q></div>`),
  ].join("");
  $("#summary").textContent = v.summary + (String(v.summaryBy).startsWith("near-ai") ? "  — note by NEAR AI Cloud" : "");
  $("#evidence").href = here(v.evidence); $("#hash").textContent = v.hash.slice(0, 16) + "…";
  $("#proof").innerHTML = v.attestation ? ` · <a href="${esc(here(v.attestation))}" target="_blank" rel="noopener">${v.aiVerified ? "🔏 TEE-signed note (verified)" : "AI proof (unverified)"}</a>` : "";
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

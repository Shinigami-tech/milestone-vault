// End-to-end check against a running server (npm start): every scenario a judge would click, on testnet.
//   node scripts/e2e.mjs [http://localhost:8090]
// Exits 0 only if: draft rejected, final paid after the challenge window (NEAR and tUSDC),
// a dispute stops a payout, and all attacks are blocked.
const BASE = process.argv[2] || "http://localhost:8090";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (p, b = {}) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());
const get = (p) => fetch(BASE + p).then((r) => r.json());
const status = async (id) => (await get(`/api/jobs/${id}`)).milestones[0].status;
async function until(id, want, secs = 150) {
  for (let i = 0; i < secs / 3; i++) { const s = await status(id); if (want.includes(s)) return s; await sleep(3000); }
  return await status(id);
}
const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "✔" : "✖"} ${name}${extra ? " — " + extra : ""}`); };

const info = await get("/api/info");
console.log(`Vault ${info.vault} · auditors ${info.auditors.map((a) => a.account).join(", ")} · quorum ${info.config?.quorum} · window ${info.challengeSecs}s`);

// 1. NEAR job: draft fails, final passes, paid after the window, gas paid by the relayer
const j1 = (await post("/api/demo/job")).jobId; // may run the demo recycler first, so measure after it
const b0 = await get("/api/balances");
await post("/api/demo/submit", { jobId: j1, version: "v1" });
check("Draft is rejected by the auditors", (await until(j1, ["Rejected"])) === "Rejected");
await post("/api/demo/submit", { jobId: j1, version: "v2" });
check("Final version is approved by 2 of 2 auditors", ["Approved", "Paying", "Released"].includes(await until(j1, ["Approved", "Released"])));
check("Paid to the freelancer after the challenge window", (await until(j1, ["Released"], info.challengeSecs + 90)) === "Released");
const b1 = await get("/api/balances");
const want = info.demoNear;
check(`Freelancer received ${want} NEAR and paid no gas`, Math.abs(b1.freelancer.near - b0.freelancer.near - want) < 0.0005, `${b0.freelancer.near} → ${b1.freelancer.near}`);
const job1 = await get(`/api/jobs/${j1}`);
check("Each audit paid its auditor a fee from the client's budget", BigInt(job1.fees_paid) === BigInt(job1.audit_fee) * BigInt(job1.reports.length) && job1.reports.length >= 3, `${job1.reports.length} reports, ${Number(BigInt(job1.fees_paid)) / 1e24} NEAR in fees`);

// 2. tUSDC job
const j2 = (await post("/api/demo/job", { currency: "usdc" })).jobId;
await post("/api/demo/submit", { jobId: j2, version: "v2" });
check("tUSDC milestone paid after the window", (await until(j2, ["Released"], info.challengeSecs + 120)) === "Released");
const b2 = await get("/api/balances");
check("Freelancer received 50 tUSDC", Math.abs(b2.freelancer.usdc - b1.freelancer.usdc - 50) < 1e-6, `${b1.freelancer.usdc} → ${b2.freelancer.usdc}`);

// 3. Dispute stops a payout
const j3 = (await post("/api/demo/job")).jobId;
await post("/api/demo/submit", { jobId: j3, version: "v2" });
await until(j3, ["Approved"]);
await post("/api/demo/dispute", { jobId: j3 });
await sleep(info.challengeSecs * 1000 + 15000);
check("A disputed milestone is not paid when the window ends", (await status(j3)) === "Disputed");
await post("/api/demo/resolve", { jobId: j3, pay: false });
check("The arbiter can send it back for fixes", (await until(j3, ["Rejected"], 30)) === "Rejected");

// 4. Attacks (uses job 3, which is open for resubmission again)
const es = await fetch(`${BASE}/api/events?since=${Date.now()}`);
await post("/api/demo/attack");
const reader = es.body.getReader(); let buf = "", done = null; const t0 = Date.now();
while (!done && Date.now() - t0 < 180000) {
  const { value } = await reader.read(); buf += new TextDecoder().decode(value);
  for (const line of buf.split("\n")) if (line.startsWith("data: ")) { const e = JSON.parse(line.slice(6)); if (e.type === "attack_done") done = e; }
}
reader.cancel();
check(`All attacks with the hijacked auditor's real key are blocked`, done?.held === true, `${done?.total} attempts`);
check("The honest auditor rejects the trap site the hijacked one voted for", (await until(j3, ["Rejected"], 90)) === "Rejected");

const ok = results.every(Boolean);
console.log(`\n${ok ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED"} (${results.filter(Boolean).length}/${results.length})`);
process.exit(ok ? 0 : 1);

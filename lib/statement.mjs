// Accountant-friendly CSV of a job: one row per money event and audit, with links to the proof.
const esc = (v) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const iso = (ns) => (ns && Number(ns) > 0 ? new Date(Number(BigInt(ns) / 1_000_000n)).toISOString() : "");

export function statementCsv(job, { explorer, vault, publicUrl }) {
  const cur = job.token ? "tUSDC" : "NEAR";
  const dec = job.token ? 1e6 : 1e24;
  const amt = (x) => (Number(BigInt(x)) / dec).toFixed(job.token ? 2 : 4);
  const rows = [["Date (UTC)", "Job", "Milestone", "Event", "Amount", "Currency", "Counterparty", "Auditor", "Score", "Evidence (sha256)", "Evidence URL", "AI proof (sha256)", "Contract"]];
  rows.push([iso(job.created_at), job.title, "", "Funds locked", amt(BigInt(job.milestones.reduce((s, m) => s + BigInt(m.amount), 0n)) + BigInt(job.audit_budget) + BigInt(job.fees_paid)), cur, job.client, "", "", "", "", "", `${explorer}/address/${vault}`]);
  for (const r of job.reports) {
    const m = job.milestones[r.milestone];
    rows.push([iso(r.at), job.title, m?.title, r.passed ? "Audit passed" : "Audit failed", job.audit_fee !== "0" ? amt(job.audit_fee) : "", job.audit_fee !== "0" ? cur : "", "", r.auditor, r.overall, r.evidence_hash, `${publicUrl}/evidence/${r.evidence_hash}.json`, r.attestation_hash || "", ""]);
  }
  job.milestones.forEach((m) => {
    if (["Released", "Paying"].includes(m.status)) rows.push(["", job.title, m.title, "Paid to freelancer", amt(m.amount), cur, job.freelancer, "", "", "", "", "", ""]);
    if (m.status === "Refunded") rows.push(["", job.title, m.title, "Refunded to client", amt(m.amount), cur, job.client, "", "", "", "", "", ""]);
    if (["Approved", "Disputed", "Open", "Submitted", "Rejected"].includes(m.status)) rows.push(["", job.title, m.title, `Status: ${m.status}`, amt(m.amount), cur, "", "", "", "", "", "", ""]);
  });
  rows.push(["", job.title, "", "Audit fees paid (total)", amt(job.fees_paid), cur, "auditors", "", "", "", "", "", ""]);
  return rows.map((r) => r.map(esc).join(",")).join("\n") + "\n";
}

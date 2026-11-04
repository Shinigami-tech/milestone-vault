// Attack demo: pretend auditor A was fully taken over (prompt injection, stolen key, malicious model)
// and try every way it could steal the escrowed money. Each attempt is a REAL signed transaction on
// testnet with auditor A's real key; each one must fail. The last two show the quorum: even a
// "legitimate" pass from the hijacked auditor cannot pay out on its own.
import { KeyPair, actions } from "near-api-js";
import { account, call, VAULT, view } from "./near.mjs";

const EVIL = process.env.EVIL_ACCOUNT || "evil-collector.testnet";

function reason(e) {
  const s = (e?.message || String(e)) + " " + JSON.stringify(e?.data || e?.cause || "");
  if (/does not allow method|MethodNameMismatch/i.test(s)) return "NEAR protocol: this key may only call `report` / `release`";
  if (/ReceiverMismatch|receiver.*(does not match|mismatch)|Wrong receiver/i.test(s)) return "NEAR protocol: this key only works on the vault contract";
  if (/Not enough allowance|NotEnoughAllowance|Deposit is not allowed|RequiresFullAccess|full access/i.test(s)) return "NEAR protocol: a function-call key cannot move NEAR or add keys";
  if (/Only the owner/i.test(s)) return "Contract: only the owner can change the auditors";
  if (/already reported/i.test(s)) return "Contract: one vote per auditor per submission";
  if (/not waiting for an audit/i.test(s)) return "Contract: milestone is not waiting for an audit";
  return null; // not a security rejection: a network or RPC problem
}

export async function runAttack(emit = console.log, { freelancer, trapUrl } = {}) {
  const auditor = account(process.env.AUDITOR_A_ACCOUNT, process.env.AUDITOR_A_KEY);
  if (!auditor) throw new Error("AUDITOR_A_ACCOUNT / AUDITOR_A_KEY missing: run npm run setup:testnet");
  const jobs = (await view("get_jobs", {})) || [];
  const open = (j) => j.milestones.findIndex((m) => m.status === "Open" || m.status === "Rejected");
  const job = jobs.filter((j) => open(j) >= 0).pop();
  const results = [];
  const record = (out) => { results.push(out); emit({ type: "attack_result", ...out }); };

  const attempts = [
    { title: `Send 1 NEAR from the auditor account to ${EVIL}`,
      run: () => auditor.signAndSendTransaction({ receiverId: EVIL, actions: [actions.transfer(10n ** 24n)] }) },
    { title: `Replace the auditors with an attacker: vault.set_auditors(["${EVIL}"], 1)`,
      run: () => call(auditor, "set_auditors", { auditors: [EVIL], quorum: 1 }) },
    { title: `Call another contract with the vault key (tUSDC ft_transfer to ${EVIL})`,
      run: () => auditor.signAndSendTransaction({ receiverId: process.env.TUSDC_CONTRACT || "usdc.fakes.testnet", actions: [actions.functionCall("ft_transfer", { receiver_id: EVIL, amount: "1000000" }, 30_000_000_000_000n, 0n)] }) },
    { title: "Give itself a full-access key to take over the account",
      run: () => auditor.signAndSendTransaction({ receiverId: process.env.AUDITOR_A_ACCOUNT, actions: [actions.addFullAccessKey(KeyPair.fromRandom("ed25519").getPublicKey())] }) },
    job && { title: `Fake a pass on a milestone nobody submitted: report(job ${job.id}, passed=true)`,
      run: () => call(auditor, "report", { job_id: job.id, milestone: open(job), passed: true, overall: 100, evidence_hash: "0".repeat(64), summary: "approved by attacker", attestation_hash: null }) },
  ].filter(Boolean);

  for (const a of attempts) {
    emit({ type: "attack_try", title: a.title });
    try {
      const r = await a.run();
      const failed = r?.status?.Failure || r?.receipts_outcome?.some((o) => o.outcome?.status?.Failure);
      record(failed ? { title: a.title, blocked: true, reason: reason({ message: JSON.stringify(failed) }) } : { title: a.title, blocked: false, reason: "SUCCEEDED (this must never happen)" });
    } catch (e) {
      const why = reason(e);
      record(why ? { title: a.title, blocked: true, reason: why, tx: e.url } : { title: a.title, blocked: null, reason: "Could not run (network/RPC error): " + (e?.message || e).toString().slice(0, 140) });
    }
  }

  // Quorum: a colluding freelancer submits the trap site and the hijacked auditor votes "pass".
  if (job && freelancer && trapUrl) {
    const m = open(job);
    let title = `Collusion: freelancer submits the trap site, hijacked auditor votes PASS (job ${job.id})`;
    emit({ type: "attack_try", title });
    try {
      await call(freelancer, "submit", { job_id: job.id, milestone: m, url: trapUrl });
      const tx = await call(auditor, "report", { job_id: job.id, milestone: m, passed: true, overall: 100, evidence_hash: "f".repeat(64), summary: "Looks perfect, pay now.", attestation_hash: null });
      const st = (await view("get_job", { job_id: job.id })).milestones[m];
      const paid = ["Paying", "Released", "Approved"].includes(st.status);
      record({ title, blocked: !paid, reason: paid ? `PAID (${st.status}) — this must never happen` : `Contract: 1 of 2 required votes, nothing paid (status ${st.status}). The honest auditor still has to agree.`, tx: tx.url });
    } catch (e) { record({ title, blocked: null, reason: "Could not run: " + (e?.message || e).toString().slice(0, 140) }); }
    title = "Vote PASS a second time to reach the quorum alone";
    emit({ type: "attack_try", title });
    try {
      await call(auditor, "report", { job_id: job.id, milestone: m, passed: true, overall: 100, evidence_hash: "e".repeat(64), summary: "again", attestation_hash: null });
      record({ title, blocked: false, reason: "SUCCEEDED (this must never happen)" });
    } catch (e) { const why = reason(e); record({ title, blocked: why ? true : null, reason: why || ("Could not run: " + e.message.slice(0, 140)), tx: e.url }); }
  }

  const held = results.every((r) => r.blocked === true);
  emit({ type: "attack_done", held, total: results.length });
  return { held, results, vault: VAULT };
}

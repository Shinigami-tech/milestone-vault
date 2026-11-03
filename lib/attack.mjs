// Attack demo: pretend the auditor agent was fully taken over (prompt injection, stolen key,
// malicious model) and try every way it could steal the escrowed money. Each attempt is a REAL
// signed transaction on testnet with the auditor's real key; each one must fail.
import { KeyPair, actions } from "near-api-js";
import { account, call, VAULT, view } from "./near.mjs";

const EVIL = process.env.EVIL_ACCOUNT || "evil-collector.testnet";

function reason(e) {
  const s = (e?.message || String(e)) + " " + JSON.stringify(e?.data || e?.cause || "");
  if (/does not allow method|MethodNameMismatch/i.test(s)) return "NEAR protocol: this key may only call `report`";
  if (/ReceiverMismatch|receiver.*(does not match|mismatch)|Wrong receiver/i.test(s)) return "NEAR protocol: this key only works on the vault contract";
  if (/Not enough allowance|NotEnoughAllowance|Deposit is not allowed|RequiresFullAccess|full access/i.test(s)) return "NEAR protocol: a function-call key cannot move NEAR or add keys";
  if (/Only the owner/i.test(s)) return "Contract: only the owner can change the auditor";
  if (/not waiting for an audit/i.test(s)) return "Contract: milestone is not waiting for an audit";
  return null; // not a security rejection: a network or RPC problem
}

export async function runAttack(emit = console.log) {
  const auditor = account(process.env.AUDITOR_ACCOUNT, process.env.AUDITOR_KEY);
  if (!auditor) throw new Error("AUDITOR_ACCOUNT / AUDITOR_KEY missing: run npm run setup:testnet");
  const jobs = (await view("get_jobs", {})) || [];
  const job = jobs.find((j) => j.milestones.some((m) => m.status === "Open" || m.status === "Rejected"));

  const attempts = [
    {
      title: `Send 1 NEAR from the auditor account to ${EVIL}`,
      run: () => auditor.signAndSendTransaction({ receiverId: EVIL, actions: [actions.transfer(10n ** 24n)] }),
    },
    {
      title: `Hand the auditor role to an attacker: vault.set_auditor("${EVIL}")`,
      run: () => call(auditor, "set_auditor", { auditor: EVIL }),
    },
    {
      title: `Call another contract with the vault key (ft_transfer on usdc.fakes.testnet to ${EVIL})`,
      run: () => auditor.signAndSendTransaction({ receiverId: "usdc.fakes.testnet", actions: [actions.functionCall("ft_transfer", { receiver_id: EVIL, amount: "1000000" }, 30_000_000_000_000n, 0n)] }),
    },
    {
      title: "Give itself a full-access key to take over the account",
      run: () => auditor.signAndSendTransaction({ receiverId: process.env.AUDITOR_ACCOUNT, actions: [actions.addFullAccessKey(KeyPair.fromRandom("ed25519").getPublicKey())] }),
    },
    job && {
      title: `Use its one allowed method to fake a pass: report(job ${job.id}, a milestone nobody submitted, passed=true)`,
      run: () => call(auditor, "report", { job_id: job.id, milestone: job.milestones.findIndex((m) => m.status === "Open" || m.status === "Rejected"), passed: true, overall: 100, evidence_hash: "0".repeat(64), summary: "approved by attacker" }),
    },
  ].filter(Boolean);

  const results = [];
  for (const a of attempts) {
    emit({ type: "attack_try", title: a.title });
    try {
      const r = await a.run();
      const failed = r?.status?.Failure || r?.receipts_outcome?.some((o) => o.outcome?.status?.Failure);
      const out = failed ? { title: a.title, blocked: true, reason: reason({ message: JSON.stringify(failed) }) } : { title: a.title, blocked: false, reason: "SUCCEEDED (this must never happen)" };
      results.push(out); emit({ type: "attack_result", ...out });
    } catch (e) {
      const why = reason(e);
      // Only count a real protocol/contract rejection as "blocked". Anything else is shown as an error.
      const out = why ? { title: a.title, blocked: true, reason: why, tx: e.url } : { title: a.title, blocked: null, reason: "Could not run (network/RPC error): " + (e?.message || e).toString().slice(0, 140) };
      results.push(out); emit({ type: "attack_result", ...out });
    }
  }
  const held = results.every((r) => r.blocked === true);
  emit({ type: "attack_done", held, total: results.length });
  return { held, results, vault: VAULT };
}

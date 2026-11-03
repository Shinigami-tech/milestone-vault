// npm run attack — try to steal escrowed funds with the auditor's real key. Every attempt must fail.
import { runAttack } from "../lib/attack.mjs";
const C = { red: "\x1b[31m", green: "\x1b[32m", dim: "\x1b[2m", off: "\x1b[0m" };
const { held, results, vault } = await runAttack((e) => {
  if (e.type === "attack_try") process.stdout.write(`${C.dim}→ ${e.title}${C.off}\n`);
  if (e.type === "attack_result") console.log(`  ${e.blocked === true ? C.green + "⛔ BLOCKED" : e.blocked === null ? C.dim + "⚠ ERROR" : C.red + "!! SUCCEEDED"}${C.off}  ${e.reason}${e.tx ? `\n  ${C.dim}${e.tx}${C.off}` : ""}`);
});
console.log(`\n${held ? C.green + `All ${results.length} attacks failed. The funds in ${vault} stayed put.` : C.red + (results.some((r) => r.blocked === false) ? "AN ATTACK SUCCEEDED" : "Some attempts could not run (network). Try again.")}${C.off}`);
process.exit(held ? 0 : 1);

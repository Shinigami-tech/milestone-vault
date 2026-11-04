// One command to get a private, working copy of Milestone Vault v2 on NEAR testnet:
//   1. creates eight free testnet accounts via the faucet: vault, two independent auditors,
//      an arbiter (dispute resolution), demo client, demo freelancer, a gas relayer and tUSDC
//   2. deploys the vault (2-of-2 auditor quorum) and the testnet-only tUSDC token
//   3. registers everyone with tUSDC and mints 1,000 tUSDC to the demo client
//   4. gives EACH auditor a FUNCTION-CALL key that can only call `report`/`release` on the vault,
//      then DELETES its full-access key, so no auditor account can move money at all
//   5. deletes the vault's own full-access key: the contract code can never be changed again,
//      not even by us (verify on the explorer: the vault account has no access keys)
//   6. writes everything to .env (git-ignored)
//
// Usage: npm run build:contract && npm run build:token && npm run setup:testnet
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions } from "near-api-js";

const RPC = process.env.NEAR_RPC || "https://test.rpc.fastnear.com";
const provider = new JsonRpcProvider({ url: RPC });
// Freshly built wasm if present, else the committed release build (so no Rust is needed to deploy).
const pick = (built, committed) => { const b = new URL(built, import.meta.url).pathname; return existsSync(b) ? b : new URL(committed, import.meta.url).pathname; };
const WASM = pick("../contract/target/near/milestone_vault.wasm", "../contract/res/milestone_vault.wasm");
const TOKEN_WASM = pick("../token/target/near/tusdc.wasm", "../token/res/tusdc.wasm");
const ENV = new URL("../.env", import.meta.url).pathname;
const TGAS = 1_000_000_000_000n;

for (const f of [WASM, TOKEN_WASM]) if (!existsSync(f)) { console.error(`Missing ${f}. Run: npm run build:contract && npm run build:token`); process.exit(1); }
console.log(`Using ${WASM.split("/").slice(-3).join("/")} (sha256 ${(await import("node:crypto")).createHash("sha256").update(readFileSync(WASM)).digest("hex").slice(0, 16)}…)`);
if (existsSync(ENV) && !process.argv.includes("--force")) { console.error(".env already exists. Re-run with --force to create a new deployment."); process.exit(1); }

const prefix = "mv" + randomBytes(3).toString("hex");
const names = {
  vault: `${prefix}-vault.testnet`, auditorA: `${prefix}-audit-a.testnet`, auditorB: `${prefix}-audit-b.testnet`, arbiter: `${prefix}-arbiter.testnet`,
  client: `${prefix}-client.testnet`, freelancer: `${prefix}-dev.testnet`, relayer: `${prefix}-relay.testnet`, token: `${prefix}-tusdc.testnet`,
};
const keys = {};
const acct = (role) => new Account(names[role], provider, KeyPairSigner.fromSecretKey(keys[role]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function createAccount(id) {
  const kp = KeyPair.fromRandom("ed25519");
  for (let i = 0; i < 4; i++) {
    const r = await fetch("https://helper.nearprotocol.com/account", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ newAccountId: id, newAccountPublicKey: kp.getPublicKey().toString() }),
    });
    if (r.ok) { console.log("  created", id); return kp.toString(); }
    const t = (await r.text()).slice(0, 160);
    console.log(`  faucet busy for ${id} (${r.status} ${t}), retrying…`); await sleep(4000 * (i + 1));
  }
  throw new Error(`Faucet refused ${id}`);
}

console.log("1/6 Creating testnet accounts with the faucet…");
for (const [role, id] of Object.entries(names)) { keys[role] = await createAccount(id); await sleep(1200); }
await sleep(3000);

console.log("2/6 Deploying the vault (2-of-2 auditor quorum) and tUSDC…");
await acct("vault").signAndSendTransaction({ receiverId: names.vault, actions: [
  actions.deployContract(readFileSync(WASM)),
  actions.functionCall("new", { owner: names.arbiter, auditors: [names.auditorA, names.auditorB], quorum: 2 }, 30n * TGAS, 0n),
] });
await acct("token").signAndSendTransaction({ receiverId: names.token, actions: [
  actions.deployContract(readFileSync(TOKEN_WASM)),
  actions.functionCall("new", {}, 30n * TGAS, 0n),
] });
console.log("  vault", names.vault, "· token", names.token);

console.log("3/6 Registering accounts with tUSDC and minting 1,000 tUSDC to the client…");
const reg = (id) => actions.functionCall("storage_deposit", { account_id: id, registration_only: true }, 10n * TGAS, 1_250_000_000_000_000_000_000n);
await acct("client").signAndSendTransaction({ receiverId: names.token, actions: [
  reg(names.client), reg(names.freelancer), reg(names.vault), reg(names.auditorA), reg(names.auditorB),
  actions.functionCall("mint", { account_id: names.client, amount: "1000000000" }, 10n * TGAS, 0n),
] });

console.log("4/6 Locking down both auditors' keys…");
const fc = {};
for (const role of ["auditorA", "auditorB"]) {
  const a = acct(role);
  const k = KeyPair.fromRandom("ed25519");
  await a.addFunctionCallAccessKey({ publicKey: k.getPublicKey(), contractId: names.vault, methodNames: ["report", "release"], allowance: 500_000_000_000_000_000_000_000n });
  await a.deleteKey(KeyPair.fromString(keys[role]).getPublicKey());
  const list = await provider.viewAccessKeyList({ accountId: names[role], finality: "final" }).catch(() => null);
  console.log(`  ${names[role]} keys now:`, JSON.stringify(list?.keys?.map((x) => x.access_key.permission) || "see explorer"));
  fc[role] = k.toString();
}

console.log("5/6 Making the vault immutable (deleting its full-access key)…");
await acct("vault").deleteKey(KeyPair.fromString(keys.vault).getPublicKey());
const vk = await provider.viewAccessKeyList({ accountId: names.vault, finality: "final" }).catch(() => null);
console.log("  vault keys now:", vk?.keys?.length ?? "see explorer");

console.log("6/6 Writing .env…");
writeFileSync(ENV, `# Generated by scripts/setup-testnet.mjs — testnet only, never commit this file
NEAR_NETWORK=testnet
VAULT_CONTRACT=${names.vault}
TUSDC_CONTRACT=${names.token}
AUDITOR_A_ACCOUNT=${names.auditorA}
AUDITOR_A_KEY=${fc.auditorA}
AUDITOR_B_ACCOUNT=${names.auditorB}
AUDITOR_B_KEY=${fc.auditorB}
DEMO_CLIENT_ACCOUNT=${names.client}
DEMO_CLIENT_KEY=${keys.client}
DEMO_FREELANCER_ACCOUNT=${names.freelancer}
DEMO_FREELANCER_KEY=${keys.freelancer}
ARBITER_ACCOUNT=${names.arbiter}
ARBITER_KEY=${keys.arbiter}
RELAYER_ACCOUNT=${names.relayer}
RELAYER_KEY=${keys.relayer}
# Optional: verifiable private inference for the audit note (https://cloud.near.ai). Verdicts never depend on it.
NEARAI_API_KEY=
NEARAI_MODEL=
PORT=8090
${process.env.MV_EXTRA_ENV || ""}
`);
console.log(`\nDone. Vault: https://testnet.nearblocks.io/address/${names.vault}\nNext: npm start`);

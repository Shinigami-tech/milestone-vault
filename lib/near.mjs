// Thin NEAR helpers (near-api-js v7). All keys come from environment variables, never the repo.
import { Account, FailoverRpcProvider, JsonRpcProvider, KeyPairSigner } from "near-api-js";

export const NETWORK = process.env.NEAR_NETWORK || "testnet";
// Public RPCs rate-limit (HTTP 429). NEAR_RPC may list several, comma-separated; we fail over between them.
const DEFAULT_RPCS = NETWORK === "mainnet"
  ? ["https://free.rpc.fastnear.com", "https://rpc.mainnet.near.org", "https://near.drpc.org"]
  : ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org", "https://near-testnet.drpc.org"];
export const RPCS = (process.env.NEAR_RPC ? process.env.NEAR_RPC.split(",") : DEFAULT_RPCS).map((u) => u.trim()).filter(Boolean);
export const RPC = RPCS[0];
export const EXPLORER = NETWORK === "mainnet" ? "https://nearblocks.io" : "https://testnet.nearblocks.io";
export const VAULT = process.env.VAULT_CONTRACT || "";
const providers = RPCS.map((url) => new JsonRpcProvider({ url }, { retries: 2, wait: 400, backoff: 1.5 }));
export const provider = providers.length > 1 ? new FailoverRpcProvider(providers) : providers[0];

export const toYocto = (near) => (BigInt(Math.round(Number(near) * 1e6)) * 10n ** 18n).toString();
export const fromYocto = (y) => Number(BigInt(y) / 10n ** 18n) / 1e6;

export function account(accountId, key) {
  if (!accountId || !key) return null;
  return new Account(accountId, provider, KeyPairSigner.fromSecretKey(key));
}

// Read-only calls are shared by both auditors and every open page: a 2 s cache keeps us far below RPC rate limits.
const cache = new Map();
export async function view(method, args = {}, { fresh = false } = {}) {
  const key = method + JSON.stringify(args), hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.t < 2000) return hit.p;
  const p = provider.callFunction({ contractId: VAULT, method, args });
  cache.set(key, { t: Date.now(), p });
  p.catch(() => cache.delete(key));
  if (cache.size > 500) cache.clear();
  return p;
}
/** Drop cached reads after a write so the next view sees it. */
export const invalidate = () => cache.clear();

/** Calls the vault (or `receiverId`) and returns { hash, url, logs, value }. Throws with a readable message. */
export async function call(acc, methodName, args, { deposit = "0", gas = "100000000000000", receiverId = VAULT } = {}) {
  const res = await acc.signAndSendTransaction({
    receiverId,
    actions: [(await import("near-api-js")).actions.functionCall(methodName, args, BigInt(gas), BigInt(deposit))],
    waitUntil: "EXECUTED_OPTIMISTIC",
    throwOnFailure: false,
  });
  invalidate();
  return outcome(res);
}

/** Normalises a transaction response; throws on any failed receipt. */
export function outcome(res) {
  const hash = res.transaction?.hash || res.transaction_outcome?.id;
  const all = [res.transaction_outcome, ...(res.receipts_outcome || [])];
  const logs = all.flatMap((o) => o?.outcome?.logs || []);
  const failure = all.map((o) => o?.outcome?.status?.Failure).find(Boolean) || res.status?.Failure;
  let value = null;
  if (res.status?.SuccessValue) { try { value = JSON.parse(Buffer.from(res.status.SuccessValue, "base64").toString()); } catch {} }
  if (failure) { const e = new Error(errorText(failure)); e.hash = hash; e.url = txUrl(hash); throw e; }
  return { hash, url: txUrl(hash), logs, value };
}

/** View call on any contract. */
export async function viewOn(contractId, method, args = {}) {
  return provider.callFunction({ contractId, method, args });
}

export const txUrl = (hash) => `${EXPLORER}/txns/${hash}`;
export const accountUrl = (id) => `${EXPLORER}/address/${id}`;

export function errorText(f) {
  const s = JSON.stringify(f);
  const m = s.match(/Smart contract panicked: ([^"\\]+)/) || s.match(/"ExecutionError":"([^"]+)"/);
  return m ? m[1] : s.slice(0, 300);
}

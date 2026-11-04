// Thin NEAR helpers (near-api-js v7). All keys come from environment variables, never the repo.
import { Account, JsonRpcProvider, KeyPairSigner } from "near-api-js";

export const NETWORK = process.env.NEAR_NETWORK || "testnet";
export const RPC = process.env.NEAR_RPC || (NETWORK === "mainnet" ? "https://free.rpc.fastnear.com" : "https://test.rpc.fastnear.com");
export const EXPLORER = NETWORK === "mainnet" ? "https://nearblocks.io" : "https://testnet.nearblocks.io";
export const VAULT = process.env.VAULT_CONTRACT || "";
export const provider = new JsonRpcProvider({ url: RPC });

export const toYocto = (near) => (BigInt(Math.round(Number(near) * 1e6)) * 10n ** 18n).toString();
export const fromYocto = (y) => Number(BigInt(y) / 10n ** 18n) / 1e6;

export function account(accountId, key) {
  if (!accountId || !key) return null;
  return new Account(accountId, provider, KeyPairSigner.fromSecretKey(key));
}

export async function view(method, args = {}) {
  return provider.callFunction({ contractId: VAULT, method, args });
}

/** Calls the vault (or `receiverId`) and returns { hash, url, logs, value }. Throws with a readable message. */
export async function call(acc, methodName, args, { deposit = "0", gas = "100000000000000", receiverId = VAULT } = {}) {
  const res = await acc.signAndSendTransaction({
    receiverId,
    actions: [(await import("near-api-js")).actions.functionCall(methodName, args, BigInt(gas), BigInt(deposit))],
    waitUntil: "EXECUTED_OPTIMISTIC",
    throwOnFailure: false,
  });
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

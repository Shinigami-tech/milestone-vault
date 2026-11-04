// NEAR AI Cloud client (OpenAI-compatible, private inference inside a TEE) with response verification.
// The API key lives only on the auditor host; it is never passed into a sandbox.
//
// Every note the model writes comes back with proof:
//   1. we hash the exact request and response bytes,
//   2. fetch the TEE's signature over "<model>:<request_hash>:<response_hash>" and check it locally
//      (EIP-191 / ECDSA signer recovery),
//   3. fetch a fresh attestation report with our own nonce and require that exactly one NEAR model
//      attestation has that signing address.
// The bundle is published as evidence and its sha256 goes on chain with the verdict, so anyone can
// re-check it (or paste it into https://cloud.near.ai/verify for the full TDX/GPU quote check).
import { createHash, randomBytes } from "node:crypto";
import { verifyMessage } from "ethers";

const BASE = process.env.NEARAI_BASE_URL || "https://cloud-api.near.ai/v1";
const KEY = process.env.NEARAI_API_KEY || "";
let MODEL = process.env.NEARAI_MODEL || "";

export const llmEnabled = () => Boolean(KEY);
export const modelName = () => MODEL || "(auto)";
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const H = () => ({ Authorization: `Bearer ${KEY}`, Accept: "application/json" });

async function pickModel() {
  if (MODEL) return MODEL;
  const j = await (await fetch(`${BASE}/models`, { headers: H() })).json();
  const ids = (j.data || []).map((m) => m.id);
  const pref = [/glm/i, /qwen/i, /deepseek/i, /gpt-oss/i, /llama/i];
  MODEL = pref.map((re) => ids.find((id) => re.test(id))).find(Boolean) || ids[0];
  return MODEL;
}

/** Pure check of a NEAR AI Cloud response signature. Exported for tests. */
export function checkSignature({ sig, model, requestHash, responseHash }) {
  if (!sig || sig.error_code) return { ok: false, why: "no signature" };
  if (sig.signing_algo !== "ecdsa") return { ok: false, why: `unsupported algo ${sig.signing_algo}` };
  const expected = sig.signature_kind === "gateway" ? `${requestHash}:${responseHash}` : sig.signature_kind === "provider_tee" ? `${model}:${requestHash}:${responseHash}` : null;
  if (!expected) return { ok: false, why: `unknown signature_kind ${sig.signature_kind}` };
  if (sig.text !== expected) return { ok: false, why: "signed text does not match our request/response hashes" };
  let signer;
  try { signer = verifyMessage(sig.text, sig.signature); } catch { return { ok: false, why: "bad signature" }; }
  if (signer.toLowerCase() !== String(sig.signing_address).toLowerCase()) return { ok: false, why: "signer mismatch" };
  return { ok: true, signer };
}

async function attest(model, chatId, requestHash, responseHash) {
  const sig = await (await fetch(`${BASE}/signature/${encodeURIComponent(chatId)}?signing_algo=ecdsa`, { headers: H() })).json().catch(() => null);
  const check = checkSignature({ sig, model, requestHash, responseHash });
  const nonce = randomBytes(32).toString("hex");
  const q = new URLSearchParams({ model, provider: "near", include_tls_fingerprint: "false", signing_algo: "ecdsa", nonce });
  const rep = await (await fetch(`${BASE}/attestation/report?${q}`, { headers: { ...H(), "x-no-aliasing": "true" } })).json().catch(() => ({}));
  const matches = (rep.model_attestations || []).filter((a) => a.request_nonce === nonce && String(a.signing_address).toLowerCase() === String(sig?.signing_address).toLowerCase());
  const bound = sig?.signature_kind === "gateway" ? Boolean(rep.gateway_attestation) : matches.length === 1;
  const bundle = {
    provider: "NEAR AI Cloud", model, chat_id: chatId, request_hash: requestHash, response_hash: responseHash,
    signature: sig && { text: sig.text, signature: sig.signature, signing_address: sig.signing_address, signing_algo: sig.signing_algo, signature_kind: sig.signature_kind },
    nonce, quote_sha256: matches[0]?.intel_quote ? sha256(matches[0].intel_quote) : null, gpu_evidence: Boolean(matches[0]?.nvidia_payload),
    verified: { signature: check.ok, signer_in_attestation: bound, why: check.ok ? (bound ? "ok" : "signer not found in a fresh attestation report") : check.why },
    verify_at: "https://cloud.near.ai/verify",
  };
  const body = JSON.stringify(bundle, null, 2);
  return { bundle, body, hash: sha256(body), ok: check.ok && bound };
}

/** Chat completion. With { attest: true } also returns a verified attestation bundle. */
export async function chat(messages, { maxTokens = 1800, temperature = 0.2, attest: wantProof = false } = {}) {
  const model = await pickModel();
  const reqBody = JSON.stringify({ model, messages, max_tokens: maxTokens, temperature, stream: false });
  const r = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { ...H(), "Content-Type": "application/json", "Accept-Encoding": "identity", "x-no-aliasing": "true" },
    body: reqBody,
  });
  const resText = await r.text();
  if (!r.ok) throw new Error(`NEAR AI Cloud ${r.status}: ${resText.slice(0, 200)}`);
  const j = JSON.parse(resText);
  const content = (j.choices?.[0]?.message?.content || "").replace(/<think>[\s\S]*?(<\/think>|$)/g, "").trim();
  if (!wantProof) return content;
  let proof = null;
  try { proof = await attest(model, j.id, sha256(reqBody), sha256(resText)); } catch (e) { proof = { ok: false, error: e.message }; }
  return { content, proof };
}

export function parseJson(text) {
  const t = text.replace(/<think>[\s\S]*?(<\/think>|$)/g, "");
  const m = t.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1)];
  return JSON.parse(m[1]);
}

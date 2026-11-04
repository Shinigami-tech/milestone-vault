// The AI-proof check is pure code: these tests sign with a throwaway key, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { checkSignature } from "../auditor/engine/llm.mjs";

const w = Wallet.createRandom();
const model = "glm-5", requestHash = "a".repeat(64), responseHash = "b".repeat(64);
const sign = async (text, kind = "provider_tee", by = w) => ({ text, signature: await by.signMessage(text), signing_address: w.address, signing_algo: "ecdsa", signature_kind: kind });

test("a genuine TEE signature over our exact hashes verifies", async () => {
  assert.equal(checkSignature({ sig: await sign(`${model}:${requestHash}:${responseHash}`), model, requestHash, responseHash }).ok, true);
});
test("a signature over a different response is rejected", async () => {
  const r = checkSignature({ sig: await sign(`${model}:${requestHash}:${"c".repeat(64)}`), model, requestHash, responseHash });
  assert.equal(r.ok, false); assert.match(r.why, /does not match/);
});
test("a signature by another key claiming the TEE's address is rejected", async () => {
  const r = checkSignature({ sig: await sign(`${model}:${requestHash}:${responseHash}`, "provider_tee", Wallet.createRandom()), model, requestHash, responseHash });
  assert.equal(r.ok, false); assert.match(r.why, /signer mismatch/);
});
test("missing signatures are never treated as verified", () => {
  assert.equal(checkSignature({ sig: { error_code: "not_found" }, model, requestHash, responseHash }).ok, false);
});

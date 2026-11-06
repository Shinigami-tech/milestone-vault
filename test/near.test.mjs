import { test } from "node:test";
import assert from "node:assert/strict";
import { JsonRpcProvider } from "near-api-js";
import { SmartFailover, isTransient } from "../lib/near.mjs";

test("RPC failover retries rate limits on the next node but never hides a protocol refusal", async () => {
  assert.equal(isTransient(new Error("429 Too Many Requests")), true);
  assert.equal(isTransient(new Error("fetch failed")), true);
  assert.equal(isTransient(new Error("Access key permission: method name mismatch (MethodNameMismatch)")), false);
  const fo = new SmartFailover([new JsonRpcProvider({ url: "http://a" }), new JsonRpcProvider({ url: "http://b" })]);
  const seen = [];
  const r = await fo.withBackoff(async (p) => { seen.push(p.connection.url); if (p.connection.url === "http://a") throw new Error("Rate limits exceeded (429)"); return "ok"; });
  assert.deepEqual([r, seen], ["ok", ["http://a", "http://b"]]);
  await assert.rejects(fo.withBackoff(async () => { throw new Error("NotEnoughAllowance: function-call key cannot transfer"); }), /NotEnoughAllowance/);
});

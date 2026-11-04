// The relayer only pays for the freelancer's `submit` call on the vault, nothing else.
import { test } from "node:test";
import assert from "node:assert/strict";
import { relayPolicy } from "../lib/relayer.mjs";

const fc = (methodName, deposit = 0n, gas = 50_000_000_000_000n) => ({ functionCall: { methodName, deposit, gas } });
const sd = (receiverId, acts) => ({ delegateAction: { receiverId, actions: acts } });

test("a freelancer's submit on the vault is relayed", () => { assert.equal(relayPolicy(sd("vault.testnet", [fc("submit")]), "vault.testnet"), null); });
test("calls to other contracts are refused", () => { assert.match(relayPolicy(sd("usdc.testnet", [fc("submit")]), "vault.testnet"), /only pays for calls/); });
test("other vault methods are refused", () => { assert.match(relayPolicy(sd("vault.testnet", [fc("approve")]), "vault.testnet"), /does not pay for approve/); });
test("transfers and deposits are refused", () => {
  assert.match(relayPolicy(sd("vault.testnet", [{ transfer: { deposit: 1n } }]), "vault.testnet"), /only pays for function calls/);
  assert.match(relayPolicy(sd("vault.testnet", [fc("submit", 1n)]), "vault.testnet"), /never pays deposits/);
});
test("gas above the cap is refused", () => { assert.match(relayPolicy(sd("vault.testnet", [fc("submit", 0n, 300_000_000_000_000n)]), "vault.testnet"), /cap/); });

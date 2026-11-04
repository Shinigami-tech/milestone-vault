// Gasless freelancer: NEP-366 meta transactions.
// The freelancer signs a DelegateAction ("call vault.submit(...)") with their own key, offline. Our
// relayer wraps it in a transaction and pays the gas. The freelancer never needs to buy NEAR.
//
// The relayer is not a blank cheque: it only relays delegate actions that
//   * target the vault contract,
//   * contain nothing but function calls to the allowed methods (`submit`),
//   * attach no deposit and stay under a gas cap.
// Anything else is refused before it is signed, so the relayer's NEAR can't be drained.
import { actions } from "near-api-js";
import { account, outcome, VAULT } from "./near.mjs";

export const RELAY_METHODS = ["submit"];
const MAX_GAS = 100_000_000_000_000n;

export function relayer() { return account(process.env.RELAYER_ACCOUNT, process.env.RELAYER_KEY); }

/** Returns null if the relayer may pay for this signed delegate, else the reason it refuses. */
export function relayPolicy(signedDelegate, vault = VAULT) {
  const da = signedDelegate?.delegateAction;
  if (!da) return "Not a signed delegate action";
  if (da.receiverId !== vault) return `Relayer only pays for calls to ${vault}`;
  let gas = 0n;
  for (const a of da.actions || []) {
    const fc = a.functionCall;
    if (!fc) return "Relayer only pays for function calls";
    if (!RELAY_METHODS.includes(fc.methodName)) return `Relayer does not pay for ${fc.methodName}`;
    if (BigInt(fc.deposit) !== 0n) return "Relayer never pays deposits";
    gas += BigInt(fc.gas);
  }
  if (!da.actions?.length) return "Empty delegate action";
  if (gas > MAX_GAS) return "Gas above the relayer's cap";
  return null;
}

/** Freelancer signs `submit` as a meta transaction; the relayer pays the gas. */
export async function gaslessSubmit(freelancerAccount, args) {
  const r = relayer();
  if (!r) throw new Error("RELAYER_ACCOUNT / RELAYER_KEY missing");
  const { signedDelegate } = await freelancerAccount.createSignedMetaTransaction({
    receiverId: VAULT,
    actions: [actions.functionCall("submit", args, 50_000_000_000_000n, 0n)],
  });
  const refused = relayPolicy(signedDelegate);
  if (refused) throw new Error(`Relayer refused: ${refused}`);
  return outcome(await r.relayMetaTransaction(signedDelegate));
}

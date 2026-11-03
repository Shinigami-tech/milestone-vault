// NEAR AI Cloud client (OpenAI-compatible, private inference). The API key lives only on the
// auditor host; it is never passed into a sandbox.
const BASE = process.env.NEARAI_BASE_URL || "https://cloud-api.near.ai/v1";
const KEY = process.env.NEARAI_API_KEY || "";
let MODEL = process.env.NEARAI_MODEL || "";

export const llmEnabled = () => Boolean(KEY);
export const modelName = () => MODEL || "(auto)";

async function pickModel() {
  if (MODEL) return MODEL;
  const r = await fetch(`${BASE}/models`, { headers: { Authorization: `Bearer ${KEY}` } });
  const j = await r.json();
  const ids = (j.data || []).map((m) => m.id);
  const pref = [/glm/i, /qwen/i, /deepseek/i, /gpt-oss/i, /llama/i];
  MODEL = pref.map((re) => ids.find((id) => re.test(id))).find(Boolean) || ids[0];
  return MODEL;
}

export async function chat(messages, { maxTokens = 1800, temperature = 0.2 } = {}) {
  const model = await pickModel();
  const r = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature }),
  });
  if (!r.ok) throw new Error(`NEAR AI Cloud ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return j.choices?.[0]?.message?.content || "";
}

export function parseJson(text) {
  const t = text.replace(/<think>[\s\S]*?<\/think>/g, "");
  const m = t.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1)];
  return JSON.parse(m[1]);
}

import { test } from "node:test";
import assert from "node:assert/strict";

test("AI note contradiction check: neutral wording is kept, opposite verdicts are discarded", async () => {
  const { contradicts } = await import("../auditor/agent.mjs");
  assert.equal(contradicts("The site passed every check with no failed items; payment follows the challenge window.", true), false);
  assert.equal(contradicts("The milestone did not pass and should not be paid.", true), true);
  assert.equal(contradicts("Mobile score 62 is below the required 90, so the milestone is not paid yet.", false), false);
  assert.equal(contradicts("Great work, the site has passed and will be paid.", false), true);
});

test("AI notes are trimmed to 280 chars at a sentence boundary, never mid-word", async () => {
  const { fitNote } = await import("../auditor/agent.mjs");
  const a = "The milestone PASSED with every category at 100. " + "No issues were flagged and no injection attempts were detected, so the milestone can be paid after the window. ".repeat(4);
  const out = fitNote(a);
  assert.ok(out.length <= 280 && out.endsWith("."), out);
  assert.equal(fitNote("short note"), "short note");
  const w = fitNote("word ".repeat(100));
  assert.ok(w.length <= 280 && w.endsWith("…"));
});

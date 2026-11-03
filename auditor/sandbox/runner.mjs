// SiteDoctor sandbox runner.
// Runs INSIDE an isolated, throwaway container. It has no API keys, no host access and strict limits.
// Input:  /job/input.json  { url, mode: "audit" | "verify", patch?: { css, js }, allowHosts?: [] }
// Output: /job/out/report.json + /job/out/{desktop,mobile}.png
import { chromium } from "playwright";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";

const require = createRequire(import.meta.url);
const JOB = process.env.SD_JOB_DIR || "/job";
const OUT = `${JOB}/out`;
mkdirSync(OUT, { recursive: true });
const input = JSON.parse(readFileSync(`${JOB}/input.json`, "utf8"));
const axeSource = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const toolbox = readFileSync(new URL("./toolbox.js", import.meta.url), "utf8");
const started = Date.now();
const containment = []; // every blocked action is recorded here and shown in the UI
const log = (m) => process.stdout.write(`[sandbox] ${m}\n`);

const target = new URL(input.url);
if (!/^https?:$/.test(target.protocol)) fail(`Only http(s) URLs are allowed, got ${target.protocol}`);
const allowHosts = new Set((input.allowHosts || []).map((h) => h.toLowerCase()));

/* ---------------- network guard (containment layer 2, inside the browser) ---------------- */
const PRIVATE = [/^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];
function isPrivateHost(host) {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (allowHosts.has(h)) return false;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h === "metadata.google.internal") return true;
  if (net.isIP(h) === 4) return PRIVATE.some((r) => r.test(h));
  if (net.isIP(h) === 6) return h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80");
  return false;
}
function checkRequest(req) {
  let u;
  try { u = new URL(req.url()); } catch { return null; }
  if (u.protocol === "data:" || u.protocol === "blob:") return null;
  if (!/^https?:$/.test(u.protocol)) return { rule: "scheme", why: `Blocked ${u.protocol} access` };
  if (isPrivateHost(u.hostname)) {
    const meta = u.hostname === "169.254.169.254";
    return { rule: meta ? "metadata" : "private-network", why: meta ? "Blocked cloud metadata request (credential theft attempt)" : `Blocked request to private network host ${u.hostname}` };
  }
  const sameSite = u.hostname === target.hostname || u.hostname.endsWith("." + target.hostname.replace(/^www\./, ""));
  const method = req.method();
  if (!sameSite && method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    return { rule: "exfiltration", why: `Blocked ${method} to third-party ${u.hostname} (possible data exfiltration)` };
  }
  return null;
}

async function guard(page, label) {
  await page.route("**/*", (route) => {
    const req = route.request();
    const verdict = checkRequest(req);
    if (verdict) {
      containment.push({ ...verdict, url: req.url().slice(0, 200), method: req.method(), viewport: label, t: Date.now() - started });
      log(`BLOCKED ${verdict.rule}: ${req.url().slice(0, 120)}`);
      return route.abort("blockedbyclient");
    }
    return route.continue();
  });
}

/* ---------------- page checks ---------------- */
async function measure(page, label) {
  const consoleErrors = [];
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text().slice(0, 200)));
  page.on("pageerror", (e) => consoleErrors.push(String(e.message).slice(0, 200)));
  const t0 = Date.now();
  let status = 0;
  try {
    const resp = await page.goto(input.url, { waitUntil: "load", timeout: 30000 });
    status = resp ? resp.status() : 0;
  } catch (e) {
    return { label, error: `Page did not load: ${e.message.split("\n")[0]}` };
  }
  await page.waitForTimeout(800);
  const loadMs = Date.now() - t0;

  let applied = null;
  if (input.patch) {
    // The prescription runs here, inside the sandbox, never on the host.
    try {
      await page.addScriptTag({ content: toolbox });
      if (input.patch.css) await page.addStyleTag({ content: input.patch.css });
      applied = await page.evaluate((actions) => {
        const out = [];
        for (const a of actions || []) {
          if (typeof window.__sd[a.tool] !== "function") throw new Error(`Unknown tool "${a.tool}"`);
          out.push({ tool: a.tool, changed: window.__sd[a.tool](...(Array.isArray(a.args) ? a.args : a.args == null ? [] : [a.args])) });
        }
        return out;
      }, input.patch.actions || []);
      if (input.patch.js) await page.evaluate(input.patch.js);
    } catch (e) {
      return { label, error: `Patch failed: ${e.message.split("\n")[0]}`, patchError: true };
    }
    await page.waitForTimeout(400);
  }

  const dom = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const all = [...document.querySelectorAll("body *")];
    const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
    const overflowing = all.filter((el) => visible(el) && el.getBoundingClientRect().right > vw + 2).slice(0, 8)
      .map((el) => el.tagName.toLowerCase() + (el.id ? "#" + el.id : el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/)[0] : ""));
    const textEls = all.filter((el) => visible(el) && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 2));
    const smallText = textEls.filter((el) => parseFloat(getComputedStyle(el).fontSize) < 12).length;
    const taps = [...document.querySelectorAll("a, button, input, select, textarea, [role=button]")].filter(visible);
    const smallTaps = taps.filter((el) => { const r = el.getBoundingClientRect(); return r.width < 44 || r.height < 44; }).length;
    const links = [...document.querySelectorAll("a[href]")].map((a) => a.href).filter((h) => /^https?:/.test(h));
    return {
      title: document.title,
      lang: document.documentElement.getAttribute("lang") || "",
      viewport: document.querySelector('meta[name="viewport"]')?.getAttribute("content") || "",
      description: document.querySelector('meta[name="description"]')?.getAttribute("content") || "",
      h1: document.querySelectorAll("h1").length,
      imgsNoAlt: [...document.images].filter((i) => !i.hasAttribute("alt")).length,
      images: document.images.length,
      scrollWidth: document.documentElement.scrollWidth, viewportWidth: vw,
      overflowing, smallText, textCount: textEls.length, smallTaps, tapCount: taps.length,
      links: [...new Set(links)].slice(0, 25),
      // Text a human can't see (display:none, zero size, transparent, off-screen, aria-hidden, comments)
      // is where prompt-injection attacks against AI agents usually hide.
      hiddenText: (() => {
        const out = [];
        const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_COMMENT);
        for (let n = tw.nextNode(); n && out.join(" ").length < 4000; n = tw.nextNode()) {
          const t = n.textContent.trim(); if (t.length < 12) continue;
          if (n.nodeType === 8) { out.push(t); continue; }
          const el = n.parentElement; if (!el || ["SCRIPT", "STYLE", "NOSCRIPT"].includes(el.tagName)) continue;
          const s = getComputedStyle(el), r = el.getBoundingClientRect();
          const hidden = !visible(el) || parseFloat(s.fontSize) < 2 || parseFloat(s.opacity) < 0.05 || s.color === s.backgroundColor ||
            r.right < 0 || r.bottom < 0 || r.left > vw * 3 || el.closest("[aria-hidden=true]") || s.clipPath === "inset(50%)" || s.color === "rgba(0, 0, 0, 0)";
          if (hidden) out.push(t);
        }
        return out.join("\n").slice(0, 4000);
      })(),
      visibleText: document.body.innerText.slice(0, 4000),
    };
  });

  await page.addScriptTag({ content: axeSource });
  const axe = await page.evaluate(async () => {
    const r = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] }, resultTypes: ["violations"] });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, sample: v.nodes[0]?.target?.join(" ") || "" }));
  });

  const perf = await page.evaluate(() => {
    const res = performance.getEntriesByType("resource");
    const nav = performance.getEntriesByType("navigation")[0];
    return { requests: res.length + 1, bytes: Math.round(res.reduce((s, r) => s + (r.transferSize || r.encodedBodySize || 0), 0) + (nav?.transferSize || 0)), domContentLoaded: Math.round(nav?.domContentLoadedEventEnd || 0) };
  });

  await page.screenshot({ path: `${OUT}/${label}.png`, fullPage: false });
  return { label, status, loadMs, consoleErrors, dom, axe, perf, applied };
}

async function checkLinks(ctx, links) {
  const out = [];
  for (const href of links.slice(0, 20)) {
    let u; try { u = new URL(href); } catch { continue; }
    if (isPrivateHost(u.hostname)) continue;
    try {
      const r = await ctx.request.fetch(href, { method: "HEAD", timeout: 6000, maxRedirects: 5 });
      let s = r.status();
      if (s === 405 || s === 403) s = (await ctx.request.get(href, { timeout: 6000 })).status();
      if (s >= 400) out.push({ href, status: s });
    } catch { out.push({ href, status: 0 }); }
  }
  return out;
}

function fail(msg) {
  writeFileSync(`${OUT}/report.json`, JSON.stringify({ ok: false, error: msg, containment }, null, 2));
  log(msg);
  process.exit(0);
}

/* ---------------- main ---------------- */
const hardStop = setTimeout(() => fail("Sandbox time limit reached (60 s)"), 60000);
const browser = await chromium.launch({ args: ["--disable-dev-shm-usage", "--no-first-run", "--disable-background-networking"] });
try {
  const desktopCtx = await browser.newContext({ viewport: { width: 1366, height: 860 }, ignoreHTTPSErrors: false });
  const mobileCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" });
  const dp = await desktopCtx.newPage(); await guard(dp, "desktop");
  const mp = await mobileCtx.newPage(); await guard(mp, "mobile");
  log(`opening ${input.url} (${input.mode})`);
  const desktop = await measure(dp, "desktop");
  const mobile = await measure(mp, "mobile");
  if (desktop.error && !desktop.patchError) fail(desktop.error);
  const broken = desktop.dom ? await checkLinks(desktopCtx, desktop.dom.links) : [];
  writeFileSync(`${OUT}/report.json`, JSON.stringify({ ok: true, mode: input.mode, url: input.url, desktop, mobile, brokenLinks: broken, containment, durationMs: Date.now() - started }, null, 2));
  log(`done in ${Date.now() - started} ms, ${containment.length} blocked action(s)`);
} catch (e) {
  fail(`Sandbox error: ${e.message.split("\n")[0]}`);
} finally {
  clearTimeout(hardStop);
  await browser.close().catch(() => {});
}

// Turns a raw sandbox report into scores (0-100) and a list of human-readable findings.
const IMPACT = { critical: 15, serious: 10, moderate: 5, minor: 2 };
const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));

export function diagnose(report) {
  if (!report?.ok) return null;
  const d = report.desktop, m = report.mobile, md = m.dom || {}, dd = d.dom || {};
  const findings = [];
  const add = (cat, sev, key, title, detail) => findings.push({ cat, sev, key, title, detail });

  // Accessibility
  let a11y = 100;
  for (const v of m.axe || []) {
    a11y -= (IMPACT[v.impact] || 3) + Math.min(v.nodes, 10);
    add("Accessibility", v.impact === "critical" || v.impact === "serious" ? "high" : "medium", `axe:${v.id}`, v.help, `${v.nodes} element(s), e.g. ${v.sample}`);
  }

  // Mobile
  let mobile = 100;
  if (!md.viewport) { mobile -= 35; add("Mobile", "high", "viewport", "No mobile viewport", "Phones render the page as a zoomed-out desktop site."); }
  if (md.scrollWidth > md.viewportWidth + 2) { mobile -= 25; add("Mobile", "high", "overflow", "Page is wider than the phone screen", `Content is ${md.scrollWidth}px wide on a ${md.viewportWidth}px screen: ${md.overflowing.slice(0, 3).join(", ")}`); }
  const smallTextRatio = md.textCount ? md.smallText / md.textCount : 0;
  if (smallTextRatio > 0.1) { mobile -= Math.round(smallTextRatio * 25); add("Mobile", "medium", "small-text", "Text too small to read", `${md.smallText} of ${md.textCount} text elements are under 12px.`); }
  const smallTapRatio = md.tapCount ? md.smallTaps / md.tapCount : 0;
  if (smallTapRatio > 0.2) { mobile -= Math.round(smallTapRatio * 20); add("Mobile", "medium", "tap-targets", "Buttons and links too small to tap", `${md.smallTaps} of ${md.tapCount} are smaller than 44×44px.`); }

  // Performance
  let perf = 100;
  const kb = Math.round((d.perf?.bytes || 0) / 1024);
  if (d.loadMs > 2500) { perf -= Math.min(40, Math.round((d.loadMs - 2500) / 100)); add("Performance", "medium", "slow", "Slow to load", `${(d.loadMs / 1000).toFixed(1)}s until the page finished loading.`); }
  if (kb > 1500) { perf -= Math.min(30, Math.round((kb - 1500) / 100)); add("Performance", "medium", "heavy", "Heavy page", `${kb} KB transferred.`); }
  if ((d.perf?.requests || 0) > 80) { perf -= 10; add("Performance", "low", "requests", "Too many requests", `${d.perf.requests} network requests.`); }

  // SEO & basics
  let seo = 100;
  if (!dd.title) { seo -= 20; add("SEO", "high", "title", "Missing page title", "Search results will show the URL instead."); }
  if (!dd.description) { seo -= 15; add("SEO", "medium", "description", "Missing meta description", "Google has nothing to show under the title."); }
  if (!dd.h1) { seo -= 15; add("SEO", "medium", "h1", "No main heading (h1)", "Search engines can't tell what the page is about."); }
  if (!dd.lang) { seo -= 10; add("SEO", "low", "lang", "No page language set", "Screen readers and Google may guess the wrong language."); }

  // Reliability
  let rel = 100;
  for (const b of report.brokenLinks || []) { rel -= 12; add("Reliability", "high", "broken:" + b.href, "Broken link", `${b.href} returns ${b.status || "no response"}.`); }
  const errs = [...new Set([...(d.consoleErrors || [])])].filter((e) => !/ERR_BLOCKED_BY_CLIENT/.test(e)); // our own blocks are reported under Security

  // Security: anything the sandbox had to stop is a red flag on the real site
  let sec = 100;
  const byRule = {};
  for (const c of report.containment || []) (byRule[c.rule] ||= new Set()).add(c.url.split("?")[0]);
  const RULE = { metadata: "Script tries to read cloud metadata (credential theft)", "private-network": "Script probes the private network / server internals", exfiltration: "Script sends visitor data to a third party", scheme: "Page tries to open local files" };
  for (const [rule, urls] of Object.entries(byRule)) { sec -= 30; add("Security", "high", "sec:" + rule, RULE[rule] || rule, [...urls].slice(0, 2).join(" · ") + " — blocked in the sandbox. Remove this script from your site."); }
  if (errs.length) { rel -= Math.min(30, errs.length * 6); add("Reliability", "low", "console", "JavaScript errors", errs.slice(0, 2).join(" · ")); }

  const scores = { Accessibility: clamp(a11y), Mobile: clamp(mobile), Performance: clamp(perf), SEO: clamp(seo), Reliability: clamp(rel), Security: clamp(sec) };
  const overall = clamp(Object.values(scores).reduce((s, v) => s + v, 0) / Object.keys(scores).length);
  return { scores, overall, findings, stats: { loadMs: d.loadMs, kb, requests: d.perf?.requests || 0 } };
}

// Compact version of the diagnosis for the language model (keeps the prompt small).
export function forModel(report, dx) {
  const md = report.mobile.dom, dd = report.desktop.dom;
  return {
    url: report.url,
    title: dd.title, lang: dd.lang, viewport: md.viewport, description: dd.description, h1Count: dd.h1,
    mobile: { scrollWidth: md.scrollWidth, viewportWidth: md.viewportWidth, overflowing: md.overflowing, smallText: md.smallText, smallTaps: md.smallTaps },
    imagesWithoutAlt: dd.imgsNoAlt,
    accessibility: (report.mobile.axe || []).map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes, example: v.sample })),
    brokenLinks: report.brokenLinks,
    findings: dx.findings.map((f) => `${f.cat}: ${f.title}`),
  };
}

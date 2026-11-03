/* SiteDoctor toolbox: small, safe DOM fixes the agent can prescribe.
   The same file is shipped to the site owner inside sitedoctor-fix.js, so a fix that was verified
   in the sandbox behaves exactly the same on the real site. */
(function () {
  if (window.__sd) return;
  const log = [];
  const note = (tool, n) => { log.push({ tool, changed: n }); return n; };
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  const css = (text) => { const s = document.createElement("style"); s.dataset.sitedoctor = ""; s.textContent = text; document.head.appendChild(s); };

  // colour helpers for contrast
  const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(",").map((x) => parseFloat(x)); return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 }; };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const bgOf = (el) => { for (let n = el; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c && c.a > 0.5) return c; } return { r: 255, g: 255, b: 255, a: 1 }; };

  window.__sd = {
    log,
    viewport() {
      if (document.querySelector('meta[name="viewport"]')) return note("viewport", 0);
      const m = document.createElement("meta"); m.name = "viewport"; m.content = "width=device-width, initial-scale=1"; document.head.appendChild(m);
      return note("viewport", 1);
    },
    lang(code = "en") { if (document.documentElement.lang) return note("lang", 0); document.documentElement.lang = code; return note("lang", 1); },
    description(text) {
      let m = document.querySelector('meta[name="description"]');
      if (m && m.content) return note("description", 0);
      if (!m) { m = document.createElement("meta"); m.name = "description"; document.head.appendChild(m); }
      m.content = String(text).slice(0, 160); return note("description", 1);
    },
    altText(texts = []) {
      let n = 0, i = 0;
      for (const img of document.images) {
        if (img.hasAttribute("alt")) continue;
        let t = texts[i++];
        if (!t) {
          const box = img.closest("figure, .card, article, li, section, div");
          const h = box && box.querySelector("figcaption, h1, h2, h3, h4, strong");
          t = h ? h.textContent.trim() : decodeURIComponent((img.src.split("/").pop() || "").split(/[?.#]/)[0]).replace(/[-_]+/g, " ");
        }
        img.alt = t || ""; n++;
      }
      return note("altText", n);
    },
    mainHeading(text) {
      if (document.querySelector("h1")) return note("mainHeading", 0);
      const h = document.querySelector("h2, header b, header strong, .logo");
      const h1 = document.createElement("h1");
      if (h && !text) {
        const s = getComputedStyle(h);
        h1.innerHTML = h.innerHTML; h1.className = h.className;
        Object.assign(h1.style, { fontSize: s.fontSize, fontWeight: s.fontWeight, margin: s.margin, color: s.color, lineHeight: s.lineHeight, fontFamily: s.fontFamily });
        h.replaceWith(h1);
      } else { h1.textContent = text || document.title; h1.style.cssText = "position:absolute;left:-9999px"; document.body.prepend(h1); }
      return note("mainHeading", 1);
    },
    fitToViewport() {
      css("img,video,iframe,svg,canvas{max-width:100%;height:auto} *{box-sizing:border-box} html,body{overflow-x:hidden}");
      const vw = document.documentElement.clientWidth; let n = 0;
      for (const el of document.querySelectorAll("body *")) {
        if (!visible(el)) continue;
        const r = el.getBoundingClientRect(), s = getComputedStyle(el);
        if (s.display === "grid" && /px/.test(s.gridTemplateColumns) && r.width > vw - 4) {
          el.style.gridTemplateColumns = "repeat(auto-fit, minmax(min(100%, 220px), 1fr))"; n++;
        }
        if (r.width > vw + 1 || r.right > vw + 1) {
          el.style.maxWidth = "100%"; el.style.width = "auto";
          if (s.display === "flex") el.style.flexWrap = "wrap";
          n++;
        }
      }
      return note("fitToViewport", n);
    },
    minFontSize(px = 14) {
      let n = 0;
      for (const el of document.querySelectorAll("body *")) {
        if (!visible(el) || ![...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim())) continue;
        if (parseFloat(getComputedStyle(el).fontSize) < px) { el.style.fontSize = px + "px"; n++; }
      }
      return note("minFontSize", n);
    },
    tapTargets(px = 44) {
      let n = 0;
      for (const el of document.querySelectorAll("a, button, input, select, textarea, [role=button]")) {
        if (!visible(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < px || r.height < px) {
          const s = getComputedStyle(el);
          if (s.display === "inline") el.style.display = "inline-flex";
          el.style.alignItems = "center"; el.style.justifyContent = "center";
          el.style.minHeight = px + "px"; el.style.minWidth = px + "px"; n++;
        }
      }
      return note("tapTargets", n);
    },
    contrast(min = 4.5) {
      let n = 0;
      for (const el of document.querySelectorAll("body *")) {
        if (!visible(el) || ![...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim())) continue;
        const fg = parse(getComputedStyle(el).color); if (!fg) continue;
        const bg = bgOf(el); if (ratio(fg, bg) >= min) continue;
        // try darkening and lightening the text, keep whichever reaches the target with the smallest change
        const walk = (toDark) => { let c = { ...fg }; for (let k = 0; k < 30 && ratio(c, bg) < min; k++) c = toDark ? { r: c.r * 0.85, g: c.g * 0.85, b: c.b * 0.85 } : { r: c.r + (255 - c.r) * 0.2, g: c.g + (255 - c.g) * 0.2, b: c.b + (255 - c.b) * 0.2 }; return c; };
        const options = [walk(true), walk(false)].filter((c) => ratio(c, bg) >= min);
        const c = options[0] || (ratio({ r: 0, g: 0, b: 0 }, bg) > ratio({ r: 255, g: 255, b: 255 }, bg) ? { r: 17, g: 17, b: 17 } : { r: 255, g: 255, b: 255 });
        el.style.color = `rgb(${c.r | 0}, ${c.g | 0}, ${c.b | 0})`; n++;
      }
      return note("contrast", n);
    },
  };
})();

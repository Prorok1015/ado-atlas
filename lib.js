// Pure, dependency-free helpers shared by api.js / app.js and exercised by
// tests/lib.test.js. No DOM, no chrome, no network — everything here is a
// deterministic function of its inputs. Loaded before api.js in index.html;
// in Node it exports via module.exports.
(function (root, factory) {
  const lib = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = lib;
  root.AdoLib = lib;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // ---- WIQL ----
  function wiqlQuote(v) { return String(v).replace(/'/g, "''"); }

  // Build WHERE clauses from a filter registry + a {key:{in:[],not:[]}} object.
  // Mirrors the chip UI. Tag-style fields (spec.contains) use CONTAINS instead
  // of IN; identity fields support the @me sentinel; numeric fields coerce.
  function buildClauses(filterFields, filters) {
    filters = filters || {};
    const clauses = [];
    for (const key of Object.keys(filterFields)) {
      const spec = filterFields[key];
      const f = filters[key] || {};
      const inc = f.in || [], exc = f.not || [];
      const { ref, identity, num, contains } = spec;
      const lit = v => {
        if (num) { const n = parseInt(v, 10); return Number.isFinite(n) ? String(n) : null; }
        return "'" + wiqlQuote(v) + "'";
      };
      if (contains) {
        if (inc.length) clauses.push("(" + inc.map(v => `[${ref}] CONTAINS '${wiqlQuote(v)}'`).join(" OR ") + ")");
        if (exc.length) clauses.push("(" + exc.map(v => `[${ref}] NOT CONTAINS '${wiqlQuote(v)}'`).join(" AND ") + ")");
        continue;
      }
      if (inc.length) {
        const parts = [];
        const names = inc.filter(v => !(identity && v === "me"));
        if (identity && inc.includes("me")) parts.push(`[${ref}] = @me`);
        const vals = names.map(lit).filter(x => x !== null);
        if (vals.length) parts.push(`[${ref}] IN (${vals.join(",")})`);
        if (parts.length) clauses.push("(" + parts.join(" OR ") + ")");
      }
      if (exc.length) {
        const parts = [];
        const names = exc.filter(v => !(identity && v === "me"));
        if (identity && exc.includes("me")) parts.push(`[${ref}] <> @me`);
        const vals = names.map(lit).filter(x => x !== null);
        if (vals.length) parts.push(`[${ref}] NOT IN (${vals.join(",")})`);
        if (parts.length) clauses.push("(" + parts.join(" AND ") + ")");
      }
    }
    return clauses;
  }

  // ---- markdown-lite <-> HTML ----
  function htmlEsc(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c])); }
  function htmlUnesc(s) {
    return String(s)
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, "\"").replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
  }
  function htmlToText(s) {
    if (!s) return "";
    let out = String(s)
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<li[^>]*>/gi, "- ")
      .replace(/<\/li>/gi, "\n")
      .replace(/<\/(p|div|ul|ol|tr|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, "");
    out = htmlUnesc(out);
    out = out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
    return out.trim();
  }
  function textToHtml(text) {
    if (text == null) return "";
    const lines = String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const stripped = lines[i].replace(/^\s+/, "");
      const bullet = stripped.slice(0, 2);
      if (bullet === "- " || bullet === "* ") {
        const items = [];
        while (i < lines.length) {
          const s = lines[i].replace(/^\s+/, "");
          if (s.slice(0, 2) !== "- " && s.slice(0, 2) !== "* ") break;
          items.push("<li>" + htmlEsc(s.slice(2)) + "</li>");
          i++;
        }
        out.push("<ul>" + items.join("") + "</ul>");
        continue;
      }
      if (lines[i].trim() === "") out.push("<br>");
      else out.push("<div>" + htmlEsc(lines[i]) + "</div>");
      i++;
    }
    return out.join("");
  }

  // ---- business-hours overlap ----
  // Seconds of [s,e] (Date objects) that fall inside Mon-Fri [ws,we] local hours,
  // after shifting both endpoints by `offset` hours (team-local window on UTC pair).
  function businessSeconds(s, e, offset, ws, we) {
    if (!s || !e || e <= s) return 0;
    ws = (ws == null ? 9 : ws); we = (we == null ? 17 : we);
    const ms = (offset || 0) * 3600 * 1000;
    const start = new Date(s.getTime() + ms);
    const end = new Date(e.getTime() + ms);
    let total = 0;
    let cur = new Date(start);
    while (cur < end) {
      const day0 = new Date(cur);
      day0.setUTCHours(0, 0, 0, 0);
      if (cur.getUTCDay() !== 0 && cur.getUTCDay() !== 6) {   // Mon-Fri (UTC after shift)
        const a = new Date(Math.max(cur.getTime(), day0.getTime() + ws * 3600 * 1000));
        const b = new Date(Math.min(end.getTime(), day0.getTime() + we * 3600 * 1000));
        if (b > a) total += (b - a) / 1000;
      }
      cur = new Date(day0.getTime() + 24 * 3600 * 1000);
    }
    return total;
  }

  // ---- PAT expiry countdown ----
  // Whole days from `nowMs` (default: now) until the "YYYY-MM-DD" expiry. null if unset/invalid.
  function patDaysLeft(expiry, nowMs) {
    if (!expiry) return null;
    const exp = Date.parse(expiry);
    if (!Number.isFinite(exp)) return null;
    const base = (nowMs == null ? Date.now() : nowMs);
    const today = Date.parse(new Date(base).toISOString().slice(0, 10));
    return Math.round((exp - today) / 86400000);
  }

  // ---- markdown-lite -> HTML (used for work-item Description preview) ----
  // Hardened: the inner escaper covers all five HTML-significant chars, and the
  // link rule requires an https?:// scheme with no whitespace, emitting
  // rel="noopener noreferrer". Non-matching links stay as escaped literal text.
  function mdToHtml(src) {
    const h = s => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
    const inl = t => h(t).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<i>$2</i>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    const ls = (src || "").replace(/\r\n/g, "\n").split("\n"); let out = "", ul = false, ol = false, code = false, buf = "";
    const close = () => { if (ul) { out += "</ul>"; ul = false; } if (ol) { out += "</ol>"; ol = false; } };
    for (const raw of ls) {
      if (/^```/.test(raw)) { if (code) { out += "<pre>" + h(buf) + "</pre>"; buf = ""; code = false; } else { close(); code = true; } continue; }
      if (code) { buf += raw + "\n"; continue; }
      let m = raw.match(/^(#{1,4})\s+(.*)/); if (m) { close(); const l = m[1].length + 2; out += `<h${l}>${inl(m[2])}</h${l}>`; continue; }
      m = raw.match(/^\s*[-*]\s+(.*)/); if (m) { if (!ul) { close(); out += "<ul>"; ul = true; } out += "<li>" + inl(m[1]) + "</li>"; continue; }
      m = raw.match(/^\s*\d+\.\s+(.*)/); if (m) { if (!ol) { close(); out += "<ol>"; ol = true; } out += "<li>" + inl(m[1]) + "</li>"; continue; }
      if (!raw.trim()) { close(); continue; }
      close(); out += "<p>" + inl(raw) + "</p>";
    }
    if (code) out += "<pre>" + h(buf) + "</pre>"; close(); return out;
  }

  return { wiqlQuote, buildClauses, htmlEsc, htmlUnesc, htmlToText, textToHtml, businessSeconds, patDaysLeft, mdToHtml };
});

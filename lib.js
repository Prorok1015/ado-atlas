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
  //
  // opts:
  //   workItemBase  - if set, "#123" gets auto-linked to `<base>/123` (ADO edit URL)
  //   allowImages   - default true; `![alt](https://...)` becomes <img>
  function mdToHtml(src, opts) {
    opts = opts || {};
    const base = (opts.workItemBase || "").replace(/\/+$/, "");
    const allowImg = opts.allowImages !== false;
    const h = s => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
    // Inline pass: order matters — pull images out BEFORE links so ![]() isn't
    // mistaken for a literal "!" followed by [link](...), and pull @-mentions
    // and #123 BEFORE the regular link rule for the same reason.
    const MENTION_RE = /@\[([^\]\n]{1,80})\]\(([A-Za-z0-9._\-+=]{1,200})\)/g;
    const IMG_RE     = /!\[([^\]\n]{0,200})\]\((https:\/\/[^)\s"<>]+)\)/g;
    const LINK_RE    = /\[([^\]]+)\]\((https?:\/\/[^)\s"<>]+)\)/g;
    const WID_RE     = /(^|[\s(,;:.])#(\d{1,8})\b/g;
    function inl(t) {
      let out = h(t)
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
        .replace(/__([^_]+)__/g, "<b>$1</b>")
        .replace(/~~([^~]+)~~/g, "<s>$1</s>")
        .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<i>$2</i>");
      if (allowImg) out = out.replace(IMG_RE, (m, alt, url) => `<img alt="${alt}" src="${url}" style="max-width:100%">`);
      // @[Name](descriptor) - ADO mention anchor. href stays "#"; the descriptor
      // goes into data-vss-mention exactly so the saved HTML triggers a real
      // notification when round-tripped back.
      out = out.replace(MENTION_RE, (m, name, desc) =>
        `<a href="#" data-vss-mention="version:2.0,${desc}" class="vss-mention-link">@${name}</a>`);
      out = out.replace(LINK_RE, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
      if (base) out = autolinkWidOutsideTags(out, base);
      return out;
    }
    // Replace "#NNN" with an anchor ONLY in plain text segments — never inside an
    // existing <a>...</a> (avoids double-linking a #-id that's already a link)
    // or inside <img alt="...">. Walks the string between tags.
    function autolinkWidOutsideTags(s, b) {
      const parts = s.split(/(<a\b[^>]*>[\s\S]*?<\/a>|<[^>]+>)/);
      for (let i = 0; i < parts.length; i += 2) {
        parts[i] = parts[i].replace(WID_RE, (m, pre, id) =>
          `${pre}<a href="${b}/${id}" target="_blank" rel="noopener noreferrer">#${id}</a>`);
      }
      return parts.join("");
    }
    const ls = (src || "").replace(/\r\n/g, "\n").split("\n"); let out = "", ul = false, ol = false, bq = false, code = false, buf = "";
    const close = () => { if (ul) { out += "</ul>"; ul = false; } if (ol) { out += "</ol>"; ol = false; } if (bq) { out += "</blockquote>"; bq = false; } };
    for (const raw of ls) {
      if (/^```/.test(raw)) { if (code) { out += "<pre>" + h(buf) + "</pre>"; buf = ""; code = false; } else { close(); code = true; } continue; }
      if (code) { buf += raw + "\n"; continue; }
      if (/^\s*([-*_])\1\1+\s*$/.test(raw)) { close(); out += "<hr>"; continue; }   // --- / *** / ___
      let m = raw.match(/^(#{1,6})\s+(.*)/); if (m) { close(); const l = Math.min(6, m[1].length + 2); out += `<h${l}>${inl(m[2])}</h${l}>`; continue; }
      m = raw.match(/^\s*>\s?(.*)/); if (m) { if (!bq) { close(); out += "<blockquote>"; bq = true; } else out += "<br>"; out += inl(m[1]); continue; }
      m = raw.match(/^\s*[-*]\s+(.*)/); if (m) { if (!ul) { close(); out += "<ul>"; ul = true; } out += "<li>" + inl(m[1]) + "</li>"; continue; }
      m = raw.match(/^\s*\d+\.\s+(.*)/); if (m) { if (!ol) { close(); out += "<ol>"; ol = true; } out += "<li>" + inl(m[1]) + "</li>"; continue; }
      if (!raw.trim()) { close(); continue; }
      close(); out += "<p>" + inl(raw) + "</p>";
    }
    if (code) out += "<pre>" + h(buf) + "</pre>"; close(); return out;
  }

  // ---- HTML -> markdown-lite (the reverse, so an ADO description round-trips
  // through the editor without losing bold/italic/strike/code/links/headings/
  // lists/blockquotes). Used to populate the Description/AC fields on load. ----
  function inlineHtmlToMd(s) {
    return String(s)
      .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (m, _t, c) => "**" + c.replace(/<[^>]+>/g, "") + "**")
      .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (m, _t, c) => "*" + c.replace(/<[^>]+>/g, "") + "*")
      .replace(/<(s|strike|del)\b[^>]*>([\s\S]*?)<\/\1>/gi, (m, _t, c) => "~~" + c.replace(/<[^>]+>/g, "") + "~~")
      .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (m, c) => "`" + c.replace(/<[^>]+>/g, "") + "`")
      // Anchors. Three special cases handled BEFORE the generic [text](url):
      //   - ADO mention (data-vss-mention="version:2.0,<descriptor>")  → @[Name](descriptor)
      //   - work-item edit URL ending in /_workitems/edit/<id>          → #<id>
      //   - plain anchor                                                → [text](url)
      .replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (m, attrs, inner) => {
        const text = inner.replace(/<[^>]+>/g, "").trim();
        const dm = attrs.match(/\bdata-vss-mention\s*=\s*"version:2\.0,([A-Za-z0-9._\-+=]+)"/i);
        if (dm) return "@[" + text.replace(/^@/, "") + "](" + dm[1] + ")";
        const hrefM = attrs.match(/\bhref\s*=\s*"([^"]*)"/i);
        const href = hrefM ? hrefM[1] : "";
        const widM = href.match(/\/_workitems\/edit\/(\d{1,8})(?:[/?#]|$)/);
        if (widM && (text === "#" + widM[1] || text === widM[1])) return "#" + widM[1];
        return href ? "[" + (text || href) + "](" + href + ")" : text;
      })
      // <img src="..." alt="..."> → ![alt](src). Order of attributes varies, so
      // capture them independently and reassemble.
      .replace(/<img\b([^>]*)\/?>/gi, (m, attrs) => {
        const srcM = attrs.match(/\bsrc\s*=\s*"([^"]*)"/i);
        const altM = attrs.match(/\balt\s*=\s*"([^"]*)"/i);
        const src = srcM ? srcM[1] : "";
        const alt = altM ? altM[1] : "";
        return src ? "![" + alt + "](" + src + ")" : "";
      });
  }
  function htmlToMarkdown(s) {
    if (!s) return "";
    let t = String(s).replace(/\r\n/g, "\n");
    t = t.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (m, c) => "\n```\n" + htmlUnesc(c.replace(/<[^>]+>/g, "")).replace(/\n+$/, "") + "\n```\n");
    t = t.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (m, n, c) => "\n" + "#".repeat(Math.max(1, (+n) - 2)) + " " + inlineHtmlToMd(c).replace(/<[^>]+>/g, "").trim() + "\n");
    t = t.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (m, c) => "\n" + htmlToMarkdown(c).split("\n").map(l => (l ? "> " + l : ">")).join("\n") + "\n");
    t = t.replace(/<ol\b[^>]*>([\s\S]*?)<\/ol>/gi, (m, c) => { let i = 0; return "\n" + c.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (mm, li) => (++i) + ". " + inlineHtmlToMd(li).replace(/<[^>]+>/g, "").trim() + "\n"); });
    t = t.replace(/<ul\b[^>]*>([\s\S]*?)<\/ul>/gi, (m, c) => "\n" + c.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (mm, li) => "- " + inlineHtmlToMd(li).replace(/<[^>]+>/g, "").trim() + "\n"));
    t = t.replace(/<hr\s*\/?>/gi, "\n---\n");
    t = t.replace(/<br\s*\/?>/gi, "\n");
    t = inlineHtmlToMd(t);
    t = t.replace(/<\/(p|div|tr)>/gi, "\n").replace(/<(p|div)\b[^>]*>/gi, "");
    t = t.replace(/<[^>]+>/g, "");                       // strip any remaining tags
    t = htmlUnesc(t);
    t = t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
    return t.trim();
  }

  // ---- OAuth (Microsoft Entra ID) URL/encoding helpers ----
  // Pure pieces of the PKCE flow; the crypto + chrome.identity bits live in api.js.

  // base64url (no padding) of a byte array (Uint8Array or number[]).
  function base64UrlEncode(bytes) {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    const b64 = (typeof btoa !== "undefined") ? btoa(bin) : Buffer.from(bin, "binary").toString("base64");
    return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  // Microsoft v2.0 authorize URL for the auth-code + PKCE flow.
  function oauthAuthorizeUrl({ tenant, clientId, redirectUri, scope, challenge, state }) {
    const p = new URLSearchParams({
      client_id: clientId, response_type: "code", redirect_uri: redirectUri,
      response_mode: "query", scope, code_challenge: challenge, code_challenge_method: "S256", state,
    });
    return `https://login.microsoftonline.com/${encodeURIComponent(tenant || "organizations")}/oauth2/v2.0/authorize?` + p.toString();
  }

  // x-www-form-urlencoded body for the token / refresh request (skips null/undefined).
  function oauthTokenBody(params) {
    const p = new URLSearchParams();
    for (const k of Object.keys(params)) if (params[k] != null) p.append(k, params[k]);
    return p.toString();
  }

  // Extract {code,state,error,error_description} from the redirect URL.
  function parseRedirectParams(redirectUrl) {
    try {
      const q = new URL(redirectUrl).searchParams;
      return { code: q.get("code"), state: q.get("state"), error: q.get("error"), error_description: q.get("error_description") };
    } catch (_) { return {}; }
  }

  return { wiqlQuote, buildClauses, htmlEsc, htmlUnesc, htmlToText, textToHtml, htmlToMarkdown, businessSeconds, patDaysLeft, mdToHtml,
           base64UrlEncode, oauthAuthorizeUrl, oauthTokenBody, parseRedirectParams };
});

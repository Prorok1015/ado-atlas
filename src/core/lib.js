// Pure, dependency-free helpers shared by api.js / app.js and exercised by
// tests/lib.test.js. No DOM, no chrome, no network — everything here is a
// deterministic function of its inputs. Loaded before api.js in index.html;
// in Node it exports via module.exports.
(function (root, factory) {
  const lib = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = lib;
  root.AdoLib = lib;
  root.timeExprToMath = lib.timeExprToMath;
  root.evaluateMath = lib.evaluateMath;
  root.formatMessage = lib.formatMessage;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // ---- i18n ----
  // Interpolate {placeholder} tokens in a localized template. Pure and
  // deterministic so it lives here (no DOM/chrome) and is unit-tested. Missing
  // params leave their token untouched so gaps are visible rather than silent.
  function formatMessage(template, params) {
    if (!template) return "";
    if (!params) return template;
    return String(template).replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
  }

  // ---- WIQL ----
  function wiqlQuote(v) { return String(v).replace(/'/g, "''"); }

  function splitQuotedList(str) {
    const parts = [];
    let current = "";
    let inDouble = false;
    let inSingle = false;
    for (let i = 0; i < str.length; i++) {
      const char = str[i];
      if (char === '"' && !inSingle) {
        inDouble = !inDouble;
        current += char;
      } else if (char === "'" && !inDouble) {
        inSingle = !inSingle;
        current += char;
      } else if (char === ',' && !inDouble && !inSingle) {
        parts.push(current);
        current = "";
      } else {
        current += char;
      }
    }
    parts.push(current);

    return parts.map(x => {
      let s = x.trim();
      if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
        s = s.slice(1, -1);
      }
      return s.trim();
    }).filter(Boolean);
  }

  function parseOperatorValue(v) {
    if (v == null) return { op: "=", value: "" };
    const s = String(v).trim();
    if (s.startsWith(">=")) return { op: ">=", value: s.slice(2).trim() };
    if (s.startsWith("<=")) return { op: "<=", value: s.slice(2).trim() };
    if (s.startsWith("<>")) return { op: "<>", value: s.slice(2).trim() };
    if (s.startsWith(">")) return { op: ">", value: s.slice(1).trim() };
    if (s.startsWith("<")) return { op: "<", value: s.slice(1).trim() };
    if (s.startsWith("=")) return { op: "=", value: s.slice(1).trim() };

    const notContainsMatch = s.match(/^not contains\s+(.*)/i);
    if (notContainsMatch) return { op: "NOT CONTAINS", value: notContainsMatch[1].trim() };

    const containsMatch = s.match(/^contains\s+(.*)/i);
    if (containsMatch) return { op: "CONTAINS", value: containsMatch[1].trim() };

    const notUnderMatch = s.match(/^not under\s+(.*)/i);
    if (notUnderMatch) return { op: "NOT UNDER", value: notUnderMatch[1].trim() };

    const underMatch = s.match(/^under\s+(.*)/i);
    if (underMatch) return { op: "UNDER", value: underMatch[1].trim() };

    const notInMatch = s.match(/^not in\s+(.*)/i);
    if (notInMatch) {
      let val = notInMatch[1].trim();
      if (val.startsWith("(") && val.endsWith(")")) {
        val = val.slice(1, -1).trim();
      }
      const parts = splitQuotedList(val);
      return { op: "NOT IN", value: parts };
    }

    const inMatch = s.match(/^in\s+(.*)/i);
    if (inMatch) {
      let val = inMatch[1].trim();
      if (val.startsWith("(") && val.endsWith(")")) {
        val = val.slice(1, -1).trim();
      }
      const parts = splitQuotedList(val);
      return { op: "IN", value: parts };
    }

    return { op: "=", value: s };
  }

  // of IN; identity fields support the @me sentinel; numeric fields coerce.
  function buildClauses(filterFields, filters) {
    let FC;
    if (typeof window !== 'undefined' && window.FilterCompiler) {
      FC = window.FilterCompiler;
    } else if (typeof globalThis !== 'undefined' && globalThis.FilterCompiler) {
      FC = globalThis.FilterCompiler;
    } else if (typeof module !== 'undefined' && module.exports && typeof require === 'function') {
      FC = require('./filter-compiler.js');
    }
    if (!FC) throw new Error("FilterCompiler is not loaded");
    return FC.compile(filters, filterFields);
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

  // ---- Syntax Highlighting ----
  const highlightRegistry = {
    json: [
      { token: "hl-key", regex: /"(?:[^"\\]|\\.)*"\s*(?=:)/g },
      { token: "hl-string", regex: /"(?:[^"\\]|\\.)*"/g },
      { token: "hl-num", regex: /\b-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g }
    ],
    javascript: [
      { token: "hl-comment", regex: /\/\/.*|\/\*[\s\S]*?\*\//g },
      { token: "hl-string", regex: /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g },
      { token: "hl-keyword", regex: /\b(const|let|var|function|class|import|export|return|if|else|for|while|do|switch|case|break|continue|new|typeof|instanceof|try|catch|finally|throw|async|await|yield|default|extends|super|this)\b/g },
      { token: "hl-num", regex: /\b\d+(?:\.\d+)?\b/g }
    ],
    html: [
      { token: "hl-comment", regex: /<!--[\s\S]*?-->/g },
      { token: "hl-string", regex: /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g },
      { token: "hl-keyword", regex: /(?<=<\/?)[a-zA-Z0-9:-]+/g }
    ],
    css: [
      { token: "hl-comment", regex: /\/\*[\s\S]*?\*\//g },
      { token: "hl-string", regex: /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|url\([^)]*\)/g },
      { token: "hl-keyword", regex: /\b(color|background|margin|padding|border|display|position|top|left|right|bottom|width|height|font|flex|grid|opacity|z-index|box-shadow|text-align|float|clear|overflow|visibility|clip-path|transform|transition|animation|media|keyframes|import)\b|!important|\b[a-zA-Z-]+\b(?=\s*:)/g },
      { token: "hl-num", regex: /\b-?\d+(?:\.\d+)?(?:px|em|rem|%|s|ms|deg)?\b/g }
    ]
  };

  const langAliases = {
    js: "javascript",
    ts: "javascript",
    xml: "html"
  };

  function highlightCode(code, lang) {
    const h = s => s.replace(/&(?!(?:[a-zA-Z0-9]+|#[0-9]+|#x[0-9a-fA-F]+);)|[<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
    if (lang) {
      lang = lang.toLowerCase();
      if (langAliases[lang]) {
        lang = langAliases[lang];
      }
    }
    
    if (lang === "json") {
      try {
        const parsed = JSON.parse(code);
        code = JSON.stringify(parsed, null, 2);
      } catch (e) {
        // use code as-is
      }
    }

    const rules = highlightRegistry[lang];
    if (!rules) {
      return h(code);
    }

    const matches = [];
    for (const rule of rules) {
      rule.regex.lastIndex = 0;
      let match;
      while ((match = rule.regex.exec(code)) !== null) {
        if (match[0].length === 0) {
          rule.regex.lastIndex++;
          continue;
        }
        matches.push({
          start: match.index,
          end: rule.regex.lastIndex,
          token: rule.token,
          content: match[0]
        });
      }
    }

    matches.sort((a, b) => {
      if (a.start !== b.start) {
        return a.start - b.start;
      }
      return (b.end - b.start) - (a.end - a.start);
    });

    const accepted = [];
    let lastEnd = 0;
    for (const m of matches) {
      if (m.start >= lastEnd) {
        accepted.push(m);
        lastEnd = m.end;
      }
    }

    let out = "";
    let idx = 0;
    for (const m of accepted) {
      if (m.start > idx) {
        out += h(code.slice(idx, m.start));
      }
      out += `<span class="${m.token}">${h(m.content)}</span>`;
      idx = m.end;
    }
    if (idx < code.length) {
      out += h(code.slice(idx));
    }
    return out;
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
    const h = s => s.replace(/&(?!(?:[a-zA-Z0-9]+|#[0-9]+|#x[0-9a-fA-F]+);)|[<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
    // Inline pass: order matters — pull images out BEFORE links so ![]() isn't
    // mistaken for a literal "!" followed by [link](...), and pull @-mentions
    // and #123 BEFORE the regular link rule for the same reason.
    const MENTION_RE = /@\[([^\]\n]{1,80})\]\(([a-f0-9-]{36})\)/gi;
    const IMG_RE     = /!\[([^\]\n]{0,200})\]\(((?:https:\/\/|\/|\?|File\?)[^)\s"<>]+)\)/gi;
    const LINK_RE    = /\[([^\]]+)\]\((https?:\/\/[^)\s"<>]+)\)/g;
    const WID_RE     = /(^|[\s(,;:.])#(\d{1,8})\b/g;
    function inl(t) {
      let out = h(t)
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
        .replace(/__([^_]+)__/g, "<b>$1</b>")
        .replace(/~~([^~]+)~~/g, "<s>$1</s>")
        .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<i>$2</i>");
      if (allowImg) {
        out = out.replace(IMG_RE, (m, alt, url) => {
          if (!url.startsWith("http")) {
            if (base && url.includes("fileName=")) {
              const projUrl = base.replace(/\/_workitems\/edit\/\d+\/?$/, "");
              const match = url.match(/(?:uid|attachmentId)=([^&]+)/i);
              if (match) {
                url = projUrl + "/_apis/wit/attachments/" + match[1] + "?fileName=" + encodeURIComponent(alt || "image.png");
              } else {
                url = projUrl + (url.startsWith("/") ? "" : "/") + url;
              }
            } else {
              return `![${alt}](${url})`;
            }
          }
          return `<img alt="${alt}" src="${url}" style="max-width:100%">`;
        });
      }
      // @[Name](descriptor) - ADO mention anchor. href stays "#"; the descriptor
      // goes into data-vss-mention exactly so the saved HTML triggers a real
      // notification when round-tripped back.
      out = out.replace(MENTION_RE, (m, name, guid) =>
      `<a href="#" data-vss-mention="version:2.0,${guid}">@${name}</a>`);
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
    const ls = (src || "").replace(/\r\n/g, "\n").split("\n"); let out = "", ul = false, ol = false, bq = false, code = false, buf = "", codeLang = null;
    const close = () => { if (ul) { out += "</ul>"; ul = false; } if (ol) { out += "</ol>"; ol = false; } if (bq) { out += "</blockquote>"; bq = false; } };
    
    const isTableRow = (line) => line && line.trim().startsWith('|') && line.trim().endsWith('|');
    const isDelimiterRow = (line) => {
      if (!line) return false;
      const trimmed = line.trim();
      return trimmed.startsWith('|') && trimmed.endsWith('|') && /^[|:\s-]+$/.test(trimmed);
    };

    for (let i = 0; i < ls.length; i++) {
      const raw = ls[i];
      const mCode = raw.match(/^```(.*)/);
      if (mCode) {
        if (code) {
          let detectedLang = codeLang;
          if (!detectedLang) {
            const trimmedBuf = buf.trim();
            if (trimmedBuf) {
              try {
                JSON.parse(trimmedBuf);
                detectedLang = "json";
              } catch (e) {
                if (trimmedBuf.startsWith("<")) {
                  detectedLang = "html";
                } else if (/\b(const|let|var|function|class|import|export|return|async|await)\b/.test(trimmedBuf) || ["const ", "let ", "function ", "class ", "import "].some(kw => trimmedBuf.includes(kw))) {
                  detectedLang = "javascript";
                } else if (trimmedBuf.includes("{") && trimmedBuf.includes("}") && /[\w.-]+\s*\{/.test(trimmedBuf)) {
                  detectedLang = "css";
                }
              }
            }
          }
          
          out += `<pre data-lang="${detectedLang || ''}">` + highlightCode(buf, detectedLang) + "</pre>";
          buf = "";
          code = false;
          codeLang = null;
        } else {
          close();
          code = true;
          codeLang = mCode[1].trim() || null;
        }
        continue;
      }
      if (code) { buf += raw + "\n"; continue; }

      // Parse Markdown Tables
      if (isTableRow(raw) && isDelimiterRow(ls[i + 1])) {
        close();
        const headerCols = raw.split('|').slice(1, -1).map(c => c.trim());
        const alignments = ls[i + 1].split('|').slice(1, -1).map(c => {
          const t = c.trim();
          const left = t.startsWith(':');
          const right = t.endsWith(':');
          if (left && right) return 'center';
          if (right) return 'right';
          if (left) return 'left';
          return '';
        });
        i++; // skip delimiter row
        const rows = [];
        while (i + 1 < ls.length && isTableRow(ls[i + 1])) {
          i++;
          rows.push(ls[i].split('|').slice(1, -1).map(c => c.trim()));
        }
        
        let tableHtml = '<table style="border-collapse:collapse;width:100%;margin:16px 0;"><thead><tr>';
        headerCols.forEach((col, idx) => {
          const align = alignments[idx] ? `text-align:${alignments[idx]};` : '';
          tableHtml += `<th style="border:1px solid var(--line,#333);padding:8px 12px;background:var(--panel2,#1e1e1e);font-weight:600;${align}">${inl(col)}</th>`;
        });
        tableHtml += '</tr></thead><tbody>';
        rows.forEach(row => {
          tableHtml += '<tr>';
          for (let idx = 0; idx < headerCols.length; idx++) {
            const cell = row[idx] || '';
            const align = alignments[idx] ? `text-align:${alignments[idx]};` : '';
            tableHtml += `<td style="border:1px solid var(--line,#333);padding:8px 12px;${align}">${inl(cell)}</td>`;
          }
          tableHtml += '</tr>';
        });
        tableHtml += '</tbody></table>';
        out += tableHtml;
        continue;
      }

      if (/^\s*([-*_])\1\1+\s*$/.test(raw)) { close(); out += "<hr>"; continue; }   // --- / *** / ___
      let m = raw.match(/^(#{1,6})\s+(.*)/); if (m) { close(); const l = Math.min(6, m[1].length + 2); out += `<h${l}>${inl(m[2])}</h${l}>`; continue; }
      m = raw.match(/^\s*>\s?(.*)/); if (m) { if (!bq) { close(); out += "<blockquote>"; bq = true; } else out += "<br>"; out += inl(m[1]); continue; }
      m = raw.match(/^\s*[-*]\s+(.*)/); if (m) {
        if (!ul) { close(); out += "<ul>"; ul = true; }
        let content = m[1];
        let taskPrefix = "";
        if (content.startsWith("[ ] ")) {
          taskPrefix = '<input type="checkbox" disabled style="margin-right:6px;">';
          content = content.slice(4);
        } else if (content.startsWith("[x] ") || content.startsWith("[X] ")) {
          taskPrefix = '<input type="checkbox" checked disabled style="margin-right:6px;">';
          content = content.slice(4);
        }
        out += "<li>" + taskPrefix + inl(content) + "</li>";
        continue;
      }
      m = raw.match(/^\s*\d+\.\s+(.*)/); if (m) { if (!ol) { close(); out += "<ol>"; ol = true; } out += "<li>" + inl(m[1]) + "</li>"; continue; }
      if (!raw.trim()) { if (bq) out += "<br>"; continue; }
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
        const dm = attrs.match(/\bdata-vss-mention\s*=\s*"version:2\.0,([a-f0-9-]+)"/i);
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
        const srcM = attrs.match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
        const altM = attrs.match(/\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
        const src = srcM ? (srcM[1] || srcM[2] || srcM[3] || "") : "";
        const alt = altM ? (altM[1] || altM[2] || altM[3] || "") : "";
        return src ? "![" + alt + "](" + src + ")" : "";
      });
  }
  function htmlToMarkdown(s) {
    if (!s) return "";
    let t = String(s).replace(/\r\n/g, "\n");
    // Strip ACK control characters that ADO injects as sentinels in comment renderedText
    t = t.replace(/\u0006/g, "");
    t = t.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (m, c) => "\n```\n" + htmlUnesc(c.replace(/<[^>]+>/g, "")).replace(/\n+$/, "") + "\n```\n");
    t = t.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (m, n, c) => "\n" + "#".repeat(Math.max(1, (+n) - 2)) + " " + inlineHtmlToMd(c).replace(/<[^>]+>/g, "").trim() + "\n");
    t = t.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (m, tableContent) => {
      let headerCols = [];
      const theadMatch = tableContent.match(/<thead\b[^>]*>([\s\S]*?)<\/thead>/i);
      const headerSource = theadMatch ? theadMatch[1] : tableContent;
      const trHeadMatch = headerSource.match(/<tr\b[^>]*>([\s\S]*?)<\/tr>/i);
      
      if (trHeadMatch) {
        const thRegex = /<th\b[^>]*>([\s\S]*?)<\/th>/gi;
        let thMatch;
        while ((thMatch = thRegex.exec(trHeadMatch[1])) !== null) {
          headerCols.push(inlineHtmlToMd(thMatch[1]).replace(/<[^>]+>/g, "").trim());
        }
      }
      
      if (headerCols.length === 0) {
        const trFirstMatch = tableContent.match(/<tr\b[^>]*>([\s\S]*?)<\/tr>/i);
        if (trFirstMatch) {
          const tdRegex = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
          let tdMatch;
          while ((tdMatch = tdRegex.exec(trFirstMatch[1])) !== null) {
            headerCols.push(inlineHtmlToMd(tdMatch[1]).replace(/<[^>]+>/g, "").trim());
          }
        }
      }
      
      if (headerCols.length === 0) return "";
      
      let dataRows = [];
      const tbodyMatch = tableContent.match(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i);
      const bodySource = tbodyMatch ? tbodyMatch[1] : tableContent;
      
      let trSource = bodySource;
      if (!theadMatch && tableContent.includes("</td>")) {
        trSource = bodySource.replace(/<tr\b[^>]*>[\s\S]*?<\/tr>/i, "");
      }
      
      const trRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
      let trMatch;
      while ((trMatch = trRegex.exec(trSource)) !== null) {
        let cols = [];
        const tdRegex = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
        let tdMatch;
        while ((tdMatch = tdRegex.exec(trMatch[1])) !== null) {
          cols.push(inlineHtmlToMd(tdMatch[1]).replace(/<[^>]+>/g, "").trim());
        }
        if (cols.length > 0) {
          dataRows.push(cols);
        }
      }
      
      let mdTable = "\n| " + headerCols.join(" | ") + " |\n";
      mdTable += "| " + headerCols.map(() => "---").join(" | ") + " |\n";
      dataRows.forEach(row => {
        const paddedRow = [];
        for (let i = 0; i < headerCols.length; i++) {
          paddedRow.push(row[i] || "");
        }
        mdTable += "| " + paddedRow.join(" | ") + " |\n";
      });
      return mdTable + "\n";
    });

    t = t.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (m, c) => "\n" + htmlToMarkdown(c).split("\n").map(l => (l ? "> " + l : ">")).join("\n") + "\n");
    t = t.replace(/<ol\b[^>]*>([\s\S]*?)<\/ol>/gi, (m, c) => { let i = 0; return "\n" + c.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (mm, li) => (++i) + ". " + inlineHtmlToMd(li).replace(/<[^>]+>/g, "").trim() + "\n"); });
    t = t.replace(/<ul\b[^>]*>([\s\S]*?)<\/ul>/gi, (m, c) => "\n" + c.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (mm, li) => {
      let text = inlineHtmlToMd(li).replace(/<[^>]+>/g, "").trim();
      const hasChecked = /<input[^>]*checkbox[^>]*checked/i.test(li);
      const hasUnchecked = /<input[^>]*checkbox/i.test(li);
      if (hasChecked) return "- [x] " + text + "\n";
      if (hasUnchecked) return "- [ ] " + text + "\n";
      return "- " + text + "\n";
    }));
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

  function timeExprToMath(str, workHours) {
    const weekHours = workHours * 5;
    let res = str.toLowerCase();
    res = res.replace(/(\d+(?:\.\d+)?)\s*w/g, '($1 * ' + weekHours + ')');
    res = res.replace(/(\d+(?:\.\d+)?)\s*d/g, '($1 * ' + workHours + ')');
    res = res.replace(/(\d+(?:\.\d+)?)\s*h/g, '($1 * 1)');
    // Support space-separated adjacent terms like "1d 4h" -> "(1 * 8) + (4 * 1)"
    res = res.replace(/\)\s*\(/g, ') + (');
    return res;
  }

  function evaluateMath(str) {
    let pos = 0;
    let hasError = false;
    
    function consume(char) {
      if (str[pos] === char) {
        pos++;
        return true;
      }
      return false;
    }
    
    function skipWhitespace() {
      while (pos < str.length && /\s/.test(str[pos])) {
        pos++;
      }
    }
    
    function parseExpression() {
      let val = parseTerm();
      skipWhitespace();
      while (pos < str.length) {
        if (consume('+')) {
          val += parseTerm();
        } else if (consume('-')) {
          val -= parseTerm();
        } else {
          break;
        }
        skipWhitespace();
      }
      return val;
    }
    
    function parseTerm() {
      let val = parseFactor();
      skipWhitespace();
      while (pos < str.length) {
        if (consume('*')) {
          val *= parseFactor();
        } else if (consume('/')) {
          const den = parseFactor();
          if (den === 0) {
            hasError = true;
            val = 0;
          } else {
            val /= den;
          }
        } else {
          break;
        }
        skipWhitespace();
      }
      return val;
    }
    
    function parseFactor() {
      skipWhitespace();
      if (consume('(')) {
        const val = parseExpression();
        skipWhitespace();
        if (!consume(')')) {
          hasError = true;
        }
        return val;
      }
      
      let start = pos;
      if (str[pos] === '-' || str[pos] === '+') {
        pos++;
      }
      while (pos < str.length && (/[0-9.]/.test(str[pos]))) {
        pos++;
      }
      if (start === pos) {
        hasError = true;
        pos++; // Avoid infinite loop
        return NaN;
      }
      const numStr = str.substring(start, pos);
      const val = parseFloat(numStr);
      if (isNaN(val)) {
        hasError = true;
        return NaN;
      }
      return val;
    }
    
    const result = parseExpression();
    if (hasError || isNaN(result) || pos < str.length) {
      return NaN;
    }
    return result;
  }

  // ---- Global / composite work-item ids (BACKEND_PROVIDER_SPEC §13.1) ----
  // A global id is "<providerId>:<nativeId>" (e.g. "ado:123", "jira:PROJ-45") so ids from
  // different providers never collide. The app treats an item id as an OPAQUE STRING; only
  // the owning provider parses its native id out (at the REST boundary). These helpers are
  // the single source of truth for that encoding. Tolerant on decode: a bare native id
  // (no ':') passes through unchanged, so user-typed "123" and legacy URLs still work.
  function gidMake(provider, native) { return String(provider) + ':' + String(native); }
  function gidNative(gid) { const s = String(gid); const i = s.indexOf(':'); return i >= 0 ? s.slice(i + 1) : s; }
  function gidProvider(gid) { const s = String(gid); const i = s.indexOf(':'); return i >= 0 ? s.slice(0, i) : null; }

  return { formatMessage, wiqlQuote, buildClauses, parseOperatorValue, htmlEsc, htmlUnesc, htmlToText, textToHtml, htmlToMarkdown, businessSeconds, patDaysLeft, mdToHtml, highlightCode,
           highlightRegistry, langAliases,
           base64UrlEncode, oauthAuthorizeUrl, oauthTokenBody, parseRedirectParams, timeExprToMath, evaluateMath,
           gidMake, gidNative, gidProvider };
});

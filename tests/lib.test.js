// Unit tests for the pure helpers in lib.js. No deps — run with: npm test
// (or: node tests/lib.test.js). Exits non-zero if anything fails.
const assert = require("node:assert");
const lib = require("../src/core/lib.js");
const FilterManager = require("../src/components/filter-manager.js");

let pass = 0, fail = 0;
// Queued and awaited sequentially at the bottom. Calling fn() directly would silently
// break any async test: "ok" prints before the assertions run. No async tests today —
// this keeps the first one that gets added from lying.
const queued = [];
function test(name, fn) { queued.push({ name, fn }); }
process.on("unhandledRejection", (e) => {
  console.error("UNHANDLED REJECTION\n       " + (e && e.stack || e));
  process.exit(1);
});
const utc = (...a) => new Date(Date.UTC(...a));

// ---- formatMessage (i18n interpolation) ----
test("formatMessage: substitutes a single placeholder", () => {
  assert.strictEqual(lib.formatMessage("{count} items followed", { count: 3 }), "3 items followed");
});
test("formatMessage: substitutes multiple placeholders", () => {
  assert.strictEqual(lib.formatMessage("{a} of {b}", { a: 2, b: 5 }), "2 of 5");
});
test("formatMessage: leaves unknown placeholder token untouched", () => {
  assert.strictEqual(lib.formatMessage("hi {name}", { other: "x" }), "hi {name}");
});
test("formatMessage: no params returns template verbatim", () => {
  assert.strictEqual(lib.formatMessage("plain {x}"), "plain {x}");
});
test("formatMessage: empty/missing template returns empty string", () => {
  assert.strictEqual(lib.formatMessage("", { x: 1 }), "");
  assert.strictEqual(lib.formatMessage(undefined, { x: 1 }), "");
  assert.strictEqual(lib.formatMessage(null), "");
});
test("formatMessage: coerces non-string param values", () => {
  assert.strictEqual(lib.formatMessage("{v}", { v: 0 }), "0");
  assert.strictEqual(lib.formatMessage("{v}", { v: false }), "false");
});

// ---- wiqlQuote ----
test("wiqlQuote doubles single quotes", () => {
  assert.strictEqual(lib.wiqlQuote("O'Brien"), "O''Brien");
  assert.strictEqual(lib.wiqlQuote("plain"), "plain");
});

// ---- buildClauses ----
const FF = {
  state:    { ref: "System.State" },
  priority: { ref: "Microsoft.VSTS.Common.Priority", num: true },
  assigned: { ref: "System.AssignedTo", identity: true },
  tags:     { ref: "System.Tags", contains: true },
  createddate: { ref: "System.CreatedDate", type: "dateTime" }
};
test("buildClauses: FilterIR empty / no group -> no clauses", () => {
  assert.deepStrictEqual(lib.buildClauses(FF, {}), []);
});

test("buildClauses: FilterIR compiles @today-30 macro on date fields", () => {
  const ir = {
    where: {
      kind: "group",
      logic: "AND",
      rules: [
        { kind: "condition", field: "createddate", op: ">", value: "@today-30" }
      ]
    }
  };
  assert.deepStrictEqual(lib.buildClauses(FF, ir), ["[System.CreatedDate] > @today-30"]);
});

test("buildClauses: FilterIR compiles RANGE operator on date macros", () => {
  const ir = {
    where: {
      kind: "group",
      logic: "AND",
      rules: [
        { kind: "condition", field: "createddate", op: "RANGE", value: "@today-90...@today" }
      ]
    }
  };
  assert.deepStrictEqual(lib.buildClauses(FF, ir), ["([System.CreatedDate] >= @today-90 AND [System.CreatedDate] <= @today)"]);
});

test("buildClauses: FilterIR ignores conditions with empty values", () => {
  const ir = {
    where: {
      kind: "group",
      logic: "AND",
      rules: [
        { kind: "condition", field: "state", op: "=", value: "" },
        { kind: "condition", field: "priority", op: "IN", value: [] },
        { kind: "condition", field: "assigned", op: "=", value: null },
        { kind: "condition", field: "tags", op: "CONTAINS", value: undefined }
      ]
    }
  };
  assert.deepStrictEqual(lib.buildClauses(FF, ir), []);
});

test("buildClauses: FilterIR generates '' for @empty in dates/identity and doesn't drop them", () => {
  const ir = {
    where: {
      kind: "group",
      logic: "AND",
      rules: [
        { kind: "condition", field: "state", op: "=", value: "@empty" },
        { kind: "condition", field: "assigned", op: "<>", value: "@empty" }
      ]
    }
  };
  assert.deepStrictEqual(lib.buildClauses(FF, ir), [
    "([System.State] = '' AND [System.AssignedTo] <> '')"
  ]);
});

test("buildClauses: FilterIR generates correct WIQL for @empty and @me together", () => {
  const ir = {
    where: {
      kind: "group",
      logic: "AND",
      rules: [
        { kind: "condition", field: "assigned", op: "IN", value: ["@empty", "@me"] }
      ]
    }
  };
  assert.deepStrictEqual(lib.buildClauses(FF, ir), [
    "([System.AssignedTo] = @me OR [System.AssignedTo] IN (''))"
  ]);
});

test("buildClauses: FilterIR generates correct WIQL for numeric field with @empty and value together", () => {
  const ir = {
    where: {
      kind: "group",
      logic: "AND",
      rules: [
        { kind: "condition", field: "priority", op: "IN", value: ["@empty", "2"] }
      ]
    }
  };
  assert.deepStrictEqual(lib.buildClauses(FF, ir), [
    "([Microsoft.VSTS.Common.Priority] = '' OR [Microsoft.VSTS.Common.Priority] IN (2))"
  ]);
});

test("buildClauses: FilterIR generates correct WIQL for numeric field with NOT IN and @empty", () => {
  const ir = {
    where: {
      kind: "group",
      logic: "AND",
      rules: [
        { kind: "condition", field: "priority", op: "NOT IN", value: ["@empty", "2"] }
      ]
    }
  };
  assert.deepStrictEqual(lib.buildClauses(FF, ir), [
    "([Microsoft.VSTS.Common.Priority] <> '' AND [Microsoft.VSTS.Common.Priority] NOT IN (2))"
  ]);
});

test("buildClauses: FilterIR simple condition with =", () => {
  const ir = {
    where: {
      kind: "group",
      logic: "AND",
      rules: [
        { kind: "condition", field: "state", op: "=", value: "Active" }
      ]
    }
  };
  assert.deepStrictEqual(lib.buildClauses(FF, ir), ["[System.State] = 'Active'"]);
});

test("buildClauses: FilterIR simple condition with <>", () => {
  const ir = {
    where: {
      kind: "group",
      logic: "AND",
      rules: [
        { kind: "condition", field: "state", op: "<>", value: "Closed" }
      ]
    }
  };
  assert.deepStrictEqual(lib.buildClauses(FF, ir), ["[System.State] <> 'Closed'"]);
});

test("buildClauses: FilterIR IN include", () => {
  const ir = {
    where: {
      kind: "group",
      logic: "AND",
      rules: [
        { kind: "condition", field: "state", op: "IN", value: ["Active", "New"] }
      ]
    }
  };
  assert.deepStrictEqual(lib.buildClauses(FF, ir), ["[System.State] IN ('Active','New')"]);
});

test("buildClauses: FilterIR NOT IN exclude", () => {
  const ir = {
    where: {
      kind: "group",
      logic: "AND",
      rules: [
        { kind: "condition", field: "state", op: "NOT IN", value: ["Closed"] }
      ]
    }
  };
  assert.deepStrictEqual(lib.buildClauses(FF, ir), ["[System.State] NOT IN ('Closed')"]);
});

test("buildClauses: FilterIR numeric field is not quoted", () => {
  const ir = {
    where: {
      kind: "group",
      logic: "AND",
      rules: [
        { kind: "condition", field: "priority", op: "IN", value: ["1", "2"] }
      ]
    }
  };
  assert.deepStrictEqual(lib.buildClauses(FF, ir), ["[Microsoft.VSTS.Common.Priority] IN (1,2)"]);
});

test("buildClauses: FilterIR identity @me + named", () => {
  const ir = {
    where: {
      kind: "group",
      logic: "AND",
      rules: [
        { kind: "condition", field: "assigned", op: "IN", value: ["me", "Bob"] }
      ]
    }
  };
  assert.deepStrictEqual(lib.buildClauses(FF, ir), ["([System.AssignedTo] = @me OR [System.AssignedTo] IN ('Bob'))"]);
});

test("buildClauses: FilterIR tags use CONTAINS / NOT CONTAINS", () => {
  const ir = {
    where: {
      kind: "group",
      logic: "AND",
      rules: [
        { kind: "condition", field: "tags", op: "CONTAINS", value: ["ux"] },
        { kind: "condition", field: "tags", op: "NOT CONTAINS", value: ["wip"] }
      ]
    }
  };
  assert.deepStrictEqual(lib.buildClauses(FF, ir), ["([System.Tags] CONTAINS 'ux' AND NOT [System.Tags] CONTAINS 'wip')"]);
});

test("buildClauses: FilterIR UNDER / NOT UNDER", () => {
  const ir = {
    where: {
      kind: "group",
      logic: "AND",
      rules: [
        { kind: "condition", field: "state", op: "UNDER", value: "Area/Path" },
        { kind: "condition", field: "state", op: "NOT UNDER", value: "Area/Path2" }
      ]
    }
  };
  assert.deepStrictEqual(lib.buildClauses(FF, ir), [
    "(([System.State] = 'Area/Path' OR [System.State] UNDER 'Area/Path') AND ([System.State] <> 'Area/Path2' AND [System.State] NOT UNDER 'Area/Path2'))"
  ]);
});

test("buildClauses: FilterIR UNDER / NOT UNDER with arrays", () => {
  const ir = {
    where: {
      kind: "group",
      logic: "AND",
      rules: [
        { kind: "condition", field: "state", op: "UNDER", value: ["Area/Path", "Area/Path2"] },
        { kind: "condition", field: "state", op: "NOT UNDER", value: ["Area/Path3", "Area/Path4"] }
      ]
    }
  };
  assert.deepStrictEqual(lib.buildClauses(FF, ir), [
    "((([System.State] = 'Area/Path' OR [System.State] UNDER 'Area/Path') OR ([System.State] = 'Area/Path2' OR [System.State] UNDER 'Area/Path2')) AND (([System.State] <> 'Area/Path3' AND [System.State] NOT UNDER 'Area/Path3') AND ([System.State] <> 'Area/Path4' AND [System.State] NOT UNDER 'Area/Path4')))"
  ]);
});

test("buildClauses: FilterIR multi-group OR / AND logic", () => {
  const ir = {
    where: {
      kind: "group",
      logic: "OR",
      rules: [
        {
          kind: "group",
          logic: "AND",
          rules: [
            { kind: "condition", field: "state", op: "=", value: "Active" },
            { kind: "condition", field: "priority", op: "IN", value: ["1", "2"] }
          ]
        },
        {
          kind: "group",
          logic: "AND",
          rules: [
            { kind: "condition", field: "state", op: "=", value: "Closed" },
            { kind: "condition", field: "assigned", op: "=", value: "@me" }
          ]
        }
      ]
    }
  };
  assert.deepStrictEqual(lib.buildClauses(FF, ir), [
    "(([System.State] = 'Active' AND [Microsoft.VSTS.Common.Priority] IN (1,2)) OR ([System.State] = 'Closed' AND [System.AssignedTo] = @me))"
  ]);
});

test("buildClauses: FilterIR operators >, <, >=, <=", () => {
  const ir = {
    where: {
      kind: "group",
      logic: "AND",
      rules: [
        { kind: "condition", field: "priority", op: ">", value: "1" },
        { kind: "condition", field: "priority", op: "<", value: "5" },
        { kind: "condition", field: "priority", op: ">=", value: "2" },
        { kind: "condition", field: "priority", op: "<=", value: "4" }
      ]
    }
  };
  assert.deepStrictEqual(lib.buildClauses(FF, ir), ["([Microsoft.VSTS.Common.Priority] > 1 OR [Microsoft.VSTS.Common.Priority] < 5 OR [Microsoft.VSTS.Common.Priority] >= 2 OR [Microsoft.VSTS.Common.Priority] <= 4)"]);
});

test("buildClauses: FilterIR values are WIQL-escaped", () => {
  const ir = {
    where: {
      kind: "group",
      logic: "AND",
      rules: [
        { kind: "condition", field: "state", op: "IN", value: ["O'Brien"] }
      ]
    }
  };
  assert.deepStrictEqual(lib.buildClauses(FF, ir), ["[System.State] IN ('O''Brien')"]);
});

// ---- html <-> text ----
test("htmlToText: divs become newlines", () => {
  assert.strictEqual(lib.htmlToText("<div>Hello</div><div>World</div>"), "Hello\nWorld");
});
test("htmlToText: list items get dashes", () => {
  assert.strictEqual(lib.htmlToText("<ul><li>a</li><li>b</li></ul>"), "- a\n- b");
});
test("htmlToText: entities are unescaped", () => {
  assert.strictEqual(lib.htmlToText("<div>a &amp; b &lt;c&gt;</div>"), "a & b <c>");
});
test("textToHtml: lines become divs", () => {
  assert.strictEqual(lib.textToHtml("a\nb"), "<div>a</div><div>b</div>");
});
test("textToHtml: bullet lines become a ul", () => {
  assert.strictEqual(lib.textToHtml("- x\n- y"), "<ul><li>x</li><li>y</li></ul>");
});
test("textToHtml: escapes html in content", () => {
  assert.strictEqual(lib.textToHtml("a <b> & c"), "<div>a &lt;b&gt; &amp; c</div>");
});

// ---- businessSeconds (Mon-Fri, ws..we local hours) ----
test("businessSeconds: full weekday window = 8h", () => {
  // Wed 2024-01-03 09:00 -> 17:00 UTC, offset 0, 9..17
  assert.strictEqual(lib.businessSeconds(utc(2024, 0, 3, 9), utc(2024, 0, 3, 17), 0, 9, 17), 8 * 3600);
});
test("businessSeconds: clips to window start", () => {
  // 08:00 -> 10:00 counts only 09:00..10:00 = 1h
  assert.strictEqual(lib.businessSeconds(utc(2024, 0, 3, 8), utc(2024, 0, 3, 10), 0, 9, 17), 3600);
});
test("businessSeconds: weekend = 0", () => {
  // Sat 2024-01-06 all day
  assert.strictEqual(lib.businessSeconds(utc(2024, 0, 6, 0), utc(2024, 0, 6, 23), 0, 9, 17), 0);
});
test("businessSeconds: spans two weekdays", () => {
  // Wed 16:00 -> Thu 10:00 = 1h (Wed) + 1h (Thu) = 2h
  assert.strictEqual(lib.businessSeconds(utc(2024, 0, 3, 16), utc(2024, 0, 4, 10), 0, 9, 17), 2 * 3600);
});
test("businessSeconds: reversed/zero interval = 0", () => {
  assert.strictEqual(lib.businessSeconds(utc(2024, 0, 3, 17), utc(2024, 0, 3, 9), 0, 9, 17), 0);
});

// ---- patDaysLeft (deterministic via nowMs) ----
const now = Date.parse("2024-01-01T12:00:00Z");
test("patDaysLeft: future date", () => {
  assert.strictEqual(lib.patDaysLeft("2024-01-10", now), 9);
});
test("patDaysLeft: expired date is negative", () => {
  assert.strictEqual(lib.patDaysLeft("2023-12-30", now), -2);
});
test("patDaysLeft: empty/invalid -> null", () => {
  assert.strictEqual(lib.patDaysLeft("", now), null);
  assert.strictEqual(lib.patDaysLeft("not-a-date", now), null);
});

// ---- mdToHtml (markdown-lite -> safe HTML) ----
test("mdToHtml: valid http link -> safe anchor", () => {
  assert.ok(lib.mdToHtml("[x](https://ok.com)").includes('<a href="https://ok.com" target="_blank" rel="noopener noreferrer">x</a>'));
});
test("mdToHtml: javascript: link is not an anchor", () => {
  assert.ok(!lib.mdToHtml("[x](javascript:alert(1))").includes("<a"));
});
test("mdToHtml: href quote-breakout cannot inject an attribute", () => {
  const out = lib.mdToHtml('[x](https://a" onmouseover="alert(1)');
  assert.ok(!/<a[^>]*\sonmouseover=/.test(out));
});
test("mdToHtml: bold renders", () => {
  assert.ok(lib.mdToHtml("**bold**").includes("<b>bold</b>"));
});
test("mdToHtml: dash line becomes a list", () => {
  assert.ok(lib.mdToHtml("- a").includes("<ul><li>a</li></ul>"));
});
test("mdToHtml: angle-bracket injection is escaped", () => {
  const out = lib.mdToHtml("<img src=x onerror=alert(1)>");
  assert.ok(out.includes("&lt;img"));
  assert.ok(!out.includes("<img"));
});
test("mdToHtml: HTML entities are preserved while raw ampersands are escaped", () => {
  assert.strictEqual(lib.mdToHtml("a & b"), "<p>a &amp; b</p>");
  assert.strictEqual(lib.mdToHtml("&#128225;"), "<p>&#128225;</p>");
  assert.strictEqual(lib.mdToHtml("&#x1F4E1;"), "<p>&#x1F4E1;</p>");
  assert.strictEqual(lib.mdToHtml("&nbsp;"), "<p>&nbsp;</p>");
  assert.strictEqual(lib.mdToHtml("a &copy b"), "<p>a &amp;copy b</p>");
});
test("mdToHtml: tables render correctly", () => {
  const md = "| H1 | H2 |\n|---|---:|\n| val1 | **val2** |";
  const html = lib.mdToHtml(md);
  assert.ok(html.includes("<table"));
  assert.ok(html.includes(">H1</th>"));
  assert.ok(html.includes("<b>val2</b>"));
});
test("htmlToMarkdown: tables parse back to markdown", () => {
  const html = '<table style="border-collapse:collapse;"><thead><tr><th>H1</th><th>H2</th></tr></thead><tbody><tr><td>val1</td><td>val2</td></tr></tbody></table>';
  const md = lib.htmlToMarkdown(html);
  assert.strictEqual(md, "| H1 | H2 |\n| --- | --- |\n| val1 | val2 |");
});
test("mdToHtml: task lists render correctly", () => {
  assert.ok(lib.mdToHtml("- [ ] Task 1").includes('<li><input type="checkbox" disabled style="margin-right:6px;">Task 1</li>'));
  assert.ok(lib.mdToHtml("- [x] Task 2").includes('<li><input type="checkbox" checked disabled style="margin-right:6px;">Task 2</li>'));
});
test("htmlToMarkdown: task lists parse back to markdown", () => {
  const html = '<ul><li><input type="checkbox" disabled> Task 1</li><li><input type="checkbox" checked disabled> Task 2</li></ul>';
  const md = lib.htmlToMarkdown(html);
  assert.strictEqual(md, "- [ ] Task 1\n- [x] Task 2");
});
test("mdToHtml: strikethrough + underscore-bold + hr + blockquote", () => {
  assert.ok(lib.mdToHtml("~~gone~~").includes("<s>gone</s>"));
  assert.ok(lib.mdToHtml("__bold__").includes("<b>bold</b>"));
  assert.ok(lib.mdToHtml("---").includes("<hr>"));
  assert.ok(lib.mdToHtml("> quote").includes("<blockquote>quote</blockquote>"));
});
test("mdToHtml: ordered list", () => {
  assert.ok(lib.mdToHtml("1. a\n2. b").includes("<ol><li>a</li><li>b</li></ol>"));
});

// ---- htmlToMarkdown (the reverse, for round-tripping descriptions) ----
test("htmlToMarkdown: inline formatting + link", () => {
  assert.strictEqual(lib.htmlToMarkdown("<b>x</b> <i>y</i> <s>z</s> <code>c</code>"), "**x** *y* ~~z~~ `c`");
  assert.strictEqual(lib.htmlToMarkdown('<a href="https://a.com">t</a>'), "[t](https://a.com)");
});
test("htmlToMarkdown: headings and lists", () => {
  assert.strictEqual(lib.htmlToMarkdown("<h3>Title</h3>"), "# Title");
  assert.strictEqual(lib.htmlToMarkdown("<ul><li>a</li><li>b</li></ul>"), "- a\n- b");
  assert.strictEqual(lib.htmlToMarkdown("<ol><li>a</li><li>b</li></ol>"), "1. a\n2. b");
});
test("htmlToMarkdown: entities unescaped, tags stripped", () => {
  assert.strictEqual(lib.htmlToMarkdown("<div>a &amp; b</div>"), "a & b");
});
test("md round-trip: html -> markdown -> html keeps formatting", () => {
  const html = lib.mdToHtml(lib.htmlToMarkdown("<b>bold</b> and <a href=\"https://x.io\">link</a>"));
  assert.ok(html.includes("<b>bold</b>"));
  assert.ok(html.includes('<a href="https://x.io"'));
});

// ---- new: images, @mentions, #123 autolinks ----
test("mdToHtml: ![alt](https://...) -> <img>", () => {
  const out = lib.mdToHtml("![pic](https://ok.com/a.png)");
  assert.ok(out.includes('<img alt="pic" src="https://ok.com/a.png"'));
});
test("mdToHtml: ![](http://) (non-https) is NOT an image", () => {
  const out = lib.mdToHtml("![x](http://insecure/a.png)");
  assert.ok(!out.includes("<img"));
});
test("mdToHtml: @[Name](descriptor) -> mention anchor with data-vss-mention", () => {
  const out = lib.mdToHtml("@[Jane Doe](e401e150-a645-7c8e-b903-3994dbead567)");
  assert.ok(out.includes('data-vss-mention="version:2.0,e401e150-a645-7c8e-b903-3994dbead567"'));
  assert.ok(out.includes(">@Jane Doe</a>"));
});
test("mdToHtml: mention descriptor with bad chars is NOT a mention", () => {
  const out = lib.mdToHtml("@[X](<script>)");
  assert.ok(!out.includes("data-vss-mention"));
});
test("mdToHtml: #123 autolinks when workItemBase is set", () => {
  const out = lib.mdToHtml("see #42 for context", { workItemBase: "https://dev.azure.com/o/p/_workitems/edit" });
  assert.ok(out.includes('<a href="https://dev.azure.com/o/p/_workitems/edit/42"'));
  assert.ok(out.includes(">#42</a>"));
});
test("mdToHtml: #123 stays plain when no workItemBase", () => {
  const out = lib.mdToHtml("see #42 for context");
  assert.ok(!/<a[^>]*>#42<\/a>/.test(out));
});
test("mdToHtml: #123 inside an existing link is NOT re-linked", () => {
  const out = lib.mdToHtml("[the #42 ticket](https://x.com/42)", { workItemBase: "https://b" });
  // exactly one anchor (the original); no nested anchor for #42
  const anchors = out.match(/<a\b/g) || [];
  assert.strictEqual(anchors.length, 1);
});
test("htmlToMarkdown: <img> -> ![alt](src)", () => {
  assert.strictEqual(lib.htmlToMarkdown('<img src="https://x/a.png" alt="pic">'), "![pic](https://x/a.png)");
});
test("htmlToMarkdown: <img> with unquoted attributes", () => {
  assert.strictEqual(lib.htmlToMarkdown('<img src=https://x/a.png alt=pic>'), "![pic](https://x/a.png)");
  assert.strictEqual(lib.htmlToMarkdown('<img src=https://x/a.png alt="pic with spaces">'), "![pic with spaces](https://x/a.png)");
});
test("htmlToMarkdown: strips ACK (\\u0006) control characters from ADO comment HTML", () => {
  assert.strictEqual(lib.htmlToMarkdown("\u0006hello\u0006"), "hello");
  assert.strictEqual(lib.htmlToMarkdown("<b>\u0006bold\u0006</b>"), "**bold**");
  assert.strictEqual(lib.htmlToMarkdown("<div>\u0006a</div><div>\u0006b</div>"), "a\nb");
});
test("htmlToMarkdown: mention anchor -> @[Name](descriptor)", () => {
  const md = lib.htmlToMarkdown('<a href="#" data-vss-mention="version:2.0,e401e150-a645-7c8e-b903-3994dbead567">@Jane Doe</a>');
  assert.strictEqual(md, "@[Jane Doe](e401e150-a645-7c8e-b903-3994dbead567)");
});
test("htmlToMarkdown: work-item edit URL -> #N shorthand", () => {
  const md = lib.htmlToMarkdown('<a href="https://dev.azure.com/o/p/_workitems/edit/42">#42</a>');
  assert.strictEqual(md, "#42");
});
test("round-trip: image + mention + #ref survive md -> html -> md", () => {
  const src = "see #42, ![pic](https://x/a.png), cc @[Jane](e401e150-a645-7c8e-b903-3994dbead567)";
  const back = lib.htmlToMarkdown(lib.mdToHtml(src, { workItemBase: "https://dev.azure.com/o/p/_workitems/edit" }));
  assert.ok(back.includes("#42"));
  assert.ok(back.includes("![pic](https://x/a.png)"));
  assert.ok(back.includes("@[Jane](e401e150-a645-7c8e-b903-3994dbead567)"));
});

// ---- OAuth helpers ----
test("base64UrlEncode: url-safe, no padding", () => {
  // bytes [251,255] -> base64 "+/8=" -> base64url "-_8"
  assert.strictEqual(lib.base64UrlEncode([251, 255]), "-_8");
  assert.strictEqual(lib.base64UrlEncode([0]), "AA");
});
test("oauthAuthorizeUrl: contains the PKCE params", () => {
  const u = lib.oauthAuthorizeUrl({ tenant: "organizations", clientId: "cid", redirectUri: "https://x.chromiumapp.org/", scope: "s1 s2", challenge: "chal", state: "st" });
  assert.ok(u.startsWith("https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?"));
  assert.ok(u.includes("client_id=cid"));
  assert.ok(u.includes("code_challenge=chal"));
  assert.ok(u.includes("code_challenge_method=S256"));
  assert.ok(u.includes("response_type=code"));
  assert.ok(u.includes("scope=s1+s2"));
});
test("oauthTokenBody: form-encodes and skips null", () => {
  const b = lib.oauthTokenBody({ grant_type: "authorization_code", code: "a b", client_secret: null });
  assert.ok(b.includes("grant_type=authorization_code"));
  assert.ok(b.includes("code=a+b"));
  assert.ok(!b.includes("client_secret"));
});
test("parseRedirectParams: extracts code/state/error", () => {
  assert.deepStrictEqual(lib.parseRedirectParams("https://x.chromiumapp.org/?code=AAA&state=BBB"),
    { code: "AAA", state: "BBB", error: null, error_description: null });
  const e = lib.parseRedirectParams("https://x.chromiumapp.org/?error=access_denied&error_description=nope");
  assert.strictEqual(e.error, "access_denied");
  assert.strictEqual(e.code, null);
});

// ---- new: parseOperatorValue ----
test("parseOperatorValue extracts operators correctly", () => {
  assert.deepStrictEqual(lib.parseOperatorValue("> 5"), { op: ">", value: "5" });
  assert.deepStrictEqual(lib.parseOperatorValue(">= 10"), { op: ">=", value: "10" });
  assert.deepStrictEqual(lib.parseOperatorValue("<> 0"), { op: "<>", value: "0" });
  assert.deepStrictEqual(lib.parseOperatorValue("under Area/Path"), { op: "UNDER", value: "Area/Path" });
  assert.deepStrictEqual(lib.parseOperatorValue("not under Area/Path"), { op: "NOT UNDER", value: "Area/Path" });
  assert.deepStrictEqual(lib.parseOperatorValue("contains bug"), { op: "CONTAINS", value: "bug" });
  assert.deepStrictEqual(lib.parseOperatorValue("not contains bug"), { op: "NOT CONTAINS", value: "bug" });
  assert.deepStrictEqual(lib.parseOperatorValue("in (Active, New)"), { op: "IN", value: ["Active", "New"] });
  assert.deepStrictEqual(lib.parseOperatorValue("in Active, New"), { op: "IN", value: ["Active", "New"] });
  assert.deepStrictEqual(lib.parseOperatorValue("in Active"), { op: "IN", value: ["Active"] });
  assert.deepStrictEqual(lib.parseOperatorValue("not in (Closed, Cut)"), { op: "NOT IN", value: ["Closed", "Cut"] });
  assert.deepStrictEqual(lib.parseOperatorValue('in ("Area, Group A", "Tag 2")'), { op: "IN", value: ["Area, Group A", "Tag 2"] });
  assert.deepStrictEqual(lib.parseOperatorValue("in ('Area, Group A', 'Tag 2')"), { op: "IN", value: ["Area, Group A", "Tag 2"] });
  assert.deepStrictEqual(lib.parseOperatorValue('not in ("Area, Group A", "Tag 2")'), { op: "NOT IN", value: ["Area, Group A", "Tag 2"] });
  assert.deepStrictEqual(lib.parseOperatorValue('in "Area, Group A", Tag 2'), { op: "IN", value: ["Area, Group A", "Tag 2"] });
  assert.deepStrictEqual(lib.parseOperatorValue("simple value"), { op: "=", value: "simple value" });
});

// ---- new: buildClauses with FilterIR ----
test("buildClauses: FilterIR simple group", () => {
  const ir = {
    where: {
      kind: "group",
      logic: "AND",
      rules: [
        { kind: "condition", field: "state", op: "IN", value: ["Active", "New"] }
      ]
    }
  };
  assert.deepStrictEqual(lib.buildClauses(FF, ir), ["[System.State] IN ('Active','New')"]);
});

test("buildClauses: FilterIR complex DNF (A AND B) OR (C AND D)", () => {
  const ir = {
    where: {
      kind: "group",
      logic: "OR",
      rules: [
        {
          kind: "group",
          logic: "AND",
          rules: [
            { kind: "condition", field: "state", op: "=", value: "Active" },
            { kind: "condition", field: "priority", op: "=", value: "1" }
          ]
        },
        {
          kind: "group",
          logic: "AND",
          rules: [
            { kind: "condition", field: "state", op: "=", value: "New" },
            { kind: "condition", field: "priority", op: "=", value: "2" }
          ]
        }
      ]
    }
  };
  assert.deepStrictEqual(lib.buildClauses(FF, ir), [
    "(([System.State] = 'Active' AND [Microsoft.VSTS.Common.Priority] = 1) OR ([System.State] = 'New' AND [Microsoft.VSTS.Common.Priority] = 2))"
  ]);
});

test("buildClauses: Comprehensive validation of IN / NOT IN across all field types and argument counts", () => {
  const customFF = {
    state:    { ref: "System.State", type: "string" },
    priority: { ref: "Microsoft.VSTS.Common.Priority", num: true, type: "integer" },
    assigned: { ref: "System.AssignedTo", identity: true, type: "identity" },
    iteration:{ ref: "System.IterationPath", type: "treePath" },
    created:  { ref: "System.CreatedDate", type: "dateTime" },
    tags:     { ref: "System.Tags", type: "tags" }
  };

  const compileSingle = (field, op, value) => {
    const ir = {
      where: {
        kind: "group",
        logic: "AND",
        rules: [{ kind: "condition", field, op, value }]
      }
    };
    const res = lib.buildClauses(customFF, ir);
    return res[0] || "";
  };

  // 1. Native types (string, integer, identity)
  assert.strictEqual(compileSingle("state", "IN", ["Active"]), "[System.State] IN ('Active')");
  assert.strictEqual(compileSingle("priority", "IN", ["1", "2"]), "[Microsoft.VSTS.Common.Priority] IN (1,2)");
  assert.strictEqual(compileSingle("assigned", "NOT IN", ["Alex", "Bob", "Charlie"]), "[System.AssignedTo] NOT IN ('Alex','Bob','Charlie')");

  // 2. TreePath fields (1 and 2 arguments)
  assert.strictEqual(compileSingle("iteration", "IN", ["Sprint 1"]), "[System.IterationPath] = 'Sprint 1'");
  assert.strictEqual(compileSingle("iteration", "IN", ["Sprint 2", "Sprint 3"]), "([System.IterationPath] = 'Sprint 2' OR [System.IterationPath] = 'Sprint 3')");
  assert.strictEqual(compileSingle("iteration", "NOT IN", ["Sprint 4", "Sprint 5"]), "([System.IterationPath] <> 'Sprint 4' AND [System.IterationPath] <> 'Sprint 5')");

  // 3. Date fields (1 and 2 arguments)
  assert.strictEqual(compileSingle("created", "IN", ["2026-06-25"]), "[System.CreatedDate] = '2026-06-25'");
  assert.strictEqual(compileSingle("created", "IN", ["2026-06-26", "2026-06-27"]), "([System.CreatedDate] = '2026-06-26' OR [System.CreatedDate] = '2026-06-27')");
  assert.strictEqual(compileSingle("created", "NOT IN", ["2026-06-28", "2026-06-29"]), "([System.CreatedDate] <> '2026-06-28' AND [System.CreatedDate] <> '2026-06-29')");

  // 4. Tags fields (1 and 2 arguments)
  assert.strictEqual(compileSingle("tags", "IN", ["ux"]), "[System.Tags] CONTAINS 'ux'");
  assert.strictEqual(compileSingle("tags", "IN", ["bug", "wip"]), "([System.Tags] CONTAINS 'bug' OR [System.Tags] CONTAINS 'wip')");
  assert.strictEqual(compileSingle("tags", "NOT IN", ["done"]), "NOT [System.Tags] CONTAINS 'done'");
  assert.strictEqual(compileSingle("tags", "NOT IN", ["blocked", "hold"]), "(NOT [System.Tags] CONTAINS 'blocked' AND NOT [System.Tags] CONTAINS 'hold')");

  // 5. Case-insensitivity and reference-name lookup tests
  assert.strictEqual(compileSingle("System.IterationPath", "IN", ["Sprint 1", "Sprint 2"]), "([System.IterationPath] = 'Sprint 1' OR [System.IterationPath] = 'Sprint 2')");
  assert.strictEqual(compileSingle("SYSTEM.STATE", "IN", ["Active"]), "[System.State] IN ('Active')");
});

// ---- FilterManager ----
test("FilterManager: initial state and clear", () => {
  const fm = new FilterManager();
  const ir = fm.getIR();
  assert.strictEqual(ir.where.kind, "group");
  assert.strictEqual(ir.where.logic, "OR");
  assert.strictEqual(ir.where.rules.length, 1);
  assert.strictEqual(ir.where.rules[0].kind, "group");
  assert.strictEqual(ir.where.rules[0].logic, "AND");
  assert.strictEqual(ir.where.rules[0].rules.length, 0);

  fm.setIR({
    where: {
      kind: "group",
      logic: "OR",
      rules: [
        {
          kind: "group",
          logic: "AND",
          rules: [
            { kind: "condition", field: "state", op: "=", value: "Active" }
          ]
        }
      ]
    }
  });
  assert.strictEqual(fm.getIR().where.rules.length, 1);
  fm.clear();
  assert.strictEqual(fm.getIR().where.rules[0].rules.length, 0);
});

test("FilterManager: toggleChip and getChipState for normal field", () => {
  const fm = new FilterManager();
  
  // Initially null
  assert.strictEqual(fm.getChipState("state", "Active"), null);
  
  // Toggle 'in'
  fm.toggleChip("state", "Active", "in");
  assert.strictEqual(fm.getChipState("state", "Active"), "in");
  let ir = fm.getIR();
  let cond = ir.where.rules[0].rules[0];
  assert.deepStrictEqual(cond, { kind: "condition", field: "state", op: "=", value: "Active" });

  // Toggle 'in' again (removes it)
  fm.toggleChip("state", "Active", "in");
  assert.strictEqual(fm.getChipState("state", "Active"), null);
  assert.strictEqual(fm.getIR().where.rules[0].rules.length, 0);

  // Toggle 'out'
  fm.toggleChip("state", "Active", "out");
  assert.strictEqual(fm.getChipState("state", "Active"), "out");
  ir = fm.getIR();
  cond = ir.where.rules[0].rules[0];
  assert.deepStrictEqual(cond, { kind: "condition", field: "state", op: "<>", value: "Active" });

  // Toggle 'in' while 'out' (switches to 'in')
  fm.toggleChip("state", "Active", "in");
  assert.strictEqual(fm.getChipState("state", "Active"), "in");
  assert.strictEqual(fm.getChipState("state", "New"), null);

  // Add another 'in' value to same field -> compiles to IN
  fm.toggleChip("state", "New", "in");
  assert.strictEqual(fm.getChipState("state", "Active"), "in");
  assert.strictEqual(fm.getChipState("state", "New"), "in");
  ir = fm.getIR();
  assert.strictEqual(ir.where.rules[0].rules.length, 1);
  assert.deepStrictEqual(ir.where.rules[0].rules[0], {
    kind: "condition",
    field: "state",
    op: "IN",
    value: ["Active", "New"]
  });

  // Explicit removeChip
  fm.removeChip("state", "Active");
  assert.strictEqual(fm.getChipState("state", "Active"), null);
  assert.strictEqual(fm.getChipState("state", "New"), "in");
  ir = fm.getIR();
  assert.deepStrictEqual(ir.where.rules[0].rules[0], {
    kind: "condition",
    field: "state",
    op: "=",
    value: "New"
  });
});

test("FilterManager: toggleChip and getChipState for tag field", () => {
  // Mock fieldRegistry
  const fm = new FilterManager({
    fieldRegistry: {
      tags: { ref: "System.Tags", type: "tags" }
    }
  });

  fm.toggleChip("tags", "ux", "in");
  assert.strictEqual(fm.getChipState("tags", "ux"), "in");
  let ir = fm.getIR();
  assert.deepStrictEqual(ir.where.rules[0].rules[0], {
    kind: "condition",
    field: "tags",
    op: "CONTAINS",
    value: ["ux"]
  });

  fm.toggleChip("tags", "wip", "out");
  assert.strictEqual(fm.getChipState("tags", "wip"), "out");
  ir = fm.getIR();
  assert.strictEqual(ir.where.rules[0].rules.length, 2);
  assert.deepStrictEqual(ir.where.rules[0].rules.find(r => r.op === "NOT CONTAINS"), {
    kind: "condition",
    field: "tags",
    op: "NOT CONTAINS",
    value: ["wip"]
  });
});

test("FilterManager: load / save / migrate", () => {
  // FilterManager now persists through App.prefs (not localStorage directly). Drive
  // the real prefs singleton — in node it uses its in-memory cache (no chrome), and
  // filters/filterIR/filtersAdvanced are not mirrorLS so localStorage is never touched.
  const prefs = require("../src/app/prefs.js");
  globalThis.App = { prefs };

  const fm = new FilterManager();

  // 1. Save and Load
  fm.toggleChip("state", "Active", "in");
  fm.save();
  assert.ok(prefs.get("filterIR"));

  const fm2 = new FilterManager();
  fm2.load();
  assert.strictEqual(fm2.getChipState("state", "Active"), "in");

  // 2. Migrate from filtersAdvanced
  prefs.remove("filterIR");
  prefs.set("filtersAdvanced", JSON.stringify({
    where: {
      kind: "group",
      logic: "OR",
      rules: [
        {
          kind: "group",
          logic: "AND",
          rules: [{ kind: "condition", field: "state", op: "=", value: "Closed" }]
        }
      ]
    }
  }));

  const fm3 = new FilterManager();
  fm3.load();
  assert.strictEqual(fm3.getChipState("state", "Closed"), "in");
  assert.ok(!prefs.get("filtersAdvanced"));
  assert.ok(prefs.get("filterIR"));

  // 3. Migrate from flat filters (filters)
  prefs.remove("filterIR");
  prefs.set("filters", JSON.stringify({
    state: { in: ["Active", "New"], not: ["Closed"] }
  }));

  const fm4 = new FilterManager();
  fm4.load();
  assert.strictEqual(fm4.getChipState("state", "Active"), "in");
  assert.strictEqual(fm4.getChipState("state", "New"), "in");
  assert.strictEqual(fm4.getChipState("state", "Closed"), "out");
  assert.ok(!prefs.get("filters"));
  assert.ok(prefs.get("filterIR"));

  prefs.remove("filterIR");
  delete globalThis.App;
});

test("FilterManager: onChange listener and unsubscribe", () => {
  const fm = new FilterManager();
  let count = 0;
  let lastIR = null;
  const unsubscribe = fm.onChange((ir) => {
    count++;
    lastIR = ir;
  });

  fm.toggleChip("state", "Active", "in");
  assert.strictEqual(count, 1);
  assert.ok(lastIR);

  unsubscribe();
  fm.toggleChip("state", "New", "in");
  assert.strictEqual(count, 1); // should not have incremented
});

test("timeExprToMath and evaluateMath", () => {
  assert.strictEqual(lib.evaluateMath(lib.timeExprToMath("1d 4h", 8)), 12);
  assert.strictEqual(lib.evaluateMath(lib.timeExprToMath("1w 2d 3h", 8)), 59);
  assert.strictEqual(lib.evaluateMath(lib.timeExprToMath("2d + 4h", 8)), 20);
  assert.strictEqual(lib.evaluateMath(lib.timeExprToMath("1.5d - 2h", 8)), 10);
  assert.ok(isNaN(lib.evaluateMath(lib.timeExprToMath("invalid", 8))));
});

test("gid: composite work-item id encode/decode (BACKEND_PROVIDER §13.1)", () => {
  assert.strictEqual(lib.gidMake("ado", 123), "ado:123");
  assert.strictEqual(lib.gidMake("jira", "PROJ-45"), "jira:PROJ-45");
  assert.strictEqual(lib.gidNative("ado:123"), "123");
  assert.strictEqual(lib.gidNative("jira:PROJ-45"), "PROJ-45");   // native may contain no extra colon
  assert.strictEqual(lib.gidNative("123"), "123");                 // tolerant: bare native passes through
  assert.strictEqual(lib.gidProvider("ado:123"), "ado");
  assert.strictEqual(lib.gidProvider("123"), null);                // bare native has no provider
  assert.strictEqual(lib.gidNative(lib.gidMake("ado", 7)), "7");   // round-trip
});

(async () => {
  for (const { name, fn } of queued) {
    try { await fn(); pass++; console.log("  ok   " + name); }
    catch (e) { fail++; console.error("FAIL   " + name + "\n       " + (e && e.message)); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

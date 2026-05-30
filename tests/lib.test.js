// Unit tests for the pure helpers in lib.js. No deps — run with: npm test
// (or: node tests/lib.test.js). Exits non-zero if anything fails.
const assert = require("node:assert");
const lib = require("../lib.js");

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log("  ok   " + name); }
  catch (e) { fail++; console.error("FAIL   " + name + "\n       " + (e && e.message)); }
}
const utc = (...a) => new Date(Date.UTC(...a));

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
};
test("buildClauses: simple IN include", () => {
  assert.deepStrictEqual(lib.buildClauses(FF, { state: { in: ["Active", "New"], not: [] } }),
    ["([System.State] IN ('Active','New'))"]);
});
test("buildClauses: NOT IN exclude", () => {
  assert.deepStrictEqual(lib.buildClauses(FF, { state: { in: [], not: ["Closed"] } }),
    ["([System.State] NOT IN ('Closed'))"]);
});
test("buildClauses: numeric field is not quoted", () => {
  assert.deepStrictEqual(lib.buildClauses(FF, { priority: { in: ["1", "2"], not: [] } }),
    ["([Microsoft.VSTS.Common.Priority] IN (1,2))"]);
});
test("buildClauses: identity @me + named", () => {
  assert.deepStrictEqual(lib.buildClauses(FF, { assigned: { in: ["me", "Bob"], not: [] } }),
    ["([System.AssignedTo] = @me OR [System.AssignedTo] IN ('Bob'))"]);
});
test("buildClauses: tags use CONTAINS / NOT CONTAINS", () => {
  assert.deepStrictEqual(lib.buildClauses(FF, { tags: { in: ["ux"], not: ["wip"] } }),
    ["([System.Tags] CONTAINS 'ux')", "([System.Tags] NOT CONTAINS 'wip')"]);
});
test("buildClauses: values are WIQL-escaped", () => {
  assert.deepStrictEqual(lib.buildClauses(FF, { state: { in: ["O'Brien"], not: [] } }),
    ["([System.State] IN ('O''Brien'))"]);
});
test("buildClauses: empty filters -> no clauses", () => {
  assert.deepStrictEqual(lib.buildClauses(FF, {}), []);
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

// Guard against cross-file global collisions. lib.js, api.js and app.js are
// loaded as classic <script>s that SHARE one global scope, so a top-level
// declaration in one (e.g. `function assignees`) collides with the same name in
// another (`let assignees`) — a SyntaxError that per-file `node --check` cannot
// see. This parses the three as one combined scope to surface such duplicates.
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const root = path.join(__dirname, "..");
const files = ["lib.js", "api.js", "app.js"];
const src = files.map(f => fs.readFileSync(path.join(root, f), "utf8")).join("\n;\n");

try {
  new vm.Script(src, { filename: "combined.js" });   // compile-time early errors throw here
} catch (e) {
  console.error("Global-scope check FAILED: " + e.message);
  console.error("(a top-level name is declared in more than one of " + files.join(", ") + ")");
  process.exit(1);
}
console.log("Global-scope check OK (" + files.join(" + ") + ")");

// Guard against cross-file global collisions. lib.js, api.js and app.js are
// loaded as classic <script>s that SHARE one global scope, so a top-level
// declaration in one (e.g. `function assignees`) collides with the same name in
// another (`let assignees`) — a SyntaxError that per-file `node --check` cannot
// see. This parses the three as one combined scope to surface such duplicates.
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const root = path.join(__dirname, "..");
const files = [
  "src/core/lib.js",
  "src/components/i18n.js",
  "src/core/api.js",
  "src/components/markdown-editor.js",
  "src/components/card-picker.js",
  "src/components/tags-editor.js",
  "src/components/date-range-picker.js",
  "src/components/tutorial-manager.js",
  "src/components/follow-manager.js",
  "src/components/entitlement-manager.js",
  "src/components/premium-paywall.js",
  "src/components/pro-features.js",
  "src/components/filter-builder-modal.js",
  "src/components/filter-manager.js",
  "src/ai/ai-provider.js",
  "src/ai/chrome-prompt-provider.js",
  "src/ai/custom-cloud-provider.js",
  "src/ai/hosted-cloud-provider.js",
  "src/ai/prompts/search-prompt.js",
  "src/ai/ai-search-service.js",
  "src/components/ai-search-dialog.js",
  "src/app/namespace.js",
  "src/app/const.js",
  "src/app/loading.js",
  "src/app/badges.js",
  "src/app/state-globals.js",
  "src/app/export.js",
  "src/app/types.js",
  "src/app/timeline.js",
  "src/app/item-create.js",
  "src/app/settings.js",
  "src/app/snapshot.js",
  "src/app/setup.js",
  "src/app/command-palette.js",
  "src/app/filters.js",
  "src/app/dependencies.js",
  "src/app/activity.js",
  "src/app/graph.js",
  "src/app.js"
];
const src = files.map(f => fs.readFileSync(path.join(root, f), "utf8")).join("\n;\n");

try {
  new vm.Script(src, { filename: "combined.js" });   // compile-time early errors throw here
} catch (e) {
  console.error("Global-scope check FAILED: " + e.message);
  console.error("(a top-level name is declared in more than one of " + files.join(", ") + ")");
  process.exit(1);
}
console.log("Global-scope check OK (" + files.join(" + ") + ")");

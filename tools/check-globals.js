// Guard against cross-file global collisions. All src/**/*.js files are
// loaded as classic <script>s that SHARE one global scope, so a top-level
// declaration in one (e.g. `function assignees`) collides with the same name in
// another (`let assignees`) — a SyntaxError that per-file `node --check` cannot
// see. This parses the files as one combined scope to surface such duplicates.
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const root = path.join(__dirname, "..");

function getJsFilesRecursively(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach(file => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat && stat.isDirectory()) {
      results = results.concat(getJsFilesRecursively(filePath));
    } else if (file.endsWith(".js")) {
      results.push(filePath);
    }
  });
  return results;
}

const files = getJsFilesRecursively(path.join(root, "src"));
const src = files.map(f => fs.readFileSync(f, "utf8")).join("\n;\n");

try {
  new vm.Script(src, { filename: "combined.js" });   // compile-time early errors throw here
} catch (e) {
  console.error("Global-scope check FAILED: " + e.message);
  console.error("(a top-level name is declared in more than one file in the src directory)");
  process.exit(1);
}
console.log(`Global-scope check OK (${files.length} files audited)`);

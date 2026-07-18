// Static linter to verify that all JS files under src/ are registered
// either in index.html (as <script> tags) or in background.js (via importScripts).
const fs = require("fs");
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
      // Exclude test/spec files and test folders
      if (!file.includes(".test.") && !file.includes(".spec.") && !dir.includes("test")) {
        results.push(filePath);
      }
    }
  });
  return results;
}

const jsFiles = getJsFilesRecursively(path.join(root, "src"));

const indexHtml = fs.readFileSync(path.join(root, "index.html"), "utf8");
const backgroundJs = fs.readFileSync(path.join(root, "background.js"), "utf8");

let failed = false;

for (const filePath of jsFiles) {
  const relativePath = path.relative(root, filePath).replace(/\\/g, "/");
  
  const inIndex = indexHtml.includes(relativePath);
  const inBackground = backgroundJs.includes(relativePath);
  
  if (!inIndex && !inBackground) {
    console.error(`Script check FAILED: ${relativePath} is not registered in index.html or background.js`);
    failed = true;
  }
}

if (failed) {
  process.exit(1);
}

console.log(`Script registration check OK (${jsFiles.length} files verified)`);

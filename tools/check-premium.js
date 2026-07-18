// Guards the premium feature registry. ProCatalog (src/components/pro-catalog.js) is the
// single place a feature is declared — tier, status, copy, group. Everything else derives
// from it. This check exists because every way of getting it wrong fails SILENTLY:
//
//   feature used in markup but not declared  -> getTier() defaults it to 'pro'; nobody chose that
//   a tier that isn't free/preview/pro       -> silently treated as 'pro'
//   pitch keys that don't exist in en.json   -> the paywall renders a blank title
//   a theme pointing at a missing feature    -> its badge and gate quietly do the wrong thing
//
// None of it throws, none of it shows up in a smoke test. So it is checked here.
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const read = p => fs.readFileSync(path.join(root, p), "utf8");

const catalog = require(path.join(root, "src/components/pro-catalog.js"));
const en = JSON.parse(read("src/locales/en.json"));
const errors = [];

const TIERS = ["free", "preview", "pro"];
const STATUSES = ["planned", "stub", "partial", "live"];

// ---- 1. every declaration is complete and well-formed -------------------------------------
const seen = new Set();
for (const g of catalog.GROUPS) {
  if (!en[g.group]) errors.push(`group "${g.group}" has no en.json string`);
  for (const f of g.items) {
    if (seen.has(f.key)) errors.push(`feature "${f.key}" is declared twice`);
    seen.add(f.key);

    if (!TIERS.includes(f.tier)) {
      errors.push(`feature "${f.key}": tier "${f.tier}" is not one of ${TIERS.join(" / ")} — it would silently behave as 'pro'`);
    }
    if (!STATUSES.includes(f.status)) {
      errors.push(`feature "${f.key}": status "${f.status}" is not one of ${STATUSES.join(" / ")}`);
    }
    for (const k of ["titleKey", "descKey", "pitchTitleKey", "pitchDescKey"]) {
      if (f[k] && !en[f[k]]) errors.push(`feature "${f.key}": ${k} "${f[k]}" is missing from en.json`);
    }
    // A pitch is all-or-nothing: half of one renders a blank line in the paywall.
    if (!!f.pitchTitleKey !== !!f.pitchDescKey) {
      errors.push(`feature "${f.key}": pitchTitleKey and pitchDescKey must be declared together`);
    }
  }
}

// ---- 2. everything that USES a feature key refers to one that exists -----------------------
const usages = [];
for (const m of read("index.html").matchAll(/data-pro-feature="(\w+)"/g)) {
  usages.push({ key: m[1], where: "index.html (data-pro-feature)" });
}
for (const m of read("src/app/settings.js").matchAll(/feature:\s*'(\w+)'/g)) {
  usages.push({ key: m[1], where: "settings.js (THEMES)" });
}
for (const m of read("src/components/premium-paywall.js").matchAll(/\{\s*key:\s*'(\w+)',\s*icon:/g)) {
  if (m[1] !== "ui") usages.push({ key: m[1], where: "premium-paywall.js (BENEFITS)" });
}
for (const u of usages) {
  if (!catalog.has(u.key)) {
    errors.push(`${u.where}: "${u.key}" is not declared in ProCatalog — getTier() would silently default it to 'pro'`);
  }
}

// ---- 3. the old per-module registries are really gone --------------------------------------
// If one comes back, the drift this file exists to prevent comes back with it.
if (/const\s+TIERS\s*=/.test(read("src/components/pro-button-manager.js"))) {
  errors.push("pro-button-manager.js: a local TIERS table is back — tiers belong in ProCatalog only");
}
if (/const\s+FEATURES\s*=\s*\{/.test(read("src/components/premium-paywall.js"))) {
  errors.push("premium-paywall.js: a local FEATURES table is back — pitch copy belongs in ProCatalog only");
}
if (/const\s+CATALOG\s*=\s*\[/.test(read("src/components/pro-features.js"))) {
  errors.push("pro-features.js: a local CATALOG is back — the feature list belongs in ProCatalog only");
}

if (errors.length) {
  console.error("Premium registry check FAILED:\n" + errors.map(e => "  - " + e).join("\n"));
  process.exit(1);
}

const byTier = {};
for (const k of catalog.keys()) { const t = catalog.tier(k); byTier[t] = (byTier[t] || 0) + 1; }
const live = catalog.keys().filter(k => catalog.isLive(k));
console.log(`Premium registry check OK (${catalog.keys().length} features: ` +
  Object.entries(byTier).map(([t, n]) => `${n} ${t}`).join(", ") +
  `; live: ${live.join(", ") || "none"})`);

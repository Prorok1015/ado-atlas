// Guards the theme system against silent drift. Themes are defined in three places by
// necessity — settings.js (source of truth), premium.css (the palettes), and theme-init.js
// (a pre-paint duplicate that MUST exist, because chrome.storage is async and would resolve
// after first paint). Nothing at runtime would tell you they disagree: a missing token just
// inherits the base theme, and a stale theme-init map just flashes the wrong theme for one
// frame. Both are exactly the kind of bug the static gate otherwise cannot see.
//
// Checks:
//   1. every theme in settings.js THEMES has a body.theme-<id> block in premium.css
//      declaring all 11 tokens (premium themes only — dark/light live in base.css);
//   2. theme-init.js THEME_BASE agrees with settings.js on every id and its base;
//   3. every premium theme's `feature` key exists in ProButtonManager TIERS and in
//      PremiumPaywall FEATURES, so the gate and the paywall pitch can both resolve it.
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const read = p => fs.readFileSync(path.join(root, p), "utf8");

const TOKENS = ["--bg","--panel","--panel2","--line","--txt","--muted","--accent","--field","--sel","--cy-bg","--cy-dot"];
const errors = [];

// ---- 1. parse THEMES out of settings.js -------------------------------------------------
const settings = read("src/app/settings.js");
const themes = {};
const themeRe = /(\w+):\s*\{\s*id:\s*'([^']+)'\s*,\s*base:\s*'(dark|light)'[^}]*?(?:feature:\s*'([^']+)')?\s*\}/g;
let m;
while ((m = themeRe.exec(settings))) {
  themes[m[2]] = { base: m[3], feature: m[4] || null };
}
if (Object.keys(themes).length === 0) {
  errors.push("settings.js: could not parse the THEMES registry — did its shape change?");
}

// ---- 2. premium.css declares every premium palette in full ------------------------------
const css = read("src/styles/premium.css");
for (const [id, t] of Object.entries(themes)) {
  if (id === "dark" || id === "light") continue;          // these live in base.css
  const block = new RegExp("body\\.theme-" + id + "\\s*\\{([^}]*)\\}").exec(css);
  if (!block) {
    errors.push(`premium.css: no "body.theme-${id}" block for theme "${id}"`);
    continue;
  }
  const body = block[1];
  const missing = TOKENS.filter(tok => !new RegExp("\\" + tok + "\\s*:").test(body));
  if (missing.length) {
    errors.push(`premium.css: body.theme-${id} is missing token(s): ${missing.join(", ")}`);
  }
  const wantScheme = t.base === "light" ? "light" : "dark";
  if (!new RegExp("color-scheme:\\s*" + wantScheme).test(body)) {
    errors.push(`premium.css: body.theme-${id} should declare color-scheme: ${wantScheme} (base is ${t.base})`);
  }
}

// ---- 3. theme-init.js (pre-paint duplicate) agrees ---------------------------------------
const init = read("src/boot/theme-init.js");
const baseBlock = /THEME_BASE\s*=\s*\{([\s\S]*?)\}/.exec(init);
if (!baseBlock) {
  errors.push("theme-init.js: could not find THEME_BASE — the pre-paint theme map is gone, themes will flash on load");
} else {
  const initBase = {};
  const re = /(\w+):\s*'(dark|light)'/g;
  let b;
  while ((b = re.exec(baseBlock[1]))) initBase[b[1]] = b[2];

  for (const [id, t] of Object.entries(themes)) {
    if (!(id in initBase)) {
      errors.push(`theme-init.js: theme "${id}" is missing from THEME_BASE — it will flash the wrong theme on every load`);
    } else if (initBase[id] !== t.base) {
      errors.push(`theme-init.js: theme "${id}" base is "${initBase[id]}" but settings.js says "${t.base}"`);
    }
  }
  for (const id of Object.keys(initBase)) {
    if (!(id in themes)) errors.push(`theme-init.js: THEME_BASE has "${id}", which settings.js does not define`);
  }
}

// ---- 4. every premium theme is a declared feature ------------------------------------------
// Tier and pitch copy live in ProCatalog now (one registry for every premium feature);
// tools/check-premium.js validates those. Here we only assert the link exists at all.
const catalog = require(path.join(root, "src/components/pro-catalog.js"));
for (const [id, t] of Object.entries(themes)) {
  if (!t.feature) continue;
  if (!catalog.has(t.feature)) {
    errors.push(`ProCatalog has no feature "${t.feature}" (theme "${id}") — its tier would silently default to 'pro' and the paywall would show the generic pitch`);
  }
}

if (errors.length) {
  console.error("Theme check FAILED:\n" + errors.map(e => "  - " + e).join("\n"));
  process.exit(1);
}
console.log(`Theme check OK (${Object.keys(themes).length} themes: ${Object.keys(themes).join(", ")})`);

// Lint the in-app locale dictionaries for key parity against the English base.
// en.json is the source of truth: every other locale must define exactly the
// same key set — no missing keys (would silently fall back to EN) and no
// orphans (dead translations / typos). Run: node tools/check-i18n-keys.js
// Optional: `--pseudo` (re)writes locales/pseudo.json, a debugging locale whose
// values wrap the EN text in [!...!] markers so untranslated UI is obvious at a
// glance (placeholders like {count} are preserved). Exits non-zero on mismatch.
const fs = require("fs");
const path = require("path");

const LOCALES_DIR = path.join(__dirname, "..", "locales");
const BASE = "en";
const TRANSLATIONS = ["ru", "es", "de"]; // locales expected to mirror en.json

function loadDict(lang) {
  const p = path.join(LOCALES_DIR, lang + ".json");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function writePseudo(enDict) {
  const out = {};
  for (const k of Object.keys(enDict)) out[k] = "[!" + enDict[k] + "!]";
  const p = path.join(LOCALES_DIR, "pseudo.json");
  fs.writeFileSync(p, JSON.stringify(out, null, 2) + "\n");
  console.log("Wrote " + p + " (" + Object.keys(out).length + " keys)");
}

const en = loadDict(BASE);
const enKeys = Object.keys(en).sort();

if (process.argv.includes("--pseudo")) { writePseudo(en); process.exit(0); }

let failed = false;
for (const lang of TRANSLATIONS) {
  let dict;
  try { dict = loadDict(lang); }
  catch (e) { console.error("locale " + lang + ": cannot read — " + e.message); failed = true; continue; }
  const keys = new Set(Object.keys(dict));
  const missing = enKeys.filter(k => !keys.has(k));
  const orphan = [...keys].filter(k => !(k in en)).sort();
  if (missing.length || orphan.length) {
    failed = true;
    console.error("locale " + lang + ": FAILED");
    if (missing.length) console.error("  missing " + missing.length + " key(s): " + missing.join(", "));
    if (orphan.length) console.error("  orphan " + orphan.length + " key(s): " + orphan.join(", "));
  } else {
    console.log("locale " + lang + ": OK (" + enKeys.length + " keys)");
  }
}

if (failed) { console.error("\ni18n key-parity check FAILED"); process.exit(1); }
console.log("\ni18n key-parity check OK (base=en, " + enKeys.length + " keys)");

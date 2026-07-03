// App.prefs export/import sanity check (SETTINGS_SYNC_SPEC Phase 1).
//
// Guards the two invariants the sync payload depends on:
//   1. Secrets firewall — no secret key is in the REGISTRY, and export() emits ONLY
//      scope:'sync' keys (device-scoped keys and secrets can never leak).
//   2. Round-trip stability — import(export()) reproduces the same sync values, and
//      import() ignores non-sync / unknown keys.
//
// prefs.js has no chrome in node, so it uses its in-memory cache. The keys touched
// here are not mirrorLS, so localStorage is never used.
const assert = require("node:assert");
const prefs = require("../src/app/prefs.js");

// ---- seed a mix of sync-scoped and device-scoped prefs ----
prefs.set("theme", "light");                              // sync
prefs.set("filterIR", JSON.stringify({ where: {} }));     // sync
prefs.set("followNotify", "off");                         // sync (worker area)
prefs.set("sideWidth", "360px");                          // device
prefs.set("pinnedSprints", JSON.stringify(["a\\b"]));    // device

// ---- 1. secrets are not even in the registry ----
for (const secret of ["license_key", "__dev_force_pro", "config", "pat",
                       "oauthAccess", "oauthRefresh", "ai_custom_config",
                       "ai_custom_config_v2", "ai_selected_provider"]) {
  assert.ok(!(secret in prefs.REGISTRY), `secret "${secret}" must NOT be in the REGISTRY`);
}

// ---- 2. export() emits only scope:'sync' keys ----
const blob = prefs.export();
assert.strictEqual(blob.v, 1, "export schema version");
assert.ok(blob && blob.values && typeof blob.values === "object", "export has a values object");
assert.strictEqual(blob.values.theme, "light");
assert.ok(blob.values.filterIR, "sync filterIR exported");
assert.strictEqual(blob.values.followNotify, "off");
assert.ok(!("sideWidth" in blob.values), "device key sideWidth must NOT export");
assert.ok(!("pinnedSprints" in blob.values), "device key pinnedSprints must NOT export");
for (const k of Object.keys(blob.values)) {
  const r = prefs.REGISTRY[k];
  assert.ok(r && r.scope === "sync", `exported key "${k}" must be a sync-scoped registry key`);
}

// ---- 3. round-trip stability: import(export()) is a no-op on the values ----
prefs.import(blob);
const blob2 = prefs.export();
assert.deepStrictEqual(blob2.values, blob.values, "import(export()) round-trip is stable");

// ---- 4. import ignores device-scoped + unknown/secret keys ----
prefs.import({ v: 1, ts: 0, values: { theme: "dark", sideWidth: "999px", license_key: "SECRET" } });
assert.strictEqual(prefs.get("theme"), "dark", "sync key theme is imported");
assert.strictEqual(prefs.get("sideWidth"), "360px", "device key sideWidth is NOT overwritten by import");
assert.ok(!("license_key" in prefs.REGISTRY) && !("license_key" in prefs.getAll()), "unknown secret key is ignored by import");

console.log("prefs export/import check OK (" + Object.keys(blob.values).length +
            " sync keys exported; device keys + secrets firewalled; round-trip stable)");

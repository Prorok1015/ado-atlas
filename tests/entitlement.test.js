// Unit tests for EntitlementManager — the money logic. It decides who gets what they paid
// for, and it had ZERO tests before this file. Almost all of it is pure: state + Date.now().
const assert = require("node:assert");

// Minimal extension-API mocks; the manager only touches chrome.storage.local in init().
global.window = global;
let storage = {};
global.chrome = {
  storage: { local: {
    get: async keys => { const o = {}; for (const k of keys) if (k in storage) o[k] = storage[k]; return o; },
    set: async patch => { Object.assign(storage, patch); }
  } }
};
let paywallFor = null;
global.PremiumPaywall = { open: f => { paywallFor = f; } };
global.ProButtonManager = { isPreview: f => f === "previewFeature" };

require("../src/components/entitlement-manager.js");
const EM = global.EntitlementManager;

const DAY = 24 * 60 * 60 * 1000;
// Put the manager in a known state without going through storage.
function setState(s, devForce = false) {
  EM._state = Object.assign({ tier: "free", status: "none", expires_at: 0, last_validated_at: 0 }, s);
  EM._devForcePro = devForce;
  paywallFor = null;
}

let pass = 0, fail = 0;
const queued = [];
function test(name, fn) { queued.push({ name, fn }); }
process.on("unhandledRejection", e => { console.error("UNHANDLED REJECTION\n  " + (e && e.stack || e)); process.exit(1); });

// ---- isPro -------------------------------------------------------------------------------
test("isPro: a free tier is not Pro", () => {
  setState({ tier: "free" });
  assert.strictEqual(EM.isPro(), false);
});

test("isPro: an active subscription is Pro", () => {
  setState({ tier: "pro", status: "active" });
  assert.strictEqual(EM.isPro(), true);
});

test("isPro: past_due inside the grace period stays Pro (a network blip must not lock a payer out)", () => {
  setState({ tier: "pro", status: "past_due", last_validated_at: Date.now() - 3 * DAY });
  assert.strictEqual(EM.isPro(), true);
});

test("isPro: past_due beyond the 7-day grace period is NOT Pro", () => {
  setState({ tier: "pro", status: "past_due", last_validated_at: Date.now() - 8 * DAY });
  assert.strictEqual(EM.isPro(), false);
});

test("isPro: never validated (last_validated_at = 0) is not Pro once past_due", () => {
  setState({ tier: "pro", status: "past_due", last_validated_at: 0 });
  assert.strictEqual(EM.isPro(), false);
});

test("isPro: the dev override forces Pro", () => {
  setState({ tier: "free" }, true);
  assert.strictEqual(EM.isPro(), true);
});

// ---- gate --------------------------------------------------------------------------------
test("gate: a Pro user passes and sees NO paywall", () => {
  setState({ tier: "pro", status: "active" });
  assert.strictEqual(EM.gate("anything"), true);
  assert.strictEqual(paywallFor, null, "a paying user must never be shown a paywall");
});

test("gate: a free user is blocked and the paywall is pitched at THAT feature", () => {
  setState({ tier: "free" });
  assert.strictEqual(EM.gate("cloud_ai"), false);
  assert.strictEqual(paywallFor, "cloud_ai");
});

test("gate: a Free Preview feature passes for a free user", () => {
  setState({ tier: "free" });
  assert.strictEqual(EM.gate("previewFeature"), true);
  assert.strictEqual(paywallFor, null);
});

// ---- entitlement guards ------------------------------------------------------------------
test("guards: run and collect the labels of what they reverted", () => {
  EM._guards.clear();
  EM.registerGuard("theme", () => "Ultra Dark");
  EM.registerGuard("formatting", () => null);          // nothing to revert
  assert.deepStrictEqual(EM.enforceEntitlements(), ["Ultra Dark"]);
});

test("guards: a throwing guard does not take down the others (or the boot)", () => {
  EM._guards.clear();
  EM.registerGuard("broken", () => { throw new Error("boom"); });
  EM.registerGuard("theme", () => "Paper");
  assert.deepStrictEqual(EM.enforceEntitlements(), ["Paper"]);
});

test("guards: registering the same id twice replaces it (no double-revert)", () => {
  EM._guards.clear();
  EM.registerGuard("theme", () => "old");
  EM.registerGuard("theme", () => "new");
  assert.deepStrictEqual(EM.enforceEntitlements(), ["new"]);
});

test("guards: nothing registered means nothing reverted", () => {
  EM._guards.clear();
  assert.deepStrictEqual(EM.enforceEntitlements(), []);
});

(async () => {
  for (const { name, fn } of queued) {
    try { await fn(); pass++; console.log("  ok   " + name); }
    catch (e) { fail++; console.error("FAIL   " + name + "\n       " + (e && e.message)); }
  }
  console.log(`\nEntitlement tests: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

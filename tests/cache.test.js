// Unit tests for App.cache (src/app/cache-manager.js). No deps — run with: npm test
const assert = require("node:assert");

// Mock environment before loading module
const store = {};
globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        if (keys === null) return { ...store };
        if (Array.isArray(keys)) {
          const res = {};
          keys.forEach(k => { if (k in store) res[k] = store[k]; });
          return res;
        }
        if (typeof keys === 'string') {
          return { [keys]: store[keys] };
        }
        return {};
      },
      async set(obj) {
        Object.assign(store, obj);
      },
      async remove(keys) {
        const arr = Array.isArray(keys) ? keys : [keys];
        arr.forEach(k => delete store[k]);
      }
    }
  }
};

globalThis.api = {
  async getConfig() {
    return { org: "testorg", project: "testproj" };
  }
};

require("../src/app/cache-manager.js");

let pass = 0, fail = 0;
const queued = [];
function test(name, fn) { queued.push({ name, fn }); }

test("App.cache: resolves project-scoped keys correctly", async () => {
  const scopedKey = await globalThis.App.cache.getScopedKey("test_key");
  assert.strictEqual(scopedKey, "v1:testorg/testproj:test_key");
});

test("App.cache: set and get value with memory + persistent storage", async () => {
  await globalThis.App.cache.set("user_data", { foo: "bar" });
  const val = await globalThis.App.cache.get("user_data");
  assert.deepStrictEqual(val, { foo: "bar" });
});

test("App.cache: respects TTL expiration", async () => {
  await globalThis.App.cache.set("ttl_key", "temporary");
  
  // Instant fetch succeeds
  const fresh = await globalThis.App.cache.get("ttl_key", { ttlMs: 5000 });
  assert.strictEqual(fresh, "temporary");

  // Expired fetch (ttlMs: -1) returns null
  const expired = await globalThis.App.cache.get("ttl_key", { ttlMs: -1 });
  assert.strictEqual(expired, null);
});

test("App.cache: clearProject purges project-scoped keys", async () => {
  await globalThis.App.cache.set("item1", "v1");
  await globalThis.App.cache.set("item2", "v2");
  
  assert.strictEqual(await globalThis.App.cache.get("item1"), "v1");
  await globalThis.App.cache.clearProject();
  
  assert.strictEqual(await globalThis.App.cache.get("item1"), null);
  assert.strictEqual(await globalThis.App.cache.get("item2"), null);
});

(async () => {
  for (const { name, fn } of queued) {
    try { await fn(); pass++; console.log("  ok   " + name); }
    catch (e) { fail++; console.error("FAIL   " + name + "\n       " + (e && e.message)); }
  }
  console.log(`\nCache tests completed: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

// Unit tests for API mapping logic. Run with: node tests/api.test.js
const assert = require("node:assert");
const lib = require("../src/core/lib.js");

// Set up globals required by http-auth.js
global.AdoLib = lib;
global.FIELD_REGISTRY = {
  id:          { ref: "System.Id", type: "integer", name: "ID" },
  type:        { ref: "System.WorkItemType", type: "string", name: "Type" },
  title:       { ref: "System.Title", type: "string", name: "Title" },
  state:       { ref: "System.State", type: "string", name: "State" },
  assigned:    { ref: "System.AssignedTo", type: "identity", name: "Assigned" },
  parent:      { ref: "System.Parent", type: "integer", name: "Parent ID" },
  finish:      { ref: "System.FinishDate", type: "dateTime" },
  target:      { ref: "System.TargetDate", type: "dateTime" },
  due:         { ref: "System.DueDate", type: "dateTime" },
  ac:          { ref: "Microsoft.VSTS.Common.AcceptanceCriteria", type: "html", name: "Acceptance Criteria" },
  desc:        { ref: "System.Description", type: "html", name: "Description", fallbackRefs: ["Microsoft.VSTS.TCM.ReproSteps", "System.Description"] },
  estimate:    { ref: "Microsoft.VSTS.Scheduling.OriginalEstimate", type: "double", name: "Original Estimate" },
  priority:    { ref: "Microsoft.VSTS.Common.Priority", type: "integer", name: "Priority" },
  iteration:   { ref: "System.IterationPath", type: "string", name: "Sprint" },
  tags:        { ref: "System.Tags", type: "string", name: "Tags" }
};
global.AC_TYPES = new Set(["User Story", "Bug"]);
global.htmlToMarkdown = (x) => x || "";
global.depsFromRelations = () => [];
global.attachmentsFromRelations = () => [];

// Mock Chrome APIs
global.chrome = {
  identity: {
    getRedirectURL: () => "https://mock-redirect"
  },
  storage: {
    local: {
      get: async () => ({}),
      set: async () => {}
    }
  }
};

// Mock fetch globally
global.fetch = async () => ({
  ok: true,
  text: async () => "{}"
});

// Load http-auth.js in the global context (simulating browser script tag behavior)
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const code = fs.readFileSync(path.resolve(__dirname, "../src/core/api/http-auth.js"), "utf8");
vm.runInThisContext(code);

let pass = 0, fail = 0;

// Queued and awaited sequentially at the bottom — see tests/ai.test.js for why calling
// fn() synchronously makes every async test report a false pass.
const queued = [];
function test(name, fn) { queued.push({ name, fn }); }

process.on("unhandledRejection", (e) => {
  console.error("UNHANDLED REJECTION\n       " + (e && e.stack || e));
  process.exit(1);
});

console.log("Running API tests...");

test("mapWorkItem: normalizes numeric parent to composite string ID", () => {
  const raw = {
    id: 100,
    fields: {
      "System.Id": 100,
      "System.WorkItemType": "Task",
      "System.Title": "Task Title",
      "System.State": "New",
      "System.Parent": 200
    }
  };
  const mapped = global.mapWorkItem(raw);
  assert.strictEqual(mapped.id, "ado:100");
  assert.strictEqual(mapped.parent, "ado:200");
});

test("mapWorkItem: normalizes string numeric parent to composite string ID", () => {
  const raw = {
    id: 100,
    fields: {
      "System.Id": 100,
      "System.WorkItemType": "Task",
      "System.Title": "Task Title",
      "System.State": "New",
      "System.Parent": "200"
    }
  };
  const mapped = global.mapWorkItem(raw);
  assert.strictEqual(mapped.parent, "ado:200");
});

test("mapWorkItem: preserves already-composite parent ID", () => {
  const raw = {
    id: 100,
    fields: {
      "System.Id": 100,
      "System.WorkItemType": "Task",
      "System.Title": "Task Title",
      "System.State": "New",
      "System.Parent": "ado:200"
    }
  };
  const mapped = global.mapWorkItem(raw);
  assert.strictEqual(mapped.parent, "ado:200");
});

test("mapWorkItem: maps empty/falsy parent to null", () => {
  const cases = [null, undefined, "", 0, "0"];
  for (const p of cases) {
    const raw = {
      id: 100,
      fields: {
        "System.Id": 100,
        "System.WorkItemType": "Task",
        "System.Title": "Task Title",
        "System.State": "New",
        "System.Parent": p
      }
    };
    const mapped = global.mapWorkItem(raw);
    assert.strictEqual(mapped.parent, null, `Expected null parent for: ${p}`);
  }
});

test("isRetryableRequest: retry is allowed for GET, PUT, DELETE, and HEAD", () => {
  assert.strictEqual(global.isRetryableRequest("GET"), true);
  assert.strictEqual(global.isRetryableRequest("PUT"), true);
  assert.strictEqual(global.isRetryableRequest("DELETE"), true);
  assert.strictEqual(global.isRetryableRequest("HEAD"), true);
});

test("isRetryableRequest: retry is NOT allowed for POST", () => {
  assert.strictEqual(global.isRetryableRequest("POST"), false);
});

test("isRetryableRequest: PATCH with test /rev is retryable", () => {
  const body = [{ op: "test", path: "/rev", value: 3 }, { op: "add", path: "/fields/System.Title", value: "New" }];
  assert.strictEqual(global.isRetryableRequest("PATCH", body), true);
});

test("isRetryableRequest: PATCH without test /rev is NOT retryable", () => {
  const body = [{ op: "add", path: "/fields/System.Title", value: "New" }];
  assert.strictEqual(global.isRetryableRequest("PATCH", body), false);
});

test("oauthRefresh: concurrent calls reuse the same promise", async () => {
  let callCount = 0;
  // Mock oauthTokenRequest to simulate delay
  global.oauthTokenRequest = async () => {
    callCount++;
    return new Promise(resolve => setTimeout(() => resolve({ access_token: "tok1", expires_in: 3600 }), 50));
  };
  global.getConfig = async () => ({ oauthClientId: "cid", oauthTenant: "ten", oauthRefresh: "ref" });
  global.setConfig = async () => {};
  global.OAUTH_SCOPE = "scope";

  // Trigger concurrent refreshes
  const p1 = global.oauthRefresh();
  const p2 = global.oauthRefresh();
  
  assert.strictEqual(p1, p2, "Promises must be the exact same instance");
  await Promise.all([p1, p2]);
  assert.strictEqual(callCount, 1, "Should only have called token endpoint once");
});

test("export: exports all items if bulk selection is empty", () => {
  const exportJs = fs.readFileSync(path.join(__dirname, "../src/app/export.js"), "utf8");
  
  let lastDownloadedText = null;
  global.Blob = class Blob {
    constructor(parts) {
      lastDownloadedText = parts[0];
    }
  };
  global.URL = {
    createObjectURL: () => "blob-url",
    revokeObjectURL: () => {}
  };
  global.document = {
    createElement: () => ({
      click: () => {},
      remove: () => {}
    }),
    body: {
      appendChild: () => {}
    }
  };
  
  let lastStatus = null;
  global.setStatus = (msg) => { lastStatus = msg; };
  
  global.App = {
    state: {
      store: {
        roots: ["ado:1", "ado:2"],
        nodes: {
          "ado:1": { id: "ado:1", title: "Item 1", type: "Task" },
          "ado:2": { id: "ado:2", title: "Item 2", type: "Bug" }
        }
      },
      bulkSel: new Set()
    }
  };
  global.window = { App: global.App };
  
  eval(exportJs);
  
  global.App.export.exportView("json");
  
  assert.ok(lastDownloadedText.includes("Item 1"));
  assert.ok(lastDownloadedText.includes("Item 2"));
  assert.ok(lastStatus.includes("exported 2"));
});

test("export: exports only selected items if bulk selection is not empty", () => {
  const exportJs = fs.readFileSync(path.join(__dirname, "../src/app/export.js"), "utf8");
  
  let lastDownloadedText = null;
  global.Blob = class Blob {
    constructor(parts) {
      lastDownloadedText = parts[0];
    }
  };
  global.URL = {
    createObjectURL: () => "blob-url",
    revokeObjectURL: () => {}
  };
  global.document = {
    createElement: () => ({
      click: () => {},
      remove: () => {}
    }),
    body: {
      appendChild: () => {}
    }
  };
  
  let lastStatus = null;
  global.setStatus = (msg) => { lastStatus = msg; };
  
  global.App = {
    state: {
      store: {
        roots: ["ado:1", "ado:2"],
        nodes: {
          "ado:1": { id: "ado:1", title: "Item 1", type: "Task" },
          "ado:2": { id: "ado:2", title: "Item 2", type: "Bug" }
        }
      },
      bulkSel: new Set(["ado:2"])
    }
  };
  global.window = { App: global.App };
  
  eval(exportJs);
  
  global.App.export.exportView("json");
  
  assert.ok(!lastDownloadedText.includes("Item 1"));
  assert.ok(lastDownloadedText.includes("Item 2"));
  assert.ok(lastStatus.includes("exported 1"));
});


(async () => {
  for (const { name, fn } of queued) {
    try { await fn(); pass++; console.log("  ok   " + name); }
    catch (e) { fail++; console.error("FAIL   " + name + "\n       " + (e && e.stack || e)); }
  }
  console.log(`API tests finished: ${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})();

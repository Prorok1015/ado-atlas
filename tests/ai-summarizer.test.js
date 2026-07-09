const assert = require("node:assert");

// Load dependencies
require("../ai/ai-provider.js");
require("../ai/prompts/summarize-prompt.js");
require("../ai/ai-summarizer.js");

let pass = 0, fail = 0;
function test(name, fn) {
  try {
    fn();
    pass++;
    console.log("  ok   " + name);
  } catch (e) {
    fail++;
    console.error("FAIL   " + name + "\n       " + (e && e.message));
  }
}

test("AISummarizer is exported globally", () => {
  assert.ok(typeof global.aiSummarizer !== "undefined");
  assert.ok(global.aiSummarizer instanceof global.AISummarizer);
});

test("AISummarizer constructor accepts custom registry", () => {
  const mockRegistry = { providers: [] };
  const summarizer = new global.AISummarizer(mockRegistry);
  assert.strictEqual(summarizer.registry, mockRegistry);
});

test("AISummarizer defaults to global aiProviderRegistry", () => {
  const summarizer = new global.AISummarizer();
  assert.strictEqual(summarizer.registry, global.aiProviderRegistry);
});

function makeMockRegistry(provider) {
  return {
    async getActive() {
      return provider || null;
    }
  };
}

test("AISummarizer.summarize calls provider.prompt with system prompt and description", async () => {
  let capturedSystem = null;
  let capturedUser = null;

  const mockProvider = {
    async prompt(system, user, options) {
      capturedSystem = system;
      capturedUser = user;
      return "This is a mock summary of the work item.";
    }
  };

  const summarizer = new global.AISummarizer(makeMockRegistry(mockProvider));
  const result = await summarizer.summarize("This is a test description with some details about a bug.");

  assert.strictEqual(capturedSystem, global.SUMMARIZE_SYSTEM_PROMPT);
  assert.strictEqual(capturedUser, "This is a test description with some details about a bug.");
  assert.strictEqual(result, "This is a mock summary of the work item.");
});

test("AISummarizer.summarize returns concise output for a short description", async () => {
  const mockProvider = {
    async prompt(system, user, options) {
      return user.length < 50 ? user : "A concise summary of the work item.";
    }
  };

  const summarizer = new global.AISummarizer(makeMockRegistry(mockProvider));
  const shortResult = await summarizer.summarize("Short desc");
  assert.strictEqual(shortResult, "Short desc");

  const longResult = await summarizer.summarize("This is a much longer description that should be summarized by the AI model into something more concise.");
  assert.strictEqual(longResult, "A concise summary of the work item.");
});

test("AISummarizer.summarize throws when no active provider", async () => {
  const summarizer = new global.AISummarizer(makeMockRegistry(null));

  try {
    await summarizer.summarize("test");
    assert.fail("Expected error was not thrown");
  } catch (e) {
    assert.ok(e.message.includes("No active provider"));
  }
});

(async () => {
  setTimeout(() => {
    console.log(`\nAI Summarizer Tests completed: ${pass} passed, ${fail} failed`);
    if (fail > 0) process.exit(1);
  }, 100);
})();

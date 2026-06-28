// Unit tests for the AI Search Service and Provider Registry
const assert = require("node:assert");

// Mock standard API dependencies
global.window = {
  api: {
    getFilterFields() {
      return [
        { id: "id", displayName: "ID", type: "number", operators: ["=", "<>", ">", "<"] },
        { id: "type", displayName: "Type", type: "string", operators: ["=", "<>"] },
        { id: "state", displayName: "State", type: "string", operators: ["=", "<>"] },
        { id: "assigned", displayName: "Assigned", type: "user", operators: ["=", "<>"] },
        { id: "iteration", displayName: "Sprint", type: "tree", operators: ["=", "UNDER"] },
        { id: "tags", displayName: "Tags", type: "tags", operators: ["CONTAINS", "NOT CONTAINS"] }
      ];
    },
    async assignees() {
      return ["John Doe", "Jane Smith", "Alice Cooper"];
    }
  }
};

// Load the AI Search Service
require("../ai/ai-provider.js");
require("../ai/chrome-prompt-provider.js");
require("../ai/prompts/search-prompt.js");
require("../ai/ai-search-service.js");

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

// Tests
test("AIProviderRegistry registers and returns providers", () => {
  const providers = global.aiProviderRegistry.getAll();
  assert.ok(providers.some(p => p.id === "chrome-prompt-api"));
});

test("AISearchService.enrichIR handles flat AND queries", async () => {
  const service = global.aiSearchService;
  const rawIR = {
    where: {
      logic: "AND",
      rules: [
        { field: "status", op: "=", value: "active" },
        { field: "assignee", op: "=", value: "John" }
      ]
    }
  };

  const fields = global.window.api.getFilterFields();
  const enriched = await service.enrichIR(rawIR, fields, []);

  // Should normalize root to OR, and rules to a single AND group
  assert.strictEqual(enriched.kind, "group");
  assert.strictEqual(enriched.logic, "OR");
  assert.strictEqual(enriched.rules.length, 1);

  const card = enriched.rules[0];
  assert.strictEqual(card.kind, "group");
  assert.strictEqual(card.logic, "AND");
  assert.strictEqual(card.rules.length, 2);

  // Status should be mapped to state
  assert.strictEqual(card.rules[0].field, "state");
  assert.strictEqual(card.rules[0].op, "=");
  assert.strictEqual(card.rules[0].value, "active");

  // Assignee should be mapped to assigned and fuzzy resolved John -> John Doe
  assert.strictEqual(card.rules[1].field, "assigned");
  assert.strictEqual(card.rules[1].value, "John Doe");
});

test("AISearchService.enrichIR handles nested OR/AND query", async () => {
  const service = global.aiSearchService;
  const rawIR = {
    where: {
      logic: "OR",
      rules: [
        {
          logic: "AND",
          rules: [
            { field: "type", op: "=", value: "Bug" },
            { field: "state", op: "=", value: "Active" }
          ]
        },
        {
          logic: "AND",
          rules: [
            { field: "type", op: "=", value: "Task" },
            { field: "iteration", op: "UNDER", value: "@currentIteration" }
          ]
        }
      ]
    }
  };

  const fields = global.window.api.getFilterFields();
  const enriched = await service.enrichIR(rawIR, fields, []);

  assert.strictEqual(enriched.logic, "OR");
  assert.strictEqual(enriched.rules.length, 2);

  assert.strictEqual(enriched.rules[0].rules[0].field, "type");
  assert.strictEqual(enriched.rules[0].rules[1].field, "state");

  assert.strictEqual(enriched.rules[1].rules[0].field, "type");
  assert.strictEqual(enriched.rules[1].rules[1].field, "iteration");
  assert.strictEqual(enriched.rules[1].rules[1].value, "@currentIteration");
});

test("AISearchService.resolveIdentity handles @me", async () => {
  const service = global.aiSearchService;
  assert.strictEqual(await service.resolveIdentity("me"), "@me");
  assert.strictEqual(await service.resolveIdentity("@me"), "@me");
});

test("AISearchService.resolveIdentity fuzzy matches John", async () => {
  const service = global.aiSearchService;
  assert.strictEqual(await service.resolveIdentity("John"), "John Doe");
  assert.strictEqual(await service.resolveIdentity("Jane"), "Jane Smith");
  assert.strictEqual(await service.resolveIdentity("Cooper"), "Alice Cooper");
  assert.strictEqual(await service.resolveIdentity("Unknown Person"), "Unknown Person"); // Falls back
});

test("ChromePromptApiProvider.extractJSON parses embedded JSON and auto-escapes single backslashes in paths", () => {
  const provider = new global.ChromePromptApiProvider();
  
  const textWithConversationalPrefix = `Чтобы я мог найти ваши активные баги, я создал этот фильтр:
  {
    "where": {
      "logic": "AND",
      "rules": [
        { "field": "type", "op": "=", "value": "Bug" },
        { "field": "iteration", "op": "IN", "value": ["Project\\Sprint 1", "Project\\Sprint 2"] }
      ]
    }
  }
  Удачи!`;
  
  const extracted = provider.extractJSON(textWithConversationalPrefix);
  assert.doesNotThrow(() => JSON.parse(extracted));
  const parsed = JSON.parse(extracted);
  assert.strictEqual(parsed.where.logic, "AND");
  assert.strictEqual(parsed.where.rules[1].value[0], "Project\\Sprint 1");
  assert.strictEqual(parsed.where.rules[1].value[1], "Project\\Sprint 2");
});

test("AISearchService.extractJSON handles comments, single quotes, and trailing commas", () => {
  const service = global.aiSearchService;
  
  const textWithComplexIssues = `
  {
    'where': { // This is a comment
      'logic': 'AND',
      'rules': [
        { 'field': 'type', 'op': '=', 'value': 'Bug' }, /* another comment */
        { 'field': 'state', 'op': '=', 'value': 'Active' },
      ],
    }
  }
  `;
  
  const extracted = service.extractJSON(textWithComplexIssues);
  assert.doesNotThrow(() => JSON.parse(extracted));
  
  const parsed = JSON.parse(extracted);
  assert.strictEqual(parsed.where.logic, "AND");
  assert.strictEqual(parsed.where.rules.length, 2);
  assert.strictEqual(parsed.where.rules[0].field, "type");
  assert.strictEqual(parsed.where.rules[0].value, "Bug");
  assert.strictEqual(parsed.where.rules[1].value, "Active");
});

test("AISearchService.extractJSON balances brackets and ignores trailing conversational suffixes", () => {
  const service = global.aiSearchService;

  // Case 1: Truncated closing brace (regression test from user's bug report)
  const truncatedJSON = `{"where":{"logic":"AND","rules":[{"field":"type","op":"IN","value":["Task","Bug"]},{"field":"createddate","op":"RANGE","value":{"min":"@today-90...@today","max":"@today"}},{"field":"commentcount","op":"UNDER","value":0}]}`;
  
  const balanced = service.extractJSON(truncatedJSON);
  assert.doesNotThrow(() => JSON.parse(balanced));
  const parsed = JSON.parse(balanced);
  assert.strictEqual(parsed.where.rules.length, 3);
  assert.strictEqual(parsed.where.rules[2].field, "commentcount");

  // Case 2: Fully closed JSON followed by conversational suffix
  const JSONWithSuffix = `{"where":{"logic":"AND","rules":[]}} Hope this helps! Please apply this filter.`;
  const balanced2 = service.extractJSON(JSONWithSuffix);
  assert.strictEqual(balanced2, `{"where":{"logic":"AND","rules":[]}}`);
  assert.doesNotThrow(() => JSON.parse(balanced2));
});

test("AISearchService.determineReasoningLevel works correctly", () => {
  const service = global.aiSearchService;

  // Simple English queries
  assert.strictEqual(service.determineReasoningLevel("my active bugs"), "fast");
  assert.strictEqual(service.determineReasoningLevel("closed tasks"), "fast");

  // English queries with dates/sprints
  assert.strictEqual(service.determineReasoningLevel("bugs created in last week"), "balanced");
  assert.strictEqual(service.determineReasoningLevel("tasks for sprint 3"), "balanced");

  // English queries with logic
  assert.strictEqual(service.determineReasoningLevel("bugs or tasks"), "thorough");
  assert.strictEqual(service.determineReasoningLevel("active bugs except priority 1"), "thorough");

  // Russian/Cyrillic queries (automatically bypass Fast)
  assert.strictEqual(service.determineReasoningLevel("мои баги"), "balanced"); // default Cyrillic
  assert.strictEqual(service.determineReasoningLevel("задачи или баги"), "thorough"); // Cyrillic with logic

  // Non-English ASCII/European languages without explicit English keywords
  assert.strictEqual(service.determineReasoningLevel("bugs de ayer"), "balanced"); // goes to Balanced for translation
  assert.strictEqual(service.determineReasoningLevel("bugs o tareas"), "thorough"); // logic trigger 'o' -> thorough
});

test("AISearchService.search executes target pipelines based on reasoningLevel", async () => {
  const service = global.aiSearchService;
  
  // Set up mock provider
  let mockPromptJSONCalls = [];
  let mockSessionPrompts = [];
  let sessionDestroyed = false;

  const mockProvider = {
    id: "mock-provider",
    displayName: "Mock Provider",
    isSupported() { return true; },
    async getAvailability() { return "available"; },
    async promptJSON(system, user, schema, options) {
      mockPromptJSONCalls.push({ system, user });
      return { where: { logic: "AND", rules: [{ field: "type", op: "=", value: "Bug" }] } };
    },
    async createSession(system, options) {
      return {
        async prompt(message, promptOptions) {
          mockSessionPrompts.push(message);
          // Return field list for Turn 1
          if (message.includes("field classifier")) {
            return "type, state";
          }
          // Return structured text for Turn 2 in Thorough mode
          if (message.includes("search query enricher")) {
            return "- type: Bug\n- state: Active";
          }
          // Return JSON for JSON Compilation/Direct JSON
          return `{ "where": { "logic": "AND", "rules": [{ "field": "type", "op": "=", "value": "Bug" }] } }`;
        },
        destroy() {
          sessionDestroyed = true;
        }
      };
    }
  };

  // Temporarily register mock provider at top priority
  const registry = global.aiProviderRegistry;
  registry.providers.unshift(mockProvider);

  try {
    // 1. Test Fast mode (should call promptJSON)
    mockPromptJSONCalls = [];
    let result = await service.search("my bugs", { reasoningLevel: "fast" });
    assert.strictEqual(mockPromptJSONCalls.length, 1);
    assert.strictEqual(result.ir.where.rules[0].rules[0].field, "type");

    // 2. Test Balanced mode (should create session and run 2 prompts)
    mockSessionPrompts = [];
    sessionDestroyed = false;
    result = await service.search("my bugs", { reasoningLevel: "balanced" });
    assert.strictEqual(mockSessionPrompts.length, 2);
    assert.ok(mockSessionPrompts[0].includes("field classifier"));
    assert.ok(mockSessionPrompts[1].includes("JSON filter"));
    assert.strictEqual(sessionDestroyed, true);

    // 3. Test Thorough mode (should create session and run 3 prompts)
    mockSessionPrompts = [];
    sessionDestroyed = false;
    result = await service.search("my bugs", { reasoningLevel: "thorough" });
    assert.strictEqual(mockSessionPrompts.length, 3);
    assert.ok(mockSessionPrompts[0].includes("field classifier"));
    assert.ok(mockSessionPrompts[1].includes("search query enricher"));
    assert.ok(mockSessionPrompts[2].includes("structured query intent"));
    assert.strictEqual(sessionDestroyed, true);
  } finally {
    // Restore registry
    registry.providers.shift();
  }
});

test("AISearchService.normalizeValueDateMacros cleans date macros and range objects", () => {
  const service = global.aiSearchService;

  // Test simple macro renaming and conversion
  assert.strictEqual(service.normalizeDateMacro("@currentDate-3m"), "@today-90");
  assert.strictEqual(service.normalizeDateMacro("@today-2w"), "@today-14");
  assert.strictEqual(service.normalizeDateMacro("@today-90"), "@today-90"); // untouched

  // Test value normalizer on strings and ranges
  assert.strictEqual(service.normalizeValueDateMacros("@currentDate-3m"), "@today-90");
  assert.strictEqual(service.normalizeValueDateMacros("@today-3m...@today"), "@today-90...@today");
  assert.strictEqual(service.normalizeValueDateMacros("@today-90..."), "@today-90...@today");

  // Test value normalizer on nested objects (regression from user bug report)
  const nestedRangeObj = {
    min: "@today-90...@today",
    max: "@today"
  };
  assert.strictEqual(service.normalizeValueDateMacros(nestedRangeObj), "@today-90...@today");

  const nestedSplitRange = {
    min: "@currentDate-3m",
    max: "@today"
  };
  assert.strictEqual(service.normalizeValueDateMacros(nestedSplitRange), "@today-90...@today");
});

test("AISearchService.enrichIR forces RANGE operator for range values", async () => {
  const service = global.aiSearchService;
  const filterFields = [
    { id: "createddate", displayName: "Created Date", type: "date", operators: ["=", "<>", ">", "<", ">=", "<=", "RANGE"] }
  ];
  
  const rawIR = {
    where: {
      logic: "AND",
      rules: [
        { field: "createddate", op: "=", value: "@today-90...@today" }
      ]
    }
  };
  
  const warnings = [];
  const enriched = await service.enrichIR(rawIR, filterFields, warnings);
  
  const condition = enriched.rules[0].rules[0];
  assert.strictEqual(condition.field, "createddate");
  assert.strictEqual(condition.op, "RANGE");
  assert.strictEqual(condition.value, "@today-90...@today");

  // Test that RANGE operator is kept even if field metadata does not explicitly list RANGE operator
  const filterFieldsNoRange = [
    { id: "createddate", displayName: "Created Date", type: "date", operators: ["=", "<>", ">", "<", ">=", "<="] }
  ];
  const enrichedNoRange = await service.enrichIR(rawIR, filterFieldsNoRange, warnings);
  const conditionNoRange = enrichedNoRange.rules[0].rules[0];
  assert.strictEqual(conditionNoRange.op, "RANGE");
});

test("AISearchService.enrichIR distributes nested OR groups into separate AND cards", async () => {
  const service = global.aiSearchService;
  const filterFields = [
    { id: "type", type: "string", displayName: "Type", operators: ["="] },
    { id: "title", type: "string", displayName: "Title", operators: ["CONTAINS"] },
    { id: "tags", type: "tags", displayName: "Tags", operators: ["CONTAINS"] }
  ];
  
  const rawIR = {
    where: {
      logic: "AND",
      rules: [
        { field: "type", op: "=", value: "Bug" },
        {
          logic: "OR",
          rules: [
            { field: "title", op: "CONTAINS", value: "x" },
            { field: "tags", op: "CONTAINS", value: "y" }
          ]
        }
      ]
    }
  };
  
  const warnings = [];
  const enriched = await service.enrichIR(rawIR, filterFields, warnings);
  
  // Should produce 2 rules (cards) under the root OR group
  assert.strictEqual(enriched.logic, "OR");
  assert.strictEqual(enriched.rules.length, 2);
  
  // Card 1
  assert.strictEqual(enriched.rules[0].logic, "AND");
  assert.strictEqual(enriched.rules[0].rules.length, 2);
  assert.strictEqual(enriched.rules[0].rules[0].field, "type");
  assert.strictEqual(enriched.rules[0].rules[1].field, "title");
  
  // Card 2
  assert.strictEqual(enriched.rules[1].logic, "AND");
  assert.strictEqual(enriched.rules[1].rules.length, 2);
  assert.strictEqual(enriched.rules[1].rules[0].field, "type");
  assert.strictEqual(enriched.rules[1].rules[1].field, "tags");
});

test("AISearchService.enrichIR resolves short sprint/area path to full path", async () => {
  const service = global.aiSearchService;
  const filterFields = [
    {
      id: "iteration",
      displayName: "Sprint",
      type: "tree",
      allowedValues: ["MyProject\\Sprint 1 (current)", "MyProject\\Sprint 2", "MyProject\\Milestone 3\\Sprint A"]
    },
    {
      id: "area",
      displayName: "Area",
      type: "tree",
      allowedValues: ["MyProject\\Area 1", "MyProject\\SubTeam\\API"]
    }
  ];
  
  const rawIR = {
    where: {
      logic: "AND",
      rules: [
        { field: "iteration", op: "=", value: "Sprint 2" },
        { field: "area", op: "=", value: "API" }
      ]
    }
  };
  
  const enriched = await service.enrichIR(rawIR, filterFields, []);
  const card = enriched.rules[0];
  
  assert.strictEqual(card.rules[0].field, "iteration");
  assert.strictEqual(card.rules[0].value, "MyProject\\Sprint 2");
  
  assert.strictEqual(card.rules[1].field, "area");
  assert.strictEqual(card.rules[1].value, "MyProject\\SubTeam\\API");
});

test("AISearchService.enrichIR fuzzy matches closed list values (type, state)", async () => {
  const service = global.aiSearchService;
  const filterFields = [
    { id: "type", displayName: "Type", type: "string", allowedValues: ["Bug", "Task", "User Story"] },
    { id: "state", displayName: "State", type: "string", allowedValues: ["New", "Active", "Closed"] }
  ];
  
  const rawIR = {
    where: {
      logic: "AND",
      rules: [
        { field: "type", op: "=", value: "bug" },     // lowercase
        { field: "type", op: "=", value: "task" },    // lowercase
        { field: "state", op: "=", value: "active" }  // lowercase
      ]
    }
  };
  
  const enriched = await service.enrichIR(rawIR, filterFields, []);
  const card = enriched.rules[0];
  
  assert.strictEqual(card.rules[0].value, "Bug");
  assert.strictEqual(card.rules[1].value, "Task");
  assert.strictEqual(card.rules[2].value, "Active");
});

test("AISearchService.enrichIR normalizes arrays and single items for IN operator", async () => {
  const service = global.aiSearchService;
  const filterFields = [
    { id: "type", displayName: "Type", type: "string", operators: ["=", "IN"] }
  ];
  
  // Case 1: IN with single value should simplify to =
  const rawIR1 = {
    where: {
      logic: "AND",
      rules: [{ field: "type", op: "IN", value: ["Bug"] }]
    }
  };
  const enriched1 = await service.enrichIR(rawIR1, filterFields, []);
  assert.strictEqual(enriched1.rules[0].rules[0].op, "=");
  assert.strictEqual(enriched1.rules[0].rules[0].value, "Bug");

  // Case 2: = with array value should convert to IN
  const rawIR2 = {
    where: {
      logic: "AND",
      rules: [{ field: "type", op: "=", value: ["Bug", "Task"] }]
    }
  };
  const enriched2 = await service.enrichIR(rawIR2, filterFields, []);
  assert.strictEqual(enriched2.rules[0].rules[0].op, "IN");
  assert.deepStrictEqual(enriched2.rules[0].rules[0].value, ["Bug", "Task"]);

  // Case 3: IN with string value should convert to array
  const rawIR3 = {
    where: {
      logic: "AND",
      rules: [{ field: "type", op: "IN", value: "Bug" }]
    }
  };
  const enriched3 = await service.enrichIR(rawIR3, filterFields, []);
  assert.strictEqual(enriched3.rules[0].rules[0].op, "=");
  assert.strictEqual(enriched3.rules[0].rules[0].value, "Bug");
});

test("AISearchService.enrichIR handles hallucinated filters array format and normalizes dates", async () => {
  const service = global.aiSearchService;
  const filterFields = [
    { id: "type", displayName: "Type", type: "string", allowedValues: ["Bug", "Task"] },
    { id: "state", displayName: "State", type: "string", allowedValues: ["New", "Resolved", "Closed"] },
    { id: "assigned", displayName: "Assigned", type: "user" },
    { id: "createddate", displayName: "Created Date", type: "date", operators: ["=", "<>", ">", "<", "RANGE"] }
  ];

  // The exact hallucinated structure returned by the model
  const rawIR = {
    filters: [
      { type: "Bug", operator: "=", value: "Bug" },
      { state: "Resolved", operator: "=", value: "Resolved" },
      { assigned: ["@me", "Aleksei Bezruk"] },
      { createddate: { operator: "<", value: "@today-2mo" } }
    ]
  };

  const enriched = await service.enrichIR(rawIR, filterFields, []);

  assert.strictEqual(enriched.logic, "OR");
  assert.strictEqual(enriched.rules.length, 1);
  const card = enriched.rules[0];
  assert.strictEqual(card.logic, "AND");
  assert.strictEqual(card.rules.length, 4);

  // Rule 0: type
  assert.strictEqual(card.rules[0].field, "type");
  assert.strictEqual(card.rules[0].op, "=");
  assert.strictEqual(card.rules[0].value, "Bug");

  // Rule 1: state
  assert.strictEqual(card.rules[1].field, "state");
  assert.strictEqual(card.rules[1].op, "=");
  assert.strictEqual(card.rules[1].value, "Resolved");

  // Rule 2: assigned (should retain array and keep IN operator since it's an array of length > 1)
  assert.strictEqual(card.rules[2].field, "assigned");
  assert.strictEqual(card.rules[2].op, "IN");
  assert.deepStrictEqual(card.rules[2].value, ["@me", "Aleksei Bezruk"]);

  // Rule 3: createddate (operator translated, value date macro normalized from @today-2mo to @today-60)
  assert.strictEqual(card.rules[3].field, "createddate");
  assert.strictEqual(card.rules[3].op, "<");
  assert.strictEqual(card.rules[3].value, "@today-60");
});

test("AISearchService.enrichIR resolves transliterated assignee names and merges matchedDates", async () => {
  const service = global.aiSearchService;
  const filterFields = [
    { id: "type", type: "string", allowedValues: ["Bug", "Task"] },
    { id: "state", type: "string", allowedValues: ["New", "Resolved"] },
    { id: "assigned", type: "user" },
    { id: "due", type: "date", operators: ["=", "<>", ">", "<", "RANGE"] }
  ];

  // Raw IR with Russian nickname and split date rules (the exact case from user)
  const rawIR = {
    where: {
      logic: "AND",
      rules: [
        { field: "type", op: "=", value: "Bug" },
        { field: "state", op: "=", value: "Resolved" },
        { field: "assigned", op: "IN", value: ["@me", "Леху Б"] },
        { field: "due", op: "<=", value: "@today-60...@today" },
        { field: "due", op: ">=", value: "@today-30...@today-60" }
      ]
    }
  };

  const matchedAssignees = { "меня": "@me", "Леху Б": "Aleksei Bezruk" };
  const matchedDates = { due: "@today-60...@today-30" };

  const enriched = await service.enrichIR(rawIR, filterFields, [], { matchedAssignees, matchedDates });

  assert.strictEqual(enriched.logic, "OR");
  const card = enriched.rules[0];
  assert.strictEqual(card.logic, "AND");
  assert.strictEqual(card.rules.length, 4); // type, state, assigned, due (duplicates consolidated)

  // Assigned should be resolved to Aleksei Bezruk
  assert.strictEqual(card.rules[2].field, "assigned");
  assert.strictEqual(card.rules[2].op, "IN");
  assert.deepStrictEqual(card.rules[2].value, ["@me", "Aleksei Bezruk"]);

  // Due should be consolidated into one RANGE rule with correct matched range value
  assert.strictEqual(card.rules[3].field, "due");
  assert.strictEqual(card.rules[3].op, "RANGE");
  assert.strictEqual(card.rules[3].value, "@today-60...@today-30");
});

test("AISearchService.enrichIR handles identity keys mapping to multiple assignees (arrays)", async () => {
  const service = global.aiSearchService;
  const filterFields = [
    { id: "type", type: "string" },
    { id: "assigned", type: "user" }
  ];

  // Raw IR with single mention of "Alex"
  const rawIR = {
    where: {
      logic: "AND",
      rules: [
        { field: "type", op: "=", value: "Bug" },
        { field: "assigned", op: "=", value: "Alex" }
      ]
    }
  };

  const matchedAssignees = { "Alex": ["Alexander Ivanov", "Alexander Smith"] };

  const enriched = await service.enrichIR(rawIR, filterFields, [], { matchedAssignees });

  const card = enriched.rules[0];
  assert.strictEqual(card.rules.length, 2);

  // Assigned should be expanded to both names, and operator resolved to IN
  assert.strictEqual(card.rules[1].field, "assigned");
  assert.strictEqual(card.rules[1].op, "IN");
  assert.deepStrictEqual(card.rules[1].value, ["Alexander Ivanov", "Alexander Smith"]);
});

(async () => {
  // Wait a short time for any async tests to print their output
  setTimeout(() => {
    console.log(`\nAI Tests completed: ${pass} passed, ${fail} failed`);
    if (fail > 0) process.exit(1);
  }, 100);
})();


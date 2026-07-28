// Unit tests for LinearProvider (#64, #69)
const assert = require('node:assert');
const path = require('node:path');

// Mock browser globals for node execution
global.window = global;
global.self = global;
global.AdoLib = require(path.join(__dirname, '../src/core/lib.js'));
global.FilterCompiler = require(path.join(__dirname, '../src/core/filter-compiler.js'));

// Load backend registry & LinearProvider
require(path.join(__dirname, '../src/app/backend.js'));
require(path.join(__dirname, '../src/core/api/linear-provider.js'));

const LinearProvider = global.LinearProvider;
const App = global.App;

console.log('Running LinearProvider tests...');

// 1. Meta and descriptors
assert.strictEqual(LinearProvider.meta.id, 'linear');
assert.strictEqual(LinearProvider.meta.label, 'Linear');
assert.strictEqual(LinearProvider.capabilities.sprints, true);
assert.strictEqual(LinearProvider.capabilities.hierarchy, true);
assert.strictEqual(LinearProvider.capabilities.states, 'enum');
assert.strictEqual(LinearProvider.terms.sprint, 'cycle');
assert.strictEqual(LinearProvider.terms.item, 'issue');
console.log('  ok   LinearProvider meta and capabilities verified');

// 2. ID helpers
assert.strictEqual(LinearProvider.gid('ENG-123'), 'linear:ENG-123');
assert.strictEqual(LinearProvider.gid('linear:ENG-123'), 'linear:ENG-123');
assert.strictEqual(LinearProvider.nid('linear:ENG-123'), 'ENG-123');
assert.strictEqual(LinearProvider.nid('ENG-123'), 'ENG-123');
console.log('  ok   LinearProvider composite ID helpers verified');

// 3. State category mapping
assert.strictEqual(LinearProvider.mapStateCategory('backlog'), 'proposed');
assert.strictEqual(LinearProvider.mapStateCategory('unstarted'), 'proposed');
assert.strictEqual(LinearProvider.mapStateCategory('started'), 'inprogress');
assert.strictEqual(LinearProvider.mapStateCategory('completed'), 'completed');
assert.strictEqual(LinearProvider.mapStateCategory('canceled'), 'removed');
console.log('  ok   LinearProvider workflow state category mapping verified');

// 4. Item mapper (Linear issue -> canonical item schema)
const mockLinearIssue = {
  id: 'issue-uuid-1',
  identifier: 'ENG-456',
  title: 'Fix auth token refresh',
  description: 'Bug description',
  priority: 1,
  estimate: 3,
  dueDate: '2026-08-15',
  createdAt: '2026-07-20T10:00:00Z',
  updatedAt: '2026-07-25T12:00:00Z',
  url: 'https://linear.app/issue/ENG-456',
  state: { id: 'state-1', name: 'In Progress', type: 'started' },
  assignee: { id: 'user-1', name: 'Alice Smith', email: 'alice@example.com' },
  cycle: { id: 'cycle-1', number: 12, name: 'Cycle 12' },
  team: { id: 'team-1', name: 'Engineering', key: 'ENG' },
  parent: { id: 'issue-uuid-0', identifier: 'ENG-100' },
  labels: { nodes: [{ id: 'l1', name: 'Bug' }] },
};

const mapped = LinearProvider.mapLinearIssue(mockLinearIssue);
assert.strictEqual(mapped.id, 'linear:issue-uuid-1');
assert.strictEqual(mapped.nativeId, 'ENG-456');
assert.strictEqual(mapped.title, 'Fix auth token refresh');
assert.strictEqual(mapped.state, 'In Progress');
assert.strictEqual(mapped.stateCategory, 'inprogress');
assert.strictEqual(mapped.assigned, 'Alice Smith');
assert.strictEqual(mapped.iteration, 'Cycle 12');
assert.strictEqual(mapped.area, 'Engineering');
assert.strictEqual(mapped.priority, 1);
assert.strictEqual(mapped.points, 3);
assert.strictEqual(mapped.type, 'Bug');
assert.strictEqual(mapped.parent, 'linear:issue-uuid-0');
console.log('  ok   Linear issue to canonical node mapping verified');

// 5. FilterCompiler for LinearGraphQL
const fieldsSpec = {
  title: { id: 'title', type: 'string' },
  state: { id: 'state', type: 'string' },
  assignee: { id: 'assignee', type: 'identity' },
  priority: { id: 'priority', type: 'integer' },
};

const ast = {
  where: {
    type: 'logical',
    op: 'AND',
    children: [
      { type: 'comparison', field: 'title', op: 'CONTAINS', values: [{ type: 'literal', value: 'auth' }] },
      { type: 'comparison', field: 'priority', op: '=', values: [{ type: 'literal', value: '1' }] },
    ],
  },
};

const filterObj = global.FilterCompiler.compile(ast, fieldsSpec, 'LinearGraphQL');
assert.deepStrictEqual(filterObj, {
  title: { containsIgnoreCase: 'auth' },
  priority: { eq: 1 },
});
console.log('  ok   FilterCompiler LinearGraphQL filter compilation verified');

// 6. Provider registration check
assert.strictEqual(App.backend.get('linear'), LinearProvider);
console.log('  ok   LinearProvider registered in App.backend');

// 7. FilterCompiler delegation via active provider contract
App.backend.setActive('linear');
const delegatedFilterObj = global.FilterCompiler.compile(ast, fieldsSpec);
assert.deepStrictEqual(delegatedFilterObj, {
  title: { containsIgnoreCase: 'auth' },
  priority: { eq: 1 },
});
console.log('  ok   FilterCompiler delegation to active provider compileFilter verified');

console.log('LinearProvider tests completed: 7 passed, 0 failed');

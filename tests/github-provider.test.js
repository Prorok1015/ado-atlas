// Unit tests for GitHubProvider (#64, #69)
const assert = require('node:assert');
const path = require('node:path');

// Mock browser globals for node execution
global.window = global;
global.self = global;
global.AdoLib = require(path.join(__dirname, '../src/core/lib.js'));
global.FilterCompiler = require(path.join(__dirname, '../src/core/filter-compiler.js'));

// Load backend registry & GitHubProvider
require(path.join(__dirname, '../src/app/backend.js'));
require(path.join(__dirname, '../src/core/api/github-provider.js'));

const GitHubProvider = global.GitHubProvider;
const App = global.App;

console.log('Running GitHubProvider tests...');

// 1. Meta and capabilities
assert.strictEqual(GitHubProvider.meta.id, 'github');
assert.strictEqual(GitHubProvider.meta.label, 'GitHub Issues');
assert.strictEqual(GitHubProvider.capabilities.sprints, true);
assert.strictEqual(GitHubProvider.capabilities.areas, true);
assert.strictEqual(GitHubProvider.terms.sprint, 'milestone');
assert.strictEqual(GitHubProvider.terms.item, 'issue');
console.log('  ok   GitHubProvider meta and capabilities verified');

// 2. ID helpers
assert.strictEqual(GitHubProvider.gid('octocat/Hello-World/123'), 'github:octocat/Hello-World/123');
assert.strictEqual(GitHubProvider.gid('github:octocat/Hello-World/123'), 'github:octocat/Hello-World/123');
assert.strictEqual(GitHubProvider.nid('github:octocat/Hello-World/123'), '123');
assert.strictEqual(GitHubProvider.nid('123'), '123');
console.log('  ok   GitHubProvider composite ID helpers verified');

// 3. State category mapping
assert.strictEqual(GitHubProvider.mapStateCategory('open'), 'inprogress');
assert.strictEqual(GitHubProvider.mapStateCategory('closed', 'completed'), 'completed');
assert.strictEqual(GitHubProvider.mapStateCategory('closed', 'not_planned'), 'removed');
console.log('  ok   GitHubProvider state category mapping verified');

// 4. Item mapper (GitHub issue -> canonical item schema)
const mockGitHubIssue = {
  number: 42,
  title: 'Bug in authentication token storage',
  body: 'Full issue description here',
  state: 'open',
  state_reason: null,
  html_url: 'https://github.com/octocat/Hello-World/issues/42',
  repository_url: 'https://api.github.com/repos/octocat/Hello-World',
  assignee: { login: 'octocat' },
  milestone: { title: 'v1.0 Release', due_on: '2026-09-01T00:00:00Z' },
  labels: [{ name: 'bug' }, { name: 'security' }],
  created_at: '2026-07-20T10:00:00Z',
  updated_at: '2026-07-25T12:00:00Z',
};

const mapped = GitHubProvider.mapGitHubIssue(mockGitHubIssue);
assert.strictEqual(mapped.id, 'github:octocat/Hello-World/42');
assert.strictEqual(mapped.nativeId, '#42');
assert.strictEqual(mapped.title, 'Bug in authentication token storage');
assert.strictEqual(mapped.state, 'open');
assert.strictEqual(mapped.stateCategory, 'inprogress');
assert.strictEqual(mapped.assigned, 'octocat');
assert.strictEqual(mapped.iteration, 'v1.0 Release');
assert.strictEqual(mapped.area, 'octocat/Hello-World');
assert.strictEqual(mapped.type, 'bug');
assert.deepStrictEqual(mapped.tags, ['bug', 'security']);
console.log('  ok   GitHub issue to canonical node mapping verified');

// 5. FilterCompiler for GitHubBackend
const fieldsSpec = {
  title: { id: 'title', type: 'string' },
  state: { id: 'state', type: 'string' },
  assignee: { id: 'assignee', type: 'identity' },
  label: { id: 'tag', type: 'string' },
};

const ast = {
  where: {
    type: 'logical',
    op: 'AND',
    children: [
      { type: 'comparison', field: 'state', op: '=', values: [{ type: 'literal', value: 'open' }] },
      { type: 'comparison', field: 'assignee', op: '=', values: [{ type: 'literal', value: 'octocat' }] },
      { type: 'comparison', field: 'tag', op: '=', values: [{ type: 'literal', value: 'bug' }] },
    ],
  },
};

const filterQuery = global.FilterCompiler.compile(ast, fieldsSpec, GitHubProvider);
assert.strictEqual(filterQuery, 'is:open assignee:octocat label:"bug"');
console.log('  ok   Polymorphic GitHub search query compilation verified');

// 6. Provider registration check
assert.strictEqual(App.backend.get('github'), GitHubProvider);
console.log('  ok   GitHubProvider registered in App.backend');

// 7. OAuth config test
(async () => {
  await GitHubProvider.setConfig({
    authMode: 'oauth',
    oauthClientId: 'gh-client-999',
    owner: 'octocat',
    repo: 'Hello-World',
  });
  const cfg = await GitHubProvider.getConfig();
  assert.strictEqual(cfg.authMode, 'oauth');
  assert.strictEqual(cfg.oauthClientId, 'gh-client-999');
  assert.strictEqual(cfg.owner, 'octocat');
  assert.strictEqual(cfg.repo, 'Hello-World');
  assert.strictEqual(typeof GitHubProvider.oauthRedirectUri(), 'string');
  console.log('  ok   GitHubProvider configuration and redirect URI verified');
  console.log('GitHubProvider tests completed: 7 passed, 0 failed');
})();

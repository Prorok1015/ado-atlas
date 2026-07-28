// Linear Tracker Provider (linear.app GraphQL API).
// Fulfills the Provider contract (BACKEND_PROVIDER_SPEC / #64 / #69).

(function (global) {
  'use strict';

  const App = global.App = global.App || {};

  const ENDPOINT = 'https://api.linear.app/graphql';
  const OAUTH_AUTHORIZE_URL = 'https://linear.app/oauth/authorize';
  const OAUTH_TOKEN_URL = 'https://api.linear.app/oauth/token';

  function getDefaultClientId() {
    return (App.OAUTH_CONFIG && App.OAUTH_CONFIG.linear && App.OAUTH_CONFIG.linear.clientId) || 'YOUR_LINEAR_CLIENT_ID';
  }

  // Config storage keys in chrome.storage.local
  const CONFIG_KEY = 'linear_provider_config';

  let _config = {
    authMode: 'api_key', // 'api_key' | 'oauth'
    apiKey: '',
    teamId: '',
    oauthClientId: '',
    oauthClientSecret: '',
    oauthAccessToken: '',
    oauthRefreshToken: '',
    oauthExpiresAt: 0,
  };

  // Helper to get composite global ID and native ID
  function gid(nativeId) {
    if (!nativeId) return '';
    const s = String(nativeId);
    if (s.indexOf(':') >= 0) return s;
    const L = global.AdoLib;
    return L ? L.gidMake('linear', s) : ('linear:' + s);
  }

  function nid(gidValue) {
    if (!gidValue) return '';
    const L = global.AdoLib;
    return L ? L.gidNative(gidValue) : String(gidValue).replace(/^linear:/, '');
  }

  // Linear WorkflowState.type -> canonical stateCategory
  function mapStateCategory(type) {
    if (!type) return 'proposed';
    const t = String(type).toLowerCase();
    if (t === 'completed') return 'completed';
    if (t === 'started') return 'inprogress';
    if (t === 'canceled' || t === 'cancelled') return 'removed';
    if (t === 'backlog' || t === 'unstarted' || t === 'triage') return 'proposed';
    return 'proposed';
  }

  function oauthRedirectUri() {
    if (typeof chrome !== 'undefined' && chrome.identity && chrome.identity.getRedirectURL) {
      return chrome.identity.getRedirectURL();
    }
    return '';
  }

  // Generate random URL-safe base64 string
  function randB64Url(len = 16) {
    const arr = new Uint8Array(len);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      crypto.getRandomValues(arr);
    } else {
      for (let i = 0; i < len; i++) arr[i] = Math.floor(Math.random() * 256);
    }
    let str = '';
    for (let i = 0; i < len; i++) str += String.fromCharCode(arr[i]);
    const b64 = typeof btoa === 'function' ? btoa(str) : Buffer.from(arr).toString('base64');
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // Execute raw GraphQL request to Linear API
  async function graphqlRequest(query, variables = {}, apiKeyOverride = null) {
    let authHeader = '';

    if (apiKeyOverride) {
      authHeader = apiKeyOverride.trim();
    } else if (_config.authMode === 'oauth' || _config.oauthAccessToken) {
      authHeader = `Bearer ${_config.oauthAccessToken.trim()}`;
    } else {
      const key = _config.apiKey;
      if (!key) {
        throw new Error('Linear API key is not configured.');
      }
      authHeader = key.trim(); // Personal API key: NO 'Bearer' prefix
    }

    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        throw new Error('Linear API rate limit exceeded (HTTP 429).');
      }
      throw new Error(`Linear API HTTP error ${response.status}: ${response.statusText}`);
    }

    const json = await response.json();
    if (json.errors && json.errors.length > 0) {
      const err = json.errors[0];
      if (err.userError || err.message) {
        throw new Error(`Linear GraphQL error: ${err.message || err.userError}`);
      }
      throw new Error('Linear GraphQL request failed.');
    }

    return json.data;
  }

  // Map raw Linear issue GraphQL node -> canonical node schema
  function mapLinearIssue(issue) {
    if (!issue) return null;

    const rawId = issue.id || issue.identifier;
    const itemGid = gid(rawId);

    const labels = issue.labels && issue.labels.nodes ? issue.labels.nodes.map(l => l.name) : [];
    const primaryType = labels.length > 0 ? labels[0] : 'Issue';

    const parentGid = issue.parent && issue.parent.id ? gid(issue.parent.id) : null;
    const cycleName = issue.cycle ? (issue.cycle.name || `Cycle ${issue.cycle.number}`) : '';
    const teamName = issue.team ? issue.team.name : (issue.project ? issue.project.name : '');
    const assigneeName = issue.assignee ? (issue.assignee.name || issue.assignee.email) : '';

    const stateName = issue.state ? issue.state.name : 'Backlog';
    const stateType = issue.state ? issue.state.type : 'backlog';
    const category = mapStateCategory(stateType);

    return {
      id: itemGid,
      nativeId: issue.identifier || issue.id,
      title: issue.title || '',
      state: stateName,
      stateCategory: category,
      type: primaryType,
      assigned: assigneeName,
      assignee: assigneeName,
      iteration: cycleName,
      area: teamName,
      priority: issue.priority != null ? issue.priority : 0,
      points: issue.estimate != null ? issue.estimate : 0,
      dueDate: issue.dueDate || null,
      createdDate: issue.createdAt || null,
      updatedDate: issue.updatedAt || null,
      url: issue.url || `https://linear.app/issue/${issue.identifier || issue.id}`,
      parent: parentGid,
      rev: issue.updatedAt ? new Date(issue.updatedAt).getTime() : 1,
      tags: labels,
      description: issue.description || '',
    };
  }

  // Issue query fragment
  const ISSUE_FRAGMENT = `
    id
    identifier
    title
    description
    priority
    estimate
    dueDate
    createdAt
    updatedAt
    url
    state {
      id
      name
      type
    }
    assignee {
      id
      name
      email
    }
    cycle {
      id
      number
      name
    }
    team {
      id
      name
      key
    }
    project {
      id
      name
    }
    parent {
      id
      identifier
    }
    labels {
      nodes {
        id
        name
      }
    }
  `;

  const LinearBackend = {
    generate(irNode, fieldsMap) {
      if (!irNode) return {};
      if (irNode.type === 'logical') {
        const clauses = (irNode.children || []).map(child => this.generate(child, fieldsMap)).filter(c => Object.keys(c).length > 0);
        if (clauses.length === 0) return {};
        if (irNode.op === 'AND') {
          return clauses.reduce((acc, c) => ({ ...acc, ...c }), {});
        }
        if (irNode.op === 'OR') {
          return { or: clauses };
        }
      }
      if (irNode.type === 'comparison') {
        const fieldName = (irNode.field || '').toLowerCase();
        const op = (irNode.op || '=').toUpperCase();
        const valObj = (irNode.values && irNode.values[0]) || {};
        const val = valObj.value !== undefined ? valObj.value : valObj.raw;

        if (fieldName === 'title' || fieldName === 'summary') {
          if (op === 'CONTAINS') return { title: { containsIgnoreCase: String(val) } };
          return { title: { eq: String(val) } };
        }
        if (fieldName === 'state' || fieldName === 'status') {
          return { state: { name: { eq: String(val) } } };
        }
        if (fieldName === 'assignee' || fieldName === 'assignedto') {
          return { assignee: { name: { containsIgnoreCase: String(val) } } };
        }
        if (fieldName === 'priority') {
          return { priority: { eq: Number(val) } };
        }
        if (fieldName === 'estimate' || fieldName === 'points') {
          return { estimate: { eq: Number(val) } };
        }
        if (fieldName === 'cycle' || fieldName === 'sprint' || fieldName === 'iteration') {
          return { cycle: { name: { eq: String(val) } } };
        }
        if (fieldName === 'team' || fieldName === 'area') {
          return { team: { name: { eq: String(val) } } };
        }
      }
      return {};
    }
  };

  // Linear Provider definition
  const LinearProvider = {
    meta: {
      id: 'linear',
      label: 'Linear',
      icon: 'linear',
      endpoint: ENDPOINT,
    },

    capabilities: {
      hierarchy: true,
      sprints: true,
      dependencies: true,
      states: 'enum',
      points: true,
      timeTracking: false,
      attachments: true,
      mentions: false,
      reactions: false,
      history: false,
      customFields: false,
      areas: true,
    },

    terms: {
      item: 'issue',
      items: 'issues',
      sprint: 'cycle',
      sprints: 'cycles',
      type: 'label',
      state: 'state',
      assignee: 'assignee',
      area: 'team',
      tag: 'label',
    },

    connectionSchema: [
      { key: 'authMode', type: 'enum', options: ['api_key', 'oauth'], label: 'Auth Mode', required: true },
      { key: 'apiKey', type: 'string', label: 'Personal API Key', secret: true, required: false },
      { key: 'oauthClientId', type: 'string', label: 'OAuth Client ID', secret: false, required: false },
      { key: 'oauthClientSecret', type: 'string', label: 'OAuth Client Secret', secret: true, required: false },
      { key: 'teamId', type: 'string', label: 'Team Key / ID (Optional)', secret: false, required: false },
    ],

    fieldSchema: {
      id: { id: 'id', name: 'ID', type: 'string', isCore: true },
      title: { id: 'title', name: 'Title', type: 'string', isCore: true },
      state: { id: 'state', name: 'State', type: 'string', isCore: true },
      assignee: { id: 'assignee', name: 'Assignee', type: 'string', isCore: true },
      cycle: { id: 'cycle', name: 'Cycle', type: 'string', isCore: true },
      team: { id: 'team', name: 'Team', type: 'string', isCore: true },
      priority: { id: 'priority', name: 'Priority', type: 'number', isCore: true },
      estimate: { id: 'estimate', name: 'Estimate', type: 'number', isCore: true },
    },

    // ID helpers
    gid(nativeId) { return gid(nativeId); },
    nid(gidValue) { return nid(gidValue); },
    mapStateCategory(type) { return mapStateCategory(type); },
    mapLinearIssue(issue) { return mapLinearIssue(issue); },
    oauthRedirectUri() { return oauthRedirectUri(); },

    // Configuration
    async getConfig() {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        return new Promise((resolve) => {
          chrome.storage.local.get([CONFIG_KEY], (res) => {
            if (res && res[CONFIG_KEY]) {
              _config = { ..._config, ...res[CONFIG_KEY] };
            }
            resolve({ ..._config });
          });
        });
      }
      return { ..._config };
    },

    async setConfig(cfg) {
      _config = { ..._config, ...cfg };
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        await new Promise((resolve) => {
          chrome.storage.local.set({ [CONFIG_KEY]: _config }, resolve);
        });
      }
      return true;
    },

    async clearConfig() {
      _config = {
        authMode: 'api_key',
        apiKey: '',
        teamId: '',
        oauthClientId: '',
        oauthClientSecret: '',
        oauthAccessToken: '',
        oauthRefreshToken: '',
        oauthExpiresAt: 0,
      };
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        await new Promise((resolve) => {
          chrome.storage.local.remove([CONFIG_KEY], resolve);
        });
      }
      return true;
    },

    // OAuth2 Interactive Sign-in
    async oauthSignIn(clientId = '', clientSecret = '') {
      clientId = (clientId || '').trim() || getDefaultClientId();
      clientSecret = (clientSecret || '').trim();
      if (!clientId || clientId === 'YOUR_LINEAR_CLIENT_ID') {
        throw new Error('Enter an OAuth Client ID or configure App.OAUTH_CONFIG.linear.clientId in src/app/oauth-config.js.');
      }

      const redirectUri = oauthRedirectUri();
      const state = randB64Url(16);

      const authUrl = `${OAUTH_AUTHORIZE_URL}?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=read,write&state=${encodeURIComponent(state)}&prompt=consent`;

      const redirect = await new Promise((resolve, reject) => {
        if (typeof chrome === 'undefined' || !chrome.identity || !chrome.identity.launchWebAuthFlow) {
          return reject(new Error('chrome.identity WebAuthFlow is not available.'));
        }
        chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, (redirectResult) => {
          const err = chrome.runtime.lastError;
          if (err || !redirectResult) {
            return reject(new Error((err && err.message) ? err.message : 'Sign-in was cancelled'));
          }
          resolve(redirectResult);
        });
      });

      // Parse code and state from redirect URL
      const urlObj = new URL(redirect);
      const code = urlObj.searchParams.get('code');
      const returnedState = urlObj.searchParams.get('state');
      const errorMsg = urlObj.searchParams.get('error_description') || urlObj.searchParams.get('error');

      if (errorMsg) throw new Error(`Linear OAuth error: ${errorMsg}`);
      if (!code || returnedState !== state) throw new Error('Linear OAuth failed (code missing or state mismatch).');

      // Exchange code for token
      const params = new URLSearchParams();
      params.append('grant_type', 'authorization_code');
      params.append('client_id', clientId);
      if (clientSecret) params.append('client_secret', clientSecret);
      params.append('code', code);
      params.append('redirect_uri', redirectUri);

      const tokenResp = await fetch(OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });

      if (!tokenResp.ok) {
        const text = await tokenResp.text();
        throw new Error(`Linear token request failed (${tokenResp.status}): ${text.slice(0, 200)}`);
      }

      const tok = await tokenResp.json();
      if (!tok.access_token) {
        throw new Error('Linear OAuth token response contained no access_token.');
      }

      await this.setConfig({
        authMode: 'oauth',
        oauthClientId: clientId,
        oauthClientSecret: clientSecret,
        oauthAccessToken: tok.access_token,
        oauthRefreshToken: tok.refresh_token || '',
        oauthExpiresAt: Date.now() + ((tok.expires_in || 3600 * 24 * 30) * 1000),
      });

      return await this.me();
    },

    // Query Compilation
    compileFilter(ir, fieldsMap) {
      return LinearBackend.generate(ir, fieldsMap);
    },

    // Authenticated user check
    async me() {
      const q = `query { viewer { id name email } }`;
      const data = await graphqlRequest(q);
      return data.viewer;
    },

    // Work item operations
    async item(id) {
      const nativeId = nid(id);
      const q = `
        query GetIssue($id: String!) {
          issue(id: $id) {
            ${ISSUE_FRAGMENT}
          }
        }
      `;
      const data = await graphqlRequest(q, { id: nativeId });
      return mapLinearIssue(data.issue);
    },

    async roots({ filters, text } = {}) {
      return this.list({ filters, text, first: 100 });
    },

    async search({ text, filters } = {}) {
      return this.list({ text, filters, first: 100 });
    },

    async list({ text, filters, parent, first = 100 } = {}) {
      let filterObj = {};
      if (parent) {
        filterObj.parent = { id: { eq: nid(parent) } };
      }
      if (text) {
        filterObj.title = { containsIgnoreCase: text };
      }

      const q = `
        query ListIssues($filter: IssueFilter, $first: Int) {
          issues(filter: $filter, first: $first) {
            nodes {
              ${ISSUE_FRAGMENT}
            }
          }
        }
      `;
      const data = await graphqlRequest(q, { filter: filterObj, first });
      const nodes = (data.issues && data.issues.nodes) || [];
      return nodes.map(mapLinearIssue);
    },

    async children(parentId) {
      return this.list({ parent: parentId });
    },

    async parents(ids) {
      if (!ids || ids.length === 0) return {};
      const nativeIds = ids.map(nid);
      const q = `
        query GetIssuesParents($filter: IssueFilter) {
          issues(filter: $filter) {
            nodes {
              id
              identifier
              parent {
                id
                identifier
              }
            }
          }
        }
      `;
      const data = await graphqlRequest(q, { filter: { id: { in: nativeIds } } });
      const nodes = (data.issues && data.issues.nodes) || [];
      const res = {};
      for (const node of nodes) {
        const itemGid = gid(node.id);
        res[itemGid] = node.parent ? gid(node.parent.id) : null;
      }
      return res;
    },

    async updateItem(id, fields) {
      const nativeId = nid(id);
      const input = {};

      if (fields.title !== undefined) input.title = fields.title;
      if (fields.description !== undefined) input.description = fields.description;
      if (fields.priority !== undefined) input.priority = Number(fields.priority);
      if (fields.estimate !== undefined || fields.points !== undefined) {
        input.estimate = Number(fields.estimate !== undefined ? fields.estimate : fields.points);
      }
      if (fields.dueDate !== undefined) input.dueDate = fields.dueDate;

      const q = `
        mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) {
            success
            issue {
              ${ISSUE_FRAGMENT}
            }
          }
        }
      `;
      const data = await graphqlRequest(q, { id: nativeId, input });
      if (!data.issueUpdate || !data.issueUpdate.success) {
        throw new Error(`Failed to update Linear issue #${nativeId}`);
      }
      return mapLinearIssue(data.issueUpdate.issue);
    },

    async createItem({ title, teamId, description, priority, estimate }) {
      const input = {
        title: title || 'New Issue',
        teamId: teamId || _config.teamId,
      };
      if (description) input.description = description;
      if (priority != null) input.priority = Number(priority);
      if (estimate != null) input.estimate = Number(estimate);

      const q = `
        mutation CreateIssue($input: IssueCreateInput!) {
          issueCreate(input: $input) {
            success
            issue {
              ${ISSUE_FRAGMENT}
            }
          }
        }
      `;
      const data = await graphqlRequest(q, { input });
      if (!data.issueCreate || !data.issueCreate.success) {
        throw new Error('Failed to create Linear issue.');
      }
      return mapLinearIssue(data.issueCreate.issue);
    },

    async deleteItem(id) {
      const nativeId = nid(id);
      const q = `
        mutation DeleteIssue($id: String!) {
          issueDelete(id: $id) {
            success
          }
        }
      `;
      const data = await graphqlRequest(q, { id: nativeId });
      return data.issueDelete && data.issueDelete.success;
    },

    // Metadata queries
    async states() {
      const q = `
        query GetWorkflowStates {
          workflowStates {
            nodes {
              id
              name
              type
              color
            }
          }
        }
      `;
      const data = await graphqlRequest(q);
      return (data.workflowStates && data.workflowStates.nodes) || [];
    },

    async iterations() {
      const q = `
        query GetCycles {
          cycles {
            nodes {
              id
              number
              name
              startsAt
              endsAt
            }
          }
        }
      `;
      const data = await graphqlRequest(q);
      const nodes = (data.cycles && data.cycles.nodes) || [];
      return nodes.map(c => ({
        id: c.id,
        name: c.name || `Cycle ${c.number}`,
        startDate: c.startsAt,
        endDate: c.endsAt,
      }));
    },

    async areas() {
      const q = `
        query GetTeams {
          teams {
            nodes {
              id
              name
              key
            }
          }
        }
      `;
      const data = await graphqlRequest(q);
      const nodes = (data.teams && data.teams.nodes) || [];
      return nodes.map(t => ({
        id: t.id,
        name: t.name,
        key: t.key,
      }));
    },

    async assignees() {
      const q = `
        query GetUsers {
          users {
            nodes {
              id
              name
              email
            }
          }
        }
      `;
      const data = await graphqlRequest(q);
      const nodes = (data.users && data.users.nodes) || [];
      return nodes.map(u => ({
        id: u.id,
        displayName: u.name,
        email: u.email,
      }));
    },

    async tags() {
      const q = `
        query GetIssueLabels {
          issueLabels {
            nodes {
              id
              name
              color
            }
          }
        }
      `;
      const data = await graphqlRequest(q);
      const nodes = (data.issueLabels && data.issueLabels.nodes) || [];
      return nodes.map(l => l.name);
    },

    browserUrl(id) {
      const nativeId = nid(id);
      return `https://linear.app/issue/${nativeId}`;
    },
  };

  // Export globally and register if App.backend exists
  global.LinearProvider = LinearProvider;
  if (App.backend) {
    App.backend.register(LinearProvider);
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);

// GitHub Issues Tracker Provider (api.github.com).
// Fulfills the Provider contract (BACKEND_PROVIDER_SPEC / #64 / #69).

(function (global) {
  'use strict';

  const App = global.App = global.App || {};

  const ENDPOINT = 'https://api.github.com';
  const OAUTH_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
  const OAUTH_TOKEN_URL = 'https://github.com/login/oauth/access_token';

  // Default official GitHub OAuth App Client ID (for 1-click sign-in).
  // Register an OAuth App in GitHub → Settings → Developer settings → OAuth Apps
  // Set Redirect URI to chrome.identity.getRedirectURL()
  // Replace 'YOUR_GITHUB_CLIENT_ID' below with your Client ID.
  const DEFAULT_GITHUB_CLIENT_ID = 'YOUR_GITHUB_CLIENT_ID';

  const CONFIG_KEY = 'github_provider_config';

  let _config = {
    authMode: 'token', // 'token' | 'oauth'
    token: '',
    oauthClientId: '',
    oauthClientSecret: '',
    oauthAccessToken: '',
    oauthExpiresAt: 0,
    owner: '',
    repo: '',
  };

  function gid(nativeId) {
    if (!nativeId) return '';
    const s = String(nativeId);
    if (s.indexOf('github:') === 0) return s;
    const L = global.AdoLib;
    if (s.indexOf('/') >= 0) {
      return L ? L.gidMake('github', s) : ('github:' + s);
    }
    const full = (_config.owner && _config.repo) ? `${_config.owner}/${_config.repo}/${s}` : s;
    return L ? L.gidMake('github', full) : ('github:' + full);
  }

  function nid(gidValue) {
    if (!gidValue) return '';
    const L = global.AdoLib;
    const raw = L ? L.gidNative(gidValue) : String(gidValue).replace(/^github:/, '');
    const parts = raw.split('/');
    return parts[parts.length - 1];
  }

  function parsePath(gidValue) {
    if (!gidValue) return { owner: _config.owner, repo: _config.repo, number: '' };
    const L = global.AdoLib;
    const raw = L ? L.gidNative(gidValue) : String(gidValue).replace(/^github:/, '');
    const parts = raw.split('/');
    if (parts.length >= 3) {
      return { owner: parts[0], repo: parts[1], number: parts[2] };
    }
    if (parts.length === 2) {
      return { owner: _config.owner, repo: parts[0], number: parts[1] };
    }
    return { owner: _config.owner, repo: _config.repo, number: parts[0] };
  }

  function mapStateCategory(state, stateReason) {
    if (!state) return 'proposed';
    const s = String(state).toLowerCase();
    if (s === 'closed') {
      return stateReason === 'not_planned' ? 'removed' : 'completed';
    }
    return 'inprogress';
  }

  function oauthRedirectUri() {
    if (typeof chrome !== 'undefined' && chrome.identity && chrome.identity.getRedirectURL) {
      return chrome.identity.getRedirectURL();
    }
    return '';
  }

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

  async function restRequest(path, { method = 'GET', body = null, headers = {} } = {}) {
    let authHeader = '';
    const activeToken = _config.authMode === 'oauth' ? _config.oauthAccessToken : _config.token;

    if (activeToken) {
      const trimmed = activeToken.trim();
      authHeader = trimmed.startsWith('ghp_') || trimmed.startsWith('github_pat_') ? `token ${trimmed}` : `Bearer ${trimmed}`;
    }

    const reqHeaders = {
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      ...headers,
    };
    if (authHeader) reqHeaders['Authorization'] = authHeader;

    const url = path.startsWith('http') ? path : `${ENDPOINT}${path.startsWith('/') ? '' : '/'}${path}`;

    const response = await fetch(url, {
      method,
      headers: reqHeaders,
      body: body ? JSON.stringify(body) : null,
    });

    if (!response.ok) {
      if (response.status === 429) {
        throw new Error('GitHub API rate limit exceeded (HTTP 429).');
      }
      const text = await response.text();
      let msg = `GitHub API HTTP error ${response.status}: ${response.statusText}`;
      try {
        const json = JSON.parse(text);
        if (json.message) msg = `GitHub API error: ${json.message}`;
      } catch (_) {}
      throw new Error(msg);
    }

    return await response.json();
  }

  function mapGitHubIssue(issue) {
    if (!issue) return null;

    let repoPath = `${_config.owner}/${_config.repo}`;
    if (issue.repository_url) {
      const idx = issue.repository_url.indexOf('/repos/');
      if (idx >= 0) repoPath = issue.repository_url.slice(idx + 7);
    } else if (issue.repository && issue.repository.full_name) {
      repoPath = issue.repository.full_name;
    }

    const fullPath = `${repoPath}/${issue.number}`;
    const itemGid = gid(fullPath);

    const labels = issue.labels ? issue.labels.map(l => typeof l === 'string' ? l : l.name) : [];
    const primaryType = labels.length > 0 ? labels[0] : 'Issue';

    const assigneeName = issue.assignee ? issue.assignee.login : (issue.assignees && issue.assignees[0] ? issue.assignees[0].login : '');
    const cycleName = issue.milestone ? issue.milestone.title : '';
    const stateName = issue.state || 'open';
    const category = mapStateCategory(issue.state, issue.state_reason);

    return {
      id: itemGid,
      nativeId: `#${issue.number}`,
      title: issue.title || '',
      state: stateName,
      stateCategory: category,
      type: primaryType,
      assigned: assigneeName,
      assignee: assigneeName,
      iteration: cycleName,
      area: repoPath,
      priority: 0,
      points: 0,
      dueDate: issue.milestone ? issue.milestone.due_on : null,
      createdDate: issue.created_at || null,
      updatedDate: issue.updated_at || null,
      url: issue.html_url || `https://github.com/${repoPath}/issues/${issue.number}`,
      parent: null,
      rev: issue.updated_at ? new Date(issue.updated_at).getTime() : 1,
      tags: labels,
      description: issue.body || '',
    };
  }

  const GitHubBackend = {
    generate(irNode, fields) {
      if (!irNode) return '';
      if (irNode.type === 'logical' && irNode.children) {
        return irNode.children.map(child => this.generate(child, fields)).filter(Boolean).join(' ');
      }
      if (irNode.type === 'comparison') {
        const fieldName = (irNode.field || '').toLowerCase();
        let val = '';
        if (Array.isArray(irNode.values) && irNode.values.length > 0) {
          val = irNode.values[0].value || irNode.values[0].raw || '';
        } else if (irNode.value !== undefined) {
          val = typeof irNode.value === 'object' ? (irNode.value.value || irNode.value.raw || '') : irNode.value;
        }

        if (fieldName === 'title' || fieldName === 'text') {
          return String(val);
        }
        if (fieldName === 'state') {
          const s = String(val).toLowerCase();
          if (s === 'closed' || s === 'completed' || s === 'removed') return 'is:closed';
          if (s === 'open' || s === 'inprogress' || s === 'proposed') return 'is:open';
          return `state:${val}`;
        }
        if (fieldName === 'assignee' || fieldName === 'assigned') {
          return `assignee:${val}`;
        }
        if (fieldName === 'type' || fieldName === 'tag' || fieldName === 'labels') {
          return `label:"${val}"`;
        }
        if (fieldName === 'iteration' || fieldName === 'sprint' || fieldName === 'milestone') {
          return `milestone:"${val}"`;
        }
        if (fieldName === 'area' || fieldName === 'repo' || fieldName === 'repository') {
          return `repo:${val}`;
        }
      }
      return '';
    }
  };

  const GitHubProvider = {
    meta: {
      id: 'github',
      label: 'GitHub Issues',
      icon: 'github',
      endpoint: ENDPOINT,
    },

    capabilities: {
      hierarchy: false,
      sprints: true,
      dependencies: false,
      states: 'enum',
      points: false,
      timeTracking: false,
      attachments: true,
      mentions: true,
      reactions: true,
      history: false,
      customFields: false,
      areas: true,
    },

    terms: {
      item: 'issue',
      items: 'issues',
      sprint: 'milestone',
      sprints: 'milestones',
      type: 'label',
      state: 'state',
      assignee: 'assignee',
      area: 'repository',
      tag: 'label',
    },

    connectionSchema: [
      { key: 'authMode', type: 'enum', options: ['token', 'oauth'], label: 'Auth Mode', required: true },
      { key: 'token', type: 'string', label: 'Personal Access Token', secret: true, required: false },
      { key: 'oauthClientId', type: 'string', label: 'OAuth Client ID', secret: false, required: false },
      { key: 'oauthClientSecret', type: 'string', label: 'OAuth Client Secret', secret: true, required: false },
      { key: 'owner', type: 'string', label: 'Owner / Organization', secret: false, required: true },
      { key: 'repo', type: 'string', label: 'Repository', secret: false, required: true },
    ],

    fieldSchema: {
      id: { id: 'id', name: 'ID', type: 'string', isCore: true },
      title: { id: 'title', name: 'Title', type: 'string', isCore: true },
      state: { id: 'state', name: 'State', type: 'string', isCore: true },
      assignee: { id: 'assignee', name: 'Assignee', type: 'string', isCore: true },
      milestone: { id: 'milestone', name: 'Milestone', type: 'string', isCore: true },
      repository: { id: 'repository', name: 'Repository', type: 'string', isCore: true },
    },

    gid(nativeId) { return gid(nativeId); },
    nid(gidValue) { return nid(gidValue); },
    mapStateCategory(state, reason) { return mapStateCategory(state, reason); },
    mapGitHubIssue(issue) { return mapGitHubIssue(issue); },
    oauthRedirectUri() { return oauthRedirectUri(); },

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
        authMode: 'token',
        token: '',
        oauthClientId: '',
        oauthClientSecret: '',
        oauthAccessToken: '',
        oauthExpiresAt: 0,
        owner: '',
        repo: '',
      };
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        await new Promise((resolve) => {
          chrome.storage.local.remove([CONFIG_KEY], resolve);
        });
      }
      return true;
    },

    async oauthSignIn(clientId = '', clientSecret = '') {
      clientId = (clientId || '').trim() || DEFAULT_GITHUB_CLIENT_ID;
      clientSecret = (clientSecret || '').trim();
      if (!clientId || clientId === 'YOUR_GITHUB_CLIENT_ID') {
        throw new Error('Enter an OAuth Client ID or configure DEFAULT_GITHUB_CLIENT_ID in code.');
      }

      const redirectUri = oauthRedirectUri();
      const state = randB64Url(16);

      const authUrl = `${OAUTH_AUTHORIZE_URL}?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=repo,user&state=${encodeURIComponent(state)}`;

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

      const urlObj = new URL(redirect);
      const code = urlObj.searchParams.get('code');
      const returnedState = urlObj.searchParams.get('state');
      const errorMsg = urlObj.searchParams.get('error_description') || urlObj.searchParams.get('error');

      if (errorMsg) throw new Error(`GitHub OAuth error: ${errorMsg}`);
      if (!code || returnedState !== state) throw new Error('GitHub OAuth failed (code missing or state mismatch).');

      const params = new URLSearchParams();
      params.append('client_id', clientId);
      if (clientSecret) params.append('client_secret', clientSecret);
      params.append('code', code);
      params.append('redirect_uri', redirectUri);

      const tokenResp = await fetch(OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
        },
        body: params.toString(),
      });

      if (!tokenResp.ok) {
        const text = await tokenResp.text();
        throw new Error(`GitHub token request failed (${tokenResp.status}): ${text.slice(0, 200)}`);
      }

      const tok = await tokenResp.json();
      if (!tok.access_token) {
        throw new Error('GitHub OAuth token response contained no access_token.');
      }

      await this.setConfig({
        authMode: 'oauth',
        oauthClientId: clientId,
        oauthClientSecret: clientSecret,
        oauthAccessToken: tok.access_token,
      });

      return await this.me();
    },

    compileFilter(ir, fieldsMap) {
      return GitHubBackend.generate(ir, fieldsMap);
    },

    async me() {
      const data = await restRequest('/user');
      return {
        id: data.id,
        name: data.name || data.login,
        email: data.email || data.login,
      };
    },

    async item(id) {
      const { owner, repo, number } = parsePath(id);
      if (!owner || !repo || !number) {
        throw new Error(`Invalid GitHub issue path: ${id}`);
      }
      const data = await restRequest(`/repos/${owner}/${repo}/issues/${number}`);
      return mapGitHubIssue(data);
    },

    async roots({ filters, text } = {}) {
      return this.list({ filters, text, first: 100 });
    },

    async search({ text, filters } = {}) {
      return this.list({ text, filters, first: 100 });
    },

    async list({ text, filters, first = 100 } = {}) {
      const owner = _config.owner;
      const repo = _config.repo;

      let q = `is:issue`;
      if (owner && repo) {
        q += ` repo:${owner}/${repo}`;
      } else if (owner) {
        q += ` org:${owner}`;
      }

      if (text) q += ` ${text}`;

      if (filters && typeof filters === 'string') {
        q += ` ${filters}`;
      }

      const data = await restRequest(`/search/issues?q=${encodeURIComponent(q)}&per_page=${Math.min(first, 100)}`);
      const items = data.items || [];
      return items.map(mapGitHubIssue);
    },

    async children() {
      return [];
    },

    async parents() {
      return {};
    },

    async updateItem(id, fields) {
      const { owner, repo, number } = parsePath(id);
      const body = {};

      if (fields.title !== undefined) body.title = fields.title;
      if (fields.description !== undefined) body.body = fields.description;
      if (fields.state !== undefined) {
        const s = String(fields.state).toLowerCase();
        body.state = (s === 'closed' || s === 'completed' || s === 'removed') ? 'closed' : 'open';
      }
      if (fields.assignee !== undefined) {
        body.assignees = fields.assignee ? [fields.assignee] : [];
      }
      if (fields.tags !== undefined) {
        body.labels = Array.isArray(fields.tags) ? fields.tags : [fields.tags];
      }

      const data = await restRequest(`/repos/${owner}/${repo}/issues/${number}`, {
        method: 'PATCH',
        body,
      });

      return mapGitHubIssue(data);
    },

    async createItem({ title, description, labels, assignees }) {
      const owner = _config.owner;
      const repo = _config.repo;
      if (!owner || !repo) {
        throw new Error('Owner and repository are required to create GitHub issues.');
      }

      const body = {
        title: title || 'New Issue',
      };
      if (description) body.body = description;
      if (labels) body.labels = Array.isArray(labels) ? labels : [labels];
      if (assignees) body.assignees = Array.isArray(assignees) ? assignees : [assignees];

      const data = await restRequest(`/repos/${owner}/${repo}/issues`, {
        method: 'POST',
        body,
      });

      return mapGitHubIssue(data);
    },

    async deleteItem(id) {
      const { owner, repo, number } = parsePath(id);
      await restRequest(`/repos/${owner}/${repo}/issues/${number}`, {
        method: 'PATCH',
        body: { state: 'closed', state_reason: 'not_planned' },
      });
      return true;
    },

    async states() {
      return [
        { id: 'open', name: 'Open', type: 'inprogress', color: '#2da44e' },
        { id: 'closed', name: 'Closed', type: 'completed', color: '#8250df' },
      ];
    },

    async iterations() {
      const owner = _config.owner;
      const repo = _config.repo;
      if (!owner || !repo) return [];
      const data = await restRequest(`/repos/${owner}/${repo}/milestones`);
      return (data || []).map(m => ({
        id: String(m.number),
        name: m.title,
        startDate: m.created_at,
        endDate: m.due_on,
      }));
    },

    async areas() {
      const owner = _config.owner;
      if (!owner) return [];
      const data = await restRequest(`/users/${owner}/repos?per_page=100`);
      return (data || []).map(r => ({
        id: r.full_name,
        name: r.name,
        key: r.full_name,
      }));
    },

    async assignees() {
      const owner = _config.owner;
      const repo = _config.repo;
      if (!owner || !repo) return [];
      const data = await restRequest(`/repos/${owner}/${repo}/assignees`);
      return (data || []).map(u => ({
        id: u.login,
        displayName: u.login,
        email: u.login,
      }));
    },

    async tags() {
      const owner = _config.owner;
      const repo = _config.repo;
      if (!owner || !repo) return [];
      const data = await restRequest(`/repos/${owner}/${repo}/labels`);
      return (data || []).map(l => l.name);
    },

    browserUrl(id) {
      const { owner, repo, number } = parsePath(id);
      return `https://github.com/${owner}/${repo}/issues/${number}`;
    },
  };

  global.GitHubProvider = GitHubProvider;
  if (App.backend) {
    App.backend.register(GitHubProvider);
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);

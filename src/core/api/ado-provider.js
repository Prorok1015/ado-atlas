// Azure DevOps Tracker Provider (dev.azure.com REST API).
// Fulfills the Provider contract (BACKEND_PROVIDER spec / #64 / #69).

(function (global) {
  'use strict';

  const App = global.App = global.App || {};

  const WiqlBackend = {
    generate(ast, fields) {
      if (!ast) return [];
      const compiled = this._compileRule(ast, fields);
      return compiled ? [compiled] : [];
    },

    _compileRule(rule, fields) {
      if (!rule) return "";
      if (rule.kind === 'group') {
        const logic = rule.logic || 'AND';
        const groupedByField = {};
        const standardChildren = [];
        
        (rule.rules || []).forEach(r => {
          if (r.kind === 'condition') {
            if (!groupedByField[r.field]) groupedByField[r.field] = [];
            groupedByField[r.field].push(r);
          } else {
            standardChildren.push(this._compileRule(r, fields));
          }
        });

        const fieldGroups = Object.values(groupedByField).map(conds => {
          if (conds.length === 1) return this._compileCondition(conds[0], fields);
          
          const positiveOps = ['=', 'IN', 'CONTAINS', 'UNDER', 'RANGE', '>', '<', '>=', '<='];
          const negativeOps = ['<>', 'NOT IN', 'NOT CONTAINS', 'NOT UNDER'];
          
          const posCompiled = conds.filter(c => positiveOps.includes(c.op)).map(c => this._compileCondition(c, fields)).filter(Boolean);
          const negCompiled = conds.filter(c => negativeOps.includes(c.op)).map(c => this._compileCondition(c, fields)).filter(Boolean);
          const otherCompiled = conds.filter(c => !positiveOps.includes(c.op) && !negativeOps.includes(c.op)).map(c => this._compileCondition(c, fields)).filter(Boolean);
          
          const parts = [];
          if (posCompiled.length > 0) parts.push(posCompiled.length > 1 ? `(${posCompiled.join(' OR ')})` : posCompiled[0]);
          if (negCompiled.length > 0) parts.push(negCompiled.length > 1 ? `(${negCompiled.join(' AND ')})` : negCompiled[0]);
          if (otherCompiled.length > 0) parts.push(...otherCompiled);
          
          if (parts.length === 0) return "";
          if (parts.length === 1) return parts[0];
          return "(" + parts.join(' AND ') + ")";
        }).filter(Boolean);

        const allChildren = [...fieldGroups, ...standardChildren].filter(Boolean);
        if (allChildren.length === 0) return "";
        if (allChildren.length === 1) return allChildren[0];
        return "(" + allChildren.join(` ${logic} `) + ")";
      }
      
      if (rule.kind === 'condition') {
        return this._compileCondition(rule, fields);
      }
      return "";
    },

    _compileCondition(cond, fields) {
      const field = cond.field;
      const spec = (fields && fields[String(field).toLowerCase()]) || { ref: field };
      const ref = spec.ref || field;
      const num = spec.num || spec.type === 'integer' || spec.type === 'double';
      let op = (cond.op || '=').toUpperCase();
      const isTags = spec.type === 'tags';
      if (isTags) {
        const negativeOps = ['<>', 'NOT IN', 'NOT CONTAINS'];
        op = negativeOps.includes(op) ? 'NOT CONTAINS' : 'CONTAINS';
      }
      
      const lit = (vNode) => {
        if (vNode.type === 'macro') {
          if (vNode.name === 'ME') return "@me";
          return vNode.raw;
        }
        
        const v = vNode.value;
        
        if (num) {
          if (v === '' && vNode.isExplicitEmpty) return "''";
          const n = Number(v);
          return Number.isFinite(n) ? String(n) : "null";
        }
        
        const root = (typeof window !== 'undefined') ? window : (typeof globalThis !== 'undefined' ? globalThis : this);
        const escapeFn = (root.AdoLib && root.AdoLib.wiqlQuote) ? root.AdoLib.wiqlQuote : (s => String(s).replace(/'/g, "''"));
        return "'" + escapeFn(v) + "'";
      };

      const values = cond.values;
      if (op === 'ISEMPTY') return `[${ref}] IS EMPTY`;
      if (op === 'ISNOTEMPTY') return `[${ref}] IS NOT EMPTY`;
      
      if (!values || values.length === 0) return "";

      const validVals = values.map(lit).filter(x => x !== null);
      if (validVals.length === 0 && op !== 'ISEMPTY' && op !== 'ISNOTEMPTY') return "";

      if (op === 'IN' || op === 'NOT IN') {
        const isTree = spec.type === 'tree' || spec.type === 'treePath';
        const isDate = spec.type === 'date' || spec.type === 'dateTime' || spec.type === 'datetime';
        const needsExpansion = isTree || isDate;
        
        if (needsExpansion) {
          const clauses = values.map(v => {
            const formatted = lit(v);
            if (!formatted) return null;
            return `[${ref}] ${op === 'NOT IN' ? '<>' : '='} ${formatted}`;
          }).filter(Boolean);
          
          if (clauses.length === 0) return "";
          if (clauses.length === 1) return clauses[0];
          return "(" + clauses.join(op === 'NOT IN' ? ' AND ' : ' OR ') + ")";
        }

        const hasMe = values.some(v => v.type === 'macro' && v.name === 'ME');
        const hasEmpty = values.some(v => v.type === 'literal' && v.isExplicitEmpty);
        
        const splitEmpty = hasEmpty && num;
        
        const filteredVals = values.filter(v => {
          if (v.type === 'macro' && v.name === 'ME') return false;
          if (splitEmpty && v.type === 'literal' && v.isExplicitEmpty) return false;
          return true;
        });
        
        const normalVals = filteredVals.map(lit).filter(x => x !== null);
        
        const parts = [];
        if (hasMe) parts.push(`[${ref}] ${op === 'NOT IN' ? '<>' : '='} @me`);
        if (splitEmpty) parts.push(`[${ref}] ${op === 'NOT IN' ? '<>' : '='} ''`);
        if (normalVals.length) parts.push(`[${ref}] ${op} (${normalVals.join(",")})`);
        
        if (parts.length === 0) return "";
        if (parts.length === 1) return parts[0];
        return "(" + parts.join(op === 'NOT IN' ? ' AND ' : ' OR ') + ")";
      }

      if (op === 'CONTAINS' || op === 'NOT CONTAINS') {
        const clauses = values.map(v => {
          const formatted = lit(v);
          if (!formatted) return null;
          return op === 'NOT CONTAINS' ? `NOT [${ref}] CONTAINS ${formatted}` : `[${ref}] CONTAINS ${formatted}`;
        }).filter(Boolean);
        
        if (clauses.length === 0) return "";
        if (clauses.length === 1) return clauses[0];
        return "(" + clauses.join(op === 'NOT CONTAINS' ? ' AND ' : ' OR ') + ")";
      }

      if (op === 'UNDER' || op === 'NOT UNDER') {
        const clauses = values.map(v => {
          const formatted = lit(v);
          if (!formatted) return null;
          if (op === 'NOT UNDER') {
            return `([${ref}] <> ${formatted} AND [${ref}] NOT UNDER ${formatted})`;
          }
          return `([${ref}] = ${formatted} OR [${ref}] UNDER ${formatted})`;
        }).filter(Boolean);
        
        if (clauses.length === 0) return "";
        if (clauses.length === 1) return clauses[0];
        return clauses.length > 1 ? `(${clauses.join(op === 'NOT UNDER' ? ' AND ' : ' OR ')})` : clauses[0];
      }

      if (op === 'RANGE') {
        if (values.length === 1) {
          const rawVal = values[0].type === 'macro' ? values[0].raw : values[0].value;
          const parts = String(rawVal).split('...');
          if (parts.length === 2) {
            const lit0 = parts[0].startsWith('@') ? { type: 'macro', name: 'TODAY', raw: parts[0] } : { type: 'literal', value: parts[0] };
            const lit1 = parts[1].startsWith('@') ? { type: 'macro', name: 'TODAY', raw: parts[1] } : { type: 'literal', value: parts[1] };
            return `([${ref}] >= ${lit(lit0)} AND [${ref}] <= ${lit(lit1)})`;
          }
        }
        return `[${ref}] = ${validVals[0]}`;
      }

      if (values.length === 1) {
        return `[${ref}] ${op} ${validVals[0]}`;
      }

      const formatted = validVals.join(', ');
      return `[${ref}] ${op} ${formatted}`;
    }
  };

  function gid(nativeId) {
    if (!nativeId) return '';
    const s = String(nativeId);
    if (s.indexOf(':') >= 0) return s;
    const L = global.AdoLib;
    return L ? L.gidMake('ado', s) : ('ado:' + s);
  }

  function nid(gidValue) {
    if (!gidValue) return '';
    const L = global.AdoLib;
    return L ? L.gidNative(gidValue) : String(gidValue).replace(/^ado:/, '');
  }

  function getDefaultClientId() {
    return (App.OAUTH_CONFIG && App.OAUTH_CONFIG.ado && App.OAUTH_CONFIG.ado.clientId) || 'YOUR_ADO_CLIENT_ID';
  }

  function oauthRedirectUri() {
    return (typeof chrome !== 'undefined' && chrome.identity && chrome.identity.getRedirectURL) ? chrome.identity.getRedirectURL() : '';
  }

  const AdoProvider = {
    meta: {
      id: 'ado',
      label: 'Azure DevOps',
    },
    capabilities: {
      hierarchy: true, sprints: true, dependencies: true, states: 'workflow',
      points: true, timeTracking: true, attachments: true, mentions: true,
      reactions: true, history: true, customFields: true, areas: true,
    },
    terms: {
      item: 'work item', items: 'work items', sprint: 'sprint', sprints: 'sprints',
      type: 'type', state: 'state', assignee: 'assignee', area: 'area', tag: 'tag',
    },
    connectionSchema: [
      { key: 'authMode', type: 'enum', options: ['pat', 'oauth'], label: 'Auth mode', required: true },
      { key: 'org', type: 'string', label: 'Organization', required: true },
      { key: 'project', type: 'string', label: 'Project', required: true },
      { key: 'pat', type: 'string', label: 'Personal Access Token', secret: true, required: false },
    ],
    gid,
    nid,
    oauthRedirectUri,
    getDefaultClientId,
    async oauthSignIn(clientId, tenant) {
      if (global.api && global.api.oauthSignIn) {
        return await global.api.oauthSignIn(clientId, tenant);
      }
      throw new Error('OAuth API is not loaded');
    },
    compileFilter(ir, fieldsMap) {
      return WiqlBackend.generate(ir, fieldsMap);
    },
    WiqlBackend
  };

  global.AdoProvider = AdoProvider;

  if (App.backend) {
    App.backend.register(AdoProvider);
  }
})(typeof window !== 'undefined' ? window : global);

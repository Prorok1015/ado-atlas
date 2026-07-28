// App.backend — the tracker-backend Provider registry (BACKEND_PROVIDER_SPEC).
//
// Goal: make the tracker backend pluggable (Azure DevOps today; Jira / GitHub Issues
// later) without rewriting the ~60 call-sites that use the global `api`. The active
// provider IS the global `api` (§3) — keep the name, zero churn. This module adds the
// registry seam + formalises the current ADO client as a Provider by attaching the
// descriptor properties the capability-gated UI (Phase 2) and non-ADO providers will read.
//
// PHASE 1 (this file) — formalise the contract, NO behaviour change:
//   * App.backend registry: register/get/active/setActive (mirrors aiProviderRegistry).
//   * Attach ADO descriptors to `api`: meta, capabilities (§5), terms (§7),
//     connectionSchema (§8), fieldSchema (§6). All advertise ADO's full feature set, so
//     the UI (which still hardcodes ADO assumptions) behaves identically — nothing
//     consumes these yet. Phase 2 replaces those hardcoded assumptions with reads of
//     api.capabilities/terms/fieldSchema/connectionSchema.
//
// The service worker (background.js) uses `api` directly and needs none of these
// descriptors in single-provider mode, so it is intentionally NOT changed here.
// NOTE (§13.1): composite/global ids ("ado:123") are a deliberate NEXT decision, not
// done here — the numeric-id assumption is still baked into store/tree/graph/snapshot.
// Loaded after core/api (facade) + app/namespace, alongside the other foundational infra.
(function (global) {
  'use strict';
  const App = global.App = global.App || {};

  const _providers = {};   // id -> provider (the provider object exposes the api surface + descriptors)
  let _activeId = null;

  const Backend = {
    // Register a provider. The first registered becomes active by default.
    register(provider) {
      const id = provider && provider.meta && provider.meta.id;
      if (!id) { console.warn('App.backend.register: provider has no meta.id', provider); return provider; }
      _providers[id] = provider;
      if (!_activeId) _activeId = id;
      return provider;
    },
    get(id) { return _providers[id] || null; },
    ids() { return Object.keys(_providers); },
    get active() { return _activeId ? _providers[_activeId] : null; },
    get activeId() { return _activeId; },
    setActive(id) { if (_providers[id]) { _activeId = id; return true; } return false; },

    // Composite/global work-item id helpers (BACKEND_PROVIDER_SPEC §13.1), delegating to
    // the pure lib.js encoders. The app treats an item id as an OPAQUE STRING
    // ("<provider>:<native>"); use these at the two edges only:
    //   gid(native) — wrap a user-typed / URL / notification NATIVE id into the active
    //                 provider's global id (tolerant: already-composite passes through).
    //   nid(gid)    — the native id, for DISPLAY ("#123", not "#ado:123") and any place a
    //                 raw native id is needed. (API calls take the composite id directly;
    //                 the provider strips it internally.)
    gid(native) {
      const s = String(native);
      if (s.indexOf(':') >= 0) return s;
      const L = global.AdoLib;
      return L ? L.gidMake(_activeId || 'ado', s) : ((_activeId || 'ado') + ':' + s);
    },
    rawNid(gid) {
      const L = global.AdoLib;
      return L ? L.gidNative(gid) : (function(){ const s=String(gid); const i=s.indexOf(':'); return i>=0?s.slice(i+1):s; })();
    },
    nid(gid) {
      const active = Backend.active;
      if (active && typeof active.nid === 'function') {
        return active.nid(gid);
      }
      return this.rawNid(gid);
    },
    // Dynamically resolves abstract state category ('completed', 'inprogress', 'proposed', 'removed')
    // for a node object or state string via the active tracker backend's schema metadata with keyword fallback.
    getStateCategory(arg) {
      if (!arg) return null;
      if (typeof arg === 'object') {
        if (arg.stateCategory) {
          const lowerCat = String(arg.stateCategory).toLowerCase();
          if (lowerCat.includes('complete') || lowerCat.includes('done') || lowerCat.includes('closed') || lowerCat.includes('resolved') || lowerCat.includes('finish') || lowerCat.includes('готово') || lowerCat.includes('закрыто') || lowerCat.includes('решено') || lowerCat.includes('выполнено')) return 'completed';
          if (lowerCat.includes('progress') || lowerCat.includes('active') || lowerCat.includes('doing') || lowerCat.includes('wip') || lowerCat.includes('работе')) return 'inprogress';
          if (lowerCat.includes('propos') || lowerCat.includes('new') || lowerCat.includes('todo') || lowerCat.includes('to do') || lowerCat.includes('backlog') || lowerCat.includes('новая') || lowerCat.includes('новое')) return 'proposed';
          if (lowerCat.includes('remov') || lowerCat.includes('cut') || lowerCat.includes('cancel') || lowerCat.includes('отменено') || lowerCat.includes('удалено')) return 'removed';
          return lowerCat;
        }
        if (arg.state) return this.getStateCategory(arg.state);
        return null;
      }
      const s = String(arg).trim().toLowerCase();
      const cats = global.stateCategories || {};
      const cat = cats[s];
      const targetStr = cat ? String(cat).toLowerCase() : s;

      if (targetStr.includes('complete') || targetStr.includes('done') || targetStr.includes('closed') || targetStr.includes('resolved') || targetStr.includes('finish') || targetStr.includes('готово') || targetStr.includes('закрыто') || targetStr.includes('решено') || targetStr.includes('выполнено')) return 'completed';
      if (targetStr.includes('progress') || targetStr.includes('active') || targetStr.includes('doing') || targetStr.includes('wip') || targetStr.includes('работе')) return 'inprogress';
      if (targetStr.includes('propos') || targetStr.includes('new') || targetStr.includes('todo') || targetStr.includes('to do') || targetStr.includes('backlog') || targetStr.includes('новая') || targetStr.includes('новое')) return 'proposed';
      if (targetStr.includes('remov') || targetStr.includes('cut') || targetStr.includes('cancel') || targetStr.includes('отменено') || targetStr.includes('удалено')) return 'removed';
      return null;
    },
  };
  App.backend = Backend;

  // ---- Azure DevOps provider descriptor -------------------------------------------------
  // The existing global `api` (assembled in src/core/api/facade.js) already provides every
  // Provider method. Here we only bolt on the meta/capability/vocabulary/connection/field
  // descriptors so `api` is a complete Provider. Guarded (`if (!api.x)`) so this is purely
  // additive and safe to load once.
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

    const adoProvider = global.api || (global.api = {
      meta: { id: 'ado', label: 'Azure DevOps' },
      capabilities: {
        hierarchy: true, sprints: true, dependencies: true, states: 'workflow',
        points: true, timeTracking: true, attachments: true, mentions: true,
        reactions: true, history: true, customFields: true, areas: true,
      },
      terms: {
        item: 'work item', items: 'work items', sprint: 'sprint', sprints: 'sprints',
        type: 'type', state: 'state', assignee: 'assignee', area: 'area', tag: 'tag',
      },
    });

    if (!adoProvider.meta) adoProvider.meta = { id: 'ado', label: 'Azure DevOps' };
    adoProvider.compileFilter = function (ir, fieldsMap) {
      return WiqlBackend.generate(ir, fieldsMap);
    };

    Backend.register(adoProvider);
    Backend.setActive('ado');
})(typeof globalThis !== 'undefined' ? globalThis : window);

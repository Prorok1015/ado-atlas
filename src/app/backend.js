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
    setActive(id, options = {}) {
      if (!_providers[id]) return false;
      const changed = (_activeId !== id);
      _activeId = id;

      if (options.save !== false) {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
          chrome.storage.local.set({ active_backend_provider: id });
        }
        if (App.prefs && typeof App.prefs.set === 'function') {
          App.prefs.set('active_backend_provider', id);
        }
      }

      if (changed || options.clearCache === true) {
        if (App.cache && typeof App.cache.clearProject === 'function') {
          App.cache.clearProject();
        }
        if (App.state) {
          App.state.store = { nodes: {}, kids: {}, roots: [], expanded: new Set(), parent: {}, showAllKids: new Set() };
          App.state.depCache = {};
          App.state.cur = null;
          App.state.orig = {};
          App.state.selRow = null;
          App.state.activeItemData = null;
          App.state.bulkSel = new Set();
          if (App.state.cy && typeof App.state.cy.destroy === 'function') {
            try { App.state.cy.destroy(); } catch (_) {}
            App.state.cy = null;
          }
        }
        if (typeof global.renderBoard === 'function') try { global.renderBoard(); } catch (_) {}
        if (typeof global.renderTree === 'function') try { global.renderTree(); } catch (_) {}
        if (App.timeline && typeof App.timeline.render === 'function') try { App.timeline.render(); } catch (_) {}
      }

      return true;
    },

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
  const adoProvider = global.AdoProvider || global.api || {
    meta: { id: 'ado', label: 'Azure DevOps' },
  };

  if (global.api && global.AdoProvider) {
    Object.assign(global.api, global.AdoProvider);
  }

  Backend.register(adoProvider);
  Backend.setActive('ado');
})(typeof globalThis !== 'undefined' ? globalThis : window);

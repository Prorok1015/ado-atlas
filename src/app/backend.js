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
  };
  App.backend = Backend;

  // ---- Azure DevOps provider descriptor -------------------------------------------------
  // The existing global `api` (assembled in src/core/api/facade.js) already provides every
  // Provider method. Here we only bolt on the meta/capability/vocabulary/connection/field
  // descriptors so `api` is a complete Provider. Guarded (`if (!api.x)`) so this is purely
  // additive and safe to load once.
  const api = global.api;
  if (api) {
    if (!api.meta) api.meta = { id: 'ado', label: 'Azure DevOps' };

    // §5 — everything ADO supports is advertised true, so the UI degrades nowhere for ADO.
    if (!api.capabilities) api.capabilities = {
      hierarchy: true,       // parent/children tree
      sprints: true,         // iteration/sprint board grouping
      dependencies: true,    // blocked-by / blocks graph
      states: 'workflow',    // per-type workflow states (vs a fixed 'enum')
      points: true,          // story points
      timeTracking: true,    // remaining / completed
      attachments: true,
      mentions: true,
      reactions: true,
      history: true,
      customFields: true,
      areas: true,
    };

    // §7 — provider vocabulary. Phase 3 routes UI labels through these (via i18n); for now
    // they are the ADO literals the UI already hardcodes, so behaviour is unchanged.
    if (!api.terms) api.terms = {
      item: 'work item', items: 'work items',
      sprint: 'sprint', sprints: 'sprints',
      type: 'type', state: 'state', assignee: 'assignee', area: 'area', tag: 'tag',
    };

    // §8 — declarative connection form. Phase 2 renders the setup modal from this instead
    // of ADO-specific markup; `secret:true` fields stay firewalled from sync (SETTINGS_SYNC).
    if (!api.connectionSchema) api.connectionSchema = [
      { key: 'authMode', type: 'enum', options: ['pat', 'oauth'], label: 'Auth mode', required: true },
      { key: 'org',      type: 'string', label: 'Organization', required: true },
      { key: 'project',  type: 'string', label: 'Project', required: true },
      { key: 'pat',      type: 'string', label: 'Personal Access Token', secret: true, required: false },
    ];

    // §6 — the provider's field schema. The app already reads api.FIELD_REGISTRY (ADO field
    // metadata, populated at runtime); expose it as the Provider schema. Phase 6 formalises
    // the semantic-key -> native-ref mapping so the app addresses fields by semantic key only.
    if (!Object.getOwnPropertyDescriptor(api, 'fieldSchema')) {
      Object.defineProperty(api, 'fieldSchema', { get() { return api.FIELD_REGISTRY; }, enumerable: false });
    }

    Backend.register(api);
    Backend.setActive('ado');
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);

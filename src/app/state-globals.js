// Core cross-cutting mutable front-end state shared by every app/* module —
// the cytoscape instance, current view mode, selection, async-render tokens,
// and the active editors. Phase 3 (REFACTORING_PLAN.md) moves this onto the
// single App.state object.
//
// MIGRATION BRIDGE (temporary): every App.state field is ALSO exposed as a bare
// global via a globalThis accessor, so files not yet migrated to App.state.* keep
// resolving `cy`, `cur`, `mode`, … transparently (read + write both proxy to
// App.state). References are being converted to App.state.* module-by-module; the
// bridge loop is removed once a grep proves no bare reference to these names
// remains anywhere. Loads after app/const.js and before the feature modules + app.js.
window.App = window.App || {};

const _state = window.App.state = {
  cy: null, mode: 'tree', edgeMode: 'hierarchy', rankDir: 'LR',
  cur: null, orig: {}, selRow: null, activeItemData: null,
  maxNodesLimit: 1000,
  descEditor: null, acEditor: null, commentEditor: null, activeEditor: null,
  depCache: {}, renderToken: 0, boardToken: 0, tlToken: 0,   // tokens drop superseded async renders
  tlZoom: 'week', tlGroup: 'none',                           // timeline view: zoom (day|week|month) + row grouping
  openToken: 0,                                              // drops superseded openItem() calls
  openItemAbortCtrl: null,                                   // AbortController for the in-flight openItem() fetch
};

// Compatibility bridge — see header. Remove when Phase 3 migration is complete.
for (const _k of Object.keys(_state)) {
  Object.defineProperty(globalThis, _k, {
    configurable: true,
    get() { return _state[_k]; },
    set(v) { _state[_k] = v; },
  });
}

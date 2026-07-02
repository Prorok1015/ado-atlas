// Core cross-cutting mutable front-end state shared by every app/* module —
// the cytoscape instance, current view mode, selection, async-render tokens,
// and the active editors. Phase 3 (REFACTORING_PLAN.md) centralised these onto the
// single App.state object; every reference across app/*.js + components uses
// App.state.* (the temporary bare-global compatibility bridge has been removed now
// that the migration is complete). Loads after app/const.js and before the feature
// modules + app.js so App.state exists before any module runs.
window.App = window.App || {};

window.App.state = {
  cy: null, mode: 'tree', edgeMode: 'hierarchy', rankDir: 'LR',
  cur: null, orig: {}, selRow: null, activeItemData: null,
  maxNodesLimit: 1000,
  descEditor: null, acEditor: null, commentEditor: null, activeEditor: null,
  depCache: {}, renderToken: 0, boardToken: 0, tlToken: 0,   // tokens drop superseded async renders
  tlZoom: 'week', tlGroup: 'none',                           // timeline view: zoom (day|week|month) + row grouping
  openToken: 0,                                              // drops superseded openItem() calls
  openItemAbortCtrl: null,                                   // AbortController for the in-flight openItem() fetch
};

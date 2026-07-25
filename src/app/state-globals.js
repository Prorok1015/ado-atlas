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
  // client-side mirror of already-loaded data; tree + graph both render from this
  // store, and `expanded` is the shared expand/collapse state so they stay in sync.
  store: { nodes: {}, kids: {}, roots: [], expanded: new Set(), parent: {}, showAllKids: new Set() },
  bulkSel: new Set(),                                        // ids checked in the tree for bulk edit
};

window.stateCategories = window.stateCategories || {};

window.isCompletedState = function(state) {
  if (!state) return false;
  const targetCat = (window.StateCategory && window.StateCategory.COMPLETED) || 'completed';
  if (window.App && window.App.backend && typeof window.App.backend.getStateCategory === 'function') {
    const cat = window.App.backend.getStateCategory(state);
    if (cat) return cat === targetCat;
  }
  const raw = typeof state === 'object' ? (state.stateCategory || state.state) : String(state);
  if (!raw) return false;
  const cat = window.stateCategories ? window.stateCategories[String(raw).toLowerCase()] : null;
  return cat ? String(cat).toLowerCase() === 'completed' : false;
};

window.isInProgressState = function(state) {
  if (!state) return false;
  const targetCat = (window.StateCategory && window.StateCategory.IN_PROGRESS) || 'inprogress';
  if (window.App && window.App.backend && typeof window.App.backend.getStateCategory === 'function') {
    const cat = window.App.backend.getStateCategory(state);
    if (cat) return cat === targetCat;
  }
  const raw = typeof state === 'object' ? (state.stateCategory || state.state) : String(state);
  if (!raw) return false;
  const cat = window.stateCategories ? window.stateCategories[String(raw).toLowerCase()] : null;
  return cat ? String(cat).toLowerCase() === 'inprogress' : false;
};

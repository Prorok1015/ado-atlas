// Core cross-cutting mutable front-end state shared by every app/* module —
// the cytoscape instance, current view mode, selection, async-render tokens,
// and the active editors. Relocated from app.js as step 2 of the App.* refactor
// (REFACTORING_PLAN.md, Phase 0). Kept as bare globals in the shared script
// scope for now (callers unchanged); migrates onto App.state in Phase 3.
// Loads after app/const.js and before the feature modules + app.js so any
// module-load-time reference is always past the temporal dead zone.
window.App = window.App || {};

let cy=null, mode='tree', edgeMode='hierarchy', rankDir='LR', cur=null, orig={}, selRow=null, activeItemData=null;
let maxNodesLimit = 1000;
let descEditor = null, acEditor = null, commentEditor = null, activeEditor = null;
let depCache={}, renderToken=0, boardToken=0, tlToken=0;   // tokens drop superseded async renders
let tlZoom='week', tlGroup='none';               // timeline view: zoom (day|week|month) + row grouping
let openToken=0;                                // drops superseded openItem() calls
let openItemAbortCtrl=null;                     // AbortController for the in-flight openItem() fetch

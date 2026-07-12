// Per-view badge visibility: which fields render on nodes/cards/rows/bars
// (BADGE_FIELDS_BY_VIEW), the current on/off state (badgesOn), and its
// persistence (badgeOn/loadBadgesOn/saveBadgesOn). Shared across ALL views
// (graph, board, tree, timeline) and the badge popover, so these stay BARE
// globals — like the loading indicator — rather than a namespace: the already-
// extracted timeline module and the board/tree sections call badgeOn() bare.
// Relocated from app.js (REFACTORING_PLAN.md). Reads bare `App.state.mode` at call time.
// Loads after app/state-globals.js, before app.js.
window.App = window.App || {};

const BADGE_FIELDS_BY_VIEW={
  graph:[
    {key:'childCount',label:'Child count'},
    {key:'priority',label:'Priority'},
    {key:'assigned',label:'Assignee'},
    {key:'state',label:'State'},
    {key:'est',label:'Estimate (h)'},
    {key:'tags',label:'Tags'},
    {key:'iteration',label:'Sprint'},
  ],
  board:[
    {key:'assigned',label:'Assignee'},
    {key:'type',label:'Type'},
    {key:'priority',label:'Priority'},
    {key:'state',label:'State'},
    {key:'est',label:'Estimate / time bar'},
    {key:'tags',label:'Tags'},
  ],
  tree:[
    {key:'priority',label:'Priority'},
    {key:'state',label:'State'},
    {key:'tags',label:'Tags'},
  ],
  timeline:[
    {key:'priority',label:'Priority (bar prefix)'},
    {key:'state',label:'State pill on label'},
    {key:'assigned',label:'Assignee chip'},
  ],
};
const badgesOn={
  graph:{childCount:true,priority:true,assigned:true,state:true,est:true,tags:true,iteration:true},
  board:{assigned:true,type:true,priority:true,state:true,est:true,tags:true},
  tree:{priority:true,state:true,tags:true},
  timeline:{priority:true,state:false,assigned:false},
};
// True iff the (view, key) toggle is on. View defaults to the current App.state.mode
// — pass an explicit view when the call site renders for a specific view
// regardless of what's focused (e.g., gstyle is always 'graph').
function badgeOn(k,view){view=view||App.state.mode;const m=badgesOn[view];return !m||m[k]!==false;}
function loadBadgesOn(){
  try{
    const s=App.prefs.get('badges');
    if(s){const p=JSON.parse(s);Object.keys(badgesOn).forEach(v=>{
      if(p[v]&&typeof p[v]==='object')Object.keys(badgesOn[v]).forEach(k=>{if(typeof p[v][k]==='boolean')badgesOn[v][k]=p[v][k];});
    });}
    const legacy=App.prefs.get('graphBadges');   // migrate v1 single-view format
    if(legacy){const op=JSON.parse(legacy);Object.keys(badgesOn.graph).forEach(k=>{if(typeof op[k]==='boolean')badgesOn.graph[k]=op[k];});}
  }catch(e){}
}
function saveBadgesOn(){App.prefs.set('badges',JSON.stringify(badgesOn));}

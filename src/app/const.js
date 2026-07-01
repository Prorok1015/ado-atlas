// Shared constants & tiny pure-ish helpers — colours, state ordering, type
// names. Relocated verbatim from app.js as step 1 of the App.* modular refactor
// (REFACTORING_PLAN.md, Phase 0). Names stay bare globals in the shared script
// scope so existing callers are untouched; the stable set is also published on
// App.const to seed the new namespace. Loads after app/namespace.js, before app.js.
window.App = window.App || {};

// Type colours: seeded with sensible defaults for instant first paint, then
// overwritten by the project's real process colours once they load from ADO.
// The hex map feeds the canvas graph; DOM views use a CSS custom property so the
// real colour propagates live (no re-render) once loadTypes() sets it on :root.
let TYPE_COLOR={Epic:'#8e44ad',Feature:'#e67e22','User Story':'#3498db',Bug:'#e74c3c',Task:'#7f8c8d',Issue:'#16a085'};
const tyVar=t=>'--ty-'+String(t).toLowerCase().replace(/[^a-z0-9]+/g,'-');
const tyColor=t=>`var(${tyVar(t)}, ${TYPE_COLOR[t]||'#95a5a6'})`;   // CSS var with the default hex as fallback
const PRIO_COLOR={1:'#e74c3c',2:'#e67e22',3:'#f1c40f',4:'#95a5a6'};   // P1 urgent … P4 low
const prioColor=p=>{
  if (typeof document !== 'undefined') {
    const custom = getComputedStyle(document.documentElement).getPropertyValue(`--prio-${p}`).trim();
    if (custom) return custom;
  }
  return PRIO_COLOR[p]||'#5b6b7d';
};
const STATE_COLOR={New:'#6b7785',Active:'#2f6fed',Resolved:'#1e7a44',Closed:'#5b6b7d',Removed:'#9b2c2c',Done:'#1e7a44'};
const stateColor=s=>{
  if (typeof document !== 'undefined') {
    const norm = String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const custom = getComputedStyle(document.documentElement).getPropertyValue(`--state-${norm}`).trim();
    if (custom) return custom;
  }
  return STATE_COLOR[s]||'#6b7785';
};
// Canonical left-to-right order for the by-State board and the State filter
// chips; states not listed here keep their discovered order, appended after.
const STATE_ORDER=['New','Proposed','To Do','Approved','Active','Doing','In Progress','Committed','Resolved','Done','Closed','Removed'];
function orderStates(list){const seen=new Set(),out=[];
  STATE_ORDER.forEach(s=>{if(list.includes(s)&&!seen.has(s)){seen.add(s);out.push(s);}});
  list.forEach(s=>{if(!seen.has(s)){seen.add(s);out.push(s);}});
  return out;}
// Card ordering that honours the toolbar Sort selector (id by default, or
// priority then id). Used by the board columns and the sprint detail so Sort
// works there too — not just in the tree.
function cmpBySort(a,b){
  if(($('f_sort')&&$('f_sort').value)==='priority')return ((a.priority||9)-(b.priority||9))||(a.id-b.id);
  return a.id-b.id;
}
// Offline fallback only — the real types come from ADO (api.workItemTypes),
// loaded into `typeList` at boot. Used if that call ever fails.
const TYPES=['Epic','Feature','User Story','Bug','Task','Issue'];
let typeList=[];                          // [{name,color}] of the project's real work-item types
const typeNames=()=>typeList.length?typeList.map(t=>t.name):TYPES;
const $=id=>document.getElementById(id);

// Forward namespace API (bare names above stay valid for current callers).
// `$` and the mutable `typeList` are intentionally left as bare globals —
// `$` is the universal DOM alias; `typeList` migrates to App.state later.
App.const = { TYPE_COLOR, tyVar, tyColor, PRIO_COLOR, prioColor, STATE_COLOR, stateColor, STATE_ORDER, orderStates, cmpBySort, TYPES, typeNames };

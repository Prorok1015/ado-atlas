// Shared sprint/date helpers + the iteration cache — used across board,
// sprint-detail, the extracted timeline module, and src/components/card-picker.js
// (which calls _sprint/isCurrentSprint bare). Kept as BARE globals (like
// loading/badges) since they're cross-cutting. Relocated from app.js
// (REFACTORING_PLAN.md). Reads bare api/setStatus/window.i18n at call time.
// Loads after app/state-globals.js, before app.js.
window.App = window.App || {};

function prettyDate(s){if(!s)return '';const m=String(s).slice(0,10).match(/^(\d{4})-(\d{2})-(\d{2})$/);if(!m)return String(s).slice(0,10);
  return (+m[3])+' '+new Date(Date.UTC(+m[1],+m[2]-1,+m[3])).toLocaleString(window.i18n.getLang(),{month:'short',timeZone:'UTC'})+' '+m[1];}
const DONE_STATES=['Closed','Resolved','Removed','Done'];
let iterCache=null;
async function getIterations(){                     // sprint dates — fetched once, cached
  if(!iterCache){try{iterCache=await api.iterations();}catch(e){iterCache=[];setStatus('ERROR: '+e.message,true);}}
  return iterCache;
}
function isCurrentSprint(it){const t=new Date().toISOString().slice(0,10);return !!(it.start&&it.finish&&t>=it.start.slice(0,10)&&t<=it.finish.slice(0,10));}
const BOARD_TIME_CAP=200;
function hh(h){return h>=24?(Math.floor(h/24)+'d '+Math.round(h%24)+'h'):(Math.round(h*10)/10+'h');}
function colMeta(items){const se=items.reduce((s,n)=>s+(n.est||0),0);
  return `<small>${items.length} items</small>`+
    `<div class="bfoot">`+(se?`<div class="tbar cbar"><div class="tfill"></div></div>`:'')+
    `<span class="tlabel colact">${se?'Σest '+(Math.round(se*10)/10)+'h':''}</span></div>`;}
function _sprint(path){return (iterCache||[]).find(x=>x.path===path)||null;}

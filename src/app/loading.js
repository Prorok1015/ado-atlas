// Refcounted loading indicator — the top progress bar shows while any async
// work is in flight. Cross-cutting infrastructure used from ~56 call-sites, so
// (like `$` and the core state) these stay BARE GLOBALS rather than moving onto
// App.* — namespacing pervasive infra would be churn with no boundary benefit
// (REFACTORING_PLAN.md §1). Relocated from app.js. Reads `$`/`setStatus` at call
// time. Loads after app/const.js, before app.js.
window.App = window.App || {};

let _loads=0;
function loadStart(label){_loads++;const l=$('loading');if(l)l.classList.add('on');if(label)setStatus(label);}
function loadEnd(){_loads=Math.max(0,_loads-1);if(_loads===0){const l=$('loading');if(l)l.classList.remove('on');}}
async function withLoad(label,fn){loadStart(label);try{return await fn();}finally{loadEnd();}}

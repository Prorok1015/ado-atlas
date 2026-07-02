// Front-end of the extension. Port of the inline <script> from ado_web.py
// PAGE — same store/refresh/tree/graph/board/sprint/editor logic, but every
// fetch('/api/...') is now a direct call to api.* (no Flask in between).
//
// Boot sequence (different from the Flask version):
//   1. Wait for chrome.storage to surface a PAT (setup modal otherwise).
//   2. Verify with api.me() — invalid PAT → re-open setup with an error.
//   3. Run the original initialisation (legend, filters, refresh).

cytoscape.use(cytoscapeDagre);
// Constants/colours/helpers + the $ alias now live in app/const.js (App.const).
// Core view/render state now lives in app/state-globals.js (migrates to App.state in Phase 3).
/* side-panel field-loading + sidebar lock (lockSidebar/lockSidebarHeavy/ensureFieldLoaded,
   customFieldsState/LAZY_GROUPS/HEAVY_FIELD_MAP/getCustomFieldElementId) -> app/side-panel.js (bare). */
let boardBusy=false;                            // true while a card move PATCH is in flight
let pdrag=null, suppressClick=false;            // custom pointer-based drag for board cards
let boardScroll=null;                           // saved board scroll to restore from the sprint view
let boardGroup='sprint';                        // board grouping: 'sprint' | 'assignee' | 'state'
let canCreateSprint=true;                       // show the "add sprint" column until a create is denied (403)
let canEditSprint=true;                          // show the sprint "dates" button until an edit is denied (403)
let canCreateItem=true;                         // show the New / + Child buttons until a create is denied (403)
const newSprints=new Set();                     // sprint paths created this session — stay visible while still empty
let pendingSprintItems=null;                     // cards dropped on "＋ New sprint" → moved into the sprint once created
let tzOffset=Math.round(-new Date().getTimezoneOffset()/60);   // UTC offset for work-hours (default: browser TZ)
let sprintGroup='none';                         // expanded-sprint grouping: 'none' | 'assignee'
let currentUser='';                      // display name of the PAT owner (for the "me" shortcuts)
let currentComments=[], currentHistory=[];      // tracked comments and history for activity feed
const activeCommentEditors = new Map();         // active inline MarkdownEditor instances
let projectName='';                      // configured ADO project (root path = "no sprint" fallback)
let assignees=[];                        // participant names (for the Assigned filter chips + datalist)
let projectStates=[];                    // real states fetched from the project (State filter chips)
let tagList=[];                          // distinct tags seen on recent items (Tags filter chips)
let sprintPaths=[];                      // iteration paths for the Sprint filter (chip value = path)
let sprintNames={};                      // iteration path -> short sprint name (chip label)
let listCapped=false;                    // true when the last list() hit LIST_CAP (UI warns)
let pinnedSprints=new Set();            // iteration paths pinned to stay expanded
try{const s=localStorage.getItem('ado.pinnedSprints');if(s){const p=JSON.parse(s);if(Array.isArray(p))pinnedSprints=new Set(p);}}catch(_){}
function togglePinSprint(path){
  if(pinnedSprints.has(path))pinnedSprints.delete(path);else pinnedSprints.add(path);
  try{localStorage.setItem('ado.pinnedSprints',JSON.stringify([...pinnedSprints]));}catch(_){}
  App.board.renderBoard();
}
let treeEverLoaded=false;                // false only before the very first successful list load
// client-side mirror of already-loaded data; BOTH views render from THIS store.
// `expanded` is the shared expand/collapse state, so tree and graph stay in sync.
const store={nodes:{},kids:{},roots:[],expanded:new Set(),parent:{}};
const bulkSel=new Set();                  // ids checked in the tree for bulk edit
let bulkAnchor=null,bulkAnchorOn=true;     // pivot for Shift-range + whether that action selected (true) or deselected (false)
let dragIds=[],dropTargetEl=null;          // tree drag-to-reparent: ids being dragged + current drop-target row
function reachable(){const out=new Set(),st=[...(store.top||store.roots)];
  while(st.length){const id=st.pop();if(out.has(id))continue;out.add(id);
    if(store.expanded.has(id))(store.kids[id]||[]).forEach(c=>st.push(c));}
  return out;}
async function ensureKids(id){            // load children once, cache in the store
  if(store.kids[id])return store.kids[id];
  const ord=$('f_sort').value||null;
  let kids;try{kids=await api.children(id,ord);}catch(e){setStatus('ERROR: '+e.message,true);return [];}
  kids.forEach(k=>{store.nodes[k.id]=k;store.parent[k.id]=id;});store.kids[id]=kids.map(k=>k.id);
  // these were loaded outside the filtered set, so their own child counts are
  // unknown — fetch them so the carets/badges on the new rows resolve too.
  fetchChildCounts(store.kids[id]).then(changed=>{if(changed)rerenderChildCounts();});
  return store.kids[id];
}

function setStatus(t,err){const s=$('status');if(!s)return;if(t.includes('<ui-icon')){s.innerHTML=t;}else{s.textContent=t;}s.style.color=err?'#e06c75':'var(--muted)';}
function customConfirm(message, title) {
  if (title == null) title = window.i18n.t('dialog.confirmActionTitle');
  return new Promise((resolve) => {
    $('confirm-title').textContent = title;
    $('confirm-message').innerHTML = message;
    const overlay = $('confirm-overlay');
    overlay.style.display = 'flex';
    overlay.classList.add('show');
    if (window.LayerManager) window.LayerManager.open(overlay, null, { isPopover: true });
    const ok = $('confirm-ok');
    const cancel = $('confirm-cancel');
    const cleanup = () => {
      overlay.style.display = 'none';
      overlay.classList.remove('show');
      if (window.LayerManager) window.LayerManager.close(overlay);
      ok.onclick = null;
      cancel.onclick = null;
      document.removeEventListener('keydown', onKey);
    };
    const onKey = e => {
      if (e.key === 'Enter') { e.preventDefault(); cleanup(); resolve(true); }
      else if (e.key === 'Escape') { e.preventDefault(); cleanup(); resolve(false); }
    };
    ok.onclick = () => { cleanup(); resolve(true); };
    cancel.onclick = () => { cleanup(); resolve(false); };
    document.addEventListener('keydown', onKey);
    ok.focus();
  });
}
function customAlert(message, title) {
  if (title == null) title = window.i18n.t('dialog.alertTitle');
  return new Promise((resolve) => {
    $('confirm-title').textContent = title;
    $('confirm-message').innerHTML = message;
    const overlay = $('confirm-overlay');
    overlay.style.display = 'flex';
    overlay.classList.add('show');
    if (window.LayerManager) window.LayerManager.open(overlay, null, { isPopover: true });
    const ok = $('confirm-ok');
    const cancel = $('confirm-cancel');
    cancel.style.display = 'none';
    const cleanup = () => {
      overlay.style.display = 'none';
      overlay.classList.remove('show');
      cancel.style.display = '';
      if (window.LayerManager) window.LayerManager.close(overlay);
      ok.onclick = null;
      document.removeEventListener('keydown', onKey);
    };
    const onKey = e => {
      if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); cleanup(); resolve(true); }
    };
    ok.onclick = () => { cleanup(); resolve(true); };
    document.addEventListener('keydown', onKey);
    ok.focus();
  });
}
window.customAlert = customAlert;

function customLinkPrompt(defaultText) {
  return new Promise((resolve) => {
    const overlay = $('link-overlay');
    const txtInput = $('link-dialog-text');
    const urlInput = $('link-dialog-url');
    const errDiv = $('link-dialog-err');
    
    if (!overlay || !txtInput || !urlInput || !errDiv) {
      const url = prompt('Link URL (https://…)', 'https://');
      if (!url || !/^https?:\/\//i.test(url)) {
        resolve(null);
        return;
      }
      resolve({ text: defaultText || url, url });
      return;
    }
    
    txtInput.value = defaultText || '';
    urlInput.value = 'https://';
    errDiv.textContent = '';
    
    overlay.style.display = 'flex';
    overlay.classList.add('show');
    if (window.LayerManager) window.LayerManager.open(overlay, null, { isPopover: true });
    
    if (defaultText) {
      urlInput.focus();
      urlInput.setSelectionRange(8, 8);
    } else {
      txtInput.focus();
    }
    
    const ok = $('link-ok');
    const cancel = $('link-cancel');
    
    const cleanup = () => {
      overlay.style.display = 'none';
      overlay.classList.remove('show');
      if (window.LayerManager) window.LayerManager.close(overlay);
      ok.onclick = null;
      cancel.onclick = null;
      document.removeEventListener('keydown', onKey);
    };
    
    const submit = () => {
      const text = txtInput.value.trim();
      const url = urlInput.value.trim();
      if (!url || !/^https?:\/\//i.test(url)) {
        errDiv.textContent = 'Please enter a valid URL (starting with http:// or https://)';
        urlInput.focus();
        return;
      }
      cleanup();
      resolve({ text: text || url, url });
    };
    
    const onKey = e => {
      if (e.key === 'Enter') { 
         e.preventDefault(); 
         submit(); 
      } else if (e.key === 'Escape') { 
         e.preventDefault(); 
         cleanup(); 
         resolve(null); 
      }
    };
    
    ok.onclick = submit;
    cancel.onclick = () => { cleanup(); resolve(null); };
    document.addEventListener('keydown', onKey);
  });
}
function capNote(){return listCapped?' · capped, narrow the filters':'';}   // appended to count statuses when LIST_CAP was hit
// loading indicator (loadStart/loadEnd/withLoad) -> app/loading.js (bare globals)

function getContextPopular(key, allVals){
  const counts={};
  const nodes=Object.values(store.nodes||{});
  nodes.forEach(n=>{
    if(key==='tags'){
      const ts=tagList_(n.tags);
      ts.forEach(t=>{counts[t]=(counts[t]||0)+1;});
    } else {
      const val=n[key];
      if(val!=null&&val!==''){
        counts[val]=(counts[val]||0)+1;
      }
    }
  });
  const sorted=allVals.slice().sort((a,b)=>{
    const ca=counts[a]||0;
    const cb=counts[b]||0;
    if(cb!==ca)return cb-ca;
    return allVals.indexOf(a)-allVals.indexOf(b);
  });
  return sorted.slice(0,10);
}
/* chip filters (data-driven) -> app/filters.js (App.filters.*) */

/* tree view render (childrenUl/treeNode/toggle/currentItems/renderTree) -> app/tree.js (App.tree.*) */

/* bulk-select + drag-reparent + bulk-apply subsystem -> app/bulk.js (bare, shared) */

/* graph (cytoscape) -> app/graph.js (App.graph.*) */

/* board + card-drag + sprint-detail -> app/board.js (App.board.*); openSprintPath stays bare */
let openSprintPath=null;

/* ---------- Timeline (project-wide Gantt — one continuous axis, no sprint cut-off) ---------- */
const TL_DAY=86400000;
const TL_PX={day:26,week:9,month:3.3};            // px per day at each zoom
let tlLabelWidth = 240;                           // sticky left label column width
try {
  const savedTlWidth = localStorage.getItem('ado.tlLabelWidth');
  if (savedTlWidth) tlLabelWidth = parseInt(savedTlWidth, 10);
} catch(e) {}
// timeline render (tlDates/tlKey/tlMonths/renderTimeline) -> app/timeline.js (App.timeline.render)

/* ---------- mode / refresh ---------- */
function setMode(m){
  $('sprintview').classList.remove('show');openSprintPath=null;   // leaving board closes the sprint detail
  if(m!=='graph')App.graph.depHandleHide();             // dep drag-handle is graph-only
  mode=m;$('mode').querySelectorAll('button').forEach(b=>b.classList.toggle('on',b.dataset.m===m));
  $('tree').classList.toggle('show',m==='tree');$('cy').classList.toggle('show',m==='graph');
  $('board').classList.toggle('show',m==='board');$('timeline').classList.toggle('show',m==='timeline');
  $('emode').style.display=$('dir').style.display=(m==='graph')?'inline-flex':'none';
  $('fit').style.display=(m==='graph')?'inline-block':'none';   // Fit only makes sense on the graph
  if(m!=='graph'){
    $('badgepanel').style.display='none';
    if (window.LayerManager) window.LayerManager.close($('badgepanel'));
  }            // badges popover lives inside the Controls header — graph-only
  $('empty_btn').style.display=(m==='board')?'inline-block':'none';
  $('grp').style.display=(m==='board')?'inline-flex':'none';
  $('tlzoom').style.display=(m==='timeline')?'inline-flex':'none';
  $('tl_group').style.display=(m==='timeline')?'inline-block':'none';
  renderViewHelp();
}
// Per-view "what can I do here" legend, bottom-left. Each view has its own
// non-obvious interactions (modifier-click to bulk-select, drag semantics, …);
// this surfaces them. Collapsible, with the state remembered across sessions.
// Rows store i18n key suffixes for the key-combo (k) and description (d); the
// icon/symbol (i) is literal. Resolved to localized text in renderViewHelp().
const VIEW_HELP={
  tree:[['<ui-icon name="mouse-pointer"></ui-icon>','click','openItem'],['▸','clickExpand','expandCollapse'],['<ui-icon name="check-square"></ui-icon>','ctrlClick','toggleSelect'],['<ui-icon name="arrow-up-down"></ui-icon>','shiftClick','selectRange'],['<ui-icon name="move"></ui-icon>','drag','reparentRow']],
  graph:[['<ui-icon name="mouse-pointer"></ui-icon>','click','openItem'],['<ui-icon name="mouse-pointer"></ui-icon>','doubleClick','expandCollapseChildren'],['<ui-icon name="check-square"></ui-icon>','ctrlShiftClick','toggleSelect'],['<ui-icon name="move"></ui-icon>','dragNode','moveBackgroundPans'],['<ui-icon name="search"></ui-icon>','scroll','zoom'],['→','depsDragHandle','createDepLink'],['<ui-icon name="trash"></ui-icon>','depsClickEdge','deleteDep']],
  board:[['<ui-icon name="mouse-pointer"></ui-icon>','click','openItem'],['<ui-icon name="check-square"></ui-icon>','ctrlShiftClick','toggleRangeSelect'],['<ui-icon name="move"></ui-icon>','drag','moveToColumn'],['<ui-icon name="plus"></ui-icon>','dragToPlus','newSprintFromCards']],
  timeline:[['<ui-icon name="mouse-pointer"></ui-icon>','click','openItem'],['<ui-icon name="check-square"></ui-icon>','ctrlClick','toggleSelect'],['<ui-icon name="arrow-up-down"></ui-icon>','shiftClick','selectRange']],
};
function viewHelpCollapsed(){try{return localStorage.getItem('ado.viewhelp')==='0';}catch(e){return false;}}
function renderViewHelp(){
  const box=$('viewhelp'),rows=VIEW_HELP[mode];
  const show=!!rows&&!$('sprintview').classList.contains('show');   // hide over the sprint detail
  box.classList.toggle('show',show);
  if(!show){
    $('badgepanel').style.display='none';
    if (window.LayerManager) window.LayerManager.close($('badgepanel'));
    return;
  }
  const collapsed=viewHelpCollapsed();
  box.classList.toggle('collapsed',collapsed);
  // The gear in the Controls header is per-view: every view that defines a
  // BADGE_FIELDS_BY_VIEW entry gets a popover ("Show on nodes / cards / rows / bars").
  const hasFields=!!(BADGE_FIELDS_BY_VIEW[mode]&&BADGE_FIELDS_BY_VIEW[mode].length);
  const gear=hasFields?`<button class="vhbadge" id="vhbadge" title="${htmlEsc(window.i18n.t('viewHelp.toggleFields'))}"><ui-icon name="settings"></ui-icon></button>`:'';
  const bugBtn=`<a class="icon-btn" href="https://github.com/Prorok1015/ado-atlas/issues" target="_blank" title="${htmlEsc(window.i18n.t('viewHelp.reportBug'))}">
    <ui-icon name="bug"></ui-icon>
  </a>`;
  box.innerHTML=`<div class="vhh" id="vhh">${bugBtn}${gear}<span class="vhctrl">${collapsed?'▸':'▾'} ${htmlEsc(window.i18n.t('viewHelp.controls'))}</span></div>`+
    `<div class="vhb">`+rows.map(r=>`<div class="vhrow"><span class="vi">${r[0]}</span><span class="vk">${htmlEsc(window.i18n.t('viewHelp.k.'+r[1]))}</span><span class="vd">${htmlEsc(window.i18n.t('viewHelp.d.'+r[2]))}</span></div>`).join('')+
    `<div class="vhnote">${htmlEsc(window.i18n.t('viewHelp.note'))}</div></div>`;
  // Clicking the "Controls" label collapses/expands; the gear is its own button.
  $('vhh').querySelector('.vhctrl').onclick=()=>{try{localStorage.setItem('ado.viewhelp',viewHelpCollapsed()?'1':'0');}catch(e){}renderViewHelp();};
  const gb=$('vhbadge');if(gb)gb.onclick=e=>{e.stopPropagation();toggleBadgePanel();};
  // If the gear vanished (mode without fields, but somehow panel is open), hide the popover.
  if(!hasFields){
    $('badgepanel').style.display='none';
    if (window.LayerManager) window.LayerManager.close($('badgepanel'));
  }
}
// The legend is built in JS from VIEW_HELP, so it won't pick up data-i18n DOM
// updates — re-render it (and the badge panel if open) when the language changes.
if(window.i18n&&window.i18n.onChange)window.i18n.onChange(()=>{ if($('viewhelp'))renderViewHelp(); if($('badgepanel')&&$('badgepanel').style.display!=='none')renderBadgePanel(); });
// Per-view "Show on …" popover (anchored on the Controls box's bottom-left corner).
// Toggling a checkbox re-renders the matching view so the change shows immediately.
const BADGE_PANEL_HEADER={graph:'badgePanel.graph',board:'badgePanel.board',tree:'badgePanel.tree',timeline:'badgePanel.timeline'};
function renderBadgePanel(){
  const view=mode,fields=BADGE_FIELDS_BY_VIEW[view]||[];
  const p=$('badgepanel');
  if(!fields.length){
    p.style.display='none';
    if (window.LayerManager) window.LayerManager.close(p);
    return;
  }
  let html=`<div class="bph">${htmlEsc(BADGE_PANEL_HEADER[view]?window.i18n.t(BADGE_PANEL_HEADER[view]):window.i18n.t('badgePanel.show'))}</div>`+
    fields.map(f=>`<label><input type="checkbox" data-k="${f.key}"${badgeOn(f.key,view)?' checked':''}> ${htmlEsc(f.label)}</label>`).join('');
  if(view==='graph'){
    html+=`<div class="bp-divider" style="margin:8px 0 6px;border-top:1px dashed var(--border)"></div>`+
      `<div class="bp-row" style="display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;padding:2px 0">`+
        `<span>${htmlEsc(window.i18n.t('badgePanel.maxNodes'))}</span>`+
        `<select id="f_max_nodes" style="font-size:11px;padding:2px;background:var(--bg);color:var(--txt);border:1px solid var(--border);border-radius:3px">`+
          `<option value="200">200</option>`+
          `<option value="500">500</option>`+
          `<option value="1000">1000</option>`+
          `<option value="2000">2000</option>`+
          `<option value="5000">5000</option>`+
          `<option value="999999">Unlimited</option>`+
        `</select>`+
      `</div>`;
  }
  p.innerHTML=html;
  p.querySelectorAll('input[data-k]').forEach(cb=>cb.onchange=()=>{
    if(!badgesOn[view])badgesOn[view]={};
    badgesOn[view][cb.dataset.k]=cb.checked;saveBadgesOn();
    if(view==='graph'){if(cy)cy.style(App.graph.gstyle()).update();}   // graph mappers re-read on next paint
    else if(view==='board')App.board.renderBoard();
    else if(view==='tree'){const ts=$('tree').scrollTop;App.tree.renderTree();$('tree').scrollTop=ts;}
    else if(view==='timeline')App.timeline.render();
  });
  if(view==='graph'){
    const mn=$('f_max_nodes');
    if(mn){
      mn.value=String(maxNodesLimit);
      mn.onchange=()=>{
        maxNodesLimit=parseInt(mn.value,10);
        try{localStorage.setItem('ado.maxNodes',maxNodesLimit);}catch(e){}
        App.graph.renderGraph({relayout:true,fit:true});
      };
    }
  }
}
function toggleBadgePanel(){
  const p=$('badgepanel');
  if(p.style.display==='none'){
    renderBadgePanel();
    p.style.display='block';
    if (window.LayerManager) window.LayerManager.open(p, null, { isPopover: true });
  } else {
    p.style.display='none';
    if (window.LayerManager) window.LayerManager.close(p);
  }
}
async function resolveSkippedAncestors(skippers,inSet){
  // For each skipper (parent not in set), climb the chain until an in-set ancestor
  // is found (≤6 levels). Returns {id: {target, via:[skipped ids]}}.
  const result={};
  let frontier=skippers.map(n=>({leaf:n.id,cur:n.parent,via:[]}));
  for(let d=0;d<6&&frontier.length;d++){
    const ids=[...new Set(frontier.map(f=>f.cur))];
    let r;try{r=await api.parents(ids);}catch(e){break;}
    const next=[];
    frontier.forEach(f=>{
      if(inSet.has(f.cur)){result[f.leaf]={target:f.cur,via:f.via};return;}
      const pp=r[f.cur];if(pp==null)return;                       // chain ends → leaf stays a root
      next.push({leaf:f.leaf,cur:pp,via:[...f.via,f.cur]});
    });
    frontier=next;
  }
  return result;
}
async function refresh(){
  // the ONLY place that hits the API for the list (Apply / Search / startup / create)
  loadStart('loading items…');
  try{return await _refresh();}finally{loadEnd();}
}
async function _refresh(){
  const items=await App.tree.currentItems();
  listCapped=!!items.truncated;          // list() hit LIST_CAP → status lines warn
  store.roots=items.map(n=>n.id);        // flat list — board uses this
  items.forEach(n=>{store.nodes[n.id]=n;delete n.via;});
  // RESET hierarchy caches — stale entries from a previous filter would leak via
  // auto-expand (e.g. cached Task children of an Epic when filter is "Epic only").
  const prevExpanded=store.expanded;const firstLoad=!treeEverLoaded;treeEverLoaded=true;
  store.kids={};store.expanded=new Set();
  // Build hierarchy WITHIN the filtered set so tree/graph nest correctly (no duplicates).
  // store.top = items whose parent is NOT in the set (true roots); other items become
  // children of their parent inside the set; pre-populated store.kids avoids API calls.
  const inSet=new Set(store.roots);
  const kidsOf={};
  items.forEach(n=>{if(n.parent&&inSet.has(n.parent))(kidsOf[n.parent]||(kidsOf[n.parent]=[])).push(n.id);});
  // Skipped levels: items whose direct parent is NOT in the set but an ancestor IS.
  // Attach them under that ancestor and remember the skipped chain for a "↗ via" marker.
  const skippers=items.filter(n=>n.parent&&!inSet.has(n.parent));
  const anc=skippers.length?await resolveSkippedAncestors(skippers,inSet):{};
  for(const idStr in anc){const a=anc[idStr],id=+idStr;
    (kidsOf[a.target]||(kidsOf[a.target]=[])).push(id);
    if(store.nodes[id])store.nodes[id].via=a.via;}
  store.top=items.filter(n=>!(n.parent&&inSet.has(n.parent))&&!anc[n.id]).map(n=>n.id);
  Object.keys(kidsOf).forEach(pid=>{store.kids[pid]=kidsOf[pid];if(firstLoad||prevExpanded.has(+pid))store.expanded.add(+pid);});  // auto-expand first load; otherwise preserve manual expand/collapse
  for(const id of [...bulkSel])if(!inSet.has(id))bulkSel.delete(id);   // drop selections that no longer match the filter
  updateBulkBar();
  const ts=$('tree').scrollTop;
  App.tree.renderTree();                          // keep the tree DOM current (cheap, from store)
  $('tree').scrollTop=ts;                // preserve scroll across the rebuild
  if(mode==='graph')App.graph.renderGraph({relayout:true,fit:true});
  else if(mode==='board')App.board.renderBoard();
  else if(mode==='timeline')App.timeline.render();
  if(openSprintPath&&$('sprintview').classList.contains('show'))App.board.renderSprint(openSprintPath);   // live-update open sprint
  App.snapshot.saveSnapshot();                        // cache this view for an instant first paint next session
  loadChildCounts(store.roots.slice());  // fill in n.childCount → hides empty-tree arrows, badges graph nodes
}
// How many children each loaded item has (incl. ones the filter hides), fetched
// cheaply via a links-only query. Stored on the node as n.childCount so it rides
// along into the graph data and the snapshot.
async function fetchChildCounts(ids,force){   // store counts on nodes; return true if anything changed
  ids=(ids||[]).filter(id=>store.nodes[id]&&(force||store.nodes[id].childCount===undefined));   // force=refetch all; else only the not-yet-known
  if(!ids.length)return false;
  let counts;try{counts=await api.childCounts(ids);}catch(e){return false;}
  let changed=false;
  for(const idStr in counts){const n=store.nodes[idStr];if(n&&n.childCount!==counts[idStr]){n.childCount=counts[idStr];changed=true;}}
  return changed;
}
function rerenderChildCounts(){           // reflect freshly-learned counts in the current view
  if(mode==='tree'){const ts=$('tree').scrollTop;App.tree.renderTree();$('tree').scrollTop=ts;}
  else if(mode==='graph'&&cy){cy.batch(()=>cy.nodes().forEach(nd=>{const n=store.nodes[Number(nd.data('id'))];if(n)nd.data('childCount',n.childCount);}));cy.style().update();}
  App.snapshot.saveSnapshot();                         // persist the counts so next session's cached paint has them too
}
let childCountTok=0;
async function loadChildCounts(ids){      // top-level refresh path: guarded so a newer refresh wins
  if(!ids.length)return;
  const tok=++childCountTok;
  const changed=await fetchChildCounts(ids,/*force*/true);   // structure may have changed since last refresh
  if(tok!==childCountTok)return;          // a newer refresh superseded this lookup
  if(changed)rerenderChildCounts();
}

/* ---------- editor ---------- */
/* closePanel -> app/side-panel.js (bare). */
const mdToHtml=AdoLib.mdToHtml;                     // pure, hardened renderer in lib.js
/* attachments + preview-image hydration + @mention coloring -> app/attachments.js (bare).
   descBase / attBlobs / atchState declared there; openItem sets descBase, closePanel resets atchState. */

/* @mention typeahead + full-screen editor toggle -> app/mention.js (bare).
   mentionState declared there; markdown-editor.js drives it; toggleFullscreen used by openItem/closePanel/boot. */
/* side panel: fmtDur/loadTimeline/renderItemContext/toggleSidebarKids/dynamic pickers/
   renderSidebarHeader/openItem -> app/side-panel.js (bare). currentTimelineId/Data declared there. */
/* editor: dirty/textDirty/setSaveChip/refreshDirty/discardChanges/editorValues -> app/editor.js (bare). */

// Picker onChange: auto-save the field, then refresh dirty (which now only
// tracks the manual text fields). quickSave reads orig vs editor so a no-op
// commit (same value) is a cheap early-return.
const onPick=field=>()=>{quickSave(field).finally(refreshDirty);};
const parentEditor=createParentField('s_parent',{onChange:onPick('parent'),getExcludeId:()=>cur});
const parentNew=createParentField('n_parent',{getExcludeId:()=>null});
const assignedEditor=createAssigneeField('s_assigned',{onChange:onPick('assigned')});
const assignedChild=createAssigneeField('c_assigned',{});
const assignedNew=createAssigneeField('n_assigned',{});
const sprintEditor=createSprintField('s_iter',{onChange:onPick('iteration'),getNone:sprintRoot});   // editor: "no sprint" = project root path
const sprintNew=createSprintField('n_iter',{getNone:()=>''});                                // new-item modal: "no sprint" = empty

const bulkAssignedPicker=createAssigneeField('bulk_assigned',{onChange:()=>{const v=$('bulk_assigned').value.trim();if(v!==undefined)bulkApply('assigned',v);}});
const bulkSprintPicker=createSprintField('bulk_iter',{getNone:sprintRoot,onChange:()=>{const v=$('bulk_iter').value.trim();if(v!==undefined)bulkApply('iteration',v);}});
const bulkParentPicker=createParentField('bulk_parent',{getExcludeId:()=>null,onChange:()=>{const v=$('bulk_parent').value.trim();if(v!==undefined)bulkApply('parent',v);}});

/* dependency links -> app/dependencies.js (App.deps.*); depsState stays bare (reset externally) */
const depsState={blockedBy:[],blocks:[]};

/* undo/redo stack (undoStack/pushAction/afterUndo/runStep/runUndo/runRedo/updateUndoButtons)
   -> app/undo.js (bare). Called bare from board/bulk/deps/editor/sprint-edit/palette + app.js. */
// Hide the create affordances (toolbar New, editor + Child) when the user has
// been shown to lack work-item create permission (a create returned HTTP 403).
function updateCreateButtons(){
  const nb=$('newbtn');if(nb)nb.style.display=canCreateItem?'':'none';
  const cb=$('s_childbtn');if(cb)cb.style.display=canCreateItem?'':'none';
}
/* editor save flow: recordEditUndo, applyVisualSync, postSaveRefresh, register helpers,
   time parsing, quickSave, save, comment form -> app/editor.js (bare). */

/* activity feed -> app/activity.js (App.activity.*); reactionCache stays bare (reset externally) */
const reactionCache=new Map();

async function createChild(){
  const type=$('c_type').value,title=$('c_title').value.trim();if(!title||cur==null)return;
  const assigned=$('c_assigned').value.trim(),prio=$('c_prio').value;
  const body={type,title,parent:cur};
  if(assigned)body.assigned=(assigned==='me'?(currentUser||assigned):assigned);
  if(prio)body.priority=Number(prio);
  loadStart('creating…');
  let r;try{r=await api.createItem(body);}catch(e){denyOnForbidden(e,'create work items');setStatus('ERROR: '+e.message,true);loadEnd();return;}
  loadEnd();
  delete store.kids[cur];                          // parent's child list is now stale → reloads on next expand
  recordCreateUndo(r.id,body);
  $('c_title').value='';$('c_title').focus();       // keep form open for rapid multi-create
  setStatus(`created #${r.id} (${type}) under #${cur}`);
  refresh();
}
// create undo/redo: undo deletes the item; redo re-creates it (new id, rebound).
function recordCreateUndo(id,createBody){
  const ref={id},cbody={...createBody};
  pushAction(`create #${id}`,
    async()=>{await api.deleteItem(ref.id);if(cur===ref.id)closePanel(true);await afterUndo(null);},
    async()=>{const nn=await api.createItem(cbody);ref.id=nn.id;await afterUndo(null);});
}
// On an HTTP 403 from a create, remember the user lacks the right and hide the
// matching create affordance for the session.
function denyOnForbidden(e,what){
  if(!/HTTP 403/.test(e.message||''))return false;
  if(what==='create work items'){canCreateItem=false;updateCreateButtons();}
  setStatus("you don't have permission to "+what,true);
  return true;
}

/* create a brand-new item -> app/item-create.js (App.create.*) */

/* ---------- create / edit a sprint (Board → By Sprint "＋" column; sprint screen "edit") ---------- */
/* shared date-picker sync helpers (formatDisplayDate/wireManualDateInput/parseManualDates/syncSide|Bulk|Setup|SideDue*) -> app/date-pickers.js (bare) */

/* create/edit sprint modal -> app/sprint-edit.js (App.sprint.*) */

/* work-item types + legend -> app/types.js (App.types.*) */

/* export the current (filtered) view -> app/export.js (App.export.exportView) */

/* theme + auto-refresh + notify toggles + switchMode -> app/settings.js (App.settings.*) */

/* last-snapshot cache -> app/snapshot.js (App.snapshot.*) */

/* command palette (Ctrl/Cmd+K) -> app/command-palette.js (App.palette.*) */

/* setup cluster (modal/picker/PAT-countdown) -> app/setup.js (App.setup.*) */
let setupAuthMode='pat';                 // which auth pane is active in the setup modal
let patAutoTimer=null;   // debounce for auto-loading org/project after a PAT is pasted

/* ---------- one-time wiring done before the PAT exists ---------- */
function wireSetup(){
  window.addEventListener('ado-401',App.setup.handle401);   // PAT expired/revoked mid-session → reopen setup
  $('setup-save').onclick=App.setup.saveSetup;
  $('setup-pat').addEventListener('input',()=>{   // after a PAT is pasted: persist it and (if an org is set) auto-list its projects
    clearTimeout(patAutoTimer);
    patAutoTimer=setTimeout(async()=>{
      if(setupAuthMode!=='pat')return;
      const pat=$('setup-pat').value.trim();if(!pat)return;
      try{await api.setConfig({authMode:'pat',pat});}catch(e){}
      if($('setup-org').value.trim())App.setup.loadSetupProjects();   // dev.azure.com endpoint — no sign-in redirect
    },700);
  });
  $('setup-org').addEventListener('change',App.setup.loadSetupProjects);   // org chosen → fetch its projects
  $('setup-expiry').addEventListener('change',App.setup.updateSetupExpiryInfo);
  $('setup-expiry').addEventListener('input',App.setup.updateSetupExpiryInfo);
  $('auth-mode').querySelectorAll('button').forEach(b=>b.onclick=()=>App.setup.setAuthPane(b.dataset.am));
  $('oauth-signin').onclick=App.setup.doOauthSignIn;
  $('oauth-tenant-mode').onchange=App.setup.updateTenantField;
  $('oauth-copy').onclick=()=>{
    const i=$('oauth-redirect');
    try{
      navigator.clipboard.writeText(i.value);
      const btn = $('oauth-copy');
      const orig = btn.innerHTML;
      btn.innerHTML = '<ui-icon name="check"></ui-icon> Copied';
      btn.classList.add('copied');
      setTimeout(()=>{
        btn.innerHTML = orig;
        btn.classList.remove('copied');
      }, 1200);
    }catch(e){
      if(i.select)i.select();
    }
  };
  $('setup-cancel').onclick=App.setup.hideSetup;
  $('settingsbtn').onclick=()=>{const mp=$('morepanel');if(mp){mp.style.display='none';$('morebtn').classList.remove('on');}App.setup.showSetup(true);};
  $('ai_settings_btn').onclick=()=>{const mp=$('morepanel');if(mp){mp.style.display='none';$('morebtn').classList.remove('on');}if(window.AISettingsDialog){window.AISettingsDialog.open();}};
  $('patbadge').onclick=()=>App.setup.showSetup(true);
  $('projbadge').onclick=()=>App.setup.showSetup(true);
}
/* layout customization: toolbar/bulk-bar/sidebar persist (load/save/apply/defaults) +
   visual layout builder modal + updateUiScale -> app/layout.js (bare). State there:
   BAR_ITEMS/SIDE_GROUPS/BULK_ITEMS, sideOrder/barOrder/bulkOrder, activeWType, currentSideLayout, cz*. */

/* ---------- main init (runs after PAT is verified) ---------- */
let _booted=false;
async function initialBoot(postSetup){
  try{App.settings.applyTheme(localStorage.getItem('ado.theme')||'dark');}catch(e){}
  App.setup.updateProjectBadge();                  // reflect the active org/project in the title bar
  if(_booted){                           // settings re-save: just reload data
    iterCache=null;depCache={};assignees=[];projectStates=[];tagList=[];sprintPaths=[];sprintNames={};typeList=[];undoStack.length=0;redoStack.length=0;canCreateSprint=true;canEditSprint=true;canCreateItem=true;newSprints.clear();
    updateUndoButtons();updateCreateButtons();
    if (window.FilterBuilderModal && typeof window.FilterBuilderModal.preLoad === 'function') {
      window.FilterBuilderModal.preLoad(true);
    }
    await loadIdentity();await refresh();App.setup.warnIfPatExpiring();return;
  }
  _booted=true;

  if (window.FilterBuilderModal && typeof window.FilterBuilderModal.preLoad === 'function') {
    window.FilterBuilderModal.preLoad();
  }

  App.types.fillTypeSelect('c_type','Task');App.types.fillTypeSelect('n_type','Task');   // seed with fallback now; App.types.loadTypes() refills from ADO
  // switching view is render-only (no API): graph draws from the store, tree DOM persists
  $('mode').querySelectorAll('button').forEach(b=>b.onclick=()=>App.settings.switchMode(b.dataset.m));
  $('emode').querySelectorAll('button').forEach(b=>b.onclick=()=>{edgeMode=b.dataset.e;$('emode').querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===b));App.graph.depHandleHide();App.graph.renderGraph();});
  $('dir').querySelectorAll('button').forEach(b=>b.onclick=()=>{rankDir=b.dataset.d;$('dir').querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===b));try{localStorage.setItem('ado.rankDir',rankDir);}catch(e){}App.graph.renderGraph({relayout:true,fit:true});});
  $('f_sort').onchange=()=>{try{localStorage.setItem('ado.sort',$('f_sort').value);}catch(e){}refresh();};
  for(let o=-12;o<=14;o++)$('f_tz').appendChild(new Option('UTC'+(o>=0?'+':'')+o,o));
  {const s=localStorage.getItem('ado.tz');if(s!==null&&s!=='')tzOffset=parseInt(s);}
  $('f_tz').value=tzOffset;
  $('f_tz').onchange=()=>{tzOffset=parseInt($('f_tz').value);try{localStorage.setItem('ado.tz',tzOffset);}catch(e){}if(mode==='board')App.board.renderBoard();if(cur!=null)loadTimeline(cur);};
  // working-hours window for the active-time calc (defaults 9–17)
  {let ws=9,we=17;const wh=localStorage.getItem('ado.workHours');
    if(wh&&/^\d+-\d+$/.test(wh)){const m=wh.split('-');ws=+m[0];we=+m[1];}
    const r=api.setWorkHours(ws,we);$('f_wh_start').value=r.start;$('f_wh_end').value=r.end;}
  const applyWH=()=>{const r=api.setWorkHours($('f_wh_start').value,$('f_wh_end').value);
    $('f_wh_start').value=r.start;$('f_wh_end').value=r.end;
    try{localStorage.setItem('ado.workHours',r.start+'-'+r.end);}catch(e){}
    if(mode==='board')App.board.renderBoard();if(cur!=null)loadTimeline(cur);};
  $('f_wh_start').onchange=applyWH;$('f_wh_end').onchange=applyWH;
  $('empty_btn').onclick=()=>{const on=$('board').classList.toggle('showempty');$('empty_btn').classList.toggle('on',on);try{localStorage.setItem('ado.showEmpty',on?'1':'0');}catch(e){}
    if(mode==='board'&&boardGroup!=='sprint')App.board.renderBoard();};   // state/assignee add/remove empty columns in JS (sprints are CSS-only)
  $('grp').querySelectorAll('button').forEach(b=>b.onclick=()=>{boardGroup=b.dataset.g;$('grp').querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===b));try{localStorage.setItem('ado.boardGroup',boardGroup);}catch(e){}App.board.renderBoard();});
  // timeline: zoom segment, group select, row click → editor
  $('tlzoom').querySelectorAll('button').forEach(b=>b.onclick=()=>{tlZoom=b.dataset.z;$('tlzoom').querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===b));try{localStorage.setItem('ado.tlZoom',tlZoom);}catch(e){}App.timeline.render();});
  $('tl_group').onchange=()=>{tlGroup=$('tl_group').value;try{localStorage.setItem('ado.tlGroup',tlGroup);}catch(e){}App.timeline.render();};
  $('timeline').addEventListener('click',e=>{const r=e.target.closest&&e.target.closest('.tlrow[data-id]');if(!r)return;
    const id=+r.dataset.id;
    if(e.ctrlKey||e.metaKey){e.preventDefault();bulkToggle(id);return;}        // Ctrl/Cmd: toggle in selection
    if(e.shiftKey){e.preventDefault();bulkRange(id);return;}                    // Shift: range from anchor
    openItem(id);});
  (function(){
    let drag = false;
    let startX = 0;
    let startWidth = 0;
    let activeResizer = null;
    $('timeline').addEventListener('mousedown', e => {
      const resizer = e.target.closest('.tl-col-resizer');
      if (!resizer) return;
      drag = true;
      startX = e.clientX;
      startWidth = tlLabelWidth;
      activeResizer = resizer;
      resizer.classList.add('active');
      document.body.style.cursor = 'col-resize';
      e.preventDefault();
      e.stopPropagation();
    });
    document.addEventListener('mousemove', e => {
      if (!drag) return;
      const deltaX = e.clientX - startX;
      tlLabelWidth = Math.min(Math.max(startWidth + deltaX, 100), 800);
      const corner = document.querySelector('.tlcorner');
      if (corner) corner.style.width = tlLabelWidth + 'px';
      const grid = document.querySelector('.tlgrid');
      if (grid) grid.style.left = tlLabelWidth + 'px';
      document.querySelectorAll('.tllabel, .tlgrouplabel').forEach(el => {
        el.style.width = tlLabelWidth + 'px';
      });
    });
    document.addEventListener('mouseup', () => {
      if (drag) {
        drag = false;
        if (activeResizer) activeResizer.classList.remove('active');
        document.body.style.cursor = '';
        try {
          localStorage.setItem('ado.tlLabelWidth', tlLabelWidth);
        } catch(e) {}
        App.timeline.render();
      }
    });
  })();
  function updateFollowedBtnVisual() {
    const btn = $('followed_btn');
    if (!btn) return;
    const active = window.filterManager ? window.filterManager.isFollowed() : false;
    btn.classList.toggle('on', active);
    btn.innerHTML = active ? '<ui-icon name="star-filled"></ui-icon>' : '<ui-icon name="star"></ui-icon>';
  }
  function toggleFollowedFilter(active) {
    if (window.filterManager) {
      window.filterManager.toggleFollowed(active);
    }
  }
  $('followed_btn').onclick=()=>{
    const active = !$('followed_btn').classList.contains('on');
    toggleFollowedFilter(active);
  };
  $('filt_btn').onclick=()=>{const p=$('filterpanel');const show=p.style.display==='none';p.style.display=show?'flex':'none';$('filt_btn').classList.toggle('on',show);};
  
  // AI Filter Button Wiring
  if ($('ai_filter_btn')) {
    $('ai_filter_btn').onclick = () => {
      if (window.AISearchDialog) {
        if (window.AISearchDialog.hasPendingResult && window.AISearchDialog.hasPendingResult()) {
          window.AISearchDialog.applyPendingResult();
        } else {
          const searchInput = $('search');
          const queryText = searchInput ? searchInput.value.trim() : '';
          window.AISearchDialog.open(queryText);
        }
      }
    };
  }

  async function updateAIFilterButtonState() {
    const btn = $('ai_filter_btn');
    if (!btn) return;

    const wrapper = btn.closest('.fsearch-group-wrapper');
    const badge = wrapper ? wrapper.querySelector('.ai-beta-badge-tiny') : null;

    if (!window.aiProviderRegistry) {
      btn.setAttribute('disabled', 'true');
      btn.title = "AI Service Layer is not initialized.";
      if (badge) badge.style.display = 'none';
      return;
    }

    try {
      btn.removeAttribute('disabled');
      if (badge) badge.style.display = 'inline-block';

      const provider = await window.aiProviderRegistry.getActive();
      if (!provider) {
        btn.innerHTML = `<span class="ricon" style="display:flex; align-items:center; margin:0;"><ui-icon name="sparkles"></ui-icon></span>`;
        btn.title = "Configure AI Search settings.";
        return;
      }

      const avail = await provider.getAvailability();

      if (avail === 'unsupported') {
        btn.innerHTML = `<span class="ricon" style="display:flex; align-items:center; margin:0;"><ui-icon name="sparkles"></ui-icon></span>`;
        btn.title = "Built-in AI is unsupported on this device. Click to configure cloud models.";
      } else if (avail === 'downloadable') {
        btn.innerHTML = `<span class="ricon" style="display:flex; align-items:center; margin:0;"><ui-icon name="sparkles"></ui-icon></span><span style="font-size: 0.75rem; margin-left: 2px; color: #a855f7; position: relative; z-index: 2;"><ui-icon name="download"></ui-icon></span>`;
        btn.title = provider.id === 'chrome-prompt-api' ? "Download AI model and search." : "Configure API Key and search.";
      } else if (avail === 'downloading') {
        btn.innerHTML = `<span class="ricon" style="display:flex; align-items:center; margin:0;"><ui-icon name="sparkles"></ui-icon></span><span style="font-size: 0.75rem; margin-left: 2px; color: #a855f7; position: relative; z-index: 2;"><ui-icon name="clock"></ui-icon></span>`;
        btn.title = "Downloading model... Click to view progress.";
      } else {
        btn.innerHTML = `<span class="ricon" style="display:flex; align-items:center; margin:0;"><ui-icon name="sparkles"></ui-icon></span>`;
        btn.title = "AI Search over work items.";
      }
    } catch (e) {
      btn.setAttribute('disabled', 'true');
      btn.title = "Failed checking AI status: " + e.message;
      if (badge) badge.style.display = 'none';
    }
  }
  window.updateAIFilterButtonState = updateAIFilterButtonState;

  if (window.aiProviderRegistry) {
    window.aiProviderRegistry.onAvailabilityChange(() => {
      updateAIFilterButtonState();
    });
  }
  updateAIFilterButtonState();

  // Advanced Filter Buttons Wiring
  if ($('advanced_filter_btn')) {
    $('advanced_filter_btn').onclick = () => {
      FilterBuilderModal.open(window.filterManager.getIR(), (newIR) => {
        window.filterManager.setIR(newIR);
      });
    };
  }

  if ($('advanced_filter_edit_btn')) {
    $('advanced_filter_edit_btn').onclick = () => {
      FilterBuilderModal.open(window.filterManager.getIR(), (newIR) => {
        window.filterManager.setIR(newIR);
      });
    };
  }

  if ($('advanced_filter_clear_btn')) {
    $('advanced_filter_clear_btn').onclick = () => {
      window.filterManager.clear();
    };
  }

  $('filt_clear_all').onclick=()=>{
    window.filterManager.clear();
  };
  // overflow "⋯" display-options popover — toggle + dismiss on outside click / Esc
  const moreP=$('morepanel'),moreB=$('morebtn');
  const closeMore=()=>{moreP.style.display='none';moreB.classList.remove('on');if (window.LayerManager) window.LayerManager.close(moreP);};
  moreB.onclick=e=>{e.stopPropagation();const show=moreP.style.display==='none';moreP.style.display=show?'flex':'none';moreB.classList.toggle('on',show);
    if (window.LayerManager) {
      if (show) window.LayerManager.open(moreP, null, { isPopover: true });
      else window.LayerManager.close(moreP);
    }
  };
  document.addEventListener('mousedown',e=>{if(moreP.style.display!=='none'&&!moreP.contains(e.target)&&!moreB.contains(e.target))closeMore();});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&moreP.style.display!=='none')closeMore();});
  const updateSearchClear=()=>{
    const btn=$('search-clear');
    if(btn)btn.style.display=$('search').value?'inline-flex':'none';
  };
  $('search').addEventListener('input',updateSearchClear);
  $('search').addEventListener('focus',updateSearchClear);
  $('search').addEventListener('blur',()=>{
    const btn=$('search-clear');
    if(btn)setTimeout(()=>{btn.style.display='none';},150);
  });
  const clearBtn=$('search-clear');
  if(clearBtn){
    clearBtn.onmousedown=e=>e.preventDefault();
    clearBtn.onclick=e=>{
      e.stopPropagation();
      $('search').value='';
      updateSearchClear();
      $('search').focus();
      refresh();
    };
  }
  $('searchbtn').onclick=()=>{const t=$('search').value.trim();if(/^\d+$/.test(t)){openItem(parseInt(t));return;}refresh();};
  $('search').addEventListener('keydown',e=>{if(e.key==='Enter')$('searchbtn').click();});
  // hard refresh: drop every per-session cache and re-fetch everything from the server
  $('refreshbtn').onclick=async()=>{
    const b=$('refreshbtn');b.classList.add('spinning');b.disabled=true;
    try{depCache={};iterCache=null;             // deps + sprints are cached per session
      await refresh();                          // refetch list + rebuild hierarchy from scratch
      if(cur!=null)openItem(cur);               // reload the open editor so its fields match server
    }finally{b.classList.remove('spinning');b.disabled=false;}
  };
  $('fit').onclick=()=>cy&&cy.fit(undefined,40);
  loadBadgesOn();                                                 // restore last "what to show on nodes" choices
  // The Badges trigger is now part of the Controls panel header (wired in renderViewHelp);
  // here we just handle outside-click dismissal of the popover.
  document.addEventListener('mousedown',e=>{
    const p=$('badgepanel');if(p.style.display==='none')return;
    const gb=$('vhbadge');if(!p.contains(e.target)&&e.target!==gb&&(!gb||!gb.contains(e.target)))p.style.display='none';});
  $('theme').onclick=App.settings.cycleTheme;
  try{window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change',()=>{if((localStorage.getItem('ado.theme')||'dark')==='auto')App.settings.applyTheme('auto');});}catch(e){}
  // Only wire real export buttons (data-x). Pro placeholders (data-pro-feature)
  // in the same segment are handled by the delegated premium handler.
  $('export').querySelectorAll('button[data-x]').forEach(b=>b.onclick=()=>App.export.exportView(b.dataset.x));
  $('f_auto').onchange=()=>{const s=$('f_auto').value;try{localStorage.setItem('ado.auto',s);}catch(e){}App.settings.setAutoRefresh(s);};
  $('f_scale').onchange=()=>{const s=$('f_scale').value;try{updateUiScale(parseFloat(s));}catch(e){}};
  if(window.i18n&&$('f_lang')){$('f_lang').value=window.i18n.getLang();$('f_lang').onchange=()=>{window.i18n.setLang($('f_lang').value);};}
  $('f_follow_notify').onclick=App.settings.cycleFollowNotify;
  $('f_mention_notify').onclick=App.settings.cycleMentionNotify;
  // bulk action bar (tree multi-select)
  $('bulk_state').onchange=e=>{const v=e.target.value;if(v)bulkApply('state',v);};
  $('bulk_prio').onchange=e=>{const v=e.target.value;if(v)bulkApply('priority',v);};
  $('bulk_tag_op_seg').querySelectorAll('button').forEach(btn => {
    btn.onclick = () => {
      $('bulk_tag_op_seg').querySelectorAll('button').forEach(b => b.classList.remove('on'));
      btn.classList.add('on');
      if (window.bulkTagsEditor) window.bulkTagsEditor.render();
    };
  });
  $('bulk_tag_btn').onclick=async()=>{
    if(window.bulkTagsEditor && bulkTagsEditor.value()){
      const activeOpBtn=$('bulk_tag_op_seg').querySelector('button.on');
      const op=activeOpBtn?activeOpBtn.dataset.op:'add';
      await bulkApply('tags_'+op, bulkTagsEditor.value());
      bulkTagsEditor.set('', true);
    }
  };
  $('bulk_dates_btn').onclick=()=>{
    const start=$('bulk_start').value;
    const target=$('bulk_target').value;
    if(start||target){
      bulkApply('dates',{start:start||null,target:target||null});
    }
  };
  $('bulk_clear').onclick=clearBulk;
  $('bulk_cust_btn').onclick=()=>{ showCustomize(); setCustomizeTab('bulk'); };
  $('bulk_follow_btn').onclick=async()=>{
    const ids=[...bulkSel];
    if(!ids.length)return;
    const { followedItems = {} } = await chrome.storage.local.get("followedItems");
    const { org, project } = await api.getConfig();
    ids.forEach(id=>{
      const itemData = store.nodes[id];
      if (itemData) {
        followedItems[id] = {
          id: itemData.id,
          title: itemData.title,
          rev: itemData.rev || 1,
          state: itemData.state,
          assigned: itemData.assigned,
          updatedTime: new Date().toISOString(),
          org,
          project
        };
      }
    });
    await chrome.storage.local.set({ followedItems });
    if(cur!=null)FollowManager.updateButtonState(cur);
    updateFollowedBtnVisual();
    syncBulkBarValues();
  };
  $('bulk_unfollow_btn').onclick=async()=>{
    const ids=[...bulkSel];
    if(!ids.length)return;
    const { followedItems = {} } = await chrome.storage.local.get("followedItems");
    ids.forEach(id=>{
      delete followedItems[id];
    });
    await chrome.storage.local.set({ followedItems });
    if(cur!=null)FollowManager.updateButtonState(cur);
    updateFollowedBtnVisual();
    syncBulkBarValues();
  };
  syncBulkDatePicker(null, null);
  // command palette (Ctrl/Cmd+K)
  document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.code==='KeyK'&&!e.altKey){e.preventDefault();
    $('palette').classList.contains('show')?App.palette.closePalette():App.palette.openPalette();}});
  // undo / redo — keyed on e.code (physical key), so it works on non-Latin
  // keyboard layouts; native text-undo wins inside fields.
  document.addEventListener('keydown',e=>{
    if(!(e.ctrlKey||e.metaKey)||e.altKey)return;
    const isZ=e.code==='KeyZ',isY=e.code==='KeyY';
    if(!isZ&&!isY)return;
    const t=e.target,tag=t&&t.tagName;
    if(t&&t.closest&&t.closest('#bulkbar')) {
      // Allow undo/redo inside bulk edit bar inputs/selects
    } else if(tag==='INPUT'||tag==='TEXTAREA'||tag==='SELECT'||(t&&t.isContentEditable))return;
    if($('setup-overlay').classList.contains('show')||$('newitem-overlay').classList.contains('show')||$('sprint-overlay').classList.contains('show')||$('palette').classList.contains('show'))return;
    e.preventDefault();
    if(isY||(isZ&&e.shiftKey))runRedo();else runUndo();});
  // plain "N" opens the new-item modal — only when not typing and no modal/palette is up
  document.addEventListener('keydown',e=>{
    if(e.code!=='KeyN'||e.ctrlKey||e.metaKey||e.altKey||!canCreateItem)return;
    const t=e.target,tag=t&&t.tagName;
    if(tag==='INPUT'||tag==='TEXTAREA'||tag==='SELECT'||(t&&t.isContentEditable))return;
    if($('palette').classList.contains('show')||$('setup-overlay').classList.contains('show')||$('newitem-overlay').classList.contains('show'))return;
    e.preventDefault();App.create.showNewItem();});
  $('palette-input').addEventListener('input',e=>App.palette.renderPalette(e.target.value));
  $('palette-input').addEventListener('keydown',e=>{
    if(e.key==='ArrowDown'){e.preventDefault();e.stopPropagation();App.palette.movePalette(1);}
    else if(e.key==='ArrowUp'){e.preventDefault();e.stopPropagation();App.palette.movePalette(-1);}
    else if(e.key==='Enter'){e.preventDefault();e.stopPropagation();App.palette.runPalette();}
    else if(e.key==='Escape'){e.preventDefault();e.stopPropagation();App.palette.closePalette();}
  });
  $('palette').addEventListener('mousedown',e=>{if(e.target===$('palette'))App.palette.closePalette();});
  (function(){const rz=$('resizer'),side=$('side');let drag=false;     // resizable Work Item panel
    rz.addEventListener('mousedown',e=>{drag=true;rz.classList.add('active');document.body.style.cursor='col-resize';e.preventDefault();});
    document.addEventListener('mousemove',e=>{if(!drag)return;
      const w=Math.min(Math.max(window.innerWidth-e.clientX,300),Math.round(window.innerWidth*0.7));side.style.width=w+'px';});
    document.addEventListener('mouseup',()=>{if(drag){drag=false;rz.classList.remove('active');document.body.style.cursor='';if(cy)cy.resize();try{localStorage.setItem('ado.sideWidth',side.style.width);}catch(e){}}});
  })();
  $('s_save').onclick=save;
  $('s_comment').onclick=()=>{App.activity.toggleActivityExpand(true);toggleComment();};
  // Wrap so the click Event isn't passed as `force` (which would skip the
  // discard-confirm check inside closePanel).
  $('s_close').onclick=()=>closePanel();
  $('s_follow').onclick=async()=>{
    if(cur==null||!activeItemData)return;
    await FollowManager.toggleFollow(cur,activeItemData);
  };
  // Native "leave site?" guard for page reload / tab close / Cmd+W. Modern
  // browsers ignore custom text — assigning any non-empty returnValue is enough
  // to trigger the dialog.
  window.addEventListener('beforeunload',e=>{
    if(dirty()){e.preventDefault();e.returnValue='';return '';}
  });
  $('s_customize').onclick=()=>{setCustomizeTab('side');showCustomize();};   // gear in the panel header → open Customize on the sidebar tab
  $('s_copy_link').onclick = async () => {
    const url = $('s_link').href;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      const btn = $('s_copy_link');
      const orig = btn.innerHTML;
      btn.innerHTML = '<ui-icon name="check"></ui-icon>';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.innerHTML = orig;
        btn.classList.remove('copied');
      }, 1500);
    } catch (err) {
      console.error('Failed to copy: ', err);
    }
  };
  const atchWrap = document.querySelector('.atch-wrap');
  if (atchWrap) {
    const hasFiles = e => !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'));
    let atchDragDepth = 0;
    atchWrap.addEventListener('dragenter', e => {
      if (!hasFiles(e) || cur == null) return;
      e.preventDefault();
      atchDragDepth++;
      atchWrap.classList.add('dragover');
    });
    atchWrap.addEventListener('dragleave', e => {
      if (!hasFiles(e)) return;
      atchDragDepth--;
      if (atchDragDepth <= 0) {
        atchDragDepth = 0;
        atchWrap.classList.remove('dragover');
      }
    });
    atchWrap.addEventListener('dragover', e => {
      if (hasFiles(e)) e.preventDefault();
    });
    atchWrap.addEventListener('drop', e => {
      atchDragDepth = 0;
      atchWrap.classList.remove('dragover');
      if (cur == null || !hasFiles(e)) return;
      e.preventDefault();
      const fs = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
      if (fs.length && descEditor) {
        descEditor.uploadFiles(fs, false);
      }
    });
  }
  commentEditor = new MarkdownEditor('comment_editor_container', {
    placeholder: 'add a comment…',
    allowAttachments: false,
    allowMentions: true
  });
  
  // comment_editor_container actions buttons (Post and Cancel)
  const commentActionsDiv = document.createElement('div');
  commentActionsDiv.className = 'actions';
  commentActionsDiv.innerHTML = `<button class="btn save" id="cm_post">Post</button><button class="btn" id="cm_cancel">Cancel</button>`;
  $('comment_editor_container').appendChild(commentActionsDiv);
  
  // Wire comment actions
  $('cm_post').onclick=postComment;
  $('cm_cancel').onclick=closeCommentForm;

  // Wire s_desc_attach and fullscreen from header
  $('s_desc_full').onclick=()=>toggleFullscreen();
  $('s_desc_attach').onclick=e=>{e.preventDefault();if(cur!=null)descEditor.triggerAttachmentUpload();};  $('s_me').onclick=()=>assignedEditor.set(currentUser||'me');
  $('s_discard').onclick=discardChanges;
  parentEditor.wire();parentNew.wire();   // parent card + searchable picker (editor + New-item modal)
  assignedEditor.wire();assignedChild.wire();assignedNew.wire();   // assignee card + people picker
  sprintEditor.wire();sprintNew.wire();                           // sprint card + iteration picker
  App.deps.depBlockedByPicker.wire();App.deps.depBlocksPicker.wire();               // dependency adders (Blocked-by / Blocks)
  bulkAssignedPicker.wire();bulkSprintPicker.wire();bulkParentPicker.wire();
  assignedEditor.render();assignedChild.render();assignedNew.render();sprintEditor.render();sprintNew.render();tagsEditor.render();   // placeholder cards before first use
  App.deps.depBlockedByPicker.render();App.deps.depBlocksPicker.render();App.deps.renderDeps();   // dep card stubs + empty chip rows
  bulkAssignedPicker.render();bulkSprintPicker.render();bulkParentPicker.render();
  window.bulkTagsEditor = new TagsEditor('bulk_tag_container');
  bulkTagsEditor.render();
  // refreshDirty on every keystroke for ALL editable fields, so the chip flips
  // to "● Unsaved" the moment anything diverges from orig.
  ['s_title','s_state','s_prio','s_start','s_target','s_due','s_est','s_area','s_storypoints','s_remaining','s_completed','s_activity_field','s_risk','s_valuearea'].forEach(id=>{
    const el = $(id);
    if (el) { el.addEventListener('input',refreshDirty);el.addEventListener('change',refreshDirty); } });
  // Native-input auto-save: state / priority / dates / estimate fire quickSave
  // on `change` (which means blur or commit for inputs, value-pick for selects).
  // `input` would be too noisy for est/date.
  const autoSaveMap={s_state:'state',s_prio:'priority',s_start:'start',s_target:'target',s_due:'due',s_est:'estimate',
    s_area:'area',s_storypoints:'storypoints',s_remaining:'remaining',s_completed:'completed',
    s_activity_field:'activity',s_risk:'risk',s_valuearea:'valuearea'};
  Object.entries(autoSaveMap).forEach(([id,field])=>{
    const el = $(id);
    if (el) { el.addEventListener('change',()=>quickSave(field)); }
  });
  ['s_est', 's_remaining', 's_completed'].forEach(id => {
    const el = $(id);
    const prev = $(id + '_preview');
    if (el && prev) {
      const update = () => {
        const txt = formatTimePreview(el.value);
        prev.textContent = txt;
        prev.style.display = txt ? 'block' : 'none';
      };
      el.addEventListener('input', update);
      el.addEventListener('focus', update);
      el.addEventListener('blur', () => { prev.style.display = 'none'; });
    }
  });
  document.addEventListener('keydown',e=>{
    const open=!$('side').classList.contains('hidden');
    if((e.ctrlKey||e.metaKey)&&e.code==='KeyS'&&!e.altKey){if(open){e.preventDefault();save();}}
    else if(e.key==='Escape'){
      if (window.LayerManager && window.LayerManager.stack.length > 0) {
        const topLayer = window.LayerManager.stack[window.LayerManager.stack.length - 1];
        const el = topLayer.element;
        if (el.id === 'palette') { e.preventDefault(); e.stopPropagation(); App.palette.closePalette(); return; }
        if (el.id === 'newitem-overlay') {
          e.preventDefault(); e.stopPropagation();
          if(parentNew.isOpen())parentNew.close();
          else if(assignedNew.isOpen())assignedNew.close();
          else if(sprintNew.isOpen())sprintNew.close();
          else App.create.closeNewItem();
          return;
        }
        if (el.id === 'sprint-overlay') { e.preventDefault(); e.stopPropagation(); App.sprint.closeSprintModal(); return; }
        if (el.id === 'customize-overlay') { e.preventDefault(); e.stopPropagation(); closeCustomize(); return; }
        if (el.id === 'setup-overlay') { e.preventDefault(); e.stopPropagation(); App.setup.hideSetup(); return; }
        if (el.id === 'confirm-overlay') { return; }
        if (el.id === 'link-overlay') { return; }
        if (el.id === 'morepanel') { e.preventDefault(); e.stopPropagation(); closeMore(); return; }
        if (el.id === 'badgepanel') { e.preventDefault(); e.stopPropagation(); toggleBadgePanel(); return; }
        if (el.id === 's_mention') { e.preventDefault(); e.stopPropagation(); closeMention(); return; }
        if (el.classList.contains('drp-popover')) {
          e.preventDefault(); e.stopPropagation();
          el.classList.remove('show');
          window.LayerManager.close(el);
          return;
        }
        if (el.classList.contains('ppick')) {
          e.preventDefault(); e.stopPropagation();
          [parentEditor, assignedEditor, assignedChild, assignedNew, sprintEditor, sprintNew, parentNew, App.deps.depBlockedByPicker, App.deps.depBlocksPicker].forEach(p => {
            if (p && p.isOpen && p.isOpen()) p.close();
          });
          return;
        }
        if (el.classList.contains('reactions-popover')) {
          e.preventDefault(); e.stopPropagation();
          App.activity.closeEmojiPicker();
          return;
        }
        if (el.classList.contains('fullscreen') || el.id === 'side') {
          e.preventDefault(); e.stopPropagation();
          if (el.classList.contains('md-editor')) {
            const btn = el.querySelector('.dbtn-full');
            if(btn)btn.click();
          } else if (el.dataset.sg === 'actions') {
            App.activity.toggleActivityFullscreen(false);
          } else if (el.id === 'side') {
            toggleFullscreen(false);
          }
          return;
        }
      }
      if (open) {
        if(parentEditor.isOpen())parentEditor.close();
        else if(assignedEditor.isOpen())assignedEditor.close();
        else if(assignedChild.isOpen())assignedChild.close();
        else if(sprintEditor.isOpen())sprintEditor.close();
        else if(App.deps.depBlockedByPicker.isOpen())App.deps.depBlockedByPicker.close();
        else if(App.deps.depBlocksPicker.isOpen())App.deps.depBlocksPicker.close();
        else if($('comment_editor_container').style.display==='flex'){closeCommentForm();}
        else if($('child_form').style.display==='flex'){$('child_form').style.display='none';const cb=$('s_childbtn');if(cb)cb.classList.remove('on');}
        else if($('side').classList.contains('fullscreen'))toggleFullscreen(false);
        else closePanel();
      }
    }
  });
  $('s_childbtn').onclick=()=>{App.activity.toggleActivityExpand(true);const f=$('child_form');const show=f.style.display!=='flex';f.style.display=show?'flex':'none';f.style.flexDirection='column';$('s_childbtn').classList.toggle('on', show);if(show){$('c_prio').value = $('s_prio').value || '';$('c_title').focus();}};
  const atb = $('activity_toggle_btn');
  if (atb) {
    atb.onclick = () => {
      const actionsGroup = document.querySelector('.sgroup[data-sg="actions"]');
      if (actionsGroup && actionsGroup.classList.contains('fullscreen')) {
        App.activity.loadActivity();
        return;
      }
      const hidden = $('activity-content').classList.contains('hidden');
      App.activity.toggleActivityExpand(hidden);
    };
  }
  const saf = $('s_act_full');
  if (saf) {
    saf.onclick = () => App.activity.toggleActivityFullscreen();
  }
  App.activity.initActivityResizer();
  $('c_create').onclick=createChild;$('c_cancel').onclick=()=>{$('child_form').style.display='none';$('s_childbtn').classList.remove('on');};
  $('c_me').onclick=()=>assignedChild.set(currentUser||'me');
  $('c_title').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();createChild();}});
  // new-item modal (create from scratch)
  $('newbtn').onclick=()=>App.create.showNewItem();
  $('undobtn').onclick=runUndo;$('redobtn').onclick=runRedo;
  $('n_create').onclick=App.create.createNew;$('n_cancel').onclick=App.create.closeNewItem;
  $('n_me').onclick=()=>assignedNew.set(currentUser||'me');
  $('newitem-overlay').addEventListener('mousedown',e=>{if(e.target===$('newitem-overlay'))App.create.closeNewItem();});
  $('n_title').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();App.create.createNew();}});
  $('newitem-box').addEventListener('keydown',e=>{
    if(e.key==='Escape'){e.preventDefault();e.stopPropagation();if(parentNew.isOpen())parentNew.close();else if(assignedNew.isOpen())assignedNew.close();else if(sprintNew.isOpen())sprintNew.close();else App.create.closeNewItem();}
    else if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){e.preventDefault();App.create.createNew();}});
  // new-sprint modal (Board → By Sprint "＋" column)
  $('sp_create').onclick=App.sprint.createSprintSubmit;$('sp_cancel').onclick=App.sprint.closeSprintModal;
  $('sprint-overlay').addEventListener('mousedown',e=>{if(e.target===$('sprint-overlay'))App.sprint.closeSprintModal();});
  $('sprint-box').addEventListener('keydown',e=>{
    if(e.key==='Escape'){e.preventDefault();e.stopPropagation();App.sprint.closeSprintModal();}
    else if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){e.preventDefault();App.sprint.createSprintSubmit();}});
  $('sp_name').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();App.sprint.createSprintSubmit();}});
  // customize-toolbar dialog
  $('cz_open').onclick=showCustomize;$('cz_done').onclick=closeCustomize;$('cz_reset').onclick=resetCustomize;
  // customize-emojis dialog
  $('emojis_open').onclick=App.activity.showEmojisModal;$('emojis_save').onclick=App.activity.saveEmojis;$('emojis_cancel').onclick=App.activity.closeEmojisModal;$('emojis_reset').onclick=App.activity.resetEmojis;
  $('emojis-overlay').addEventListener('mousedown',e=>{if(e.target===$('emojis-overlay'))App.activity.closeEmojisModal();});
  $('emojis-box').addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();App.activity.closeEmojisModal();}});
  
  // Wire dynamic preview updates and file uploads for customize emojis overlay
  const emojiTypes = ['like', 'dislike', 'heart', 'hooray', 'smile', 'confused'];
  emojiTypes.forEach(type => {
    const input = $(`emoji_override_${type}`);
    if (input) {
      input.addEventListener('input', () => App.activity.updateEmojiInputPreview(type));
    }
  });
  document.querySelectorAll('.emoji-file-input').forEach(fileIn => {
    fileIn.addEventListener('change', e => {
      const type = fileIn.dataset.type;
      const file = e.target.files[0];
      if (file) {
        if (file.size > 256 * 1024) {
          App.activity.showEmojiRowError(type, 'File too large! Choose an image under 256KB.');
          fileIn.value = '';
          return;
        }
        const reader = new FileReader();
        reader.onload = ev => {
          const input = $(`emoji_override_${type}`);
          if (input) {
            input.value = ev.target.result;
            App.activity.updateEmojiInputPreview(type);
          }
        };
        reader.readAsDataURL(file);
      }
    });
  });
  $('cz_tabs').querySelectorAll('button').forEach(b=>b.onclick=()=>setCustomizeTab(b.dataset.cz));
  loadSideLayout(activeWType);applySideLayout(activeWType);          // restore the saved sidebar group order / hidden set
  $('customize-overlay').addEventListener('mousedown',e=>{if(e.target===$('customize-overlay'))closeCustomize();});
  $('customize-box').addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closeCustomize();}});
  loadBarLayout();applyBarLayout();              // apply the saved toolbar order / hidden set
  loadBulkLayout();applyBulkLayout();            // apply the saved bulk edit bar order / hidden set
  wireTreeDnD();                                  // drag tree rows to re-parent
  try {
    window.filterManager = new FilterManager({ quickFilterFields: App.filters.FILTERS.map(f => f.key) });
    window.filterManager.load();
    App.filters.renderFilters();
    App.filters.updateFilterCount();
    window.filterManager.onChange(() => {
      window.filterManager.save();
      updateFollowedBtnVisual();
      App.filters.renderFilters();
      App.filters.updateFilterCount();
      App.filters.scheduleApply();
    });
    updateFollowedBtnVisual();
    chrome.storage.local.get(["followNotify", "mentionNotify", "notifyAge"]).then(({followNotify, mentionNotify, notifyAge})=>{
      App.settings.applyFollowNotify(followNotify||'on');
      App.settings.applyMentionNotify(mentionNotify||'on');
      const ageSel = $('f_notify_age');
      if (ageSel) ageSel.value = notifyAge || '172800';
    });
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      setTimeout(() => {
        try {
          chrome.runtime.sendMessage({ action: "checkMentionsAndFollows" })
            .then(() => {
              const err = chrome.runtime.lastError;
              if (err) console.warn("Could not check notifications on startup:", err.message);
            })
            .catch(err => {
              console.warn("Could not establish connection to background worker on startup:", err.message);
            });
        } catch (_) {}
      }, 500);
    }
    const ageSelect = $('f_notify_age');
    if (ageSelect) {
      ageSelect.onchange = () => {
        chrome.storage.local.set({ notifyAge: ageSelect.value });
      };
    }
    const ss=localStorage.getItem('ado.sort');if(ss!==null)$('f_sort').value=ss;
    if(localStorage.getItem('ado.showEmpty')!=='0'){$('board').classList.add('showempty');$('empty_btn').classList.add('on');}
    const bg=localStorage.getItem('ado.boardGroup');if(bg){boardGroup=bg;$('grp').querySelectorAll('button').forEach(x=>x.classList.toggle('on',x.dataset.g===bg));}
    const tz2=localStorage.getItem('ado.tlZoom');if(tz2&&TL_PX[tz2]){tlZoom=tz2;$('tlzoom').querySelectorAll('button').forEach(x=>x.classList.toggle('on',x.dataset.z===tz2));}
    const tg=localStorage.getItem('ado.tlGroup');if(tg){tlGroup=tg;$('tl_group').value=tg;}
    const sg=localStorage.getItem('ado.sprintGroup');if(sg)sprintGroup=sg;
    const au=localStorage.getItem('ado.auto');if(au!==null){$('f_auto').value=au;App.settings.setAutoRefresh(au);}
    const sc=localStorage.getItem('ado.uiScale');
    if(sc!==null){
      const num=parseFloat(sc);
      if(!isNaN(num)){
        $('f_scale').value=num.toFixed(1);
        updateUiScale(num);
      }
    }
    const mn=localStorage.getItem('ado.maxNodes');if(mn!==null){maxNodesLimit=parseInt(mn,10);}
    const rd=localStorage.getItem('ado.rankDir');if(rd==='TB'||rd==='LR'){rankDir=rd;$('dir').querySelectorAll('button').forEach(x=>x.classList.toggle('on',x.dataset.d===rd));}}catch(e){}
  App.types.buildLegend();App.filters.renderFilters();App.filters.updateFilterCount();App.setup.updatePatBadge();updateUndoButtons();updateCreateButtons();
  setInterval(App.setup.updatePatBadge, 1800000); // refresh the PAT countdown badge every 30 minutes independently of the tasks auto-refresh setting
  await loadIdentity();
  try{
    const savedWidth=localStorage.getItem('ado.sideWidth');
    if(savedWidth)$('side').style.width=savedWidth;
    const savedMode=localStorage.getItem('ado.mode');
    if(savedMode&&savedMode!=='tree')setMode(savedMode);
  }catch(e){}
  renderViewHelp();                          // show the controls legend for the initial view
  const p=new URLSearchParams(location.search),root=p.get('root');
  if(root){await openItem(parseInt(root));}
  if(mode==='tree')await App.snapshot.loadSnapshot();   // paint last session's tree instantly while the network refresh runs
  refresh().then(App.setup.warnIfPatExpiring);   // nudge after the list settles, if the PAT is near expiry
  try {
    const tm = new TutorialManager();
    window.tutorialManagerInstance = tm;
    await tm.init();
  } catch (e) {
    console.error('Failed to initialize TutorialManager:', e);
  }
  setupSettingsTooltips();
}

function setupSettingsTooltips() {
  let globalTooltip = document.getElementById('fb-global-logic-tooltip');
  if (!globalTooltip) {
    globalTooltip = document.createElement('div');
    globalTooltip.id = 'fb-global-logic-tooltip';
    globalTooltip.className = 'logic-tooltip';
    globalTooltip.style.display = 'none';
    document.body.appendChild(globalTooltip);
  }

  const panel = document.getElementById('morepanel');
  if (panel) {
    panel.querySelectorAll('.logic-hint').forEach(hint => {
      hint.onmouseenter = () => {
        if (window.LayerManager) {
          globalTooltip.innerHTML = hint.getAttribute('data-tooltip-html');
          const rect = hint.getBoundingClientRect();
          globalTooltip.style.position = 'absolute';
          globalTooltip.style.top = (rect.bottom + window.scrollY + 6) + 'px';
          globalTooltip.style.left = (rect.left + window.scrollX - 10) + 'px';
          globalTooltip.style.display = 'block';
          window.LayerManager.open(globalTooltip, hint, { isPopover: true, direction: 'bottom' });
        }
      };
      hint.onmouseleave = () => {
        if (window.LayerManager) {
          globalTooltip.style.display = 'none';
          window.LayerManager.close(globalTooltip);
        }
      };
    });
  }
}

async function loadIdentity(){
  if(!currentUser){try{currentUser=await api.me();}catch(e){currentUser='';}}
  try{const asg=await api.assignees();assignees=(asg||[]).filter(a=>a!==currentUser);}
  catch(e){assignees=[];}
  $('assignees').innerHTML=['me',...assignees].map(a=>`<option value="${String(a).replace(/"/g,'&quot;')}">`).join('');
  App.filters.renderFilters();                          // re-render so Assigned chips include people
  loadFilterData().then(App.filters.renderFilters);     // states/tags/sprints fill in async (don't block first paint)
  if(currentUser)$('s_me').title='assign to me ('+currentUser+')';
}
// Populate the data-driven filter chips from the project itself (in parallel):
//   - State: union of states across all work-item types (falls back to a static list)
//   - Tags:  distinct tags sampled from recent items
//   - Sprint: dated iterations (chip value = path, label = short name)
async function loadFilterData(){
  await App.types.loadTypes();                          // real work-item types first (drives the lines below + create dropdowns)
  await Promise.all([
    (async()=>{try{
      const allTypes = typeNames();
      const per = [];
      for (let i = 0; i < allTypes.length; i += 4) {
        const chunk = allTypes.slice(i, i + 4);
        const results = await Promise.all(chunk.map(t => api.states(t).catch(() => [])));
        per.push(...results);
      }
      const all=[];per.forEach(arr=>arr.forEach(s=>{if(!all.includes(s))all.push(s);}));
      projectStates=all.length?orderStates(all):[];
    }catch(e){projectStates=[];}})(),
    (async()=>{try{tagList=await api.tags();$('tagsdl').innerHTML=tagList.map(x=>`<option value="${htmlEsc(x)}">`).join('');}catch(e){tagList=[];}})(),
    (async()=>{try{const its=await getIterations();sprintPaths=its.map(i=>i.path);
      sprintNames={};its.forEach(i=>{sprintNames[i.path]=i.name;});}
      catch(e){sprintPaths=[];sprintNames={};}})(),
  ]);
}

// Delegated handler for any Pro feature entry point. Mark a clickable element
// with `data-pro-feature="<key>"` (key must exist in PremiumPaywall.FEATURES) and
// a click opens the paywall for Free users, or shows a "coming soon" placeholder
// for Pro users until the real feature ships (Stage 3+).
function wirePremiumPlaceholders(){
  document.addEventListener('click',(e)=>{
    const el=e.target.closest('[data-pro-feature]');
    if(!el)return;
    e.preventDefault();
    const feature=el.dataset.proFeature;
    if(window.EntitlementManager && !window.EntitlementManager.gate(feature))return; // Free → paywall shown
    if(window.customAlert)window.customAlert(window.i18n.t('pro.comingSoon'),window.i18n.t('pro.title'));
  });
  // "Explore ADO Atlas Pro" — opens the full premium feature catalog.
  const explore=$('pro_explore_btn');
  if(explore)explore.addEventListener('click',()=>{ if(window.ProFeaturesPanel)window.ProFeaturesPanel.open(); });
}

/* ---------- boot ---------- */
window.addEventListener('DOMContentLoaded',async()=>{
  if(window.i18n){try{await window.i18n.init();window.i18n.applyDOM();}catch(e){}}
  wireSetup();
  FollowManager.init(openItem);
  if (window.EntitlementManager) await window.EntitlementManager.init();
  wirePremiumPlaceholders();
  const cfg=await api.getConfig();
  projectName=cfg.project;                  // "no sprint" root path fallback
  const hasAuth=cfg.authMode==='oauth'?(!!cfg.oauthAccess||!!cfg.oauthRefresh):(!!cfg.pat&&!!cfg.org&&!!cfg.project);
  if(!hasAuth){App.setup.showSetup(false);return;}    // first-run flow takes over
  // Validate the stored credentials before showing the UI: a stale token would
  // otherwise surface as a wall of 401s after the first refresh.
  try{
    const name=await api.me();
    if(!name)throw new Error('no display name');
    currentUser=name;
  }catch(e){App.setup.showSetup(false);$('setup-err').textContent='Stored credentials are invalid: '+e.message;return;}
  initialBoot(false);
});

// Debug method to force notifications check from console
window.debugForceNotificationCheck = function() {
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
    console.log("Forcing background notifications check (follows and mentions)...");
    chrome.runtime.sendMessage({ action: "checkMentionsAndFollows" })
      .then((response) => {
        console.log("Response from background check handler:", response);
      })
      .catch((err) => {
        console.warn("Could not check notifications via debug call:", err.message);
      });
  } else {
    console.error("Chrome extension runtime is not available.");
  }
};

// --- Global Smart Paste Dispatcher ---
document.addEventListener('paste', async (e) => {
  // If the user is typing in an input or textarea, let the default behavior happen 
  // unless it's a massive JSON filter payload that they didn't mean to paste as text.
  const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
  const inInput = activeTag === 'input' || activeTag === 'textarea' || (document.activeElement && document.activeElement.isContentEditable);
  
  // 1. Check for text data (Filter JSON)
  const clipboardData = e.clipboardData || window.clipboardData;
  if (!clipboardData) return;
  
  const pastedText = clipboardData.getData('text');
  if (pastedText && pastedText.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(pastedText);
      // Heuristic for our Filter IR schema
      if (parsed && typeof parsed === 'object' && (parsed.where || parsed.cards)) {
        // If pasting directly into the import textarea, let it happen naturally
        if (inInput && document.activeElement.id === 'fb-ie-text') {
          return;
        }
        
        e.preventDefault(); // Intercept!
        
        if (window.FilterBuilderModal && typeof window.FilterBuilderModal.open === 'function') {
          // Open builder with current config to initialize it
          window.FilterBuilderModal.open(window.filterManager ? window.filterManager.getIR() : null, (newIR) => {
            if (window.filterManager) window.filterManager.setIR(newIR);
          });
          
          // Immediately show the import dialog with the pasted text
          if (typeof window.FilterBuilderModal.showImport === 'function') {
             setTimeout(() => {
               window.FilterBuilderModal.showImport(pastedText);
             }, 50);
          }
        }
        return; // Handled
      }
    } catch(err) {
      // Not valid JSON, ignore
    }
  }

  // 2. Check for image data (Screenshots) - Future proofing
  /*
  const items = clipboardData.items;
  for (let i = 0; i < items.length; i++) {
    if (items[i].type.indexOf('image') !== -1) {
      // const blob = items[i].getAsFile();
      // Handle screenshot paste...
      // e.preventDefault();
      // return;
    }
  }
  */
});

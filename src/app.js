// Front-end of the extension. Port of the inline <script> from ado_web.py
// PAGE — same App.state.store/refresh/tree/graph/board/sprint/editor logic, but every
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
let pinnedSprints=new Set();            // iteration paths pinned to stay expanded (hydrated from App.prefs in initialBoot, after load())
function togglePinSprint(path){
  if(pinnedSprints.has(path))pinnedSprints.delete(path);else pinnedSprints.add(path);
  App.prefs.set('pinnedSprints',JSON.stringify([...pinnedSprints]));
  App.board.renderBoard();
}
let treeEverLoaded=false;                // false only before the very first successful list load
/* App.state.store + App.state.bulkSel now live on App.state (state-globals.js): App.state.store is the
   client-side data mirror (tree + graph render from it; shared `expanded` set), and
   App.state.bulkSel is the tree bulk-edit selection. */
let bulkAnchor=null,bulkAnchorOn=true;     // pivot for Shift-range + whether that action selected (true) or deselected (false)
let dragIds=[],dropTargetEl=null;          // tree drag-to-reparent: ids being dragged + current drop-target row
function reachable(){const out=new Set(),st=[...(App.state.store.top||App.state.store.roots)];
  while(st.length){const id=st.pop();if(out.has(id))continue;out.add(id);
    if(App.state.store.expanded.has(id))(App.state.store.kids[id]||[]).forEach(c=>st.push(c));}
  return out;}
async function ensureKids(id){            // load children once, cache in the App.state.store
  if(!App.state.store.fullKids) App.state.store.fullKids = new Set();
  if(App.state.store.fullKids.has(id)) return App.state.store.kids[id] || [];
  const ord=$('f_sort').value||null;
  let kids;try{kids=await api.children(id,ord);}catch(e){setStatus('ERROR: '+e.message,true);return [];}
  kids.forEach(k=>{App.state.store.nodes[k.id]=k;App.state.store.parent[k.id]=id;});
  App.state.store.kids[id]=kids.map(k=>k.id);
  App.state.store.fullKids.add(id);
  // these were loaded outside the filtered set, so their own child counts are
  // unknown — fetch them so the carets/badges on the new rows resolve too.
  fetchChildCounts(App.state.store.kids[id]).then(changed=>{if(changed)rerenderChildCounts();});
  return App.state.store.kids[id];
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
  const nodes=Object.values(App.state.store.nodes||{});
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
let tlLabelWidth = 240;                           // sticky left label column width (hydrated from App.prefs in initialBoot, after load())
// timeline render (tlDates/tlKey/tlMonths/renderTimeline) -> app/timeline.js (App.timeline.render)

/* ---------- App.state.mode / refresh ---------- */
function setMode(m){
  $('sprintview').classList.remove('show');openSprintPath=null;   // leaving board closes the sprint detail
  if(m!=='graph')App.graph.depHandleHide();             // dep drag-handle is graph-only
  App.state.mode=m;$('mode').querySelectorAll('button').forEach(b=>b.classList.toggle('on',b.dataset.m===m));
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
// Rows App.state.store i18n key suffixes for the key-combo (k) and description (d); the
// icon/symbol (i) is literal. Resolved to localized text in renderViewHelp().
const VIEW_HELP={
  tree:[['<ui-icon name="mouse-pointer"></ui-icon>','click','openItem'],['▸','clickExpand','expandCollapse'],['<ui-icon name="check-square"></ui-icon>','ctrlClick','toggleSelect'],['<ui-icon name="arrow-up-down"></ui-icon>','shiftClick','selectRange'],['<ui-icon name="move"></ui-icon>','drag','reparentRow']],
  graph:[['<ui-icon name="mouse-pointer"></ui-icon>','click','openItem'],['<ui-icon name="mouse-pointer"></ui-icon>','doubleClick','expandCollapseChildren'],['<ui-icon name="check-square"></ui-icon>','ctrlShiftClick','toggleSelect'],['<ui-icon name="move"></ui-icon>','dragNode','moveBackgroundPans'],['<ui-icon name="search"></ui-icon>','scroll','zoom'],['→','depsDragHandle','createDepLink'],['<ui-icon name="trash"></ui-icon>','depsClickEdge','deleteDep']],
  board:[['<ui-icon name="mouse-pointer"></ui-icon>','click','openItem'],['<ui-icon name="check-square"></ui-icon>','ctrlShiftClick','toggleRangeSelect'],['<ui-icon name="move"></ui-icon>','drag','moveToColumn'],['<ui-icon name="plus"></ui-icon>','dragToPlus','newSprintFromCards']],
  timeline:[['<ui-icon name="mouse-pointer"></ui-icon>','click','openItem'],['<ui-icon name="check-square"></ui-icon>','ctrlClick','toggleSelect'],['<ui-icon name="arrow-up-down"></ui-icon>','shiftClick','selectRange']],
};
function viewHelpCollapsed(){try{return App.prefs.get('viewhelp')==='0';}catch(e){return false;}}
function renderViewHelp(){
  const box=$('viewhelp'),rows=VIEW_HELP[App.state.mode];
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
  const hasFields=!!(BADGE_FIELDS_BY_VIEW[App.state.mode]&&BADGE_FIELDS_BY_VIEW[App.state.mode].length);
  const gear=hasFields?`<button class="vhbadge" id="vhbadge" title="${htmlEsc(window.i18n.t('viewHelp.toggleFields'))}"><ui-icon name="settings"></ui-icon></button>`:'';
  const bugBtn=`<a class="icon-btn" href="https://github.com/Prorok1015/ado-atlas/issues" target="_blank" title="${htmlEsc(window.i18n.t('viewHelp.reportBug'))}">
    <ui-icon name="bug"></ui-icon>
  </a>`;
  box.innerHTML=`<div class="vhh" id="vhh">${bugBtn}${gear}<span class="vhctrl">${collapsed?'▸':'▾'} ${htmlEsc(window.i18n.t('viewHelp.controls'))}</span></div>`+
    `<div class="vhb">`+rows.map(r=>`<div class="vhrow"><span class="vi">${r[0]}</span><span class="vk">${htmlEsc(window.i18n.t('viewHelp.k.'+r[1]))}</span><span class="vd">${htmlEsc(window.i18n.t('viewHelp.d.'+r[2]))}</span></div>`).join('')+
    `<div class="vhnote">${htmlEsc(window.i18n.t('viewHelp.note'))}</div></div>`;
  // Clicking the "Controls" label collapses/expands; the gear is its own button.
  $('vhh').querySelector('.vhctrl').onclick=()=>{App.prefs.set('viewhelp',viewHelpCollapsed()?'1':'0');renderViewHelp();};
  const gb=$('vhbadge');if(gb)gb.onclick=e=>{e.stopPropagation();toggleBadgePanel();};
  // If the gear vanished (App.state.mode without fields, but somehow panel is open), hide the popover.
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
  const view=App.state.mode,fields=BADGE_FIELDS_BY_VIEW[view]||[];
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
    if(view==='graph'){if(App.state.cy)App.state.cy.style(App.graph.gstyle()).update();}   // graph mappers re-read on next paint
    else if(view==='board')App.board.renderBoard();
    else if(view==='tree'){const ts=$('tree').scrollTop;App.tree.renderTree();$('tree').scrollTop=ts;}
    else if(view==='timeline')App.timeline.render();
  });
  if(view==='graph'){
    const mn=$('f_max_nodes');
    if(mn){
      mn.value=String(App.state.maxNodesLimit);
      mn.onchange=()=>{
        App.state.maxNodesLimit=parseInt(mn.value,10);
        App.prefs.set('maxNodes',App.state.maxNodesLimit);
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
      let cur = f.cur;
      if (cur && typeof cur === 'string' && !cur.includes(':')) cur = 'ado:' + cur;
      else if (typeof cur === 'number') cur = 'ado:' + cur;

      if(inSet.has(cur)){result[f.leaf]={target:cur,via:f.via};return;}
      const pp=r[cur];if(pp==null)return;                       // chain ends → leaf stays a root
      next.push({leaf:f.leaf,cur:pp,via:[...f.via,cur]});
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
  App.state.store.roots=items.map(n=>n.id);        // flat list — board uses this
  items.forEach(n=>{App.state.store.nodes[n.id]=n;delete n.via;});
  // RESET hierarchy caches — stale entries from a previous filter would leak via
  // auto-expand (e.g. cached Task children of an Epic when filter is "Epic only").
  const prevExpanded=App.state.store.expanded;const firstLoad=!treeEverLoaded;treeEverLoaded=true;
  App.state.store.kids={};App.state.store.expanded=new Set();App.state.store.fullKids=new Set();App.state.store.showAllKids=new Set();
  // Build hierarchy WITHIN the filtered set so tree/graph nest correctly (no duplicates).
  // App.state.store.top = items whose parent is NOT in the set (true roots); other items become
  // children of their parent inside the set; pre-populated App.state.store.kids avoids API calls.
  const inSet=new Set(App.state.store.roots);
  const kidsOf={};
  items.forEach(n=>{if(n.parent&&inSet.has(n.parent))(kidsOf[n.parent]||(kidsOf[n.parent]=[])).push(n.id);});
  // Skipped levels: items whose direct parent is NOT in the set but an ancestor IS.
  // Attach them under that ancestor and remember the skipped chain for a "↗ via" marker.
  const skippers=items.filter(n=>n.parent&&!inSet.has(n.parent));
  const anc=skippers.length?await resolveSkippedAncestors(skippers,inSet):{};
  for(const idStr in anc){const a=anc[idStr],id=idStr;
    (kidsOf[a.target]||(kidsOf[a.target]=[])).push(id);
    if(App.state.store.nodes[id])App.state.store.nodes[id].via=a.via;}
  App.state.store.top=items.filter(n=>!(n.parent&&inSet.has(n.parent))&&!anc[n.id]).map(n=>n.id);
  Object.keys(kidsOf).forEach(pid=>{App.state.store.kids[pid]=kidsOf[pid];if(prevExpanded.has(pid))App.state.store.expanded.add(pid);});  // preserve manual expand/collapse
  for(const id of [...App.state.bulkSel])if(!inSet.has(id))App.state.bulkSel.delete(id);   // drop selections that no longer match the filter
  updateBulkBar();
  const ts=$('tree').scrollTop;
  App.tree.renderTree();                          // keep the tree DOM current (cheap, from App.state.store)
  $('tree').scrollTop=ts;                // preserve scroll across the rebuild
  if(App.state.mode==='graph')App.graph.renderGraph({relayout:true,fit:true});
  else if(App.state.mode==='board')App.board.renderBoard();
  else if(App.state.mode==='timeline')App.timeline.render();
  if(openSprintPath&&$('sprintview').classList.contains('show'))App.board.renderSprint(openSprintPath);   // live-update open sprint
  App.snapshot.saveSnapshot();                        // cache this view for an instant first paint next session
  loadChildCounts(App.state.store.roots.slice());  // fill in n.childCount → hides empty-tree arrows, badges graph nodes
}
// How many children each loaded item has (incl. ones the filter hides), fetched
// cheaply via a links-only query. Stored on the node as n.childCount so it rides
// along into the graph data and the snapshot.
async function fetchChildCounts(ids,force){   // App.state.store counts on nodes; return true if anything changed
  ids=(ids||[]).filter(id=>App.state.store.nodes[id]&&(force||App.state.store.nodes[id].childCount===undefined));   // force=refetch all; else only the not-yet-known
  if(!ids.length)return false;
  let counts;try{counts=await api.childCounts(ids);}catch(e){return false;}
  let changed=false;
  for(const idStr in counts){const n=App.state.store.nodes[idStr];if(n&&n.childCount!==counts[idStr]){n.childCount=counts[idStr];changed=true;}}
  return changed;
}
function rerenderChildCounts(){           // reflect freshly-learned counts in the current view
  if(App.state.mode==='tree'){const ts=$('tree').scrollTop;App.tree.renderTree();$('tree').scrollTop=ts;}
  else if(App.state.mode==='graph'&&App.state.cy){App.state.cy.batch(()=>App.state.cy.nodes().forEach(nd=>{const n=App.state.store.nodes[nd.data('id')];if(n)nd.data('childCount',n.childCount);}));App.state.cy.style().update();}
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
// tracks the manual text fields). quickSave reads App.state.orig vs editor so a no-op
// commit (same value) is a cheap early-return.
const onPick=field=>()=>{quickSave(field).finally(refreshDirty);};
const parentEditor=createParentField('s_parent',{onChange:onPick('parent'),getExcludeId:()=>App.state.cur});
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
  const type=$('c_type').value,title=$('c_title').value.trim();if(!title||App.state.cur==null)return;
  const assigned=$('c_assigned').value.trim(),prio=$('c_prio').value;
  const body={type,title,parent:App.state.cur};
  if(assigned)body.assigned=(assigned==='me'?(currentUser||assigned):assigned);
  if(prio)body.priority=Number(prio);
  loadStart('creating…');
  let r;try{r=await api.createItem(body);}catch(e){denyOnForbidden(e,'create work items');setStatus('ERROR: '+e.message,true);loadEnd();return;}
  loadEnd();
  delete App.state.store.kids[App.state.cur];                          // parent's child list is now stale → reloads on next expand
  recordCreateUndo(r.id,body);
  $('c_title').value='';$('c_title').focus();       // keep form open for rapid multi-create
  setStatus(`created #${App.backend.nid(r.id)} (${type}) under #${App.backend.nid(App.state.cur)}`);
  refresh();
}
// create undo/redo: undo deletes the item; redo re-creates it (new id, rebound).
function recordCreateUndo(id,createBody){
  const ref={id},cbody={...createBody};
  pushAction(`create #${App.backend.nid(id)}`,
    async()=>{await api.deleteItem(ref.id);if(App.state.cur===ref.id)closePanel(true);await afterUndo(null);},
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
      const origHtml = btn.innerHTML;
      btn.innerHTML = '<ui-icon name="check"></ui-icon> Copied';
      btn.classList.add('copied');
      setTimeout(()=>{
        btn.innerHTML = origHtml;
        btn.classList.remove('copied');
      }, 1200);
    }catch(e){
      if(i.select)i.select();
    }
  };
  $('setup-cancel').onclick=App.setup.hideSetup;
  $('settingsbtn').onclick=()=>{if(typeof closeMore === 'function') closeMore(); App.setup.showSetup(true);};
  $('ai_settings_btn').onclick=()=>{if(typeof closeMore === 'function') closeMore(); if(window.AISettingsDialog){window.AISettingsDialog.open();}};
  $('patbadge').onclick=()=>App.setup.showSetup(true);
  $('projbadge').onclick=()=>App.setup.showSetup(true);
}
/* layout customization: toolbar/bulk-bar/sidebar persist (load/save/apply/defaults) +
   visual layout builder modal + updateUiScale -> app/layout.js (bare). State there:
   BAR_ITEMS/SIDE_GROUPS/BULK_ITEMS, sideOrder/barOrder/bulkOrder, activeWType, currentSideLayout, cz*. */

/* main init: initialBoot + setupSettingsTooltips/loadIdentity/loadFilterData/
   wirePremiumPlaceholders -> app/init.js (bare). initialBoot called bare from boot.js + setup.js. */

/* boot: DOMContentLoaded bootstrap + debug hook + global smart-paste dispatcher -> app/boot.js (bare, loads last). */

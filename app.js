// Front-end of the extension. Port of the inline <script> from ado_web.py
// PAGE — same store/refresh/tree/graph/board/sprint/editor logic, but every
// fetch('/api/...') is now a direct call to api.* (no Flask in between).
//
// Boot sequence (different from the Flask version):
//   1. Wait for chrome.storage to surface a PAT (setup modal otherwise).
//   2. Verify with api.me() — invalid PAT → re-open setup with an error.
//   3. Run the original initialisation (legend, filters, refresh).

cytoscape.use(cytoscapeDagre);
// Type colours: seeded with sensible defaults for instant first paint, then
// overwritten by the project's real process colours once they load from ADO.
// The hex map feeds the canvas graph; DOM views use a CSS custom property so the
// real colour propagates live (no re-render) once loadTypes() sets it on :root.
let TYPE_COLOR={Epic:'#8e44ad',Feature:'#e67e22','User Story':'#3498db',Bug:'#e74c3c',Task:'#7f8c8d',Issue:'#16a085'};
const tyVar=t=>'--ty-'+String(t).toLowerCase().replace(/[^a-z0-9]+/g,'-');
const tyColor=t=>`var(${tyVar(t)}, ${TYPE_COLOR[t]||'#95a5a6'})`;   // CSS var with the default hex as fallback
const PRIO_COLOR={1:'#e74c3c',2:'#e67e22',3:'#f1c40f',4:'#95a5a6'};   // P1 urgent … P4 low
const prioColor=p=>PRIO_COLOR[p]||'#5b6b7d';
const STATE_COLOR={New:'#6b7785',Active:'#2f6fed',Resolved:'#1e7a44',Closed:'#5b6b7d',Removed:'#9b2c2c',Done:'#1e7a44'};
const stateColor=s=>STATE_COLOR[s]||'#6b7785';
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
let cy=null, mode='tree', edgeMode='hierarchy', rankDir='LR', cur=null, orig={}, selRow=null;
let depCache={}, renderToken=0, boardToken=0, tlToken=0;   // tokens drop superseded async renders
let tlZoom='week', tlGroup='none';               // timeline view: zoom (day|week|month) + row grouping
let openToken=0;                                // drops superseded openItem() calls
let boardBusy=false;                            // true while a card move PATCH is in flight
let pdrag=null, suppressClick=false;            // custom pointer-based drag for board cards
let boardScroll=null;                           // saved board scroll to restore from the sprint view
let boardGroup='sprint';                        // board grouping: 'sprint' | 'assignee' | 'state'
let canCreateSprint=true;                       // show the "add sprint" column until a create is denied (403)
let canEditSprint=true;                          // show the sprint "✎ dates" button until an edit is denied (403)
let canCreateItem=true;                         // show the New / + Child buttons until a create is denied (403)
const newSprints=new Set();                     // sprint paths created this session — stay visible while still empty
let pendingSprintItems=null;                     // cards dropped on "＋ New sprint" → moved into the sprint once created
let tzOffset=Math.round(-new Date().getTimezoneOffset()/60);   // UTC offset for work-hours (default: browser TZ)
let sprintGroup='none';                         // expanded-sprint grouping: 'none' | 'assignee'
let currentUser='';                      // display name of the PAT owner (for the "me" shortcuts)
let projectName='';                      // configured ADO project (root path = "no sprint" fallback)
let assignees=[];                        // participant names (for the Assigned filter chips + datalist)
let projectStates=[];                    // real states fetched from the project (State filter chips)
let tagList=[];                          // distinct tags seen on recent items (Tags filter chips)
let sprintPaths=[];                      // iteration paths for the Sprint filter (chip value = path)
let sprintNames={};                      // iteration path -> short sprint name (chip label)
let listCapped=false;                    // true when the last list() hit LIST_CAP (UI warns)
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

function setStatus(t,err){const s=$('status');if(!s)return;s.textContent=t;s.style.color=err?'#e06c75':'var(--muted)';}
function capNote(){return listCapped?' · capped, narrow the filters':'';}   // appended to count statuses when LIST_CAP was hit
// ---- loading indicator (refcounted: top progress bar shows while any async work runs) ----
let _loads=0;
function loadStart(label){_loads++;const l=$('loading');if(l)l.classList.add('on');if(label)setStatus(label);}
function loadEnd(){_loads=Math.max(0,_loads-1);if(_loads===0){const l=$('loading');if(l)l.classList.remove('on');}}
async function withLoad(label,fn){loadStart(label);try{return await fn();}finally{loadEnd();}}
/* ---------- extensible chip filters (data-driven) ----------
   Add a field: one entry here + one in FILTER_FIELDS in api.js. */
const FILTERS=[
  {key:'state',label:'State',values:()=>projectStates.length?projectStates:['New','Active','Resolved','Closed','Removed']},
  {key:'type',label:'Type',values:()=>typeNames()},
  {key:'priority',label:'Priority',values:()=>[1,2,3,4],fmt:v=>'P'+v},
  {key:'assigned',label:'Assigned',values:()=>['me',...assignees]},
  {key:'iteration',label:'Sprint',values:()=>sprintPaths,fmt:p=>sprintNames[p]||p},
  {key:'tags',label:'Tags',values:()=>tagList},
];
const fstate={};                          // key -> { value : 'in' | 'out' }
function cycleChip(key,val){
  const m=fstate[key]||(fstate[key]={});const v=String(val);
  if(!m[v])m[v]='in'; else if(m[v]==='in')m[v]='out'; else delete m[v];
}
function filtersObj(){
  const out={};
  for(const f of FILTERS){const m=fstate[f.key]||{};const inc=[],exc=[];
    for(const v in m)(m[v]==='in'?inc:exc).push(v);
    if(inc.length||exc.length)out[f.key]={in:inc,not:exc};}
  return out;
}
function filterCount(){let n=0;for(const k in fstate)n+=Object.keys(fstate[k]).length;return n;}
function updateFilterCount(){const n=filterCount();$('filt_count').textContent=n?('('+n+')'):'';}
function renderFilters(){
  const el=$('filterchips');el.innerHTML='';
  // "Clear all" — only when at least one filter has a selection
  if(filterCount()>0){
    const all=document.createElement('button');
    all.className='fclear fclear-all';all.title='clear all filters';all.textContent='✕ Clear all';
    all.onclick=()=>{for(const k in fstate)delete fstate[k];renderFilters();updateFilterCount();scheduleApply();};
    el.appendChild(all);
  }
  FILTERS.forEach(f=>{
    const vals=f.values()||[];
    if(!vals.length&&!Object.keys(fstate[f.key]||{}).length)return;   // skip empty rows (e.g. tags/sprints not loaded yet)
    const row=document.createElement('div');row.className='frow';
    const lab=document.createElement('span');lab.className='fl';lab.textContent=f.label;row.appendChild(lab);
    // per-row clear "✕" sits left of the chips. ALWAYS rendered so the chip
    // alignment doesn't jump when it appears/disappears; visibility:hidden
    // keeps the slot reserved when this filter has no selection.
    const x=document.createElement('button');
    x.className='fclear';x.title='clear this filter';x.textContent='✕';
    if(Object.keys(fstate[f.key]||{}).length)
      x.onclick=()=>{delete fstate[f.key];renderFilters();updateFilterCount();scheduleApply();};
    else{x.style.visibility='hidden';x.tabIndex=-1;}
    row.appendChild(x);
    vals.forEach(v=>{
      const ch=document.createElement('span');ch.className='chip';
      const st=(fstate[f.key]||{})[String(v)];if(st)ch.classList.add(st);
      ch.textContent=f.fmt?f.fmt(v):v;
      ch.onclick=()=>{cycleChip(f.key,v);renderFilters();updateFilterCount();scheduleApply();};
      row.appendChild(ch);
    });
    el.appendChild(row);
  });
  buildBulkControls();                      // keep the bulk-bar dropdowns in sync with loaded data
}
let applyTimer=null;
function saveFilters(){try{localStorage.setItem('ado.filters',JSON.stringify(fstate));}catch(e){}}
function scheduleApply(){saveFilters();clearTimeout(applyTimer);applyTimer=setTimeout(refresh,500);}  // persist + debounce (long enough to click several chips)

/* ---------- tree ---------- */
function childrenUl(id){
  const ul=document.createElement('ul');const kids=store.kids[id]||[];
  if(!kids.length){const e=document.createElement('div');e.className='empty';e.textContent='(no children)';ul.appendChild(e);}
  kids.forEach(cid=>{if(store.nodes[cid])ul.appendChild(treeNode(store.nodes[cid]));});
  return ul;
}
function treeNode(n){
  const li=document.createElement('li');
  const row=document.createElement('div');row.className='trow';
  if(bulkSel.has(n.id))row.classList.add('bulksel');
  row.dataset.id=n.id;                                  // for Shift-click range selection
  row.draggable=true;                                   // drag onto another row to re-parent
  const cb=document.createElement('input');cb.type='checkbox';cb.className='tcheck';cb.checked=bulkSel.has(n.id);
  cb.title='select for bulk edit  (or Ctrl-click the row; Shift-click for a range)';
  cb.onclick=e=>{e.stopPropagation();bulkSet([n.id],cb.checked);bulkAnchor=n.id;bulkAnchorOn=cb.checked;};
  const open=store.expanded.has(n.id);
  // Show the expand caret only when the item can have children: known in-set kids,
  // a positive child count, or an as-yet-unknown count (undefined → keep the caret).
  const hasKids=(store.kids[n.id]||[]).length>0||n.childCount===undefined||n.childCount>0;
  const tog=document.createElement('span');tog.className='tog';
  if(hasKids){tog.textContent=open?'▾':'▸';tog.onclick=e=>{e.stopPropagation();toggle(li,n,tog);};}
  else{tog.classList.add('leaf');}     // childless → blank spacer keeps labels aligned
  const dot=document.createElement('i');dot.className='dot';dot.style.background=tyColor(n.type);
  const lab=document.createElement('span');lab.className='lab';lab.textContent=`#${n.id} ${n.title}`;
  if(n.via&&n.via.length){const m=document.createElement('span');m.className='skip';m.textContent=' ↗';
    m.title='via '+n.via.map(i=>'#'+i).join(' → ')+' (not in filter)';lab.appendChild(m);}
  const bdg=document.createElement('span');bdg.className='badge';bdg.textContent=n.state;
  row.append(cb,tog,dot,lab,bdg);
  if(n.priority){const pc=document.createElement('span');pc.className='prio';pc.textContent='P'+n.priority;
    pc.style.background=prioColor(n.priority);pc.title='priority '+n.priority;row.insertBefore(pc,bdg);}
  if(n.tags){const ts=tagList_(n.tags);if(ts.length){const show=ts.slice(0,3),extra=ts.length-show.length;
    bdg.style.marginLeft='0';
    show.forEach((t,i)=>{const tc=document.createElement('span');tc.className='ttag';tc.textContent=t;tc.style.background=personColor(t);tc.title=t;if(i===0)tc.style.marginLeft='auto';row.insertBefore(tc,bdg);});
    if(extra>0){const tc=document.createElement('span');tc.className='ttag';tc.textContent='+'+extra;tc.style.background='var(--muted)';row.insertBefore(tc,bdg);}}}
  if(n.id===cur){row.classList.add('sel');selRow=row;}   // keep highlight across re-renders
  row.onclick=(e)=>{
    if(e.ctrlKey||e.metaKey){e.preventDefault();bulkToggle(n.id);return;}        // Ctrl/Cmd: toggle in selection
    if(e.shiftKey){e.preventDefault();bulkRange(n.id);return;}                    // Shift: select the range from the anchor
    if(selRow)selRow.classList.remove('sel');selRow=row;row.classList.add('sel');openItem(n.id);   // plain click: open
  };
  li.appendChild(row);
  if(open&&hasKids)li.appendChild(childrenUl(n.id));    // auto-expand from shared state (never for a known-leaf)
  return li;
}
async function toggle(li,n,tog){
  if(store.expanded.has(n.id)){            // collapse (cached data stays)
    store.expanded.delete(n.id);
    const u=li.querySelector('ul');if(u)u.remove();tog.textContent='▸';return;
  }
  tog.textContent='⌛';tog.classList.add('busy');loadStart();
  try{await ensureKids(n.id);
    store.expanded.add(n.id);
    li.appendChild(childrenUl(n.id));
  }finally{tog.classList.remove('busy');tog.textContent='▾';loadEnd();}
}
function activeText(){const t=$('search').value.trim();return (t && !/^\d+$/.test(t))?t:null;}
async function currentItems(){
  // the single source of truth for BOTH views: filters (+ optional title search)
  const order=$('f_sort').value||undefined,filters=filtersObj(),text=activeText()||undefined;
  try{return text ? await api.search({text,order,filters}) : await api.roots({order,filters});}
  catch(e){setStatus('ERROR: '+e.message,true);return [];}
}
function renderTree(){
  const el=$('tree');el.innerHTML='';selRow=null;
  const ul=document.createElement('ul');ul.className='tree';
  (store.top||store.roots).forEach(id=>{if(store.nodes[id])ul.appendChild(treeNode(store.nodes[id]));});
  el.appendChild(ul);
  setStatus(store.roots.length+' item(s)'+capNote());
}

/* ---------- bulk multi-select (tree): Ctrl/Cmd-click toggles, Shift-click ranges ---------- */
// Selectable elements of the active view (tree rows / board cards / timeline rows), in visual order.
function bulkEls(){return [...document.querySelectorAll(mode==='board'?'#board .bcard[data-id]':mode==='timeline'?'#timeline .tlrow[data-id]':'#tree .trow[data-id]')];}
function syncBulkRows(){                    // reflect bulkSel onto the rendered rows/cards (class + any checkbox)
  document.querySelectorAll('#tree .trow[data-id], #board .bcard[data-id], #timeline .tlrow[data-id]').forEach(r=>{
    const on=bulkSel.has(+r.dataset.id);r.classList.toggle('bulksel',on);
    const cb=r.querySelector('.tcheck');if(cb)cb.checked=on;});
}
function bulkSet(ids,on){ids.forEach(id=>{if(on)bulkSel.add(id);else bulkSel.delete(id);});updateBulkBar();syncBulkRows();syncGraphBulk();}
function bulkToggle(id){const on=!bulkSel.has(id);bulkSet([id],on);bulkAnchor=id;bulkAnchorOn=on;}
function bulkRange(toId){                    // apply the anchor's action (select OR deselect) to the whole range
  const ids=bulkEls().map(r=>+r.dataset.id);
  const b=ids.indexOf(toId);if(b<0)return;
  let a=bulkAnchor!=null?ids.indexOf(bulkAnchor):-1;if(a<0){a=b;bulkAnchor=toId;}
  bulkSet(ids.slice(Math.min(a,b),Math.max(a,b)+1),bulkAnchorOn);
}
function clearBulk(){bulkSel.clear();bulkAnchor=null;updateBulkBar();syncBulkRows();syncGraphBulk();}
function updateBulkBar(){const n=bulkSel.size;$('bulkbar').style.display=n?'flex':'none';$('bulk_count').textContent=n+' selected';}

/* ---------- tree drag-to-re-parent (single or bulk) ---------- */
function descendantsOf(ids){                 // loaded descendants of ids (to block cycles)
  const set=new Set(),stack=[...ids];
  while(stack.length){const id=stack.pop();(store.kids[id]||[]).forEach(c=>{if(!set.has(c)){set.add(c);stack.push(c);}});}
  return set;
}
function canDrop(ids,targetId){              // targetId==='' means drop to root
  if(targetId==='')return true;
  if(ids.includes(targetId))return false;                       // can't be its own child
  return !descendantsOf(ids).has(targetId);                     // …or under its own descendant (cycle)
}
async function doReparent(ids,targetId){     // targetId: an id, or '' for root
  ids=ids.filter(id=>id!==targetId&&store.nodes[id]);
  if(!ids.length||!canDrop(ids,targetId))return;
  const olds=ids.map(id=>({id,old:(store.nodes[id].parent!=null?store.nodes[id].parent:'')}));
  if(ids.every((id,i)=>String(olds[i].old)===String(targetId)))return;   // already there → no-op
  loadStart(`re-parenting ${ids.length} item(s)…`);
  const res=await api.pool(ids.map(id=>async()=>{try{await api.setParent(id,targetId);return true;}catch(e){return false;}}),6);
  loadEnd();
  const ok=res.filter(Boolean).length,fail=res.length-ok;
  if(ok)pushAction(`re-parent ${ids.length} item(s)`,
    async()=>{await api.pool(olds.map(o=>async()=>{try{await api.setParent(o.id,o.old);}catch(e){}}),6);await afterUndo(null);},
    async()=>{await api.pool(ids.map(id=>async()=>{try{await api.setParent(id,targetId);}catch(e){}}),6);await afterUndo(null);});
  if(targetId!=='')store.expanded.add(+targetId);              // reveal the moved items under the new parent
  setStatus(`re-parented ${ok} item(s)`+(targetId!==''?` under #${targetId}`:' to root')+(fail?`, ${fail} failed`:''),!!fail);
  await refresh();
}
function cleanupDrag(){
  document.querySelectorAll('#tree .trow.dragging,#tree .trow.droptarget').forEach(el=>el.classList.remove('dragging','droptarget'));
  $('tree').classList.remove('droproot');dropTargetEl=null;dragIds=[];
}
function wireTreeDnD(){
  const t=$('tree');
  t.addEventListener('dragstart',e=>{
    const row=e.target.closest&&e.target.closest('.trow[data-id]');if(!row)return;
    const id=+row.dataset.id;
    dragIds=(bulkSel.has(id)&&bulkSel.size>1)?[...bulkSel]:[id];
    try{e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',String(id));}catch(_){}
    dragIds.forEach(d=>{const el=t.querySelector('.trow[data-id="'+d+'"]');if(el)el.classList.add('dragging');});
  });
  t.addEventListener('dragover',e=>{
    if(!dragIds.length)return;
    const row=e.target.closest&&e.target.closest('.trow[data-id]'),tid=row?+row.dataset.id:'';
    if(!canDrop(dragIds,tid)){e.dataTransfer.dropEffect='none';
      if(dropTargetEl){dropTargetEl.classList.remove('droptarget');dropTargetEl=null;}t.classList.remove('droproot');return;}
    e.preventDefault();e.dataTransfer.dropEffect='move';
    if(dropTargetEl&&dropTargetEl!==row)dropTargetEl.classList.remove('droptarget');
    if(row){row.classList.add('droptarget');dropTargetEl=row;t.classList.remove('droproot');}
    else{dropTargetEl=null;t.classList.add('droproot');}            // empty area → drop to root
  });
  t.addEventListener('drop',e=>{
    if(!dragIds.length)return;e.preventDefault();
    const row=e.target.closest&&e.target.closest('.trow[data-id]'),tid=row?+row.dataset.id:'';
    const ids=dragIds.slice();cleanupDrag();
    if(canDrop(ids,tid))doReparent(ids,tid);
  });
  t.addEventListener('dragend',cleanupDrag);
}
function buildBulkControls(){            // (re)fill the bar's dropdowns from loaded project data
  const st=$('bulk_state');if(st){st.innerHTML='<option value="">State…</option>'+
    (projectStates.length?projectStates:['New','Active','Resolved','Closed','Removed']).map(s=>`<option value="${esc(s)}">${esc(s)}</option>`).join('');}
  const it=$('bulk_iter');if(it){it.innerHTML='<option value="">Sprint…</option>'+
    sprintPaths.map(p=>`<option value="${esc(p)}">${esc(sprintNames[p]||p)}</option>`).join('');}
}
async function bulkApply(field,val){     // field: state | iteration | assigned | priority
  const ids=[...bulkSel];if(!ids.length)return;
  if(!confirm('Apply '+field+' = "'+val+'" to '+ids.length+' item(s)?'))return;
  if(field==='assigned'&&val==='me')val=currentUser||'me';
  const olds=ids.map(wid=>({id:wid,old:(store.nodes[wid]?store.nodes[wid][field]:undefined)}));   // snapshot for undo
  loadStart(`updating ${ids.length} item(s)…`);
  const results=await api.pool(ids.map(wid=>async()=>{try{const body={};body[field]=(field==='priority'?Number(val):val);await api.updateItem(wid,body);return true;}catch(e){return false;}}),6);
  const ok=results.filter(Boolean).length,fail=results.length-ok;
  loadEnd();
  if(ok)pushAction(`bulk ${field} on ${ids.length} item(s)`,
    async()=>{await api.pool(olds.map(o=>async()=>{try{const b={};b[field]=(o.old==null?'':o.old);await api.updateItem(o.id,b);}catch(e){}}),6);await afterUndo(null);},
    async()=>{await api.pool(ids.map(wid=>async()=>{try{const b={};b[field]=(field==='priority'?Number(val):val);await api.updateItem(wid,b);}catch(e){}}),6);await afterUndo(null);});
  setStatus(`bulk ${field}: ${ok} updated`+(fail?`, ${fail} failed`:''),!!fail);
  await refresh();                       // rebuild from server (prunes selection to what still matches)
  if(fail)setStatus('bulk '+field+': '+ok+' updated, '+fail+' failed',true);
}

/* ---------- graph ---------- */
async function expandNode(id){
  // double-click a graph node -> toggle expansion in the shared store (same
  // api.children the tree uses); collapse if already expanded.
  id=Number(id);                          // keep id numeric to match store keys
  if(store.expanded.has(id)){store.expanded.delete(id);renderGraph({fit:true});return;}
  loadStart('expanding #'+id+'…');
  try{const kids=await ensureKids(id);
    store.expanded.add(id);renderGraph({fit:true});
    setStatus(`#${id}: +${kids.length} child(ren)`);
  }finally{loadEnd();}
}
const txtColor=()=>document.body.classList.contains('light')?'#1b2330':'#e6edf3';   // theme text colour (matches --txt)
const HAND_FONT="'Segoe Print','Bradley Hand','Comic Sans MS',cursive";              // Excalidraw-ish hand-drawn label font
function hexToRgb(h){h=String(h||'').replace('#','');if(h.length===3)h=h.split('').map(c=>c+c).join('');const n=parseInt(h||'0',16)||0;return [(n>>16)&255,(n>>8)&255,n&255];}
function mixHex(hex,toward,t){const a=hexToRgb(hex),b=hexToRgb(toward);return 'rgb('+a.map((v,i)=>Math.round(v+(b[i]-v)*t)).join(',')+')';}
// Excalidraw-style fill: a soft pastel tint of the type colour toward the canvas
const nodeFill=type=>{const c=TYPE_COLOR[type]||'#95a5a6';return document.body.classList.contains('light')?mixHex(c,'#ffffff',0.82):mixHex(c,'#11151b',0.70);};
const nodeStroke=type=>TYPE_COLOR[type]||'#95a5a6';
// Which badges to show on graph nodes. The user toggles these via the bottom-left
// "⚙ Badges" popover; choices are persisted in localStorage.
const BADGE_FIELDS=[
  {key:'childCount',label:'Child count'},
  {key:'priority',label:'Priority'},
  {key:'assigned',label:'Assignee'},
  {key:'state',label:'State'},
  {key:'est',label:'Estimate (h)'},
  {key:'tags',label:'Tags'},
  {key:'iteration',label:'Sprint'},
];
const badgesOn={childCount:true,priority:true,assigned:true,state:true,est:true,tags:true,iteration:true};
const badgeOn=k=>badgesOn[k]!==false;
function loadBadgesOn(){try{const s=localStorage.getItem('ado.graphBadges');if(s){const p=JSON.parse(s);BADGE_FIELDS.forEach(f=>{if(typeof p[f.key]==='boolean')badgesOn[f.key]=p[f.key];});}}catch(e){}}
function saveBadgesOn(){try{localStorage.setItem('ado.graphBadges',JSON.stringify(badgesOn));}catch(e){}}
function gstyle(){return [
 {selector:'node',style:{'background-color':e=>nodeFill(e.data('type')),'shape':'round-rectangle',
   // clean label: only #id (↗ skip marker) · type, then the title
   'label':e=>{const v=e.data('via');return '#'+e.data('id')+(v&&v.length?' ↗':'')+' · '+e.data('type')+'\n'+e.data('title');},
   'color':txtColor,'font-family':HAND_FONT,'text-wrap':'wrap','text-max-width':'180px','font-size':'12px','text-valign':'center',
   'width':'210px','height':'label','padding':'12px',
   // top-left: child-count · priority · assignee (flat bookmarks); top-right: state (corner tag);
   // bottom-left: estimate (corner tag); bottom-centre: tags; bottom-right: sprint (corner tag).
   // Each slot is gated by badgeOn(key) — hidden slots collapse to BLANK_IMG (1px wide).
   'background-image':e=>{const est=e.data('est'),sp=e.data('iteration'),tg=badgeOn('tags')?tagDotsUri(e.data('tags')):null,
       est_=(badgeOn('est')&&est!=null&&est!=='')?cornerTagUri((+est)+'h','#5b6b7d','bl',60):null,
       st=(badgeOn('state')&&e.data('state'))?cornerTagUri(e.data('state'),stateColor(e.data('state')),'tr',120):null,
       spt=(badgeOn('iteration')&&sp)?cornerTagUri(sprintShort(sp),'#7a6cc4','br',110):null;return[
     (badgeOn('childCount')&&e.data('childCount')>0)?bookmarkUri('#3b7de0',e.data('childCount'),'down'):BLANK_IMG,
     (badgeOn('priority')&&e.data('priority'))?bookmarkUri(prioColor(e.data('priority')),'P'+e.data('priority'),'down'):BLANK_IMG,
     (badgeOn('assigned')&&e.data('assigned'))?avatarBadgeUri(e.data('assigned')):BLANK_IMG,
     st?st.uri:BLANK_IMG,
     est_?est_.uri:BLANK_IMG,
     tg?tg.uri:BLANK_IMG,
     spt?spt.uri:BLANK_IMG];},
   'background-image-containment':'inside','background-clip':'none','background-fit':'none',
   'background-width':e=>{const est=e.data('est'),sp=e.data('iteration'),tg=badgeOn('tags')?tagDotsUri(e.data('tags')):null;return[
     (badgeOn('childCount')&&e.data('childCount')>0)?'17px':'1px',
     (badgeOn('priority')&&e.data('priority'))?'17px':'1px',
     (badgeOn('assigned')&&e.data('assigned'))?'17px':'1px',
     ((badgeOn('state')&&e.data('state'))?cornerW(e.data('state'),120):1)+'px',
     ((badgeOn('est')&&est!=null&&est!=='')?cornerW((+est)+'h',60):1)+'px',(tg?tg.w:1)+'px',
     ((badgeOn('iteration')&&sp)?cornerW(sprintShort(sp),110):1)+'px'];},
   'background-height':['22px','22px','22px','16px','16px','10px','16px'],
   'background-position-x':['3px','21px','39px','100%','0','50%','100%'],
   'background-position-y':['0','0','0','0','100%','100%','100%'],
   // overdue → soft red halo (underlay); thin same-hue stroke (a touch bolder for high priority)
   'underlay-color':'#e0524d','underlay-padding':5,'underlay-opacity':e=>isOverdue(e.data())?0.16:0,
   'border-width':e=>((e.data('priority')||9)<=2?2.4:1.3),'border-color':e=>nodeStroke(e.data('type'))}},
 // compound (parent) nodes: render as a translucent container with a header strip
 {selector:':parent',style:{
   'background-color':e=>TYPE_COLOR[e.data('type')]||'#95a5a6','background-opacity':0.08,
   // header strip: child-count · priority · assignee (flat bookmarks) left, state (corner tag) top-right
   'background-image':e=>[(badgeOn('childCount')&&e.data('childCount')>0)?bookmarkUri('#3b7de0',e.data('childCount'),'down'):BLANK_IMG,
     (badgeOn('priority')&&e.data('priority'))?bookmarkUri(prioColor(e.data('priority')),'P'+e.data('priority'),'down'):BLANK_IMG,
     (badgeOn('assigned')&&e.data('assigned'))?avatarBadgeUri(e.data('assigned')):BLANK_IMG,
     (badgeOn('state')&&e.data('state'))?cornerTagUri(e.data('state'),stateColor(e.data('state')),'tr',120).uri:BLANK_IMG],
   'background-image-containment':'inside','background-clip':'none','background-fit':'none',
   'background-width':e=>[(badgeOn('childCount')&&e.data('childCount')>0)?'17px':'1px',
     (badgeOn('priority')&&e.data('priority'))?'17px':'1px',(badgeOn('assigned')&&e.data('assigned'))?'17px':'1px',
     ((badgeOn('state')&&e.data('state'))?cornerW(e.data('state'),120):1)+'px'],
   'background-height':['22px','22px','22px','16px'],
   'background-position-x':['3px','21px','39px','100%'],'background-position-y':['0','0','0','0'],
   'border-color':e=>TYPE_COLOR[e.data('type')]||'#95a5a6','border-width':1.5,'border-opacity':0.7,
   'shape':'round-rectangle','padding':'24px','color':txtColor,   // header sits on the page bg → theme-aware, not always white
   'label':e=>{const v=e.data('via');return '#'+e.data('id')+(v&&v.length?' ↗':'')+' · '+e.data('type')+' — '+e.data('title');},
   'text-valign':'top','text-halign':'center','text-margin-y':-4,
   'font-family':HAND_FONT,'font-size':'13px','font-weight':'bold','text-max-width':'400px','text-wrap':'wrap'}},
 {selector:'node:selected',style:{'border-color':'#fff','border-width':4}},
 {selector:'node.bulk',style:{'border-color':'#4c8bf5','border-width':5}},   // bulk-selected (Ctrl/Shift-tap)
 {selector:'node.dep-hot',style:{'border-color':'#e0a13c','border-width':4}},   // dep-drag target highlight
 {selector:'edge[kind="hierarchy"]',style:{'width':1,'line-color':'#5b6b7d','line-opacity':0.4,'target-arrow-color':'#5b6b7d','target-arrow-shape':'triangle','curve-style':'bezier'}},
 {selector:'edge[kind="dep"]',style:{'width':2,'line-style':'dashed','line-color':'#e0a13c','target-arrow-color':'#e0a13c','target-arrow-shape':'vee','curve-style':'bezier'}},
 {selector:'edge[kind="dep"].hot',style:{'width':3.5,'line-color':'#f0c674','target-arrow-color':'#f0c674'}},   // hover (click → delete)
]}
// Keep the Excalidraw dot grid locked to the graph: scale dot spacing by zoom
// and offset by pan, so the dots move and zoom with the nodes.
function syncCyGrid(){
  if(!cy)return;const z=cy.zoom(),p=cy.pan(),s=24*z,el=$('cy');
  el.style.backgroundSize=s+'px '+s+'px';
  el.style.backgroundPosition=p.x+'px '+p.y+'px';
}
function initCy(){
  cy=cytoscape({container:$('cy'),style:gstyle(),wheelSensitivity:0.2,autounselectify:true,boxSelectionEnabled:false});
  cy.on('pan zoom',()=>{syncCyGrid();depHandlePlace();});                 // grid + handle follow the canvas
  let tapTimer=null,tapId=null;                 // single tap = open editor; double tap = expand
  cy.on('tap','node',e=>{const id=Number(e.target.data('id'));   // cytoscape gives a string id
    const oe=e.originalEvent||{};
    if(oe.ctrlKey||oe.metaKey||oe.shiftKey){bulkToggle(id);return;}   // modifier-tap → bulk select (no open)
    if(tapTimer&&tapId===id){clearTimeout(tapTimer);tapTimer=null;tapId=null;expandNode(id);return;}
    tapId=id;clearTimeout(tapTimer);
    tapTimer=setTimeout(()=>{tapTimer=null;tapId=null;openItem(id);},250);});
  // Hover handle for drag-to-create dep links (only in +Deps mode).
  cy.on('mouseover','node',e=>{const nd=e.target;if(nd.isParent&&nd.isParent())return;
    if(mode==='graph'&&edgeMode!=='hierarchy')depHandleShow(nd);});
  cy.on('mouseout','node',e=>{
    if(depDrag)return;                          // mid-drag → keep target highlights
    const rel=e.originalEvent&&e.originalEvent.relatedTarget;
    if(rel&&rel.id==='depHandle')return;        // moved into the handle itself, keep it visible
    depHandleHide();
  });
  cy.on('position','node',e=>{const h=$('depHandle');
    if(h&&h.style.display!=='none'&&h._nodeId===Number(e.target.data('id')))depHandlePlace();});
  // Click on a dep edge → confirm + delete.
  cy.on('tap','edge[kind="dep"]',async e=>{
    const ed=e.target,s=Number(ed.data('source')),t=Number(ed.data('target'));
    if(!confirm(`Remove dependency #${s} → #${t}?`))return;
    await removeDepLink(s,t,'blocks');
  });
  cy.on('mouseover','edge[kind="dep"]',e=>e.target.addClass('hot'));
  cy.on('mouseout','edge[kind="dep"]',e=>e.target.removeClass('hot'));
}

/* ---- graph: drag a stub from a node to create a Dependency link ----
   Active only in +Deps mode. The handle is a small DOM bubble pinned to the
   hovered node's right edge (cheaper than another canvas layer, and stays
   accurate under pan/zoom via depHandlePlace()). Mousedown starts a custom
   drag with an SVG line ghost; mouseup hit-tests against cy nodes. */
let depDrag=null;                                // {sourceId, svg, line, sx, sy, hot}
function depHandleEl(){
  let h=$('depHandle');if(h)return h;
  h=document.createElement('div');h.id='depHandle';h.textContent='→';
  h.title='drag to create a dependency link';
  $('cy').appendChild(h);
  h.addEventListener('mousedown',e=>{
    if(!h._nodeId||e.button!==0)return;
    e.preventDefault();e.stopPropagation();
    depDragBegin(h._nodeId);
  });
  return h;
}
function depHandleShow(node){
  if(!cy)return;
  const h=depHandleEl();
  h._nodeId=Number(node.data('id'));
  h.style.display='flex';
  depHandlePlace();
}
function depHandlePlace(){
  const h=$('depHandle');if(!h||h.style.display==='none'||!cy)return;
  const nd=cy.getElementById(String(h._nodeId));if(nd.empty()){depHandleHide();return;}
  const bb=nd.renderedBoundingBox();
  h.style.left=(bb.x2-9)+'px';h.style.top=((bb.y1+bb.y2)/2-9)+'px';
}
function depHandleHide(){const h=$('depHandle');if(h)h.style.display='none';}
function depDragBegin(sourceId){
  if(!cy)return;
  const cyEl=$('cy');
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.id='depDragSvg';svg.style.cssText='position:absolute;inset:0;pointer-events:none;z-index:50;width:100%;height:100%';
  const ln=document.createElementNS('http://www.w3.org/2000/svg','line');
  ln.setAttribute('stroke','#e0a13c');ln.setAttribute('stroke-width','2');ln.setAttribute('stroke-dasharray','5,4');
  svg.appendChild(ln);cyEl.appendChild(svg);
  const src=cy.getElementById(String(sourceId)).renderedPosition();
  depDrag={sourceId,svg,line:ln,sx:src.x,sy:src.y,hot:null};
  depHandleHide();
  document.body.style.cursor='crosshair';
}
document.addEventListener('mousemove',e=>{
  if(!depDrag||!cy)return;
  const r=$('cy').getBoundingClientRect();
  const x=e.clientX-r.left,y=e.clientY-r.top;
  depDrag.line.setAttribute('x1',depDrag.sx);depDrag.line.setAttribute('y1',depDrag.sy);
  depDrag.line.setAttribute('x2',x);depDrag.line.setAttribute('y2',y);
  let hot=null;
  cy.nodes().forEach(nd=>{
    if(nd.isParent&&nd.isParent())return;
    if(Number(nd.data('id'))===depDrag.sourceId)return;
    const bb=nd.renderedBoundingBox();
    if(x>=bb.x1&&x<=bb.x2&&y>=bb.y1&&y<=bb.y2)hot=nd;
  });
  if(depDrag.hot&&depDrag.hot!==hot)depDrag.hot.removeClass('dep-hot');
  depDrag.hot=hot;if(hot)hot.addClass('dep-hot');
});
document.addEventListener('mouseup',async()=>{
  if(!depDrag)return;
  const d=depDrag;depDrag=null;
  document.body.style.cursor='';
  if(d.svg&&d.svg.parentNode)d.svg.parentNode.removeChild(d.svg);
  if(d.hot)d.hot.removeClass('dep-hot');
  const target=d.hot?Number(d.hot.data('id')):null;
  if(!target||target===d.sourceId)return;
  await addDepLink(d.sourceId,target,'blocks');   // source → target (source "blocks" target)
});
function syncGraphBulk(){if(cy)cy.nodes().forEach(nd=>nd.toggleClass('bulk',bulkSel.has(Number(nd.data('id')))));}
function runLayout(fit){
  // cytoscape's own `fit:true` triggers fit at the START of the animation, so
  // when expanding a node the camera zooms before the new children have moved
  // into their final spots. Hook layoutstop instead and fit once nodes settle.
  const l=cy.layout({name:'dagre',rankDir,ranker:'tight-tree',
    nodeSep:55,rankSep:110,edgeSep:25,animate:true,animationDuration:250,fit:false,padding:40});
  if(fit)l.one('layoutstop',()=>cy.animate({fit:{padding:40}},{duration:200}));
  l.run();
}
async function renderGraph(opts){
  opts=opts||{};
  if(!cy)initCy();
  cy.resize();
  const token=++renderToken;                    // newest render wins; stale async results bail out
  const ids=[...reachable()].filter(id=>store.nodes[id]);
  if(!ids.length){cy.elements().remove();setStatus('nothing matches the filters');return;}
  const idset=new Set(ids);
  // Compound nesting: each in-set parent becomes a container for its in-set children.
  // Derived from store.kids (same source as the tree), so skip-resolved children also nest correctly.
  const parentOf={};
  ids.forEach(p=>(store.kids[p]||[]).forEach(c=>{if(idset.has(c))parentOf[c]=p;}));
  let edges=[];
  // hierarchy edges are now redundant — compound rectangles already show the parent/child
  // structure visually. We keep edges only for dependency modes.
  if(edgeMode!=='hierarchy'){                     // dependencies: on-demand, cached
    const key=ids.slice().sort((a,b)=>a-b).join(',');
    let d=depCache[key];
    if(!d){
      loadStart('loading dependencies…');
      try{d=await api.deps(ids);depCache[key]=d;}
      catch(e){d=[];setStatus('ERROR: '+e.message,true);}
      finally{loadEnd();}
      if(token!==renderToken)return;
    }
    d.forEach(e=>edges.push({id:'d_'+e.source+'_'+e.target,source:String(e.source),target:String(e.target),kind:'dep'}));
  }
  if(token!==renderToken)return;
  // --- incremental diff: keep existing nodes (and their positions); no full rebuild ---
  const want=new Set(ids.map(String));
  let added=0,removed=0,reparented=0;
  // Compound add order: parents must exist before children reference them via `data.parent`.
  // Sort ids so that any node whose compound parent is in the set comes after that parent.
  const depth={};const dep=id=>id in depth?depth[id]:(depth[id]=parentOf[id]?dep(parentOf[id])+1:0);
  const sorted=ids.slice().sort((a,b)=>dep(a)-dep(b));
  cy.batch(()=>{
    cy.nodes().forEach(n=>{if(!want.has(n.id())){n.remove();removed++;}});
    sorted.forEach(id=>{
      const el=cy.getElementById(String(id));
      const pid=parentOf[id]?String(parentOf[id]):null;
      if(el.nonempty()){
        el.data(store.nodes[id]);                                // refresh fields
        const cp=el.parent().nonempty()?el.parent().id():null;
        if(cp!==pid){el.move({parent:pid});reparented++;}        // re-nest if hierarchy shifted
        return;
      }
      const pe=cy.getElementById(String(store.parent[id]||''));  // seed near parent (no fly-from-0,0)
      const pos=pe.nonempty()?{x:pe.position('x'),y:pe.position('y')+70}:undefined;
      const data=Object.assign({},store.nodes[id]);              // shallow copy so we don't mutate store
      if(pid)data.parent=pid;else delete data.parent;            // normalize: only set if compound parent is in cy
      cy.add({group:'nodes',data,position:pos});added++;
    });
    cy.edges().remove();
    cy.add(edges.map(e=>({group:'edges',data:e})));             // edges carry no position -> no jump
  });
  if(opts.relayout||added||removed||reparented)runLayout(opts.fit); // relayout on topology change; fit after layout settles
  else if(opts.fit)cy.fit(undefined,40);                        // positions unchanged -> safe to fit now
  setStatus(`${ids.length} nodes · ${edges.length} edges`);
  syncGraphBulk();                                              // re-apply the bulk highlight to (re)added nodes
  syncCyGrid();                                                 // align the dot grid with the current pan/zoom
}

/* ---------- board (sprints) ---------- */
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"}[c]));
// ISO date/datetime -> "30 May 2026" (UTC, so it never drifts a day across timezones)
function prettyDate(s){if(!s)return '';const m=String(s).slice(0,10).match(/^(\d{4})-(\d{2})-(\d{2})$/);if(!m)return String(s).slice(0,10);
  return (+m[3])+' '+new Date(Date.UTC(+m[1],+m[2]-1,+m[3])).toLocaleString('en-US',{month:'short',timeZone:'UTC'})+' '+m[1];}
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
async function annotateBoardTimes(){      // fill actual (active wall-clock) time per card + column Σ
  const token=boardToken;                 // current render's token — bail if a newer render starts
  const cards=[...document.querySelectorAll('#board .bcard[data-id]')];
  if(!cards.length)return;
  const ids=cards.map(c=>+c.dataset.id);
  const setCard=(c,act)=>{                 // act = hours or null
    const est=c.dataset.est?+c.dataset.est:null,lab=c.querySelector('.tlabel'),fill=c.querySelector('.tfill');
    if(act==null){if(lab)lab.textContent=est!=null?('est '+est+'h'):'⏱ —';return;}
    if(est!=null&&fill){const r=act/est;fill.style.width=Math.min(r,1)*100+'%';fill.style.background=r>1?'#e74c3c':'var(--accent)';
      if(lab)lab.textContent=`${Math.round(act)}/${est}h`;c.querySelector('.tbar').classList.toggle('over',r>1);}
    else if(lab)lab.textContent='⏱ '+hh(act);
  };
  if(ids.length>BOARD_TIME_CAP){setStatus(cards.length+' cards — filter to ≤'+BOARD_TIME_CAP+' to load actual time');
    cards.forEach(c=>setCard(c,null));return;}
  let t;try{t=await api.times(ids,tzOffset);}catch(e){return;}
  if(token!==boardToken)return;            // a newer renderBoard superseded us — don't write stale times
  cards.forEach(c=>{const sec=t[c.dataset.id];if(sec==null){setCard(c,null);return;}c.dataset.act=sec;setCard(c,sec/3600);});
  document.querySelectorAll('#board .bcol').forEach(col=>{let sa=0,se=0;
    col.querySelectorAll('.bcard[data-id]').forEach(c=>{sa+=+(c.dataset.act||0);se+=(c.dataset.est?+c.dataset.est:0);});
    const lab=col.querySelector('.colact'),fill=col.querySelector('.tbar.cbar .tfill'),ah=sa/3600;
    if(se>0&&fill){const r=ah/se;fill.style.width=Math.min(r,1)*100+'%';fill.style.background=r>1?'#e74c3c':'var(--accent)';
      const cb=col.querySelector('.cbar');if(cb)cb.classList.toggle('over',r>1);
      if(lab)lab.textContent=`Σ ${Math.round(ah)}/${Math.round(se)}h`;}
    else if(lab&&sa>0)lab.textContent='Σ⏱ '+hh(ah);});
}
async function renderBoard(){
  const token=++boardToken;
  const iters=await getIterations();
  if(token!==boardToken)return;                     // a newer renderBoard started — bail out
  const el=$('board');el.innerHTML='';
  const today=new Date().toISOString().slice(0,10);
  const info={},finish={};iters.forEach(it=>{info[it.path]=it;finish[it.path]=it.finish;});
  const items=store.roots.map(id=>store.nodes[id]).filter(Boolean);   // SAME data as tree/graph
  if(boardGroup==='assignee'){renderBoardByAssignee(el,items);setStatus(`${items.length} items`+capNote());annotateBoardTimes();return;}
  if(boardGroup==='state'){renderBoardByState(el,items);setStatus(`${items.length} items`+capNote());annotateBoardTimes();return;}
  const groups=new Map();
  items.forEach(n=>{const k=finish[n.iteration]?n.iteration:'__none__';if(!groups.has(k))groups.set(k,[]);groups.get(k).push(n);});
  groups.forEach(arr=>arr.sort(cmpBySort));  // order within column = toolbar Sort
  const root=iters[0]?iters[0].path.split('\\')[0]:projectName;   // project root = "no sprint"
  const order=iters.map(it=>it.path);   // ALL dated sprints (empties revealed while dragging)
  order.push('__none__');   // always show the "No sprint" column (a drop target even when empty)
  order.forEach(k=>{
    const it=k==='__none__'?null:info[k];const fin=it?it.finish:null;
    const colItems=groups.get(k)||[];
    const col=document.createElement('div');col.className='bcol';
    if(k!=='__none__'&&!colItems.length&&!newSprints.has(k))col.classList.add('empty-sprint');   // hidden until a drag starts (but keep a just-created one visible)
    if(k==='__none__'&&!colItems.length)col.classList.add('collapsed');   // empty "No sprint" → narrow, expands on drag-hover
    if(it&&it.start&&it.finish&&today>=it.start.slice(0,10)&&today<=it.finish.slice(0,10))col.classList.add('current');
    const h=document.createElement('div');h.className='bhead';
    h.innerHTML=(k==='__none__'?'No sprint':`${esc(it.name)} <small>${(it.start||'').slice(0,10)}→${(fin||'').slice(0,10)}</small>`)+'<br>'+colMeta(colItems);
    if(k!=='__none__'){h.style.cursor='pointer';h.title='open sprint timeline';h.addEventListener('click',()=>openSprint(k));}
    const wrap=document.createElement('div');wrap.className='bcards';
    colItems.forEach(n=>wrap.appendChild(boardCard(n,fin,today)));
    if(!colItems.length){const ph=document.createElement('div');ph.className='empty';ph.textContent='drop here';wrap.appendChild(ph);}
    col.dataset.field='iteration';col.dataset.val=(k==='__none__')?root:k;   // drop = change sprint
    col.append(h,wrap);el.appendChild(col);
  });
  if(canCreateSprint){                              // phantom "add sprint" column at the right end
    const add=document.createElement('div');add.className='bcol addcol';add.title='create a new sprint';
    add.innerHTML='<div class="addinner"><span class="plus">＋</span>New sprint</div>';
    add.onclick=()=>{if(suppressClick)return;pendingSprintItems=null;showSprintModal();};el.appendChild(add);   // plain click (not a drop)
  }
  setStatus(`${items.length} items`+capNote());annotateBoardTimes();
}
function renderBoardByAssignee(el,items){
  const groups=new Map();
  items.forEach(n=>{const k=n.assigned||'';if(!groups.has(k))groups.set(k,[]);groups.get(k).push(n);});
  groups.forEach(arr=>arr.sort(cmpBySort));
  let names=[...groups.keys()].filter(k=>k);
  if($('board').classList.contains('showempty'))    // "∅ empty" on: also show team members with no items
    [currentUser,...assignees].forEach(a=>{if(a&&!groups.has(a)&&!names.includes(a))names.push(a);});
  names.sort((a,b)=>a.localeCompare(b));
  if(groups.has(''))names.push('');                 // Unassigned last
  names.forEach(k=>{
    const arr=groups.get(k)||[];
    const col=document.createElement('div');col.className='bcol';
    const h=document.createElement('div');h.className='bhead';
    h.innerHTML=(k?esc(k):'Unassigned')+'<br>'+colMeta(arr);
    const wrap=document.createElement('div');wrap.className='bcards';
    arr.forEach(n=>wrap.appendChild(boardCard(n,null,'')));   // no overdue colouring in assignee view
    if(!arr.length){const ph=document.createElement('div');ph.className='empty';ph.textContent='drop here';wrap.appendChild(ph);}
    col.dataset.field='assigned';col.dataset.val=k;   // drop = reassign
    col.append(h,wrap);el.appendChild(col);
  });
}
function renderBoardByState(el,items){
  const today=new Date().toISOString().slice(0,10);
  const groups=new Map();
  items.forEach(n=>{const k=n.state||'';if(!groups.has(k))groups.set(k,[]);groups.get(k).push(n);});
  groups.forEach(arr=>arr.sort(cmpBySort));
  let keys=[...groups.keys()].filter(k=>k);
  if($('board').classList.contains('showempty'))    // "∅ empty" on: also show project states with no items
    projectStates.forEach(s=>{if(!groups.has(s))keys.push(s);});
  const cols=orderStates(keys);
  if(groups.has(''))cols.push('');                  // items with no state last (rare)
  cols.forEach(k=>{
    const arr=groups.get(k)||[];
    const col=document.createElement('div');col.className='bcol';
    const h=document.createElement('div');h.className='bhead';
    h.innerHTML=(k?`<span class="sbadge" style="background:${stateColor(k)}">${esc(k)}</span>`:'(no state)')+'<br>'+colMeta(arr);
    const wrap=document.createElement('div');wrap.className='bcards';
    arr.forEach(n=>wrap.appendChild(boardCard(n,null,today)));   // overdue colouring by target date
    if(!arr.length){const ph=document.createElement('div');ph.className='empty';ph.textContent='drop here';wrap.appendChild(ph);}
    col.dataset.field='state';col.dataset.val=k;   // drop = change state
    col.append(h,wrap);el.appendChild(col);
  });
}
function boardCard(n,finish,today){
  const due=n.target?n.target.slice(0,10):(finish?finish.slice(0,10):null);
  const overdue=due&&due<today&&!DONE_STATES.includes(n.state);
  const c=document.createElement('div');c.className='bcard'+(overdue?' overdue':'')+(bulkSel.has(n.id)?' bulksel':'');
  c.style.borderLeftColor=tyColor(n.type);   // left marker = item TYPE colour
  c.dataset.id=n.id;c.dataset.est=(n.est!=null?n.est:'');
  c.innerHTML=`<div class="bttl">${n.assigned?personChipT(n.assigned):''}<span class="btxt">#${n.id} ${esc(n.title)}</span></div>`+
    `<div class="bmeta"><span>${esc(n.type)}</span>`+
    (n.priority?`<span class="prio" style="background:${prioColor(n.priority)}">P${n.priority}</span>`:'')+
    `<span>${esc(n.state)}</span>`+(overdue?'<span class="od">overdue</span>':'')+`</div>`+
    `<div class="bfoot">`+(n.est!=null?`<div class="tbar"><div class="tfill"></div></div>`:'')+
    `<span class="tlabel">${n.est!=null?'est '+(+n.est)+'h':'⏱ …'}</span></div>`;
  c.addEventListener('mousedown',e=>{if(e.button===0&&!e.ctrlKey&&!e.metaKey&&!e.shiftKey)startCardDrag(e,n.id,c);});   // modifier = select, not drag
  c.onclick=(e)=>{if(suppressClick)return;
    if(e.ctrlKey||e.metaKey){e.preventDefault();bulkToggle(n.id);return;}        // Ctrl/Cmd: toggle in selection
    if(e.shiftKey){e.preventDefault();bulkRange(n.id);return;}                    // Shift: range from anchor (select or deselect)
    openItem(n.id);};
  return c;
}
async function moveCard(id,field,val){            // field: 'iteration' | 'assigned' | 'state'
  boardBusy=true;loadStart('moving #'+id+'…');
  const card=document.querySelector('.bcard[data-id="'+id+'"]');if(card)card.classList.add('moving');
  const old=store.nodes[id]?store.nodes[id][field]:'';   // snapshot for undo (still the pre-move value here)
  try{
    const body={};body[field]=val;
    const r=await api.updateItem(id,body);
    if(store.nodes[id])store.nodes[id][field]=val;   // node uses the same key names (iteration/assigned/state)
    pushAction('move #'+id,
      async()=>{await api.updateItem(id,{[field]:(old==null?'':old)});await afterUndo(id);},
      async()=>{await api.updateItem(id,{[field]:val});await afterUndo(id);});
    setStatus('#'+id+' moved → rev '+r.rev);
  }catch(e){setStatus('ERROR: '+e.message,true);}
  boardBusy=false;loadEnd();
  renderBoard();                                   // regroup from the (now updated) store
}
// Bulk move: drag a selected card → move every selected card to the dropped column.
async function moveCards(ids,field,val){
  ids=ids.filter(id=>store.nodes[id]&&String(store.nodes[id][field]||'')!==String(val));   // skip ones already there
  if(!ids.length)return;
  const olds=ids.map(id=>({id,old:store.nodes[id][field]}));
  boardBusy=true;loadStart(`moving ${ids.length} item(s)…`);
  const res=await api.pool(ids.map(id=>async()=>{try{await api.updateItem(id,{[field]:val});if(store.nodes[id])store.nodes[id][field]=val;return true;}catch(e){return false;}}),6);
  boardBusy=false;loadEnd();
  const ok=res.filter(Boolean).length,fail=res.length-ok;
  if(ok)pushAction(`move ${ids.length} item(s)`,
    async()=>{await api.pool(olds.map(o=>async()=>{try{await api.updateItem(o.id,{[field]:(o.old==null?'':o.old)});}catch(e){}}),6);await afterUndo(null);},
    async()=>{await api.pool(ids.map(id=>async()=>{try{await api.updateItem(id,{[field]:val});}catch(e){}}),6);await afterUndo(null);});
  setStatus(`moved ${ok} item(s)`+(fail?`, ${fail} failed`:''),!!fail);
  renderBoard();
}
/* ---- custom pointer-based card drag (native HTML5 DnD was unreliable here) ---- */
function startCardDrag(e,id,card){
  if(boardBusy)return;
  pdrag={id,sx:e.clientX,sy:e.clientY,card,active:false,hot:null,clone:null};
}
function _sprint(path){return (iterCache||[]).find(x=>x.path===path)||null;}
document.addEventListener('mousemove',e=>{
  if(!pdrag)return;
  if(!pdrag.active){
    if(Math.abs(e.clientX-pdrag.sx)+Math.abs(e.clientY-pdrag.sy)<5)return;   // movement threshold
    pdrag.active=true;
    const r=pdrag.card.getBoundingClientRect();
    const bulk=bulkSel.has(pdrag.id)&&bulkSel.size>1;
    const cl=pdrag.card.cloneNode(true);cl.className='bcard drag-ghost'+(bulk?' bulk':'');cl.style.width=r.width+'px';
    if(bulk){const b=document.createElement('span');b.className='dgcount';b.textContent=bulkSel.size;cl.appendChild(b);}   // count badge
    document.body.appendChild(cl);pdrag.clone=cl;
    // dim every card being moved (the whole selection on a bulk drag)
    pdrag.dragEls=bulk?[...document.querySelectorAll('#board .bcard[data-id]')].filter(el=>bulkSel.has(+el.dataset.id)):[pdrag.card];
    pdrag.dragEls.forEach(el=>el.classList.add('dragging'));
    $('board').classList.add('drag');document.body.style.cursor='grabbing';
  }
  pdrag.clone.style.left=(e.clientX+10)+'px';pdrag.clone.style.top=(e.clientY+10)+'px';
  const el=document.elementFromPoint(e.clientX,e.clientY);
  const c=el&&el.closest?el.closest('.bcol[data-field], .bcol.addcol'):null;   // addcol = "＋ New sprint" drop zone
  if(pdrag.hot&&pdrag.hot!==c)pdrag.hot.classList.remove('dropover');
  pdrag.hot=c;if(c)c.classList.add('dropover');
});
document.addEventListener('mouseup',()=>{
  if(!pdrag)return;const d=pdrag;pdrag=null;
  if(!d.active)return;                              // was a plain click — let onclick handle it
  (d.dragEls||[d.card]).forEach(el=>el.classList.remove('dragging'));if(d.clone)d.clone.remove();
  $('board').classList.remove('drag');document.body.style.cursor='';
  if(d.hot)d.hot.classList.remove('dropover');
  suppressClick=true;setTimeout(()=>{suppressClick=false;},30);   // swallow the click that follows a drag
  const col=d.hot;if(!col)return;
  const bulk=bulkSel.has(d.id)&&bulkSel.size>1;                     // dragged a selected card → move the whole selection
  const dropIds=bulk?[...bulkSel]:[d.id];
  if(col.classList.contains('addcol')){                            // dropped on "＋ New sprint" → create, then move them in
    pendingSprintItems=dropIds;showSprintModal();return;
  }
  const field=col.dataset.field,val=col.dataset.val||'';
  const node=store.nodes[d.id],curVal=node?(node[field]||''):'';   // field: iteration | assigned | state
  if(val===curVal&&!bulk)return;
  if(field==='iteration'){const it=_sprint(val),fin=it&&it.finish?it.finish.slice(0,10):null,today=new Date().toISOString().slice(0,10);
    if(fin&&fin<today&&!confirm(`Sprint "${it.name}" ended ${fin}. Move ${bulk?bulkSel.size+' items':'#'+d.id} there anyway?`))return;}
  if(bulk)moveCards([...bulkSel],field,val);else moveCard(d.id,field,val);
});

/* ---------- sprint detail (Gantt) ---------- */
let openSprintPath=null;
function renderSprint(path){
  const it=_sprint(path);if(!it||!it.start||!it.finish)return false;
  const DAY=86400000,s0=Date.parse(it.start.slice(0,10)),f0=Date.parse(it.finish.slice(0,10));
  const N=Math.max(1,Math.round((f0-s0)/DAY)+1);
  const todayIdx=Math.round((Date.parse(new Date().toISOString().slice(0,10))-s0)/DAY);
  const showToday=todayIdx>=0&&todayIdx<N, todayLeft=(todayIdx+0.5)/N*100;
  const items=store.roots.map(id=>store.nodes[id]).filter(n=>n&&n.iteration===path);
  const el=$('sprintview');el.innerHTML='';
  const se=items.reduce((s,n)=>s+(n.est||0),0);
  const top=document.createElement('div');top.className='gtop';
  const curMark=isCurrentSprint(it)?`<span class="curdot" title="current sprint"></span>`:'';
  top.innerHTML=`<button class="btn" id="g_back" title="back to board">←</button>`+
    `<span style="display:inline-flex;align-items:center;gap:6px">${curMark}<b>${esc(it.name)}</b></span> <span style="color:var(--muted)">${it.start.slice(0,10)} → ${it.finish.slice(0,10)} · ${items.length} items`+
    `${se?' · Σest '+(Math.round(se*10)/10)+'h':''} · <span id="g_act">Σ⏱ …</span></span>`+
    (canEditSprint?`<button class="btn" id="g_editdates" title="edit sprint dates">✎ dates</button>`:'')+
    `<button class="btn${sprintGroup==='assignee'?' on':''}" id="g_group" title="group rows by assignee" style="margin-left:auto">by assignee</button>`;
  el.appendChild(top);
  const head=document.createElement('div');head.className='ghead';
  const hl=document.createElement('div');hl.className='glabel';head.appendChild(hl);
  const gd=document.createElement('div');gd.className='gdays';
  for(let i=0;i<N;i++){const d=new Date(s0+i*DAY),c=document.createElement('div');c.textContent=d.getUTCDate();if(i===todayIdx)c.classList.add('gtodaycol');gd.appendChild(c);}
  head.appendChild(gd);
  const hr=document.createElement('div');hr.className='gright';hr.innerHTML='<small>est · ⏱</small>';head.appendChild(hr);
  el.appendChild(head);
  const mkRow=(n)=>{
    const row=document.createElement('div');row.className='grow';row.dataset.id=n.id;
    const lab=document.createElement('div');lab.className='glabel';lab.textContent=`#${n.id} ${n.title}`;lab.title=n.title;
    const track=document.createElement('div');track.className='gtrack';track.style.backgroundSize=(100/N)+'% 100%';
    const ps=d=>d?Date.parse(d.slice(0,10)):null;
    let bs=ps(n.start),be=ps(n.target||n.due),soft=false;
    if(bs==null&&be==null){bs=s0;be=f0;soft=true;}   // no own dates → span the sprint (hatched)
    else{if(bs==null)bs=be;if(be==null)be=bs;}        // a single date → a point bar
    if(be<bs)be=bs;
    let si=Math.round((bs-s0)/DAY),ei=Math.round((be-s0)/DAY);
    si=Math.max(0,Math.min(si,N-1));ei=Math.max(si,Math.min(ei,N-1));
    const bar=document.createElement('div');bar.className='gbar'+(soft?' soft':'');
    bar.style.left=(si/N*100)+'%';bar.style.width=((ei-si+1)/N*100)+'%';
    bar.style.backgroundColor=tyColor(n.type);
    bar.textContent=(n.priority?'P'+n.priority+' ':'')+'#'+n.id+' '+n.title;bar.title=n.title;
    bar.onclick=()=>openItem(n.id);
    track.appendChild(bar);
    if(showToday){const tl=document.createElement('div');tl.className='gtoday';tl.style.left=todayLeft+'%';track.appendChild(tl);}
    const right=document.createElement('div');right.className='gright';
    right.innerHTML=`<span>${n.est!=null?'est '+(+n.est)+'h':''}</span> <span class="gact">⏱ …</span>`;
    row.append(lab,track,right);return row;
  };
  if(!items.length){const e=document.createElement('div');e.className='empty';e.style.padding='12px';e.textContent='no items match the current filters';el.appendChild(e);}
  else if(sprintGroup==='assignee'){
    const groups=new Map();items.forEach(n=>{const k=n.assigned||'';if(!groups.has(k))groups.set(k,[]);groups.get(k).push(n);});
    const names=[...groups.keys()].filter(k=>k).sort((a,b)=>a.localeCompare(b));if(groups.has(''))names.push('');
    names.forEach(k=>{
      const arr=groups.get(k).sort(cmpBySort);
      const ge=arr.reduce((s,n)=>s+(n.est||0),0);
      const gh=document.createElement('div');gh.className='ggroup';gh.dataset.group=k;
      gh.innerHTML=`<span>${k?esc(k):'Unassigned'} · ${arr.length}${ge?' · Σest '+(Math.round(ge*10)/10)+'h':''}</span><span class="gact">⏱ …</span>`;
      el.appendChild(gh);
      arr.forEach(n=>{const r=mkRow(n);r.dataset.group=k;el.appendChild(r);});
    });
  } else items.forEach(n=>el.appendChild(mkRow(n)));
  $('g_back').onclick=backToBoard;
  {const eb=$('g_editdates');if(eb)eb.onclick=()=>showSprintEdit(path);}
  $('g_group').onclick=()=>{sprintGroup=sprintGroup==='assignee'?'none':'assignee';
    try{localStorage.setItem('ado.sprintGroup',sprintGroup);}catch(e){}renderSprint(path);};
  annotateSprintTimes(items.map(n=>n.id),path);
  return true;
}
async function annotateSprintTimes(ids,path){
  if(!ids.length||ids.length>BOARD_TIME_CAP){const t=$('g_act');if(t)t.textContent='Σ⏱ —';return;}
  let t;try{t=await api.times(ids,tzOffset);}catch(e){return;}
  if(path!==openSprintPath)return;         // the open sprint changed — don't write stale times
  let tot=0;const byGroup={};
  document.querySelectorAll('#sprintview .grow[data-id]').forEach(r=>{
    const sec=t[r.dataset.id],g=r.querySelector('.gact');
    if(sec!=null){tot+=sec;if(g)g.textContent='⏱ '+hh(sec/3600);
      if(r.dataset.group!=null)byGroup[r.dataset.group]=(byGroup[r.dataset.group]||0)+sec;}
    else if(g)g.textContent='⏱ —';
  });
  document.querySelectorAll('#sprintview .ggroup[data-group]').forEach(h=>{
    const g=h.querySelector('.gact');if(g)g.textContent='⏱ '+hh((byGroup[h.dataset.group]||0)/3600);});
  const top=$('g_act');if(top)top.textContent='Σ⏱ '+hh(tot/3600);
}
function openSprint(path){
  if(!_sprint(path))return;
  boardScroll={l:$('board').scrollLeft,t:$('board').scrollTop};
  if(renderSprint(path)){openSprintPath=path;$('board').classList.remove('show');$('sprintview').classList.add('show');renderViewHelp();}
}
function backToBoard(){
  openSprintPath=null;$('sprintview').classList.remove('show');$('board').classList.add('show');
  if(boardScroll){$('board').scrollLeft=boardScroll.l;$('board').scrollTop=boardScroll.t;}
  renderViewHelp();
}

/* ---------- Timeline (project-wide Gantt — one continuous axis, no sprint cut-off) ---------- */
const TL_DAY=86400000;
const TL_PX={day:26,week:9,month:3.3};            // px per day at each zoom
const TL_LABELW=240;                              // sticky left label column width
// Effective {s,e,soft} dates (ms) for an item, or null if it has none: prefer the
// item's own start/target, else fall back to its sprint's dates (soft=true).
function tlDates(n){
  const p=d=>d?Date.parse(String(d).slice(0,10)):null;
  let s=p(n.start),e=p(n.target||n.due),soft=false;
  if(s==null&&e==null){const it=n.iteration?_sprint(n.iteration):null;
    if(it&&it.start&&it.finish){s=p(it.start);e=p(it.finish);soft=true;}}
  if(s==null&&e==null)return null;
  if(s==null)s=e;if(e==null)e=s;if(e<s)e=s;
  return {s,e,soft};
}
function tlKey(n){                                 // row group key for the current grouping
  if(tlGroup==='sprint')return n.iteration?(sprintNames[n.iteration]||String(n.iteration).split('\\').pop()):'(no sprint)';
  if(tlGroup==='state')return n.state||'(no state)';
  if(tlGroup==='assignee')return n.assigned||'Unassigned';
  if(tlGroup==='type')return n.type||'(no type)';
  return '';
}
function tlMonths(t0,t1){                          // month segments spanning [t0,t1]
  const out=[];let y=new Date(t0).getUTCFullYear(),m=new Date(t0).getUTCMonth();
  for(;;){const start=Date.UTC(y,m,1),end=Date.UTC(y,m+1,1)-TL_DAY;if(start>t1)break;
    const lab=new Date(start).toLocaleString('en-US',{month:'short'})+(m===0?(" '"+String(y).slice(2)):'');
    out.push({start,end,label:lab});m++;if(m>11){m=0;y++;}}
  return out;
}
async function renderTimeline(){
  const token=++tlToken;
  const iters=await getIterations();                // for the sprint-date fallback + sprint grouping
  if(token!==tlToken)return;
  const el=$('timeline');el.innerHTML='';
  const items=store.roots.map(id=>store.nodes[id]).filter(Boolean);
  const dated=[],undated=[];
  items.forEach(n=>{const d=tlDates(n);if(d){n._tl=d;dated.push(n);}else undated.push(n);});
  if(!dated.length){
    el.innerHTML='<div class="tlempty">'+(items.length?`none of the ${items.length} item(s) have start/target dates or a dated sprint`:'nothing matches the filters')+'</div>';
    setStatus(`${items.length} items · 0 scheduled`+capNote());return;
  }
  let min=Infinity,max=-Infinity;dated.forEach(n=>{if(n._tl.s<min)min=n._tl.s;if(n._tl.e>max)max=n._tl.e;});
  const today=Date.parse(new Date().toISOString().slice(0,10));
  min=Math.min(min,today);max=Math.max(max,today);                          // always include today
  const ms=new Date(min),me=new Date(max);
  const r0=Date.UTC(ms.getUTCFullYear(),ms.getUTCMonth(),1);                 // start of the first month
  const r1=Date.UTC(me.getUTCFullYear(),me.getUTCMonth()+3,1)-TL_DAY;        // +2 months of future runway past the last item / today
  const px=TL_PX[tlZoom]||TL_PX.week,LW=TL_LABELW;
  const totalDays=Math.round((r1-r0)/TL_DAY)+1,W=Math.max(Math.round(totalDays*px),200);
  const xOf=t=>Math.round(((t-r0)/TL_DAY)*px);
  const wOf=(s,e)=>Math.max(Math.round(((e-s)/TL_DAY+1)*px),6);
  // axis (month labels) + gridlines (month / week) + weekend shading + today line
  const months=tlMonths(r0,r1);
  let axis='',grid='';
  months.forEach(m=>{const l=xOf(m.start),w=Math.round(((m.end-m.start)/TL_DAY+1)*px);
    axis+=`<div class="tlmonth" style="left:${l}px;width:${w}px">${esc(m.label)}</div>`;
    grid+=`<div class="tlvline" style="left:${l}px"></div>`;});
  if(tlZoom!=='month'){let d=r0-((new Date(r0).getUTCDay()+6)%7)*TL_DAY;   // week lines (Mondays)
    for(;d<=r1;d+=7*TL_DAY)if(d>=r0)grid+=`<div class="tlvline wk" style="left:${xOf(d)}px"></div>`;}
  if(tlZoom==='day'&&totalDays<=140)for(let d=r0;d<=r1;d+=TL_DAY){const wd=new Date(d).getUTCDay();
    if(wd===0||wd===6)grid+=`<div class="tlweekend" style="left:${xOf(d)}px;width:${px}px"></div>`;}
  if(today>=r0&&today<=r1)grid+=`<div class="tltoday" style="left:${xOf(today)+Math.round(px/2)}px"></div>`;
  // second axis tier: day numbers (day zoom) or week-start dates (week zoom)
  let ticks='';
  if(tlZoom==='day'){
    for(let d=r0;d<=r1;d+=TL_DAY){const dt=new Date(d),wd=dt.getUTCDay(),cls=(d===today?' now':((wd===0||wd===6)?' we':''));
      ticks+=`<div class="tltick${cls}" style="left:${xOf(d)}px;width:${px}px">${dt.getUTCDate()}</div>`;}
  }else if(tlZoom==='week'){
    for(let d=r0-((new Date(r0).getUTCDay()+6)%7)*TL_DAY;d<=r1;d+=7*TL_DAY){if(d<r0)continue;
      const dt=new Date(d),cls=(today>=d&&today<d+7*TL_DAY)?' now':'';
      ticks+=`<div class="tltick${cls}" style="left:${xOf(d)}px;width:${Math.round(7*px)}px">${dt.getUTCDate()}</div>`;}
  }
  // rows
  const ymd=ms=>new Date(ms).toISOString().slice(0,10);
  const lab=n=>`<div class="tllabel" style="width:${LW}px"><i class="dot" style="background:${tyColor(n.type)}"></i><span class="tllab">#${n.id} ${esc(n.title)}</span></div>`;
  // sp (optional) = the group's sprint window {s,e}; bars outside it are flagged.
  const rowHTML=(n,sp)=>{const t=n._tl,oos=sp&&(t.s<sp.s||t.e>sp.e);
    const tip=`${n.start?prettyDate(n.start):(t.soft?'sprint start':'?')} → ${(n.target||n.due)?prettyDate(n.target||n.due):(t.soft?'sprint finish':'?')}`+(oos?'  ⚠ dates fall outside the sprint':'');
    return `<div class="tlrow${bulkSel.has(n.id)?' bulksel':''}" data-id="${n.id}">${lab(n)}<div class="tltrack" style="width:${W}px"><div class="tlbar${t.soft?' soft':''}${oos?' oos':''}" style="left:${xOf(t.s)}px;width:${wOf(t.s,t.e)}px;background-color:${tyColor(n.type)}" title="${esc(tip)}">#${n.id} ${esc(n.title)}</div></div></div>`;};
  const byStart=(a,b)=>(a._tl.s-b._tl.s)||(a.id-b.id);
  const groupHead=(k,arr,sp)=>{
    let label=esc(k)+' · '+arr.length,track;
    if(sp){                                          // sprint grouping: draw the sprint's own date span as a reference line
      label+=`  (${ymd(sp.s)} → ${ymd(sp.e)})`;
      track=`<div class="tlsprintspan" style="left:${xOf(sp.s)}px;width:${wOf(sp.s,sp.e)}px" title="sprint window ${prettyDate(ymd(sp.s))} → ${prettyDate(ymd(sp.e))}"></div>`;
    }else{const gs=Math.min(...arr.map(n=>n._tl.s)),ge=Math.max(...arr.map(n=>n._tl.e));
      track=`<div class="tlgroupbar" style="left:${xOf(gs)}px;width:${wOf(gs,ge)}px"></div>`;}
    return `<div class="tlgrouprow"><div class="tlgrouplabel" style="width:${LW}px">${label}</div><div class="tlgrouptrack" style="width:${W}px">${track}</div></div>`;};
  let rows='';
  if(tlGroup==='none')dated.sort(byStart).forEach(n=>{rows+=rowHTML(n);});
  else{
    const groups=new Map();dated.forEach(n=>{const k=tlKey(n);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(n);});
    let keys=[...groups.keys()];keys=(tlGroup==='state')?orderStates(keys):keys.sort((a,b)=>a.localeCompare(b));
    keys.forEach(k=>{const arr=groups.get(k).sort(byStart);
      let sp=null;
      if(tlGroup==='sprint'){const it=_sprint(arr[0].iteration);if(it&&it.start&&it.finish)sp={s:Date.parse(it.start.slice(0,10)),e:Date.parse(it.finish.slice(0,10))};}
      rows+=groupHead(k,arr,sp);arr.forEach(n=>{rows+=rowHTML(n,sp);});});
  }
  if(undated.length){
    rows+=`<div class="tlgrouprow"><div class="tlgrouplabel" style="width:${LW}px">No dates · ${undated.length}</div><div class="tlgrouptrack" style="width:${W}px"></div></div>`;
    undated.sort((a,b)=>a.id-b.id).forEach(n=>{rows+=`<div class="tlrow${bulkSel.has(n.id)?' bulksel':''}" data-id="${n.id}">${lab(n)}<div class="tltrack" style="width:${W}px"><span class="tlnodate">— no dates —</span></div></div>`;});
  }
  const prevScroll=el.scrollLeft;                  // preserve horizontal scroll across re-renders
  el.innerHTML=`<div class="tlcanvas">`+
    `<div class="tlhead"><div class="tlcorner" style="width:${LW}px">${months.length} mo · ${dated.length} scheduled</div><div class="tlaxis" style="width:${W}px">${axis}${ticks}</div></div>`+
    `<div class="tlbody"><div class="tlgrid" style="left:${LW}px;width:${W}px">${grid}</div>${rows}</div></div>`;
  setStatus(`${dated.length} scheduled · ${undated.length} no dates`+capNote());
  if(prevScroll>0)el.scrollLeft=prevScroll;        // keep the user's position on a re-render
  else if(today>=r0&&today<=r1)el.scrollLeft=Math.max(0,xOf(today)-Math.round(el.clientWidth*0.35));   // first paint: centre on today
}

/* ---------- mode / refresh ---------- */
function setMode(m){
  $('sprintview').classList.remove('show');openSprintPath=null;   // leaving board closes the sprint detail
  if(m!=='graph')depHandleHide();             // dep drag-handle is graph-only
  mode=m;$('mode').querySelectorAll('button').forEach(b=>b.classList.toggle('on',b.dataset.m===m));
  $('tree').classList.toggle('show',m==='tree');$('cy').classList.toggle('show',m==='graph');
  $('board').classList.toggle('show',m==='board');$('timeline').classList.toggle('show',m==='timeline');
  $('emode').style.display=$('dir').style.display=(m==='graph')?'inline-flex':'none';
  $('fit').style.display=(m==='graph')?'inline-block':'none';   // Fit only makes sense on the graph
  if(m!=='graph')$('badgepanel').style.display='none';            // badges popover lives inside the Controls header — graph-only
  $('empty_btn').style.display=(m==='board')?'inline-block':'none';
  $('grp').style.display=(m==='board')?'inline-flex':'none';
  $('tlzoom').style.display=(m==='timeline')?'inline-flex':'none';
  $('tl_group').style.display=(m==='timeline')?'inline-block':'none';
  renderViewHelp();
}
// Per-view "what can I do here" legend, bottom-left. Each view has its own
// non-obvious interactions (modifier-click to bulk-select, drag semantics, …);
// this surfaces them. Collapsible, with the state remembered across sessions.
const VIEW_HELP={
  tree:[['🖱️','Click','open item'],['▸','Click ▸','expand / collapse'],['☑️','Ctrl-click','toggle select'],['↕️','Shift-click','select range'],['✋','Drag','re-parent onto a row']],
  graph:[['🖱️','Click','open item'],['👆','Double-click','expand / collapse children'],['☑️','Ctrl / Shift-click','toggle select'],['✋','Drag node','move · background pans'],['🔍','Scroll','zoom'],['→','+Deps: drag handle','create dependency link'],['🗑️','+Deps: click edge','delete dependency']],
  board:[['🖱️','Click','open item'],['☑️','Ctrl / Shift-click','toggle / range select'],['✋','Drag','move to another column'],['➕','Drag → ＋','new sprint from cards']],
  timeline:[['🖱️','Click','open item'],['☑️','Ctrl-click','toggle select'],['↕️','Shift-click','select range']],
};
function viewHelpCollapsed(){try{return localStorage.getItem('ado.viewhelp')==='0';}catch(e){return false;}}
function renderViewHelp(){
  const box=$('viewhelp'),rows=VIEW_HELP[mode];
  const show=!!rows&&!$('sprintview').classList.contains('show');   // hide over the sprint detail
  box.classList.toggle('show',show);
  if(!show){$('badgepanel').style.display='none';return;}
  const collapsed=viewHelpCollapsed();
  box.classList.toggle('collapsed',collapsed);
  // graph mode: the Badges gear sits flush-left in the header (replaces the old
  // standalone "⚙ Badges" button); clicking it toggles the popover without
  // collapsing the Controls box.
  const gear=mode==='graph'?`<button class="vhbadge" id="vhbadge" title="show / hide badges on graph nodes">⚙</button>`:'';
  box.innerHTML=`<div class="vhh" id="vhh">${gear}<span class="vhctrl">${collapsed?'▸':'▾'} Controls</span></div>`+
    `<div class="vhb">`+rows.map(r=>`<div class="vhrow"><span class="vi">${esc(r[0])}</span><span class="vk">${esc(r[1])}</span><span class="vd">${esc(r[2])}</span></div>`).join('')+
    `<div class="vhnote">selecting items opens the bulk-edit bar</div></div>`;
  // Toggle collapse only when the user clicks the "Controls" label, not the gear.
  $('vhh').querySelector('.vhctrl').onclick=()=>{try{localStorage.setItem('ado.viewhelp',viewHelpCollapsed()?'1':'0');}catch(e){}renderViewHelp();};
  const gb=$('vhbadge');if(gb)gb.onclick=e=>{e.stopPropagation();toggleBadgePanel();};
}
// Bottom-left badge picker: a "⚙ Badges" button + checkbox panel (graph mode only).
// Toggling rebuilds cytoscape styles so the mappers re-evaluate the badgeOn() gate.
function renderBadgePanel(){
  const p=$('badgepanel');
  p.innerHTML=`<div class="bph">Show on nodes</div>`+
    BADGE_FIELDS.map(f=>`<label><input type="checkbox" data-k="${f.key}"${badgeOn(f.key)?' checked':''}> ${esc(f.label)}</label>`).join('');
  p.querySelectorAll('input[data-k]').forEach(cb=>cb.onchange=()=>{
    badgesOn[cb.dataset.k]=cb.checked;saveBadgesOn();
    if(cy){cy.style(gstyle()).update();}                   // mappers re-read badgeOn() on next paint
  });
}
function toggleBadgePanel(){const p=$('badgepanel');if(p.style.display==='none'){renderBadgePanel();p.style.display='block';}else p.style.display='none';}
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
  const items=await currentItems();
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
  renderTree();                          // keep the tree DOM current (cheap, from store)
  $('tree').scrollTop=ts;                // preserve scroll across the rebuild
  if(mode==='graph')renderGraph({relayout:true,fit:true});
  else if(mode==='board')renderBoard();
  else if(mode==='timeline')renderTimeline();
  if(openSprintPath&&$('sprintview').classList.contains('show'))renderSprint(openSprintPath);   // live-update open sprint
  saveSnapshot();                        // cache this view for an instant first paint next session
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
  if(mode==='tree'){const ts=$('tree').scrollTop;renderTree();$('tree').scrollTop=ts;}
  else if(mode==='graph'&&cy){cy.batch(()=>cy.nodes().forEach(nd=>{const n=store.nodes[Number(nd.data('id'))];if(n)nd.data('childCount',n.childCount);}));cy.style().update();}
  saveSnapshot();                         // persist the counts so next session's cached paint has them too
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
function closePanel(force){
  if(!force&&dirty()&&!confirm('Discard unsaved changes?'))return;
  parentEditor.close();depBlockedByPicker.close();depBlocksPicker.close();
  $('side').classList.add('hidden');$('resizer').style.display='none';cur=null;orig={};
  depsState.blockedBy=[];depsState.blocks=[];renderDeps();
  if(selRow){selRow.classList.remove('sel');selRow=null;}
  if(cy)cy.$(':selected').unselect();
}
const mdToHtml=AdoLib.mdToHtml;                     // pure, hardened renderer in lib.js
function showDescPreview(on){
  const ta=$('s_desc'),pv=$('s_desc_prev'),tg=$('s_desc_toggle');
  if(on){pv.innerHTML=mdToHtml(ta.value);ta.style.display='none';pv.style.display='block';tg.textContent='edit';}
  else{pv.style.display='none';ta.style.display='block';tg.textContent='preview';}
}
function fmtDur(sec){const d=Math.floor(sec/86400),h=Math.floor(sec%86400/3600);return d?(d+'d'+(h?' '+h+'h':'')):(h+'h');}
async function loadTimeline(id){
  $('s_time').innerHTML='';
  let t;try{t=await api.timeline(id,tzOffset);}catch(e){return;}
  if(!t.durations)return;
  const ent=Object.entries(t.durations).sort((a,b)=>b[1]-a[1]);
  if(!ent.length)return;
  $('s_time').innerHTML='<span>⏱ time in state:</span>'+ent.map(([s,sec])=>
    `<span><span class="sbadge" style="background:${stateColor(s)};font-size:9px">${esc(s)}</span> <b>${fmtDur(sec)}</b></span>`).join('');
}
// Sidebar hierarchy nav: an "↑ parent" chip to go up and a "↓ children" chip
// that expands an inline, clickable child list — so you can walk the tree both
// ways without leaving the editor.
function renderItemContext(d){
  const up=d.parent?`<a class="ctxnav" id="s_par" title="open parent">↑ #${d.parent}</a>`:'';
  const n=store.nodes[d.id],cc=n?n.childCount:undefined;
  $('s_ctx').innerHTML=up+`<a class="ctxnav" id="s_kidsbtn" title="show children">↓ children${cc!=null?' ('+cc+')':''}</a>`;
  if(d.parent)$('s_par').onclick=()=>openItem(d.parent);
  const kb=$('s_kidsbtn'),box=$('s_kidlist');
  box.style.display='none';box.innerHTML='';
  if(cc===0)kb.classList.add('ctxoff');                 // known childless → inert chip
  else kb.onclick=()=>toggleSidebarKids(d.id,kb);
  if(cc===undefined&&n)fetchChildCounts([d.id]).then(ch=>{if(ch&&cur===d.id)renderItemContext(d);});   // learn + refresh the (N)
}
async function toggleSidebarKids(id,btn){
  const box=$('s_kidlist');
  if(box.style.display!=='none'){box.style.display='none';btn&&btn.classList.remove('ctxon');return;}
  box.style.display='block';btn&&btn.classList.add('ctxon');box.innerHTML='<div class="kidmsg">loading…</div>';
  let kids;try{kids=await ensureKids(id);}catch(e){kids=[];}
  if(cur!==id)return;                                    // user navigated away while loading
  const nodes=kids.map(k=>store.nodes[k]).filter(Boolean);
  if(!nodes.length){box.innerHTML='<div class="kidmsg">(no children)</div>';return;}
  box.innerHTML=nodes.map(k=>`<a class="kidrow" data-id="${k.id}"><i class="dot" style="background:${tyColor(k.type)}"></i>`+
    `<span class="kidttl">#${k.id} ${esc(k.title||'')}</span>`+
    (k.state?`<span class="kidstate" style="background:${stateColor(k.state)}">${esc(k.state)}</span>`:'')+`</a>`).join('');
  box.querySelectorAll('.kidrow').forEach(r=>r.onclick=()=>openItem(+r.dataset.id));
}
async function openItem(id){
  const myToken=++openToken;
  if(cur!=null&&id!==cur&&dirty()&&!confirm('Discard unsaved changes to #'+cur+'?'))return;  // guard against silent loss
  $('s_time').innerHTML='';
  loadStart('loading #'+id+'…');
  let d;try{d=await api.item(id);}catch(e){setStatus('ERROR: '+e.message,true);loadEnd();return;}
  loadEnd();
  if(myToken!==openToken)return;                  // a newer openItem() superseded this one
  cur=id;$('side').classList.remove('hidden');$('resizer').style.display='block';$('child_form').style.display='none';$('comment_form').style.display='none';
  $('s_activity').classList.remove('show');$('s_activity').innerHTML='';   // collapse activity for the new item
  $('s_hdr').innerHTML=`<i class="dot" style="background:${tyColor(d.type)}"></i>#${d.id} ${esc(d.type)}`+
    ` <span class="sbadge" style="background:${stateColor(d.state)}">${esc(d.state)}</span>`+
    ` <span style="color:var(--muted);font-weight:400;font-size:11px">rev${d.rev}</span>`;
  renderItemContext(d);
  $('s_link').href=d.url;$('s_title').value=d.title;assignedEditor.set(d.assigned||'',/*silent*/true);$('s_desc').value=d.desc;
  showDescPreview(true);                          // open in preview; click "edit" to modify
  $('s_prio').value=d.priority?String(d.priority):'';
  $('ac_wrap').style.display=d.has_ac?'block':'none';$('s_ac').value=d.ac;
  const sel=$('s_state');sel.innerHTML='';
  let states;try{states=await api.states(d.type);}catch(e){states=['New','Active','Resolved','Closed','Removed'];}
  if(myToken!==openToken)return;                  // a newer openItem() superseded this one
  if(!states.includes(d.state))states.unshift(d.state);
  states.forEach(s=>{const o=document.createElement('option');o.value=o.textContent=s;sel.appendChild(o);});
  sel.value=d.state;
  // sprint dropdown (manual iteration change) + planning dates
  const iters=await getIterations();
  if(myToken!==openToken)return;                  // a newer openItem() superseded this one
  const root=iters[0]?iters[0].path.split('\\')[0]:projectName;
  const curIt=d.iteration||root;
  sprintEditor.set(curIt,/*silent*/true);                                // sprint card + picker (iterCache is loaded above)
  parentEditor.set(d.parent!=null?String(d.parent):'',/*silent*/true);   // set value + render card without flipping dirty
  $('s_start').value=(d.start||'').slice(0,10);
  $('s_target').value=(d.target||'').slice(0,10);
  $('s_due').value=(d.due||'').slice(0,10);
  $('s_est').value=(d.est!=null?d.est:'');
  tagsEditor.set(d.tags||'',/*silent*/true);
  loadDeps(id,d.deps);                            // seed from item() result; no extra round-trip
  orig={title:d.title,state:d.state,assigned:d.assigned,desc:d.desc,ac:d.ac,has_ac:d.has_ac,priority:d.priority,
        iter:curIt,parent:(d.parent!=null?String(d.parent):''),start:$('s_start').value,target:$('s_target').value,due:$('s_due').value,est:$('s_est').value,tags:tagsEditor.value()};
  refreshDirty();loadTimeline(id);
  setStatus('#'+id+' loaded');
}
function dirty(){
  if(cur==null||!orig)return false;
  const v=editorValues();
  return v.title!==orig.title||v.state!==orig.state||v.assigned!==orig.assigned||v.desc!==orig.desc
    ||(orig.has_ac&&v.ac!==orig.ac)||((orig.priority?String(orig.priority):'')!==v.prio)
    ||v.iter!==orig.iter||v.parent!==orig.parent||v.start!==orig.start||v.target!==orig.target||v.due!==orig.due||v.est!==orig.est
    ||v.tags!==orig.tags;
}
function refreshDirty(){const d=dirty();const b=$('s_save');b.disabled=!d;b.textContent=d?'● Save':'Saved';}
function editorValues(){return {title:$('s_title').value,state:$('s_state').value,assigned:$('s_assigned').value,desc:$('s_desc').value,ac:$('s_ac').value,prio:$('s_prio').value,
  iter:$('s_iter').value,parent:$('s_parent').value.trim(),start:$('s_start').value,target:$('s_target').value,due:$('s_due').value,est:$('s_est').value,tags:tagsEditor.value()};}
// editor tags: chips with × remove + a "＋" bubble that reveals an inline input;
// the input commits on Enter/comma/blur and hides again. value() is ADO's "a; b".
const tagsEditor=(function(){let cur=[],adding=false,committing=false;
  const norm=s=>String(s||'').split(/[;,]/).map(t=>t.trim()).filter(Boolean);
  const uniq=a=>{const seen=new Set(),o=[];a.forEach(t=>{const k=t.toLowerCase();if(!seen.has(k)){seen.add(k);o.push(t);}});return o;};
  function commit(v){const a=norm(v);if(a.length){cur=uniq(cur.concat(a));refreshDirty();}}
  function render(){const box=$('s_tags');
    let html=cur.map((t,i)=>`<span class="tagchip" style="background:${personColor(t)}">${esc(t)}<b data-i="${i}" title="remove">×</b></span>`).join('');
    if(!cur.length&&!adding)html='<span class="pcnone">no tags</span>';
    html+=adding
      ? `<input id="s_taginp" class="taginp" list="tagsdl" placeholder="tag…" autocomplete="off"><button type="button" id="s_tagok" class="tagok" title="add tag">✓</button>`
      : `<button type="button" class="tagadd" id="s_tagplus" title="add a tag">＋</button>`;
    box.innerHTML=html;
    box.querySelectorAll('b[data-i]').forEach(x=>{
      x.onmousedown=e=>e.preventDefault();
      x.onclick=()=>{committing=true;cur.splice(+x.dataset.i,1);render();committing=false;refreshDirty();};
    });
    if(adding){const inp=$('s_taginp'),ok=$('s_tagok');inp.focus();
      function doCommit(){committing=true;commit(inp.value);inp.value='';render();adding=true;const ni=$('s_taginp');if(ni)ni.focus();committing=false;}
      ok.onmousedown=e=>e.preventDefault();
      ok.onclick=doCommit;
      inp.addEventListener('keydown',e=>{
        if(e.key==='Enter'||e.key===','){e.preventDefault();doCommit();}
        else if(e.key==='Escape'){e.preventDefault();e.stopPropagation();adding=false;render();}
        else if(e.key==='Backspace'&&!inp.value&&cur.length){committing=true;cur.pop();render();adding=true;const ni=$('s_taginp');if(ni)ni.focus();committing=false;refreshDirty();}});
      inp.addEventListener('change',()=>{if(inp.value.trim())doCommit();});
      inp.addEventListener('blur',()=>{if(!committing){commit(inp.value);adding=false;render();}});
    }else{const p=$('s_tagplus');if(p)p.onclick=()=>{adding=true;render();};}
  }
  return {render,
    add(s){commit(s);render();},
    set(s,silent){cur=uniq(norm(s));adding=false;render();if(!silent)refreshDirty();},
    value(){return cur.join('; ');}};
})();

/* ===================== CardPicker =====================
   Reusable form control: a card showing the chosen value + a searchable
   dropdown to change it. One instance per spot; the three spots so far are
   parent item, assignee and sprint (provider plugs in the data + rendering).
   Elements are looked up by id from `base`: <base> (hidden value), <base>_card,
   <base>_pick, <base>_search, <base>_results, and optional <base>_open. */
function parentCardHtml(n){
  return `<i class="dot" style="background:${tyColor(n.type)}"></i>`+
    `<span class="pcid">#${n.id}</span><span class="pctitle">${esc(n.title||'')}</span>`+
    (n.state?`<span class="pcstate" style="background:${stateColor(n.state)}">${esc(n.state)}</span>`:'');
}
function createCardPicker(base,opts){
  opts=opts||{};
  const onChange=opts.onChange||(()=>{});
  const prov=opts.provider;
  const V=()=>$(base),Card=()=>$(base+'_card'),Pick=()=>$(base+'_pick'),
        Search=()=>$(base+'_search'),Results=()=>$(base+'_results'),Open=()=>$(base+'_open');
  let idx=0,rows=[],searchTimer=null,searchTok=0,searching=false;
  function render(){
    const v=V().value.trim(),card=Card(),openBtn=Open();
    card.dataset.val=v;                              // lets the provider drop stale async card renders
    if(openBtn)openBtn.style.visibility=(v&&prov.openValue)?'visible':'hidden';
    prov.renderCard(v,card);
  }
  function set(v,silent){V().value=(v==null?'':String(v));render();close();if(!silent)onChange();}
  function get(){return V().value.trim();}
  function open(){const p=Pick();if(p.style.display!=='none'){close();return;}   // toggle
    p.style.display='block';const i=Search();i.value='';results('');i.focus();}
  function close(){const p=Pick();if(p)p.style.display='none';}
  function isOpen(){const p=Pick();return !!p&&p.style.display!=='none';}
  function results(q){
    rows=prov.localRows(q);idx=0;
    clearTimeout(searchTimer);const tok=++searchTok;searching=false;
    const run=prov.apiExpand?prov.apiExpand(q,rows):null;   // null → no server lookup for this query
    if(run){
      searching=true;
      searchTimer=setTimeout(async()=>{
        const next=await run();
        if(tok!==searchTok)return;                   // a newer query superseded this one
        rows=next;idx=Math.max(0,Math.min(idx,rows.length-1));searching=false;draw();
      },300);
    }
    draw();
  }
  function draw(){
    const list=Results();
    list.innerHTML=rows.map((r,i)=>`<div class="prow${i===idx?' on':''}" data-i="${i}">${r.html}</div>`).join('')
      +(searching?'<div class="prow"><span class="pkind"></span><span class="ptitle pcnone">searching…</span></div>':'');
    list.querySelectorAll('.prow[data-i]').forEach(r=>{
      r.onmousedown=e=>{e.preventDefault();idx=+r.dataset.i;pick();};
      r.onmousemove=()=>{if(idx!==+r.dataset.i){idx=+r.dataset.i;highlight();}};
    });
    const first=list.querySelector('.prow[data-i]');     // cap the visible window at ~5 rows, rest scrolls
    if(first)list.style.maxHeight=(first.offsetHeight*5)+'px';
  }
  function highlight(){Results().querySelectorAll('.prow[data-i]').forEach(r=>r.classList.toggle('on',+r.dataset.i===idx));}
  function move(d){if(!rows.length)return;idx=(idx+d+rows.length)%rows.length;highlight();
    const el=Results().querySelector('.prow.on');if(el)el.scrollIntoView({block:'nearest'});}
  function pick(){const r=rows[idx];if(!r)return;set(r.value);}
  function wire(){
    Card().onclick=open;
    Search().addEventListener('input',e=>results(e.target.value));
    Search().addEventListener('keydown',e=>{
      if(e.key==='ArrowDown'){e.preventDefault();move(1);}
      else if(e.key==='ArrowUp'){e.preventDefault();move(-1);}
      else if(e.key==='Enter'){e.preventDefault();pick();}
      else if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close();Card().focus();}
    });
    const ob=Open();if(ob)ob.onclick=()=>{const v=get();if(prov.openValue)prov.openValue(v);};
    document.addEventListener('mousedown',e=>{if(isOpen()&&!Pick().contains(e.target)&&!Card().contains(e.target))close();});
  }
  return {set,get,render,open,close,isOpen,wire};
}

/* --- provider: parent / any work-item (id+title, with server-side search) --- */
function itemRow(n){const badge=n.state?`<span class="pbadge" style="background:${stateColor(n.state)}">${esc(n.state)}</span>`:'';
  return {value:String(n.id),html:`<span class="pkind">${esc(n.type||'item')}</span><span class="ptitle">#${n.id} ${esc(n.title||'')}</span>${badge}`};}
async function itemApiSearch(term){            // look up items the local tree hasn't loaded
  const m=term.match(/^#?(\d+)$/);
  if(m){try{const it=await api.item(parseInt(m[1],10));return it?[it]:[];}catch(e){return [];}}
  try{return (await api.search({text:term}))||[];}catch(e){return [];}
}
function itemPickerProvider(getExclude){
  getExclude=getExclude||(()=>null);
  return {
    openValue(v){if(/^\d+$/.test(v))openItem(parseInt(v,10));},
    renderCard(v,card){
      if(!v){card.innerHTML='<span class="pcnone">(no parent)</span>';return;}
      const n=store.nodes[v];
      if(n){card.innerHTML=parentCardHtml(n);return;}
      card.innerHTML=`<i class="dot" style="background:#95a5a6"></i><span class="pcid">#${v}</span><span class="pctitle pcnone">loading…</span>`;
      const want=v;                               // resolve the title for an item that isn't in the loaded tree
      api.item(v).then(it=>{if(card.dataset.val!==want)return;store.nodes[it.id]=store.nodes[it.id]||it;card.innerHTML=parentCardHtml(it);})
        .catch(()=>{if(card.dataset.val===want)card.innerHTML=`<i class="dot" style="background:#95a5a6"></i><span class="pcid">#${v}</span>`;});
    },
    localRows(q){
      q=(q||'').trim().toLowerCase();const toks=q.split(/\s+/).filter(Boolean),ex=getExclude();
      const out=[{value:'',html:`<span class="pkind">—</span><span class="ptitle pcnone">(no parent)</span>`}];
      if(/^#?\d+$/.test(q)){const id=parseInt(q.replace('#',''),10);if(id!==ex&&!store.nodes[id])out.push({value:String(id),raw:true,html:`<span class="pkind">id</span><span class="ptitle">Use #${id}</span>`});}
      let n=0;
      for(const node of Object.values(store.nodes)){
        if(ex!=null&&node.id===ex)continue;         // an item can't be its own parent
        const hay=('#'+node.id+' '+(node.title||'')).toLowerCase();
        if(!toks.length||toks.every(t=>hay.includes(t))){out.push(itemRow(node));if(++n>=40)break;}
      }
      return out;
    },
    apiExpand(q,rows){
      const term=(q||'').trim();
      if(!(term.length>=2||/^#?\d+$/.test(term)))return null;   // too short → local matches only
      const ex=getExclude();
      return async()=>{
        const found=await itemApiSearch(term);
        const have=new Set(rows.filter(r=>r.value&&!r.raw).map(r=>r.value)),extra=[];
        found.slice(0,30).forEach(it=>{if(!it||!it.id||it.id===ex)return;
          store.nodes[it.id]=store.nodes[it.id]||it;
          const k=String(it.id);if(!have.has(k)){extra.push(itemRow(it));have.add(k);}});
        return rows.filter(r=>!(r.raw&&have.has(r.value))).concat(extra);   // drop "Use #id" once it resolved
      };
    },
  };
}

/* --- provider: assignee / person (team roster is fully loaded in `assignees`) --- */
function personColor(name){let h=0;name=String(name);for(let i=0;i<name.length;i++)h=(h*31+name.charCodeAt(i))>>>0;return `hsl(${h%360} 52% 45%)`;}
function personInitials(name){const p=String(name).trim().split(/\s+/).filter(Boolean);return (((p[0]||'')[0]||'')+(p.length>1?(p[p.length-1][0]||''):'')).toUpperCase()||'?';}
function personChip(name){return `<i class="pav" style="background:${personColor(name)}">${esc(personInitials(name))}</i>`;}
function personChipT(name){return `<i class="pav pavsm" title="${esc(name)}" style="background:${personColor(name)}">${esc(personInitials(name))}</i>`;}   // small, tooltipped — board cards
const BLANK_IMG="data:image/svg+xml;utf8,"+encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='1' height='1'></svg>");   // transparent slot for an absent multi-background layer
// All node badges are SVG drawn into a viewBox while width/height attrs are 3×
// the logical size — the browser rasterises at 3× then cytoscape scales down:
// crisp on HiDPI, no blur. Style is light & modern: thin strokes, soft fills.
const SVGSC=3;
const BADGE_FONT="-apple-system,Segoe UI,Roboto,sans-serif";
function svgTag(w,h,body){return 'data:image/svg+xml;utf8,'+encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='${w*SVGSC}' height='${h*SVGSC}' viewBox='0 0 ${w} ${h}'>${body}</svg>`);}
function hexToRgba(hex,a){const[r,g,b]=hexToRgb(hex);return `rgba(${r},${g},${b},${a})`;}
// readable text colour for a coloured chip (dark on light fills, white on dark)
function idealText(hex){const[r,g,b]=hexToRgb(hex);return (0.299*r+0.587*g+0.114*b)>150?'#1b2330':'#ffffff';}
// flat "bookmark" ribbon (tag with a soft V-notch) carrying a short label
function bookmarkUri(color,text,dir){
  text=String(text);const fs=text.length>1?9:12,W=18,H=24;
  const path=dir==='up'
    ? `M2 ${H-1} L2 6 Q2 4 4 4 L${W-4} 4 Q${W-2} 4 ${W-2} 6 L${W-2} ${H-1} L${W/2} ${H-6} Z`
    : `M2 3 Q2 1 4 1 L${W-4} 1 Q${W-2} 1 ${W-2} 3 L${W-2} ${H-4} L${W/2} ${H-9} L2 ${H-4} Z`;
  const ty=dir==='up'?17:13;
  return svgTag(W,H,`<path d='${path}' fill='${color}'/>`+
    `<text x='${W/2}' y='${ty}' font-size='${fs}' font-family='${BADGE_FONT}' font-weight='600' fill='#ffffff' text-anchor='middle'>${esc(text)}</text>`);
}
// rounded "pill": soft tinted fill + thin same-colour border + coloured text (Excalidraw-ish)
function pillW(text,max){return Math.round(Math.min(max||150,Math.max(26,10+String(text).length*6.4)));}
function pillUri(text,color,max){const w=pillW(text,max),h=18,light=document.body.classList.contains('light');
  const fill=light?hexToRgba(color,0.16):hexToRgba(color,0.28),txt=light?color:'#ffffff';
  return svgTag(w,h,`<rect x='0.75' y='0.75' rx='${h/2}' ry='${h/2}' width='${w-1.5}' height='${h-1.5}' fill='${fill}' stroke='${color}' stroke-width='1.2'/>`+
    `<text x='${w/2}' y='${h/2+3.6}' font-size='10.5' font-family='${BADGE_FONT}' font-weight='600' fill='${txt}' text-anchor='middle'>${esc(text)}</text>`);}
const statePillW=t=>pillW(t),statePillUri=(t,c)=>pillUri(t,c);
// assignee badge: same flat bookmark in the person's colour with their initials
function avatarBadgeUri(name){return bookmarkUri(personColor(name),personInitials(name),'down');}
// "corner tag": a coloured panel flush into a node corner (two edges square, the
// node corner rounded, the inner corner rounded) — reads as part of the node,
// not a floating pill. corner: 'bl' (bottom-left) | 'tr' (top-right).
function cornerW(text,max){return Math.round(Math.min(max||120,Math.max(22,9+String(text).length*6.1)));}
// rounded-rect path with a per-corner radius [tl,tr,br,bl]
function roundRectPath(w,h,r){const[tl,tr,br,bl]=r;
  return `M${tl} 0 L${w-tr} 0 Q${w} 0 ${w} ${tr} L${w} ${h-br} Q${w} ${h} ${w-br} ${h} `+
    `L${bl} ${h} Q0 ${h} 0 ${h-bl} L0 ${tl} Q0 0 ${tl} 0 Z`;}
// "corner tag": a coloured panel flush into a node corner — the matching node
// corner is rounded and the diagonally-opposite inner corner is rounded too;
// the two edges along the node sides are square. Reads as part of the node,
// not a floating pill. corner: 'tl' | 'tr' | 'bl' | 'br'.
function cornerTagUri(text,color,corner,max){const w=cornerW(text,max),h=16,ro=8,ri=7;
  // radii [tl,tr,br,bl]: round the node corner + its diagonal (inner) corner
  const R={tl:[ro,0,ri,0],tr:[0,ro,0,ri],br:[ri,0,ro,0],bl:[0,ri,0,ro]}[corner]||[0,0,0,0];
  return {w,h,uri:svgTag(w,h,`<path d='${roundRectPath(w,h,R)}' fill='${color}'/>`+
    `<text x='${w/2}' y='${h/2+3.4}' font-size='10' font-family='${BADGE_FONT}' font-weight='600' fill='${idealText(color)}' text-anchor='middle'>${esc(text)}</text>`)};}
// node tags: parse the ";"-list, take the short name of an iteration path
function tagList_(s){return String(s||'').split(/;\s*/).map(t=>t.trim()).filter(Boolean);}
function sprintShort(path){if(!path)return '';return sprintNames[path]||String(path).split('\\').pop();}
function isOverdue(n){const d=(n.target||n.due||'').slice(0,10);return !!d&&d<new Date().toISOString().slice(0,10)&&!DONE_STATES.includes(n.state);}
// a row of small, unobtrusive tag dots (max 6, "+N" overflow) as one image
function tagDotsUri(tagsStr){const ts=tagList_(tagsStr);if(!ts.length)return null;
  const show=ts.slice(0,6),extra=ts.length-show.length,gap=8,pad=2,r=3;
  const w=pad*2+show.length*gap+(extra>0?16:0),h=10;
  let x=pad+r,dots='';
  for(const t of show){dots+=`<circle cx='${x}' cy='${h/2}' r='${r}' fill='${personColor(t)}'/>`;x+=gap;}
  if(extra>0)dots+=`<text x='${x-r+1}' y='${h/2+3}' font-size='8' font-family='${BADGE_FONT}' font-weight='600' fill='#9aa7b4' text-anchor='start'>+${extra}</text>`;
  return {uri:svgTag(w,h,dots),w};}
function assigneePeople(){const seen=new Set(),out=[];   // current user first, then the deduped roster
  [currentUser,...assignees].forEach(a=>{if(a&&!seen.has(a)){seen.add(a);out.push(a);}});return out;}
function assigneePickerProvider(){
  return {
    renderCard(v,card){
      if(!v){card.innerHTML='<span class="pcnone">(unassigned)</span>';return;}
      card.innerHTML=`${personChip(v)}<span class="pctitle">${esc(v)}</span>`;
    },
    localRows(q){
      q=(q||'').trim().toLowerCase();
      const out=[{value:'',html:`<i class="pav pav0"></i><span class="ptitle pcnone">(unassigned)</span>`}];
      if(currentUser&&(!q||currentUser.toLowerCase().includes(q)))
        out.push({value:currentUser,html:`${personChip(currentUser)}<span class="ptitle">${esc(currentUser)} <span class="pcnone">· me</span></span>`});
      let n=0;
      for(const a of assigneePeople()){
        if(a===currentUser)continue;
        if(q&&!a.toLowerCase().includes(q))continue;
        out.push({value:a,html:`${personChip(a)}<span class="ptitle">${esc(a)}</span>`});
        if(++n>=40)break;
      }
      return out;
    },
    // no apiExpand — the project roster is already loaded into `assignees`
  };
}

/* --- provider: sprint / iteration (the project's dated iterations, fully cached) --- */
function sprintRoot(){return (iterCache&&iterCache[0])?iterCache[0].path.split('\\')[0]:projectName;}   // project segment = "no sprint"
function sprintRangeText(it){const s=it.start?it.start.slice(0,10):'',f=it.finish?it.finish.slice(0,10):'';return (s||f)?(s+'→'+f):'';}
function sprintPickerProvider(getNone){
  getNone=getNone||(()=>'');
  function isNone(v){return !v||v===getNone();}
  return {
    renderCard(v,card){
      if(isNone(v)){card.innerHTML='<span class="pcnone">(no sprint)</span>';return;}
      const it=_sprint(v);
      if(!it){card.innerHTML=`<span class="pctitle">${esc(v.split('\\').slice(1).join('\\')||v)}</span>`;return;}
      const rt=sprintRangeText(it);
      card.innerHTML=(isCurrentSprint(it)?'<span class="curdot" title="current sprint"></span>':'')+
        `<span class="pctitle">${esc(it.name)}</span>`+(rt?`<span class="pcnone" style="flex:none">${esc(rt)}</span>`:'');
    },
    localRows(q){
      q=(q||'').trim().toLowerCase();
      const out=[{value:getNone(),html:`<span class="pkind">—</span><span class="ptitle pcnone">(no sprint)</span>`}];
      for(const it of (iterCache||[])){
        if(q&&!it.name.toLowerCase().includes(q))continue;
        const rt=sprintRangeText(it);
        out.push({value:it.path,html:(isCurrentSprint(it)?'<span class="curdot"></span>':'<span class="pkind"></span>')+
          `<span class="ptitle">${esc(it.name)}</span>`+(rt?`<span class="pcnone">${esc(rt)}</span>`:'')});
      }
      return out;
    },
    // no apiExpand — iterations are already cached in iterCache
  };
}

function createParentField(base,opts){opts=opts||{};return createCardPicker(base,{onChange:opts.onChange,provider:itemPickerProvider(opts.getExcludeId)});}
function createAssigneeField(base,opts){opts=opts||{};return createCardPicker(base,{onChange:opts.onChange,provider:assigneePickerProvider()});}
function createSprintField(base,opts){opts=opts||{};return createCardPicker(base,{onChange:opts.onChange,provider:sprintPickerProvider(opts.getNone)});}
const parentEditor=createParentField('s_parent',{onChange:refreshDirty,getExcludeId:()=>cur});
const parentNew=createParentField('n_parent',{getExcludeId:()=>null});
const assignedEditor=createAssigneeField('s_assigned',{onChange:refreshDirty});
const assignedChild=createAssigneeField('c_assigned',{});
const assignedNew=createAssigneeField('n_assigned',{});
const sprintEditor=createSprintField('s_iter',{onChange:refreshDirty,getNone:sprintRoot});   // editor: "no sprint" = project root path
const sprintNew=createSprintField('n_iter',{getNone:()=>''});                                // new-item modal: "no sprint" = empty

/* ---------- dependency links (sidebar Blocked-by / Blocks + the graph) ----------
   The editor shows two chip rows + an item picker for adding. Mutations also fire
   from the graph (drag a stub between nodes, or click an edge to delete). Both
   paths share the same state + undo plumbing so the views stay consistent. */
const depsState={blockedBy:[],blocks:[]};
// Pick the per-direction array on the open item's deps state.
function depsArr(dir){return dir==='blocks'?depsState.blocks:depsState.blockedBy;}
function setDepsArr(dir,arr){if(dir==='blocks')depsState.blocks=arr;else depsState.blockedBy=arr;}
// Adapter on top of itemPickerProvider: hides the items already linked in the
// chosen direction and always renders the card as a "+ add" affordance (the
// picker never holds a sticky value — every pick triggers an add and resets).
function depAdderProvider(dir){
  const base=itemPickerProvider(()=>cur);
  const blocked=()=>new Set(depsArr(dir).map(Number));
  return {
    renderCard(v,card){const t=dir==='blocks'?'add a blocked link':'add a blocked-by link';
      card.innerHTML=`<span class="pcnone">＋ ${t}</span>`;},
    localRows(q){const ex=blocked();return base.localRows(q).filter(r=>!r.value||!ex.has(+r.value));},
    apiExpand(q,rows){const inner=base.apiExpand(q,rows);if(!inner)return null;
      const ex=blocked();return async()=>(await inner()).filter(r=>!r.value||!ex.has(+r.value));},
  };
}
// The hidden <input> keeps the last-picked id, but renderCard always shows the
// "+ add" affordance (independent of value), so we just reset the value to ''
// after each pick — no re-render needed.
function depPickerOnChange(dir){
  return ()=>{
    const baseId='s_deps_'+(dir==='blocks'?'blocks':'blockedby');
    const v=$(baseId).value.trim();
    $(baseId).value='';
    if(!/^\d+$/.test(v)||cur==null)return;
    addDepLink(cur,parseInt(v,10),dir);
  };
}
const depBlockedByPicker=createCardPicker('s_deps_blockedby',{provider:depAdderProvider('blockedBy'),onChange:depPickerOnChange('blockedBy')});
const depBlocksPicker=createCardPicker('s_deps_blocks',{provider:depAdderProvider('blocks'),onChange:depPickerOnChange('blocks')});

// Render Blocked-by / Blocks chip rows from depsState. Titles for items the tree
// hasn't loaded resolve lazily via api.item — same pattern as the parent card.
function renderDeps(){
  const chip=(id,dir)=>{
    const n=store.nodes[id];
    const ty=n?tyColor(n.type):'#95a5a6';
    const ttl=n?esc(n.title||''):'';
    return `<span class="depchip"><i class="dot" style="background:${ty}"></i>`+
      `<a class="depopen" data-id="${id}">#${id}</a>`+
      (ttl?`<span class="depttl">${ttl}</span>`:'')+
      `<b data-dir="${dir}" data-id="${id}" title="remove">×</b></span>`;
  };
  const bb=$('s_deps_blockedby_chips'),bk=$('s_deps_blocks_chips');
  if(!bb||!bk)return;
  bb.innerHTML=depsState.blockedBy.length?depsState.blockedBy.map(id=>chip(id,'blockedBy')).join(''):'<span class="pcnone">(none)</span>';
  bk.innerHTML=depsState.blocks.length?depsState.blocks.map(id=>chip(id,'blocks')).join(''):'<span class="pcnone">(none)</span>';
  document.querySelectorAll('#s_deps .depchip b[data-dir]').forEach(x=>x.onclick=()=>removeDepLink(cur,+x.dataset.id,x.dataset.dir));
  document.querySelectorAll('#s_deps .depopen').forEach(a=>a.onclick=(e)=>{e.preventDefault();openItem(+a.dataset.id);});
  // Lazy-load titles for ids not yet in the store (a single GET per id, cached on success)
  const missing=[...depsState.blockedBy,...depsState.blocks].filter(id=>!store.nodes[id]);
  missing.forEach(id=>{api.item(id).then(it=>{
    if(it&&it.id){store.nodes[it.id]=store.nodes[it.id]||it;if(cur!=null)renderDeps();}
  }).catch(()=>{});});
  // Keep the adder pickers in sync with the current list (so they exclude linked items)
  depBlockedByPicker.render();depBlocksPicker.render();
}
async function loadDeps(id,seed){
  depsState.blockedBy=seed&&seed.blockedBy?seed.blockedBy.slice():[];
  depsState.blocks=seed&&seed.blocks?seed.blocks.slice():[];
  renderDeps();
  if(seed)return;                                  // openItem already has fresh data from api.item()
  let d;try{d=await api.dependencies(id);}catch(e){return;}
  if(cur!==id)return;
  depsState.blockedBy=d.blockedBy||[];depsState.blocks=d.blocks||[];
  renderDeps();
}
// Map a UI direction relative to the focused item to the underlying (from, to)
// pair: edge always flows from → to ("from blocks to"). 'blocks' = focused
// blocks other; 'blockedBy' = other blocks focused.
function depPair(focusId,otherId,dir){
  return dir==='blocks'?{from:focusId,to:otherId}:{from:otherId,to:focusId};
}
// Sync local view-state (sidebar deps + graph edge) for a link that just changed
// on the server. `op` is 'add' | 'remove'.
function applyDepLocal(from,to,op){
  if(cur===from){const a=depsState.blocks;if(op==='add'){if(!a.includes(to))a.push(to);}else depsState.blocks=a.filter(x=>x!==to);}
  if(cur===to){const a=depsState.blockedBy;if(op==='add'){if(!a.includes(from))a.push(from);}else depsState.blockedBy=a.filter(x=>x!==from);}
  if(cur===from||cur===to)renderDeps();
  if(cy&&mode==='graph'&&edgeMode!=='hierarchy'){
    const eid='d_'+from+'_'+to;
    const existing=cy.getElementById(eid);
    if(op==='add'){if(existing.empty()&&cy.getElementById(String(from)).nonempty()&&cy.getElementById(String(to)).nonempty())
      cy.add({group:'edges',data:{id:eid,source:String(from),target:String(to),kind:'dep'}});}
    else{if(existing.nonempty())existing.remove();}
  }
}
async function addDepLink(focusId,otherId,dir){
  const {from,to}=depPair(focusId,otherId,dir);
  if(from===to){setStatus("a work item can't depend on itself",true);return;}
  // Local dup-check only when the sidebar's open item IS the focus (else we have no fresh state)
  if(cur===focusId&&depsArr(dir).includes(otherId))return;
  loadStart('linking #'+from+' → #'+to+'…');
  try{
    await api.addDependency(from,to);
    depCache={};                                   // graph cache is per id-set; nuke wholesale
    applyDepLocal(from,to,'add');
    pushAction(`link #${from} → #${to}`,
      async()=>{try{await api.removeDependency(from,to);}catch(e){}depCache={};applyDepLocal(from,to,'remove');if(cur===focusId)await loadDeps(focusId);},
      async()=>{try{await api.addDependency(from,to);}catch(e){}depCache={};applyDepLocal(from,to,'add');if(cur===focusId)await loadDeps(focusId);});
    setStatus(`linked #${from} → #${to}`);
  }catch(e){
    if(!denyOnForbidden(e,'add dependencies'))setStatus('ERROR: '+e.message,true);
  }finally{loadEnd();}
}
async function removeDepLink(focusId,otherId,dir){
  const {from,to}=depPair(focusId,otherId,dir);
  loadStart('unlinking #'+from+' → #'+to+'…');
  try{
    await api.removeDependency(from,to);
    depCache={};
    applyDepLocal(from,to,'remove');
    pushAction(`unlink #${from} → #${to}`,
      async()=>{try{await api.addDependency(from,to);}catch(e){}depCache={};applyDepLocal(from,to,'add');if(cur===focusId)await loadDeps(focusId);},
      async()=>{try{await api.removeDependency(from,to);}catch(e){}depCache={};applyDepLocal(from,to,'remove');if(cur===focusId)await loadDeps(focusId);});
    setStatus(`unlinked #${from} → #${to}`);
  }catch(e){
    if(!denyOnForbidden(e,'remove dependencies'))setStatus('ERROR: '+e.message,true);
  }finally{loadEnd();}
}

/* ---------- undo / redo (Ctrl/Cmd+Z · Ctrl/Cmd+Shift+Z or Ctrl+Y) ----------
   Each mutating action pushes a command with matching undo()/redo() functions,
   run via the raw api (so they never re-record themselves). A new action clears
   the redo stack. Undoing a create deletes the item (ADO Recycle Bin — still
   recoverable); redoing it re-creates it (new id, rebound for a later undo). */
const undoStack=[],redoStack=[];let undoBusy=false;
function pushAction(label,undo,redo){
  undoStack.push({label,undo,redo});if(undoStack.length>50)undoStack.shift();
  redoStack.length=0;updateUndoButtons();
}
async function afterUndo(id){await refresh();if(id!=null&&cur===id)openItem(id);}
async function runStep(from,to,verb){
  if(undoBusy)return;
  const e=from.pop();
  if(!e){setStatus('nothing to '+verb);return;}
  undoBusy=true;loadStart(verb+'ing: '+e.label+'…');
  try{await (verb==='undo'?e.undo:e.redo)();to.push(e);setStatus((verb==='undo'?'undid: ':'redid: ')+e.label);}
  catch(err){from.push(e);setStatus(verb+' failed ('+e.label+'): '+err.message,true);}
  finally{undoBusy=false;loadEnd();updateUndoButtons();}
}
const runUndo=()=>runStep(undoStack,redoStack,'undo');
const runRedo=()=>runStep(redoStack,undoStack,'redo');
function updateUndoButtons(){
  const u=$('undobtn'),r=$('redobtn');
  if(u)u.disabled=!undoStack.length;
  if(r)r.disabled=!redoStack.length;
}
// Hide the create affordances (toolbar New, editor + Child) when the user has
// been shown to lack work-item create permission (a create returned HTTP 403).
function updateCreateButtons(){
  const nb=$('newbtn');if(nb)nb.style.display=canCreateItem?'':'none';
  const cb=$('s_childbtn');if(cb)cb.style.display=canCreateItem?'':'none';
}
// An editor save: undo restores the old fields/parent, redo re-applies the new.
function recordEditUndo(id,body,parentChanged,before,beforeParent,newParent){
  const rev={};
  if('title'in body)rev.title=before.title;
  if('state'in body)rev.state=before.state;
  if('assigned'in body)rev.assigned=before.assigned;
  if('desc'in body)rev.desc=before.desc;
  if('ac'in body)rev.ac=before.ac;
  if('priority'in body&&Number.isFinite(before.priority))rev.priority=before.priority;
  if('iteration'in body)rev.iteration=before.iter;
  if('start'in body)rev.start=before.start;
  if('target'in body)rev.target=before.target;
  if('due'in body)rev.due=before.due;
  if('estimate'in body)rev.estimate=before.est;
  const hasRev=Object.keys(rev).length>0,hasFwd=Object.keys(body).length>0;
  if(!hasRev&&!parentChanged)return;
  pushAction('edit #'+id,
    async()=>{if(hasRev)await api.updateItem(id,rev);if(parentChanged)await api.setParent(id,beforeParent);await afterUndo(id);},
    async()=>{if(hasFwd)await api.updateItem(id,body);if(parentChanged)await api.setParent(id,newParent);await afterUndo(id);});
}

async function save(){
  if(cur==null)return;const id=cur;const v=editorValues();const body={};
  if(v.title!==orig.title)body.title=v.title;
  if(v.state!==orig.state)body.state=v.state;
  if(v.assigned!==orig.assigned)body.assigned=(v.assigned==='me'?(currentUser||v.assigned):v.assigned);
  if(v.desc!==orig.desc)body.desc=v.desc;
  if(orig.has_ac&&v.ac!==orig.ac)body.ac=v.ac;
  const op=orig.priority?String(orig.priority):'';
  if(v.prio!==op&&v.prio!=='')body.priority=Number(v.prio);
  if(v.iter!==orig.iter)body.iteration=v.iter;
  if(v.start!==orig.start)body.start=v.start;
  if(v.target!==orig.target)body.target=v.target;
  if(v.due!==orig.due)body.due=v.due;
  if(v.est!==orig.est)body.estimate=v.est;
  if(v.tags!==orig.tags)body.tags=v.tags;
  const parentChanged=v.parent!==orig.parent;   // re-parent is a relations PATCH, handled separately
  if(!Object.keys(body).length&&!parentChanged){setStatus('no changes');return;}
  if(parentChanged&&v.parent!==''&&Number(v.parent)===id){setStatus('A work item cannot be its own parent',true);return;}
  const before={...orig},beforeParent=orig.parent;   // snapshot for undo (orig is overwritten below)
  const sv=$('s_save');sv.disabled=true;sv.textContent='Saving…';loadStart('saving…');
  let r;
  try{
    if(Object.keys(body).length)r=await api.updateItem(id,body);
    if(parentChanged)await api.setParent(id,v.parent);   // v.parent==='' detaches (makes it a root)
  }catch(e){setStatus('ERROR: '+e.message,true);refreshDirty();loadEnd();return;}
  loadEnd();
  recordEditUndo(id,body,parentChanged,before,beforeParent,v.parent);
  if(selRow&&body.title)selRow.querySelector('.lab').textContent=`#${id} ${body.title}`;
  if(selRow&&body.state)selRow.querySelector('.badge').textContent=body.state;
  if(selRow&&('priority'in body)){let pc=selRow.querySelector('.prio');if(!pc){pc=document.createElement('span');pc.className='prio';selRow.insertBefore(pc,selRow.querySelector('.badge'));}pc.textContent='P'+body.priority;pc.style.background=prioColor(body.priority);}
  if(selRow&&('tags'in body)){selRow.querySelectorAll('.ttag').forEach(t=>t.remove());const bdg=selRow.querySelector('.badge');if(bdg){bdg.style.marginLeft='';const ts=tagList_(v.tags);if(ts.length){const show=ts.slice(0,3),extra=ts.length-show.length;bdg.style.marginLeft='0';show.forEach((t,i)=>{const tc=document.createElement('span');tc.className='ttag';tc.textContent=t;tc.style.background=personColor(t);tc.title=t;if(i===0)tc.style.marginLeft='auto';selRow.insertBefore(tc,bdg);});if(extra>0){const tc=document.createElement('span');tc.className='ttag';tc.textContent='+'+extra;tc.style.background='var(--muted)';selRow.insertBefore(tc,bdg);}}}}
  if(store.nodes[id]){const s=store.nodes[id];s.title=v.title;s.state=v.state;
    if('assigned'in body)s.assigned=body.assigned;
    if('priority'in body)s.priority=body.priority;
    if('iteration'in body)s.iteration=body.iteration;
    if('start'in body)s.start=v.start;            // keep the store's schedule dates in sync so the
    if('target'in body)s.target=v.target;         // timeline / sprint Gantt reflect edits on re-render
    if('due'in body)s.due=v.due;
    if('estimate'in body)s.est=(v.est===''?null:Number(v.est));
    if('tags'in body)s.tags=v.tags;}                // keep graph tag dots in sync
  // mirror the now-fresh store record onto the cytoscape node so graph badges
  // (state, tags, est, sprint, dates, assignee…) refresh on save without a full
  // refresh() — cytoscape mappers re-paint automatically when e.data() changes.
  if(cy&&store.nodes[id]){const n=cy.getElementById(String(id));if(n.nonempty())n.data(Object.assign({},store.nodes[id]));}
  orig={...orig,...v};if('priority'in body)orig.priority=body.priority;
  refreshDirty();setStatus(`#${id} saved`+(r?` → rev ${r.rev}`:''));
  // Auto-reload the list when the change can shift WHERE the item appears: sprint
  // moves it across board columns, assignee shifts its grouping, and a re-parent
  // changes the tree/graph hierarchy. Otherwise re-render the current view from the
  // (now updated) store so date/title/priority edits show without a full reload.
  if('iteration'in body||'assigned'in body||parentChanged)refresh();
  else{
    if(mode==='board')renderBoard();
    else if(mode==='timeline')renderTimeline();
    if(openSprintPath&&$('sprintview').classList.contains('show'))renderSprint(openSprintPath);
  }
}
function toggleComment(){const f=$('comment_form');const show=f.style.display!=='flex';f.style.display=show?'flex':'none';if(show)$('cm_text').focus();}
async function postComment(){
  const t=$('cm_text').value.trim();if(!t||cur==null)return;
  try{await api.comment(cur,t);}catch(e){setStatus('ERROR: '+e.message,true);return;}
  $('cm_text').value='';$('comment_form').style.display='none';setStatus('#'+cur+' comment added');
  if($('s_activity').classList.contains('show'))loadActivity();   // reflect the new comment if the panel is open
}

/* ---------- activity: existing comments + field-change history ---------- */
let _actId=null;
function toggleActivity(){
  const box=$('s_activity');
  if(box.classList.contains('show')){box.classList.remove('show');return;}
  box.classList.add('show');loadActivity();
}
async function loadActivity(){
  if(cur==null)return;
  const box=$('s_activity'),id=cur;_actId=id;
  box.innerHTML='<div class="asec">loading…</div>';
  let cs=[],hs=[];
  try{[cs,hs]=await Promise.all([api.comments(id),api.history(id)]);}catch(e){/* render whatever we got */}
  if(_actId!==id||cur!==id)return;                 // user switched items mid-load
  renderActivity(cs,hs);
}
function renderActivity(cs,hs){
  const fd=s=>s?String(s).slice(0,16).replace('T',' '):'';
  let h='<div class="asec">Comments ('+cs.length+')</div>';
  if(!cs.length)h+='<div class="achg">no comments</div>';
  cs.forEach(c=>{h+=`<div class="acard"><div class="ah"><span>${esc(c.by)}</span><span>${fd(c.date)}</span></div><div class="atext">${esc(c.text)}</div></div>`;});
  h+='<div class="asec">History ('+hs.length+')</div>';
  if(!hs.length)h+='<div class="achg">no recorded changes</div>';
  hs.forEach(u=>{
    const chg=u.changes.map(c=>`<div class="achg">${esc(c.field)}: ${esc(String(c.from)||'∅')} → <b>${esc(String(c.to)||'∅')}</b></div>`).join('');
    h+=`<div class="acard"><div class="ah"><span>${esc(u.by)}</span><span>${fd(u.date)}</span></div>${chg}</div>`;
  });
  $('s_activity').innerHTML=h;
}
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

/* ---------- create a brand-new item from scratch (no parent required) ---------- */
let _newIterRoot='';                               // sentinel path for "(no sprint)"
async function showNewItem(parentId){
  $('newitem-err').textContent='';
  $('n_title').value='';$('n_prio').value='';assignedNew.set('',/*silent*/true);
  parentNew.set(parentId!=null?String(parentId):'',/*silent*/true);   // render the parent card + close any open picker
  fillTypeSelect('n_type','Task');           // ensure options match the project's real types
  // sprint picker — same source as the editor's; "(no sprint)" = empty value
  try{const iters=await getIterations();_newIterRoot=iters[0]?iters[0].path.split('\\')[0]:(projectName||'');}
  catch(e){/* sprints are optional */}
  sprintNew.set('',/*silent*/true);
  $('newitem-overlay').classList.add('show');
  $('n_title').focus();
}
function closeNewItem(){parentNew.close();assignedNew.close();sprintNew.close();$('newitem-overlay').classList.remove('show');}
async function createNew(){
  const type=$('n_type').value,title=$('n_title').value.trim();
  if(!title){$('newitem-err').textContent='Title is required.';$('n_title').focus();return;}
  const body={type,title};
  const par=parentNew.get();
  if(par!==''){if(!/^\d+$/.test(par)){$('newitem-err').textContent='Parent must be a numeric work-item id.';return;}body.parent=parseInt(par,10);}
  const assigned=$('n_assigned').value.trim();if(assigned)body.assigned=(assigned==='me'?(currentUser||assigned):assigned);
  const prio=$('n_prio').value;if(prio)body.priority=Number(prio);
  const iter=$('n_iter').value;if(iter&&iter!==_newIterRoot)body.iteration=iter;
  const btn=$('n_create');btn.disabled=true;btn.textContent='Creating…';loadStart('creating…');
  let r;try{r=await api.createItem(body);}
  catch(e){if(denyOnForbidden(e,'create work items')){closeNewItem();}else $('newitem-err').textContent='ERROR: '+e.message;btn.disabled=false;btn.textContent='Create';loadEnd();return;}
  btn.disabled=false;btn.textContent='Create';loadEnd();
  if(body.parent!=null)delete store.kids[body.parent];   // parent's child list is now stale
  recordCreateUndo(r.id,body);
  closeNewItem();
  setStatus(`created #${r.id} (${type})`+(body.parent!=null?` under #${body.parent}`:' (top-level)'));
  await refresh();
  openItem(r.id);                                  // jump straight into the new item's editor
}

/* ---------- create / edit a sprint (Board → By Sprint "＋" column; sprint screen "✎") ---------- */
let sprintMode='create',sprintEditPath=null;
function showSprintModal(){                        // create a new sprint
  sprintMode='create';sprintEditPath=null;
  $('sprint-title').textContent='New sprint';
  $('sprint-err').textContent='';
  $('sp_name').readOnly=false;$('sp_name').value='';$('sp_start').value='';$('sp_finish').value='';
  $('sp_create').textContent='Create sprint';
  $('sprint-overlay').classList.add('show');$('sp_name').focus();
}
function showSprintEdit(path){                     // edit an existing sprint's dates
  const it=_sprint(path);if(!it)return;
  sprintMode='edit';sprintEditPath=path;
  $('sprint-title').textContent='Edit sprint dates';
  $('sprint-err').textContent='';
  $('sp_name').readOnly=true;$('sp_name').value=it.name||'';
  $('sp_start').value=(it.start||'').slice(0,10);$('sp_finish').value=(it.finish||'').slice(0,10);
  $('sp_create').textContent='Save dates';
  $('sprint-overlay').classList.add('show');$('sp_start').focus();
}
function closeSprintModal(){$('sprint-overlay').classList.remove('show');pendingSprintItems=null;}
// Re-derive the Sprint filter chips + bulk dropdown from the (refreshed) iteration
// list — otherwise a newly created sprint is missing from the filter.
async function reloadSprintFilter(){
  try{const its=await getIterations();sprintPaths=its.map(i=>i.path);sprintNames={};its.forEach(i=>{sprintNames[i.path]=i.name;});}
  catch(e){/* keep whatever we had */}
  renderFilters();                                 // also rebuilds the bulk Sprint dropdown
}
async function createSprintSubmit(){
  const start=$('sp_start').value,finish=$('sp_finish').value;
  if(start&&finish&&finish<start){$('sprint-err').textContent='Finish date is before the start date.';return;}
  const name=$('sp_name').value.trim();
  if(sprintMode!=='edit'&&!name){$('sprint-err').textContent='Sprint name is required.';$('sp_name').focus();return;}
  const btn=$('sp_create');btn.disabled=true;loadStart(sprintMode==='edit'?'saving sprint…':'creating sprint…');
  try{
    if(sprintMode==='edit'){
      await api.updateSprintDates(sprintEditPath,{start,finish});
      iterCache=null;closeSprintModal();
      await reloadSprintFilter();
      setStatus('sprint dates updated');
      await refresh();                             // re-render board / open sprint with new dates
      if(openSprintPath===sprintEditPath&&$('sprintview').classList.contains('show'))renderSprint(sprintEditPath);
    }else{
      const pend=pendingSprintItems&&pendingSprintItems.slice();   // cards dropped on "＋ New sprint"
      await api.createSprint({name,start,finish});
      iterCache=null;
      const its=await getIterations();                            // refetch (now includes the new sprint) to get its real path
      const made=its.find(it=>it.name===name);
      const newPath=made?made.path:((projectName||'')+'\\'+name);
      newSprints.add(newPath);                                    // keep the new column visible
      let moved=0;
      if(pend&&pend.length){                                      // move the dropped cards into the new sprint
        const olds=pend.map(id=>({id,old:(store.nodes[id]?store.nodes[id].iteration:'')}));
        const res=await api.pool(pend.map(id=>async()=>{try{await api.updateItem(id,{iteration:newPath});if(store.nodes[id])store.nodes[id].iteration=newPath;return true;}catch(e){return false;}}),6);
        moved=res.filter(Boolean).length;
        if(moved)pushAction(`move ${moved} item(s) → ${name}`,
          async()=>{await api.pool(olds.map(o=>async()=>{try{await api.updateItem(o.id,{iteration:(o.old==null?'':o.old)});}catch(e){}}),6);await afterUndo(null);},
          async()=>{await api.pool(pend.map(id=>async()=>{try{await api.updateItem(id,{iteration:newPath});}catch(e){}}),6);await afterUndo(null);});
      }
      closeSprintModal();
      await reloadSprintFilter();                  // new sprint now selectable in the filter
      setStatus(`sprint "${name}" created`+(moved?` · ${moved} item(s) moved in`:''));
      await refresh();
    }
  }catch(e){
    if(/HTTP 403/.test(e.message)){
      closeSprintModal();
      if(sprintMode==='edit'){canEditSprint=false;setStatus("you don't have permission to edit sprint dates",true);
        if(openSprintPath)renderSprint(openSprintPath);}
      else{canCreateSprint=false;setStatus("you don't have permission to create sprints",true);if(mode==='board')renderBoard();}
    }else $('sprint-err').textContent='ERROR: '+e.message;
  }finally{btn.disabled=false;$('sp_create').textContent=sprintMode==='edit'?'Save dates':'Create sprint';loadEnd();}
}

/* ---------- work-item types (sourced from ADO — no hard-coded list) ---------- */
async function loadTypes(){
  let types=[];
  try{types=await api.workItemTypes();}catch(e){types=[];}
  if(types.length){
    typeList=types;
    types.forEach(t=>{if(t.color){TYPE_COLOR[t.name]=t.color;   // canvas graph reads the hex map…
      document.documentElement.style.setProperty(tyVar(t.name),t.color);}});   // …DOM views read the CSS var (live update)
  }else if(!typeList.length){
    typeList=TYPES.map(n=>({name:n,color:TYPE_COLOR[n]||''}));     // offline fallback to the static defaults
  }
  fillTypeSelect('c_type','Task');fillTypeSelect('n_type','Task');
  buildLegend();
  repaintTypes();                                  // colours just changed → repaint so defaults don't linger
}
// DOM views colour via the CSS vars set above, so they update live. Only the
// canvas graph needs a nudge to re-read the hex map after the colours change.
function repaintTypes(){ if(mode==='graph'&&cy)cy.style().update(); }
// (Re)populate a type <select> from the loaded types, keeping the current
// choice if it's still valid, else falling back to `preferred` then the first.
function fillTypeSelect(id,preferred){
  const sel=$(id);if(!sel)return;
  const names=typeNames(),prev=sel.value;
  sel.innerHTML='';names.forEach(n=>sel.appendChild(new Option(n,n)));
  sel.value=names.includes(prev)?prev:(names.includes(preferred)?preferred:(names[0]||''));
}

function buildLegend(){$('legend').innerHTML=typeNames().map(k=>`<span><i style="background:${tyColor(k)}"></i>${esc(k)}</span>`).join('');}

/* ---------- export the current (filtered) view ---------- */
const EXPORT_COLS=['id','type','title','state','assigned','priority','iteration','parent','start','target','est','tags'];
function exportRows(){return store.roots.map(id=>store.nodes[id]).filter(Boolean);}
function downloadFile(name,mime,text){
  const url=URL.createObjectURL(new Blob([text],{type:mime}));
  const a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function exportView(kind){
  const rows=exportRows();
  if(!rows.length){setStatus('nothing to export',true);return;}
  if(kind==='json'){
    downloadFile('ado-atlas-export.json','application/json',JSON.stringify(rows.map(n=>{const o={};EXPORT_COLS.forEach(k=>o[k]=n[k]);return o;}),null,2));
  }else{
    const cell=v=>{v=(v==null?'':String(v));return /[",\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v;};
    const csv=[EXPORT_COLS.join(',')].concat(rows.map(n=>EXPORT_COLS.map(k=>cell(n[k])).join(','))).join('\r\n');
    downloadFile('ado-atlas-export.csv','text/csv;charset=utf-8','﻿'+csv);   // BOM so Excel reads UTF-8
  }
  setStatus('exported '+rows.length+' item(s) to '+kind.toUpperCase());
}

/* ---------- theme (dark / light / auto-follow-system) + auto-refresh ---------- */
function systemDark(){try{return !window.matchMedia||window.matchMedia('(prefers-color-scheme: dark)').matches;}catch(e){return true;}}
function applyTheme(mode){
  const light=mode==='light'||(mode==='auto'&&!systemDark());
  document.body.classList.toggle('light',light);
  $('theme').title='theme: '+mode+(mode==='auto'?' (follows system)':'')+' — click to change';
  const tl=$('theme_label');if(tl)tl.textContent=mode;
  if(cy)cy.style().update();                        // re-evaluate theme-aware graph styles (parent label colour)
}
function cycleTheme(){
  let m=localStorage.getItem('ado.theme')||'dark';
  m=m==='dark'?'light':(m==='light'?'auto':'dark');
  try{localStorage.setItem('ado.theme',m);}catch(e){}
  applyTheme(m);
}
let autoTimer=null;
function autoTick(){
  updatePatBadge();                          // keep the countdown fresh on long-lived tabs
  if(document.hidden||pdrag||boardBusy)return;   // don't refetch hidden, or yank the board mid-drag
  if(cur!=null&&dirty())return;              // don't disrupt unsaved editor changes
  refresh();
}
function setAutoRefresh(sec){
  if(autoTimer){clearInterval(autoTimer);autoTimer=null;}
  sec=parseInt(sec,10)||0;
  if(sec>0)autoTimer=setInterval(autoTick,sec*1000);
}
function switchMode(m){setMode(m);try{localStorage.setItem('ado.mode',m);}catch(e){}
  if(m==='graph')renderGraph({fit:true});else if(m==='board')renderBoard();else if(m==='timeline')renderTimeline();else renderTree();}

/* ---------- last-snapshot cache (instant first paint) ---------- */
async function snapKey(){try{const c=await api.getConfig();return (c.org&&c.project)?('snap:'+c.org+'/'+c.project):null;}catch(e){return null;}}
async function saveSnapshot(){
  try{
    if(store.roots.length>1500||Object.keys(store.nodes).length>4000)return;   // skip very large views
    const key=await snapKey();if(!key)return;
    await chrome.storage.local.set({[key]:{roots:store.roots,top:store.top||store.roots,nodes:store.nodes,kids:store.kids,expanded:[...store.expanded],ts:Date.now()}});
  }catch(e){/* cache is best-effort */}
}
async function loadSnapshot(){
  try{
    const key=await snapKey();if(!key)return false;
    const r=await chrome.storage.local.get([key]);const d=r[key];
    if(!d||!d.roots||!d.roots.length)return false;
    if(d.ts&&(Date.now()-d.ts)>86400000)return false;   // ignore snapshots older than 24h
    store.nodes=d.nodes||{};store.roots=d.roots;store.top=d.top||d.roots;store.kids=d.kids||{};store.expanded=new Set(d.expanded||[]);
    renderTree();                              // instant tree from the cached snapshot
    const age=Math.round((Date.now()-(d.ts||Date.now()))/60000);
    setStatus(store.roots.length+' item(s) · cached'+(age>0?(' '+age+'m ago'):'')+' — refreshing…');
    return true;
  }catch(e){return false;}
}

/* ---------- command palette (Ctrl/Cmd+K) ---------- */
let palItems=[],palIdx=0;
const PALETTE_ACTIONS=[
  {kind:'cmd',title:'New work item',run:()=>showNewItem()},
  {kind:'cmd',title:'Undo last change (Ctrl/Cmd+Z)',run:()=>runUndo()},
  {kind:'cmd',title:'Redo (Ctrl/Cmd+Shift+Z)',run:()=>runRedo()},
  {kind:'cmd',title:'Refresh list',run:()=>refresh()},
  {kind:'cmd',title:'View: Tree',run:()=>switchMode('tree')},
  {kind:'cmd',title:'View: Graph',run:()=>switchMode('graph')},
  {kind:'cmd',title:'View: Board',run:()=>switchMode('board')},
  {kind:'cmd',title:'Export CSV',run:()=>exportView('csv')},
  {kind:'cmd',title:'Export JSON',run:()=>exportView('json')},
  {kind:'cmd',title:'Toggle theme',run:()=>cycleTheme()},
  {kind:'cmd',title:'Open settings',run:()=>showSetup(true)},
  {kind:'cmd',title:'Clear bulk selection',run:()=>clearBulk()},
];
function openPalette(){$('palette').classList.add('show');const i=$('palette-input');i.value='';renderPalette('');i.focus();}
function closePalette(){$('palette').classList.remove('show');}
function paletteMatches(q){
  q=(q||'').trim().toLowerCase();
  const toks=q.split(/\s+/).filter(Boolean),out=[];
  if(/^#?\d+$/.test(q)){const id=parseInt(q.replace('#',''),10);out.push({kind:'open',title:'Open #'+id,run:()=>openItem(id)});}
  if(toks.length){                         // only match items once the user has typed something
    let n=0;
    for(const node of Object.values(store.nodes)){
      const hay=('#'+node.id+' '+(node.title||'')).toLowerCase();
      if(toks.every(t=>hay.includes(t))){out.push({kind:node.type||'item',title:`#${node.id} ${node.title||''}`,state:node.state,run:()=>openItem(node.id)});if(++n>=40)break;}
    }
  }
  for(const a of PALETTE_ACTIONS){if(!toks.length||toks.every(t=>a.title.toLowerCase().includes(t)))out.push(a);}
  return out.slice(0,50);
}
function renderPalette(q){palItems=paletteMatches(q);palIdx=0;drawPalette();}
function drawPalette(){
  const list=$('palette-list');
  if(!palItems.length){list.innerHTML='<div class="prow"><span class="ptitle" style="color:var(--muted)">no matches</span></div>';return;}
  list.innerHTML=palItems.map((it,i)=>{
    const badge=it.state?`<span class="pbadge" style="background:${stateColor(it.state)}">${esc(it.state)}</span>`:'';
    return `<div class="prow${i===palIdx?' on':''}" data-i="${i}"><span class="pkind">${esc(it.kind)}</span><span class="ptitle">${esc(it.title)}</span>${badge}</div>`;
  }).join('');
  list.querySelectorAll('.prow[data-i]').forEach(r=>{
    r.onclick=()=>{palIdx=+r.dataset.i;runPalette();};
    r.onmousemove=()=>{if(palIdx!==+r.dataset.i){palIdx=+r.dataset.i;highlightPalette();}};
  });
}
function highlightPalette(){$('palette-list').querySelectorAll('.prow[data-i]').forEach(r=>r.classList.toggle('on',+r.dataset.i===palIdx));}
function movePalette(d){if(!palItems.length)return;palIdx=(palIdx+d+palItems.length)%palItems.length;highlightPalette();
  const el=$('palette-list').querySelector('.prow.on');if(el)el.scrollIntoView({block:'nearest'});}
function runPalette(){const it=palItems[palIdx];if(!it)return;closePalette();try{it.run();}catch(e){setStatus('ERROR: '+e.message,true);}}

/* ---------- setup modal (replaces /setup page) ---------- */
let setupAuthMode='pat';                 // which auth pane is active in the setup modal
function setAuthPane(mode){
  setupAuthMode=(mode==='oauth')?'oauth':'pat';
  $('auth-pat').style.display=setupAuthMode==='pat'?'block':'none';
  $('auth-oauth').style.display=setupAuthMode==='oauth'?'block':'none';
  $('auth-mode').querySelectorAll('button').forEach(b=>b.classList.toggle('on',b.dataset.am===setupAuthMode));
}
function oauthTenantValue(){   // resolve the tenant dropdown (preset name or the custom GUID)
  const m=$('oauth-tenant-mode').value;
  return m==='custom'?$('oauth-tenant-id').value.trim():m;
}
function updateTenantField(){
  $('oauth-tenant-id').style.display=$('oauth-tenant-mode').value==='custom'?'block':'none';
}
async function doOauthSignIn(){
  const cid=$('oauth-client').value.trim(),tenant=oauthTenantValue();
  if(!cid){$('oauth-status').textContent='Enter the Application (client) ID first.';return;}
  const btn=$('oauth-signin');btn.disabled=true;btn.textContent='Signing in…';$('setup-err').textContent='';$('oauth-status').textContent='';
  try{
    const name=await api.oauthSignIn(cid,tenant);
    currentUser=name||'';
    $('oauth-status').textContent=name?('✓ Signed in as '+name):'✓ Signed in';
    await loadSetupOrgs();                // populate org/project from the signed-in account
  }catch(e){
    $('oauth-status').textContent='Sign-in failed: '+e.message;
  }finally{ btn.disabled=false;btn.textContent='Sign in with Microsoft'; }
}
function showSetup(cancellable){
  $('setup-load-hint').innerHTML=SETUP_HINT;
  try{$('oauth-redirect').value=api.oauthRedirectUri();}catch(e){$('oauth-redirect').value='(available once the extension is loaded)';}
  const cfg=api.getConfig();   // promise — fill async
  cfg.then(c=>{
    $('setup-pat').value=c.pat||'';$('setup-org').value=c.org||'';$('setup-project').value=c.project||'';
    $('setup-expiry').value=c.patExpiry||'';updateSetupExpiryInfo();
    $('oauth-client').value=c.oauthClientId||'';
    const t=c.oauthTenant||'organizations';
    if(t==='organizations'){$('oauth-tenant-mode').value='organizations';$('oauth-tenant-id').value='';}
    else{$('oauth-tenant-mode').value='custom';$('oauth-tenant-id').value=t;}
    updateTenantField();
    setAuthPane(c.authMode==='oauth'?'oauth':'pat');
    $('oauth-status').textContent=(c.authMode==='oauth'&&c.oauthAccess)?(currentUser?('✓ Signed in as '+currentUser):'✓ Signed in'):'';
    const signedIn=(c.authMode==='oauth')?!!c.oauthAccess:!!c.pat;
    if(c.org&&signedIn)loadSetupProjects();   // reopening settings: populate the project dropdown for the saved org
  });
  $('setup-err').textContent='';
  $('setup-cancel').style.display=cancellable?'inline-block':'none';
  $('setup-overlay').classList.add('show');
}
function hideSetup(){$('setup-overlay').classList.remove('show');}

// api.js dispatches 'ado-401' on any HTTP 401 — the PAT expired or was revoked
// mid-session. Reopen setup with a clear message instead of spraying errors.
function handle401(){
  if($('setup-overlay').classList.contains('show'))return;   // already prompting — don't stack
  showSetup(true);
  $('setup-err').textContent='Authentication failed (HTTP 401) — your token/session is invalid. Re-connect below'
    +((cur!=null&&dirty())?(' (your unsaved changes to #'+cur+' are preserved).'):'.');
}
// One-time nudge when the recorded PAT expiry is within 3 days (or already past).
async function warnIfPatExpiring(){
  let exp='';try{exp=(await api.getConfig()).patExpiry||'';}catch(e){}
  const n=patDaysLeft(exp);
  if(n===null||n>3)return;
  setStatus(n<0?`⚠ PAT expired ${-n} day(s) ago — update it via ⚙`
               :(n===0?'⚠ PAT expires today — update it via ⚙':`⚠ PAT expires in ${n} day(s) — update it via ⚙`),true);
}

/* ---------- setup picker: list the orgs / projects a PAT can access ----------
   Lets the user CHOOSE an org/project after pasting a PAT instead of typing.
   Both calls can legitimately fail for a narrowly-scoped PAT, so the inputs
   stay free-text and we just fall back to manual entry on error. */
const SETUP_HINT='Paste a PAT, then fill in your Organization and Project (both are in your dev.azure.com/&lt;org&gt;/&lt;project&gt; URL). The project list fills in automatically once the org is set.';
let patAutoTimer=null;   // debounce for auto-loading org/project after a PAT is pasted
function fillDatalist(id,items){
  const dl=$(id);if(!dl)return;
  dl.innerHTML=(items||[]).map(v=>`<option value="${String(v).replace(/"/g,'&quot;')}"></option>`).join('');
}
let _loadingOrgs=false;
async function loadSetupOrgs(){
  if(setupAuthMode==='pat'&&!$('setup-pat').value.trim()){$('setup-err').textContent='Paste a PAT first.';return;}
  if(_loadingOrgs)return;_loadingOrgs=true;
  const btn=$('setup-load');if(btn){btn.disabled=true;btn.textContent='Loading…';}$('setup-err').textContent='';
  try{
    if(setupAuthMode==='pat')await api.setConfig({authMode:'pat',pat:$('setup-pat').value.trim()});   // persist so the API can authenticate
    const list=await api.orgs();
    fillDatalist('setup-orglist',list);
    if(list.length){
      $('setup-load-hint').textContent=`Found ${list.length} organization(s) — pick one, then choose a project.`;
      if(!$('setup-org').value.trim()&&list.length===1)$('setup-org').value=list[0];   // single org → preselect
      if($('setup-org').value.trim())await loadSetupProjects();
    }else{
      $('setup-load-hint').textContent='No organizations returned for this PAT — type the org name manually.';
    }
  }catch(e){
    $('setup-load-hint').textContent='Could not list organizations ('+e.message+') — type the org and project manually.';
  }finally{
    if(btn){btn.disabled=false;btn.textContent='Load';}_loadingOrgs=false;
  }
}
async function loadSetupProjects(){
  const org=$('setup-org').value.trim();
  if(!org)return;
  try{
    const list=await api.projects(org);
    fillDatalist('setup-projlist',list);
    if(list.length&&!$('setup-project').value.trim())$('setup-project').value=list[0];   // prefill the first project if none chosen yet
  }catch(e){/* project dropdown is optional — manual entry still works */}
}

/* ---------- PAT validity countdown ----------
   ADO can't tell a PAT-authenticated request when the PAT expires (the Token
   Lifecycle API needs an Entra token), so the user optionally records the
   expiry date and we count down from it. */
function patDaysLeft(expiry){return AdoLib.patDaysLeft(expiry);}   // pure logic in lib.js
function patDaysLabel(n){return n>=60?(Math.round(n/30)+'mo'):(n+'d');}
async function updateProjectBadge(){
  const el=$('projbadge');if(!el)return;
  let org='',project='';
  try{const c=await api.getConfig();org=c.org||'';project=c.project||'';}catch(e){}
  if(!project){el.style.display='none';return;}
  el.style.display='inline-flex';
  el.innerHTML=(org?`<span class="pb-org">${esc(org)}</span><span class="pb-sep">/</span>`:'')+`<span class="pb-proj">${esc(project)}</span>`;
  el.title=`Current project: ${org?org+' / ':''}${project} — click to switch`;
}
async function updatePatBadge(){
  const el=$('patbadge');if(!el)return;
  let exp='';try{exp=(await api.getConfig()).patExpiry||'';}catch(e){}
  const n=patDaysLeft(exp);
  el.classList.remove('patok','patwarn','patbad');
  if(n===null){el.style.display='none';el.textContent='';el.title='';return;}
  el.style.display='inline-block';
  let cls,text,tip;
  if(n<0){cls='patbad';text='PAT expired';tip=`Personal Access Token expired ${-n} day(s) ago (${exp}).`;}
  else if(n===0){cls='patbad';text='PAT: today';tip=`Personal Access Token expires today (${exp}).`;}
  else{cls=n<=3?'patbad':(n<=14?'patwarn':'patok');text='PAT: '+patDaysLabel(n);tip=`Personal Access Token valid for ${n} day(s) (until ${exp}).`;}
  el.textContent=text;el.classList.add(cls);el.title=tip+' Click to update.';
}
function updateSetupExpiryInfo(){
  const t=$('setup-expiry-info');if(!t)return;
  const n=patDaysLeft($('setup-expiry').value);
  t.textContent=n===null?'':(n<0?`expired ${-n} day(s) ago`:(n===0?'expires today':`${n} day(s) left`));
}

async function saveSetup(){
  const org=$('setup-org').value.trim();
  const project=$('setup-project').value.trim();
  if(!org){$('setup-err').textContent='Organization is required.';return;}
  if(!project){$('setup-err').textContent='Project is required.';return;}
  if(setupAuthMode==='pat'&&!$('setup-pat').value.trim()){$('setup-err').textContent='PAT is required.';return;}
  if(setupAuthMode==='oauth'){
    const c=await api.getConfig();
    if(!c.oauthAccess&&!c.oauthRefresh){$('setup-err').textContent='Sign in with Microsoft first.';return;}
  }
  const btn=$('setup-save');btn.disabled=true;btn.textContent='Validating…';
  $('setup-err').textContent='';
  try{
    // Persist first so api.me() picks up the new values; if it fails we surface a
    // clear error and let the user fix things instead of leaving stale state.
    if(setupAuthMode==='oauth')await api.setConfig({authMode:'oauth',org,project});
    else await api.setConfig({authMode:'pat',pat:$('setup-pat').value.trim(),org,project,patExpiry:$('setup-expiry').value});
    const name=await api.me();
    if(!name)throw new Error('authentication failed (no display name returned)');
    currentUser=name;projectName=project;
    updatePatBadge();
    hideSetup();
    btn.disabled=false;btn.textContent='Save & Connect';
    await initialBoot(/*postSetup*/true);
  }catch(e){
    $('setup-err').textContent='Connection failed: '+e.message;
    btn.disabled=false;btn.textContent='Save & Connect';
  }
}

/* ---------- one-time wiring done before the PAT exists ---------- */
function wireSetup(){
  window.addEventListener('ado-401',handle401);   // PAT expired/revoked mid-session → reopen setup
  $('setup-save').onclick=saveSetup;
  $('setup-pat').addEventListener('input',()=>{   // after a PAT is pasted: persist it and (if an org is set) auto-list its projects
    clearTimeout(patAutoTimer);
    patAutoTimer=setTimeout(async()=>{
      if(setupAuthMode!=='pat')return;
      const pat=$('setup-pat').value.trim();if(!pat)return;
      try{await api.setConfig({authMode:'pat',pat});}catch(e){}
      if($('setup-org').value.trim())loadSetupProjects();   // dev.azure.com endpoint — no sign-in redirect
    },700);
  });
  $('setup-org').addEventListener('change',loadSetupProjects);   // org chosen → fetch its projects
  $('setup-expiry').addEventListener('change',updateSetupExpiryInfo);
  $('setup-expiry').addEventListener('input',updateSetupExpiryInfo);
  $('auth-mode').querySelectorAll('button').forEach(b=>b.onclick=()=>setAuthPane(b.dataset.am));
  $('oauth-signin').onclick=doOauthSignIn;
  $('oauth-tenant-mode').onchange=updateTenantField;
  $('oauth-copy').onclick=()=>{const i=$('oauth-redirect');try{navigator.clipboard.writeText(i.value);$('oauth-copy').textContent='copied';setTimeout(()=>{$('oauth-copy').textContent='copy';},1200);}catch(e){if(i.select)i.select();}};
  $('setup-cancel').onclick=hideSetup;
  $('settingsbtn').onclick=()=>{const mp=$('morepanel');if(mp){mp.style.display='none';$('morebtn').classList.remove('on');}showSetup(true);};
  $('patbadge').onclick=()=>showSetup(true);
  $('projbadge').onclick=()=>showSetup(true);
}

/* ---------- toolbar customization: reorder + show/hide, persisted ---------- */
const BAR_ITEMS=[
  {id:'projbadge',label:'Project badge'},
  {id:'newbtn',label:'New item'},
  {id:'undobtn',label:'Undo'},
  {id:'redobtn',label:'Redo'},
  {id:'mode',label:'View mode (Tree / Graph / Board / Timeline)'},
  {id:'emode',label:'Graph: edges (Hier / Deps)'},
  {id:'dir',label:'Graph: direction'},
  {id:'grp',label:'Board: grouping'},
  {id:'tlzoom',label:'Timeline: zoom'},
  {id:'tl_group',label:'Timeline: grouping'},
  {id:'empty_btn',label:'Empty-columns toggle (∅)'},
  {id:'filt_btn',label:'Filters'},
  {id:'fit',label:'Fit graph'},
  {id:'bar-spacer',label:'↔ Right-align spacer (flexible gap)'},
  {id:'export',label:'Export (CSV / JSON)'},
  {id:'patbadge',label:'PAT badge'},
  {id:'legend',label:'Type legend'},
  {id:'settings-wrap',label:'Settings menu (⚙)'},
];
const BAR_LOCKED=new Set(['settings-wrap','bar-spacer']);   // never hidden (settings = entry point; spacer = right-align anchor)
let barOrder=BAR_ITEMS.map(i=>i.id), barHidden=new Set();
// Work-item sidebar groups — same reorder + show/hide pattern as the toolbar.
// Each id matches a <div class="sgroup" data-sg="..."> wrapper in #side.
const SIDE_GROUPS=[
  {id:'nav',     label:'Hierarchy nav (↑ parent · ↓ children)'},
  {id:'title',   label:'Title'},
  {id:'workflow',label:'State · Priority · Assignee'},
  {id:'sprint',  label:'Sprint'},
  {id:'parent',  label:'Parent'},
  {id:'deps',    label:'Dependencies (blocked by · blocks)'},
  {id:'schedule',label:'Schedule (Start · Target · Due · Estimate · time in state)'},
  {id:'tags',    label:'Tags'},
  {id:'desc',    label:'Description'},
  {id:'ac',      label:'Acceptance Criteria'},
  {id:'actions', label:'Actions row + activity / comment / child forms'},
];
const SIDE_LOCKED=new Set(['title','actions']);    // editor unusable without these
let sideOrder=SIDE_GROUPS.map(g=>g.id), sideHidden=new Set();
function loadSideLayout(){
  try{const o=JSON.parse(localStorage.getItem('ado.sideOrder')||'null');if(Array.isArray(o))sideOrder=o;}catch(e){}
  try{const h=JSON.parse(localStorage.getItem('ado.sideHidden')||'null');if(Array.isArray(h))sideHidden=new Set(h.filter(id=>!SIDE_LOCKED.has(id)));}catch(e){}
}
function saveSideLayout(){try{localStorage.setItem('ado.sideOrder',JSON.stringify(sideOrder));localStorage.setItem('ado.sideHidden',JSON.stringify([...sideHidden]));}catch(e){}}
function sideOrderedIds(){     // same recovery as barOrderedIds — re-insert missing ids near their defaults
  const def=SIDE_GROUPS.map(g=>g.id),defSet=new Set(def);
  const result=sideOrder.filter((id,i)=>defSet.has(id)&&sideOrder.indexOf(id)===i);
  def.forEach((id,i)=>{
    if(result.includes(id))return;
    let at=result.length;
    for(let j=i-1;j>=0;j--){const k=result.indexOf(def[j]);if(k>=0){at=k+1;break;}}
    result.splice(at,0,id);
  });
  return result;
}
function applySideLayout(){
  const side=$('side');if(!side)return;
  sideOrderedIds().forEach(id=>{const el=side.querySelector(`.sgroup[data-sg="${id}"]`);if(el)side.appendChild(el);});
  SIDE_GROUPS.forEach(g=>{const el=side.querySelector(`.sgroup[data-sg="${g.id}"]`);if(el)el.classList.toggle('sg-hidden',sideHidden.has(g.id));});
}
function loadBarLayout(){
  try{const o=JSON.parse(localStorage.getItem('ado.barOrder')||'null');if(Array.isArray(o))barOrder=o;}catch(e){}
  try{const h=JSON.parse(localStorage.getItem('ado.barHidden')||'null');if(Array.isArray(h))barHidden=new Set(h.filter(id=>!BAR_LOCKED.has(id)));}catch(e){}
}
function saveBarLayout(){try{localStorage.setItem('ado.barOrder',JSON.stringify(barOrder));localStorage.setItem('ado.barHidden',JSON.stringify([...barHidden]));}catch(e){}}
// Ordered id list = the saved order, with any default id missing from it (new in
// a later version) re-inserted near its default neighbours rather than dumped at
// the end — so e.g. the spacer lands in the right place for pre-existing layouts.
function barOrderedIds(){
  const def=BAR_ITEMS.map(i=>i.id),defSet=new Set(def);
  const result=barOrder.filter((id,i)=>defSet.has(id)&&barOrder.indexOf(id)===i);
  def.forEach((id,i)=>{
    if(result.includes(id))return;
    let at=result.length;
    for(let j=i-1;j>=0;j--){const k=result.indexOf(def[j]);if(k>=0){at=k+1;break;}}
    result.splice(at,0,id);
  });
  return result;
}
function applyBarLayout(){
  const bar=$('bar');if(!bar)return;
  barOrderedIds().forEach(id=>{const el=$(id);if(el)bar.appendChild(el);});   // reorder (h1 isn't listed → stays first)
  BAR_ITEMS.forEach(i=>{const el=$(i.id);if(el)el.classList.toggle('tb-hidden',barHidden.has(i.id));});
}
let czTab='bar';                                           // 'bar' | 'side' — which list the Customize dialog is editing
function showCustomize(){const mp=$('morepanel');if(mp){mp.style.display='none';$('morebtn').classList.remove('on');}
  renderCustomizeList();$('customize-overlay').classList.add('show');}
function closeCustomize(){$('customize-overlay').classList.remove('show');}
function resetCustomize(){       // reset only the currently-active tab to defaults
  if(czTab==='side'){sideOrder=SIDE_GROUPS.map(g=>g.id);sideHidden=new Set();saveSideLayout();applySideLayout();}
  else{barOrder=BAR_ITEMS.map(i=>i.id);barHidden=new Set();saveBarLayout();applyBarLayout();}
  renderCustomizeList();
}
function setCustomizeTab(t){czTab=t;
  $('cz_tabs').querySelectorAll('button').forEach(b=>b.classList.toggle('on',b.dataset.cz===t));
  $('cz_title').textContent=t==='side'?'Customize work item panel':'Customize toolbar';
  renderCustomizeList();
}
function renderCustomizeList(){
  const list=$('customize-list');
  const cfg=czTab==='side'
    ? {items:SIDE_GROUPS,locked:SIDE_LOCKED,orderedIds:sideOrderedIds,save:saveSideLayout,apply:applySideLayout,setOrder:o=>{sideOrder=o;},isHidden:id=>sideHidden.has(id),hide:id=>sideHidden.add(id),show:id=>sideHidden.delete(id)}
    : {items:BAR_ITEMS,  locked:BAR_LOCKED, orderedIds:barOrderedIds, save:saveBarLayout, apply:applyBarLayout, setOrder:o=>{barOrder=o;}, isHidden:id=>barHidden.has(id), hide:id=>barHidden.add(id), show:id=>barHidden.delete(id)};
  const byId=Object.fromEntries(cfg.items.map(i=>[i.id,i.label]));
  list.innerHTML=cfg.orderedIds().map(id=>{
    const locked=cfg.locked.has(id),checked=!cfg.isHidden(id);
    return `<div class="czrow" draggable="true" data-id="${id}"><span class="czgrip" title="drag to reorder">⠿</span>`+
      `<label class="czlab"><input type="checkbox" ${checked?'checked':''} ${locked?'disabled':''} data-id="${id}">${esc(byId[id])}</label></div>`;
  }).join('');
  list.querySelectorAll('input[type=checkbox]').forEach(cb=>cb.onchange=()=>{
    const id=cb.dataset.id;if(cb.checked)cfg.show(id);else cfg.hide(id);cfg.save();cfg.apply();});
  let dragging=null;
  list.querySelectorAll('.czrow').forEach(row=>{
    row.addEventListener('dragstart',()=>{dragging=row;setTimeout(()=>row.classList.add('dragging'),0);});
    row.addEventListener('dragend',()=>{row.classList.remove('dragging');dragging=null;
      cfg.setOrder([...list.querySelectorAll('.czrow')].map(r=>r.dataset.id));cfg.save();cfg.apply();});});
  list.ondragover=e=>{e.preventDefault();if(!dragging)return;
    const rows=[...list.querySelectorAll('.czrow:not(.dragging)')];
    const after=rows.find(r=>{const b=r.getBoundingClientRect();return e.clientY<b.top+b.height/2;});
    if(after)list.insertBefore(dragging,after);else list.appendChild(dragging);};
}

/* ---------- main init (runs after PAT is verified) ---------- */
let _booted=false;
async function initialBoot(postSetup){
  updateProjectBadge();                  // reflect the active org/project in the title bar
  if(_booted){                           // settings re-save: just reload data
    iterCache=null;depCache={};assignees=[];projectStates=[];tagList=[];sprintPaths=[];sprintNames={};typeList=[];undoStack.length=0;redoStack.length=0;canCreateSprint=true;canEditSprint=true;canCreateItem=true;newSprints.clear();
    updateUndoButtons();updateCreateButtons();
    await loadIdentity();await refresh();warnIfPatExpiring();return;
  }
  _booted=true;

  fillTypeSelect('c_type','Task');fillTypeSelect('n_type','Task');   // seed with fallback now; loadTypes() refills from ADO
  // switching view is render-only (no API): graph draws from the store, tree DOM persists
  $('mode').querySelectorAll('button').forEach(b=>b.onclick=()=>switchMode(b.dataset.m));
  $('emode').querySelectorAll('button').forEach(b=>b.onclick=()=>{edgeMode=b.dataset.e;$('emode').querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===b));depHandleHide();renderGraph();});
  $('dir').querySelectorAll('button').forEach(b=>b.onclick=()=>{rankDir=b.dataset.d;$('dir').querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===b));try{localStorage.setItem('ado.rankDir',rankDir);}catch(e){}renderGraph({relayout:true,fit:true});});
  $('f_sort').onchange=()=>{try{localStorage.setItem('ado.sort',$('f_sort').value);}catch(e){}refresh();};
  for(let o=-12;o<=14;o++)$('f_tz').appendChild(new Option('UTC'+(o>=0?'+':'')+o,o));
  {const s=localStorage.getItem('ado.tz');if(s!==null&&s!=='')tzOffset=parseInt(s);}
  $('f_tz').value=tzOffset;
  $('f_tz').onchange=()=>{tzOffset=parseInt($('f_tz').value);try{localStorage.setItem('ado.tz',tzOffset);}catch(e){}if(mode==='board')renderBoard();if(cur!=null)loadTimeline(cur);};
  // working-hours window for the active-time calc (defaults 9–17)
  {let ws=9,we=17;const wh=localStorage.getItem('ado.workHours');
    if(wh&&/^\d+-\d+$/.test(wh)){const m=wh.split('-');ws=+m[0];we=+m[1];}
    const r=api.setWorkHours(ws,we);$('f_wh_start').value=r.start;$('f_wh_end').value=r.end;}
  const applyWH=()=>{const r=api.setWorkHours($('f_wh_start').value,$('f_wh_end').value);
    $('f_wh_start').value=r.start;$('f_wh_end').value=r.end;
    try{localStorage.setItem('ado.workHours',r.start+'-'+r.end);}catch(e){}
    if(mode==='board')renderBoard();if(cur!=null)loadTimeline(cur);};
  $('f_wh_start').onchange=applyWH;$('f_wh_end').onchange=applyWH;
  $('empty_btn').onclick=()=>{const on=$('board').classList.toggle('showempty');$('empty_btn').classList.toggle('on',on);try{localStorage.setItem('ado.showEmpty',on?'1':'0');}catch(e){}
    if(mode==='board'&&boardGroup!=='sprint')renderBoard();};   // state/assignee add/remove empty columns in JS (sprints are CSS-only)
  $('grp').querySelectorAll('button').forEach(b=>b.onclick=()=>{boardGroup=b.dataset.g;$('grp').querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===b));try{localStorage.setItem('ado.boardGroup',boardGroup);}catch(e){}renderBoard();});
  // timeline: zoom segment, group select, row click → editor
  $('tlzoom').querySelectorAll('button').forEach(b=>b.onclick=()=>{tlZoom=b.dataset.z;$('tlzoom').querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===b));try{localStorage.setItem('ado.tlZoom',tlZoom);}catch(e){}renderTimeline();});
  $('tl_group').onchange=()=>{tlGroup=$('tl_group').value;try{localStorage.setItem('ado.tlGroup',tlGroup);}catch(e){}renderTimeline();};
  $('timeline').addEventListener('click',e=>{const r=e.target.closest&&e.target.closest('.tlrow[data-id]');if(!r)return;
    const id=+r.dataset.id;
    if(e.ctrlKey||e.metaKey){e.preventDefault();bulkToggle(id);return;}        // Ctrl/Cmd: toggle in selection
    if(e.shiftKey){e.preventDefault();bulkRange(id);return;}                    // Shift: range from anchor
    openItem(id);});
  $('filt_btn').onclick=()=>{const p=$('filterpanel');const show=p.style.display==='none';p.style.display=show?'flex':'none';$('filt_btn').classList.toggle('on',show);};
  // overflow "⋯" display-options popover — toggle + dismiss on outside click / Esc
  const moreP=$('morepanel'),moreB=$('morebtn');
  const closeMore=()=>{moreP.style.display='none';moreB.classList.remove('on');};
  moreB.onclick=e=>{e.stopPropagation();const show=moreP.style.display==='none';moreP.style.display=show?'flex':'none';moreB.classList.toggle('on',show);};
  document.addEventListener('mousedown',e=>{if(moreP.style.display!=='none'&&!moreP.contains(e.target)&&e.target!==moreB)closeMore();});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&moreP.style.display!=='none')closeMore();});
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
  // The ⚙ Badges trigger is now part of the Controls panel header (wired in renderViewHelp);
  // here we just handle outside-click dismissal of the popover.
  document.addEventListener('mousedown',e=>{
    const p=$('badgepanel');if(p.style.display==='none')return;
    const gb=$('vhbadge');if(!p.contains(e.target)&&e.target!==gb&&(!gb||!gb.contains(e.target)))p.style.display='none';});
  $('theme').onclick=cycleTheme;
  try{window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change',()=>{if((localStorage.getItem('ado.theme')||'dark')==='auto')applyTheme('auto');});}catch(e){}
  $('export').querySelectorAll('button').forEach(b=>b.onclick=()=>exportView(b.dataset.x));
  $('f_auto').onchange=()=>{const s=$('f_auto').value;try{localStorage.setItem('ado.auto',s);}catch(e){}setAutoRefresh(s);};
  // bulk action bar (tree multi-select)
  $('bulk_state').onchange=e=>{const v=e.target.value;e.target.value='';if(v)bulkApply('state',v);};
  $('bulk_iter').onchange=e=>{const v=e.target.value;e.target.value='';if(v)bulkApply('iteration',v);};
  $('bulk_prio').onchange=e=>{const v=e.target.value;e.target.value='';if(v)bulkApply('priority',v);};
  $('bulk_assign_btn').onclick=()=>{const v=$('bulk_assigned').value.trim();if(v){bulkApply('assigned',v);$('bulk_assigned').value='';}};
  $('bulk_clear').onclick=clearBulk;
  // command palette (Ctrl/Cmd+K)
  document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.code==='KeyK'&&!e.altKey){e.preventDefault();
    $('palette').classList.contains('show')?closePalette():openPalette();}});
  // undo / redo — keyed on e.code (physical key), so it works on non-Latin
  // keyboard layouts; native text-undo wins inside fields.
  document.addEventListener('keydown',e=>{
    if(!(e.ctrlKey||e.metaKey)||e.altKey)return;
    const isZ=e.code==='KeyZ',isY=e.code==='KeyY';
    if(!isZ&&!isY)return;
    const t=e.target,tag=t&&t.tagName;
    if(tag==='INPUT'||tag==='TEXTAREA'||tag==='SELECT'||(t&&t.isContentEditable))return;
    if($('setup-overlay').classList.contains('show')||$('newitem-overlay').classList.contains('show')||$('sprint-overlay').classList.contains('show')||$('palette').classList.contains('show'))return;
    e.preventDefault();
    if(isY||(isZ&&e.shiftKey))runRedo();else runUndo();});
  // plain "N" opens the new-item modal — only when not typing and no modal/palette is up
  document.addEventListener('keydown',e=>{
    if(e.code!=='KeyN'||e.ctrlKey||e.metaKey||e.altKey||!canCreateItem)return;
    const t=e.target,tag=t&&t.tagName;
    if(tag==='INPUT'||tag==='TEXTAREA'||tag==='SELECT'||(t&&t.isContentEditable))return;
    if($('palette').classList.contains('show')||$('setup-overlay').classList.contains('show')||$('newitem-overlay').classList.contains('show'))return;
    e.preventDefault();showNewItem();});
  $('palette-input').addEventListener('input',e=>renderPalette(e.target.value));
  $('palette-input').addEventListener('keydown',e=>{
    if(e.key==='ArrowDown'){e.preventDefault();e.stopPropagation();movePalette(1);}
    else if(e.key==='ArrowUp'){e.preventDefault();e.stopPropagation();movePalette(-1);}
    else if(e.key==='Enter'){e.preventDefault();e.stopPropagation();runPalette();}
    else if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closePalette();}
  });
  $('palette').addEventListener('mousedown',e=>{if(e.target===$('palette'))closePalette();});
  (function(){const rz=$('resizer'),side=$('side');let drag=false;     // resizable Work Item panel
    rz.addEventListener('mousedown',e=>{drag=true;rz.classList.add('active');document.body.style.cursor='col-resize';e.preventDefault();});
    document.addEventListener('mousemove',e=>{if(!drag)return;
      const w=Math.min(Math.max(window.innerWidth-e.clientX,300),Math.round(window.innerWidth*0.7));side.style.width=w+'px';});
    document.addEventListener('mouseup',()=>{if(drag){drag=false;rz.classList.remove('active');document.body.style.cursor='';if(cy)cy.resize();try{localStorage.setItem('ado.sideWidth',side.style.width);}catch(e){}}});
  })();
  $('s_save').onclick=save;$('s_comment').onclick=toggleComment;$('s_close').onclick=closePanel;
  $('s_customize').onclick=()=>{setCustomizeTab('side');showCustomize();};   // gear in the panel header → open Customize on the sidebar tab
  $('s_desc_toggle').onclick=()=>showDescPreview($('s_desc').style.display!=='none');
  $('cm_post').onclick=postComment;$('cm_cancel').onclick=()=>{$('comment_form').style.display='none';};
  $('s_me').onclick=()=>assignedEditor.set(currentUser||'me');
  $('s_actbtn').onclick=toggleActivity;
  parentEditor.wire();parentNew.wire();   // parent card + searchable picker (editor + New-item modal)
  assignedEditor.wire();assignedChild.wire();assignedNew.wire();   // assignee card + people picker
  sprintEditor.wire();sprintNew.wire();                           // sprint card + iteration picker
  depBlockedByPicker.wire();depBlocksPicker.wire();               // dependency adders (Blocked-by / Blocks)
  assignedEditor.render();assignedChild.render();assignedNew.render();sprintEditor.render();sprintNew.render();tagsEditor.render();   // placeholder cards before first use
  depBlockedByPicker.render();depBlocksPicker.render();renderDeps();   // dep card stubs + empty chip rows
  ['s_title','s_state','s_prio','s_desc','s_ac','s_start','s_target','s_due','s_est'].forEach(id=>{
    $(id).addEventListener('input',refreshDirty);$(id).addEventListener('change',refreshDirty);});
  document.addEventListener('keydown',e=>{
    const open=!$('side').classList.contains('hidden');
    if((e.ctrlKey||e.metaKey)&&e.code==='KeyS'&&!e.altKey){if(open){e.preventDefault();save();}}
    else if(e.key==='Escape'&&open){
      if(parentEditor.isOpen())parentEditor.close();
      else if(assignedEditor.isOpen())assignedEditor.close();
      else if(assignedChild.isOpen())assignedChild.close();
      else if(sprintEditor.isOpen())sprintEditor.close();
      else if(depBlockedByPicker.isOpen())depBlockedByPicker.close();
      else if(depBlocksPicker.isOpen())depBlocksPicker.close();
      else if($('comment_form').style.display==='flex')$('comment_form').style.display='none';
      else if($('child_form').style.display==='flex')$('child_form').style.display='none';
      else closePanel();
    }
  });
  $('s_childbtn').onclick=()=>{const f=$('child_form');const show=f.style.display!=='flex';f.style.display=show?'flex':'none';f.style.flexDirection='column';if(show)$('c_title').focus();};
  $('c_create').onclick=createChild;$('c_cancel').onclick=()=>$('child_form').style.display='none';
  $('c_me').onclick=()=>assignedChild.set(currentUser||'me');
  $('c_title').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();createChild();}});
  // new-item modal (create from scratch)
  $('newbtn').onclick=()=>showNewItem();
  $('undobtn').onclick=runUndo;$('redobtn').onclick=runRedo;
  $('n_create').onclick=createNew;$('n_cancel').onclick=closeNewItem;
  $('n_me').onclick=()=>assignedNew.set(currentUser||'me');
  $('newitem-overlay').addEventListener('mousedown',e=>{if(e.target===$('newitem-overlay'))closeNewItem();});
  $('n_title').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();createNew();}});
  $('newitem-box').addEventListener('keydown',e=>{
    if(e.key==='Escape'){e.preventDefault();e.stopPropagation();if(parentNew.isOpen())parentNew.close();else if(assignedNew.isOpen())assignedNew.close();else if(sprintNew.isOpen())sprintNew.close();else closeNewItem();}
    else if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){e.preventDefault();createNew();}});
  // new-sprint modal (Board → By Sprint "＋" column)
  $('sp_create').onclick=createSprintSubmit;$('sp_cancel').onclick=closeSprintModal;
  $('sprint-overlay').addEventListener('mousedown',e=>{if(e.target===$('sprint-overlay'))closeSprintModal();});
  $('sprint-box').addEventListener('keydown',e=>{
    if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closeSprintModal();}
    else if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){e.preventDefault();createSprintSubmit();}});
  $('sp_name').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();createSprintSubmit();}});
  // customize-toolbar dialog
  $('cz_open').onclick=showCustomize;$('cz_done').onclick=closeCustomize;$('cz_reset').onclick=resetCustomize;
  $('cz_tabs').querySelectorAll('button').forEach(b=>b.onclick=()=>setCustomizeTab(b.dataset.cz));
  loadSideLayout();applySideLayout();          // restore the saved sidebar group order / hidden set
  $('customize-overlay').addEventListener('mousedown',e=>{if(e.target===$('customize-overlay'))closeCustomize();});
  $('customize-box').addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closeCustomize();}});
  loadBarLayout();applyBarLayout();              // apply the saved toolbar order / hidden set
  wireTreeDnD();                                  // drag tree rows to re-parent
  try{const sf=localStorage.getItem('ado.filters');if(sf)Object.assign(fstate,JSON.parse(sf));
    const ss=localStorage.getItem('ado.sort');if(ss!==null)$('f_sort').value=ss;
    if(localStorage.getItem('ado.showEmpty')!=='0'){$('board').classList.add('showempty');$('empty_btn').classList.add('on');}
    const bg=localStorage.getItem('ado.boardGroup');if(bg){boardGroup=bg;$('grp').querySelectorAll('button').forEach(x=>x.classList.toggle('on',x.dataset.g===bg));}
    const tz2=localStorage.getItem('ado.tlZoom');if(tz2&&TL_PX[tz2]){tlZoom=tz2;$('tlzoom').querySelectorAll('button').forEach(x=>x.classList.toggle('on',x.dataset.z===tz2));}
    const tg=localStorage.getItem('ado.tlGroup');if(tg){tlGroup=tg;$('tl_group').value=tg;}
    const sg=localStorage.getItem('ado.sprintGroup');if(sg)sprintGroup=sg;
    const au=localStorage.getItem('ado.auto');if(au!==null){$('f_auto').value=au;setAutoRefresh(au);}
    const rd=localStorage.getItem('ado.rankDir');if(rd==='TB'||rd==='LR'){rankDir=rd;$('dir').querySelectorAll('button').forEach(x=>x.classList.toggle('on',x.dataset.d===rd));}}catch(e){}
  buildLegend();renderFilters();updateFilterCount();updatePatBadge();updateUndoButtons();updateCreateButtons();
  await loadIdentity();
  try{
    applyTheme(localStorage.getItem('ado.theme')||'dark');
    const savedWidth=localStorage.getItem('ado.sideWidth');
    if(savedWidth)$('side').style.width=savedWidth;
    const savedMode=localStorage.getItem('ado.mode');
    if(savedMode&&savedMode!=='tree')setMode(savedMode);
  }catch(e){}
  renderViewHelp();                          // show the controls legend for the initial view
  const p=new URLSearchParams(location.search),root=p.get('root');
  if(root){await openItem(parseInt(root));}
  if(mode==='tree')await loadSnapshot();   // paint last session's tree instantly while the network refresh runs
  refresh().then(warnIfPatExpiring);   // nudge after the list settles, if the PAT is near expiry
}

async function loadIdentity(){
  if(!currentUser){try{currentUser=await api.me();}catch(e){currentUser='';}}
  try{const asg=await api.assignees();assignees=(asg||[]).filter(a=>a!==currentUser);}
  catch(e){assignees=[];}
  $('assignees').innerHTML=['me',...assignees].map(a=>`<option value="${String(a).replace(/"/g,'&quot;')}">`).join('');
  renderFilters();                          // re-render so Assigned chips include people
  loadFilterData().then(renderFilters);     // states/tags/sprints fill in async (don't block first paint)
  if(currentUser)$('s_me').title='assign to me ('+currentUser+')';
}
// Populate the data-driven filter chips from the project itself (in parallel):
//   - State: union of states across all work-item types (falls back to a static list)
//   - Tags:  distinct tags sampled from recent items
//   - Sprint: dated iterations (chip value = path, label = short name)
async function loadFilterData(){
  await loadTypes();                          // real work-item types first (drives the lines below + create dropdowns)
  await Promise.all([
    (async()=>{try{
      const per=await Promise.all(typeNames().map(t=>api.states(t).catch(()=>[])));
      const all=[];per.forEach(arr=>arr.forEach(s=>{if(!all.includes(s))all.push(s);}));
      projectStates=all.length?orderStates(all):[];
    }catch(e){projectStates=[];}})(),
    (async()=>{try{tagList=await api.tags();$('tagsdl').innerHTML=tagList.map(x=>`<option value="${esc(x)}">`).join('');}catch(e){tagList=[];}})(),
    (async()=>{try{const its=await getIterations();sprintPaths=its.map(i=>i.path);
      sprintNames={};its.forEach(i=>{sprintNames[i.path]=i.name;});}
      catch(e){sprintPaths=[];sprintNames={};}})(),
  ]);
}

/* ---------- boot ---------- */
window.addEventListener('DOMContentLoaded',async()=>{
  wireSetup();
  const cfg=await api.getConfig();
  projectName=cfg.project;                  // "no sprint" root path fallback
  const hasAuth=cfg.authMode==='oauth'?(!!cfg.oauthAccess||!!cfg.oauthRefresh):(!!cfg.pat&&!!cfg.org&&!!cfg.project);
  if(!hasAuth){showSetup(false);return;}    // first-run flow takes over
  // Validate the stored credentials before showing the UI: a stale token would
  // otherwise surface as a wall of 401s after the first refresh.
  try{
    const name=await api.me();
    if(!name)throw new Error('no display name');
    currentUser=name;
  }catch(e){showSetup(false);$('setup-err').textContent='Stored credentials are invalid: '+e.message;return;}
  initialBoot(false);
});

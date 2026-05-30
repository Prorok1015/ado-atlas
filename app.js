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
let TYPE_COLOR={Epic:'#8e44ad',Feature:'#e67e22','User Story':'#3498db',Bug:'#e74c3c',Task:'#7f8c8d',Issue:'#16a085'};
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
function reachable(){const out=new Set(),st=[...(store.top||store.roots)];
  while(st.length){const id=st.pop();if(out.has(id))continue;out.add(id);
    if(store.expanded.has(id))(store.kids[id]||[]).forEach(c=>st.push(c));}
  return out;}
async function ensureKids(id){            // load children once, cache in the store
  if(store.kids[id])return store.kids[id];
  const ord=$('f_sort').value||null;
  let kids;try{kids=await api.children(id,ord);}catch(e){setStatus('ERROR: '+e.message,true);return [];}
  kids.forEach(k=>{store.nodes[k.id]=k;store.parent[k.id]=id;});store.kids[id]=kids.map(k=>k.id);
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
  FILTERS.forEach(f=>{
    const vals=f.values()||[];
    if(!vals.length&&!Object.keys(fstate[f.key]||{}).length)return;   // skip empty rows (e.g. tags/sprints not loaded yet)
    const row=document.createElement('div');row.className='frow';
    const lab=document.createElement('span');lab.className='fl';lab.textContent=f.label;row.appendChild(lab);
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
  const cb=document.createElement('input');cb.type='checkbox';cb.className='tcheck';cb.checked=bulkSel.has(n.id);
  cb.title='select for bulk edit';
  cb.onclick=e=>{e.stopPropagation();toggleBulk(n.id,cb.checked);row.classList.toggle('bulksel',cb.checked);};
  const open=store.expanded.has(n.id);
  const tog=document.createElement('span');tog.className='tog';tog.textContent=open?'▾':'▸';
  tog.onclick=e=>{e.stopPropagation();toggle(li,n,tog);};
  const dot=document.createElement('i');dot.className='dot';dot.style.background=TYPE_COLOR[n.type]||'#95a5a6';
  const lab=document.createElement('span');lab.className='lab';lab.textContent=`#${n.id} ${n.title}`;
  if(n.via&&n.via.length){const m=document.createElement('span');m.className='skip';m.textContent=' ↗';
    m.title='via '+n.via.map(i=>'#'+i).join(' → ')+' (not in filter)';lab.appendChild(m);}
  const bdg=document.createElement('span');bdg.className='badge';bdg.textContent=n.state;
  row.append(cb,tog,dot,lab,bdg);
  if(n.priority){const pc=document.createElement('span');pc.className='prio';pc.textContent='P'+n.priority;
    pc.style.background=prioColor(n.priority);pc.title='priority '+n.priority;row.insertBefore(pc,bdg);}
  if(n.id===cur){row.classList.add('sel');selRow=row;}   // keep highlight across re-renders
  row.onclick=()=>{if(selRow)selRow.classList.remove('sel');selRow=row;row.classList.add('sel');openItem(n.id);};
  li.appendChild(row);
  if(open)li.appendChild(childrenUl(n.id));              // auto-expand from shared state
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

/* ---------- bulk multi-select (tree) ---------- */
function toggleBulk(id,on){if(on)bulkSel.add(id);else bulkSel.delete(id);updateBulkBar();}
function clearBulk(){bulkSel.clear();updateBulkBar();
  document.querySelectorAll('#tree .trow.bulksel').forEach(r=>r.classList.remove('bulksel'));
  document.querySelectorAll('#tree .tcheck').forEach(c=>{c.checked=false;});}
function updateBulkBar(){const n=bulkSel.size;$('bulkbar').style.display=n?'flex':'none';$('bulk_count').textContent=n+' selected';}
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
  if(store.expanded.has(id)){store.expanded.delete(id);renderGraph();return;}
  loadStart('expanding #'+id+'…');
  try{const kids=await ensureKids(id);
    store.expanded.add(id);renderGraph();
    setStatus(`#${id}: +${kids.length} child(ren)`);
  }finally{loadEnd();}
}
function gstyle(){return [
 {selector:'node',style:{'background-color':e=>TYPE_COLOR[e.data('type')]||'#95a5a6','shape':'round-rectangle',
   'label':e=>{const p=e.data('priority'),v=e.data('via');return (p?('P'+p+' · '):'')+'#'+e.data('id')+(v&&v.length?' ↗':'')+' · '+e.data('type')+'\n'+e.data('title');},
   'color':'#fff','text-wrap':'wrap','text-max-width':'190px','font-size':'11px','text-valign':'center',
   'width':'210px','height':'label','padding':'10px',
   'border-width':e=>((e.data('priority')||9)<=2?4:2),'border-color':e=>prioColor(e.data('priority'))}},
 // compound (parent) nodes: render as a translucent container with a header strip
 {selector:':parent',style:{
   'background-color':e=>TYPE_COLOR[e.data('type')]||'#95a5a6','background-opacity':0.08,
   'border-color':e=>TYPE_COLOR[e.data('type')]||'#95a5a6','border-width':2,'border-opacity':0.7,
   'shape':'round-rectangle','padding':'24px','color':'#fff',
   'label':e=>{const p=e.data('priority'),v=e.data('via');return (p?('P'+p+' · '):'')+'#'+e.data('id')+(v&&v.length?' ↗':'')+' · '+e.data('type')+' — '+e.data('title');},
   'text-valign':'top','text-halign':'center','text-margin-y':-4,
   'font-size':'12px','font-weight':'bold','text-max-width':'400px','text-wrap':'wrap'}},
 {selector:'node:selected',style:{'border-color':'#fff','border-width':4}},
 {selector:'edge[kind="hierarchy"]',style:{'width':1,'line-color':'#5b6b7d','line-opacity':0.4,'target-arrow-color':'#5b6b7d','target-arrow-shape':'triangle','curve-style':'bezier'}},
 {selector:'edge[kind="dep"]',style:{'width':2,'line-style':'dashed','line-color':'#e0a13c','target-arrow-color':'#e0a13c','target-arrow-shape':'vee','curve-style':'bezier'}},
]}
function initCy(){
  cy=cytoscape({container:$('cy'),style:gstyle(),wheelSensitivity:0.2});
  let tapTimer=null,tapId=null;                 // single tap = open editor; double tap = expand
  cy.on('tap','node',e=>{const id=Number(e.target.data('id'));   // cytoscape gives a string id
    if(tapTimer&&tapId===id){clearTimeout(tapTimer);tapTimer=null;tapId=null;expandNode(id);return;}
    tapId=id;clearTimeout(tapTimer);
    tapTimer=setTimeout(()=>{tapTimer=null;tapId=null;openItem(id);},250);});
}
function runLayout(fit){cy.layout({name:'dagre',rankDir,ranker:'tight-tree',
  nodeSep:55,rankSep:110,edgeSep:25,animate:true,animationDuration:250,fit:!!fit,padding:40}).run();}
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
    d.forEach((e,i)=>edges.push({id:'d'+i,source:String(e.source),target:String(e.target),kind:'dep'}));
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
}

/* ---------- board (sprints) ---------- */
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"}[c]));
const DONE_STATES=['Closed','Resolved','Removed','Done'];
let iterCache=null;
async function getIterations(){                     // sprint dates — fetched once, cached
  if(!iterCache){try{iterCache=await api.iterations();}catch(e){iterCache=[];setStatus('ERROR: '+e.message,true);}}
  return iterCache;
}
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
  if(groups.has('__none__'))order.push('__none__');
  order.forEach(k=>{
    const it=k==='__none__'?null:info[k];const fin=it?it.finish:null;
    const colItems=groups.get(k)||[];
    const col=document.createElement('div');col.className='bcol';
    if(k!=='__none__'&&!colItems.length&&!newSprints.has(k))col.classList.add('empty-sprint');   // hidden until a drag starts (but keep a just-created one visible)
    if(it&&it.start&&it.finish&&today>=it.start.slice(0,10)&&today<=it.finish.slice(0,10))col.classList.add('current');
    const h=document.createElement('div');h.className='bhead';
    h.innerHTML=(k==='__none__'?'No sprint':`${esc(it.name)} <small>${(it.start||'').slice(0,10)}→${(fin||'').slice(0,10)}</small>`)+'<br>'+colMeta(colItems);
    if(k!=='__none__'){h.style.cursor='pointer';h.title='double-click to open sprint';h.addEventListener('dblclick',()=>openSprint(k));}
    const wrap=document.createElement('div');wrap.className='bcards';
    colItems.forEach(n=>wrap.appendChild(boardCard(n,fin,today)));
    if(!colItems.length&&k!=='__none__'){const ph=document.createElement('div');ph.className='empty';ph.textContent='drop here';wrap.appendChild(ph);}
    col.dataset.field='iteration';col.dataset.val=(k==='__none__')?root:k;   // drop = change sprint
    col.append(h,wrap);el.appendChild(col);
  });
  if(canCreateSprint){                              // phantom "add sprint" column at the right end
    const add=document.createElement('div');add.className='bcol addcol';add.title='create a new sprint';
    add.innerHTML='<div class="addinner"><span class="plus">＋</span>New sprint</div>';
    add.onclick=showSprintModal;el.appendChild(add);
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
  const c=document.createElement('div');c.className='bcard'+(overdue?' overdue':'');
  c.style.borderLeftColor=TYPE_COLOR[n.type]||'#95a5a6';   // left marker = item TYPE colour
  c.dataset.id=n.id;c.dataset.est=(n.est!=null?n.est:'');
  c.innerHTML=`<div class="bttl">#${n.id} ${esc(n.title)}</div>`+
    `<div class="bmeta"><span>${esc(n.type)}</span>`+
    (n.priority?`<span class="prio" style="background:${prioColor(n.priority)}">P${n.priority}</span>`:'')+
    `<span>${esc(n.state)}</span>`+(overdue?'<span class="od">overdue</span>':'')+`</div>`+
    `<div class="bfoot">`+(n.est!=null?`<div class="tbar"><div class="tfill"></div></div>`:'')+
    `<span class="tlabel">${n.est!=null?'est '+(+n.est)+'h':'⏱ …'}</span></div>`;
  c.addEventListener('mousedown',e=>{if(e.button===0)startCardDrag(e,n.id,c);});   // custom pointer drag
  c.onclick=()=>{if(suppressClick)return;openItem(n.id);};                          // suppressed right after a drag
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
    const cl=pdrag.card.cloneNode(true);cl.className='bcard drag-ghost';cl.style.width=r.width+'px';
    document.body.appendChild(cl);pdrag.clone=cl;
    pdrag.card.classList.add('dragging');$('board').classList.add('drag');document.body.style.cursor='grabbing';
  }
  pdrag.clone.style.left=(e.clientX+10)+'px';pdrag.clone.style.top=(e.clientY+10)+'px';
  const el=document.elementFromPoint(e.clientX,e.clientY);
  const c=el&&el.closest?el.closest('.bcol[data-field]'):null;
  if(pdrag.hot&&pdrag.hot!==c)pdrag.hot.classList.remove('dropover');
  pdrag.hot=c;if(c)c.classList.add('dropover');
});
document.addEventListener('mouseup',()=>{
  if(!pdrag)return;const d=pdrag;pdrag=null;
  if(!d.active)return;                              // was a plain click — let onclick handle it
  d.card.classList.remove('dragging');if(d.clone)d.clone.remove();
  $('board').classList.remove('drag');document.body.style.cursor='';
  if(d.hot)d.hot.classList.remove('dropover');
  suppressClick=true;setTimeout(()=>{suppressClick=false;},30);   // swallow the click that follows a drag
  const col=d.hot;if(!col)return;
  const field=col.dataset.field,val=col.dataset.val||'';
  const node=store.nodes[d.id],curVal=node?(node[field]||''):'';   // field: iteration | assigned | state
  if(val===curVal)return;
  if(field==='iteration'){const it=_sprint(val),fin=it&&it.finish?it.finish.slice(0,10):null,today=new Date().toISOString().slice(0,10);
    if(fin&&fin<today&&!confirm(`Sprint "${it.name}" ended ${fin}. Move #${d.id} there anyway?`))return;}
  moveCard(d.id,field,val);
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
  top.innerHTML=`<button class="btn" id="g_back" title="back to board">←</button>`+
    `<b>${esc(it.name)}</b> <span style="color:var(--muted)">${it.start.slice(0,10)} → ${it.finish.slice(0,10)} · ${items.length} items`+
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
    const bs=n.start?Date.parse(n.start.slice(0,10)):s0, be=n.target?Date.parse(n.target.slice(0,10)):f0;
    let si=Math.round((bs-s0)/DAY),ei=Math.round((be-s0)/DAY);
    si=Math.max(0,Math.min(si,N-1));ei=Math.max(si,Math.min(ei,N-1));
    const bar=document.createElement('div');bar.className='gbar';
    bar.style.left=(si/N*100)+'%';bar.style.width=((ei-si+1)/N*100)+'%';
    bar.style.background=TYPE_COLOR[n.type]||'#95a5a6';
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
  if(renderSprint(path)){openSprintPath=path;$('board').classList.remove('show');$('sprintview').classList.add('show');}
}
function backToBoard(){
  openSprintPath=null;$('sprintview').classList.remove('show');$('board').classList.add('show');
  if(boardScroll){$('board').scrollLeft=boardScroll.l;$('board').scrollTop=boardScroll.t;}
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
  const ms=new Date(min),me=new Date(max);
  const r0=Date.UTC(ms.getUTCFullYear(),ms.getUTCMonth(),1);                 // snap range to whole months
  const r1=Date.UTC(me.getUTCFullYear(),me.getUTCMonth()+1,1)-TL_DAY;
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
  const today=Date.parse(new Date().toISOString().slice(0,10));
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
  const lab=n=>`<div class="tllabel" style="width:${LW}px"><i class="dot" style="background:${TYPE_COLOR[n.type]||'#95a5a6'}"></i><span class="tllab">#${n.id} ${esc(n.title)}</span></div>`;
  const rowHTML=n=>{const t=n._tl,tip=`${n.start||(t.soft?'sprint start':'?')} → ${(n.target||n.due)||(t.soft?'sprint finish':'?')}`;
    return `<div class="tlrow" data-id="${n.id}">${lab(n)}<div class="tltrack" style="width:${W}px"><div class="tlbar${t.soft?' soft':''}" style="left:${xOf(t.s)}px;width:${wOf(t.s,t.e)}px;background:${TYPE_COLOR[n.type]||'#95a5a6'}" title="${esc(tip)}">#${n.id} ${esc(n.title)}</div></div></div>`;};
  const byStart=(a,b)=>(a._tl.s-b._tl.s)||(a.id-b.id);
  const groupHead=(k,arr)=>{const gs=Math.min(...arr.map(n=>n._tl.s)),ge=Math.max(...arr.map(n=>n._tl.e));
    return `<div class="tlgrouprow"><div class="tlgrouplabel" style="width:${LW}px">${esc(k)} · ${arr.length}</div><div class="tlgrouptrack" style="width:${W}px"><div class="tlgroupbar" style="left:${xOf(gs)}px;width:${wOf(gs,ge)}px"></div></div></div>`;};
  let rows='';
  if(tlGroup==='none')dated.sort(byStart).forEach(n=>{rows+=rowHTML(n);});
  else{
    const groups=new Map();dated.forEach(n=>{const k=tlKey(n);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(n);});
    let keys=[...groups.keys()];keys=(tlGroup==='state')?orderStates(keys):keys.sort((a,b)=>a.localeCompare(b));
    keys.forEach(k=>{const arr=groups.get(k).sort(byStart);rows+=groupHead(k,arr);arr.forEach(n=>{rows+=rowHTML(n);});});
  }
  if(undated.length){
    rows+=`<div class="tlgrouprow"><div class="tlgrouplabel" style="width:${LW}px">No dates · ${undated.length}</div><div class="tlgrouptrack" style="width:${W}px"></div></div>`;
    undated.sort((a,b)=>a.id-b.id).forEach(n=>{rows+=`<div class="tlrow" data-id="${n.id}">${lab(n)}<div class="tltrack" style="width:${W}px"><span class="tlnodate">— no dates —</span></div></div>`;});
  }
  el.innerHTML=`<div class="tlcanvas">`+
    `<div class="tlhead"><div class="tlcorner" style="width:${LW}px">${months.length} mo · ${dated.length} scheduled</div><div class="tlaxis" style="width:${W}px">${axis}${ticks}</div></div>`+
    `<div class="tlbody"><div class="tlgrid" style="left:${LW}px;width:${W}px">${grid}</div>${rows}</div></div>`;
  setStatus(`${dated.length} scheduled · ${undated.length} no dates`+capNote());
  if(today>=r0&&today<=r1)el.scrollLeft=Math.max(0,xOf(today)-Math.round(el.clientWidth*0.35));   // centre on today
}

/* ---------- mode / refresh ---------- */
function setMode(m){
  $('sprintview').classList.remove('show');openSprintPath=null;   // leaving board closes the sprint detail
  mode=m;$('mode').querySelectorAll('button').forEach(b=>b.classList.toggle('on',b.dataset.m===m));
  $('tree').classList.toggle('show',m==='tree');$('cy').classList.toggle('show',m==='graph');
  $('board').classList.toggle('show',m==='board');$('timeline').classList.toggle('show',m==='timeline');
  $('emode').style.display=$('dir').style.display=(m==='graph')?'inline-flex':'none';
  $('fit').style.display=(m==='graph')?'inline-block':'none';   // Fit only makes sense on the graph
  $('empty_btn').style.display=(m==='board')?'inline-block':'none';
  $('grp').style.display=(m==='board')?'inline-flex':'none';
  $('tlzoom').style.display=(m==='timeline')?'inline-flex':'none';
  $('tl_group').style.display=(m==='timeline')?'inline-block':'none';
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
}

/* ---------- editor ---------- */
function closePanel(force){
  if(!force&&dirty()&&!confirm('Discard unsaved changes?'))return;
  parentEditor.close();
  $('side').classList.add('hidden');$('resizer').style.display='none';cur=null;orig={};
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
  $('s_hdr').innerHTML=`<i class="dot" style="background:${TYPE_COLOR[d.type]||'#95a5a6'}"></i>#${d.id} ${esc(d.type)}`+
    ` <span class="sbadge" style="background:${stateColor(d.state)}">${esc(d.state)}</span>`+
    ` <span style="color:var(--muted);font-weight:400;font-size:11px">rev${d.rev}</span>`;
  $('s_ctx').innerHTML=d.parent?`↑ parent <a id="s_par">#${d.parent}</a>`:'';
  if(d.parent)$('s_par').onclick=()=>openItem(d.parent);
  $('s_link').href=d.url;$('s_title').value=d.title;$('s_assigned').value=d.assigned;$('s_desc').value=d.desc;
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
  const isel=$('s_iter');isel.innerHTML='';
  const root=iters[0]?iters[0].path.split('\\')[0]:projectName;
  isel.appendChild(new Option('(no sprint)',root));
  const _t=new Date().toISOString().slice(0,10);
  iters.forEach(it=>{const cur=it.start&&it.finish&&_t>=it.start.slice(0,10)&&_t<=it.finish.slice(0,10);
    isel.appendChild(new Option(it.name+(cur?'  • current':''),it.path));});
  const curIt=d.iteration||root;
  if(curIt!==root&&!iters.some(it=>it.path===curIt))isel.appendChild(new Option(curIt.split('\\').slice(1).join('\\')||curIt,curIt));
  isel.value=curIt;
  parentEditor.set(d.parent!=null?String(d.parent):'',/*silent*/true);   // set value + render card without flipping dirty
  $('s_start').value=(d.start||'').slice(0,10);
  $('s_target').value=(d.target||'').slice(0,10);
  $('s_due').value=(d.due||'').slice(0,10);
  $('s_est').value=(d.est!=null?d.est:'');
  orig={title:d.title,state:d.state,assigned:d.assigned,desc:d.desc,ac:d.ac,has_ac:d.has_ac,priority:d.priority,
        iter:isel.value,parent:(d.parent!=null?String(d.parent):''),start:$('s_start').value,target:$('s_target').value,due:$('s_due').value,est:$('s_est').value};
  refreshDirty();loadTimeline(id);
  setStatus('#'+id+' loaded');
}
function dirty(){
  if(cur==null||!orig)return false;
  const v=editorValues();
  return v.title!==orig.title||v.state!==orig.state||v.assigned!==orig.assigned||v.desc!==orig.desc
    ||(orig.has_ac&&v.ac!==orig.ac)||((orig.priority?String(orig.priority):'')!==v.prio)
    ||v.iter!==orig.iter||v.parent!==orig.parent||v.start!==orig.start||v.target!==orig.target||v.due!==orig.due||v.est!==orig.est;
}
function refreshDirty(){const d=dirty();const b=$('s_save');b.disabled=!d;b.textContent=d?'● Save':'Saved';}
function editorValues(){return {title:$('s_title').value,state:$('s_state').value,assigned:$('s_assigned').value,desc:$('s_desc').value,ac:$('s_ac').value,prio:$('s_prio').value,
  iter:$('s_iter').value,parent:$('s_parent').value.trim(),start:$('s_start').value,target:$('s_target').value,due:$('s_due').value,est:$('s_est').value};}

/* ---------- reusable parent field: current-parent card + searchable picker ----------
   One instance per place that edits a parent (the item editor, the New-item modal).
   Elements are looked up by id from `base`: <base> (hidden value), <base>_card,
   <base>_pick, <base>_search, <base>_results, and optional <base>_open. */
function parentCardHtml(n){
  return `<i class="dot" style="background:${TYPE_COLOR[n.type]||'#95a5a6'}"></i>`+
    `<span class="pcid">#${n.id}</span><span class="pctitle">${esc(n.title||'')}</span>`+
    (n.state?`<span class="pcstate" style="background:${stateColor(n.state)}">${esc(n.state)}</span>`:'');
}
function createParentField(base,opts){
  opts=opts||{};
  const onChange=opts.onChange||(()=>{});
  const getExclude=opts.getExcludeId||(()=>null);   // id that can't be the parent (e.g. the item itself)
  const V=()=>$(base),Card=()=>$(base+'_card'),Pick=()=>$(base+'_pick'),
        Search=()=>$(base+'_search'),Results=()=>$(base+'_results'),Open=()=>$(base+'_open');
  let idx=0,rows=[];
  function render(){
    const v=V().value.trim(),card=Card(),openBtn=Open();
    if(!v){card.innerHTML='<span class="pcnone">(no parent)</span>';if(openBtn)openBtn.style.visibility='hidden';return;}
    if(openBtn)openBtn.style.visibility='visible';
    const n=store.nodes[v];
    if(n){card.innerHTML=parentCardHtml(n);return;}
    card.innerHTML=`<i class="dot" style="background:#95a5a6"></i><span class="pcid">#${v}</span><span class="pctitle pcnone">loading…</span>`;
    const want=v;                                   // resolve the title for a parent that isn't in the loaded tree
    api.item(v).then(it=>{if(V().value.trim()!==want)return;store.nodes[it.id]=store.nodes[it.id]||it;card.innerHTML=parentCardHtml(it);})
      .catch(()=>{if(V().value.trim()===want)card.innerHTML=`<i class="dot" style="background:#95a5a6"></i><span class="pcid">#${v}</span>`;});
  }
  function set(v,silent){V().value=(v==null?'':String(v));render();close();if(!silent)onChange();}
  function get(){return V().value.trim();}
  function open(){const p=Pick();if(p.style.display!=='none'){close();return;}   // toggle
    p.style.display='block';const i=Search();i.value='';results('');i.focus();}
  function close(){const p=Pick();if(p)p.style.display='none';}
  function isOpen(){const p=Pick();return !!p&&p.style.display!=='none';}
  function matches(q){
    q=(q||'').trim().toLowerCase();const toks=q.split(/\s+/).filter(Boolean),out=[{none:true}],ex=getExclude();
    if(/^#?\d+$/.test(q)){const id=parseInt(q.replace('#',''),10);if(id!==ex&&!store.nodes[id])out.push({rawId:id});}
    let n=0;
    for(const node of Object.values(store.nodes)){
      if(ex!=null&&node.id===ex)continue;           // an item can't be its own parent
      const hay=('#'+node.id+' '+(node.title||'')).toLowerCase();
      if(!toks.length||toks.every(t=>hay.includes(t))){out.push({node});if(++n>=40)break;}
    }
    return out;
  }
  function results(q){rows=matches(q);idx=0;draw();}
  function draw(){
    const list=Results();
    list.innerHTML=rows.map((r,i)=>{
      const on=i===idx?' on':'';
      if(r.none)return `<div class="prow${on}" data-i="${i}"><span class="pkind">—</span><span class="ptitle pcnone">(no parent)</span></div>`;
      if(r.rawId!=null)return `<div class="prow${on}" data-i="${i}"><span class="pkind">id</span><span class="ptitle">Use #${r.rawId}</span></div>`;
      const n=r.node,badge=n.state?`<span class="pbadge" style="background:${stateColor(n.state)}">${esc(n.state)}</span>`:'';
      return `<div class="prow${on}" data-i="${i}"><span class="pkind">${esc(n.type||'item')}</span><span class="ptitle">#${n.id} ${esc(n.title||'')}</span>${badge}</div>`;
    }).join('');
    list.querySelectorAll('.prow[data-i]').forEach(r=>{
      r.onmousedown=e=>{e.preventDefault();idx=+r.dataset.i;pick();};
      r.onmousemove=()=>{if(idx!==+r.dataset.i){idx=+r.dataset.i;highlight();}};
    });
  }
  function highlight(){Results().querySelectorAll('.prow[data-i]').forEach(r=>r.classList.toggle('on',+r.dataset.i===idx));}
  function move(d){if(!rows.length)return;idx=(idx+d+rows.length)%rows.length;highlight();
    const el=Results().querySelector('.prow.on');if(el)el.scrollIntoView({block:'nearest'});}
  function pick(){const r=rows[idx];if(!r)return;if(r.none)return set('');if(r.rawId!=null)return set(r.rawId);set(r.node.id);}
  function wire(){
    Card().onclick=open;
    Search().addEventListener('input',e=>results(e.target.value));
    Search().addEventListener('keydown',e=>{
      if(e.key==='ArrowDown'){e.preventDefault();move(1);}
      else if(e.key==='ArrowUp'){e.preventDefault();move(-1);}
      else if(e.key==='Enter'){e.preventDefault();pick();}
      else if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close();Card().focus();}
    });
    const ob=Open();if(ob)ob.onclick=()=>{const p=get();if(/^\d+$/.test(p))openItem(parseInt(p));};
    document.addEventListener('mousedown',e=>{if(isOpen()&&!Pick().contains(e.target)&&!Card().contains(e.target))close();});
  }
  return {set,get,render,open,close,isOpen,wire};
}
const parentEditor=createParentField('s_parent',{onChange:refreshDirty,getExcludeId:()=>cur});
const parentNew=createParentField('n_parent',{getExcludeId:()=>null});

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
  if(cy){const n=cy.getElementById(String(id));if(n.nonempty()){if(body.title)n.data('title',body.title);if(body.state)n.data('state',body.state);if('priority'in body)n.data('priority',body.priority);}}
  if(selRow&&body.title)selRow.querySelector('.lab').textContent=`#${id} ${body.title}`;
  if(selRow&&body.state)selRow.querySelector('.badge').textContent=body.state;
  if(selRow&&('priority'in body)){let pc=selRow.querySelector('.prio');if(!pc){pc=document.createElement('span');pc.className='prio';selRow.insertBefore(pc,selRow.querySelector('.badge'));}pc.textContent='P'+body.priority;pc.style.background=prioColor(body.priority);}
  if(store.nodes[id]){const s=store.nodes[id];s.title=v.title;s.state=v.state;
    if('priority'in body)s.priority=body.priority;
    if('iteration'in body)s.iteration=body.iteration;
    if('target'in body)s.target=v.target;
    if('estimate'in body)s.est=(v.est===''?null:Number(v.est));}
  orig={...orig,...v};if('priority'in body)orig.priority=body.priority;
  refreshDirty();setStatus(`#${id} saved`+(r?` → rev ${r.rev}`:''));
  // Auto-reload the list when the change can shift WHERE the item appears: sprint
  // moves it across board columns, assignee shifts its grouping, and a re-parent
  // changes the tree/graph hierarchy. Otherwise a board re-render + store update suffice.
  if('iteration'in body||'assigned'in body||parentChanged)refresh();
  else if(mode==='board')renderBoard();         // reflect date/title/priority on the board
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
  $('n_title').value='';$('n_prio').value='';$('n_assigned').value='';
  parentNew.set(parentId!=null?String(parentId):'',/*silent*/true);   // render the parent card + close any open picker
  fillTypeSelect('n_type','Task');           // ensure options match the project's real types
  // sprint dropdown — same source as the editor's, default to "(no sprint)"
  const isel=$('n_iter');isel.innerHTML='<option value="">(no sprint)</option>';
  try{
    const iters=await getIterations();
    _newIterRoot=iters[0]?iters[0].path.split('\\')[0]:(projectName||'');
    const _t=new Date().toISOString().slice(0,10);
    iters.forEach(it=>{const cur=it.start&&it.finish&&_t>=it.start.slice(0,10)&&_t<=it.finish.slice(0,10);
      isel.appendChild(new Option(it.name+(cur?'  • current':''),it.path));});
  }catch(e){/* sprints are optional — leave just "(no sprint)" */}
  $('newitem-overlay').classList.add('show');
  $('n_title').focus();
}
function closeNewItem(){parentNew.close();$('newitem-overlay').classList.remove('show');}
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
function closeSprintModal(){$('sprint-overlay').classList.remove('show');}
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
      await api.createSprint({name,start,finish});
      iterCache=null;newSprints.add((projectName||'')+'\\'+name);   // keep the (still-empty) new column visible
      closeSprintModal();
      await reloadSprintFilter();                  // new sprint now selectable in the filter
      setStatus(`sprint "${name}" created`);
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
    types.forEach(t=>{if(t.color)TYPE_COLOR[t.name]=t.color;});   // adopt the project's real process colours
  }else if(!typeList.length){
    typeList=TYPES.map(n=>({name:n,color:TYPE_COLOR[n]||''}));     // offline fallback to the static defaults
  }
  fillTypeSelect('c_type','Task');fillTypeSelect('n_type','Task');
  buildLegend();
  repaintTypes();                                  // colours just changed → repaint so defaults don't linger
}
// Re-apply the (now real) type colours to whatever view is showing. The first
// paint can beat the async colour load on a page reload, leaving the hard-coded
// defaults stuck until the next refresh — this fixes that without a full reload.
function repaintTypes(){
  if(!store.roots.length)return;                   // nothing painted yet; the next render will use the new colours
  if(mode==='timeline')renderTimeline();
  else if(mode==='board')renderBoard();
  else if(mode==='graph'){if(cy)cy.style().update();}
  else renderTree();
  if(openSprintPath&&$('sprintview').classList.contains('show'))renderSprint(openSprintPath);
}
// (Re)populate a type <select> from the loaded types, keeping the current
// choice if it's still valid, else falling back to `preferred` then the first.
function fillTypeSelect(id,preferred){
  const sel=$(id);if(!sel)return;
  const names=typeNames(),prev=sel.value;
  sel.innerHTML='';names.forEach(n=>sel.appendChild(new Option(n,n)));
  sel.value=names.includes(prev)?prev:(names.includes(preferred)?preferred:(names[0]||''));
}

function buildLegend(){$('legend').innerHTML=typeNames().map(k=>`<span><i style="background:${TYPE_COLOR[k]||'#95a5a6'}"></i>${esc(k)}</span>`).join('');}

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
  $('emode').querySelectorAll('button').forEach(b=>b.onclick=()=>{edgeMode=b.dataset.e;$('emode').querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===b));renderGraph();});
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
  $('timeline').addEventListener('click',e=>{const r=e.target.closest&&e.target.closest('.tlrow[data-id]');if(r)openItem(parseInt(r.dataset.id));});
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
  $('s_desc_toggle').onclick=()=>showDescPreview($('s_desc').style.display!=='none');
  $('cm_post').onclick=postComment;$('cm_cancel').onclick=()=>{$('comment_form').style.display='none';};
  $('s_me').onclick=()=>{$('s_assigned').value=currentUser||'me';refreshDirty();};
  $('s_actbtn').onclick=toggleActivity;
  parentEditor.wire();parentNew.wire();   // parent card + searchable picker (editor + New-item modal)
  ['s_title','s_state','s_prio','s_assigned','s_desc','s_ac','s_iter','s_start','s_target','s_due','s_est'].forEach(id=>{
    $(id).addEventListener('input',refreshDirty);$(id).addEventListener('change',refreshDirty);});
  document.addEventListener('keydown',e=>{
    const open=!$('side').classList.contains('hidden');
    if((e.ctrlKey||e.metaKey)&&e.code==='KeyS'&&!e.altKey){if(open){e.preventDefault();save();}}
    else if(e.key==='Escape'&&open){
      if(parentEditor.isOpen())parentEditor.close();
      else if($('comment_form').style.display==='flex')$('comment_form').style.display='none';
      else if($('child_form').style.display==='flex')$('child_form').style.display='none';
      else closePanel();
    }
  });
  $('s_childbtn').onclick=()=>{const f=$('child_form');const show=f.style.display!=='flex';f.style.display=show?'flex':'none';f.style.flexDirection='column';if(show)$('c_title').focus();};
  $('c_create').onclick=createChild;$('c_cancel').onclick=()=>$('child_form').style.display='none';
  $('c_me').onclick=()=>{$('c_assigned').value=currentUser||'me';};
  $('c_title').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();createChild();}});
  // new-item modal (create from scratch)
  $('newbtn').onclick=()=>showNewItem();
  $('undobtn').onclick=runUndo;$('redobtn').onclick=runRedo;
  $('n_create').onclick=createNew;$('n_cancel').onclick=closeNewItem;
  $('n_me').onclick=()=>{$('n_assigned').value=currentUser||'me';};
  $('newitem-overlay').addEventListener('mousedown',e=>{if(e.target===$('newitem-overlay'))closeNewItem();});
  $('n_title').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();createNew();}});
  $('newitem-box').addEventListener('keydown',e=>{
    if(e.key==='Escape'){e.preventDefault();e.stopPropagation();if(parentNew.isOpen())parentNew.close();else closeNewItem();}
    else if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){e.preventDefault();createNew();}});
  // new-sprint modal (Board → By Sprint "＋" column)
  $('sp_create').onclick=createSprintSubmit;$('sp_cancel').onclick=closeSprintModal;
  $('sprint-overlay').addEventListener('mousedown',e=>{if(e.target===$('sprint-overlay'))closeSprintModal();});
  $('sprint-box').addEventListener('keydown',e=>{
    if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closeSprintModal();}
    else if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){e.preventDefault();createSprintSubmit();}});
  $('sp_name').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();createSprintSubmit();}});
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
    (async()=>{try{tagList=await api.tags();}catch(e){tagList=[];}})(),
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

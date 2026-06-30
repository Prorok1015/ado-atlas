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
function lockSidebar(lock){
  const side=$('side');if(!side)return;
  side.classList.toggle('sidebar-loading',!!lock);
  ['s_title','s_state','s_prio','s_start','s_target','s_due','s_est','s_area','s_storypoints','s_remaining','s_completed','s_activity_field','s_risk','s_valuearea'].forEach(id=>{const el=$(id);if(el)el.disabled=!!lock;});
  
  // Disable standard dynamic pickers
  ['s_activity_field', 's_risk', 's_valuearea'].forEach(id => {
    if (window.dynamicPickers && window.dynamicPickers[id]) {
      window.dynamicPickers[id].setDisabled(lock);
    }
  });

  // Disable dynamic custom field inputs and pickers
  customFieldsState.forEach(cf => {
    const el = $(cf.elementId);
    if (el) el.disabled = !!lock;
    if (window.dynamicPickers && window.dynamicPickers[cf.elementId]) {
      window.dynamicPickers[cf.elementId].setDisabled(lock);
    }
    if (window.customHtmlEditors && window.customHtmlEditors[cf.referenceName]) {
      window.customHtmlEditors[cf.referenceName].setDisabled(lock);
    }
  });

  const trigger = $('side-range-trigger');
  if (trigger) trigger.disabled = !!lock;
  if (lock) {
    const popover = $('side-range-picker');
    if (popover) popover.classList.remove('show');
  }
  if(descEditor)descEditor.setDisabled(lock);if(acEditor)acEditor.setDisabled(lock);
  if(assignedEditor&&assignedEditor.setDisabled)assignedEditor.setDisabled(lock);
  if(sprintEditor&&sprintEditor.setDisabled)sprintEditor.setDisabled(lock);
  if(parentEditor&&parentEditor.setDisabled)parentEditor.setDisabled(lock);
  if(tagsEditor&&tagsEditor.setDisabled)tagsEditor.setDisabled(lock);
}

const LAZY_GROUPS = new Set(['desc', 'ac', 'tags', 'attachments', 'deps', 'area', 'storypoints', 'remaining', 'completed', 'activity', 'risk', 'valuearea']);
const HEAVY_FIELD_MAP = {
  desc: [api.FIELD_REGISTRY.desc.ref],
  ac: [api.FIELD_REGISTRY.ac.ref],
  tags: [api.FIELD_REGISTRY.tags.ref],
  area: [api.FIELD_REGISTRY.area.ref],
  storypoints: [api.FIELD_REGISTRY.storypoints.ref],
  remaining: [api.FIELD_REGISTRY.remaining.ref],
  completed: [api.FIELD_REGISTRY.completed.ref],
  activity: [api.FIELD_REGISTRY.activity.ref],
  risk: [api.FIELD_REGISTRY.risk.ref],
  valuearea: [api.FIELD_REGISTRY.valuearea.ref]
};

// Global cache of custom field editors / definitions to manage dynamically.
let customFieldsState = []; // array of { referenceName, name, type, readOnly, elementId }

function getCustomFieldElementId(refName) {
  return 's_cust_' + refName.replace(/[^a-zA-Z0-9]/g, '_');
}

function lockSidebarHeavy(lock, groupIds) {
  const targetGroups = groupIds || [...LAZY_GROUPS];
  targetGroups.forEach(g => {
    if (g === 'desc' && descEditor) descEditor.setDisabled(lock);
    if (g === 'ac' && acEditor) acEditor.setDisabled(lock);
    if (g === 'tags' && tagsEditor) tagsEditor.setDisabled(lock);
    if (g === 'area') { const el = $('s_area'); if (el) el.disabled = lock; }
    if (g === 'storypoints') { const el = $('s_storypoints'); if (el) el.disabled = lock; }
    if (g === 'remaining') { const el = $('s_remaining'); if (el) el.disabled = lock; }
    if (g === 'completed') { const el = $('s_completed'); if (el) el.disabled = lock; }
    if (g === 'activity') {
      const el = $('s_activity_field');
      if (el) el.disabled = lock;
      if (window.dynamicPickers && window.dynamicPickers['s_activity_field']) {
        window.dynamicPickers['s_activity_field'].setDisabled(lock);
      }
    }
    if (g === 'risk') {
      const el = $('s_risk');
      if (el) el.disabled = lock;
      if (window.dynamicPickers && window.dynamicPickers['s_risk']) {
        window.dynamicPickers['s_risk'].setDisabled(lock);
      }
    }
    if (g === 'valuearea') {
      const el = $('s_valuearea');
      if (el) el.disabled = lock;
      if (window.dynamicPickers && window.dynamicPickers['s_valuearea']) {
        window.dynamicPickers['s_valuearea'].setDisabled(lock);
      }
    }
    if (g === 'attachments') { const el = $('s_atch_group'); if (el) el.style.pointerEvents = lock ? 'none' : ''; }
    if (g === 'deps') { const el = $('s_deps'); if (el) el.style.pointerEvents = lock ? 'none' : ''; }
    
    // Support custom fields locking
    if (g.startsWith('cust:')) {
      const refName = g.substring(5);
      const elId = getCustomFieldElementId(refName);
      const el = $(elId);
      if (el) el.disabled = !!lock;
      if (window.dynamicPickers && window.dynamicPickers[elId]) {
        window.dynamicPickers[elId].setDisabled(lock);
      }
      if (window.customHtmlEditors && window.customHtmlEditors[refName]) {
        window.customHtmlEditors[refName].setDisabled(lock);
      }
    }
  });
}

async function ensureFieldLoaded(groupId) {
  if (cur == null || !orig) return;
  const id = cur;
  const myToken = openToken;                      // capture to detect stale responses
  const fieldKeyMap = {
    desc: 'desc', ac: 'ac', tags: 'tags', area: 'area',
    storypoints: 'storypoints', remaining: 'remaining', completed: 'completed',
    activity: 'activity', risk: 'risk', valuearea: 'valuearea'
  };
  const key = fieldKeyMap[groupId];
  if (key && orig[key] !== undefined && orig[key] !== '' && orig[key] !== null) return;
  // For scalar fields that were initialized with '' or null in orig, check a flag
  if (key && orig['_loaded_' + key]) return;
  if ((groupId === 'deps' || groupId === 'attachments') && orig._relationsLoaded) return;
  
  lockSidebarHeavy(true, [groupId]);
  if (groupId === 'desc') {
    const el = $('editor_desc_container');
    if (el) el.classList.add('loading-skeleton');
  }
  if (groupId === 'ac') {
    const el = $('editor_ac_container');
    if (el) el.classList.add('loading-skeleton');
  }
  
  let fieldsToFetch = HEAVY_FIELD_MAP[groupId] || [];
  let needRelations = (groupId === 'deps' || groupId === 'attachments');
  
  // If no fields to fetch and no relations needed, nothing to do
  if (fieldsToFetch.length === 0 && !needRelations) {
    lockSidebarHeavy(false, [groupId]);
    return;
  }
  
  try {
    const signal = openItemAbortCtrl ? openItemAbortCtrl.signal : undefined;
    const d = await api.item(id, { fields: fieldsToFetch.length > 0 ? fieldsToFetch : undefined, expandRelations: needRelations, signal });
    if (cur !== id || myToken !== openToken) return;  // switched items — discard stale data
    
    if (groupId === 'desc') {
      if (descEditor) {
        descEditor.value = d.desc || '';
        descEditor.togglePreview(true);
      }
      orig.desc = d.desc;
      orig._loaded_desc = true;
      const el = $('editor_desc_container');
      if (el) el.classList.remove('loading-skeleton');
    }
    if (groupId === 'ac') {
      if (acEditor) {
        acEditor.value = d.ac || '';
        acEditor.togglePreview(true);
      }
      orig.ac = d.ac;
      orig.has_ac = d.has_ac;
      orig._loaded_ac = true;
      const el = $('editor_ac_container');
      if (el) {
        el.style.display = d.has_ac ? 'block' : 'none';
        el.classList.remove('loading-skeleton');
      }
    }
    if (groupId === 'tags') {
      if (tagsEditor) tagsEditor.set(d.tags || '', /*silent*/true);
      orig.tags = d.tags;
      orig._loaded_tags = true;
    }
    if (groupId === 'area') {
      const el = $('s_area');
      if (el) el.value = d.area || '';
      orig.area = d.area || '';
      orig._loaded_area = true;
    }
    if (groupId === 'storypoints') {
      const el = $('s_storypoints');
      if (el) el.value = d.storypoints != null ? d.storypoints : '';
      orig.storypoints = d.storypoints;
      orig._loaded_storypoints = true;
    }
    if (groupId === 'remaining') {
      const el = $('s_remaining');
      if (el) el.value = d.remaining != null ? d.remaining : '';
      orig.remaining = d.remaining;
      orig._loaded_remaining = true;
    }
    if (groupId === 'completed') {
      const el = $('s_completed');
      if (el) el.value = d.completed != null ? d.completed : '';
      orig.completed = d.completed;
      orig._loaded_completed = true;
    }
    if (groupId === 'activity') {
      const el = $('s_activity_field');
      const val = d.activity || '';
      const picker = window.dynamicPickers && window.dynamicPickers['s_activity_field'];
      if (picker) picker.set(val, true);
      else if (el) el.value = val;
      orig.activity = val;
      orig._loaded_activity = true;
    }
    if (groupId === 'risk') {
      const el = $('s_risk');
      const val = d.risk || '';
      const picker = window.dynamicPickers && window.dynamicPickers['s_risk'];
      if (picker) picker.set(val, true);
      else if (el) el.value = val;
      orig.risk = val;
      orig._loaded_risk = true;
    }
    if (groupId === 'valuearea') {
      const el = $('s_valuearea');
      const val = d.valuearea || '';
      const picker = window.dynamicPickers && window.dynamicPickers['s_valuearea'];
      if (picker) picker.set(val, true);
      else if (el) el.value = val;
      orig.valuearea = val;
      orig._loaded_valuearea = true;
    }
    if (groupId === 'attachments') {
      atchState.list = Array.isArray(d.attachments) ? d.attachments.slice() : [];
      renderAttachments();
      orig._relationsLoaded = true;
    }
    if (groupId === 'deps') {
      loadDeps(id, d.deps);
      orig._relationsLoaded = true;
    }
    
    lockSidebarHeavy(false, [groupId]);
    refreshDirty();
  } catch(e) {
    if (e.name === 'AbortError') return;           // silently exit — a newer openItem() is running
    if (cur !== id || myToken !== openToken) return; // stale — discard
    setStatus('Failed to load lazy field: ' + e.message, true);
    lockSidebarHeavy(false, [groupId]);
  }
}
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
  renderBoard();
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
/* ---------- extensible chip filters (data-driven) ----------
   Add a field: one entry here + one in FILTER_FIELDS in api.js. */
const FILTERS=[
  {key:'state',label:'State',values:()=>projectStates.length?projectStates:['New','Active','Resolved','Closed','Removed']},
  {key:'type',label:'Type',values:()=>typeNames()},
  {key:'priority',label:'Priority',values:()=>[1,2,3,4],fmt:v=>'P'+v},
  {key:'assigned',label:'Assigned',values:()=>['me',...assignees],fmt:v=>v==='me'?(currentUser?`${currentUser} (me)`:'me'):v},
  {key:'iteration',label:'Sprint',values:()=>sprintPaths,fmt:p=>sprintNames[p]||p},
  {key:'tags',label:'Tags',values:()=>tagList},
];
function filterCount(){
  if (!window.filterManager) return 0;
  const ir = window.filterManager.getIR();
  let count = 0;
  const countRules = (rule) => {
    if (!rule) return 0;
    if (rule.kind === 'group') {
      return (rule.rules || []).reduce((acc, r) => acc + countRules(r), 0);
    }
    if (rule.kind === 'condition') {
      if (rule.value !== undefined && rule.value !== null) {
        if (Array.isArray(rule.value)) {
          return rule.value.length;
        }
        return String(rule.value).trim() !== '' ? 1 : 0;
      }
    }
    return 0;
  };
  count += countRules(ir.where);
  if (window.filterManager.isFollowed()) count++;
  return count;
}
function updateFilterCount(){const n=filterCount();const el=$('filt_count');if(el)el.textContent=n?('('+n+')'):'';}
function renderFilters(){
  const chipsEl = $('filterchips');
  const indEl = $('advanced-filter-indicator');
  
  if (!window.filterManager) return;
  const isAdv = window.filterManager.isAdvanced();

  if (isAdv) {
    if (chipsEl) chipsEl.style.display = 'none';
    if (indEl) indEl.style.display = 'flex';
    const all=$('filt_clear_all');if(all)all.style.visibility='visible';
    return;
  }
  
  if (chipsEl) chipsEl.style.display = 'block';
  if (indEl) indEl.style.display = 'none';

  const el=$('filterchips');el.innerHTML='';
  // toggle the static "Clear all" in the Find row — visibility (not display)
  // keeps its slot reserved so the search input never shifts when filters appear
  const all=$('filt_clear_all');if(all)all.style.visibility=filterCount()>0?'visible':'hidden';
  FILTERS.forEach(f=>{
    const allVals=f.values()||[];
    if(!allVals.length&&!window.filterManager.hasFieldFilters(f.key))return;   // skip empty rows (e.g. tags/sprints not loaded yet)
    
    const limit = 10;
    const isLarge = allVals.length > limit;
    let valsToShow = allVals;
    if(isLarge){
      const selected = allVals.filter(v => window.filterManager.getChipState(f.key, v) === 'in');
      const popular=getContextPopular(f.key, allVals);
      const union=new Set([...selected,...popular]);
      if(f.key==='assigned')union.add('me');
      valsToShow=allVals.filter(v=>union.has(String(v)));
    }

    const row=document.createElement('div');row.className='frow';
    const lab=document.createElement('span');lab.className='fl';lab.textContent=f.label;row.appendChild(lab);
    // per-row clear "x" sits left of the chips. ALWAYS rendered so the chip
    // alignment doesn't jump when it appears/disappears; visibility:hidden
    // keeps the slot reserved when this filter has no selection.
    const x=document.createElement('button');
    x.className='fclear';x.title='clear this filter';x.innerHTML='<ui-icon name="x"></ui-icon>';
    if(window.filterManager.hasFieldFilters(f.key))
      x.onclick=()=>{window.filterManager.clearField(f.key);};
    else{x.style.visibility='hidden';x.tabIndex=-1;}
    row.appendChild(x);
    valsToShow.forEach(v=>{
      const ch=document.createElement('span');ch.className='chip';
      const st=window.filterManager.getChipState(f.key, v);if(st)ch.classList.add(st);
      ch.textContent=f.fmt?f.fmt(v):v;
      ch.onclick=()=>{
        const curSt = window.filterManager.getChipState(f.key, v);
        if (curSt === 'out') {
          window.filterManager.removeChip(f.key, v);
        } else {
          window.filterManager.toggleChip(f.key, v, !curSt ? 'in' : 'out');
        }
      };
      row.appendChild(ch);
    });
    if(isLarge){
      const wrap=document.createElement('div');
      wrap.className='f-dropdown-container';

      const inp=document.createElement('input');
      inp.type='text';
      inp.className='tag-search';
      inp.placeholder='Search ' + f.label.toLowerCase() + '...';
      inp.autocomplete='off';
      wrap.appendChild(inp);

      const clearBtn=document.createElement('button');
      clearBtn.type='button';
      clearBtn.className='search-clear-btn';
      clearBtn.innerHTML='<ui-icon name="x"></ui-icon>';
      clearBtn.style.display='none';
      wrap.appendChild(clearBtn);

      const updateClearBtn=()=>{
        clearBtn.style.display=inp.value?'inline-flex':'none';
      };

      const dropdown=document.createElement('div');
      dropdown.className='f-dropdown';
      dropdown.style.display='none';
      wrap.appendChild(dropdown);

      const showMatches=(q)=>{
        const query=q.toLowerCase().trim();
        const shownSet=new Set(valsToShow.map(String));
        const matches=allVals.filter(v=>{
          if(shownSet.has(String(v)))return false;
          return String(f.fmt?f.fmt(v):v).toLowerCase().includes(query);
        });
        dropdown.innerHTML='';
        if(!matches.length){
          const empty=document.createElement('div');
          empty.className='f-dropdown-item empty';
          empty.textContent=window.i18n.t('filter.noMatches');
          dropdown.appendChild(empty);
        } else {
          matches.forEach(val=>{
            const item=document.createElement('div');
            item.className='f-dropdown-item';
            item.textContent=f.fmt?f.fmt(val):val;
            item.onmousedown=(e)=>{
              e.preventDefault();
              window.filterManager.toggleChip(f.key, val, 'in');
              inp.value='';
              updateClearBtn();
              dropdown.style.display='none';
              if (window.LayerManager) window.LayerManager.close(dropdown);
            };
            dropdown.appendChild(item);
          });
        }
        dropdown.style.display='flex';
        if (window.LayerManager) window.LayerManager.open(dropdown, null, { isPopover: true });
        dropdown.style.left='0';
        dropdown.style.right='auto';
        dropdown.style.top='100%';
        dropdown.style.bottom='auto';
        dropdown.style.marginTop='4px';
        dropdown.style.marginBottom='0';
        const rect=dropdown.getBoundingClientRect();
        if(rect.right>window.innerWidth){
          dropdown.style.left='auto';
          dropdown.style.right='0';
        }
        if(rect.bottom>window.innerHeight){
          dropdown.style.top='auto';
          dropdown.style.bottom='100%';
          dropdown.style.marginTop='0';
          dropdown.style.marginBottom='4px';
        }
      };

      inp.onfocus=()=>{
        updateClearBtn();
        showMatches(inp.value);
      };
      inp.oninput=()=>{
        updateClearBtn();
        showMatches(inp.value);
      };
      inp.onblur=()=>{
        dropdown.style.display='none';
        if (window.LayerManager) window.LayerManager.close(dropdown);
        clearBtn.style.display='none';
      };
      clearBtn.onmousedown=e=>{
        e.preventDefault();
      };
      clearBtn.onclick=e=>{
        e.stopPropagation();
        inp.value='';
        updateClearBtn();
        showMatches('');
        inp.focus();
      };
      inp.onkeydown=e=>{
        if(e.key==='Escape'){
          dropdown.style.display='none';
          if (window.LayerManager) window.LayerManager.close(dropdown);
          clearBtn.style.display='none';
          inp.blur();
        } else if(e.key==='Enter'){
          e.preventDefault();
          const firstItem=dropdown.querySelector('.f-dropdown-item:not(.empty)');
          if(firstItem){
            firstItem.dispatchEvent(new MouseEvent('mousedown'));
          }
        }
      };
      row.appendChild(wrap);
    }
    el.appendChild(row);
  });
  buildBulkControls();                      // keep the bulk-bar dropdowns in sync with loaded data
}
let applyTimer=null;
function scheduleApply(){clearTimeout(applyTimer);applyTimer=setTimeout(refresh,500);}  // debounce (long enough to click several chips)

/* ---------- tree ---------- */
function childrenUl(id){
  const ul=document.createElement('ul');const kids=store.kids[id]||[];
  if(!kids.length){const e=document.createElement('div');e.className='empty';e.textContent=window.i18n.t('tree.noChildren');ul.appendChild(e);}
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
  if(hasKids){tog.innerHTML=open?'<ui-icon name="chevron-down"></ui-icon>':'<ui-icon name="chevron-right"></ui-icon>';tog.onclick=e=>{e.stopPropagation();toggle(li,n,tog);};}
  else{tog.classList.add('leaf');}     // childless → blank spacer keeps labels aligned
  const dot=document.createElement('i');dot.className='dot';dot.style.background=tyColor(n.type);
  const lab=document.createElement('span');lab.className='lab';lab.textContent=`#${n.id} ${n.title}`;
  if(n.via&&n.via.length){const m=document.createElement('span');m.className='skip';m.innerHTML=' <ui-icon name="external-link"></ui-icon>';
    m.title='via '+n.via.map(i=>'#'+i).join(' → ')+' (not in filter)';lab.appendChild(m);}
  // Priority sits to the RIGHT of the title (between the label and the spacer),
  // so it stays close to the task name and never visually merges with the
  // right-edge tag chips.
  const prioEl=(badgeOn('priority','tree')&&n.priority)?(()=>{
    const pc=document.createElement('span');pc.className='prio';pc.textContent='P'+n.priority;
    pc.style.background=prioColor(n.priority);pc.title='priority '+n.priority;return pc;
  })():null;
  // A right-pushing spacer keeps the right-aligned cluster anchored regardless of
  // which badges the user has hidden via Badges; everything appended after it
  // sits on the right edge in insertion order.
  const sp=document.createElement('span');sp.className='rspacer';sp.style.cssText='flex:1';
  if(prioEl)row.append(cb,tog,dot,lab,prioEl,sp);
  else row.append(cb,tog,dot,lab,sp);
  if(badgeOn('tags','tree')&&n.tags){
    const ts=tagList_(n.tags);
    if(ts.length){const show=ts.slice(0,3),extra=ts.length-show.length;
      show.forEach(t=>{const tc=document.createElement('span');tc.className='ttag';tc.textContent=t;tc.style.background=personColor(t);tc.title=t;row.appendChild(tc);});
      if(extra>0){const tc=document.createElement('span');tc.className='ttag';tc.textContent='+'+extra;tc.style.background='var(--muted)';tc.title=ts.slice(3).join(', ');row.appendChild(tc);}
    }
  }
  if(badgeOn('state','tree')&&n.state){
    const bdg=document.createElement('span');bdg.className='badge';bdg.textContent=n.state;
    bdg.style.marginLeft='0';row.appendChild(bdg);
  }
  if(n.id===cur){row.classList.add('sel');selRow=row;}   // keep highlight across re-renders
  row.onclick=(e)=>{
    if(e.ctrlKey||e.metaKey){e.preventDefault();bulkToggle(n.id);return;}        // Ctrl/Cmd: toggle in selection
    if(e.shiftKey){e.preventDefault();bulkRange(n.id);return;}                    // Shift: select the range from the anchor
    openItem(n.id);   // plain click: open
  };
  li.appendChild(row);
  if(open&&hasKids)li.appendChild(childrenUl(n.id));    // auto-expand from shared state (never for a known-leaf)
  return li;
}
async function toggle(li,n,tog){
  if(store.expanded.has(n.id)){            // collapse (cached data stays)
    store.expanded.delete(n.id);
    const u=li.querySelector('ul');if(u)u.remove();tog.innerHTML='<ui-icon name="chevron-right"></ui-icon>';return;
  }
  tog.innerHTML='<ui-icon name="clock"></ui-icon>';tog.classList.add('busy');loadStart();
  try{await ensureKids(n.id);
    store.expanded.add(n.id);
    li.appendChild(childrenUl(n.id));
  }finally{tog.classList.remove('busy');tog.innerHTML='<ui-icon name="chevron-down"></ui-icon>';loadEnd();}
}
function activeText(){const t=$('search').value.trim();return (t && !/^\d+$/.test(t))?t:null;}
async function currentItems(){
  // the single source of truth for BOTH views: filters (+ optional title search)
  const order=$('f_sort').value||undefined,filters=window.filterManager.getIR(),text=activeText()||undefined;
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
function clearBulk(){
  bulkSel.clear();
  bulkAnchor=null;
  if(window.bulkTagsEditor) bulkTagsEditor.set('', true);
  if($('bulk_start')) $('bulk_start').value='';
  if($('bulk_target')) $('bulk_target').value='';
  syncBulkDatePicker(null, null);
  updateBulkBar();
  syncBulkRows();
  syncGraphBulk();
}
function syncBulkBarValues() {
  const ids = [...bulkSel];
  if (!ids.length) return;

  const firstNode = store.nodes[ids[0]];
  if (!firstNode) return;

  let commonState = firstNode.state;
  let commonPriority = firstNode.priority;
  let commonAssigned = firstNode.assigned;
  let commonIteration = firstNode.iteration;
  let commonParent = firstNode.parent;
  let commonStart = firstNode.start;
  let commonTarget = firstNode.target;

  for (let i = 1; i < ids.length; i++) {
    const n = store.nodes[ids[i]];
    if (!n) continue;
    if (n.state !== commonState) commonState = null;
    if (n.priority !== commonPriority) commonPriority = null;
    if (n.assigned !== commonAssigned) commonAssigned = null;
    if (n.iteration !== commonIteration) commonIteration = null;
    if (n.parent !== commonParent) commonParent = null;
    if (n.start !== commonStart) commonStart = null;
    if (n.target !== commonTarget) commonTarget = null;
  }

  const elState = $('bulk_state');
  if (elState) elState.value = commonState || '';

  const elPrio = $('bulk_prio');
  if (elPrio) elPrio.value = commonPriority ? String(commonPriority) : '';

  if (typeof bulkAssignedPicker !== 'undefined') {
    bulkAssignedPicker.set(commonAssigned || '', true);
  }
  if (typeof bulkSprintPicker !== 'undefined') {
    bulkSprintPicker.set(commonIteration || '', true);
  }
  if (typeof bulkParentPicker !== 'undefined') {
    bulkParentPicker.set(commonParent != null ? String(commonParent) : '', true);
  }

  const startVal = commonStart ? commonStart.slice(0, 10) : '';
  const targetVal = commonTarget ? commonTarget.slice(0, 10) : '';
  const bulkStart = $('bulk_start');
  const bulkTarget = $('bulk_target');
  if (bulkStart) bulkStart.value = startVal;
  if (bulkTarget) bulkTarget.value = targetVal;
  syncBulkDatePicker(startVal || null, targetVal || null);

  // Sync follow buttons visibility based on followed states
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get("followedItems").then(({ followedItems = {} }) => {
      let followCount = 0;
      ids.forEach(id => {
        if (followedItems[id]) {
          followCount++;
        }
      });
      const elFollow = $('bulk_follow_btn');
      const elUnfollow = $('bulk_unfollow_btn');
      if (elFollow && elUnfollow) {
        if (followCount === ids.length) {
          // All are followed -> Show only unfollow button
          elFollow.style.display = 'none';
          elUnfollow.style.display = '';
        } else if (followCount === 0) {
          // All are unfollowed -> Show only follow button
          elFollow.style.display = '';
          elUnfollow.style.display = 'none';
        } else {
          // Mixed states -> Show both buttons
          elFollow.style.display = '';
          elUnfollow.style.display = '';
        }
      }
    }).catch(() => {});
  }
}

function updateBulkBar(){
  const n=bulkSel.size;
  $('bulkbar').style.display=n?'flex':'none';
  $('bulk_count').textContent=n+' selected';
  if (n) {
    syncBulkBarValues();
  }
}

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
    (projectStates.length?projectStates:['New','Active','Resolved','Closed','Removed']).map(s=>`<option value="${htmlEsc(s)}">${htmlEsc(s)}</option>`).join('');}
  const it=$('bulk_iter');if(it){it.innerHTML='<option value="">Sprint…</option>'+
    sprintPaths.map(p=>`<option value="${htmlEsc(p)}">${htmlEsc(sprintNames[p]||p)}</option>`).join('');}
}
function syncSidebarField(field, ids) {
  if (cur == null || !ids.includes(cur)) return;
  const d = store.nodes[cur];
  if (!d) return;

  if (field === 'state') {
    const el = $('s_state');
    if (el) el.value = d.state || '';
    if (orig) orig.state = d.state || '';
  }
  else if (field === 'priority') {
    const el = $('s_prio');
    if (el) el.value = d.priority ? String(d.priority) : '';
    if (orig) orig.priority = d.priority || '';
  }
  else if (field === 'assigned') {
    if (typeof assignedEditor !== 'undefined') assignedEditor.set(d.assigned || '', true);
    if (orig) orig.assigned = d.assigned || '';
  }
  else if (field === 'iteration') {
    if (typeof sprintEditor !== 'undefined') sprintEditor.set(d.iteration || '', true);
    if (orig) orig.iter = d.iteration || '';
  }
  else if (field === 'parent') {
    if (typeof parentEditor !== 'undefined') parentEditor.set(d.parent != null ? String(d.parent) : '', true);
    if (orig) orig.parent = d.parent != null ? String(d.parent) : '';
  }
  else if (field.startsWith('tags_')) {
    if (typeof tagsEditor !== 'undefined') tagsEditor.set(d.tags || '', true);
    if (orig) orig.tags = d.tags || '';
  }
  else if (field === 'dates') {
    const startVal = (d.start || '').slice(0, 10);
    const targetVal = (d.target || '').slice(0, 10);
    const s_start = $('s_start');
    const s_target = $('s_target');
    if (s_start) s_start.value = startVal;
    if (s_target) s_target.value = targetVal;
    syncSideDatePicker(startVal, targetVal);
    if (orig) {
      orig.start = startVal;
      orig.target = targetVal;
    }
  }
  refreshDirty();
}

async function bulkApply(field,val){
  const ids=[...bulkSel];if(!ids.length)return;
  if(field==='assigned'&&val==='me')val=currentUser||'me';
  
  let labelVal = val;
  if (field === 'tags_add') labelVal = `Add tag "${val}"`;
  else if (field === 'tags_remove') labelVal = `Remove tag "${val}"`;
  else if (field === 'dates') labelVal = `dates [start: ${val.start || '(clear)'}, target: ${val.target || '(clear)'}]`;
  else if (val === '') labelVal = '(clear)';
  
  const fieldNamesMap = {
    state: 'State',
    priority: 'Priority',
    assigned: 'Assignee',
    iteration: 'Sprint',
    parent: 'Parent',
    tags_add: 'Tags (Add)',
    tags_remove: 'Tags (Remove)',
    dates: 'Dates'
  };
  const displayName = fieldNamesMap[field] || field;

  let htmlVal = `<span class="tagchip" style="background:var(--accent); margin:0 4px; display:inline-flex; vertical-align:middle; font-weight:600; border-radius:14px; padding:3px 10px; color:#fff;">${htmlEsc(labelVal)}</span>`;
  let itemsListHtml = '<div style="margin-top:10px; max-height:150px; overflow-y:auto; border:1px solid var(--line); border-radius:6px; padding:8px; background:var(--panel2); text-align:left;">';
  ids.forEach(id => {
    const node = store.nodes[id];
    const title = node ? node.title : '';
    const type = node ? node.type : '';
    itemsListHtml += `<div style="margin-bottom:6px; font-size:12px; display:flex; align-items:center; gap:6px;">` +
      `<i class="dot" style="background:${tyColor(type)}"></i>` +
      `<span style="color:var(--muted); font-weight:600; flex:none;">#${id}</span>` +
      `<span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--txt);">${htmlEsc(title)}</span>` +
      `</div>`;
  });
  itemsListHtml += '</div>';

  const msg = window.i18n.t('bulk.applyConfirm', {field:`<strong style="color:var(--txt); font-weight:700;">${htmlEsc(displayName)}</strong>`, value:htmlVal, count:ids.length}) + itemsListHtml;
  if(!await customConfirm(msg, window.i18n.t('bulk.applyTitle'))) {
    syncBulkBarValues();
    return;
  }
  
  loadStart(`updating ${ids.length} item(s)…`);
  
  try {
    const projConfig = await api.getConfig();
    const orgName = projConfig.org.replace(/\/$/, "");
    const projUrl = `https://dev.azure.com/${encodeURIComponent(orgName)}/${encodeURIComponent(projConfig.project)}`;
    
    let relationsMap = {};
    if (field === 'parent') {
      const rawItems = (await api.req("GET", `${projUrl}/_apis/wit/workitems?ids=${ids.join(",")}&$expand=relations&api-version=7.1`)).value || [];
      for (const item of rawItems) {
        relationsMap[item.id] = item.relations || [];
      }
    }
    
    const itemsOps = [];
    const undoOps = [];
    const oldsList = [];
    
    for (const id of ids) {
      const node = store.nodes[id];
      const itemOpsList = [];
      const itemUndoOpsList = [];
      
      if (field === 'state' || field === 'iteration' || field === 'assigned' || field === 'priority') {
        const fName = resolveBulkField(field);
        const path = `/fields/${fName}`;
        const curVal = node ? node[field] : undefined;
        
        let valStr = val;
        if (field === 'priority') valStr = val ? Number(val) : null;
        if (valStr === '' || valStr == null) {
          itemOpsList.push({ op: 'remove', path });
        } else {
          itemOpsList.push({ op: 'add', path, value: valStr });
        }
        
        if (curVal === '' || curVal == null) {
          itemUndoOpsList.push({ op: 'remove', path });
        } else {
          itemUndoOpsList.push({ op: 'add', path, value: (field === 'priority' ? Number(curVal) : curVal) });
        }
      }
      else if (field === 'tags_add' || field === 'tags_remove') {
        const path = '/fields/System.Tags';
        const curTagsStr = node ? node.tags : '';
        const curTags = tagList_(curTagsStr);
        const inputTags = tagList_(val);
        
        let newTags;
        if (field === 'tags_add') {
          const toAdd = inputTags.filter(it => !curTags.some(ct => ct.toLowerCase() === it.toLowerCase()));
          newTags = curTags.concat(toAdd);
        } else {
          newTags = curTags.filter(ct => !inputTags.some(it => it.toLowerCase() === ct.toLowerCase()));
        }
        
        const newTagsVal = newTags.join('; ');
        if (newTagsVal === '') {
          itemOpsList.push({ op: 'remove', path });
        } else {
          itemOpsList.push({ op: 'replace', path, value: newTagsVal });
        }
        
        if (curTagsStr === '') {
          itemUndoOpsList.push({ op: 'remove', path });
        } else {
          itemUndoOpsList.push({ op: 'replace', path, value: curTagsStr });
        }
      }
      else if (field === 'dates') {
        const startFieldName = 'Microsoft.VSTS.Scheduling.StartDate';
        const targetFieldName = detectedTargetField || 'Microsoft.VSTS.Scheduling.TargetDate';
        
        if ('start' in val) {
          const path = `/fields/${startFieldName}`;
          if (val.start === '' || val.start == null) {
            itemOpsList.push({ op: 'remove', path });
          } else {
            itemOpsList.push({ op: 'add', path, value: val.start });
          }
          const curStart = node ? node.start : undefined;
          if (curStart === '' || curStart == null) {
            itemUndoOpsList.push({ op: 'remove', path });
          } else {
            itemUndoOpsList.push({ op: 'add', path, value: curStart.slice(0, 10) });
          }
        }
        if ('target' in val) {
          const path = `/fields/${targetFieldName}`;
          if (val.target === '' || val.target == null) {
            itemOpsList.push({ op: 'remove', path });
          } else {
            itemOpsList.push({ op: 'add', path, value: val.target });
          }
          const curTarget = node ? node.target : undefined;
          if (curTarget === '' || curTarget == null) {
            itemUndoOpsList.push({ op: 'remove', path });
          } else {
            itemUndoOpsList.push({ op: 'add', path, value: curTarget.slice(0, 10) });
          }
        }
      }
      else if (field === 'parent') {
        const curParent = node ? node.parent : undefined;
        if (String(curParent) === String(val)) continue;
        
        oldsList.push({ id, oldParent: curParent });
        const rels = relationsMap[id] || [];
        const idx = rels.findIndex(r => r.rel === "System.LinkTypes.Hierarchy-Reverse");
        
        if (idx >= 0) {
          itemOpsList.push({ op: "remove", path: `/relations/${idx}` });
        }
        if (val !== '' && val != null) {
          itemOpsList.push({
            op: "add",
            path: "/relations/-",
            value: { rel: "System.LinkTypes.Hierarchy-Reverse", url: `${projUrl}/_apis/wit/workitems/${val | 0}` }
          });
        }
      }
      
      if (itemOpsList.length) {
        itemsOps.push({
          method: 'PATCH',
          uri: `/_apis/wit/workitems/${id}?api-version=7.1`,
          headers: { 'Content-Type': 'application/json-patch+json' },
          body: itemOpsList,
          id: id
        });
      }
      if (itemUndoOpsList.length) {
        undoOps.push({
          method: 'PATCH',
          uri: `/_apis/wit/workitems/${id}?api-version=7.1`,
          headers: { 'Content-Type': 'application/json-patch+json' },
          body: itemUndoOpsList
        });
      }
    }
    
    if (!itemsOps.length && field === 'parent') {
      loadEnd();
      bulkParentPicker.set('', true);
      return;
    }
    
    let ok = 0, fail = 0;
    for (let i = 0; i < itemsOps.length; i += 200) {
      const batch = itemsOps.slice(i, i + 200);
      const res = await api.batchUpdate(batch);
      const valueArray = res && res.value && Array.isArray(res.value) ? res.value : (Array.isArray(res) ? res : null);
      if (valueArray) {
        valueArray.forEach(itemRes => {
          if (itemRes.code === 200) ok++;
          else fail++;
        });
      } else {
        fail += batch.length;
      }
    }
    
    loadEnd();
    
    if (ok) {
      if (field === 'parent') {
        pushAction(`bulk parent on ${ids.length} item(s)`,
          async () => {
            await undoParentBatch(oldsList);
            syncSidebarField('parent', ids);
          },
          async () => {
            loadStart(`redoing bulk parent…`);
            try {
              for (let i = 0; i < itemsOps.length; i += 200) {
                await api.batchUpdate(itemsOps.slice(i, i + 200));
              }
            } finally {
              loadEnd();
              await afterUndo(null);
              syncSidebarField('parent', ids);
            }
          }
        );
      } else {
        pushAction(`bulk ${field} on ${ids.length} item(s)`,
          async () => {
            loadStart(`undoing bulk ${field}…`);
            try {
              for (let i = 0; i < undoOps.length; i += 200) {
                await api.batchUpdate(undoOps.slice(i, i + 200));
              }
            } finally {
              loadEnd();
              await afterUndo(null);
              syncSidebarField(field, ids);
            }
          },
          async () => {
            loadStart(`redoing bulk ${field}…`);
            try {
              for (let i = 0; i < itemsOps.length; i += 200) {
                await api.batchUpdate(itemsOps.slice(i, i + 200));
              }
            } finally {
              loadEnd();
              await afterUndo(null);
              syncSidebarField(field, ids);
            }
          }
        );
      }
    }
    
    setStatus(`bulk ${field}: ${ok} updated` + (fail ? `, ${fail} failed` : ''), !!fail);
    if (field === 'assigned' && val) registerNewAssignee(val);
    await refresh();
    syncSidebarField(field, ids);
    if (fail) setStatus('bulk ' + field + ': ' + ok + ' updated, ' + fail + ' failed', true);
    
  } catch (err) {
    loadEnd();
    setStatus('Error executing bulk update: ' + err.message, true);
    if (field === 'assigned') bulkAssignedPicker.set('', true);
    if (field === 'iteration') bulkSprintPicker.set('', true);
    if (field === 'parent') bulkParentPicker.set('', true);
  } finally {
  }
}

function resolveBulkField(field) {
  if (field === 'target') return detectedTargetField || api.FIELD_REGISTRY.target.ref;
  if (field in api.FIELD_REGISTRY) return api.FIELD_REGISTRY[field].ref;
  return field;
}

async function undoParentBatch(oldsList) {
  loadStart(`undoing parent bulk update…`);
  try {
    const ids = oldsList.map(o => o.id);
    const projConfig = await api.getConfig();
    const orgName = projConfig.org.replace(/\/$/, "");
    const projUrl = `https://dev.azure.com/${encodeURIComponent(orgName)}/${encodeURIComponent(projConfig.project)}`;
    const rawItems = (await api.req("GET", `${projUrl}/_apis/wit/workitems?ids=${ids.join(",")}&$expand=relations&api-version=7.1`)).value || [];
    const relsMap = {};
    for (const item of rawItems) {
      relsMap[item.id] = item.relations || [];
    }
    
    const batchOps = [];
    for (const o of oldsList) {
      const rels = relsMap[o.id] || [];
      const idx = rels.findIndex(r => r.rel === "System.LinkTypes.Hierarchy-Reverse");
      const list = [];
      if (idx >= 0) list.push({ op: "remove", path: `/relations/${idx}` });
      if (o.oldParent !== '' && o.oldParent != null) {
        list.push({ op: "add", path: "/relations/-", value: { rel: "System.LinkTypes.Hierarchy-Reverse", url: `${projUrl}/_apis/wit/workitems/${o.oldParent | 0}` } });
      }
      if (list.length) {
        batchOps.push({
          method: 'PATCH',
          uri: `/_apis/wit/workitems/${o.id}?api-version=7.1`,
          headers: { 'Content-Type': 'application/json-patch+json' },
          body: list
        });
      }
    }
    if (batchOps.length) {
      for (let i = 0; i < batchOps.length; i += 200) {
        await api.batchUpdate(batchOps.slice(i, i + 200));
      }
    }
  } catch(e) {
    console.error(e);
  } finally {
    loadEnd();
    await afterUndo(null);
    syncSidebarField('parent', ids);
  }
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
const HAND_FONT='"Segoe Print","Bradley Hand","Comic Sans MS",cursive';              // Excalidraw-ish hand-drawn label font (double quotes — cytoscape's font-family parser rejects single-quoted names)
function hexToRgb(h){h=String(h||'').replace('#','');if(h.length===3)h=h.split('').map(c=>c+c).join('');const n=parseInt(h||'0',16)||0;return [(n>>16)&255,(n>>8)&255,n&255];}
function mixHex(hex,toward,t){const a=hexToRgb(hex),b=hexToRgb(toward);return 'rgb('+a.map((v,i)=>Math.round(v+(b[i]-v)*t)).join(',')+')';}
// Excalidraw-style fill: a soft pastel tint of the type colour toward the canvas
const nodeFill=type=>{const c=TYPE_COLOR[type]||'#95a5a6';return document.body.classList.contains('light')?mixHex(c,'#ffffff',0.82):mixHex(c,'#11151b',0.70);};
const nodeStroke=type=>TYPE_COLOR[type]||'#95a5a6';
// Per-view "what to show" toggles. Each view exposes its own set of fields
// through the popover anchored on the Controls box. Choices persist as one
// nested object under `ado.badges`; the legacy `ado.graphBadges` flat key is
// migrated on first load.
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
// True iff the (view, key) toggle is on. View defaults to the current mode
// — pass an explicit view when the call site renders for a specific view
// regardless of what's focused (e.g., gstyle is always 'graph').
function badgeOn(k,view){view=view||mode;const m=badgesOn[view];return !m||m[k]!==false;}
function loadBadgesOn(){
  try{
    const s=localStorage.getItem('ado.badges');
    if(s){const p=JSON.parse(s);Object.keys(badgesOn).forEach(v=>{
      if(p[v]&&typeof p[v]==='object')Object.keys(badgesOn[v]).forEach(k=>{if(typeof p[v][k]==='boolean')badgesOn[v][k]=p[v][k];});
    });}
    const legacy=localStorage.getItem('ado.graphBadges');   // migrate v1 single-view format
    if(legacy){const op=JSON.parse(legacy);Object.keys(badgesOn.graph).forEach(k=>{if(typeof op[k]==='boolean')badgesOn.graph[k]=op[k];});}
  }catch(e){}
}
function saveBadgesOn(){try{localStorage.setItem('ado.badges',JSON.stringify(badgesOn));}catch(e){}}
// Short alias used by cytoscape style mappers — always read the graph's set, since
// mappers may evaluate at any time (e.g. after a theme change while another view is up).
const gOn=k=>badgeOn(k,'graph');
function gstyle(){return [
 {selector:'node',style:{'background-color':e=>nodeFill(e.data('type')),'shape':'round-rectangle',
   // clean label: only #id (↗ skip marker) · type, then the title
   'label':e=>{const v=e.data('via');return '#'+e.data('id')+(v&&v.length?' ↗':'')+' · '+e.data('type')+'\n'+e.data('title');},
   'color':txtColor,'font-family':HAND_FONT,'text-wrap':'wrap','text-max-width':'180px','font-size':'12px','text-valign':'center',
   'width':'210px','height':'label','padding':'12px',
   // top-left: child-count · priority · assignee (flat bookmarks); top-right: state (corner tag);
   // bottom-left: estimate (corner tag); bottom-centre: tags; bottom-right: sprint (corner tag).
   // Each slot is gated by badgeOn(key) — hidden slots collapse to BLANK_IMG (1px wide).
   'background-image':e=>{const est=e.data('est'),sp=e.data('iteration'),tg=gOn('tags')?tagDotsUri(e.data('tags')):null,
       est_=(gOn('est')&&est!=null&&est!=='')?cornerTagUri((+est)+'h','#5b6b7d','bl',60):null,
       st=(gOn('state')&&e.data('state'))?cornerTagUri(e.data('state'),stateColor(e.data('state')),'tr',120):null,
       spt=(gOn('iteration')&&sp)?cornerTagUri(sprintShort(sp),'#7a6cc4','br',110):null;return[
     (gOn('childCount')&&e.data('childCount')>0)?bookmarkUri('#3b7de0',e.data('childCount'),'down'):BLANK_IMG,
     (gOn('priority')&&e.data('priority'))?bookmarkUri(prioColor(e.data('priority')),'P'+e.data('priority'),'down'):BLANK_IMG,
     (gOn('assigned')&&e.data('assigned'))?avatarBadgeUri(e.data('assigned')):BLANK_IMG,
     st?st.uri:BLANK_IMG,
     est_?est_.uri:BLANK_IMG,
     tg?tg.uri:BLANK_IMG,
     spt?spt.uri:BLANK_IMG];},
   'background-image-containment':'inside','background-clip':'none','background-fit':'none',
   'background-width':e=>{const est=e.data('est'),sp=e.data('iteration'),tg=gOn('tags')?tagDotsUri(e.data('tags')):null;return[
     (gOn('childCount')&&e.data('childCount')>0)?'17px':'1px',
     (gOn('priority')&&e.data('priority'))?'17px':'1px',
     (gOn('assigned')&&e.data('assigned'))?'17px':'1px',
     ((gOn('state')&&e.data('state'))?cornerW(e.data('state'),120):1)+'px',
     ((gOn('est')&&est!=null&&est!=='')?cornerW((+est)+'h',60):1)+'px',(tg?tg.w:1)+'px',
     ((gOn('iteration')&&sp)?cornerW(sprintShort(sp),110):1)+'px'];},
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
   'background-image':e=>[(gOn('childCount')&&e.data('childCount')>0)?bookmarkUri('#3b7de0',e.data('childCount'),'down'):BLANK_IMG,
     (gOn('priority')&&e.data('priority'))?bookmarkUri(prioColor(e.data('priority')),'P'+e.data('priority'),'down'):BLANK_IMG,
     (gOn('assigned')&&e.data('assigned'))?avatarBadgeUri(e.data('assigned')):BLANK_IMG,
     (gOn('state')&&e.data('state'))?cornerTagUri(e.data('state'),stateColor(e.data('state')),'tr',120).uri:BLANK_IMG],
   'background-image-containment':'inside','background-clip':'none','background-fit':'none',
   'background-width':e=>[(gOn('childCount')&&e.data('childCount')>0)?'17px':'1px',
     (gOn('priority')&&e.data('priority'))?'17px':'1px',(gOn('assigned')&&e.data('assigned'))?'17px':'1px',
     ((gOn('state')&&e.data('state'))?cornerW(e.data('state'),120):1)+'px'],
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
  cy=cytoscape({container:$('cy'),style:gstyle(),wheelSensitivity:0.2,autounselectify:true,boxSelectionEnabled:false,hideEdgesOnViewport:true,textureOnViewport:true});
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
    if(!await customConfirm(window.i18n.t('dep.removeConfirm', {source:s, target:t}), window.i18n.t('dep.removeTitle')))return;
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
function saveNodePositions() {
  if (!cy || !projectName) return;
  const positions = {};
  cy.nodes().forEach(n => {
    if (n.isChildless()) {
      positions[n.id()] = n.position();
    }
  });
  try {
    localStorage.setItem('ado.positions:' + projectName, JSON.stringify(positions));
  } catch(e) {}
}
function loadNodePositions() {
  if (!projectName) return {};
  try {
    const data = localStorage.getItem('ado.positions:' + projectName);
    return data ? JSON.parse(data) : {};
  } catch(e) {
    return {};
  }
}
async function runLayout(fit){
  loadStart('calculating layout…');
  const cyl = $('cy-loading');
  if (cyl) cyl.style.display = 'flex';
  // yield main thread for 50ms so browser paints the loading spinner before thread freezes
  await new Promise(resolve => setTimeout(resolve, 50));
  
  const animate=cy.nodes().length<200;
  console.time("Graph: Layout execution");
  const l=cy.layout({name:'dagre',rankDir,ranker:'tight-tree',
    nodeSep:55,rankSep:110,edgeSep:25,animate,animationDuration:250,fit:false,padding:40});
  return new Promise(resolve => {
    l.one('layoutstop', () => {
      console.timeEnd("Graph: Layout execution");
      saveNodePositions();
      if(fit){
        if(animate) cy.animate({fit:{padding:40}},{duration:200});
        else cy.fit(undefined,40);
      }
      if (cyl) cyl.style.display = 'none';
      loadEnd();
      resolve();
    });
    l.run();
  });
}
async function renderGraph(opts){
  opts=opts||{};
  if(!cy)initCy();
  cy.resize();
  const token=++renderToken;                    // newest render wins; stale async results bail out
  let ids=[...reachable()].filter(id=>store.nodes[id]);
  if(!ids.length){cy.elements().remove();setStatus(window.i18n.t('status.nothingMatches'));return;}
  const originalCount = ids.length;
  let isTruncated = false;
  if (ids.length > maxNodesLimit) {
    ids = ids.slice(0, maxNodesLimit);
    isTruncated = true;
  }
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
  const cachedPositions = loadNodePositions();
  let hasAllCached = true;
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
      let pos = cachedPositions[id];
      if (!pos) {
        hasAllCached = false;
        pos = pe.nonempty()?{x:pe.position('x'),y:pe.position('y')+70}:undefined;
      }
      const data=Object.assign({},store.nodes[id]);              // shallow copy so we don't mutate store
      if(pid)data.parent=pid;else delete data.parent;            // normalize: only set if compound parent is in cy
      cy.add({group:'nodes',data,position:pos});added++;
    });
    cy.edges().remove();
    cy.add(edges.map(e=>({group:'edges',data:e})));             // edges carry no position -> no jump
  });
  const needsLayout = opts.relayout || !hasAllCached || removed > 0 || reparented > 0;
  if(needsLayout) await runLayout(opts.fit); // relayout on topology change; fit after layout settles
  else if(opts.fit && (added > 0 || removed > 0 || reparented > 0))cy.fit(undefined,40);                        // positions unchanged -> safe to fit now
  let statusText = `${ids.length} nodes · ${edges.length} edges`;
  if (isTruncated) statusText += ` (truncated from ${originalCount}, change 'Max nodes' in settings)`;
  setStatus(statusText);
  syncGraphBulk();                                              // re-apply the bulk highlight to (re)added nodes
  syncCyGrid();                                                 // align the dot grid with the current pan/zoom
}

/* ---------- board (sprints) ---------- */

// ISO date/datetime -> "30 May 2026" (UTC, so it never drifts a day across timezones)
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
async function annotateBoardTimes(){      // fill actual (active wall-clock) time per card + column Σ
  const token=boardToken;                 // current render's token — bail if a newer render starts
  const cards=[...document.querySelectorAll('#board .bcard[data-id]')];
  if(!cards.length)return;
  const ids=cards.map(c=>+c.dataset.id);
  const setCard=(c,act)=>{                 // act = hours or null
    const est=c.dataset.est?+c.dataset.est:null,lab=c.querySelector('.tlabel'),fill=c.querySelector('.tfill');
    if(act==null){if(lab)lab.innerHTML=est!=null?('est '+est+'h'):'<ui-icon name="clock"></ui-icon> —';return;}
    if(est!=null&&fill){const r=act/est;fill.style.width=Math.min(r,1)*100+'%';fill.style.background=r>1?'#e74c3c':'var(--accent)';
      if(lab)lab.textContent=`${Math.round(act)}/${est}h`;c.querySelector('.tbar').classList.toggle('over',r>1);}
    else if(lab)lab.innerHTML='<ui-icon name="clock"></ui-icon> '+hh(act);
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
    else if(lab&&sa>0)lab.innerHTML='Σ<ui-icon name="clock"></ui-icon> '+hh(ah);});
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
  items.forEach(n=>{const k=info[n.iteration]?n.iteration:'__none__';if(!groups.has(k))groups.set(k,[]);groups.get(k).push(n);});
  groups.forEach(arr=>arr.sort(cmpBySort));  // order within column = toolbar Sort
  const root=iters[0]?iters[0].path.split('\\')[0]:projectName;   // project root = "no sprint"
  const order=iters.map(it=>it.path);   // ALL dated sprints (empties revealed while dragging)
  order.push('__none__');   // always show the "No sprint" column (a drop target even when empty)
  const fragment=document.createDocumentFragment();
  order.forEach(k=>{
    const it=k==='__none__'?null:info[k];const fin=it?it.finish:null;
    const colItems=groups.get(k)||[];
    const col=document.createElement('div');col.className='bcol';
    if(it&&(!it.start||!it.finish))col.classList.add('dateless');
    const isPinned=pinnedSprints.has(k);
    if(k!=='__none__'&&!colItems.length&&!newSprints.has(k)&&!isPinned)col.classList.add('empty-sprint');   // hidden until a drag starts (but keep a just-created one visible)
    if(k==='__none__'&&!colItems.length)col.classList.add('collapsed');   // empty "No sprint" → narrow, expands on drag-hover
    if(it&&it.start&&it.finish&&today>=it.start.slice(0,10)&&today<=it.finish.slice(0,10))col.classList.add('current');
    const h=document.createElement('div');h.className='bhead';
    const dateBadge=it
      ?((!it.start||!it.finish)
        ?''
        :`<small>${(it.start||'').slice(0,10)}→${(fin||'').slice(0,10)}</small>`)
      :'';
    const pinBtn=k!=='__none__'?`<button class="pin-btn${isPinned?' pinned':''}" data-path="${htmlEsc(k)}" title="${isPinned?'Unpin column':'Pin column'}"><ui-icon name="pin"></ui-icon></button>`:'';
    h.innerHTML=(k==='__none__'?'No sprint':`${htmlEsc(it.name)} ${dateBadge} ${pinBtn}`)+'<br>'+colMeta(colItems);
    if(k!=='__none__'){
      h.style.cursor='pointer';h.title='open sprint timeline';
      h.addEventListener('click',(e)=>{
        if(e.target.closest('.pin-btn')){
          e.preventDefault();e.stopPropagation();
          togglePinSprint(k);
          return;
        }
        openSprint(k);
      });
    }
    const wrap=document.createElement('div');wrap.className='bcards';
    colItems.forEach(n=>wrap.appendChild(boardCard(n,fin,today)));
    if(!colItems.length){const ph=document.createElement('div');ph.className='empty';ph.textContent=window.i18n.t('board.dropHere');wrap.appendChild(ph);}
    col.dataset.field='iteration';col.dataset.val=(k==='__none__')?root:k;   // drop = change sprint
    col.append(h,wrap);fragment.appendChild(col);
  });
  if(canCreateSprint){                              // phantom "add sprint" column at the right end
    const add=document.createElement('div');add.className='bcol addcol';add.title='create a new sprint';
    add.innerHTML='<div class="addinner"><span class="plus">＋</span>New sprint</div>';
    add.onclick=()=>{if(suppressClick)return;pendingSprintItems=null;showSprintModal();};fragment.appendChild(add);   // plain click (not a drop)
  }
  el.appendChild(fragment);
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
  const fragment=document.createDocumentFragment();
  names.forEach(k=>{
    const arr=groups.get(k)||[];
    const col=document.createElement('div');col.className='bcol';
    const h=document.createElement('div');h.className='bhead';
    h.innerHTML=(k?htmlEsc(k):'Unassigned')+'<br>'+colMeta(arr);
    const wrap=document.createElement('div');wrap.className='bcards';
    arr.forEach(n=>wrap.appendChild(boardCard(n,null,'')));   // no overdue colouring in assignee view
    if(!arr.length){const ph=document.createElement('div');ph.className='empty';ph.textContent=window.i18n.t('board.dropHere');wrap.appendChild(ph);}
    col.dataset.field='assigned';col.dataset.val=k;   // drop = reassign
    col.append(h,wrap);fragment.appendChild(col);
  });
  el.appendChild(fragment);
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
  const fragment=document.createDocumentFragment();
  cols.forEach(k=>{
    const arr=groups.get(k)||[];
    const col=document.createElement('div');col.className='bcol';
    const h=document.createElement('div');h.className='bhead';
    h.innerHTML=(k?`<span class="sbadge" style="background:${stateColor(k)}">${htmlEsc(k)}</span>`:'(no state)')+'<br>'+colMeta(arr);
    const wrap=document.createElement('div');wrap.className='bcards';
    arr.forEach(n=>wrap.appendChild(boardCard(n,null,today)));   // overdue colouring by target date
    if(!arr.length){const ph=document.createElement('div');ph.className='empty';ph.textContent=window.i18n.t('board.dropHere');wrap.appendChild(ph);}
    col.dataset.field='state';col.dataset.val=k;   // drop = change state
    col.append(h,wrap);fragment.appendChild(col);
  });
  el.appendChild(fragment);
}
function boardCard(n,finish,today){
  const due=n.target?n.target.slice(0,10):(finish?finish.slice(0,10):null);
  const overdue=due&&due<today&&!DONE_STATES.includes(n.state);
  const c=document.createElement('div');c.className='bcard'+(overdue?' overdue':'')+(bulkSel.has(n.id)?' bulksel':'');
  c.style.borderLeftColor=tyColor(n.type);   // left marker = item TYPE colour
  c.dataset.id=n.id;c.dataset.est=(n.est!=null?n.est:'');
  // Gate each badge by the board's per-field toggle (in the Controls header).
  const showAssigned=badgeOn('assigned','board'),showType=badgeOn('type','board'),
        showPrio=badgeOn('priority','board'),showState=badgeOn('state','board'),
        showEst=badgeOn('est','board'),showTags=badgeOn('tags','board');
  const tagsHtml=(()=>{
    if(!showTags||!n.tags)return '';
    const ts=tagList_(n.tags);if(!ts.length)return '';
    const show=ts.slice(0,4),extra=ts.length-show.length;
    return `<div class="btags">`+
      show.map(t=>`<span class="ttag" style="background:${personColor(t)}" title="${htmlEsc(t)}">${htmlEsc(t)}</span>`).join('')+
      (extra>0?`<span class="ttag" style="background:var(--muted)" title="${htmlEsc(ts.slice(4).join(', '))}">+${extra}</span>`:'')+
      `</div>`;
  })();
  c.innerHTML=`<div class="bttl">${showAssigned&&n.assigned?personChipT(n.assigned):''}<span class="btxt">#${n.id} ${htmlEsc(n.title)}</span></div>`+
    `<div class="bmeta">`+(showType?`<span>${htmlEsc(n.type)}</span>`:'')+
    (showPrio&&n.priority?`<span class="prio" style="background:${prioColor(n.priority)}">P${n.priority}</span>`:'')+
    (showState?`<span>${htmlEsc(n.state)}</span>`:'')+(overdue?'<span class="od">overdue</span>':'')+`</div>`+
    tagsHtml+
    (showEst?`<div class="bfoot">`+(n.est!=null?`<div class="tbar"><div class="tfill"></div></div>`:'')+
      `<span class="tlabel">${n.est!=null?'est '+(+n.est)+'h':'<ui-icon name="clock"></ui-icon> …'}</span></div>`:'');
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
document.addEventListener('mouseup',async ()=>{
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
    if(fin&&fin<today&&!await customConfirm(window.i18n.t('move.sprintEndedConfirm', {sprint:it.name, date:fin, what:bulk?window.i18n.t('move.nItems',{count:bulkSel.size}):('#'+d.id)}), window.i18n.t('move.confirmTitle')))return;}
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
    `<span style="display:inline-flex;align-items:center;gap:6px">${curMark}<b>${htmlEsc(it.name)}</b></span> <span style="color:var(--muted)">${it.start.slice(0,10)} → ${it.finish.slice(0,10)} · ${items.length} items`+
    `${se?' · Σest '+(Math.round(se*10)/10)+'h':''} · <span id="g_act">Σ<ui-icon name="clock"></ui-icon> …</span></span>`+
    (canEditSprint?`<button class="btn" id="g_editdates" title="edit sprint dates"><ui-icon name="edit"></ui-icon> dates</button>`:'')+
    `<button class="btn${sprintGroup==='assignee'?' on':''}" id="g_group" title="group rows by assignee" style="margin-left:auto">by assignee</button>`;
  el.appendChild(top);
  const head=document.createElement('div');head.className='ghead';
  const hl=document.createElement('div');hl.className='glabel';head.appendChild(hl);
  const gd=document.createElement('div');gd.className='gdays';
  for(let i=0;i<N;i++){const d=new Date(s0+i*DAY),c=document.createElement('div');c.textContent=d.getUTCDate();if(i===todayIdx)c.classList.add('gtodaycol');gd.appendChild(c);}
  head.appendChild(gd);
  const hr=document.createElement('div');hr.className='gright';hr.innerHTML='<small>est · <ui-icon name="clock"></ui-icon></small>';head.appendChild(hr);
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
    right.innerHTML=`<span>${n.est!=null?'est '+(+n.est)+'h':''}</span> <span class="gact"><ui-icon name="clock"></ui-icon> …</span>`;
    row.append(lab,track,right);return row;
  };
  if(!items.length){const e=document.createElement('div');e.className='empty';e.style.padding='12px';e.textContent=window.i18n.t('empty.noItemsMatch');el.appendChild(e);}
  else if(sprintGroup==='assignee'){
    const groups=new Map();items.forEach(n=>{const k=n.assigned||'';if(!groups.has(k))groups.set(k,[]);groups.get(k).push(n);});
    const names=[...groups.keys()].filter(k=>k).sort((a,b)=>a.localeCompare(b));if(groups.has(''))names.push('');
    names.forEach(k=>{
      const arr=groups.get(k).sort(cmpBySort);
      const ge=arr.reduce((s,n)=>s+(n.est||0),0);
      const gh=document.createElement('div');gh.className='ggroup';gh.dataset.group=k;
      gh.innerHTML=`<span>${k?htmlEsc(k):'Unassigned'} · ${arr.length}${ge?' · Σest '+(Math.round(ge*10)/10)+'h':''}</span><span class="gact"><ui-icon name="clock"></ui-icon> …</span>`;
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
  if(!ids.length||ids.length>BOARD_TIME_CAP){const t=$('g_act');if(t)t.innerHTML='Σ<ui-icon name="clock"></ui-icon> —';return;}
  let t;try{t=await api.times(ids,tzOffset);}catch(e){return;}
  if(path!==openSprintPath)return;         // the open sprint changed — don't write stale times
  let tot=0;const byGroup={};
  document.querySelectorAll('#sprintview .grow[data-id]').forEach(r=>{
    const sec=t[r.dataset.id],g=r.querySelector('.gact');
    if(sec!=null){tot+=sec;if(g)g.innerHTML='<ui-icon name="clock"></ui-icon> '+hh(sec/3600);
      if(r.dataset.group!=null)byGroup[r.dataset.group]=(byGroup[r.dataset.group]||0)+sec;}
    else if(g)g.innerHTML='<ui-icon name="clock"></ui-icon> —';
  });
  document.querySelectorAll('#sprintview .ggroup[data-group]').forEach(h=>{
    const g=h.querySelector('.gact');if(g)g.innerHTML='<ui-icon name="clock"></ui-icon> '+hh((byGroup[h.dataset.group]||0)/3600);});
  const top=$('g_act');if(top)top.innerHTML='Σ<ui-icon name="clock"></ui-icon> '+hh(tot/3600);
}
function openSprint(path){
  if(!_sprint(path))return;
  boardScroll={l:$('board').scrollLeft,t:$('board').scrollTop};
  if(renderSprint(path)){openSprintPath=path;$('board').classList.remove('show');$('sprintview').classList.add('show');renderViewHelp();}
  else{showSprintEdit(path);}
}
function backToBoard(){
  openSprintPath=null;$('sprintview').classList.remove('show');$('board').classList.add('show');
  if(boardScroll){$('board').scrollLeft=boardScroll.l;$('board').scrollTop=boardScroll.t;}
  renderViewHelp();
}

/* ---------- Timeline (project-wide Gantt — one continuous axis, no sprint cut-off) ---------- */
const TL_DAY=86400000;
const TL_PX={day:26,week:9,month:3.3};            // px per day at each zoom
let tlLabelWidth = 240;                           // sticky left label column width
try {
  const savedTlWidth = localStorage.getItem('ado.tlLabelWidth');
  if (savedTlWidth) tlLabelWidth = parseInt(savedTlWidth, 10);
} catch(e) {}
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
    const lab=new Date(start).toLocaleString(window.i18n.getLang(),{month:'short'})+(m===0?(" '"+String(y).slice(2)):'');
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
    el.innerHTML='<div class="tlempty">'+(items.length?window.i18n.t('timeline.noDatedItems',{count:items.length}):window.i18n.t('status.nothingMatches'))+'</div>';
    setStatus(`${items.length} items · 0 scheduled`+capNote());return;
  }
  let min=Infinity,max=-Infinity;dated.forEach(n=>{if(n._tl.s<min)min=n._tl.s;if(n._tl.e>max)max=n._tl.e;});
  const today=Date.parse(new Date().toISOString().slice(0,10));
  min=Math.min(min,today);max=Math.max(max,today);                          // always include today
  const ms=new Date(min),me=new Date(max);
  const r0=Date.UTC(ms.getUTCFullYear(),ms.getUTCMonth(),1);                 // start of the first month
  const r1=Date.UTC(me.getUTCFullYear(),me.getUTCMonth()+3,1)-TL_DAY;        // +2 months of future runway past the last item / today
  const px=TL_PX[tlZoom]||TL_PX.week,LW=tlLabelWidth;
  const totalDays=Math.round((r1-r0)/TL_DAY)+1,W=Math.max(Math.round(totalDays*px),200);
  const xOf=t=>Math.round(((t-r0)/TL_DAY)*px);
  const wOf=(s,e)=>Math.max(Math.round(((e-s)/TL_DAY+1)*px),6);
  // axis (month labels) + gridlines (month / week) + weekend shading + today line
  const months=tlMonths(r0,r1);
  let axis='',grid='';
  months.forEach(m=>{const l=xOf(m.start),w=Math.round(((m.end-m.start)/TL_DAY+1)*px);
    axis+=`<div class="tlmonth" style="left:${l}px;width:${w}px">${htmlEsc(m.label)}</div>`;
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
  // Timeline label: dot + #id title + optional state pill + optional assignee chip — gated by Badges (timeline).
  const showTlPrio=badgeOn('priority','timeline'),showTlState=badgeOn('state','timeline'),showTlAsg=badgeOn('assigned','timeline');
  const lab=n=>`<div class="tllabel" style="width:${LW}px"><i class="dot" style="background:${tyColor(n.type)}"></i>`+
    (showTlAsg&&n.assigned?personChipT(n.assigned):'')+
    `<span class="tllab">#${n.id} ${htmlEsc(n.title)}</span>`+
    (showTlState&&n.state?`<span class="sbadge tlst" style="background:${stateColor(n.state)}">${htmlEsc(n.state)}</span>`:'')+
    `</div>`;
  // sp (optional) = the group's sprint window {s,e}; bars outside it are flagged.
  const rowHTML=(n,sp)=>{const t=n._tl,oos=sp&&(t.s<sp.s||t.e>sp.e);
    const tip=`${n.start?prettyDate(n.start):(t.soft?'sprint start':'?')} → ${(n.target||n.due)?prettyDate(n.target||n.due):(t.soft?'sprint finish':'?')}`+(oos?'  dates fall outside the sprint':'');
    const prefix=(showTlPrio&&n.priority)?('P'+n.priority+' '):'';
    return `<div class="tlrow${bulkSel.has(n.id)?' bulksel':''}" data-id="${n.id}">${lab(n)}<div class="tltrack" style="width:${W}px"><div class="tlbar${t.soft?' soft':''}${oos?' oos':''}" style="left:${xOf(t.s)}px;width:${wOf(t.s,t.e)}px;background-color:${tyColor(n.type)}" title="${htmlEsc(tip)}">${htmlEsc(prefix)}#${n.id} ${htmlEsc(n.title)}</div></div></div>`;};
  const byStart=(a,b)=>(a._tl.s-b._tl.s)||(a.id-b.id);
  const groupHead=(k,arr,sp)=>{
    let label=htmlEsc(k)+' · '+arr.length,track;
    if(sp){                                          // sprint grouping: draw the sprint's own date span as a reference line
      label+=`  (${ymd(sp.s)} → ${ymd(sp.e)})`;
      track=`<div class="tlsprintspan" style="left:${xOf(sp.s)}px;width:${wOf(sp.s,sp.e)}px" title="sprint window ${prettyDate(ymd(sp.s))} → ${prettyDate(ymd(sp.e))}"></div>`;
    }else{const datedInGroup = arr.filter(n=>n._tl);
      if(datedInGroup.length){const gs=Math.min(...datedInGroup.map(n=>n._tl.s)),ge=Math.max(...datedInGroup.map(n=>n._tl.e));
        track=`<div class="tlgroupbar" style="left:${xOf(gs)}px;width:${wOf(gs,ge)}px"></div>`;}
      else{track=`<div class="tlgroupbar" style="display:none"></div>`;}}
    return `<div class="tlgrouprow"><div class="tlgrouplabel" style="width:${LW}px">${label}</div><div class="tlgrouptrack" style="width:${W}px">${track}</div></div>`;};
  let rows='';
  if(tlGroup==='none'){
    dated.sort(byStart).forEach(n=>{rows+=rowHTML(n);});
    if(undated.length){
      rows+=`<div class="tlgrouprow"><div class="tlgrouplabel" style="width:${LW}px">No dates · ${undated.length}</div><div class="tlgrouptrack" style="width:${W}px"></div></div>`;
      undated.sort((a,b)=>a.id-b.id).forEach(n=>{rows+=`<div class="tlrow${bulkSel.has(n.id)?' bulksel':''}" data-id="${n.id}">${lab(n)}<div class="tltrack" style="width:${W}px"><span class="tlnodate">— no dates —</span></div></div>`;});
    }
  }else{
    const groups=new Map();
    items.forEach(n=>{const k=tlKey(n);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(n);});
    let keys=[...groups.keys()];keys=(tlGroup==='state')?orderStates(keys):keys.sort((a,b)=>a.localeCompare(b));
    keys.forEach(k=>{
      const arr=groups.get(k);
      const gDated=arr.filter(n=>n._tl).sort(byStart);
      const gUndated=arr.filter(n=>!n._tl).sort((a,b)=>a.id-b.id);
      let sp=null;
      if(tlGroup==='sprint'&&gDated.length){const it=_sprint(gDated[0].iteration);if(it&&it.start&&it.finish)sp={s:Date.parse(it.start.slice(0,10)),e:Date.parse(it.finish.slice(0,10))};}
      rows+=groupHead(k,arr,sp);
      gDated.forEach(n=>{rows+=rowHTML(n,sp);});
      gUndated.forEach(n=>{rows+=`<div class="tlrow${bulkSel.has(n.id)?' bulksel':''}" data-id="${n.id}">${lab(n)}<div class="tltrack" style="width:${W}px"><span class="tlnodate">— no dates —</span></div></div>`;});
    });
  }
  const prevScroll=el.scrollLeft;                  // preserve horizontal scroll across re-renders
  el.innerHTML=`<div class="tlcanvas">`+
    `<div class="tlhead"><div class="tlcorner" style="width:${LW}px">${months.length} mo · ${dated.length} scheduled<div class="tl-col-resizer"></div></div><div class="tlaxis" style="width:${W}px">${axis}${ticks}</div></div>`+
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
    if(view==='graph'){if(cy)cy.style(gstyle()).update();}   // graph mappers re-read on next paint
    else if(view==='board')renderBoard();
    else if(view==='tree'){const ts=$('tree').scrollTop;renderTree();$('tree').scrollTop=ts;}
    else if(view==='timeline')renderTimeline();
  });
  if(view==='graph'){
    const mn=$('f_max_nodes');
    if(mn){
      mn.value=String(maxNodesLimit);
      mn.onchange=()=>{
        maxNodesLimit=parseInt(mn.value,10);
        try{localStorage.setItem('ado.maxNodes',maxNodesLimit);}catch(e){}
        renderGraph({relayout:true,fit:true});
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
async function closePanel(force){
  if(!force&&dirty()&&!await customConfirm(window.i18n.t('editor.discardConfirm'), window.i18n.t('editor.discardTitle')))return;
  document.querySelectorAll('.sidebar-backdrop, .activity-backdrop, .editor-backdrop').forEach(el => el.remove());
  parentEditor.close();depBlockedByPicker.close();depBlocksPicker.close();closeMention();
  if($('side').classList.contains('fullscreen'))toggleFullscreen(false);   // restore inline width before hiding
  $('side').classList.add('hidden');
  $('resizer').style.display='none';cur=null;orig={};
  const cbtn = $('s_comment'); if (cbtn) cbtn.classList.remove('on');
  const chbtn = $('s_childbtn'); if (chbtn) chbtn.classList.remove('on');
  atchState.list=[];atchState.wid=null;atchState.uploading=0;renderAttachments();clearAttBlobs();
  depsState.blockedBy=[];depsState.blocks=[];renderDeps();
  if(selRow){selRow.classList.remove('sel');selRow=null;}
  if(cy)cy.$(':selected').unselect();
}
const mdToHtml=AdoLib.mdToHtml;                     // pure, hardened renderer in lib.js
// Description-preview renderer uses the project's work-item base URL so that
// `#123` shorthand in the markdown gets auto-linked back to that work item.
// descBase is derived from the open item's url (set by api.item()) — that way
// we don't have to know org/project here.
let descBase='';
function descRenderOpts(){return {workItemBase:descBase};}
// ADO attachment URLs require an Authorization header that the browser doesn't
// send for plain <img src=...>, so we fetch each one through the API helper and
// swap the src to a blob: URL. Cache keyed by attachment URL; revoked on item
// switch so memory doesn't grow without bound.
const attBlobs=new Map();
function isAdoAttachmentUrl(u){return /^https:\/\/[^/]+\/.+\/_apis\/wit\/attachments\/[^/?#]+/.test(u||'');}
function clearAttBlobs(){
  const urls=Array.from(attBlobs.values());
  attBlobs.clear();
  setTimeout(()=>{
    for(const u of urls)try{URL.revokeObjectURL(u);}catch(e){}
  },1000);
}
async function hydratePreviewImages(container){
  const pv=container||$('s_desc_prev');if(!pv)return;
  const imgs=Array.from(pv.querySelectorAll('img[data-src], img[src]'));
  const signal=openItemAbortCtrl?.signal;
  for(const img of imgs){
    if(signal?.aborted)return;
    // Prefer data-src (set by renderPreview to avoid unauthenticated browser fetch)
    const src=img.getAttribute('data-src')||img.getAttribute('src');
    if(!isAdoAttachmentUrl(src))continue;
    const cached=attBlobs.get(src);
    if(cached){img.src=cached;img.removeAttribute('data-src');continue;}
    try{
      const blob=await api.fetchAttachmentBlob(src,{signal});
      const blobUrl=URL.createObjectURL(blob);
      attBlobs.set(src,blobUrl);
      // Preview may have been re-rendered (or the user may have closed the panel)
      // by the time the blob arrives — only patch the element if it's still in the DOM.
      if(img.isConnected && !(signal?.aborted)){img.src=blobUrl;img.removeAttribute('data-src');}
    }catch(e){
      if(e.name==='AbortError')return;
      img.alt=(img.alt||'')+' [failed to load: '+e.message+']';
      img.style.opacity='.4';
    }
  }
}
function colorMentions(container){
  if(!container)return;
  const links=container.querySelectorAll('a[data-vss-mention]');
  links.forEach(a=>{
    const name=a.textContent.replace(/^@/,'').trim();
    if(!name)return;
    const baseColor=personColor(name);
    const bg=baseColor.replace('hsl','hsla').replace(')',', 0.12)');
    a.style.color=baseColor;
    a.style.background=bg;
  });
}

/* ---------- attachments + paste/drop + @mention typeahead (description editor) ----------
   atchState mirrors the AttachedFile relations for the open item. Add/remove are
   PATCHes against the work item's relations; uploads use the project attachments
   endpoint. Pasting an image into s_desc uploads it, links it, and inserts an
   image markdown at the caret in one shot. */
const atchState={list:[],wid:null,uploading:0};
function fmtBytes(n){if(n==null)return '';if(n<1024)return n+' B';if(n<1048576)return (n/1024).toFixed(1)+' K';return (n/1048576).toFixed(1)+' M';}
function isImageName(n){return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(n||'');}
function isImageMime(t){return /^image\//.test(t||'');}
function renderAttachments(){
  const box=$('s_atch');if(!box)return;
  const group=$('s_atch_group');
  const arr=atchState.list||[];
  if(cur==null || (group && group.classList.contains('sg-hidden'))){
    if(group)group.style.display='none';
    box.innerHTML='';
    return;
  }
  if(group)group.style.display='block';
  if(!arr.length&&!atchState.uploading){
    box.innerHTML=`<div class="atch-empty">${htmlEsc(window.i18n.t('attach.dropHere'))}</div>`;
    return;
  }
  const head=`<div class="atchhead"><span class="acount">${arr.length}</span> file(s)`+
    (atchState.uploading?` · <span class="spin"></span> uploading ${atchState.uploading}…`:'')+`</div>`;
  const rows=arr.map((a,i)=>{
    const icon=isImageName(a.name)?'<ui-icon name="image"></ui-icon>':'<ui-icon name="file-text"></ui-icon>';
    const size=a.size!=null?fmtBytes(a.size):'';
    return `<div class="atchrow" data-i="${i}">`+
      `<span class="aico">${icon}</span>`+
      `<a class="aname" href="#" title="${htmlEsc(a.url)}">${htmlEsc(a.name)}</a>`+
      (size?`<span class="asize">${size}</span>`:'')+
      `<button class="ains" title="insert ${isImageName(a.name)?'image':'link'} into the description"><ui-icon name="corner-down-left"></ui-icon> insert</button>`+
      `<button class="axdel" title="remove attachment"><ui-icon name="x"></ui-icon></button>`+
      `</div>`;
  }).join('');
  box.innerHTML=head+rows;
  box.querySelectorAll('.atchrow').forEach(row=>{
    const i=+row.dataset.i,a=arr[i];
    row.querySelector('.aname').onclick=async e=>{
      e.preventDefault();
      try{
        setStatus('downloading '+a.name+'…');
        const blob=await api.fetchAttachmentBlob(a.url);
        const url=URL.createObjectURL(blob);
        const link=document.createElement('a');
        link.href=url;
        link.download=a.name;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        setStatus('downloaded '+a.name);
      }catch(err){
        setStatus('download failed: '+err.message,true);
      }
    };
    row.querySelector('.ains').onclick=e=>{e.preventDefault();if(descEditor){descEditor.insertAtCursor((isImageName(a.name)?'!':'')+`[${a.name}](${a.url})`);refreshDirty();}};
    row.querySelector('.axdel').onclick=e=>{e.preventDefault();removeAttachment(a);};
  });
}
async function removeAttachment(a){
  if(cur==null)return;
  const wid=cur;
  if(!await customConfirm(window.i18n.t('attach.removeConfirm', {name:a.name}), window.i18n.t('attach.removeTitle')))return;
  try{
    const res=await api.removeAttachmentLink(wid,a.url);
    if(cur===wid){atchState.list=res.attachments||[];renderAttachments();}
    setStatus('#'+wid+' detached '+a.name);
  }catch(e){setStatus('detach failed: '+e.message,true);}
}

/* @mention typeahead: opens when the caret follows "@xxx" (no whitespace).
   Click / Enter inserts `@[Display](descriptor)` in markdown form, which
   mdToHtml then renders as an ADO mention anchor. */
const mentionState={open:false,query:'',start:-1,rows:[],idx:0,tok:0};
let mentionDebounceTimeout = null;
function findMentionTrigger(ta){
  const pos=ta.selectionStart;
  // Walk backward for an "@" with no whitespace or bracketing in between.
  // Stopping on [ ] ( ) prevents a freshly-inserted "@[Name](descriptor)" from
  // re-triggering the popup once the caret lands after the closing ).
  const v=ta.value;let i=pos-1;
  while(i>=0){
    const ch=v[i];
    if(ch==='@'){
      const prev=i>0?v[i-1]:'';
      // Trigger only when @ starts a token (after whitespace/punct/start).
      if(i===0||/\s|[(,;:.]/.test(prev))return {at:i,query:v.slice(i+1,pos)};
      return null;
    }
    if(ch==='\n'||ch===' '||ch==='\t'||ch==='['||ch===']'||ch==='('||ch===')')return null;
    if(pos-i>40)return null;             // give up after 40 chars without @
    i--;
  }
  return null;
}
let closeMentionTimeout = null;
function scheduleCloseMention(){
  if(closeMentionTimeout) clearTimeout(closeMentionTimeout);
  closeMentionTimeout = setTimeout(closeMention, 150);
}
function closeMention(){
  if(closeMentionTimeout){clearTimeout(closeMentionTimeout);closeMentionTimeout=null;}
  if(mentionDebounceTimeout){clearTimeout(mentionDebounceTimeout);mentionDebounceTimeout=null;}
  const p=$('s_mention');if(p){
    p.style.display='none';
    if (window.LayerManager) window.LayerManager.close(p);
  }
  mentionState.open=false;mentionState.query='';mentionState.start=-1;mentionState.rows=[];
}
function drawMention(){
  const p=$('s_mention');if(!p)return;
  if(!mentionState.rows.length){p.innerHTML='<div class="mempty">no matches — keep typing</div>';return;}
  p.innerHTML=mentionState.rows.map((r,i)=>
    `<div class="mrow${i===mentionState.idx?' on':''}" data-i="${i}">`+
      `<span class="mname">${htmlEsc(r.displayName)}${r.isGroup?' <span class="pcnone">(group)</span>':''}</span>`+
      (r.mail?`<span class="mmail">${htmlEsc(r.mail)}</span>`:'')+
    `</div>`).join('');
  p.querySelectorAll('.mrow').forEach(r=>{
    r.onmousedown=e=>{e.preventDefault();mentionState.idx=+r.dataset.i;pickMention();};
    r.onmouseenter=()=>{
      mentionState.idx=+r.dataset.i;
      p.querySelectorAll('.mrow').forEach((el, idx) => {
        el.classList.toggle('on', idx === mentionState.idx);
      });
    };
  });
}
function getCaretCoordinates(element, position) {
  const div = document.createElement('div');
  document.body.appendChild(div);

  const style = div.style;
  const computed = window.getComputedStyle(element);

  style.whiteSpace = 'pre-wrap';
  style.wordWrap = 'break-word';
  style.position = 'absolute';
  style.visibility = 'hidden';

  const properties = [
    'direction', 'boxSizing', 'width', 'height', 'overflowX', 'overflowY',
    'borderStyle', 'borderWidth', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontSize',
    'lineHeight', 'fontFamily', 'textAlign', 'textTransform', 'textIndent',
    'textDecoration', 'letterSpacing', 'wordSpacing'
  ];

  properties.forEach(prop => {
    style[prop] = computed[prop];
  });

  div.textContent = element.value.substring(0, position);

  const span = document.createElement('span');
  span.textContent = element.value.substring(position) || '.';
  div.appendChild(span);

  const lh = parseInt(computed.lineHeight || 0);
  const coordinates = {
    top: span.offsetTop + parseInt(computed.borderTopWidth || 0),
    left: span.offsetLeft + parseInt(computed.borderLeftWidth || 0),
    height: !isNaN(lh) && lh > 0 ? lh : (span.offsetHeight || 16)
  };

  document.body.removeChild(div);
  return coordinates;
}
function positionMention(){
  if(!activeEditor)return;
  const ta=activeEditor.textarea,p=$('s_mention');if(!ta||!p)return;
  
  if (p.parentNode !== activeEditor.container) {
    activeEditor.container.appendChild(p);
  }

  const caretPos=mentionState.start;
  const coords=getCaretCoordinates(ta,caretPos);
  const r=ta.getBoundingClientRect(),cr=activeEditor.container.getBoundingClientRect();
  
  const pWidth=p.offsetWidth||220;
  const maxLeft=r.right-cr.left-pWidth-8;
  const computedLeft=r.left-cr.left+coords.left-ta.scrollLeft;
  const left=Math.max(r.left-cr.left+8,Math.min(computedLeft,maxLeft));
  const top=r.top-cr.top+coords.top+coords.height-ta.scrollTop+4;
  
  p.style.left=left+'px';
  p.style.top=top+'px';
  p.style.maxWidth=r.width+'px';
}
async function openOrUpdateMention(){
  if(closeMentionTimeout){clearTimeout(closeMentionTimeout);closeMentionTimeout=null;}
  if(mentionDebounceTimeout){clearTimeout(mentionDebounceTimeout);mentionDebounceTimeout=null;}
  if(!activeEditor)return;
  const ta=activeEditor.textarea;if(!ta)return;
  const trig=findMentionTrigger(ta);
  if(!trig){closeMention();return;}
  mentionState.start=trig.at;mentionState.query=trig.query;mentionState.open=true;
  
  let p=$('s_mention');
  if (!p) {
    p = document.createElement('div');
    p.id = 's_mention';
    p.className = 'mention-pop';
    p.style.display = 'none';
    activeEditor.container.appendChild(p);
  }
  
  p.style.display='block';
  if (window.LayerManager) window.LayerManager.open(p, null, { isPopover: true });
  positionMention();
  const tok = ++mentionState.tok;
  if(!trig.query){
    let rows=[];
    try{rows=await api.searchIdentities("",20);}catch(e){rows=[];}
    if(tok!==mentionState.tok||!mentionState.open)return;
    mentionState.rows=rows;mentionState.idx=0;drawMention();
    return;
  }
  
  mentionDebounceTimeout = setTimeout(async () => {
    let rows=[];
    try{rows=await api.searchIdentities(trig.query,20);}catch(e){rows=[];}
    if(tok!==mentionState.tok||!mentionState.open)return;
    mentionState.rows=rows;mentionState.idx=0;drawMention();
  }, 150);
}
function pickMention(){
  if(!activeEditor)return;
  const r=mentionState.rows[mentionState.idx];if(!r)return;
  const ta=activeEditor.textarea,pos=ta.selectionStart,v=ta.value;
  
  let vsid = r.id || "";
  
  if (vsid.includes('.')) {
     vsid = vsid.split('.').pop();
  }
  
  if (/^[a-f0-9]{32}$/i.test(vsid)) {
     vsid = `${vsid.slice(0, 8)}-${vsid.slice(8, 12)}-${vsid.slice(12, 16)}-${vsid.slice(16, 20)}-${vsid.slice(20)}`;
  }
  
  const md = vsid ? `@[${r.displayName}](${vsid})` : `@${r.displayName}`;

  ta.value=v.slice(0,mentionState.start)+md+v.slice(pos);
  const at=mentionState.start+md.length;
  ta.selectionStart=ta.selectionEnd=at;
  closeMention();
  activeEditor.fireChange();
}
function moveMention(d){if(!mentionState.rows.length)return;
  mentionState.idx=(mentionState.idx+d+mentionState.rows.length)%mentionState.rows.length;
  drawMention();
}



/* ---------- full-screen editor toggle ---------- */
let _sideWidthBeforeFs='';
function toggleFullscreen(force){
  const side=$('side');
  const on=force===true||force===false?force:!side.classList.contains('fullscreen');
  let backdrop = document.getElementById('s_side_backdrop');
  if(on){
    if (!backdrop) {
      backdrop = document.createElement('div');
      backdrop.id = 's_side_backdrop';
      backdrop.className = 'modal-backdrop sidebar-backdrop';
      backdrop.onclick = () => toggleFullscreen(false);
      document.body.appendChild(backdrop);
    }
    // The user's inline width (from dragging #resizer) overrides the .fullscreen
    // class's `width: auto`. Stash it and clear so the panel fills the viewport,
    // then restore on exit.
    _sideWidthBeforeFs=side.style.width||'';
    side.style.width='';
    
    if (window.LayerManager) {
      window.LayerManager.open(side, backdrop);
    }
  } else {
    if (window.LayerManager) {
      window.LayerManager.close(side);
    }
    if (backdrop) {
      backdrop.remove();
    }
    if(_sideWidthBeforeFs){
      side.style.width=_sideWidthBeforeFs;
      _sideWidthBeforeFs='';
    }
  }
  side.classList.toggle('fullscreen',on);
  if(cy)try{cy.resize();}catch(e){}
}
function fmtDur(sec){const d=Math.floor(sec/86400),h=Math.floor(sec%86400/3600);return d?(d+'d'+(h?' '+h+'h':'')):(h+'h');}
let currentTimelineId = null;
let currentTimelineData = null;
async function loadTimeline(id){
  const el = $('s_time');
  if (!el) return;
  
  let t;
  if (id === currentTimelineId && currentTimelineData) {
    t = currentTimelineData;
  } else {
    el.innerHTML = '<span style="font-size:0.846rem; color:var(--muted);"><ui-icon name="clock"></ui-icon> loading timeline…</span>';
    try {
      t = await api.timeline(id, tzOffset);
      if (cur !== id) return;
      currentTimelineId = id;
      currentTimelineData = t;
    } catch(e) {
      el.innerHTML = '';
      return;
    }
  }
  
  el.innerHTML='';
  if(!t.durations)return;
  const ent=Object.entries(t.durations).sort((a,b)=>b[1]-a[1]);
  if(!ent.length)return;

  const currentView = localStorage.getItem('ado.timelineView') || 'bar';
  
  // Header with toggle button
  const hdr = document.createElement('div');
  hdr.style.display = 'flex';
  hdr.style.justify = 'space-between';
  hdr.style.alignItems = 'center';
  hdr.style.width = '100%';
  
  hdr.innerHTML = `<span style="font-weight:500; font-size:0.846rem; color:var(--muted); display:flex; align-items:center; gap:4px;"><ui-icon name="clock"></ui-icon> time in state</span>` +
    `<button class="stime-toggle-btn" title="Toggle view">${currentView === 'bar' ? '<ui-icon name="list"></ui-icon> List' : '<ui-icon name="bar-chart"></ui-icon> Bar'}</button>`;
  
  hdr.querySelector('.stime-toggle-btn').onclick = () => {
    localStorage.setItem('ado.timelineView', currentView === 'bar' ? 'list' : 'bar');
    loadTimeline(id);
  };
  el.appendChild(hdr);

  if (currentView === 'bar') {
    const totalSec = ent.reduce((sum, [_, sec]) => sum + sec, 0);
    
    // Progress bar
    const bar = document.createElement('div');
    bar.style.display = 'flex';
    bar.style.height = '8px';
    bar.style.borderRadius = '4px';
    bar.style.overflow = 'hidden';
    bar.style.background = 'var(--line)';
    bar.style.margin = '4px 0';
    bar.style.width = '100%';
    
    ent.forEach(([s, sec]) => {
      const seg = document.createElement('div');
      seg.style.width = `${(sec / totalSec) * 100}%`;
      seg.style.background = stateColor(s);
      seg.style.height = '100%';
      seg.title = `${s}: ${fmtDur(sec)}`;
      bar.appendChild(seg);
    });
    el.appendChild(bar);
    
    // Legend list
    const legend = document.createElement('div');
    legend.style.display = 'flex';
    legend.style.flexWrap = 'wrap';
    legend.style.gap = '0.308rem 0.615rem';
    legend.style.width = '100%';
    legend.innerHTML = ent.map(([s, sec]) => 
      `<span style="display:inline-flex; align-items:center; gap:4px; font-size:11px;">` +
        `<span style="width:6px; height:6px; border-radius:50%; background:${stateColor(s)}; display:inline-block;"></span>` +
        `<span style="color:var(--muted);">${htmlEsc(s)}:</span>` +
        `<b>${fmtDur(sec)}</b>` +
      `</span>`
    ).join('');
    el.appendChild(legend);
  } else {
    // List view
    const list = document.createElement('div');
    list.style.display = 'flex';
    list.style.flexWrap = 'wrap';
    list.style.gap = '0.308rem 0.615rem';
    list.style.alignItems = 'center';
    list.style.width = '100%';
    list.innerHTML = ent.map(([s, sec]) =>
      `<span><span class="sbadge" style="background:${stateColor(s)};font-size:9px">${htmlEsc(s)}</span> <b>${fmtDur(sec)}</b></span>`
    ).join('');
    el.appendChild(list);
  }
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
    `<span class="kidttl">#${k.id} ${htmlEsc(k.title||'')}</span>`+
    (k.state?`<span class="kidstate" style="background:${stateColor(k.state)}">${htmlEsc(k.state)}</span>`:'')+`</a>`).join('');
  box.querySelectorAll('.kidrow').forEach(r=>r.onclick=()=>openItem(+r.dataset.id));
}
function optionsPickerProvider(optionsList, placeholder) {
  return {
    localRows(q) {
      const query = (q || '').trim();
      const queryLower = query.toLowerCase();
      const out = [];

      // Prepend blank option if query is empty
      if (!query) {
        out.push({
          value: '',
          html: `<span class="ptitle pcnone">—</span>`
        });
      }

      const filtered = (optionsList || []).filter(opt => String(opt).toLowerCase().includes(queryLower));
      filtered.forEach(opt => {
        out.push({
          value: String(opt),
          html: `<span class="ptitle">${htmlEsc(opt || '—')}</span>`
        });
      });

      // If there's a custom query that isn't an exact match to any option, add a custom option
      if (query && !filtered.some(opt => String(opt).toLowerCase() === queryLower)) {
        out.push({
          value: query,
          html: `<span class="ptitle" style="font-style: italic;">Use custom: "${htmlEsc(query)}"</span>`
        });
      }

      return out;
    },
    renderCard(v, card) {
      if (!v) {
        card.innerHTML = `<span class="pcnone">${placeholder || '(no value)'}</span>`;
      } else {
        card.innerHTML = `<span class="pctitle">${htmlEsc(v)}</span>`;
      }
    }
  };
}

function createDynamicCombobox(elId, referenceName, optionsList, placeholder, initialVal) {
  const hidden = $(elId);
  if (!hidden) return;

  if (!window.dynamicPickers) window.dynamicPickers = {};

  hidden.value = initialVal || '';

  const picker = createCardPicker(elId, {
    provider: optionsPickerProvider(optionsList, placeholder),
    onChange: () => {
      hidden.dispatchEvent(new Event('input'));
      hidden.dispatchEvent(new Event('change'));
    }
  });
  picker.wire();
  picker.render();
  window.dynamicPickers[elId] = picker;
}

function createDynamicAssigneeField(elId, referenceName, initialVal, readOnly) {
  const hidden = $(elId);
  if (!hidden) return;

  if (!window.dynamicPickers) window.dynamicPickers = {};

  hidden.value = initialVal || '';

  const picker = createAssigneeField(elId, {
    onChange: () => {
      hidden.dispatchEvent(new Event('input'));
      hidden.dispatchEvent(new Event('change'));
    }
  });
  picker.wire();
  picker.render();
  if (readOnly) picker.setDisabled(true);
  window.dynamicPickers[elId] = picker;
}

function setupDynamicDatePicker(elId, referenceName, initialVal) {
  const trigger = $(elId + '_trigger');
  const popover = $(elId + '_picker');
  const hidden = $(elId);
  if (!trigger || !popover || !hidden) return;

  if (!window.dynamicDatePickers) window.dynamicDatePickers = {};

  const syncFunc = (val) => {
    if (val) {
      trigger.value = formatDisplayDate(val);
    } else {
      trigger.value = '';
    }
    hidden.value = val || '';
  };

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const show = !popover.classList.contains('show');
    document.querySelectorAll('.drp-popover.show').forEach(p => {
      if (p !== popover) {
        p.classList.remove('show');
        if (window.LayerManager) window.LayerManager.close(p);
      }
    });

    popover.classList.toggle('show', show);
    if (window.LayerManager) {
      if (show) window.LayerManager.open(popover, null, { isPopover: true });
      else window.LayerManager.close(popover);
    }
  });

  window.addEventListener('mousedown', (e) => {
    if (popover.classList.contains('show')) {
      if (!popover.contains(e.target) && !trigger.contains(e.target)) {
        popover.classList.remove('show');
        if (window.LayerManager) window.LayerManager.close(popover);
      }
    }
  });

  wireManualDateInput(elId + '_trigger', elId, null, (start) => {
    syncFunc(start);
    hidden.dispatchEvent(new Event('input'));
    hidden.dispatchEvent(new Event('change'));
  }, true);

  syncFunc(initialVal);

  window.dynamicDatePickers[elId] = new DateRangePicker(elId + '_picker', {
    start: initialVal,
    single: true,
    onChange: (range) => {
      const v = range.start;
      if (v !== hidden.value) {
        hidden.value = v;
        hidden.dispatchEvent(new Event('input'));
        hidden.dispatchEvent(new Event('change'));
      }
    }
  });
}

function renderSidebarHeader(d) {
  const hdr = $('s_hdr');
  if (!hdr) return;
  hdr.innerHTML=`<i class="dot" style="background:${tyColor(d.type)}"></i>#${d.id} ${htmlEsc(d.type)}`+
    ` <span class="sbadge" style="background:${stateColor(d.state)}">${htmlEsc(d.state)}</span>`+
    `<span id="s_rev" style="color:var(--muted);font-weight:400;font-size:11px;margin-left:4px;">${d.rev ? 'rev' + d.rev : ''}</span>`;
}

async function openItem(id){
  const myToken=++openToken;
  // Always ask before clobbering edits — including reopening the SAME dirty
  // item (which would otherwise silently reload from server and wipe the work).
  if(cur!=null&&dirty()&&!await customConfirm(window.i18n.t('editor.discardItemConfirm', {id:cur}), window.i18n.t('editor.discardTitle')))return;
  // After the async confirm another openItem() may have started — bail if superseded.
  if(myToken!==openToken)return;

  // ── Abort any in-flight fetch from a previous openItem ──
  if(openItemAbortCtrl)openItemAbortCtrl.abort();
  openItemAbortCtrl=new AbortController();
  const signal=openItemAbortCtrl.signal;

  // ── Synchronous reset: block saves for the OLD item ──
  cur=null;orig=null;                              // dirty()→false, quickSave()→early return
  lockSidebar(true);                               // dim + disable all interactive fields

  // ── Clear stale field values so the user never sees the previous item's data ──
  $('s_title').value='';$('s_hdr').innerHTML='<span style="color:var(--muted)">loading…</span>';
  if($('s_time')) $('s_time').innerHTML='';
  $('s_ctx').innerHTML='';$('s_kidlist').innerHTML='';
  if(descEditor)descEditor.value='';if(acEditor)acEditor.value='';
  atchState.list=[];atchState.uploading=0;renderAttachments();
  depsState.blockedBy=[];depsState.blocks=[];renderDeps();
  
  // Clear all custom field elements from the sidebar root and reset state
  document.querySelectorAll('#side .sgroup[data-sg^="cust:"]').forEach(el => el.remove());
  customFieldsState = [];

  closeMention();setSaveChip('idle');reactionCache.clear();

  // ── Highlight the target row in the tree ──
  if(selRow)selRow.classList.remove('sel');
  const targetRow=document.querySelector(`#tree .trow[data-id="${id}"]`);
  if(targetRow){targetRow.classList.add('sel');selRow=targetRow;}else{selRow=null;}

  // ── Show the sidebar shell + start the loading indicator ──
  $('side').classList.remove('hidden');$('resizer').style.display='block';
  $('child_form').style.display='none';closeCommentForm();
  const chbtn=$('s_childbtn');if(chbtn)chbtn.classList.remove('on');
  toggleActivityExpand(false);
  loadStart('loading #'+id+'…');

  const LIGHT_FIELDS = [
    api.FIELD_REGISTRY.id.ref,
    api.FIELD_REGISTRY.type.ref,
    api.FIELD_REGISTRY.title.ref,
    api.FIELD_REGISTRY.state.ref,
    api.FIELD_REGISTRY.assigned.ref,
    api.FIELD_REGISTRY.parent.ref,
    api.FIELD_REGISTRY.priority.ref,
    api.FIELD_REGISTRY.iteration.ref,
    api.FIELD_REGISTRY.start.ref,
    api.FIELD_REGISTRY.target.ref,
    api.FIELD_REGISTRY.finish.ref,
    api.FIELD_REGISTRY.due.ref,
    api.FIELD_REGISTRY.estimate.ref
  ];

  // ── Fetch the item (cancellable) ──
  let d;
  try{
    d = await api.item(id, { fields: LIGHT_FIELDS, expandRelations: false, signal });
  }catch(e){
    loadEnd();
    if(e.name==='AbortError')return;               // silently exit — a newer openItem() is already running
    setStatus('ERROR: '+e.message,true);lockSidebar(false);return;
  }
  loadEnd();
  if(myToken!==openToken)return;                   // a newer openItem() superseded this one

  // ── Populate the sidebar with fresh data ──
  cur=id;
  activeItemData=d;
  FollowManager.updateButtonState(id);
  api.comments(id).then(cs => {
    if (cur !== id) return;
    const badge = $('s_activity_count');
    if (badge) {
      badge.textContent = cs.length;
      badge.style.display = cs.length > 0 ? 'inline-block' : 'none';
    }
  });
  
  renderSidebarHeader(d);

  renderItemContext(d);
  $('s_link').href=d.url;$('s_title').value=d.title;assignedEditor.set(d.assigned||'',/*silent*/true);
  descBase=(d.url||'').replace(/\/\d+$/,'');     // e.g. ".../_workitems/edit" for #N autolinks in the preview
  
  // ── Fetch the fields definition and dynamically generate layout ──
  let fields = [];
  try {
    fields = await api.getWorkItemTypeFields(d.type);
  } catch(e) {
    console.error("Failed to load fields definition", e);
  }
  if(myToken!==openToken)return;                   // a newer openItem() superseded this one

  const side = $('side');
  if (side) {
    // Purge any existing dynamic groups from the DOM first
    side.querySelectorAll('.sgroup').forEach(el => {
      if (['area', 'storypoints', 'remaining', 'completed', 'risk', 'valuearea', 'start_target', 'due', 'estimate', 'time_in_state', 'activity', 'desc', 'ac'].includes(el.dataset.sg) || el.dataset.sg.startsWith('cust:')) {
        el.remove();
      }
    });
  }
  customFieldsState = [];
  descEditor = null;
  acEditor = null;

  const refNames = new Set(fields.map(f => f.referenceName));

  // Determine which groups exist
  const hasDesc = refNames.has("System.Description") || refNames.has("Microsoft.VSTS.TCM.ReproSteps");
  const hasAc = refNames.has("Microsoft.VSTS.Common.AcceptanceCriteria");
  const hasArea = refNames.has("System.AreaPath");
  const hasActivity = refNames.has("Microsoft.VSTS.Common.Activity");
  
  const hasStoryPoints = refNames.has("Microsoft.VSTS.Scheduling.StoryPoints");
  const hasRemaining = refNames.has("Microsoft.VSTS.Scheduling.RemainingWork");
  const hasCompleted = refNames.has("Microsoft.VSTS.Scheduling.CompletedWork");

  const hasRisk = refNames.has("Microsoft.VSTS.Common.Risk");
  const hasValueArea = refNames.has("Microsoft.VSTS.Common.ValueArea");

  const hasStartOrTarget = refNames.has("Microsoft.VSTS.Scheduling.StartDate") || 
                           refNames.has("Microsoft.VSTS.Scheduling.TargetDate") || 
                           refNames.has("Microsoft.VSTS.Scheduling.FinishDate");
  const hasDue = refNames.has("Microsoft.VSTS.Scheduling.DueDate");
  const hasEstimate = refNames.has("Microsoft.VSTS.Scheduling.OriginalEstimate");

  // Dynamically append the sgroup elements to #side
  if (side) {
    // 1. Description Group
    if (hasDesc) {
      const div = document.createElement('div');
      div.className = 'sgroup';
      div.dataset.sg = 'desc';
      div.id = 'editor_desc_container';
      side.appendChild(div);

      descEditor = new MarkdownEditor('editor_desc_container', {
        label: refNames.has("Microsoft.VSTS.TCM.ReproSteps") ? 'Repro Steps' : 'Description',
        placeholder: 'add description…',
        allowAttachments: true,
        allowMentions: true,
        onInput: refreshDirty
      });
    }

    // 2. Acceptance Criteria Group
    if (hasAc) {
      const div = document.createElement('div');
      div.className = 'sgroup';
      div.dataset.sg = 'ac';
      div.id = 'editor_ac_container';
      side.appendChild(div);

      acEditor = new MarkdownEditor('editor_ac_container', {
        label: 'Acceptance Criteria',
        placeholder: 'add acceptance criteria…',
        allowAttachments: false,
        allowMentions: true,
        onInput: refreshDirty
      });
    }

    // 3. Area Path Group
    if (hasArea) {
      const div = document.createElement('div');
      div.className = 'sgroup';
      div.dataset.sg = 'area';
      div.innerHTML = `<label>Area Path</label><input id="s_area">`;
      const input = div.querySelector('input');
      input.addEventListener('input', refreshDirty);
      input.addEventListener('change', () => quickSave('area'));
      side.appendChild(div);
    }

    // 4. Story Points Group
    if (hasStoryPoints) {
      const div = document.createElement('div');
      div.className = 'sgroup';
      div.dataset.sg = 'storypoints';
      div.innerHTML = `<label>Story Points</label><input id="s_storypoints" type="text">`;
      const input = div.querySelector('input');
      input.addEventListener('input', refreshDirty);
      input.addEventListener('change', () => quickSave('storypoints'));
      side.appendChild(div);
    }

    // 5. Remaining Group
    if (hasRemaining) {
      const div = document.createElement('div');
      div.className = 'sgroup';
      div.dataset.sg = 'remaining';
      div.innerHTML = `
        <label>Remaining</label>
        <div class="time-input-wrap">
          <input id="s_remaining" type="text" placeholder="e.g. 4h">
          <span class="time-hint-icon" title="Supports math expressions: h (hours), d (days = 8h), w (weeks = 40h), e.g. 1d + 4h"><ui-icon name="clock"></ui-icon></span>
          <div id="s_remaining_preview" class="time-preview-text"></div>
        </div>
      `;
      const input = div.querySelector('input');
      input.addEventListener('input', refreshDirty);
      input.addEventListener('change', () => quickSave('remaining'));
      side.appendChild(div);
      
      const prev = div.querySelector('.time-preview-text');
      if (input && prev) {
        const update = () => {
          const txt = formatTimePreview(input.value);
          prev.textContent = txt;
          prev.style.display = txt ? 'block' : 'none';
        };
        input.addEventListener('input', update);
        input.addEventListener('focus', update);
        input.addEventListener('blur', () => { prev.style.display = 'none'; });
      }
    }

    // 6. Completed Group
    if (hasCompleted) {
      const div = document.createElement('div');
      div.className = 'sgroup';
      div.dataset.sg = 'completed';
      div.innerHTML = `
        <label>Completed</label>
        <div class="time-input-wrap">
          <input id="s_completed" type="text" placeholder="e.g. 2d">
          <span class="time-hint-icon" title="Supports math expressions: h (hours), d (days = 8h), w (weeks = 40h), e.g. 1d + 4h"><ui-icon name="clock"></ui-icon></span>
          <div id="s_completed_preview" class="time-preview-text"></div>
        </div>
      `;
      const input = div.querySelector('input');
      input.addEventListener('input', refreshDirty);
      input.addEventListener('change', () => quickSave('completed'));
      side.appendChild(div);
      
      const prev = div.querySelector('.time-preview-text');
      if (input && prev) {
        const update = () => {
          const txt = formatTimePreview(input.value);
          prev.textContent = txt;
          prev.style.display = txt ? 'block' : 'none';
        };
        input.addEventListener('input', update);
        input.addEventListener('focus', update);
        input.addEventListener('blur', () => { prev.style.display = 'none'; });
      }
    }

    // 7. Activity Group
    if (hasActivity) {
      const div = document.createElement('div');
      div.className = 'sgroup';
      div.dataset.sg = 'activity';
      const elId = 's_activity_field';
      
      div.innerHTML = `
        <label>Activity</label>
        <div style="position:relative; width:100%">
          <input type="hidden" id="${elId}">
          <div class="prow-field">
            <button type="button" class="btn pcard" id="${elId}_card" title="click to change value"></button>
          </div>
          <div id="${elId}_pick" class="ppick" style="display:none">
            <input id="${elId}_search" class="psearch" placeholder="search options…  (Esc to cancel)" autocomplete="off">
            <div id="${elId}_results" class="presults"></div>
          </div>
        </div>
      `;
      
      const hidden = div.querySelector('input[type="hidden"]');
      hidden.addEventListener('input', refreshDirty);
      hidden.addEventListener('change', () => quickSave('activity'));
      side.appendChild(div);
      
      const allowedVals = api.FIELD_REGISTRY.activity && api.FIELD_REGISTRY.activity.allowedValues ? api.FIELD_REGISTRY.activity.allowedValues : [];
      createDynamicCombobox(elId, 'microsoft.vsts.common.activity', allowedVals, 'Activity', '');
    }

    // 8. Risk Group
    if (hasRisk) {
      const div = document.createElement('div');
      div.className = 'sgroup';
      div.dataset.sg = 'risk';
      const elId = 's_risk';
      
      div.innerHTML = `
        <label>Risk</label>
        <div style="position:relative; width:100%">
          <input type="hidden" id="${elId}">
          <div class="prow-field">
            <button type="button" class="btn pcard" id="${elId}_card" title="click to change value"></button>
          </div>
          <div id="${elId}_pick" class="ppick" style="display:none">
            <input id="${elId}_search" class="psearch" placeholder="search options…  (Esc to cancel)" autocomplete="off">
            <div id="${elId}_results" class="presults"></div>
          </div>
        </div>
      `;
      
      const hidden = div.querySelector('input[type="hidden"]');
      hidden.addEventListener('input', refreshDirty);
      hidden.addEventListener('change', () => quickSave('risk'));
      side.appendChild(div);
      
      const allowedVals = api.FIELD_REGISTRY.risk && api.FIELD_REGISTRY.risk.allowedValues ? api.FIELD_REGISTRY.risk.allowedValues : [];
      createDynamicCombobox(elId, 'microsoft.vsts.common.risk', allowedVals, 'Risk', '');
    }

    // 9. Value Area Group
    if (hasValueArea) {
      const div = document.createElement('div');
      div.className = 'sgroup';
      div.dataset.sg = 'valuearea';
      const elId = 's_valuearea';
      
      div.innerHTML = `
        <label>Value Area</label>
        <div style="position:relative; width:100%">
          <input type="hidden" id="${elId}">
          <div class="prow-field">
            <button type="button" class="btn pcard" id="${elId}_card" title="click to change value"></button>
          </div>
          <div id="${elId}_pick" class="ppick" style="display:none">
            <input id="${elId}_search" class="psearch" placeholder="search options…  (Esc to cancel)" autocomplete="off">
            <div id="${elId}_results" class="presults"></div>
          </div>
        </div>
      `;
      
      const hidden = div.querySelector('input[type="hidden"]');
      hidden.addEventListener('input', refreshDirty);
      hidden.addEventListener('change', () => quickSave('valuearea'));
      side.appendChild(div);
      
      const allowedVals = api.FIELD_REGISTRY.valuearea && api.FIELD_REGISTRY.valuearea.allowedValues ? api.FIELD_REGISTRY.valuearea.allowedValues : [];
      createDynamicCombobox(elId, 'microsoft.vsts.common.valuearea', allowedVals, 'Value Area', '');
    }

    // 10. Start — Target Date Group
    if (hasStartOrTarget) {
      const div = document.createElement('div');
      div.className = 'sgroup';
      div.dataset.sg = 'start_target';
      div.innerHTML = `
        <label>Start — Target</label>
        <div class="drp-wrapper" style="position:relative;">
          <div style="position:relative; display:flex; align-items:center; width:100%;">
            <input type="text" class="btn pcard" id="side-range-trigger" placeholder="Select dates..." style="width:100%; text-align:left; padding-right:24px; cursor:text;" autocomplete="off">
            <span style="position:absolute; right:8px; color:var(--muted); font-size:10px; pointer-events:none;">▼</span>
          </div>
          <div id="side-range-picker" class="drp-popover"></div>
        </div>
        <input id="s_start" type="hidden">
        <input id="s_target" type="hidden">
      `;
      const startInp = div.querySelector('#s_start');
      const targetInp = div.querySelector('#s_target');
      startInp.addEventListener('input', refreshDirty);
      startInp.addEventListener('change', () => quickSave('start'));
      targetInp.addEventListener('input', refreshDirty);
      targetInp.addEventListener('change', () => quickSave('target'));
      side.appendChild(div);
    }

    // 11. Due Date Group
    if (hasDue) {
      const div = document.createElement('div');
      div.className = 'sgroup';
      div.dataset.sg = 'due';
      div.innerHTML = `
        <label>Due</label>
        <div class="drp-wrapper" style="position:relative;">
          <div style="position:relative; display:flex; align-items:center; width:100%;">
            <input type="text" class="btn pcard" id="side-due-trigger" placeholder="Select date..." style="width:100%; text-align:left; padding-right:24px; cursor:text;" autocomplete="off">
            <span style="position:absolute; right:8px; color:var(--muted); font-size:10px; pointer-events:none;">▼</span>
          </div>
          <div id="side-due-picker" class="drp-popover"></div>
        </div>
        <input id="s_due" type="hidden">
      `;
      const dueInp = div.querySelector('#s_due');
      dueInp.addEventListener('input', refreshDirty);
      dueInp.addEventListener('change', () => quickSave('due'));
      side.appendChild(div);
    }

    // 12. Original Estimate Group
    if (hasEstimate) {
      const div = document.createElement('div');
      div.className = 'sgroup';
      div.dataset.sg = 'estimate';
      div.innerHTML = `
        <label>Est h</label>
        <div class="time-input-wrap">
          <input id="s_est" type="text" placeholder="e.g. 1d + 2h">
          <span class="time-hint-icon" title="Supports math expressions: h (hours), d (days = 8h), w (weeks = 40h), e.g. 1d + 4h"><ui-icon name="clock"></ui-icon></span>
          <div id="s_est_preview" class="time-preview-text"></div>
        </div>
      `;
      const input = div.querySelector('input');
      input.addEventListener('input', refreshDirty);
      input.addEventListener('change', () => quickSave('estimate'));
      side.appendChild(div);
      const prev = div.querySelector('.time-preview-text');
      if (input && prev) {
        const update = () => {
          const txt = formatTimePreview(input.value);
          prev.textContent = txt;
          prev.style.display = txt ? 'block' : 'none';
        };
        input.addEventListener('input', update);
        input.addEventListener('focus', update);
      }
    }

    // 7.5. Time in State Timeline
    const hasSchedule = refNames.has("Microsoft.VSTS.Scheduling.StartDate") || 
                        refNames.has("Microsoft.VSTS.Scheduling.TargetDate") || 
                        refNames.has("Microsoft.VSTS.Scheduling.FinishDate") || 
                        refNames.has("Microsoft.VSTS.Scheduling.DueDate") || 
                        refNames.has("Microsoft.VSTS.Scheduling.OriginalEstimate");
    if (hasSchedule) {
      const div = document.createElement('div');
      div.className = 'sgroup';
      div.dataset.sg = 'time_in_state';
      div.innerHTML = `<div id="s_time" class="stime"></div>`;
      side.appendChild(div);
    }

    // 8. Custom Fields
    const customFields = fields.filter(f => !api.isCoreField(f.referenceName));
    customFields.forEach(cf => {
      // Inject fallbacks if ADO didn't provide allowed values
      if ((!cf.allowedValues || cf.allowedValues.length === 0) && window.api && window.api.FIELD_REGISTRY) {
        const regField = Object.values(window.api.FIELD_REGISTRY).find(r => r.ref && r.ref.toLowerCase() === cf.referenceName.toLowerCase());
        if (regField && regField.allowedValues && regField.allowedValues.length > 0) {
          cf.allowedValues = regField.allowedValues;
          cf.hasAllowedValues = true;
        }
      }

      const elId = getCustomFieldElementId(cf.referenceName);
      const sgId = 'cust:' + cf.referenceName;
      const div = document.createElement('div');
      div.className = 'sgroup';
      div.dataset.sg = sgId;
      div.innerHTML = `<label>${htmlEsc(cf.name)}</label>`;

      const type = (cf.type || '').toLowerCase();
      let input;
      if (type === 'html' || type === 'plaintext') {
        const wrapper = document.createElement('div');
        wrapper.id = elId + '_editor_container';
        div.appendChild(wrapper);
        side.appendChild(div);

        if (!window.customHtmlEditors) window.customHtmlEditors = {};
        const editor = new MarkdownEditor(wrapper.id, {
          placeholder: 'Add ' + cf.name + '...',
          onInput: () => { refreshDirty(); }
        });
        if (cf.readOnly) editor.setDisabled(true);
        window.customHtmlEditors[cf.referenceName] = editor;
      } else if (type === 'datetime') {
        const wrapper = document.createElement('div');
        wrapper.className = 'drp-wrapper';
        wrapper.style.position = 'relative';
        wrapper.innerHTML = `
          <div style="position:relative; display:flex; align-items:center; width:100%;">
            <input type="text" class="btn pcard" id="${elId}_trigger" placeholder="Select date..." style="width:100%; text-align:left; padding-right:24px; cursor:text;" autocomplete="off" ${cf.readOnly ? 'disabled' : ''}>
            <span style="position:absolute; right:8px; color:var(--muted); font-size:10px; pointer-events:none;">▼</span>
          </div>
          <div id="${elId}_picker" class="drp-popover"></div>
        `;
        div.appendChild(wrapper);
        
        const hidden = document.createElement('input');
        hidden.type = 'hidden';
        hidden.id = elId;
        hidden.addEventListener('input', refreshDirty);
        hidden.addEventListener('change', () => quickSave('cust:' + cf.referenceName));
        div.appendChild(hidden);
        side.appendChild(div);

        setupDynamicDatePicker(elId, cf.referenceName, '');
      } else if (cf.allowedValues && cf.allowedValues.length > 0) {
        const wrapper = document.createElement('div');
        wrapper.innerHTML = `
          <input type="hidden" id="${elId}">
          <div class="prow-field">
            <button type="button" class="btn pcard" id="${elId}_card" title="click to change value" ${cf.readOnly ? 'disabled' : ''}></button>
          </div>
          <div id="${elId}_pick" class="ppick" style="display:none">
            <input id="${elId}_search" class="psearch" placeholder="search options…  (Esc to cancel)" autocomplete="off">
            <div id="${elId}_results" class="presults"></div>
          </div>
        `;
        div.appendChild(wrapper);
        
        const hidden = wrapper.querySelector('input[type="hidden"]');
        hidden.addEventListener('input', refreshDirty);
        hidden.addEventListener('change', () => quickSave('cust:' + cf.referenceName));
        
        div.appendChild(wrapper);
        side.appendChild(div);

        createDynamicCombobox(elId, cf.referenceName, cf.allowedValues, cf.name, '');
      } else if (cf.isIdentity || type === 'identity') {
        const wrapper = document.createElement('div');
        wrapper.innerHTML = `
          <input type="hidden" id="${elId}">
          <div class="prow-field">
            <button type="button" class="btn pcard" id="${elId}_card" title="click to change value" ${cf.readOnly ? 'disabled' : ''}></button>
          </div>
          <div id="${elId}_pick" class="ppick" style="display:none">
            <input id="${elId}_search" class="psearch" placeholder="search people…  (Esc to cancel)" autocomplete="off">
            <div id="${elId}_results" class="presults"></div>
          </div>
        `;
        div.appendChild(wrapper);
        
        const hidden = wrapper.querySelector('input[type="hidden"]');
        hidden.addEventListener('input', refreshDirty);
        hidden.addEventListener('change', () => quickSave('cust:' + cf.referenceName));
        
        div.appendChild(wrapper);
        side.appendChild(div);

        createDynamicAssigneeField(elId, cf.referenceName, '', cf.readOnly);
      } else {
        input = document.createElement('input');
        input.type = (type === 'double' || type === 'integer') ? 'number' : 'text';
        input.id = elId;
        if (cf.readOnly) input.disabled = true;
        input.addEventListener('input', refreshDirty);
        input.addEventListener('change', () => quickSave('cust:' + cf.referenceName));
        div.appendChild(input);
        side.appendChild(div);
      }

      customFieldsState.push({
        referenceName: cf.referenceName,
        name: cf.name,
        type: cf.type,
        readOnly: cf.readOnly,
        isIdentity: cf.isIdentity || type === 'identity',
        elementId: elId,
        hasAllowedValues: cf.allowedValues && cf.allowedValues.length > 0
      });

      // Add dynamically to SIDE_GROUPS so it shows up in Customize
      let existingGroup = SIDE_GROUPS.find(g => g.id === sgId);
      if (!existingGroup) {
        SIDE_GROUPS.push({
          id: sgId,
          label: 'Custom: ' + cf.name,
          customType: cf.type,
          allowedValues: cf.allowedValues,
          isIdentity: cf.isIdentity || type === 'identity'
        });
      } else {
        existingGroup.customType = cf.type;
        existingGroup.allowedValues = cf.allowedValues;
        existingGroup.isIdentity = cf.isIdentity || type === 'identity';
      }
    });
  }

  activeWType = d.type;
  const customFieldIds = fields
    .filter(cf => !api.isCoreField(cf.referenceName) && cf.isOnForm)
    .map(cf => ({ id: 'cust:' + cf.referenceName, formGroup: cf.formGroup, fieldType: cf.type }));

  const offFormFields = fields.filter(f => !f.isOnForm).map(f => 'cust:' + f.referenceName);
  loadSideLayout(activeWType, offFormFields, customFieldIds);
  applySideLayout(activeWType);
  
  $('s_prio').value=d.priority?String(d.priority):'';
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
  if ($('s_start')) $('s_start').value=(d.start||'').slice(0,10);
  if ($('s_target')) $('s_target').value=(d.target||'').slice(0,10);
  if ($('side-range-trigger')) syncSideDatePicker(d.start, d.target);
  if ($('s_due')) $('s_due').value=(d.due||'').slice(0,10);
  if ($('side-due-trigger')) syncSideDuePicker(d.due);
  if ($('s_est')) $('s_est').value=(d.est!=null?d.est:'');

  orig={
    title:d.title,state:d.state,assigned:d.assigned,priority:d.priority,
    iter:curIt,parent:(d.parent!=null?String(d.parent):''),
    start: $('s_start') ? $('s_start').value : '',
    target: $('s_target') ? $('s_target').value : '',
    due: $('s_due') ? $('s_due').value : '',
    est: $('s_est') ? $('s_est').value : '',
    desc:'', ac:'', has_ac:false, tags:'', area:'', storypoints:null, remaining:null, completed:null, activity:'', risk:'', valuearea:'', _relationsLoaded:false
  };

  // ── Unlock the sidebar (Phase 1 fields only) ──
  lockSidebar(false);
  refreshDirty();loadTimeline(id);
  setStatus('#'+id+' partially loaded');

  // ── Phase 2: Lazy loading of heavy/hidden fields that are actually visible ──
  const activeLazyGroups = [...LAZY_GROUPS].filter(g => !sideHidden.has(g));
  if (activeLazyGroups.length > 0) {
    lockSidebarHeavy(true, activeLazyGroups);
    activeLazyGroups.forEach(g => {
      if (g === 'desc' && $('editor_desc_container')) $('editor_desc_container').classList.add('loading-skeleton');
      if (g === 'ac' && $('editor_ac_container')) $('editor_ac_container').classList.add('loading-skeleton');
    });

    let fieldsToFetch = [];
    let needRelations = false;
    activeLazyGroups.forEach(g => {
      if (HEAVY_FIELD_MAP[g]) fieldsToFetch.push(...HEAVY_FIELD_MAP[g]);
      if (g === 'deps' || g === 'attachments') needRelations = true;
    });

    // Skip Phase 2 entirely if there's nothing to fetch
    if (fieldsToFetch.length === 0 && !needRelations) {
      lockSidebarHeavy(false, activeLazyGroups);
    } else {
      const phase2Token = openToken;                  // capture for stale-detection
      api.item(id, { fields: fieldsToFetch.length > 0 ? fieldsToFetch : undefined, expandRelations: needRelations, signal }).then(fullD => {
        if (cur !== id || phase2Token !== openToken) return; // switched items — discard stale data

        if (fullD && fullD.rev) {
          if (store.nodes[id]) {
            store.nodes[id].rev = fullD.rev;
            renderSidebarHeader(store.nodes[id]);
          }
        }

        if (activeLazyGroups.includes('desc') && descEditor) {
          descEditor.value = fullD.desc || '';
          descEditor.togglePreview(true);
          orig.desc = fullD.desc;
          orig._loaded_desc = true;
          if ($('editor_desc_container')) $('editor_desc_container').classList.remove('loading-skeleton');
        }
        if (activeLazyGroups.includes('ac') && acEditor) {
          acEditor.value = fullD.ac || '';
          acEditor.togglePreview(true);
          orig.ac = fullD.ac;
          orig.has_ac = fullD.has_ac;
          orig._loaded_ac = true;
          if ($('editor_ac_container')) {
            $('editor_ac_container').style.display = fullD.has_ac ? 'block' : 'none';
            $('editor_ac_container').classList.remove('loading-skeleton');
          }
        }
        if (activeLazyGroups.includes('tags')) {
          tagsEditor.set(fullD.tags || '', /*silent*/true);
          orig.tags = fullD.tags;
          orig._loaded_tags = true;
        }
        if (activeLazyGroups.includes('area') && $('s_area')) {
          $('s_area').value = fullD.area || '';
          orig.area = fullD.area || '';
          orig._loaded_area = true;
        }
        if (activeLazyGroups.includes('effort')) {
          if ($('s_storypoints')) $('s_storypoints').value = fullD.storypoints != null ? fullD.storypoints : '';
          if ($('s_remaining')) $('s_remaining').value = fullD.remaining != null ? fullD.remaining : '';
          if ($('s_completed')) $('s_completed').value = fullD.completed != null ? fullD.completed : '';
          orig.storypoints = fullD.storypoints;
          orig.remaining = fullD.remaining;
          orig.completed = fullD.completed;
          orig._loaded_storypoints = true;
          orig._loaded_remaining = true;
          orig._loaded_completed = true;
        }
        if (activeLazyGroups.includes('activity') && $('s_activity_field')) {
          const picker = window.dynamicPickers && window.dynamicPickers['s_activity_field'];
          if (picker) {
            picker.set(fullD.activity || '', true);
          } else {
            $('s_activity_field').value = fullD.activity || '';
          }
          orig.activity = fullD.activity || '';
          orig._loaded_activity = true;
        }
        if (activeLazyGroups.includes('classification')) {
          const rPicker = window.dynamicPickers && window.dynamicPickers['s_risk'];
          if (rPicker) {
            rPicker.set(fullD.risk || '', true);
          } else {
            if ($('s_risk')) $('s_risk').value = fullD.risk || '';
          }
          orig.risk = fullD.risk || '';
          orig._loaded_risk = true;

          const vaPicker = window.dynamicPickers && window.dynamicPickers['s_valuearea'];
          if (vaPicker) {
            vaPicker.set(fullD.valuearea || '', true);
          } else {
            if ($('s_valuearea')) $('s_valuearea').value = fullD.valuearea || '';
          }
          orig.valuearea = fullD.valuearea || '';
          orig._loaded_valuearea = true;
        }
        if (activeLazyGroups.includes('attachments')) {
          atchState.list = Array.isArray(fullD.attachments) ? fullD.attachments.slice() : [];
          renderAttachments();
        }
        if (activeLazyGroups.includes('deps')) {
          loadDeps(id, fullD.deps);
        }
        if (needRelations) {
          orig._relationsLoaded = true;
        }

        // Dynamically build and render Custom Fields values
        customFieldsState.forEach(cf => {
          let val = fullD.fields[cf.referenceName] || '';
          if (val && typeof val === 'object') {
            val = val.displayName || val.uniqueName || '';
          }
          const isHtml = cf.type && (cf.type.toLowerCase() === 'html' || cf.type.toLowerCase() === 'plaintext');
          const editor = isHtml ? (window.customHtmlEditors && window.customHtmlEditors[cf.referenceName]) : null;
          const el = $(cf.elementId);
          
          if (el || editor) {
            const isDateTime = cf.type && cf.type.toLowerCase() === 'datetime';
            if (isHtml && editor) {
              const mdVal = AdoLib.htmlToMarkdown(val || '');
              editor.set(mdVal, true);
              editor.togglePreview(true);
            } else if (isDateTime) {
              const picker = window.dynamicDatePickers && window.dynamicDatePickers[cf.elementId];
              if (picker) {
                const dateStr = val ? val.slice(0, 10) : '';
                picker.setRange(dateStr, dateStr);
                const trigger = $(cf.elementId + '_trigger');
                if (trigger) trigger.value = dateStr ? formatDisplayDate(dateStr) : '';
              }
              val = val ? val.slice(0, 10) : '';
              el.value = val;
            } else if (cf.hasAllowedValues || cf.isIdentity || (cf.type && cf.type.toLowerCase() === 'identity')) {
              const picker = window.dynamicPickers && window.dynamicPickers[cf.elementId];
              if (picker) {
                picker.set(val, true);
              } else if (el) {
                el.value = val;
              }
            } else if (el) {
              el.value = val;
            }
          }
          if (isHtml) {
            orig[cf.referenceName] = AdoLib.htmlToMarkdown(val || '');
          } else {
            orig[cf.referenceName] = val;
          }
          orig['_loaded_' + cf.referenceName] = true;
        });

        lockSidebarHeavy(false, activeLazyGroups);
        refreshDirty();
        setStatus('#'+id+' loaded');
      }).catch(err => {
        if (err.name === 'AbortError') return;        // silently exit — a newer openItem() is running
        if (cur !== id || phase2Token !== openToken) return; // stale
        setStatus('Failed to load details: ' + err.message, true);
        lockSidebarHeavy(false, activeLazyGroups);
      });
    }
  }
}
function dirty(){
  if(cur==null||!orig)return false;
  const v=editorValues();
  const numEq=(a,b)=>(a===''||a==null)&&(b===''||b==null) ? true : String(a)===String(b);
  // Phase 1 (always-loaded) fields
  if(v.title!==orig.title||v.state!==orig.state||v.assigned!==orig.assigned
    ||((orig.priority?String(orig.priority):'')!==v.prio)
    ||v.iter!==orig.iter||v.parent!==orig.parent||v.start!==orig.start||v.target!==orig.target||v.due!==orig.due||v.est!==orig.est)
    return true;
  // Lazy fields — only compare if they've actually been loaded into orig
  if(orig._loaded_desc && v.desc!==orig.desc) return true;
  if(orig._loaded_ac && orig.has_ac && v.ac!==orig.ac) return true;
  if(orig._loaded_tags && v.tags!==orig.tags) return true;
  if(orig._loaded_area && v.area!==orig.area) return true;
  if(orig._loaded_storypoints && !numEq(v.storypoints,orig.storypoints)) return true;
  if(orig._loaded_remaining && !numEq(v.remaining,orig.remaining)) return true;
  if(orig._loaded_completed && !numEq(v.completed,orig.completed)) return true;
  if(orig._loaded_activity && v.activity!==orig.activity) return true;
  if(orig._loaded_risk && v.risk!==orig.risk) return true;
  if(orig._loaded_valuearea && v.valuearea!==orig.valuearea) return true;

  // Custom fields dirty check
  for (const cf of customFieldsState) {
    if (orig['_loaded_' + cf.referenceName]) {
      const currentVal = v[cf.referenceName];
      const origVal = orig[cf.referenceName];
      if (cf.type === 'double' || cf.type === 'integer') {
        if (!numEq(currentVal, origVal)) return true;
      } else {
        if (String(currentVal) !== String(origVal)) return true;
      }
    }
  }

  return false;
}
// Hybrid save: pickers (state, priority, assignee, sprint, parent, tags, dates,
// estimate) auto-commit on change via quickSave(). Only text fields stay manual
// (title, description, AC). textDirty drives the Save button + status chip;
// dirty() (full check) still drives the "discard unsaved" prompt so a failed
// auto-save isn't silently lost.
function textDirty(){
  if(cur==null||!orig)return false;
  const v=editorValues();
  return v.title!==orig.title||v.desc!==orig.desc||(orig.has_ac&&v.ac!==orig.ac);
}
let _saveChipTimer=null;
function setSaveChip(state,msg){
  const chip=$('s_status_chip');
  if(!chip)return;
  if(_saveChipTimer){clearTimeout(_saveChipTimer);_saveChipTimer=null;}
  chip.title=msg||'';
  const btns=$('s_unsaved_btns');
  if(state==='idle'){
    chip.className='schip';
    chip.innerHTML='';
    if(btns)btns.classList.add('hidden');
  }
  else if(state==='dirty'){
    chip.className='schip hidden';
    if(btns)btns.classList.remove('hidden');
  }
  else if(state==='saving'){
    if(btns)btns.classList.add('hidden');
    chip.className='schip saving';
    chip.innerHTML='<span class="spin"></span> Saving…';
  }
  else if(state==='saved'){
    if(btns)btns.classList.add('hidden');
    chip.className='schip saved';
    chip.innerHTML='<ui-icon name="check"></ui-icon> Saved';_saveChipTimer=setTimeout(()=>{
      const c=$('s_status_chip');if(c)c.className='schip';
      refreshDirty();
    },2500);
  }
  else if(state==='error'){
    if(btns)btns.classList.add('hidden');
    chip.className='schip error';
    chip.innerHTML='<ui-icon name="alert-triangle"></ui-icon> Save failed';
  }
}
function refreshDirty(){
  const d=textDirty();const b=$('s_save');
  if(b){
    b.disabled=!d;
    b.textContent='Save';
  }
  const chip=$('s_status_chip');
  if(chip&&!chip.classList.contains('saving')&&!chip.classList.contains('saved')&&!chip.classList.contains('error')){
    setSaveChip(d?'dirty':'idle');
  }
}
function discardChanges(){
  if(cur==null||!orig)return;
  if ($('s_title')) $('s_title').value=orig.title;
  if (descEditor) descEditor.value=orig.desc;
  if(orig.has_ac && acEditor){
    acEditor.value=orig.ac;
  }
  if ($('s_area')) $('s_area').value=orig.area||'';
  if ($('s_storypoints')) $('s_storypoints').value=orig.storypoints!=null?orig.storypoints:'';
  if ($('s_remaining')) $('s_remaining').value=orig.remaining!=null?orig.remaining:'';
  if ($('s_completed')) $('s_completed').value=orig.completed!=null?orig.completed:'';

  const fieldsToSync = [
    { elId: 's_activity_field', val: orig.activity },
    { elId: 's_risk', val: orig.risk },
    { elId: 's_valuearea', val: orig.valuearea }
  ];
  fieldsToSync.forEach(f => {
    if ($(f.elId)) {
      const p = window.dynamicPickers && window.dynamicPickers[f.elId];
      if (p) p.set(f.val || '', true);
      else $(f.elId).value = f.val || '';
    }
  });

  // Restore custom fields
  customFieldsState.forEach(cf => {
    const origVal = orig[cf.referenceName] || '';
    const isHtml = cf.type && (cf.type.toLowerCase() === 'html' || cf.type.toLowerCase() === 'plaintext');
    const editor = isHtml ? (window.customHtmlEditors && window.customHtmlEditors[cf.referenceName]) : null;
    const el = $(cf.elementId);

    if (el || editor) {
      const isDateTime = cf.type && cf.type.toLowerCase() === 'datetime';
      if (isHtml && editor) {
        editor.value = origVal;
        editor.togglePreview(true);
      } else if (isDateTime) {
        const dateStr = origVal ? origVal.slice(0, 10) : '';
        el.value = dateStr;
        const picker = window.dynamicDatePickers && window.dynamicDatePickers[cf.elementId];
        if (picker) picker.setRange(dateStr, dateStr);
        const trigger = $(cf.elementId + '_trigger');
        if (trigger) trigger.value = dateStr ? formatDisplayDate(dateStr) : '';
      } else {
        const picker = window.dynamicPickers && window.dynamicPickers[cf.elementId];
        if (picker) {
          picker.set(origVal, true);
        } else if (el) {
          el.value = origVal;
        }
      }
    }
  });

  refreshDirty();
}
function editorValues(){
  const values = {
    title: $('s_title') ? $('s_title').value : '',
    state: $('s_state') ? $('s_state').value : '',
    assigned: $('s_assigned') ? $('s_assigned').value : '',
    desc: descEditor ? descEditor.value : '',
    ac: acEditor ? acEditor.value : '',
    prio: $('s_prio') ? $('s_prio').value : '',
    iter: $('s_iter') ? $('s_iter').value : '',
    parent: $('s_parent') ? $('s_parent').value.trim() : '',
    start: $('s_start') ? $('s_start').value : '',
    target: $('s_target') ? $('s_target').value : '',
    due: $('s_due') ? $('s_due').value : '',
    est: $('s_est') ? $('s_est').value : '',
    tags: tagsEditor ? tagsEditor.value() : '',
    area: $('s_area') ? $('s_area').value : '',
    storypoints: $('s_storypoints') ? $('s_storypoints').value : '',
    remaining: $('s_remaining') ? $('s_remaining').value : '',
    completed: $('s_completed') ? $('s_completed').value : '',
    activity: $('s_activity_field') ? $('s_activity_field').value : '',
    risk: $('s_risk') ? $('s_risk').value : '',
    valuearea: $('s_valuearea') ? $('s_valuearea').value : ''
  };
  
  // Collect dynamic custom fields values
  customFieldsState.forEach(cf => {
    const isHtml = cf.type && (cf.type.toLowerCase() === 'html' || cf.type.toLowerCase() === 'plaintext');
    if (isHtml) {
      if (window.customHtmlEditors && window.customHtmlEditors[cf.referenceName]) {
        values[cf.referenceName] = window.customHtmlEditors[cf.referenceName].value;
      } else {
        values[cf.referenceName] = '';
      }
      return;
    }

    const el = $(cf.elementId);
    if (el) {
      if (cf.type === 'double' || cf.type === 'integer') {
        values[cf.referenceName] = el.value === '' ? '' : Number(el.value);
      } else {
        values[cf.referenceName] = el.value;
      }
    }
  });

  return values;
}

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

/* ---------- dependency links (sidebar Blocked-by / Blocks + the graph) ----------
   The editor shows two chip rows + an item picker for adding. Mutations also fire
   from the graph (drag a stub between nodes, or click an edge to delete). Both
   paths share the same state + undo plumbing so the views stay consistent. */
const depsState={blockedBy:[],blocks:[]};
// Pick the per-direction array on the open item's deps state.
function depsArr(dir){return dir==='blocks'?depsState.blocks:depsState.blockedBy;}
function setDepsArr(dir,arr){if(dir==='blocks')depsState.blocks=arr;else depsState.blockedBy=arr;}

const depBlockedByPicker=createCardPicker('s_deps_blockedby',{provider:depAdderProvider('blockedBy'),onChange:depPickerOnChange('blockedBy')});
const depBlocksPicker=createCardPicker('s_deps_blocks',{provider:depAdderProvider('blocks'),onChange:depPickerOnChange('blocks')});

// Render Blocked-by / Blocks chip rows from depsState. Titles for items the tree
// hasn't loaded resolve lazily via api.item — same pattern as the parent card.
function renderDeps(){
  const chip=(id,dir)=>{
    const n=store.nodes[id];
    const ty=n?tyColor(n.type):'#95a5a6';
    const ttl=n?htmlEsc(n.title||''):'';
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
  if(from===to){setStatus(window.i18n.t('status.cannotDependSelf'),true);return;}
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
  
  if('area'in body)rev.area=before.area;
  if('storypoints'in body)rev.storypoints=before.storypoints;
  if('remaining'in body)rev.remaining=before.remaining;
  if('completed'in body)rev.completed=before.completed;
  if('activity'in body)rev.activity=before.activity;
  if('risk'in body)rev.risk=before.risk;
  if('valuearea'in body)rev.valuearea=before.valuearea;

  const hasRev=Object.keys(rev).length>0,hasFwd=Object.keys(body).length>0;
  if(!hasRev&&!parentChanged)return;
  pushAction('edit #'+id,
    async()=>{if(hasRev)await api.updateItem(id,rev);if(parentChanged)await api.setParent(id,beforeParent);await afterUndo(id);},
    async()=>{if(hasFwd)await api.updateItem(id,body);if(parentChanged)await api.setParent(id,newParent);await afterUndo(id);});
}

// Shared post-PATCH visuals: keeps the tree row, store, and cytoscape node in
// sync with whatever fields the PATCH just touched. Used by both save() (full
// manual save) and quickSave() (single-field auto-save).
function applyVisualSync(id,body,v){
  if(selRow&&body.title)selRow.querySelector('.lab').textContent=`#${id} ${body.title}`;
  if(selRow&&body.state)selRow.querySelector('.badge').textContent=body.state;
  if(selRow&&('priority'in body)){let pc=selRow.querySelector('.prio');if(!pc){pc=document.createElement('span');pc.className='prio';selRow.insertBefore(pc,selRow.querySelector('.badge'));}pc.textContent='P'+body.priority;pc.style.background=prioColor(body.priority);}
  if(selRow&&('tags'in body)){selRow.querySelectorAll('.ttag').forEach(t=>t.remove());const bdg=selRow.querySelector('.badge');if(bdg){bdg.style.marginLeft='';const ts=tagList_(v.tags);if(ts.length){const show=ts.slice(0,3),extra=ts.length-show.length;bdg.style.marginLeft='0';show.forEach((t,i)=>{const tc=document.createElement('span');tc.className='ttag';tc.textContent=t;tc.style.background=personColor(t);tc.title=t;if(i===0)tc.style.marginLeft='auto';selRow.insertBefore(tc,bdg);});if(extra>0){const tc=document.createElement('span');tc.className='ttag';tc.textContent='+'+extra;tc.style.background='var(--muted)';selRow.insertBefore(tc,bdg);}}}}
  if(store.nodes[id]){const s=store.nodes[id];s.title=v.title;s.state=v.state;
    if('assigned'in body)s.assigned=body.assigned;
    if('priority'in body)s.priority=body.priority;
    if('iteration'in body)s.iteration=body.iteration;
    if('start'in body)s.start=v.start;
    if('target'in body)s.target=v.target;
    if('due'in body)s.due=v.due;
    if('estimate'in body)s.est=(v.est===''?null:Number(v.est));
    if('tags'in body)s.tags=v.tags;}
  if(cy&&store.nodes[id]){const n=cy.getElementById(String(id));if(n.nonempty())n.data(Object.assign({},store.nodes[id]));}
}

// Refresh the listing view if a saved field shifts WHERE the item appears.
function postSaveRefresh(body,parentChanged){
  if('iteration'in body||'assigned'in body||parentChanged)refresh();
  else{
    if(mode==='board')renderBoard();
    else if(mode==='timeline')renderTimeline();
    if(openSprintPath&&$('sprintview').classList.contains('show'))renderSprint(openSprintPath);
  }
}
function registerNewAssignee(name) {
  if(name && name !== currentUser && !assignees.includes(name)) {
    assignees.push(name);
    assignees.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    const dl = $('assignees');
    if (dl) dl.innerHTML = ['me', ...assignees].map(a => `<option value="${String(a).replace(/"/g,'&quot;')}">`).join('');
    renderFilters();
  }
}
function registerNewTags(tagsStr) {
  const ts = tagList_(tagsStr);
  let changed = false;
  ts.forEach(t => {
    if (!tagList.includes(t)) {
      tagList.push(t);
      changed = true;
    }
  });
  if (changed) {
    tagList.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    const dl = $('tagsdl');
    if (dl) dl.innerHTML = tagList.map(x => `<option value="${htmlEsc(x)}">`).join('');
    renderFilters();
  }
}

function getWorkDayHours() {
  let ws = 9, we = 17;
  try {
    const wh = localStorage.getItem('ado.workHours');
    if (wh && /^\d+-\d+$/.test(wh)) {
      const m = wh.split('-');
      ws = +m[0];
      we = +m[1];
    }
  } catch (e) {}
  return Math.max(1, we - ws);
}

function formatTimePreview(str) {
  if (typeof str !== 'string') return '';
  const cleaned = str.trim();
  if (!cleaned) return '';
  
  const workHours = getWorkDayHours();
  const weekHours = workHours * 5;
  
  const mathExpr = timeExprToMath(cleaned, workHours);
  const total = evaluateMath(mathExpr);
  if (isNaN(total) || !isFinite(total)) return '';
  
  let breakdown = cleaned
    .replace(/(\d+(?:\.\d+)?)\s*w/gi, '$1w (' + weekHours + 'h)')
    .replace(/(\d+(?:\.\d+)?)\s*d/gi, '$1d (' + workHours + 'h)')
    .replace(/(\d+(?:\.\d+)?)\s*h/gi, '$1h');
  
  breakdown = breakdown
    .replace(/\s*([+\-*/])\s*/g, ' $1 ')
    .replace(/\s*\(\s*/g, '(')
    .replace(/\s*\)\s*/g, ')');
    
  return `<ui-icon name="clock"></ui-icon> = ${parseFloat(total.toFixed(2))}h [${breakdown}]`;
}

function parseTimeExpr(str) {
  if (typeof str !== 'string') return NaN;
  const cleaned = str.trim();
  if (!cleaned) return NaN;
  
  const workHours = getWorkDayHours();
  const mathExpr = timeExprToMath(cleaned, workHours);
  const total = evaluateMath(mathExpr);
  return isNaN(total) ? NaN : total;
}

// Atomic single-field PATCH triggered by a picker / select / date input change.
// `field` ∈ {state, assigned, priority, iteration, start, target, due, estimate, tags, parent}.
// Concurrent calls for different fields don't conflict (independent body keys).
// Concurrent calls for the SAME field race on the wire — to converge orig with
// the latest editor value we re-read editorValues() at response time instead of
// using the request-time snapshot.
async function quickSave(field){
  if(cur==null||!orig)return;
  const id=cur;
  
  // Perform math parsing for estimate (s_est), storypoints, remaining, completed
  if (field === 'estimate' || field === 'storypoints' || field === 'remaining' || field === 'completed') {
    const inputId = {estimate: 's_est', storypoints: 's_storypoints', remaining: 's_remaining', completed: 's_completed'}[field];
    const el = $(inputId);
    if (el) {
      const parsedVal = parseTimeExpr(el.value);
      if (!isNaN(parsedVal)) {
        el.value = String(Number(parsedVal.toFixed(2))); // round to 2 decimal places max
      }
    }
  }

  const v=editorValues();
  let body={},parentChanged=false;
  const numEq=(a,b)=>(a===''||a==null)&&(b===''||b==null) ? true : String(a)===String(b);
  if(field==='parent'){
    if(v.parent===orig.parent)return;
    if(v.parent!==''&&Number(v.parent)===id){setStatus(window.i18n.t('status.cannotParentSelf'),true);return;}
    parentChanged=true;
  } else if(field==='priority'){
    const op=orig.priority?String(orig.priority):'';
    if(v.prio===op||v.prio==='')return;          // empty = "no change" (matches manual save)
    body.priority=Number(v.prio);
  } else if(field==='storypoints' || field==='remaining' || field==='completed') {
    if(numEq(v[field], orig[field])) return;
    body[field] = v[field] === '' ? '' : Number(v[field]);
  } else if(field.startsWith('cust:')) {
    const refName = field.substring(5);
    if(v[refName] === orig[refName]) return;
    body[refName] = v[refName];
  } else {
    const keyMap={iteration:'iter',estimate:'est'};
    const k=keyMap[field]||field;
    if(v[k]===orig[k])return;
    if(field==='assigned')body.assigned=(v.assigned==='me'?(currentUser||v.assigned):v.assigned);
    else body[field]=v[k];
  }
  if(!Object.keys(body).length&&!parentChanged)return;
  const before={...orig},beforeParent=orig.parent,newParent=v.parent;
  setSaveChip('saving');
  let r;
  try{
    if(Object.keys(body).length)r=await api.updateItem(id,body);
    if(parentChanged)await api.setParent(id,newParent);
  }catch(e){
    setSaveChip('error',e.message);setStatus('save failed: '+e.message,true);refreshDirty();
    return;
  }
  if(cur!==id)return;                            // user navigated away mid-save
  recordEditUndo(id,body,parentChanged,before,beforeParent,newParent);
  // Use the FRESH editor values for orig + visuals — a follow-up edit during
  // the in-flight PATCH has already fired its own quickSave; we just make sure
  // orig converges to "whatever's in the editor right now".
  const vNow=editorValues();
  applyVisualSync(id,body,vNow);
  if('state'in body)orig.state=vNow.state;
  if('assigned'in body){orig.assigned=vNow.assigned; registerNewAssignee(vNow.assigned);}
  if('priority'in body)orig.priority=body.priority;
  if('iteration'in body)orig.iter=vNow.iter;
  if('start'in body)orig.start=vNow.start;
  if('target'in body)orig.target=vNow.target;
  if('due'in body)orig.due=vNow.due;
  if('estimate'in body)orig.est=vNow.est;
  if('tags'in body){orig.tags=vNow.tags; registerNewTags(vNow.tags);}
  if('area'in body)orig.area=vNow.area;
  if('storypoints'in body)orig.storypoints=body.storypoints === '' ? null : Number(body.storypoints);
  if('remaining'in body)orig.remaining=body.remaining === '' ? null : Number(body.remaining);
  if('completed'in body)orig.completed=body.completed === '' ? null : Number(body.completed);
  if('activity'in body)orig.activity=vNow.activity;
  if('risk'in body)orig.risk=vNow.risk;
  if('valuearea'in body)orig.valuearea=vNow.valuearea;
  if(parentChanged)orig.parent=vNow.parent;

  // Sync custom fields to orig
  customFieldsState.forEach(cf => {
    if (cf.referenceName in body) {
      orig[cf.referenceName] = vNow[cf.referenceName];
    }
  });

  if(r&&r.rev) {
    FollowManager.updateItemRev(id,r.rev,orig.state,orig.title,orig.assigned);
    if(store.nodes[id]) store.nodes[id].rev = r.rev;
  }
  refreshDirty();setSaveChip('saved');
  setStatus(`#${id} ${field} saved`+(r?` → rev ${r.rev}`:''));
  postSaveRefresh(body,parentChanged);
}

async function save(){
  if(cur==null)return;const id=cur;const v=editorValues();const body={};
  // Text fields only — pickers/selects/dates are auto-saved by quickSave().
  if(v.title!==orig.title)body.title=v.title;
  if(v.desc!==orig.desc)body.desc=v.desc;
  if(orig.has_ac&&v.ac!==orig.ac)body.ac=v.ac;
  customFieldsState.forEach(cf => {
    const isHtml = cf.type && (cf.type.toLowerCase() === 'html' || cf.type.toLowerCase() === 'plaintext');
    if (isHtml && v[cf.referenceName] !== orig[cf.referenceName]) {
      body[cf.referenceName] = v[cf.referenceName];
    }
  });
  if(!Object.keys(body).length){setStatus('no changes');return;}
  const before={...orig};
  const sv=$('s_save');sv.disabled=true;sv.textContent='Saving…';setSaveChip('saving');loadStart('saving…');
  let r;
  try{
    r=await api.updateItem(id,body);
  }catch(e){setStatus('ERROR: '+e.message,true);setSaveChip('error',e.message);refreshDirty();loadEnd();return;}
  loadEnd();
  recordEditUndo(id,body,false,before,orig.parent,orig.parent);
  applyVisualSync(id,body,v);
  if('title'in body)orig.title=v.title;
  if('desc'in body)orig.desc=v.desc;
  if('ac'in body)orig.ac=v.ac;
  customFieldsState.forEach(cf => {
    if (cf.referenceName in body) {
      orig[cf.referenceName] = v[cf.referenceName];
    }
  });
  if(r&&r.rev) {
    FollowManager.updateItemRev(id,r.rev,orig.state,orig.title,orig.assigned);
    if(store.nodes[id]) store.nodes[id].rev = r.rev;
  }
  refreshDirty();setSaveChip('saved');setStatus(`#${id} saved`+(r?` → rev ${r.rev}`:''));
  postSaveRefresh(body,false);
}
function closeCommentForm(){
  const f=$('comment_editor_container');
  if(f){
    f.style.display='none';
    if(commentEditor){
      commentEditor.toggleFullscreen(false);
      commentEditor.value='';
    }
  }
  const btn=$('s_comment');
  if(btn) btn.classList.remove('on');
}
function toggleComment(){
  const f=$('comment_editor_container');
  const show=f.style.display!=='flex';
  f.style.display=show?'flex':'none';
  const btn=$('s_comment');
  if(btn) btn.classList.toggle('on', show);
  if(show) commentEditor.textarea.focus();
}
async function postComment(){
  const t=commentEditor.value.trim();if(!t||cur==null)return;
  try{await api.comment(cur,t);}catch(e){setStatus('ERROR: '+e.message,true);return;}
  closeCommentForm();
  setStatus('#'+cur+' comment added');
  loadActivity();
}

/* ---------- activity reactions, expansion, inline edits ---------- */
function getEmojiMap() {
  const defaults = {
    like: 'icons/reactions/like.png',
    dislike: 'icons/reactions/dislike.png',
    heart: 'icons/reactions/heart.png',
    hooray: 'icons/reactions/hooray.png',
    smile: 'icons/reactions/smile.png',
    confused: 'icons/reactions/confused.png'
  };
  try {
    const custom = JSON.parse(localStorage.getItem('ado.custom_emojis') || '{}');
    return { ...defaults, ...custom };
  } catch (e) {
    return defaults;
  }
}

function renderEmojiMarkup(type, emojiVal) {
  const isUrl = /^(https?:\/\/|chrome-extension:\/\/|icons\/|data:image\/)/.test(emojiVal);
  if (isUrl) {
    return `<img class="emoji-img" src="${emojiVal}" alt="${type}">`;
  }
  return emojiVal;
}

function showEmojisModal() {
  const m = $('morepanel');
  if (m) {
    m.style.display = 'none';
    $('morebtn').classList.remove('on');
  }
  const current = getEmojiMap();
  const defaults = {
    like: 'icons/reactions/like.png',
    dislike: 'icons/reactions/dislike.png',
    heart: 'icons/reactions/heart.png',
    hooray: 'icons/reactions/hooray.png',
    smile: 'icons/reactions/smile.png',
    confused: 'icons/reactions/confused.png'
  };
  for (const [type, val] of Object.entries(current)) {
    const input = $(`emoji_override_${type}`);
    if (input) {
      if (val === defaults[type]) {
        input.value = '';
      } else {
        input.value = val;
      }
      updateEmojiInputPreview(type);
    }
  }
  const overlay = $('emojis-overlay');
  overlay.classList.add('show');
  if (window.LayerManager) {
    window.LayerManager.open(overlay);
  }
}

function updateEmojiInputPreview(type) {
  const input = $(`emoji_override_${type}`);
  const previewDiv = $(`emoji_preview_${type}`);
  if (!input || !previewDiv) return;
  const val = input.value.trim();
  const defaults = {
    like: 'icons/reactions/like.png',
    dislike: 'icons/reactions/dislike.png',
    heart: 'icons/reactions/heart.png',
    hooray: 'icons/reactions/hooray.png',
    smile: 'icons/reactions/smile.png',
    confused: 'icons/reactions/confused.png'
  };
  const displayVal = val || defaults[type];
  previewDiv.innerHTML = renderEmojiMarkup(type, displayVal);
}

function showEmojiRowError(type, message) {
  const inputEl = $(`emoji_override_${type}`);
  if (!inputEl) return;
  const row = inputEl.closest('.emoji-config-row');
  if (!row) return;
  
  const existing = document.querySelector(`.emoji-row-error[data-row-type="${type}"]`);
  if (existing) {
    if (window.LayerManager) window.LayerManager.close(existing);
    existing.remove();
  }
  
  const err = document.createElement('div');
  err.className = 'emoji-row-error';
  err.dataset.rowType = type;
  err.textContent = message;
  
  const overlay = $('emojis-overlay');
  overlay.appendChild(err);
  
  const rRect = row.getBoundingClientRect();
  const oRect = overlay.getBoundingClientRect();
  
  const top = rRect.top - oRect.top - 32;
  const right = oRect.right - rRect.right + 10;
  
  err.style.top = `${top}px`;
  err.style.right = `${right}px`;
  
  if (window.LayerManager) {
    window.LayerManager.open(err, null, { isPopover: true });
  }
  
  setTimeout(() => {
    err.style.opacity = '0';
    setTimeout(() => {
      if (window.LayerManager) window.LayerManager.close(err);
      err.remove();
    }, 200);
  }, 4000);
}

function closeEmojisModal() {
  const overlay = $('emojis-overlay');
  overlay.classList.remove('show');
  if (window.LayerManager) {
    window.LayerManager.close(overlay);
  }
}

function resetEmojis() {
  localStorage.removeItem('ado.custom_emojis');
  closeEmojisModal();
  loadActivity();
}

function saveEmojis() {
  const custom = {};
  const types = ['like', 'dislike', 'heart', 'hooray', 'smile', 'confused'];
  for (const type of types) {
    const val = $(`emoji_override_${type}`).value.trim();
    if (val) {
      custom[type] = val;
    }
  }
  localStorage.setItem('ado.custom_emojis', JSON.stringify(custom));
  closeEmojisModal();
  loadActivity();
}

function updateCommentReactionsUI(commentId, reactions) {
  const card = document.querySelector(`.comment-card[data-cid="${commentId}"]`);
  if (!card) return;
  const reactionsDiv = card.querySelector('.comment-reactions');
  if (!reactionsDiv) return;

  const emojiMap = getEmojiMap();
  let reactHtml = '';
  Object.entries(emojiMap).forEach(([type, emojiVal]) => {
    const data = reactions[type];
    if (data && data.count > 0) {
      const active = data.me ? 'active' : '';
      reactHtml += `<span class="reaction-chip ${active}" data-cid="${commentId}" data-type="${type}"><span class="emoji-symbol">${renderEmojiMarkup(type, emojiVal)}</span> <span class="rc-count">${data.count}</span></span>`;
    }
  });
  reactionsDiv.innerHTML = reactHtml;
}

function toggleActivityExpand(forceState) {
  const actionsGroup = document.querySelector('.sgroup[data-sg="actions"]');
  const arrow = document.querySelector('#activity_toggle_btn .toggle-arrow');
  const content = $('activity-content');
  if (!actionsGroup || !content) return;
  
  const isFullscreen = actionsGroup.classList.contains('fullscreen');
  const isExpanded = forceState !== undefined ? forceState : content.classList.contains('hidden');
  if (isExpanded) {
    const alreadyExpanded = !content.classList.contains('hidden');
    content.classList.remove('hidden');
    if (arrow) {
      arrow.innerHTML = isFullscreen ? '<ui-icon name="refresh-cw"></ui-icon>' : '<ui-icon name="chevron-down"></ui-icon>';
      if (isFullscreen) arrow.title = 'Reload activity content';
      else arrow.title = '';
    }
    actionsGroup.classList.add('expanded');
    if (!alreadyExpanded) {
      loadActivity();
    }
  } else {
    content.classList.add('hidden');
    if (arrow) {
      arrow.innerHTML = isFullscreen ? '<ui-icon name="refresh-cw"></ui-icon>' : '<ui-icon name="chevron-right"></ui-icon>';
      if (isFullscreen) arrow.title = 'Reload activity content';
      else arrow.title = '';
    }
    actionsGroup.classList.remove('expanded');
  }
}

let _actionsOrigParent = null;
let _actionsOrigNextSibling = null;
function toggleActivityFullscreen(forceOn) {
  const actionsGroup = document.querySelector('.sgroup[data-sg="actions"]');
  const btn = $('s_act_full');
  if (!actionsGroup) return;
  
  const on = forceOn !== undefined ? forceOn : !actionsGroup.classList.contains('fullscreen');
  const arrow = document.querySelector('#activity_toggle_btn .toggle-arrow');
  const atb = $('activity_toggle_btn');
  
  if (on) {
    actionsGroup.classList.add('fullscreen');
    toggleActivityExpand(true);
    if (btn) btn.classList.add('on');
    if (arrow) {
      arrow.innerHTML = '<ui-icon name="refresh-cw"></ui-icon>';
      arrow.title = 'Reload activity content';
    }
    if (atb) {
      atb.title = 'Reload activity content';
    }
    let bd = $('act-backdrop');
    if (!bd) {
      bd = document.createElement('div');
      bd.id = 'act-backdrop';
      bd.className = 'modal-backdrop activity-backdrop';
      bd.onclick = () => toggleActivityFullscreen(false);
      const sideEl = $('side');
      if (sideEl) {
        sideEl.appendChild(bd);
      } else {
        document.body.appendChild(bd);
      }
    }
    
    // Move actionsGroup to document.body to break stacking context bugs
    if (!_actionsOrigParent) {
      _actionsOrigParent = actionsGroup.parentNode;
      _actionsOrigNextSibling = actionsGroup.nextSibling;
    }
    document.body.appendChild(actionsGroup);

    if (window.LayerManager) {
      window.LayerManager.open(actionsGroup, bd);
    }
  } else {
    if (window.LayerManager) {
      window.LayerManager.close(actionsGroup);
    }
    
    // Restore actionsGroup to original parent
    const sideEl = $('side');
    if (sideEl && _actionsOrigParent) {
      if (_actionsOrigNextSibling) {
        _actionsOrigParent.insertBefore(actionsGroup, _actionsOrigNextSibling);
      } else {
        _actionsOrigParent.appendChild(actionsGroup);
      }
      _actionsOrigParent = null;
      _actionsOrigNextSibling = null;
    }

    actionsGroup.classList.remove('fullscreen');
    if (btn) btn.classList.remove('on');
    if (arrow) {
      arrow.textContent = '▼'; // Since it's still expanded
      arrow.title = '';
    }
    if (atb) {
      atb.title = 'Click to collapse/expand activity';
    }
    const bd = $('act-backdrop');
    if (bd) bd.remove();
  }
}

function initActivityResizer() {
  const rz = $('activity-resizer');
  const act = $('s_activity');
  if (!rz || !act) return;
  let drag = false;
  let startY, startH;
  
  rz.onmousedown = e => {
    const content = $('activity-content');
    if (content && content.classList.contains('hidden')) {
      toggleActivityExpand(true);
      startH = 200;
    } else {
      startH = act.offsetHeight;
    }
    drag = true;
    startY = e.clientY;
    rz.classList.add('active');
    document.body.style.cursor = 'ns-resize';
    e.preventDefault();
  };
  
  document.addEventListener('mousemove', e => {
    if (!drag) return;
    const dy = startY - e.clientY;
    const h = Math.max(100, Math.min(600, startH + dy));
    act.style.maxHeight = h + 'px';
  });
  
  document.addEventListener('mouseup', () => {
    if (drag) {
      drag = false;
      rz.classList.remove('active');
      document.body.style.cursor = '';
      try {
        localStorage.setItem('ado.activityHeight', act.style.maxHeight);
      } catch (err) {}
    }
  });
  
  try {
    const savedH = localStorage.getItem('ado.activityHeight');
    if (savedH) act.style.maxHeight = savedH;
  } catch (err) {}
}

let activeEmojiPicker = null;
function showEmojiPicker(btn, commentId) {
  const isAlreadyOpen = activeEmojiPicker && activeEmojiPicker.parentElement === btn.parentElement;
  closeEmojiPicker();
  if (isAlreadyOpen) {
    return;
  }
  
  const pop = document.createElement('div');
  pop.className = 'reactions-popover';
  const emojiMap = getEmojiMap();
  
  Object.entries(emojiMap).forEach(([type, emojiVal]) => {
    const emojiBtn = document.createElement('button');
    emojiBtn.className = 'reaction-emoji-btn';
    emojiBtn.type = 'button';
    emojiBtn.innerHTML = renderEmojiMarkup(type, emojiVal);
    emojiBtn.title = type;
    emojiBtn.onclick = (ev) => {
      ev.stopPropagation();
      toggleReaction(commentId, type);
      closeEmojiPicker();
    };
    pop.appendChild(emojiBtn);
  });
  
  btn.parentElement.appendChild(pop);
  activeEmojiPicker = pop;
  if (window.LayerManager) window.LayerManager.open(pop, null, { isPopover: true });
  
  document.addEventListener('click', closeEmojiPickerOutside);
}
function closeEmojiPicker() {
  if (activeEmojiPicker) {
    if (window.LayerManager) window.LayerManager.close(activeEmojiPicker);
    activeEmojiPicker.remove();
    activeEmojiPicker = null;
  }
  document.removeEventListener('click', closeEmojiPickerOutside);
}
function closeEmojiPickerOutside(e) {
  if (activeEmojiPicker && !activeEmojiPicker.contains(e.target)) {
    closeEmojiPicker();
  }
}

async function toggleReaction(commentId, type) {
  if (cur == null) return;
  const c = currentComments.find(x => x.id === commentId);
  if (!c) return;

  const cacheKey = `${commentId}_${type}`;
  reactionCache.delete(cacheKey);

  if (!c.reactions) c.reactions = {};
  if (!c.reactions[type]) c.reactions[type] = { count: 0, me: false };

  const wasMe = c.reactions[type].me;
  
  // Optimistic update
  if (wasMe) {
    c.reactions[type].me = false;
    c.reactions[type].count = Math.max(0, c.reactions[type].count - 1);
  } else {
    c.reactions[type].me = true;
    c.reactions[type].count++;
  }

  // Update specific comment reactions UI
  updateCommentReactionsUI(commentId, c.reactions);

  try {
    if (wasMe) {
      await api.removeCommentReaction(cur, commentId, type);
    } else {
      await api.addCommentReaction(cur, commentId, type);
    }
  } catch (err) {
    setStatus('ERROR: ' + err.message, true);
    // Revert optimistic update
    if (wasMe) {
      c.reactions[type].me = true;
      c.reactions[type].count++;
    } else {
      c.reactions[type].me = false;
      c.reactions[type].count = Math.max(0, c.reactions[type].count - 1);
    }
    updateCommentReactionsUI(commentId, c.reactions);
  }
}

function editCommentInline(commentId) {
  const card = document.querySelector(`.comment-card[data-cid="${commentId}"]`);
  if (!card) return;
  const bodyEl = card.querySelector('.atext');
  if (!bodyEl) return;
  
  if (card.classList.contains('editing-comment')) return;
  card.classList.add('editing-comment');
  
  const rawText = card.dataset.rawMarkdown || '';
  
  bodyEl.innerHTML = `
    <div class="inline-comment-edit-container" id="inline_comment_editor_${commentId}"></div>
    <div class="inline-comment-edit-actions" style="margin-top: 8px;">
      <button type="button" class="btn btn-sm cancel-comment-edit-btn" data-cid="${commentId}">Cancel</button>
      <button type="button" class="btn btn-sm save save-comment-edit-btn" data-cid="${commentId}">Save</button>
    </div>
  `;

  const editorContainer = document.getElementById(`inline_comment_editor_${commentId}`);
  const ed = new MarkdownEditor(editorContainer, {
    placeholder: 'Edit your comment...',
    allowAttachments: false,
    allowMentions: true
  });
  ed.value = rawText;
  activeCommentEditors.set(commentId, ed);
}
function cancelEditComment(e, commentId) {
  e.stopPropagation();
  activeCommentEditors.delete(commentId);
  loadActivity();
}
async function saveEditComment(e, commentId) {
  e.stopPropagation();
  const ed = activeCommentEditors.get(commentId);
  if (!ed) return;
  const text = ed.value.trim();
  if (!text) return;
  
  loadStart('saving…');
  try {
    await api.updateComment(cur, commentId, text);
    setStatus('Comment updated');
    activeCommentEditors.delete(commentId);
  } catch (err) {
    setStatus('ERROR: ' + err.message, true);
  }
  loadEnd();
  loadActivity();
}

async function deleteCommentAction(commentId) {
  if (!await customConfirm(window.i18n.t('comment.deleteConfirm'), window.i18n.t('comment.deleteTitle'))) return;
  loadStart('deleting…');
  try {
    await api.deleteComment(cur, commentId);
    setStatus('Comment deleted');
  } catch (err) {
    setStatus('ERROR: ' + err.message, true);
  }
  loadEnd();
  loadActivity();
}

/* ---------- activity: existing comments + field-change history ---------- */
let _actId=null;
const reactionCache=new Map();
async function loadActivity(){
  if(cur==null)return;
  const box=$('s_activity'),id=cur;_actId=id;
  const arrow = document.querySelector('#activity_toggle_btn .toggle-arrow');
  if (arrow && arrow.textContent === '↻') {
    arrow.classList.add('spinning');
  }
  box.innerHTML='<div class="asec">loading…</div>';
  let cs=[],hs=[];
  try{[cs,hs]=await Promise.all([api.comments(id),api.history(id)]);}catch(e){/* render whatever we got */}
  if (arrow) {
    arrow.classList.remove('spinning');
  }
  if(_actId!==id||cur!==id)return;                 // user switched items mid-load
  currentComments = cs;
  currentHistory = hs;
  renderActivity(cs,hs);
}
async function copyCommentLink(commentId, btn) {
  try {
    const base = await api.browserUrl(cur);
    const url = `${base}?_a=discussion&Anchor=comment-${commentId}`;
    await navigator.clipboard.writeText(url);
    setStatus('Comment link copied');
    if (btn) {
      const oldHtml = btn.innerHTML;
      btn.innerHTML = '<ui-icon name="check"></ui-icon>';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.innerHTML = oldHtml;
        btn.classList.remove('copied');
      }, 1000);
    }
  } catch(e) {
    setStatus('Failed to copy link: ' + e.message, true);
  }
}
function handleActivityClick(e) {
  const copylinkBtn = e.target.closest('.copylink-btn');
  if (copylinkBtn) {
    e.stopPropagation();
    const cid = parseInt(copylinkBtn.dataset.cid, 10);
    copyCommentLink(cid, copylinkBtn);
    return;
  }
  const chip = e.target.closest('.reaction-chip');
  if (chip) {
    e.stopPropagation();
    const cid = parseInt(chip.dataset.cid, 10);
    const type = chip.dataset.type;
    toggleReaction(cid, type);
    return;
  }
  const reactBtn = e.target.closest('.react-btn');
  if (reactBtn) {
    e.stopPropagation();
    const cid = parseInt(reactBtn.dataset.cid, 10);
    showEmojiPicker(reactBtn, cid);
    return;
  }
  const editBtn = e.target.closest('.edit-btn');
  if (editBtn) {
    e.stopPropagation();
    const cid = parseInt(editBtn.dataset.cid, 10);
    editCommentInline(cid);
    return;
  }
  const deleteBtn = e.target.closest('.delete-btn');
  if (deleteBtn) {
    e.stopPropagation();
    const cid = parseInt(deleteBtn.dataset.cid, 10);
    deleteCommentAction(cid);
    return;
  }
  const cancelBtn = e.target.closest('.cancel-comment-edit-btn');
  if (cancelBtn) {
    e.stopPropagation();
    const cid = parseInt(cancelBtn.dataset.cid, 10);
    cancelEditComment(e, cid);
    return;
  }
  const saveBtn = e.target.closest('.save-comment-edit-btn');
  if (saveBtn) {
    e.stopPropagation();
    const cid = parseInt(saveBtn.dataset.cid, 10);
    saveEditComment(e, cid);
    return;
  }
}

function handleActivityMouseOver(e) {
  const chip = e.target.closest('.reaction-chip');
  if (!chip) return;
  const cid = parseInt(chip.dataset.cid, 10);
  const type = chip.dataset.type;
  if (!cid || !type) return;
  
  const cacheKey = `${cid}_${type}`;
  if (reactionCache.has(cacheKey)) {
    const names = reactionCache.get(cacheKey);
    chip.title = names.length ? names.join(', ') : 'No reactions';
    return;
  }
  
  // Set temporary loading title
  chip.title = 'Loading...';
  
  // Mark as fetching to avoid duplicate requests
  if (chip.dataset.fetching) return;
  chip.dataset.fetching = 'true';
  
  api.commentReactionUsers(cur, cid, type)
    .then(users => {
      reactionCache.set(cacheKey, users);
      chip.title = users.length ? users.join(', ') : 'No reactions';
      delete chip.dataset.fetching;
    })
    .catch(err => {
      chip.title = 'Failed to load';
      delete chip.dataset.fetching;
    });
}

function renderActivity(cs,hs){
  const fd=s=>s?String(s).slice(0,16).replace('T',' '):'';
  
  const countBadge = $('s_activity_count');
  if (countBadge) {
    countBadge.textContent = cs.length;
    countBadge.style.display = cs.length > 0 ? 'inline-block' : 'none';
  }
  
  const commentsCollapsed = localStorage.getItem('ado.activityCommentsCollapsed') === 'true';
  const historyCollapsed = localStorage.getItem('ado.activityHistoryCollapsed') === 'true';
  
  let h = `
    <div class="asec" id="activity_comments_header" style="cursor:pointer; user-select:none; display:flex; justify-content:space-between; align-items:center;">
      <span>Comments (${cs.length})</span>
      <span class="toggle-arrow" style="font-size:10px; color:var(--muted); transition:transform 0.1s ease">${commentsCollapsed ? '<ui-icon name="chevron-right"></ui-icon>' : '<ui-icon name="chevron-down"></ui-icon>'}</span>
    </div>
    <div id="activity_comments_list" class="${commentsCollapsed ? 'hidden' : ''}" style="display:${commentsCollapsed ? 'none' : 'flex'}; flex-direction:column; gap:8px;">
  `;
  if(!cs.length)h+='<div class="achg">no comments</div>';
  
  const emojiMap = getEmojiMap();
  
  cs.forEach(c => {
    const initials = personInitials(c.by);
    const avColor = personColor(c.by);
    const reacts = c.reactions || {};
    let reactHtml = '';
    Object.entries(emojiMap).forEach(([type, emoji]) => {
      const data = reacts[type];
      if (data && data.count > 0) {
        const active = data.me ? 'active' : '';
        reactHtml += `<span class="reaction-chip ${active}" data-cid="${c.id}" data-type="${type}" title="Show who reacted"><span class="emoji-symbol">${renderEmojiMarkup(type, emoji)}</span> <span class="rc-count">${data.count}</span></span>`;
      }
    });
    
    const isAuthor = currentUser && c.by && (c.by.trim().toLowerCase() === currentUser.trim().toLowerCase());
    const actionsHtml = isAuthor ? `
              <button type="button" class="c-action-btn edit-btn" title="Edit comment" data-cid="${c.id}"><ui-icon name="edit"></ui-icon></button>
              <button type="button" class="c-action-btn delete-btn" title="Delete comment" data-cid="${c.id}"><ui-icon name="trash"></ui-icon></button>
    ` : '';
    
    h += `
      <div class="comment-card" data-cid="${c.id}" data-raw-markdown="${htmlEsc(c.text)}">
        <div class="comment-avatar" style="background:${avColor}">${htmlEsc(initials)}</div>
        <div class="comment-main">
          <div class="comment-header">
            <span class="comment-author">${htmlEsc(c.by)}</span>
            <span class="comment-time">${fd(c.date)}</span>
            <div class="comment-actions">
              <button type="button" class="c-action-btn copylink-btn" title="Copy link to comment" data-cid="${c.id}"><ui-icon name="link"></ui-icon></button>
              <button type="button" class="c-action-btn react-btn" title="Add reaction" data-cid="${c.id}"><ui-icon name="smile"></ui-icon></button>
              ${actionsHtml}
            </div>
          </div>
          <div class="atext">${mdToHtml(c.text, descRenderOpts())}</div>
          <div class="comment-reactions">${reactHtml}</div>
        </div>
      </div>
    `;
  });
  h += '</div>';
  
  h += `
    <div class="asec" id="activity_history_header" style="cursor:pointer; user-select:none; display:flex; justify-content:space-between; align-items:center; margin-top:8px;">
      <span>History (${hs.length})</span>
      <span class="toggle-arrow" style="font-size:10px; color:var(--muted); transition:transform 0.1s ease">${historyCollapsed ? '<ui-icon name="chevron-right"></ui-icon>' : '<ui-icon name="chevron-down"></ui-icon>'}</span>
    </div>
    <div id="activity_history_list" class="${historyCollapsed ? 'hidden' : ''}" style="display:${historyCollapsed ? 'none' : 'flex'}; flex-direction:column; gap:6px;">
  `;
  if(!hs.length)h+='<div class="achg">no recorded changes</div>';
  
  hs.forEach(u => {
    const chg = u.changes.map(c => `
      <div class="achg-row">
        <span class="achg-field">${htmlEsc(c.field)}:</span>
        <span class="achg-from">${htmlEsc(String(c.from)||'∅')}</span>
        <span class="achg-arrow">→</span>
        <span class="achg-to">${htmlEsc(String(c.to)||'∅')}</span>
      </div>
    `).join('');
    
    h += `
      <div class="history-item">
        <div class="history-avatar"><ui-icon name="tool"></ui-icon></div>
        <div class="history-main">
          <div class="history-header">
            <span class="history-author">${htmlEsc(u.by)}</span>
            <span class="history-time">${fd(u.date)}</span>
          </div>
          <div class="history-changes">${chg}</div>
        </div>
      </div>
    `;
  });
  h += '</div>';
  
  const box = $('s_activity');
  box.innerHTML=h;
  hydratePreviewImages(box);
  colorMentions(box);
  
  if (box && !box.dataset.wired) {
    box.dataset.wired = 'true';
    box.addEventListener('click', handleActivityClick);
    box.addEventListener('mouseover', handleActivityMouseOver);
  }
  
  const ach = $('activity_comments_header');
  if (ach) {
    ach.onclick = () => {
      const list = $('activity_comments_list');
      const arrow = ach.querySelector('.toggle-arrow');
      const collapsed = !list.classList.contains('hidden');
      list.classList.toggle('hidden', collapsed);
      list.style.display = collapsed ? 'none' : 'flex';
      arrow.innerHTML = collapsed ? '<ui-icon name="chevron-right"></ui-icon>' : '<ui-icon name="chevron-down"></ui-icon>';
      localStorage.setItem('ado.activityCommentsCollapsed', collapsed);
    };
  }
  const ahh = $('activity_history_header');
  if (ahh) {
    ahh.onclick = () => {
      const list = $('activity_history_list');
      const arrow = ahh.querySelector('.toggle-arrow');
      const collapsed = !list.classList.contains('hidden');
      list.classList.toggle('hidden', collapsed);
      list.style.display = collapsed ? 'none' : 'flex';
      arrow.innerHTML = collapsed ? '<ui-icon name="chevron-right"></ui-icon>' : '<ui-icon name="chevron-down"></ui-icon>';
      localStorage.setItem('ado.activityHistoryCollapsed', collapsed);
    };
  }
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
  App.types.fillTypeSelect('n_type','Task');           // ensure options match the project's real types
  // sprint picker — same source as the editor's; "(no sprint)" = empty value
  try{const iters=await getIterations();_newIterRoot=iters[0]?iters[0].path.split('\\')[0]:(projectName||'');}
  catch(e){/* sprints are optional */}
  sprintNew.set('',/*silent*/true);
  const overlay = $('newitem-overlay');
  overlay.classList.add('show');
  if (window.LayerManager) {
    window.LayerManager.open(overlay);
  }
  $('n_title').focus();
}
function closeNewItem(){
  parentNew.close();
  assignedNew.close();
  sprintNew.close();
  const overlay = $('newitem-overlay');
  overlay.classList.remove('show');
  if (window.LayerManager) {
    window.LayerManager.close(overlay);
  }
}
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

/* ---------- create / edit a sprint (Board → By Sprint "＋" column; sprint screen "edit") ---------- */
function formatDisplayDate(dateStr) {
  if (!dateStr) return '';
  const parts = dateStr.slice(0, 10).split('-');
  if (parts.length !== 3) return dateStr;
  const d = new Date(Date.UTC(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10)));
  return d.toLocaleDateString(window.i18n.getLang(), { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}
function updateSprintRangeDisplay(start, finish) {
  const trigger = $('sprint-range-trigger');
  if (!trigger) return;
  if (start || finish) {
    const sPart = start ? formatDisplayDate(start) : '?';
    const fPart = finish ? formatDisplayDate(finish) : '?';
    trigger.value = `${sPart} — ${fPart}`;
  } else {
    trigger.value = '';
  }
}
function initSprintDatePickerEvents() {
  const trigger = $('sprint-range-trigger');
  if (trigger && !trigger.dataset.init) {
    trigger.dataset.init = '1';
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const popover = $('sprint-range-picker');
      const show = !popover.classList.contains('show');
      popover.classList.toggle('show', show);
      if (window.LayerManager) {
        if (show) window.LayerManager.open(popover, null, { isPopover: true });
        else window.LayerManager.close(popover);
      }
    });
    window.addEventListener('mousedown', (e) => {
      const popover = $('sprint-range-picker');
      if (popover && popover.classList.contains('show')) {
        if (!popover.contains(e.target) && !trigger.contains(e.target)) {
          popover.classList.remove('show');
          if (window.LayerManager) window.LayerManager.close(popover);
        }
      }
    });
    wireManualDateInput('sprint-range-trigger', 'sp_start', 'sp_finish', updateSprintRangeDisplay, false);
  }
}

function wireManualDateInput(triggerId, hiddenStartId, hiddenFinishId, syncFunc, isSingle) {
  const trigger = document.getElementById(triggerId);
  if (!trigger) return;
  
  trigger.addEventListener('change', () => {
    const text = trigger.value.trim();
    if (!text) {
      $(hiddenStartId).value = '';
      if (hiddenFinishId) $(hiddenFinishId).value = '';
      $(hiddenStartId).dispatchEvent(new Event('input'));
      $(hiddenStartId).dispatchEvent(new Event('change'));
      if (hiddenFinishId) {
        $(hiddenFinishId).dispatchEvent(new Event('input'));
        $(hiddenFinishId).dispatchEvent(new Event('change'));
      }
      syncFunc('', '');
      return;
    }
    
    const parsed = parseManualDates(text, isSingle);
    if (parsed) {
      $(hiddenStartId).value = parsed.start;
      if (hiddenFinishId) $(hiddenFinishId).value = parsed.finish;
      $(hiddenStartId).dispatchEvent(new Event('input'));
      $(hiddenStartId).dispatchEvent(new Event('change'));
      if (hiddenFinishId) {
        $(hiddenFinishId).dispatchEvent(new Event('input'));
        $(hiddenFinishId).dispatchEvent(new Event('change'));
      }
      syncFunc(parsed.start, parsed.finish);
    } else {
      const currentStart = $(hiddenStartId).value;
      const currentFinish = hiddenFinishId ? $(hiddenFinishId).value : '';
      syncFunc(currentStart, currentFinish);
    }
  });
  
  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      trigger.blur();
    }
  });
}

function parseManualDates(text, isSingle) {
  const parts = text.split(/[-—–~–]|\sto\s/).map(s => s.trim()).filter(Boolean);
  
  const parseSingle = (str) => {
    if (!str) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
      return str;
    }
    const d = new Date(str);
    if (!isNaN(d.getTime())) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    }
    return null;
  };
  
  const startStr = parseSingle(parts[0]);
  if (!startStr) return null;
  
  if (isSingle) {
    return { start: startStr, finish: startStr };
  } else {
    const finishStr = parseSingle(parts[1]) || startStr;
    return { start: startStr, finish: finishStr };
  }
}

let sideRangePicker = null;
function syncSideDatePicker(start, target) {
  const trigger = $('side-range-trigger');
  const popover = $('side-range-picker');
  if (!trigger || !popover) return;
  
  if (!trigger.dataset.init) {
    trigger.dataset.init = '1';
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const show = !popover.classList.contains('show');
      popover.classList.toggle('show', show);
      if (window.LayerManager) {
        if (show) window.LayerManager.open(popover, null, { isPopover: true });
        else window.LayerManager.close(popover);
      }
    });
    window.addEventListener('mousedown', (e) => {
      if (popover.classList.contains('show')) {
        if (!popover.contains(e.target) && !trigger.contains(e.target)) {
          popover.classList.remove('show');
          if (window.LayerManager) window.LayerManager.close(popover);
        }
      }
    });
    wireManualDateInput('side-range-trigger', 's_start', 's_target', syncSideDatePicker, false);
  }
  
  if (start || target) {
    const sPart = start ? formatDisplayDate(start) : '?';
    const tPart = target ? formatDisplayDate(target) : '?';
    trigger.value = `${sPart} — ${tPart}`;
  } else {
    trigger.value = '';
  }
  
  if (!sideRangePicker || !document.body.contains(sideRangePicker.container)) {
    sideRangePicker = new DateRangePicker('side-range-picker', {
      start,
      finish: target,
      onChange: ({start: s, finish: t}) => {
        $('s_start').value = s;
        $('s_target').value = t;
        
        $('s_start').dispatchEvent(new Event('input'));
        $('s_start').dispatchEvent(new Event('change'));
        $('s_target').dispatchEvent(new Event('input'));
        $('s_target').dispatchEvent(new Event('change'));
        
        syncSideDatePicker(s, t);
        if (s && t) {
          popover.classList.remove('show');
          if (window.LayerManager) window.LayerManager.close(popover);
        }
      }
    });
  } else {
    sideRangePicker.setRange(start, target);
  }
}

let bulkRangePicker = null;
function syncBulkDatePicker(start, target) {
  const trigger = $('bulk-range-trigger');
  const popover = $('bulk-range-picker');
  if (!trigger || !popover) return;
  
  if (!trigger.dataset.init) {
    trigger.dataset.init = '1';
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const show = !popover.classList.contains('show');
      popover.classList.toggle('show', show);
      if (window.LayerManager) {
        if (show) window.LayerManager.open(popover, null, { isPopover: true });
        else window.LayerManager.close(popover);
      }
    });
    window.addEventListener('mousedown', (e) => {
      if (popover.classList.contains('show')) {
        if (!popover.contains(e.target) && !trigger.contains(e.target)) {
          popover.classList.remove('show');
          if (window.LayerManager) window.LayerManager.close(popover);
        }
      }
    });
    wireManualDateInput('bulk-range-trigger', 'bulk_start', 'bulk_target', syncBulkDatePicker, false);
  }
  
  if (start || target) {
    const sPart = start ? formatDisplayDate(start) : '?';
    const tPart = target ? formatDisplayDate(target) : '?';
    trigger.value = `${sPart} — ${tPart}`;
  } else {
    trigger.value = '';
  }
  
  if (!bulkRangePicker) {
    bulkRangePicker = new DateRangePicker('bulk-range-picker', {
      start,
      finish: target,
      onChange: ({start: s, finish: t}) => {
        $('bulk_start').value = s;
        $('bulk_target').value = t;
        syncBulkDatePicker(s, t);
        if (s && t) {
          popover.classList.remove('show');
          if (window.LayerManager) window.LayerManager.close(popover);
        }
      }
    });
  } else {
    bulkRangePicker.setRange(start, target);
  }
}

let setupExpiryPicker = null;
function syncSetupExpiryPicker(expiry) {
  const trigger = $('setup-expiry-trigger');
  const popover = $('setup-expiry-picker');
  if (!trigger || !popover) return;
  
  if (!trigger.dataset.init) {
    trigger.dataset.init = '1';
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const show = !popover.classList.contains('show');
      popover.classList.toggle('show', show);
      if (window.LayerManager) {
        if (show) window.LayerManager.open(popover, null, { isPopover: true });
        else window.LayerManager.close(popover);
      }
    });
    window.addEventListener('mousedown', (e) => {
      if (popover.classList.contains('show')) {
        if (!popover.contains(e.target) && !trigger.contains(e.target)) {
          popover.classList.remove('show');
          if (window.LayerManager) window.LayerManager.close(popover);
        }
      }
    });
    wireManualDateInput('setup-expiry-trigger', 'setup-expiry', null, syncSetupExpiryPicker, true);
  }
  
  if (expiry) {
    trigger.value = formatDisplayDate(expiry);
  } else {
    trigger.value = '';
  }
  
  if (!setupExpiryPicker) {
    setupExpiryPicker = new DateRangePicker('setup-expiry-picker', {
      start: expiry,
      single: true,
      onChange: ({start: d}) => {
        $('setup-expiry').value = d;
        
        $('setup-expiry').dispatchEvent(new Event('input'));
        $('setup-expiry').dispatchEvent(new Event('change'));
        
        syncSetupExpiryPicker(d);
        if (d) {
          popover.classList.remove('show');
          if (window.LayerManager) window.LayerManager.close(popover);
        }
      }
    });
  } else {
    setupExpiryPicker.setRange(expiry, expiry);
  }
}

let sideDuePicker = null;
function syncSideDuePicker(due) {
  const trigger = $('side-due-trigger');
  const popover = $('side-due-picker');
  if (!trigger || !popover) return;
  
  if (!trigger.dataset.init) {
    trigger.dataset.init = '1';
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const show = !popover.classList.contains('show');
      popover.classList.toggle('show', show);
      if (window.LayerManager) {
        if (show) window.LayerManager.open(popover, null, { isPopover: true });
        else window.LayerManager.close(popover);
      }
    });
    window.addEventListener('mousedown', (e) => {
      if (popover.classList.contains('show')) {
        if (!popover.contains(e.target) && !trigger.contains(e.target)) {
          popover.classList.remove('show');
          if (window.LayerManager) window.LayerManager.close(popover);
        }
      }
    });
    wireManualDateInput('side-due-trigger', 's_due', null, syncSideDuePicker, true);
  }
  
  if (due) {
    trigger.value = formatDisplayDate(due);
  } else {
    trigger.value = '';
  }
  
  if (!sideDuePicker || !document.body.contains(sideDuePicker.container)) {
    sideDuePicker = new DateRangePicker('side-due-picker', {
      start: due,
      single: true,
      onChange: ({start: d}) => {
        $('s_due').value = d;
        
        $('s_due').dispatchEvent(new Event('input'));
        $('s_due').dispatchEvent(new Event('change'));
        
        syncSideDuePicker(d);
        if (d) {
          popover.classList.remove('show');
          if (window.LayerManager) window.LayerManager.close(popover);
        }
      }
    });
  } else {
    sideDuePicker.setRange(due, due);
  }
}

function updatePendingSprintItems() {
  const container = $('sprint-pending-container');
  const list = $('sprint-pending-list');
  if (!container || !list) return;
  if (pendingSprintItems && pendingSprintItems.length > 0) {
    container.style.display = 'block';
    list.innerHTML = '';
    pendingSprintItems.forEach(id => {
      const n = store.nodes[id];
      if (!n) return;
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; align-items:center; gap:6px; font-size:12px; margin-bottom:4px; padding:4px 6px; background:var(--panel2); border-radius:4px; border:1px solid var(--line);';
      
      const dot = document.createElement('i');
      dot.className = 'dot';
      dot.style.display = 'inline-block';
      dot.style.background = tyColor(n.type);
      
      const idSpan = document.createElement('span');
      idSpan.style.cssText = 'color:var(--muted); font-weight:600; flex:none;';
      idSpan.textContent = `#${id}`;
      
      const titleSpan = document.createElement('span');
      titleSpan.style.cssText = 'overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; color:var(--txt);';
      titleSpan.textContent = n.title || '';
      
      row.append(dot, idSpan, titleSpan);
      list.appendChild(row);
    });
  } else {
    container.style.display = 'none';
    list.innerHTML = '';
  }
}

let sprintMode='create',sprintEditPath=null,sprintRangePicker=null;
function showSprintModal(){                        // create a new sprint
  sprintMode='create';sprintEditPath=null;
  $('sprint-title').textContent='New sprint';
  $('sprint-err').textContent='';
  $('sp_name').readOnly=false;$('sp_name').value='';$('sp_start').value='';$('sp_finish').value='';
  $('sprint-range-picker').classList.remove('show');
  initSprintDatePickerEvents();
  if(!sprintRangePicker){
    sprintRangePicker=new DateRangePicker('sprint-range-picker',{
      onChange:({start,finish})=>{
        $('sp_start').value=start;
        $('sp_finish').value=finish;
        updateSprintRangeDisplay(start, finish);
        if (start && finish) {
          $('sprint-range-picker').classList.remove('show');
        }
      }
    });
  }else{
    sprintRangePicker.setRange('','');
  }
  updateSprintRangeDisplay('', '');
  updatePendingSprintItems();
  $('sp_create').textContent='Create sprint';
  $('sprint-overlay').classList.add('show');
  if (window.LayerManager) window.LayerManager.open($('sprint-overlay'));
  $('sp_name').focus();
}
function showSprintEdit(path){                     // edit an existing sprint's dates
  const it=_sprint(path);if(!it)return;
  sprintMode='edit';sprintEditPath=path;
  $('sprint-title').textContent='Edit sprint dates';
  $('sprint-err').textContent='';
  $('sp_name').readOnly=true;$('sp_name').value=it.name||'';
  $('sp_start').value=(it.start||'').slice(0,10);$('sp_finish').value=(it.finish||'').slice(0,10);
  $('sprint-range-picker').classList.remove('show');
  if (window.LayerManager) window.LayerManager.close($('sprint-range-picker'));
  initSprintDatePickerEvents();
  if(!sprintRangePicker){
    sprintRangePicker=new DateRangePicker('sprint-range-picker',{
      start:it.start,
      finish:it.finish,
      onChange:({start,finish})=>{
        $('sp_start').value=start;
        $('sp_finish').value=finish;
        updateSprintRangeDisplay(start, finish);
        if (start && finish) {
          $('sprint-range-picker').classList.remove('show');
          if (window.LayerManager) window.LayerManager.close($('sprint-range-picker'));
        }
      }
    });
  }else{
    sprintRangePicker.setRange(it.start,it.finish);
  }
  updateSprintRangeDisplay($('sp_start').value, $('sp_finish').value);
  updatePendingSprintItems();
  $('sp_create').textContent='Save dates';
  $('sprint-overlay').classList.add('show');
  if (window.LayerManager) window.LayerManager.open($('sprint-overlay'));
}
function closeSprintModal(){
  $('sprint-overlay').classList.remove('show');
  if (window.LayerManager) window.LayerManager.close($('sprint-overlay'));
  $('sprint-range-picker').classList.remove('show');
  if (window.LayerManager) window.LayerManager.close($('sprint-range-picker'));
  pendingSprintItems=null;
  updatePendingSprintItems();
}
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

/* work-item types + legend -> app/types.js (App.types.*) */

/* export the current (filtered) view -> app/export.js (App.export.exportView) */

/* ---------- theme (dark / light / auto-follow-system) + auto-refresh ---------- */
function systemDark(){try{return !window.matchMedia||window.matchMedia('(prefers-color-scheme: dark)').matches;}catch(e){return true;}}
function applyTheme(mode){
  const light=mode==='light'||(mode==='auto'&&!systemDark());
  document.body.classList.toggle('light',light);
  const btn=$('theme');
  if(btn){
    btn.title='theme: '+mode+(mode==='auto'?' (follows system)':'')+' — click to change';
    const iconEl=btn.querySelector('ui-icon');
    if(iconEl){
      const iconName=light?'sun':'moon';
      iconEl.setAttribute('name',iconName);
      if(window.ICONS&&window.ICONS[iconName]){
        iconEl.innerHTML=window.ICONS[iconName];
      }
    }
  }
  const tl=$('theme_label');if(tl)tl.textContent=mode;
  if(cy)cy.style().update();                        // re-evaluate theme-aware graph styles (parent label colour)
}
function cycleTheme(){
  let m=localStorage.getItem('ado.theme')||'dark';
  m=m==='dark'?'light':(m==='light'?'auto':'dark');
  try{localStorage.setItem('ado.theme',m);}catch(e){}
  applyTheme(m);
}
function applyFollowNotify(status) {
  const btn = $('f_follow_notify');
  if (!btn) return;
  btn.title = 'notifications: ' + status + ' — click to change';
  btn.innerHTML = (status === 'on' ? '<ui-icon name="bell"></ui-icon> ' : '<ui-icon name="bell-off"></ui-icon> ') + `<span id="f_follow_notify_label">${status}</span>`;
}
async function cycleFollowNotify() {
  const { followNotify = 'on' } = await chrome.storage.local.get("followNotify");
  const next = followNotify === 'on' ? 'off' : 'on';
  await chrome.storage.local.set({ followNotify: next });
  applyFollowNotify(next);
}
function applyMentionNotify(status) {
  const btn = $('f_mention_notify');
  if (!btn) return;
  btn.title = 'mention notifications: ' + status + ' — click to change';
  btn.innerHTML = (status === 'on' ? '<ui-icon name="bell"></ui-icon> ' : '<ui-icon name="bell-off"></ui-icon> ') + `<span id="f_mention_notify_label">${status}</span>`;
}
async function cycleMentionNotify() {
  const { mentionNotify = 'on' } = await chrome.storage.local.get("mentionNotify");
  const next = mentionNotify === 'on' ? 'off' : 'on';
  await chrome.storage.local.set({ mentionNotify: next });
  applyMentionNotify(next);
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
  {kind:'cmd',title:'Export CSV',run:()=>App.export.exportView('csv')},
  {kind:'cmd',title:'Export JSON',run:()=>App.export.exportView('json')},
  {kind:'cmd',title:'Toggle theme',run:()=>cycleTheme()},
  {kind:'cmd',title:'Open settings',run:()=>showSetup(true)},
  {kind:'cmd',title:'Clear bulk selection',run:()=>clearBulk()},
];
function openPalette(){$('palette').classList.add('show');if (window.LayerManager) window.LayerManager.open($('palette'));const i=$('palette-input');i.value='';renderPalette('');i.focus();}
function closePalette(){$('palette').classList.remove('show');if (window.LayerManager) window.LayerManager.close($('palette'));}
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
    const badge=it.state?`<span class="pbadge" style="background:${stateColor(it.state)}">${htmlEsc(it.state)}</span>`:'';
    return `<div class="prow${i===palIdx?' on':''}" data-i="${i}"><span class="pkind">${htmlEsc(it.kind)}</span><span class="ptitle">${htmlEsc(it.title)}</span>${badge}</div>`;
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
    $('oauth-status').innerHTML=name?('<ui-icon name="check"></ui-icon> Signed in as '+htmlEsc(name)):'<ui-icon name="check"></ui-icon> Signed in';
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
    const expiry = c.patExpiry||'';
    $('setup-expiry').value=expiry;
    syncSetupExpiryPicker(expiry);
    updateSetupExpiryInfo();
    $('oauth-client').value=c.oauthClientId||'';
    const t=c.oauthTenant||'organizations';
    if(t==='organizations'){$('oauth-tenant-mode').value='organizations';$('oauth-tenant-id').value='';}
    else{$('oauth-tenant-mode').value='custom';$('oauth-tenant-id').value=t;}
    updateTenantField();
    setAuthPane(c.authMode==='oauth'?'oauth':'pat');
    $('oauth-status').innerHTML=(c.authMode==='oauth'&&c.oauthAccess)?(currentUser?('<ui-icon name="check"></ui-icon> Signed in as '+htmlEsc(currentUser)):'<ui-icon name="check"></ui-icon> Signed in'):'';
    const signedIn=(c.authMode==='oauth')?!!c.oauthAccess:!!c.pat;
    if(c.org&&signedIn)loadSetupProjects();   // reopening settings: populate the project dropdown for the saved org
  });
  $('setup-err').textContent='';
  $('setup-cancel').style.display=cancellable?'inline-block':'none';
  const overlay = $('setup-overlay');
  overlay.classList.add('show');
  if (window.LayerManager) {
    window.LayerManager.open(overlay);
  }
}
function hideSetup(){
  const overlay = $('setup-overlay');
  overlay.classList.remove('show');
  if (window.LayerManager) {
    window.LayerManager.close(overlay);
  }
}

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
  setStatus(n<0?`<ui-icon name="alert-triangle"></ui-icon> PAT expired ${-n} day(s) ago — update it via <ui-icon name="settings"></ui-icon>`
               :(n===0?'<ui-icon name="alert-triangle"></ui-icon> PAT expires today — update it via <ui-icon name="settings"></ui-icon>':`<ui-icon name="alert-triangle"></ui-icon> PAT expires in ${n} day(s) — update it via <ui-icon name="settings"></ui-icon>`),true);
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
  }catch(e){
    showSetupOrgError('Organization not found or PAT has no permissions.');
  }
}
function showSetupOrgError(message) {
  const inputEl = $('setup-org');
  if (!inputEl) return;
  const overlay = $('setup-overlay');
  if (!overlay) return;
  
  const existing = document.querySelector('.setup-org-error');
  if (existing) {
    if (window.LayerManager) window.LayerManager.close(existing);
    existing.remove();
  }
  
  const err = document.createElement('div');
  err.className = 'setup-org-error emoji-row-error';
  err.textContent = message;
  
  overlay.appendChild(err);
  
  const rRect = inputEl.getBoundingClientRect();
  const oRect = overlay.getBoundingClientRect();
  
  const top = rRect.top - oRect.top - 32;
  const left = rRect.left - oRect.left + 10;
  
  err.style.top = `${top}px`;
  err.style.left = `${left}px`;
  err.style.right = 'auto';
  
  if (window.LayerManager) {
    window.LayerManager.open(err, null, { isPopover: true });
  }
  
  setTimeout(() => {
    err.style.opacity = '0';
    setTimeout(() => {
      if (window.LayerManager) window.LayerManager.close(err);
      err.remove();
    }, 200);
  }, 4000);
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
  el.innerHTML=(org?`<span class="pb-org">${htmlEsc(org)}</span><span class="pb-sep">/</span>`:'')+`<span class="pb-proj">${htmlEsc(project)}</span>`;
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
  $('setup-cancel').onclick=hideSetup;
  $('settingsbtn').onclick=()=>{const mp=$('morepanel');if(mp){mp.style.display='none';$('morebtn').classList.remove('on');}showSetup(true);};
  $('ai_settings_btn').onclick=()=>{const mp=$('morepanel');if(mp){mp.style.display='none';$('morebtn').classList.remove('on');}if(window.AISettingsDialog){window.AISettingsDialog.open();}};
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
  {id:'filter-split',label:'Filters & Followed'},
  {id:'fit',label:'Fit graph'},
  {id:'bar-spacer',label:'<ui-icon name="arrow-left-right"></ui-icon> Right-align spacer (flexible gap)'},
  {id:'export',label:'Export (CSV / JSON)'},
  {id:'analytics_btn',label:'Analytics (Pro)'},
  {id:'patbadge',label:'PAT badge'},
  {id:'legend',label:'Type legend'},
  {id:'settings-wrap',label:'Settings menu (<ui-icon name="settings"></ui-icon>)'},
];
const BAR_LOCKED=new Set(['settings-wrap','bar-spacer']);   // never hidden (settings = entry point; spacer = right-align anchor)
let barOrder=BAR_ITEMS.map(i=>i.id), barHidden=new Set();
// Work-item sidebar groups — same reorder + show/hide pattern as the toolbar.
// Each id matches a <div class="sgroup" data-sg="..."> wrapper in #side.
const SIDE_GROUPS=[
  {id:'nav',          label:'Hierarchy nav (↑ parent · ↓ children)'},
  {id:'title',        label:'Title'},
  {id:'state',        label:'State'},
  {id:'priority',     label:'Priority'},
  {id:'assigned',     label:'Assignee'},
  {id:'storypoints',  label:'Story Points'},
  {id:'remaining',    label:'Remaining Work'},
  {id:'completed',    label:'Completed Work'},
  {id:'risk',         label:'Risk'},
  {id:'valuearea',    label:'Value Area'},
  {id:'sprint',       label:'Sprint'},
  {id:'parent',       label:'Parent'},
  {id:'deps',         label:'Dependencies (blocked by · blocks)'},
  {id:'start_target', label:'Start — Target Date'},
  {id:'due',          label:'Due Date'},
  {id:'estimate',     label:'Original Estimate'},
  {id:'time_in_state',label:'Time in State Timeline'},
  {id:'tags',         label:'Tags'},
  {id:'attachments',  label:'Attachments'},
  {id:'desc',         label:'Description'},
  {id:'ac',           label:'Acceptance Criteria'},
  {id:'area',         label:'Area Path'},
  {id:'activity',     label:'Activity'},
];
const SIDE_LOCKED=new Set(['title','state']);    // editor unusable without these
let sideOrder = SIDE_GROUPS.map(g => g.id), sideHidden = new Set(['area', 'activity']);
let activeWType = null; // Track current loaded work item type for sidebar
let currentSideLayout = null;
let czTab = 'bar';

function getDefaultSideLayout(wtype) {
  return {
    version: "1.0",
    wtype: wtype || "",
    layout: [
      { id: "nav", type: "field", ref: "nav" },
      { id: "title", type: "field", ref: "title" },
      {
        id: "group_workflow",
        type: "group",
        title: "Workflow",
        collapsible: true,
        defaultCollapsed: false,
        elements: [
          {
            type: "row",
            columns: [
              { width: "38%", elements: [{ type: "field", ref: "state" }] },
              { width: "24%", elements: [{ type: "field", ref: "priority" }] },
              { width: "38%", elements: [{ type: "field", ref: "assigned" }] }
            ]
          }
        ]
      },
      {
        id: "group_effort",
        type: "group",
        title: "Effort",
        collapsible: true,
        defaultCollapsed: false,
        elements: [
          {
            type: "row",
            columns: [
              { width: "33%", elements: [{ type: "field", ref: "storypoints" }] },
              { width: "33%", elements: [{ type: "field", ref: "remaining" }] },
              { width: "33%", elements: [{ type: "field", ref: "completed" }] }
            ]
          }
        ]
      },
      {
        id: "group_classification",
        type: "group",
        title: "Classification",
        collapsible: true,
        defaultCollapsed: false,
        elements: [
          {
            type: "row",
            columns: [
              { width: "50%", elements: [{ type: "field", ref: "risk" }] },
              { width: "50%", elements: [{ type: "field", ref: "valuearea" }] }
            ]
          }
        ]
      },
      { id: "sprint", type: "field", ref: "sprint" },
      { id: "parent", type: "field", ref: "parent" },
      { id: "deps", type: "field", ref: "deps" },
      {
        id: "group_schedule",
        type: "group",
        title: "Schedule",
        collapsible: true,
        defaultCollapsed: false,
        elements: [
          {
            type: "row",
            columns: [
              { width: "50%", elements: [{ type: "field", ref: "start_target" }] },
              { width: "30%", elements: [{ type: "field", ref: "due" }] },
              { width: "20%", elements: [{ type: "field", ref: "estimate" }] }
            ]
          },
          { type: "field", ref: "time_in_state" }
        ]
      },
      { id: "tags", type: "field", ref: "tags" },
      { id: "attachments", type: "field", ref: "attachments" },
      { id: "desc", type: "field", ref: "desc" },
      { id: "ac", type: "field", ref: "ac" },
      { id: "area", type: "field", ref: "area" },
      { id: "activity", type: "field", ref: "activity" }
    ]
  };
}

function loadSideLayout(wtype, offFormFields = [], availableCustomFields = []) {
  const suffix = wtype ? '.' + wtype : '';
  const layoutKey = 'ado.layout' + suffix;
  const oldOrderKey = 'ado.sideOrder' + suffix;
  const oldHiddenKey = 'ado.sideHidden' + suffix;
  
  try {
    const saved = localStorage.getItem(layoutKey);
    if (saved) {
      currentSideLayout = JSON.parse(saved);
      ensureLayoutFields(wtype, offFormFields, availableCustomFields);
      return;
    }
  } catch(e) {
    console.error("Failed to load side layout schema", e);
  }
  
  try {
    const oldOrder = JSON.parse(localStorage.getItem(oldOrderKey) || 'null');
    const oldHidden = JSON.parse(localStorage.getItem(oldHiddenKey) || 'null');
    
    if (Array.isArray(oldOrder)) {
      const layoutItems = [];
      const hiddenSet = new Set(Array.isArray(oldHidden) ? oldHidden : ['area', 'activity', ...offFormFields]);
      
      oldOrder.forEach(id => {
        if (!hiddenSet.has(id) && id !== 'actions') {
          // Map old flat composite IDs to individual fields
          if (id === 'workflow') {
            layoutItems.push({ id: 'state', type: 'field', ref: 'state' });
            layoutItems.push({ id: 'priority', type: 'field', ref: 'priority' });
            layoutItems.push({ id: 'assigned', type: 'field', ref: 'assigned' });
          } else if (id === 'effort') {
            layoutItems.push({ id: 'storypoints', type: 'field', ref: 'storypoints' });
            layoutItems.push({ id: 'remaining', type: 'field', ref: 'remaining' });
            layoutItems.push({ id: 'completed', type: 'field', ref: 'completed' });
          } else if (id === 'classification') {
            layoutItems.push({ id: 'risk', type: 'field', ref: 'risk' });
            layoutItems.push({ id: 'valuearea', type: 'field', ref: 'valuearea' });
          } else if (id === 'schedule') {
            layoutItems.push({ id: 'start_target', type: 'field', ref: 'start_target' });
            layoutItems.push({ id: 'due', type: 'field', ref: 'due' });
            layoutItems.push({ id: 'estimate', type: 'field', ref: 'estimate' });
          } else {
            layoutItems.push({ id: id, type: 'field', ref: id });
          }
        }
      });
      layoutItems.push({ id: 'actions', type: 'field', ref: 'actions' });
      
      currentSideLayout = {
        version: "1.0",
        wtype: wtype || "",
        layout: layoutItems
      };
      ensureLayoutFields(wtype, offFormFields, availableCustomFields);
      saveSideLayout(wtype);
      return;
    }
  } catch(e) {
    console.error("Failed to migrate side layout schema", e);
  }
  
  const def = getDefaultSideLayout(wtype);
  const hiddenSet = new Set(['area', 'activity', ...offFormFields]);
  def.layout = def.layout.filter(item => !hiddenSet.has(item.ref));
  currentSideLayout = def;
  ensureLayoutFields(wtype, offFormFields, availableCustomFields);
  saveSideLayout(wtype);
}

function saveSideLayout(wtype) {
  if (!currentSideLayout) return;
  const suffix = wtype ? '.' + wtype : '';
  const layoutKey = 'ado.layout' + suffix;
  try {
    localStorage.setItem(layoutKey, JSON.stringify(currentSideLayout));
  } catch(e) {
    console.error("Failed to save side layout schema", e);
  }
}

function ensureLayoutFields(wtype, offFormFields, availableCustomFields = []) {
  if (!currentSideLayout) return;
  const placed = new Set();
  const traverse = (node) => {
    if (!node) return;
    if (typeof node === 'string') placed.add(node);
    else if (node.type === 'field') placed.add(node.ref);
    else if (node.elements) node.elements.forEach(traverse);
    else if (node.columns) node.columns.forEach(col => (col.elements || []).forEach(traverse));
  };
  currentSideLayout.layout.forEach(traverse);
  
  if (!placed.has('title')) {
    currentSideLayout.layout.unshift({ id: 'title', type: 'field', ref: 'title' });
    placed.add('title');
  }

  // Field types that need full width (no row batching)
  const WIDE_TYPES = new Set(['html', 'plainText', 'history']);

  // Build a lookup from cfId → {formGroup, fieldType}
  const cfMetaMap = new Map();
  availableCustomFields.forEach(cf => {
    if (typeof cf === 'object') {
      cfMetaMap.set(cf.id, { formGroup: cf.formGroup || null, fieldType: cf.fieldType || 'string' });
    }
  });

  // Helper: arrange field IDs into layout elements with row batching for compact types
  const buildGroupElements = (fieldIds) => {
    const elements = [];
    const compactBatch = []; // accumulate compact fields

    const flushBatch = () => {
      if (compactBatch.length === 0) return;
      if (compactBatch.length === 1) {
        // Single compact field — no need for a row wrapper
        elements.push(compactBatch[0]);
      } else {
        // Batch into rows of 2-3
        for (let i = 0; i < compactBatch.length; i += 3) {
          const chunk = compactBatch.slice(i, i + 3);
          const pct = chunk.length === 3 ? '33.3%' : '50%';
          elements.push({
            type: 'row',
            columns: chunk.map(f => ({ width: pct, elements: [f] }))
          });
        }
      }
      compactBatch.length = 0;
    };

    fieldIds.forEach(cfId => {
      const meta = cfMetaMap.get(cfId);
      const fType = meta ? meta.fieldType : 'string';
      const fieldNode = { id: cfId, type: 'field', ref: cfId };

      if (WIDE_TYPES.has(fType)) {
        flushBatch();
        elements.push(fieldNode);
      } else {
        compactBatch.push(fieldNode);
      }
    });
    flushBatch();
    return elements;
  };

  // Helper: create or find a cust_group node and set its elements
  const makeGroupId = (label) => 'cust_group_' + label.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();

  const insertIntoGroup = (label, fieldIds) => {
    const groupId = makeGroupId(label);
    const existingGroup = currentSideLayout.layout.find(n => n.id === groupId && n.type === 'group');
    if (existingGroup) {
      const existingRefs = new Set();
      const collectRefs = (node) => {
        if (node.type === 'field') existingRefs.add(node.ref);
        else if (node.elements) node.elements.forEach(collectRefs);
        else if (node.columns) node.columns.forEach(c => (c.elements || []).forEach(collectRefs));
      };
      existingGroup.elements.forEach(collectRefs);
      const newIds = fieldIds.filter(id => !existingRefs.has(id));
      if (newIds.length > 0) {
        existingGroup.elements.push(...buildGroupElements(newIds));
      }
    } else {
      currentSideLayout.layout.push({
        id: groupId,
        type: 'group',
        title: label,
        collapsible: true,
        defaultCollapsed: false,
        elements: buildGroupElements(fieldIds)
      });
    }
  };

  // Migrate existing flat custom fields at root level into group nodes
  if (cfMetaMap.size > 0) {
    const toRegroup = []; // {cfId, formGroup}
    for (let i = currentSideLayout.layout.length - 1; i >= 0; i--) {
      const node = currentSideLayout.layout[i];
      if (node && node.type === 'field' && node.ref && node.ref.startsWith('cust:')) {
        const meta = cfMetaMap.get(node.ref);
        if (meta && meta.formGroup) {
          toRegroup.push({ cfId: node.ref, formGroup: meta.formGroup });
          currentSideLayout.layout.splice(i, 1);
        }
      }
    }
    // Insert regrouped fields
    const regrouped = {};
    toRegroup.forEach(cf => {
      (regrouped[cf.formGroup] = regrouped[cf.formGroup] || []).push(cf.cfId);
    });
    for (const [label, fieldIds] of Object.entries(regrouped)) {
      insertIntoGroup(label, fieldIds);
    }
  }

  // Auto-append any newly discovered custom fields that aren't already placed & not hidden.
  const hiddenFields = currentSideLayout.hiddenFields || [];
  const toInsert = []; // {id, formGroup}
  availableCustomFields.forEach(cf => {
    const cfId = typeof cf === 'string' ? cf : cf.id;
    const formGroup = typeof cf === 'string' ? null : (cf.formGroup || null);
    if (!placed.has(cfId) && !hiddenFields.includes(cfId)) {
      toInsert.push({ id: cfId, formGroup });
      placed.add(cfId);
    }
  });

  // Group by formGroup label
  const grouped = {};
  const ungrouped = [];
  toInsert.forEach(cf => {
    if (cf.formGroup) {
      (grouped[cf.formGroup] = grouped[cf.formGroup] || []).push(cf.id);
    } else {
      ungrouped.push(cf.id);
    }
  });

  // Insert grouped custom fields as collapsible group nodes with row batching
  for (const [label, fieldIds] of Object.entries(grouped)) {
    insertIntoGroup(label, fieldIds);
  }

  // Insert ungrouped custom fields flat (with row batching)
  if (ungrouped.length > 0) {
    currentSideLayout.layout.push(...buildGroupElements(ungrouped));
  }
}

function sideOrderedIds() {
  const result = [];
  const traverse = (node) => {
    if (!node) return;
    if (typeof node === 'string') {
      result.push(node);
    } else if (node.type === 'field') {
      result.push(node.ref);
    } else if (node.elements) {
      node.elements.forEach(traverse);
    } else if (node.columns) {
      node.columns.forEach(col => (col.elements || []).forEach(traverse));
    }
  };
  if (currentSideLayout && currentSideLayout.layout) {
    currentSideLayout.layout.forEach(traverse);
  }
  
  if (!result.includes('title')) result.unshift('title');
  
  return [...new Set(result)];
}

function applySideLayout(wtype) {
  const side = $('side');
  if (!side) return;
  
  const sgroups = {};
  side.querySelectorAll('.sgroup').forEach(el => {
    const sg = el.dataset.sg;
    if (sg) {
      sgroups[sg] = el;
      el.remove();
    }
  });
  
  side.querySelectorAll('.sg-row, .sg-group-panel, .sg-separator, .sg-custom-label').forEach(el => el.remove());
  
  if (!currentSideLayout || currentSideLayout.wtype !== (wtype || '')) {
    loadSideLayout(wtype);
  }
  
  const hasVisibleContent = (container) => {
    const children = [...container.children];
    return children.some(el => {
      if (el.classList.contains('sg-hidden') || el.style.display === 'none') {
        return false;
      }
      if (el.classList.contains('sg-row') || el.classList.contains('sg-col')) {
        return hasVisibleContent(el);
      }
      if (el.classList.contains('sg-separator') || el.classList.contains('sg-custom-label')) {
        return false;
      }
      return true;
    });
  };

  const renderNode = (node, parentEl) => {
    if (!node) return;
    
    if (typeof node === 'string') {
      if (node === 'actions') return;
      const el = sgroups[node];
      if (el) {
        el.classList.remove('sg-hidden');
        parentEl.appendChild(el);
        if (cur != null) ensureFieldLoaded(node);
      }
      return;
    }
    
    if (node.type === 'field') {
      if (node.ref === 'actions') return;
      if (node.visible === false) return;
      const el = sgroups[node.ref];
      if (el) {
        el.classList.remove('sg-hidden');
        parentEl.appendChild(el);
        if (cur != null) ensureFieldLoaded(node.ref);
      }
      return;
    }
    
    if (node.type === 'row') {
      const rowEl = document.createElement('div');
      rowEl.className = 'sg-row';
      if (node.id) rowEl.id = node.id;
      
      const colsToRender = [];
      (node.columns || []).forEach(col => {
        const colEl = document.createElement('div');
        colEl.className = 'sg-col';
        
        (col.elements || []).forEach(child => {
          renderNode(child, colEl);
        });
        colsToRender.push({ colEl, colWidth: col.width });
      });
      
      const visibleCols = colsToRender.filter(c => {
        return [...c.colEl.children].some(child => !child.classList.contains('sg-hidden'));
      });
      
      colsToRender.forEach(c => {
        const isVisible = visibleCols.includes(c);
        if (!isVisible) {
          c.colEl.style.display = 'none';
        } else {
          c.colEl.style.display = '';
          if (c.colWidth) {
            c.colEl.style.flex = `1 1 ${c.colWidth}`;
            if (visibleCols.length < colsToRender.length) {
              c.colEl.style.maxWidth = 'none';
            } else {
              c.colEl.style.maxWidth = c.colWidth;
            }
          }
        }
        rowEl.appendChild(c.colEl);
      });
      
      parentEl.appendChild(rowEl);
      return;
    }
    
    if (node.type === 'group') {
      if (node.visible === false) return;
      const groupEl = document.createElement('div');
      groupEl.className = 'sg-group-panel';
      if (node.id) groupEl.id = node.id;
      
      const hdrEl = document.createElement('div');
      hdrEl.className = 'sg-group-hdr';
      hdrEl.innerHTML = `<span class="toggle-arrow"><ui-icon name="chevron-down"></ui-icon></span> <span class="title-text">${htmlEsc(node.title)}</span>`;
      groupEl.appendChild(hdrEl);
      
      const bodyEl = document.createElement('div');
      bodyEl.className = 'sg-group-body';
      
      if (node.collapsible) {
        hdrEl.style.cursor = 'pointer';
        const collapsedKey = `ado.collapsed.${node.id}`;
        const isCollapsed = localStorage.getItem(collapsedKey) === 'true' || (node.defaultCollapsed && localStorage.getItem(collapsedKey) === null);
        if (isCollapsed) {
          groupEl.classList.add('collapsed');
          hdrEl.querySelector('.toggle-arrow').innerHTML = '<ui-icon name="chevron-right"></ui-icon>';
        }
        hdrEl.onclick = () => {
          const nowCollapsed = groupEl.classList.toggle('collapsed');
          localStorage.setItem(collapsedKey, nowCollapsed ? 'true' : 'false');
          hdrEl.querySelector('.toggle-arrow').innerHTML = nowCollapsed ? '<ui-icon name="chevron-right"></ui-icon>' : '<ui-icon name="chevron-down"></ui-icon>';
        };
      }
      
      (node.elements || []).forEach(child => {
        renderNode(child, bodyEl);
      });
      groupEl.appendChild(bodyEl);
      
      if (!hasVisibleContent(bodyEl)) {
        groupEl.style.display = 'none';
      }
      
      parentEl.appendChild(groupEl);
      return;
    }
    
    if (node.type === 'separator') {
      const sep = document.createElement('div');
      sep.className = 'sg-separator';
      parentEl.appendChild(sep);
      return;
    }
    
    if (node.type === 'label') {
      const lbl = document.createElement('div');
      lbl.className = 'sg-custom-label';
      lbl.textContent = node.text || '';
      parentEl.appendChild(lbl);
      return;
    }
  };
  
  (currentSideLayout.layout || []).forEach(node => {
    renderNode(node, side);
  });
  
  const placed = new Set(sideOrderedIds());
  Object.keys(sgroups).forEach(ref => {
    if (ref === 'actions') return;
    if (!placed.has(ref)) {
      const el = sgroups[ref];
      el.classList.add('sg-hidden');
      side.appendChild(el);
    }
  });
  
  if (sgroups['actions']) {
    sgroups['actions'].classList.remove('sg-hidden');
    side.appendChild(sgroups['actions']);
  }
  
  const descHidden = !placed.has('desc');
  ['s_desc_attach','s_desc_full'].forEach(id=>{
    const el=$(id);if(el)el.style.display=descHidden?'none':'';
  });
}
const BULK_ITEMS=[
  {id:'state',label:'State'},
  {id:'priority',label:'Priority'},
  {id:'assigned',label:'Assignee'},
  {id:'iteration',label:'Sprint'},
  {id:'parent',label:'Parent'},
  {id:'tags',label:'Tags (Add/Remove)'},
  {id:'dates',label:'Dates (Start/Target)'},
  {id:'followed',label:'Follow / Unfollow'},
];
const BULK_LOCKED=new Set();
let bulkOrder=BULK_ITEMS.map(i=>i.id), bulkHidden=new Set(['parent', 'dates', 'followed']);
function loadBulkLayout(){
  try{const o=JSON.parse(localStorage.getItem('ado.bulkOrder')||'null');if(Array.isArray(o))bulkOrder=o;}catch(e){}
  try{const h=JSON.parse(localStorage.getItem('ado.bulkHidden')||'null');if(Array.isArray(h))bulkHidden=new Set(h);}catch(e){}
}
function saveBulkLayout(){try{localStorage.setItem('ado.bulkOrder',JSON.stringify(bulkOrderedIds()));localStorage.setItem('ado.bulkHidden',JSON.stringify([...bulkHidden]));}catch(e){}}
function bulkOrderedIds(){
  const def=BULK_ITEMS.map(i=>i.id),defSet=new Set(def);
  const result=bulkOrder.filter((id,i)=>defSet.has(id)&&bulkOrder.indexOf(id)===i);
  def.forEach((id,i)=>{
    if(result.includes(id))return;
    let at=result.length;
    for(let j=i-1;j>=0;j--){const k=result.indexOf(def[j]);if(k>=0){at=k+1;break;}}
    result.splice(at,0,id);
  });
  return result;
}
function applyBulkLayout(){
  const bar=$('bulkbar');if(!bar)return;
  const ids=bulkOrderedIds();
  ids.forEach(id=>{
    const el=$('bulk_g_'+id);
    if(el)bar.appendChild(el);
  });
  const clearBtn=$('bulk_clear');
  if(clearBtn)bar.appendChild(clearBtn);
  const custBtn=$('bulk_cust_btn');
  if(custBtn)bar.appendChild(custBtn);
  BULK_ITEMS.forEach(i=>{
    const el=$('bulk_g_'+i.id);
    if(el)el.style.display=bulkHidden.has(i.id)?'none':'inline-flex';
  });
}

function loadBarLayout(){
  try{const o=JSON.parse(localStorage.getItem('ado.barOrder')||'null');if(Array.isArray(o))barOrder=o;}catch(e){}
  try{const h=JSON.parse(localStorage.getItem('ado.barHidden')||'null');if(Array.isArray(h))barHidden=new Set(h.filter(id=>!BAR_LOCKED.has(id)));}catch(e){}
}
function saveBarLayout(){try{localStorage.setItem('ado.barOrder',JSON.stringify(barOrderedIds()));localStorage.setItem('ado.barHidden',JSON.stringify([...barHidden]));}catch(e){}}
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
let czWType = ''; // selected type to customize; empty string means default/all
let czSupportedGroups = new Set();

async function updateSideGroupsForType(wtype) {
  for (let i = SIDE_GROUPS.length - 1; i >= 0; i--) {
    if (SIDE_GROUPS[i].id.startsWith('cust:')) {
      SIDE_GROUPS.splice(i, 1);
    }
  }
  czSupportedGroups.clear();
  
  if (wtype) {
    try {
      const fields = await api.getWorkItemTypeFields(wtype);
      const refNames = new Set(fields.map(f => f.referenceName));
      
      const hasDesc = refNames.has("System.Description") || refNames.has("Microsoft.VSTS.TCM.ReproSteps");
      const hasAc = refNames.has("Microsoft.VSTS.Common.AcceptanceCriteria");
      const hasArea = refNames.has("System.AreaPath");
      const hasActivity = refNames.has("Microsoft.VSTS.Common.Activity");
      
      const hasStoryPoints = refNames.has("Microsoft.VSTS.Scheduling.StoryPoints");
      const hasRemaining = refNames.has("Microsoft.VSTS.Scheduling.RemainingWork");
      const hasCompleted = refNames.has("Microsoft.VSTS.Scheduling.CompletedWork");

      const hasRisk = refNames.has("Microsoft.VSTS.Common.Risk");
      const hasValueArea = refNames.has("Microsoft.VSTS.Common.ValueArea");

      const hasStartOrTarget = refNames.has("Microsoft.VSTS.Scheduling.StartDate") || 
                               refNames.has("Microsoft.VSTS.Scheduling.TargetDate") || 
                               refNames.has("Microsoft.VSTS.Scheduling.FinishDate");
      const hasDue = refNames.has("Microsoft.VSTS.Scheduling.DueDate");
      const hasEstimate = refNames.has("Microsoft.VSTS.Scheduling.OriginalEstimate");

      // Always supported groups
      ['nav', 'title', 'state', 'priority', 'assigned', 'sprint', 'parent', 'deps', 'tags', 'attachments'].forEach(id => czSupportedGroups.add(id));

      if (hasDesc) czSupportedGroups.add('desc');
      if (hasAc) czSupportedGroups.add('ac');
      if (hasArea) czSupportedGroups.add('area');
      if (hasActivity) czSupportedGroups.add('activity');
      if (hasStoryPoints) czSupportedGroups.add('storypoints');
      if (hasRemaining) czSupportedGroups.add('remaining');
      if (hasCompleted) czSupportedGroups.add('completed');
      if (hasRisk) czSupportedGroups.add('risk');
      if (hasValueArea) czSupportedGroups.add('valuearea');
      if (hasStartOrTarget) czSupportedGroups.add('start_target');
      if (hasDue) czSupportedGroups.add('due');
      if (hasEstimate) czSupportedGroups.add('estimate');
      if (hasStartOrTarget || hasDue || hasEstimate) czSupportedGroups.add('time_in_state');

      fields.forEach(cf => {
        if (!api.isCoreField(cf.referenceName)) {
          const sgId = 'cust:' + cf.referenceName;
          czSupportedGroups.add(sgId);
          let existingGroup = SIDE_GROUPS.find(g => g.id === sgId);
          if (!existingGroup) {
            SIDE_GROUPS.push({
              id: sgId,
              label: 'Custom: ' + cf.name,
              customType: cf.type,
              allowedValues: cf.allowedValues,
              isIdentity: cf.isIdentity
            });
          } else {
            existingGroup.customType = cf.type;
            existingGroup.allowedValues = cf.allowedValues;
            existingGroup.isIdentity = cf.isIdentity;
          }
        }
      });
    } catch(e) { console.error(e); }
  } else {
    SIDE_GROUPS.forEach(g => czSupportedGroups.add(g.id));
  }
}

async function showCustomize(){
  const mp=$('morepanel');
  if(mp){
    mp.style.display='none';
    if (window.LayerManager) window.LayerManager.close(mp);
    $('morebtn').classList.remove('on');
  }
  
  czWType = activeWType || '';
  await updateSideGroupsForType(czWType);
  
  // Populate wtype chips
  const types = [''].concat(typeList.length ? typeList.map(t=>t.name) : TYPES);
  const chipsCont = $('cz_wtype_chips');
  if (chipsCont) {
    chipsCont.innerHTML = types.map(t => {
      const label = t || 'All Types';
      const active = (czWType || '') === t ? ' class="type-chip on"' : ' class="type-chip"';
      return `<button data-wtype="${t}"${active}>${htmlEsc(label)}</button>`;
    }).join('');

    chipsCont.querySelectorAll('button').forEach(btn => {
      btn.onclick = async () => {
        chipsCont.querySelectorAll('button').forEach(b => b.classList.remove('on'));
        btn.classList.add('on');
        czWType = btn.dataset.wtype;
        await updateSideGroupsForType(czWType);
        let offFormFields = [];
        let customFieldIds = [];
        if (czWType) {
          try {
            const fields = await api.getWorkItemTypeFields(czWType);
            offFormFields = fields.filter(f => !f.isOnForm).map(f => 'cust:' + f.referenceName);
            customFieldIds = fields
              .filter(cf => !api.isCoreField(cf.referenceName) && cf.isOnForm)
              .map(cf => ({ id: 'cust:' + cf.referenceName, formGroup: cf.formGroup, fieldType: cf.type }));
          } catch (e) {}
        }
        loadSideLayout(czWType, offFormFields, customFieldIds);
        renderCustomizeList();
      };
    });
  }
  
  renderCustomizeList();
  $('customize-overlay').classList.add('show');
  if (window.LayerManager) window.LayerManager.open($('customize-overlay'));
}

function closeCustomize(){
  $('customize-overlay').classList.remove('show');
  if (window.LayerManager) window.LayerManager.close($('customize-overlay'));
}

// Visual Layout Editor interactive preview and drag-drop logic
let draggingNodeId = null;
let draggingType = null;
window.addEventListener('dragend', () => {
  draggingType = null;
  draggingNodeId = null;
});

function renderVisualLayoutBuilder() {
  renderToolboxFields();
  renderCanvas();
  initToolboxStructures();
}

function initToolboxStructures() {
  const container = $('cz_toolbox_structures');
  if (!container) return;
  container.querySelectorAll('.cz-toolbox-item').forEach(item => {
    item.ondragstart = (e) => {
      draggingType = item.dataset.type;
      draggingNodeId = null;
      e.dataTransfer.setData('text/plain', JSON.stringify({
        source: 'toolbox',
        type: item.dataset.type
      }));
    };
  });
}

function getIconForField(g) {
  if (!g) return '⠿';
  const id = g.id;
  if (id.startsWith('cust:')) {
    if (g.isIdentity) return '<ui-icon name="user"></ui-icon>';
    if (g.customType === 'dateTime') return '<ui-icon name="calendar"></ui-icon>';
    if (g.customType === 'allowedValues' || g.allowedValues) return '▼';
    if (g.customType === 'html') return '<ui-icon name="file-text"></ui-icon>';
    if (g.customType === 'plain') return '<ui-icon name="type"></ui-icon>';
    return '<ui-icon name="settings"></ui-icon>';
  }
  const mapping = {
    nav: '<ui-icon name="compass"></ui-icon>',
    title: '<ui-icon name="tag"></ui-icon>',
    state: '<ui-icon name="refresh-cw"></ui-icon>',
    priority: '<ui-icon name="zap"></ui-icon>',
    assigned: '<ui-icon name="user"></ui-icon>',
    storypoints: '<ui-icon name="hash"></ui-icon>',
    remaining: '<ui-icon name="clock"></ui-icon>',
    completed: '<ui-icon name="check-circle"></ui-icon>',
    risk: '<ui-icon name="alert-triangle"></ui-icon>',
    valuearea: '<ui-icon name="gem"></ui-icon>',
    sprint: '<ui-icon name="milestone"></ui-icon>',
    parent: '<ui-icon name="arrow-up"></ui-icon>',
    deps: '<ui-icon name="link"></ui-icon>',
    start_target: '<ui-icon name="calendar"></ui-icon>',
    due: '<ui-icon name="clock"></ui-icon>',
    estimate: '<ui-icon name="ruler"></ui-icon>',
    time_in_state: '<ui-icon name="clock"></ui-icon>',
    tags: '<ui-icon name="tag"></ui-icon>',
    attachments: '<ui-icon name="paperclip"></ui-icon>',
    desc: '<ui-icon name="file-text"></ui-icon>',
    ac: '<ui-icon name="copy"></ui-icon>',
    area: '<ui-icon name="map-pin"></ui-icon>',
    activity: '<ui-icon name="settings"></ui-icon>'
  };
  return mapping[id] || '⠿';
}

function renderToolboxFields() {
  const container = $('cz_toolbox_fields');
  if (!container) return;
  
  const placed = new Set();
  const traverse = (node) => {
    if (!node) return;
    if (typeof node === 'string') placed.add(node);
    else if (node.type === 'field') placed.add(node.ref);
    else if (node.elements) node.elements.forEach(traverse);
    else if (node.columns) node.columns.forEach(col => (col.elements || []).forEach(traverse));
  };
  if (currentSideLayout && currentSideLayout.layout) {
    currentSideLayout.layout.forEach(traverse);
  }
  
  const unused = SIDE_GROUPS.filter(g => {
    return czSupportedGroups.has(g.id) && !placed.has(g.id);
  });
  
  container.innerHTML = unused.map(g => {
    return `<div class="cz-toolbox-item" draggable="true" data-type="field" data-ref="${g.id}">` +
      `<span class="grip">${getIconForField(g)}</span> ${htmlEsc(g.label || g.id)}</div>`;
  }).join('');
  
  container.querySelectorAll('.cz-toolbox-item').forEach(item => {
    item.ondragstart = (e) => {
      draggingType = 'field';
      draggingNodeId = null;
      const ref = item.dataset.ref;
      const g = SIDE_GROUPS.find(x => x.id === ref);
      e.dataTransfer.setData('text/plain', JSON.stringify({
        source: 'toolbox',
        type: 'field',
        ref: ref,
        label: g ? (g.label || g.id) : ref
      }));
    };
  });
}

function getMockFieldHtml(fieldId, label) {
  const selectStyle = `width:100%; box-sizing:border-box; height:2.154rem; font-size:0.923rem; padding:0 8px; border:1px solid var(--line); border-radius:4px; background:var(--panel2); color:var(--txt); pointer-events:none;`;
  const inputStyle = `width:100%; box-sizing:border-box; height:2.154rem; font-size:0.923rem; padding:0 8px; border:1px solid var(--line); border-radius:4px; background:var(--panel2); color:var(--txt); pointer-events:none;`;
  const textareaStyle = `width:100%; box-sizing:border-box; border:1px solid var(--line); border-radius:4px; padding:6px 8px; background:var(--panel2); font-size:0.846rem; color:var(--muted); min-height:3.692rem; pointer-events:none; font-family:inherit; resize:none; line-height:1.4;`;
  
  if (fieldId === 'title') {
    return `<input type="text" value="Implement layout customization" style="${inputStyle}">`;
  }
  if (fieldId === 'state') {
    return `<select style="${selectStyle}"><option>Active</option></select>`;
  }
  if (fieldId === 'priority') {
    return `<select style="${selectStyle}"><option>2</option></select>`;
  }
  if (fieldId === 'assigned') {
    return `<div style="display:flex; gap:4px; width:100%;">
      <div class="btn pcard" style="flex:1; pointer-events:none; border:1px solid var(--line); background:var(--panel2); height:2.462rem; min-width:0; margin:0; display:flex; align-items:center; padding:0.385rem 0.692rem;">
        <div class="pav pavsm" style="background:#2f6fed; display:inline-flex; align-items:center; justify-content:center; font-size:0.615rem; font-weight:700; color:#fff; border-radius:50%; width:1.231rem; height:1.231rem; flex:none;">JD</div>
        <div class="pctitle" style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin-left:6px; font-size:0.923rem; color:var(--txt);">John Doe</div>
      </div>
      <button class="btn" disabled style="padding:6px 9px; height:2.462rem; background:var(--panel2); border:1px solid var(--line); border-radius:4px; font-size:0.923rem; margin:0; color:var(--txt);">me</button>
    </div>`;
  }
  if (fieldId === 'sprint') {
    return `<div class="btn pcard" style="width:100%; pointer-events:none; border:1px solid var(--line); background:var(--panel2); height:2.462rem; margin:0; display:flex; align-items:center; padding:0.385rem 0.692rem;">
      <span style="color:var(--muted); margin-right:4px; font-size:0.923rem; display:inline-flex;"><ui-icon name="milestone"></ui-icon></span>
      <div class="pctitle" style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:0.923rem; color:var(--txt);">Sprint 24</div>
    </div>`;
  }
  if (fieldId === 'parent') {
    return `<div style="display:flex; gap:4px; width:100%;">
      <div class="btn pcard" style="flex:1; pointer-events:none; border:1px solid var(--line); background:var(--panel2); height:2.462rem; min-width:0; margin:0; display:flex; align-items:center; padding:0.385rem 0.692rem;">
        <span class="pcid" style="color:var(--muted); font-size:0.923rem; flex:none;">#1024</span>
        <div class="pctitle" style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin-left:6px; font-size:0.923rem; color:var(--txt);">Epic: User Profile</div>
      </div>
      <button class="btn" disabled style="padding:6px 9px; height:2.462rem; background:var(--panel2); border:1px solid var(--line); border-radius:4px; font-size:0.923rem; margin:0; color:var(--txt); display:inline-flex; align-items:center; justify-content:center;"><ui-icon name="external-link"></ui-icon></button>
    </div>`;
  }
  if (fieldId === 'storypoints') {
    return `<input type="text" value="8" style="${inputStyle}">`;
  }
  if (fieldId === 'remaining') {
    return `<input type="text" value="4" style="${inputStyle}">`;
  }
  if (fieldId === 'completed') {
    return `<input type="text" value="12" style="${inputStyle}">`;
  }
  if (fieldId === 'estimate') {
    return `<input type="text" value="16" style="${inputStyle}">`;
  }
  if (fieldId === 'risk') {
    return `<select style="${selectStyle}"><option>Medium</option></select>`;
  }
  if (fieldId === 'valuearea') {
    return `<select style="${selectStyle}"><option>Business</option></select>`;
  }
  if (fieldId === 'activity') {
    return `<select style="${selectStyle}"><option>Development</option></select>`;
  }
  if (fieldId === 'area') {
    return `<input type="text" value="Project\\Development\\Frontend" style="${inputStyle}">`;
  }
  if (fieldId === 'start_target') {
    return `<div style="position:relative; width:100%;">
      <input type="text" value="2026-06-01 — 2026-06-15" style="${inputStyle} text-align:left; padding-right:24px;">
      <span style="position:absolute; right:8px; top:50%; transform:translateY(-50%); color:var(--muted); font-size:10px;">▼</span>
    </div>`;
  }
  if (fieldId === 'due') {
    return `<div style="position:relative; width:100%;">
      <input type="text" value="2026-06-30" style="${inputStyle} text-align:left; padding-right:24px;">
      <span style="position:absolute; right:8px; top:50%; transform:translateY(-50%); color:var(--muted); font-size:10px;">▼</span>
    </div>`;
  }
  if (fieldId === 'tags') {
    return `<div style="display:flex; flex-wrap:wrap; gap:4px; width:100%; min-height:2.154rem; align-items:center;">
      <span style="font-size:0.769rem; background:rgba(47,111,237,0.15); color:var(--accent); padding:2px 8px; border-radius:12px; font-weight:500;">frontend</span>
      <span style="font-size:0.769rem; background:rgba(47,111,237,0.15); color:var(--accent); padding:2px 8px; border-radius:12px; font-weight:500;">v2</span>
    </div>`;
  }
  if (fieldId === 'deps') {
    return `<div style="font-size:0.846rem; color:var(--muted); display:flex; flex-direction:column; gap:4px; width:100%;">
      <div style="font-size:0.692rem; text-transform:uppercase; color:var(--muted); font-weight:600; letter-spacing:0.5px;">Blocked By</div>
      <div style="display:flex; gap:4px;">
        <div style="font-size:0.769rem; background:var(--panel); border:1px solid var(--line); padding:2px 8px; border-radius:12px; color:var(--txt);">#1080 Database Schema</div>
      </div>
    </div>`;
  }
  if (fieldId === 'time_in_state') {
    return `<div style="display:flex; flex-direction:column; gap:4px; font-size:0.769rem; color:var(--muted); width:100%;">
      <div style="display:flex; justify-content:space-between; font-weight:500;">
        <span>Active: 3d</span>
        <span>Resolved: 1d</span>
      </div>
      <div style="display:flex; height:6px; border-radius:3px; overflow:hidden; background:var(--line);">
        <div style="width:75%; background:#2f6fed;"></div>
        <div style="width:25%; background:#2ebb4e;"></div>
      </div>
    </div>`;
  }
  if (fieldId === 'attachments') {
    return `<div style="font-size:0.846rem; color:var(--muted); display:flex; align-items:center; gap:6px; width:100%;">
      <span><ui-icon name="paperclip"></ui-icon> screenshot.png (240 KB)</span>
    </div>`;
  }
  if (fieldId === 'desc') {
    return `<textarea style="${textareaStyle}" readonly>Detailed user story description goes here...</textarea>`;
  }
  if (fieldId === 'ac') {
    return `<textarea style="${textareaStyle}" readonly>- GIVEN custom layouts\n- WHEN viewing preview\n- THEN show real fields</textarea>`;
  }
  if (fieldId === 'actions') {
    return `<div style="display:flex; justify-content:space-between; align-items:center; width:100%; border-top:1px solid var(--line); padding-top:8px;">
      <div style="display:flex; gap:8px;">
        <span style="font-weight:600; font-size:0.846rem; color:var(--accent); border-bottom:2px solid var(--accent); padding-bottom:2px;">Timeline</span>
        <span style="font-size:0.846rem; color:var(--muted);">History</span>
      </div>
      <button class="btn" disabled style="padding:4px 8px; font-size:0.769rem; background:var(--accent); color:#fff; border:none; border-radius:4px; cursor:default; margin:0;">Add Comment</button>
    </div>`;
  }
  if (fieldId === 'nav') {
    return `<div style="font-size:0.769rem; color:var(--muted); display:flex; gap:4px; align-items:center;">
      <span>Parent Item</span> <span>&gt;</span> <span style="color:var(--txt); font-weight:500;">Current Item</span>
    </div>`;
  }
  
  if (fieldId.startsWith('cust:')) {
    const foundGroup = SIDE_GROUPS.find(g => g.id === fieldId);
    if (foundGroup) {
      const type = (foundGroup.customType || '').toLowerCase();
      const hasAllowedValues = foundGroup.allowedValues && foundGroup.allowedValues.length > 0;
      const isIdentity = foundGroup.isIdentity || type === 'identity';
      
      if (type === 'html' || type === 'plaintext') {
        return `<textarea style="${textareaStyle}" readonly>Mock HTML / Plaintext value...</textarea>`;
      }
      if (type === 'datetime') {
        return `<div style="position:relative; width:100%;">
          <input type="text" value="2026-06-16" style="${inputStyle} text-align:left; padding-right:24px;">
          <span style="position:absolute; right:8px; top:50%; transform:translateY(-50%); color:var(--muted); font-size:10px;">▼</span>
        </div>`;
      }
      if (hasAllowedValues) {
        const firstVal = foundGroup.allowedValues[0] || 'Option 1';
        return `<div class="btn pcard" style="width:100%; pointer-events:none; border:1px solid var(--line); background:var(--panel2); height:2.462rem; margin:0; display:flex; align-items:center; padding:0.385rem 0.692rem;">
          <div class="pctitle" style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:0.923rem; color:var(--txt);">${htmlEsc(firstVal)}</div>
          <span style="color:var(--muted); font-size:10px; margin-left:4px;">▼</span>
        </div>`;
      }
      if (isIdentity) {
        return `<div class="btn pcard" style="width:100%; pointer-events:none; border:1px solid var(--line); background:var(--panel2); height:2.462rem; margin:0; display:flex; align-items:center; padding:0.385rem 0.692rem;">
          <div class="pav pavsm" style="background:#2ebb4e; display:inline-flex; align-items:center; justify-content:center; font-size:0.615rem; font-weight:700; color:#fff; border-radius:50%; width:1.231rem; height:1.231rem; flex:none;">US</div>
          <div class="pctitle" style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin-left:6px; font-size:0.923rem; color:var(--txt);">User Name</div>
        </div>`;
      }
      if (type === 'double' || type === 'integer') {
        return `<input type="number" value="42" style="${inputStyle}">`;
      }
    }
    return `<input type="text" placeholder="[Custom Field Value]" style="${inputStyle}">`;
  }
  return `<input type="text" placeholder="[${htmlEsc(label)}]" style="${inputStyle}">`;
}

function renderCanvas() {
  const canvas = $('cz_canvas');
  if (!canvas) return;
  canvas.innerHTML = '';
  
  if (!currentSideLayout || !currentSideLayout.layout) return;
  const byId = Object.fromEntries(SIDE_GROUPS.map(i => [i.id, i.label]));
  
  const renderPreviewNode = (node, parentEl) => {
    if (!node) return;
    if (!node.id) node.id = 'node_' + Math.random().toString(36).substring(2, 9);
    
    if (typeof node === 'string' || node.type === 'field') {
      const fieldId = typeof node === 'string' ? node : node.ref;
      const label = byId[fieldId] || fieldId;
      
      const el = document.createElement('div');
      el.className = 'cz-preview-field';
      el.dataset.layoutId = node.id;
      el.setAttribute('draggable', 'true');
      
      const locked = SIDE_LOCKED.has(fieldId);
      const grip = '⠿';
      
      el.innerHTML = `<div class="field-lbl">${grip} ${htmlEsc(label)}</div>` +
        `<div class="field-mock-wrapper" style="margin-top:0.385rem; width:100%;">${getMockFieldHtml(fieldId, label)}</div>` +
        (locked ? '' : `<button class="cz-del-btn" title="Remove field"><ui-icon name="x"></ui-icon></button>`);
      
      if (!locked) {
        el.querySelector('.cz-del-btn').onclick = (e) => {
          e.stopPropagation();
          removeLayoutNode(node.id);
        };
      }
      
      el.ondragstart = (e) => {
        e.stopPropagation();
        draggingNodeId = node.id;
        draggingType = 'field';
        e.dataTransfer.setData('text/plain', JSON.stringify({
          source: 'canvas',
          id: node.id
        }));
      };
      
      parentEl.appendChild(el);
      return;
    }
    
    if (node.type === 'group') {
      const el = document.createElement('div');
      el.className = 'sg-group-panel cz-preview-group';
      el.dataset.layoutId = node.id;
      el.setAttribute('draggable', 'true');
      
      el.innerHTML = `<div class="sg-group-hdr">` +
        `<span class="toggle-arrow"><ui-icon name="chevron-down"></ui-icon></span>` +
        `<span class="title-text" contenteditable="true" style="outline:none; border-bottom:1px dashed var(--muted);">${htmlEsc(node.title)}</span>` +
        `</div>` +
        `<div class="sg-group-body cz-preview-col" data-col-parent-id="${node.id}"></div>` +
        `<button class="cz-del-btn" title="Delete group"><ui-icon name="x"></ui-icon></button>`;
      
      // In the layout editor preview, we keep all groups expanded so the user can see their contents and drag/drop elements into them.
      
      const titleSpan = el.querySelector('.title-text');
      titleSpan.onblur = () => {
        node.title = titleSpan.textContent.trim() || "New Group";
        saveSideLayout(czWType);
        applySideLayout(czWType);
      };
      titleSpan.addEventListener('mousedown', e => e.stopPropagation());
      titleSpan.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          titleSpan.blur();
        }
      });
      
      el.querySelector('.cz-del-btn').onclick = (e) => {
        e.stopPropagation();
        removeLayoutNode(node.id);
      };
      
      el.ondragstart = (e) => {
        e.stopPropagation();
        draggingNodeId = node.id;
        draggingType = 'group';
        e.dataTransfer.setData('text/plain', JSON.stringify({
          source: 'canvas',
          id: node.id
        }));
      };
      
      const body = el.querySelector('.sg-group-body');
      (node.elements || []).forEach(child => {
        renderPreviewNode(child, body);
      });
      
      parentEl.appendChild(el);
      setupDropZone(body);
      return;
    }
    
    if (node.type === 'row') {
      const el = document.createElement('div');
      el.className = 'sg-row cz-preview-row';
      el.dataset.layoutId = node.id;
      el.setAttribute('draggable', 'true');
      
      el.innerHTML = `<button class="cz-del-btn" title="Delete row"><ui-icon name="x"></ui-icon></button>`;
      
      el.querySelector('.cz-del-btn').onclick = (e) => {
        e.stopPropagation();
        removeLayoutNode(node.id);
      };
      
      el.ondragstart = (e) => {
        e.stopPropagation();
        draggingNodeId = node.id;
        draggingType = 'row';
        e.dataTransfer.setData('text/plain', JSON.stringify({
          source: 'canvas',
          id: node.id
        }));
      };
      
      (node.columns || []).forEach((col, idx) => {
        const colEl = document.createElement('div');
        colEl.className = 'sg-col cz-preview-col';
        colEl.style.flex = `1 1 ${col.width || '50%'}`;
        colEl.style.maxWidth = col.width || '50%';
        colEl.dataset.rowId = node.id;
        colEl.dataset.colIdx = idx;
        
        (col.elements || []).forEach(child => {
          renderPreviewNode(child, colEl);
        });
        
        el.appendChild(colEl);
        setupDropZone(colEl);
      });
      
      parentEl.appendChild(el);
      return;
    }
    
    if (node.type === 'separator') {
      const el = document.createElement('div');
      el.className = 'sg-separator cz-preview-separator';
      el.dataset.layoutId = node.id;
      el.setAttribute('draggable', 'true');
      
      el.innerHTML = `<span class="sep-line"></span><button class="cz-del-btn" title="Remove separator"><ui-icon name="x"></ui-icon></button>`;
      
      el.querySelector('.cz-del-btn').onclick = (e) => {
        e.stopPropagation();
        removeLayoutNode(node.id);
      };
      
      el.ondragstart = (e) => {
        e.stopPropagation();
        draggingNodeId = node.id;
        draggingType = 'separator';
        e.dataTransfer.setData('text/plain', JSON.stringify({
          source: 'canvas',
          id: node.id
        }));
      };
      
      parentEl.appendChild(el);
      return;
    }
    
    if (node.type === 'label') {
      const el = document.createElement('div');
      el.className = 'sg-custom-label cz-preview-label';
      el.dataset.layoutId = node.id;
      el.setAttribute('draggable', 'true');
      
      el.innerHTML = `<span class="lbl-txt" contenteditable="true" style="outline:none; border-bottom:1px dashed var(--muted);">${htmlEsc(node.text || 'Custom Text')}</span>` +
        `<button class="cz-del-btn" title="Remove block"><ui-icon name="x"></ui-icon></button>`;
      
      const txtSpan = el.querySelector('.lbl-txt');
      txtSpan.onblur = () => {
        node.text = txtSpan.textContent.trim() || "Custom Text";
        saveSideLayout(czWType);
        applySideLayout(czWType);
      };
      txtSpan.addEventListener('mousedown', e => e.stopPropagation());
      txtSpan.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          txtSpan.blur();
        }
      });
      
      el.querySelector('.cz-del-btn').onclick = (e) => {
        e.stopPropagation();
        removeLayoutNode(node.id);
      };
      
      el.ondragstart = (e) => {
        e.stopPropagation();
        draggingNodeId = node.id;
        draggingType = 'label';
        e.dataTransfer.setData('text/plain', JSON.stringify({
          source: 'canvas',
          id: node.id
        }));
      };
      
      parentEl.appendChild(el);
      return;
    }
  };
  
  currentSideLayout.layout.forEach(node => {
    renderPreviewNode(node, canvas);
  });
  
  setupDropZone(canvas, true);
}

function findNodeAndParent(id) {
  if (!currentSideLayout || !currentSideLayout.layout) return null;
  const search = (array) => {
    for (let i = 0; i < array.length; i++) {
      const node = array[i];
      if (node && node.id === id) {
        return { array, index: i, node };
      }
      if (node && node.elements) {
        const found = search(node.elements);
        if (found) return found;
      }
      if (node && node.columns) {
        for (let col of node.columns) {
          const found = search(col.elements || []);
          if (found) return found;
        }
      }
    }
    return null;
  };
  return search(currentSideLayout.layout);
}

function removeLayoutNode(id) {
  const result = findNodeAndParent(id);
  if (result) {
    const node = result.array[result.index];
    const fieldId = typeof node === 'string' ? node : (node && node.ref);
    if (fieldId && fieldId.startsWith('cust:')) {
      if (!currentSideLayout.hiddenFields) {
        currentSideLayout.hiddenFields = [];
      }
      if (!currentSideLayout.hiddenFields.includes(fieldId)) {
        currentSideLayout.hiddenFields.push(fieldId);
      }
    }
    result.array.splice(result.index, 1);
    saveSideLayout(czWType);
    applySideLayout(czWType);
    renderToolboxFields();
    renderCanvas();
  }
}

function setupDropZone(container, isRoot = false) {
  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    
    removeDropIndicators();
    
    const indicator = document.createElement('div');
    indicator.className = 'cz-drop-indicator';
    
    const getAcceptorChildUnderMouse = (acceptor, clientY) => {
      const children = [...acceptor.children].filter(child => 
        !child.classList.contains('cz-drop-indicator') && 
        !child.classList.contains('cz-del-btn') && 
        !child.classList.contains('sg-group-hdr') &&
        child.dataset.layoutId !== draggingNodeId
      );
      return children.find(child => {
        const box = child.getBoundingClientRect();
        return clientY < box.bottom;
      }) || null;
    };
    
    if (draggingType === 'group') {
      // Groups can only be placed at the root of the canvas.
      const canvas = $('cz_canvas');
      const child = getAcceptorChildUnderMouse(canvas, e.clientY);
      if (child) {
        const box = child.getBoundingClientRect();
        const placeBefore = e.clientY < box.top + box.height / 2;
        if (placeBefore) {
          canvas.insertBefore(indicator, child);
        } else {
          canvas.insertBefore(indicator, child.nextSibling);
        }
      } else {
        canvas.appendChild(indicator);
      }
    } else if (draggingType === 'row') {
      // Rows can be placed in the root canvas or inside a group body.
      const acceptor = e.target.closest('#cz_canvas, .sg-group-body');
      if (acceptor) {
        const child = getAcceptorChildUnderMouse(acceptor, e.clientY);
        if (child) {
          const box = child.getBoundingClientRect();
          const placeBefore = e.clientY < box.top + box.height / 2;
          if (placeBefore) {
            acceptor.insertBefore(indicator, child);
          } else {
            acceptor.insertBefore(indicator, child.nextSibling);
          }
        } else {
          acceptor.appendChild(indicator);
        }
      }
    } else {
      // Fields, labels, separators can be placed in canvas, group body, or columns.
      const acceptor = e.target.closest('#cz_canvas, .sg-group-body, .sg-col');
      if (acceptor) {
        const child = getAcceptorChildUnderMouse(acceptor, e.clientY);
        if (child) {
          const box = child.getBoundingClientRect();
          const placeBefore = e.clientY < box.top + box.height / 2;
          if (placeBefore) {
            acceptor.insertBefore(indicator, child);
          } else {
            acceptor.insertBefore(indicator, child.nextSibling);
          }
        } else {
          acceptor.appendChild(indicator);
        }
      }
    }
  });
  
  container.addEventListener('dragleave', (e) => {
    if (!container.contains(e.relatedTarget)) {
      removeDropIndicators();
    }
  });
  
  container.ondrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    
    const indicator = document.querySelector('.cz-drop-indicator');
    if (!indicator) return;
    
    let dragData;
    try {
      dragData = JSON.parse(e.dataTransfer.getData('text/plain'));
    } catch(err) {
      removeDropIndicators();
      return;
    }
    
    const targetContainer = indicator.parentElement;
    const targetIsRoot = (targetContainer === $('cz_canvas'));
    
    // Calculate insertIdx based on indicator position
    const siblings = [...targetContainer.children];
    let insertIdx = 0;
    for (let child of siblings) {
      if (child === indicator) {
        break;
      }
      if (child.dataset.layoutId && 
          child.dataset.layoutId !== draggingNodeId && 
          !child.classList.contains('cz-drop-indicator') && 
          !child.classList.contains('cz-del-btn') && 
          !child.classList.contains('sg-group-hdr')) {
        insertIdx++;
      }
    }
    
    removeDropIndicators();
    
    let nodeToInsert = null;
    
    if (dragData.source === 'toolbox') {
      if (dragData.type === 'field') {
        nodeToInsert = {
          id: 'node_' + Math.random().toString(36).substring(2, 9),
          type: 'field',
          ref: dragData.ref
        };
      } else if (dragData.type === 'group') {
        nodeToInsert = {
          id: 'node_' + Math.random().toString(36).substring(2, 9),
          type: 'group',
          title: 'New Group',
          collapsible: true,
          defaultCollapsed: false,
          elements: []
        };
      } else if (dragData.type === 'row') {
        nodeToInsert = {
          id: 'node_' + Math.random().toString(36).substring(2, 9),
          type: 'row',
          columns: [
            { width: '50%', elements: [] },
            { width: '50%', elements: [] }
          ]
        };
      } else if (dragData.type === 'row3') {
        nodeToInsert = {
          id: 'node_' + Math.random().toString(36).substring(2, 9),
          type: 'row',
          columns: [
            { width: '33.3%', elements: [] },
            { width: '33.3%', elements: [] },
            { width: '33.3%', elements: [] }
          ]
        };
      } else if (dragData.type === 'label') {
        nodeToInsert = {
          id: 'node_' + Math.random().toString(36).substring(2, 9),
          type: 'label',
          text: 'Custom Text Block'
        };
      } else if (dragData.type === 'separator') {
        nodeToInsert = {
          id: 'node_' + Math.random().toString(36).substring(2, 9),
          type: 'separator'
        };
      }
    } else if (dragData.source === 'canvas') {
      const result = findNodeAndParent(dragData.id);
      if (result) {
        nodeToInsert = result.node;
        result.array.splice(result.index, 1);
      }
    }
    
    if (nodeToInsert) {
      const targetArray = getTargetArray(targetContainer, targetIsRoot);
      if (targetArray) {
        targetArray.splice(insertIdx, 0, nodeToInsert);
        saveSideLayout(czWType);
        applySideLayout(czWType);
        renderToolboxFields();
        renderCanvas();
      }
    }
  };
}

function removeDropIndicators() {
  document.querySelectorAll('.cz-drop-indicator').forEach(el => el.remove());
}

function getTargetArray(container, isRoot) {
  if (isRoot) {
    return currentSideLayout.layout;
  }
  if (container.dataset.colParentId) {
    const parentNode = findNodeAndParent(container.dataset.colParentId);
    if (parentNode && parentNode.node) {
      if (!parentNode.node.elements) parentNode.node.elements = [];
      return parentNode.node.elements;
    }
  }
  if (container.dataset.rowId) {
    const parentNode = findNodeAndParent(container.dataset.rowId);
    if (parentNode && parentNode.node && parentNode.node.columns) {
      const colIdx = parseInt(container.dataset.colIdx);
      const col = parentNode.node.columns[colIdx];
      if (col) {
        if (!col.elements) col.elements = [];
        return col.elements;
      }
    }
  }
  return null;
}

function resetCustomize(){       // reset only the currently-active tab to defaults
  if(czTab==='side'){
    (async () => {
      let offFormFields = [];
      if (czWType) {
        try {
          const fields = await api.getWorkItemTypeFields(czWType);
          offFormFields = fields.filter(f => !f.isOnForm).map(f => 'cust:' + f.referenceName);
        } catch (e) {}
      }
      const def = getDefaultSideLayout(czWType);
      const hiddenSet = new Set(['area', 'activity', ...offFormFields]);
      def.layout = def.layout.filter(item => !hiddenSet.has(item.ref));
      currentSideLayout = def;
      saveSideLayout(czWType);
      applySideLayout(czWType);
      renderVisualLayoutBuilder();
    })();
    return;
  }
  else if(czTab==='bulk'){bulkOrder=BULK_ITEMS.map(i=>i.id);bulkHidden=new Set(['parent', 'dates']);saveBulkLayout();applyBulkLayout();}
  else{barOrder=BAR_ITEMS.map(i=>i.id);barHidden=new Set();saveBarLayout();applyBarLayout();}
  renderCustomizeList();
}

function setCustomizeTab(t){
  czTab=t;
  $('cz_tabs').querySelectorAll('button').forEach(b=>b.classList.toggle('on',b.dataset.cz===t));
  $('cz_title').textContent=t==='side'?'Customize work item panel':(t==='bulk'?'Customize bulk edit bar':'Customize toolbar');
  const wtypeCont = $('cz_wtype_container');
  if (wtypeCont) {
    wtypeCont.style.display = t === 'side' ? 'flex' : 'none';
  }
  const overlay = $('customize-overlay');
  const visualEditor = $('cz_visual_editor');
  const list = $('customize-list');
  if (t === 'side') {
    overlay.classList.add('cz-side-active');
    if (visualEditor) visualEditor.style.display = 'flex';
    if (list) list.style.display = 'none';
  } else {
    overlay.classList.remove('cz-side-active');
    if (visualEditor) visualEditor.style.display = 'none';
    if (list) list.style.display = 'block';
  }
  renderCustomizeList();
}

function renderCustomizeList(){
  if (czTab === 'side') {
    renderVisualLayoutBuilder();
    return;
  }
  const list=$('customize-list');
  const cfg=czTab==='side'
    ? {
        items:SIDE_GROUPS,
        locked:SIDE_LOCKED,
        orderedIds:sideOrderedIds,
        save:()=>saveSideLayout(czWType),
        apply:()=>applySideLayout(czWType),
        setOrder:o=>{sideOrder=o;},
        isHidden:id=>sideHidden.has(id),
        hide:id=>sideHidden.add(id),
        show:id=>sideHidden.delete(id)
      }
    : (czTab==='bulk'
      ? {items:BULK_ITEMS,locked:BULK_LOCKED,orderedIds:bulkOrderedIds,save:saveBulkLayout,apply:applyBulkLayout,setOrder:o=>{bulkOrder=o;},isHidden:id=>bulkHidden.has(id),hide:id=>bulkHidden.add(id),show:id=>bulkHidden.delete(id)}
      : {items:BAR_ITEMS,  locked:BAR_LOCKED, orderedIds:barOrderedIds, save:saveBarLayout, apply:applyBarLayout, setOrder:o=>{barOrder=o;}, isHidden:id=>barHidden.has(id), hide:id=>barHidden.add(id), show:id=>barHidden.delete(id)});
  
  const byId=Object.fromEntries(cfg.items.map(i=>[i.id,i.label]));
  list.innerHTML=cfg.orderedIds().filter(id=>id!=='actions' && (czTab !== 'side' || !czWType || czSupportedGroups.has(id))).map(id=>{
    const locked=cfg.locked.has(id),checked=!cfg.isHidden(id);
    const grip=locked?'<span class="czgrip disabled" title="locked field"><ui-icon name="lock"></ui-icon></span>':'<span class="czgrip" title="drag to reorder">⠿</span>';
    return `<div class="czrow${locked?' locked':''}" draggable="${!locked}" data-id="${id}">${grip}`+
      `<label class="czlab"><input type="checkbox" ${checked?'checked':''} ${locked?'disabled':''} data-id="${id}">${byId[id] || id}</label></div>`;
  }).join('');
  
  list.querySelectorAll('input[type=checkbox]').forEach(cb=>cb.onchange=()=>{
    const id=cb.dataset.id;if(cb.checked)cfg.show(id);else cfg.hide(id);cfg.save();cfg.apply();});
  let dragging=null;
  list.querySelectorAll('.czrow').forEach(row=>{
    if (row.classList.contains('locked')) return;
    row.addEventListener('dragstart',()=>{dragging=row;setTimeout(()=>row.classList.add('dragging'),0);});
    row.addEventListener('dragend',()=>{row.classList.remove('dragging');dragging=null;
      cfg.setOrder([...list.querySelectorAll('.czrow')].map(r=>r.dataset.id));cfg.save();cfg.apply();});});
  list.ondragover=e=>{e.preventDefault();if(!dragging)return;
    const rows=[...list.querySelectorAll('.czrow:not(.dragging)')];
    const after=rows.find(r=>{
      if (r.classList.contains('locked')) return false; // do not insert before/after locked rows if they are title/actions to preserve boundary, or we can just let it move around other non-locked rows.
      const b=r.getBoundingClientRect();return e.clientY<b.top+b.height/2;
    });
    if(after)list.insertBefore(dragging,after);else list.appendChild(dragging);};
}

function updateUiScale(scaleFactor) {
  try {
    localStorage.setItem('ado.uiScale', parseFloat(scaleFactor).toFixed(1));
  } catch(e) {}
  document.documentElement.style.fontSize = (13 * scaleFactor) + 'px';
  if (typeof cy !== 'undefined' && cy && typeof cy.resize === 'function') {
    cy.resize();
  }
}

/* ---------- main init (runs after PAT is verified) ---------- */
let _booted=false;
async function initialBoot(postSetup){
  try{applyTheme(localStorage.getItem('ado.theme')||'dark');}catch(e){}
  updateProjectBadge();                  // reflect the active org/project in the title bar
  if(_booted){                           // settings re-save: just reload data
    iterCache=null;depCache={};assignees=[];projectStates=[];tagList=[];sprintPaths=[];sprintNames={};typeList=[];undoStack.length=0;redoStack.length=0;canCreateSprint=true;canEditSprint=true;canCreateItem=true;newSprints.clear();
    updateUndoButtons();updateCreateButtons();
    if (window.FilterBuilderModal && typeof window.FilterBuilderModal.preLoad === 'function') {
      window.FilterBuilderModal.preLoad(true);
    }
    await loadIdentity();await refresh();warnIfPatExpiring();return;
  }
  _booted=true;

  if (window.FilterBuilderModal && typeof window.FilterBuilderModal.preLoad === 'function') {
    window.FilterBuilderModal.preLoad();
  }

  App.types.fillTypeSelect('c_type','Task');App.types.fillTypeSelect('n_type','Task');   // seed with fallback now; App.types.loadTypes() refills from ADO
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
        renderTimeline();
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
  $('theme').onclick=cycleTheme;
  try{window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change',()=>{if((localStorage.getItem('ado.theme')||'dark')==='auto')applyTheme('auto');});}catch(e){}
  // Only wire real export buttons (data-x). Pro placeholders (data-pro-feature)
  // in the same segment are handled by the delegated premium handler.
  $('export').querySelectorAll('button[data-x]').forEach(b=>b.onclick=()=>App.export.exportView(b.dataset.x));
  $('f_auto').onchange=()=>{const s=$('f_auto').value;try{localStorage.setItem('ado.auto',s);}catch(e){}setAutoRefresh(s);};
  $('f_scale').onchange=()=>{const s=$('f_scale').value;try{updateUiScale(parseFloat(s));}catch(e){}};
  if(window.i18n&&$('f_lang')){$('f_lang').value=window.i18n.getLang();$('f_lang').onchange=()=>{window.i18n.setLang($('f_lang').value);};}
  $('f_follow_notify').onclick=cycleFollowNotify;
  $('f_mention_notify').onclick=cycleMentionNotify;
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
    $('palette').classList.contains('show')?closePalette():openPalette();}});
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
  $('s_save').onclick=save;
  $('s_comment').onclick=()=>{toggleActivityExpand(true);toggleComment();};
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
  depBlockedByPicker.wire();depBlocksPicker.wire();               // dependency adders (Blocked-by / Blocks)
  bulkAssignedPicker.wire();bulkSprintPicker.wire();bulkParentPicker.wire();
  assignedEditor.render();assignedChild.render();assignedNew.render();sprintEditor.render();sprintNew.render();tagsEditor.render();   // placeholder cards before first use
  depBlockedByPicker.render();depBlocksPicker.render();renderDeps();   // dep card stubs + empty chip rows
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
        if (el.id === 'palette') { e.preventDefault(); e.stopPropagation(); closePalette(); return; }
        if (el.id === 'newitem-overlay') {
          e.preventDefault(); e.stopPropagation();
          if(parentNew.isOpen())parentNew.close();
          else if(assignedNew.isOpen())assignedNew.close();
          else if(sprintNew.isOpen())sprintNew.close();
          else closeNewItem();
          return;
        }
        if (el.id === 'sprint-overlay') { e.preventDefault(); e.stopPropagation(); closeSprintModal(); return; }
        if (el.id === 'customize-overlay') { e.preventDefault(); e.stopPropagation(); closeCustomize(); return; }
        if (el.id === 'setup-overlay') { e.preventDefault(); e.stopPropagation(); hideSetup(); return; }
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
          [parentEditor, assignedEditor, assignedChild, assignedNew, sprintEditor, sprintNew, parentNew, depBlockedByPicker, depBlocksPicker].forEach(p => {
            if (p && p.isOpen && p.isOpen()) p.close();
          });
          return;
        }
        if (el.classList.contains('reactions-popover')) {
          e.preventDefault(); e.stopPropagation();
          closeEmojiPicker();
          return;
        }
        if (el.classList.contains('fullscreen') || el.id === 'side') {
          e.preventDefault(); e.stopPropagation();
          if (el.classList.contains('md-editor')) {
            const btn = el.querySelector('.dbtn-full');
            if(btn)btn.click();
          } else if (el.dataset.sg === 'actions') {
            toggleActivityFullscreen(false);
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
        else if(depBlockedByPicker.isOpen())depBlockedByPicker.close();
        else if(depBlocksPicker.isOpen())depBlocksPicker.close();
        else if($('comment_editor_container').style.display==='flex'){closeCommentForm();}
        else if($('child_form').style.display==='flex'){$('child_form').style.display='none';const cb=$('s_childbtn');if(cb)cb.classList.remove('on');}
        else if($('side').classList.contains('fullscreen'))toggleFullscreen(false);
        else closePanel();
      }
    }
  });
  $('s_childbtn').onclick=()=>{toggleActivityExpand(true);const f=$('child_form');const show=f.style.display!=='flex';f.style.display=show?'flex':'none';f.style.flexDirection='column';$('s_childbtn').classList.toggle('on', show);if(show){$('c_prio').value = $('s_prio').value || '';$('c_title').focus();}};
  const atb = $('activity_toggle_btn');
  if (atb) {
    atb.onclick = () => {
      const actionsGroup = document.querySelector('.sgroup[data-sg="actions"]');
      if (actionsGroup && actionsGroup.classList.contains('fullscreen')) {
        loadActivity();
        return;
      }
      const hidden = $('activity-content').classList.contains('hidden');
      toggleActivityExpand(hidden);
    };
  }
  const saf = $('s_act_full');
  if (saf) {
    saf.onclick = () => toggleActivityFullscreen();
  }
  initActivityResizer();
  $('c_create').onclick=createChild;$('c_cancel').onclick=()=>{$('child_form').style.display='none';$('s_childbtn').classList.remove('on');};
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
  // customize-emojis dialog
  $('emojis_open').onclick=showEmojisModal;$('emojis_save').onclick=saveEmojis;$('emojis_cancel').onclick=closeEmojisModal;$('emojis_reset').onclick=resetEmojis;
  $('emojis-overlay').addEventListener('mousedown',e=>{if(e.target===$('emojis-overlay'))closeEmojisModal();});
  $('emojis-box').addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closeEmojisModal();}});
  
  // Wire dynamic preview updates and file uploads for customize emojis overlay
  const emojiTypes = ['like', 'dislike', 'heart', 'hooray', 'smile', 'confused'];
  emojiTypes.forEach(type => {
    const input = $(`emoji_override_${type}`);
    if (input) {
      input.addEventListener('input', () => updateEmojiInputPreview(type));
    }
  });
  document.querySelectorAll('.emoji-file-input').forEach(fileIn => {
    fileIn.addEventListener('change', e => {
      const type = fileIn.dataset.type;
      const file = e.target.files[0];
      if (file) {
        if (file.size > 256 * 1024) {
          showEmojiRowError(type, 'File too large! Choose an image under 256KB.');
          fileIn.value = '';
          return;
        }
        const reader = new FileReader();
        reader.onload = ev => {
          const input = $(`emoji_override_${type}`);
          if (input) {
            input.value = ev.target.result;
            updateEmojiInputPreview(type);
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
    window.filterManager = new FilterManager({ quickFilterFields: FILTERS.map(f => f.key) });
    window.filterManager.load();
    renderFilters();
    updateFilterCount();
    window.filterManager.onChange(() => {
      window.filterManager.save();
      updateFollowedBtnVisual();
      renderFilters();
      updateFilterCount();
      scheduleApply();
    });
    updateFollowedBtnVisual();
    chrome.storage.local.get(["followNotify", "mentionNotify", "notifyAge"]).then(({followNotify, mentionNotify, notifyAge})=>{
      applyFollowNotify(followNotify||'on');
      applyMentionNotify(mentionNotify||'on');
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
    const au=localStorage.getItem('ado.auto');if(au!==null){$('f_auto').value=au;setAutoRefresh(au);}
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
  App.types.buildLegend();renderFilters();updateFilterCount();updatePatBadge();updateUndoButtons();updateCreateButtons();
  setInterval(updatePatBadge, 1800000); // refresh the PAT countdown badge every 30 minutes independently of the tasks auto-refresh setting
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
  if(mode==='tree')await loadSnapshot();   // paint last session's tree instantly while the network refresh runs
  refresh().then(warnIfPatExpiring);   // nudge after the list settles, if the PAT is near expiry
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
  renderFilters();                          // re-render so Assigned chips include people
  loadFilterData().then(renderFilters);     // states/tags/sprints fill in async (don't block first paint)
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

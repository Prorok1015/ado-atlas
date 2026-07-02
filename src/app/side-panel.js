// Side panel: item editor open/close, lazy field-group loading, sidebar locking,
// dynamic custom-field pickers, item context/timeline, and the openItem() core.
// Relocated from app.js (bare, no IIFE) as batch A3 of the side-panel refactor.
// openItem is called bare from many modules/components (board/tree/graph/
// command-palette/dependencies/card-picker/item-create), so the whole cluster
// stays bare — pure relocation, zero call-site churn. customFieldsState /
// LAZY_GROUPS / HEAVY_FIELD_MAP / currentTimelineId / currentTimelineData declared
// here. Relies on bare globals resolved at call time: $, api, cur/orig/selRow/cy/
// activeItemData (state-globals), setStatus, customConfirm, refresh, dirty,
// editorValues, refreshDirty, renderAttachments, clearAttBlobs, closeMention,
// toggleFullscreen, depsState, parentEditor/assignedEditor/sprintEditor/tagsEditor,
// App.deps.*, App.activity.*, window.i18n.

// ---- lazy field-group loading + sidebar lock (was app.js top block) ----
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
      App.deps.loadDeps(id, d.deps);
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

// ---- closePanel ----
async function closePanel(force){
  if(!force&&dirty()&&!await customConfirm(window.i18n.t('editor.discardConfirm'), window.i18n.t('editor.discardTitle')))return;
  document.querySelectorAll('.sidebar-backdrop, .activity-backdrop, .editor-backdrop').forEach(el => el.remove());
  parentEditor.close();App.deps.depBlockedByPicker.close();App.deps.depBlocksPicker.close();closeMention();
  if($('side').classList.contains('fullscreen'))toggleFullscreen(false);   // restore inline width before hiding
  $('side').classList.add('hidden');
  $('resizer').style.display='none';cur=null;orig={};
  const cbtn = $('s_comment'); if (cbtn) cbtn.classList.remove('on');
  const chbtn = $('s_childbtn'); if (chbtn) chbtn.classList.remove('on');
  atchState.list=[];atchState.wid=null;atchState.uploading=0;renderAttachments();clearAttBlobs();
  depsState.blockedBy=[];depsState.blocks=[];App.deps.renderDeps();
  if(selRow){selRow.classList.remove('sel');selRow=null;}
  if(cy)cy.$(':selected').unselect();
}

// ---- item context / timeline / dynamic pickers / openItem ----
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
  depsState.blockedBy=[];depsState.blocks=[];App.deps.renderDeps();
  
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
  App.activity.toggleActivityExpand(false);
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
          App.deps.loadDeps(id, fullD.deps);
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

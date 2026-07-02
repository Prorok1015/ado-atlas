// Layout customization: persisted toolbar/bulk-bar/sidebar reorder+show/hide
// (load/save/apply + defaults) and the visual drag-and-drop layout builder modal.
// Relocated from app.js (bare, no IIFE) as Task C. Kept as one cohesive bare file
// because persist and builder share mutable state (currentSideLayout, czTab,
// czWType, czSupportedGroups). side-panel.js calls loadSideLayout/applySideLayout
// and reads/mutates activeWType/sideHidden/SIDE_GROUPS bare; app.js initialBoot
// wires showCustomize/updateUiScale/applyBarLayout/applyBulkLayout/applySideLayout
// bare — so the whole subsystem stays bare, zero call-site churn. Relies on bare
// globals resolved at call time: $, App.state.cy, api, localStorage, App.settings, App.setup,
// window.LayerManager, htmlEsc, setStatus, window.i18n.

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
  if (typeof App.state.cy !== 'undefined' && App.state.cy && typeof App.state.cy.resize === 'function') {
    App.state.cy.resize();
  }
}

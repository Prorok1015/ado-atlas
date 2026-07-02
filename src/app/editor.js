// Item editor: dirty-tracking, save-chip, discard, editorValues snapshot, the
// save-undo recorders, time-estimate parsing, and the quickSave/save/comment flow.
// Relocated from app.js (bare, no IIFE) as batch A4 of the side-panel refactor.
// dirty/refreshDirty/quickSave are called bare from settings.js/setup.js/bulk.js/
// tags-editor.js, so the whole cluster stays bare — pure relocation, zero call-site
// churn. Stays in app.js (referenced here at call time): the editor const pickers
// (parentEditor/assignedEditor/sprintEditor/tagsEditor + onPick), the undo core
// (undoStack/pushAction/afterUndo/runStep/updateUndoButtons/updateCreateButtons),
// the shared create helpers (createChild/recordCreateUndo/denyOnForbidden), and
// depsState/reactionCache. Other bare globals used at call time: $, api, App.state.cur/App.state.orig/
// App.state.descEditor/App.state.acEditor (state-globals), customFieldsState (side-panel.js), setStatus,
// refresh, openItem, assignees, tagList, App.activity.*, App.deps.*, window.i18n.

// ---- dirty-tracking / save-chip / discard / editorValues ----
function dirty(){
  if(App.state.cur==null||!App.state.orig)return false;
  const v=editorValues();
  const numEq=(a,b)=>(a===''||a==null)&&(b===''||b==null) ? true : String(a)===String(b);
  // Phase 1 (always-loaded) fields
  if(v.title!==App.state.orig.title||v.state!==App.state.orig.state||v.assigned!==App.state.orig.assigned
    ||((App.state.orig.priority?String(App.state.orig.priority):'')!==v.prio)
    ||v.iter!==App.state.orig.iter||v.parent!==App.state.orig.parent||v.start!==App.state.orig.start||v.target!==App.state.orig.target||v.due!==App.state.orig.due||v.est!==App.state.orig.est)
    return true;
  // Lazy fields — only compare if they've actually been loaded into App.state.orig
  if(App.state.orig._loaded_desc && v.desc!==App.state.orig.desc) return true;
  if(App.state.orig._loaded_ac && App.state.orig.has_ac && v.ac!==App.state.orig.ac) return true;
  if(App.state.orig._loaded_tags && v.tags!==App.state.orig.tags) return true;
  if(App.state.orig._loaded_area && v.area!==App.state.orig.area) return true;
  if(App.state.orig._loaded_storypoints && !numEq(v.storypoints,App.state.orig.storypoints)) return true;
  if(App.state.orig._loaded_remaining && !numEq(v.remaining,App.state.orig.remaining)) return true;
  if(App.state.orig._loaded_completed && !numEq(v.completed,App.state.orig.completed)) return true;
  if(App.state.orig._loaded_activity && v.activity!==App.state.orig.activity) return true;
  if(App.state.orig._loaded_risk && v.risk!==App.state.orig.risk) return true;
  if(App.state.orig._loaded_valuearea && v.valuearea!==App.state.orig.valuearea) return true;

  // Custom fields dirty check
  for (const cf of customFieldsState) {
    if (App.state.orig['_loaded_' + cf.referenceName]) {
      const currentVal = v[cf.referenceName];
      const origVal = App.state.orig[cf.referenceName];
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
  if(App.state.cur==null||!App.state.orig)return false;
  const v=editorValues();
  return v.title!==App.state.orig.title||v.desc!==App.state.orig.desc||(App.state.orig.has_ac&&v.ac!==App.state.orig.ac);
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
  if(App.state.cur==null||!App.state.orig)return;
  if ($('s_title')) $('s_title').value=App.state.orig.title;
  if (App.state.descEditor) App.state.descEditor.value=App.state.orig.desc;
  if(App.state.orig.has_ac && App.state.acEditor){
    App.state.acEditor.value=App.state.orig.ac;
  }
  if ($('s_area')) $('s_area').value=App.state.orig.area||'';
  if ($('s_storypoints')) $('s_storypoints').value=App.state.orig.storypoints!=null?App.state.orig.storypoints:'';
  if ($('s_remaining')) $('s_remaining').value=App.state.orig.remaining!=null?App.state.orig.remaining:'';
  if ($('s_completed')) $('s_completed').value=App.state.orig.completed!=null?App.state.orig.completed:'';

  const fieldsToSync = [
    { elId: 's_activity_field', val: App.state.orig.activity },
    { elId: 's_risk', val: App.state.orig.risk },
    { elId: 's_valuearea', val: App.state.orig.valuearea }
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
    const origVal = App.state.orig[cf.referenceName] || '';
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
    desc: App.state.descEditor ? App.state.descEditor.value : '',
    ac: App.state.acEditor ? App.state.acEditor.value : '',
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

// ---- save-undo recorders / time parsing / quickSave / save / comments ----
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

// Shared post-PATCH visuals: keeps the tree row, App.state.store, and cytoscape node in
// sync with whatever fields the PATCH just touched. Used by both save() (full
// manual save) and quickSave() (single-field auto-save).
function applyVisualSync(id,body,v){
  if(App.state.selRow&&body.title)App.state.selRow.querySelector('.lab').textContent=`#${id} ${body.title}`;
  if(App.state.selRow&&body.state)App.state.selRow.querySelector('.badge').textContent=body.state;
  if(App.state.selRow&&('priority'in body)){let pc=App.state.selRow.querySelector('.prio');if(!pc){pc=document.createElement('span');pc.className='prio';App.state.selRow.insertBefore(pc,App.state.selRow.querySelector('.badge'));}pc.textContent='P'+body.priority;pc.style.background=prioColor(body.priority);}
  if(App.state.selRow&&('tags'in body)){App.state.selRow.querySelectorAll('.ttag').forEach(t=>t.remove());const bdg=App.state.selRow.querySelector('.badge');if(bdg){bdg.style.marginLeft='';const ts=tagList_(v.tags);if(ts.length){const show=ts.slice(0,3),extra=ts.length-show.length;bdg.style.marginLeft='0';show.forEach((t,i)=>{const tc=document.createElement('span');tc.className='ttag';tc.textContent=t;tc.style.background=personColor(t);tc.title=t;if(i===0)tc.style.marginLeft='auto';App.state.selRow.insertBefore(tc,bdg);});if(extra>0){const tc=document.createElement('span');tc.className='ttag';tc.textContent='+'+extra;tc.style.background='var(--muted)';App.state.selRow.insertBefore(tc,bdg);}}}}
  if(App.state.store.nodes[id]){const s=App.state.store.nodes[id];s.title=v.title;s.state=v.state;
    if('assigned'in body)s.assigned=body.assigned;
    if('priority'in body)s.priority=body.priority;
    if('iteration'in body)s.iteration=body.iteration;
    if('start'in body)s.start=v.start;
    if('target'in body)s.target=v.target;
    if('due'in body)s.due=v.due;
    if('estimate'in body)s.est=(v.est===''?null:Number(v.est));
    if('tags'in body)s.tags=v.tags;}
  if(App.state.cy&&App.state.store.nodes[id]){const n=App.state.cy.getElementById(String(id));if(n.nonempty())n.data(Object.assign({},App.state.store.nodes[id]));}
}

// Refresh the listing view if a saved field shifts WHERE the item appears.
function postSaveRefresh(body,parentChanged){
  if('iteration'in body||'assigned'in body||parentChanged)refresh();
  else{
    if(App.state.mode==='board')App.board.renderBoard();
    else if(App.state.mode==='timeline')App.timeline.render();
    if(openSprintPath&&$('sprintview').classList.contains('show'))App.board.renderSprint(openSprintPath);
  }
}
function registerNewAssignee(name) {
  if(name && name !== currentUser && !assignees.includes(name)) {
    assignees.push(name);
    assignees.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    const dl = $('assignees');
    if (dl) dl.innerHTML = ['me', ...assignees].map(a => `<option value="${String(a).replace(/"/g,'&quot;')}">`).join('');
    App.filters.renderFilters();
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
    App.filters.renderFilters();
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
// Concurrent calls for the SAME field race on the wire — to converge App.state.orig with
// the latest editor value we re-read editorValues() at response time instead of
// using the request-time snapshot.
async function quickSave(field){
  if(App.state.cur==null||!App.state.orig)return;
  const id=App.state.cur;
  
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
    if(v.parent===App.state.orig.parent)return;
    if(v.parent!==''&&Number(v.parent)===id){setStatus(window.i18n.t('status.cannotParentSelf'),true);return;}
    parentChanged=true;
  } else if(field==='priority'){
    const op=App.state.orig.priority?String(App.state.orig.priority):'';
    if(v.prio===op||v.prio==='')return;          // empty = "no change" (matches manual save)
    body.priority=Number(v.prio);
  } else if(field==='storypoints' || field==='remaining' || field==='completed') {
    if(numEq(v[field], App.state.orig[field])) return;
    body[field] = v[field] === '' ? '' : Number(v[field]);
  } else if(field.startsWith('cust:')) {
    const refName = field.substring(5);
    if(v[refName] === App.state.orig[refName]) return;
    body[refName] = v[refName];
  } else {
    const keyMap={iteration:'iter',estimate:'est'};
    const k=keyMap[field]||field;
    if(v[k]===App.state.orig[k])return;
    if(field==='assigned')body.assigned=(v.assigned==='me'?(currentUser||v.assigned):v.assigned);
    else body[field]=v[k];
  }
  if(!Object.keys(body).length&&!parentChanged)return;
  const before={...App.state.orig},beforeParent=App.state.orig.parent,newParent=v.parent;
  setSaveChip('saving');
  let r;
  try{
    if(Object.keys(body).length)r=await api.updateItem(id,body);
    if(parentChanged)await api.setParent(id,newParent);
  }catch(e){
    setSaveChip('error',e.message);setStatus('save failed: '+e.message,true);refreshDirty();
    return;
  }
  if(App.state.cur!==id)return;                            // user navigated away mid-save
  recordEditUndo(id,body,parentChanged,before,beforeParent,newParent);
  // Use the FRESH editor values for App.state.orig + visuals — a follow-up edit during
  // the in-flight PATCH has already fired its own quickSave; we just make sure
  // App.state.orig converges to "whatever's in the editor right now".
  const vNow=editorValues();
  applyVisualSync(id,body,vNow);
  if('state'in body)App.state.orig.state=vNow.state;
  if('assigned'in body){App.state.orig.assigned=vNow.assigned; registerNewAssignee(vNow.assigned);}
  if('priority'in body)App.state.orig.priority=body.priority;
  if('iteration'in body)App.state.orig.iter=vNow.iter;
  if('start'in body)App.state.orig.start=vNow.start;
  if('target'in body)App.state.orig.target=vNow.target;
  if('due'in body)App.state.orig.due=vNow.due;
  if('estimate'in body)App.state.orig.est=vNow.est;
  if('tags'in body){App.state.orig.tags=vNow.tags; registerNewTags(vNow.tags);}
  if('area'in body)App.state.orig.area=vNow.area;
  if('storypoints'in body)App.state.orig.storypoints=body.storypoints === '' ? null : Number(body.storypoints);
  if('remaining'in body)App.state.orig.remaining=body.remaining === '' ? null : Number(body.remaining);
  if('completed'in body)App.state.orig.completed=body.completed === '' ? null : Number(body.completed);
  if('activity'in body)App.state.orig.activity=vNow.activity;
  if('risk'in body)App.state.orig.risk=vNow.risk;
  if('valuearea'in body)App.state.orig.valuearea=vNow.valuearea;
  if(parentChanged)App.state.orig.parent=vNow.parent;

  // Sync custom fields to App.state.orig
  customFieldsState.forEach(cf => {
    if (cf.referenceName in body) {
      App.state.orig[cf.referenceName] = vNow[cf.referenceName];
    }
  });

  if(r&&r.rev) {
    FollowManager.updateItemRev(id,r.rev,App.state.orig.state,App.state.orig.title,App.state.orig.assigned);
    if(App.state.store.nodes[id]) App.state.store.nodes[id].rev = r.rev;
  }
  refreshDirty();setSaveChip('saved');
  setStatus(`#${id} ${field} saved`+(r?` → rev ${r.rev}`:''));
  postSaveRefresh(body,parentChanged);
}

async function save(){
  if(App.state.cur==null)return;const id=App.state.cur;const v=editorValues();const body={};
  // Text fields only — pickers/selects/dates are auto-saved by quickSave().
  if(v.title!==App.state.orig.title)body.title=v.title;
  if(v.desc!==App.state.orig.desc)body.desc=v.desc;
  if(App.state.orig.has_ac&&v.ac!==App.state.orig.ac)body.ac=v.ac;
  customFieldsState.forEach(cf => {
    const isHtml = cf.type && (cf.type.toLowerCase() === 'html' || cf.type.toLowerCase() === 'plaintext');
    if (isHtml && v[cf.referenceName] !== App.state.orig[cf.referenceName]) {
      body[cf.referenceName] = v[cf.referenceName];
    }
  });
  if(!Object.keys(body).length){setStatus('no changes');return;}
  const before={...App.state.orig};
  const sv=$('s_save');sv.disabled=true;sv.textContent='Saving…';setSaveChip('saving');loadStart('saving…');
  let r;
  try{
    r=await api.updateItem(id,body);
  }catch(e){setStatus('ERROR: '+e.message,true);setSaveChip('error',e.message);refreshDirty();loadEnd();return;}
  loadEnd();
  recordEditUndo(id,body,false,before,App.state.orig.parent,App.state.orig.parent);
  applyVisualSync(id,body,v);
  if('title'in body)App.state.orig.title=v.title;
  if('desc'in body)App.state.orig.desc=v.desc;
  if('ac'in body)App.state.orig.ac=v.ac;
  customFieldsState.forEach(cf => {
    if (cf.referenceName in body) {
      App.state.orig[cf.referenceName] = v[cf.referenceName];
    }
  });
  if(r&&r.rev) {
    FollowManager.updateItemRev(id,r.rev,App.state.orig.state,App.state.orig.title,App.state.orig.assigned);
    if(App.state.store.nodes[id]) App.state.store.nodes[id].rev = r.rev;
  }
  refreshDirty();setSaveChip('saved');setStatus(`#${id} saved`+(r?` → rev ${r.rev}`:''));
  postSaveRefresh(body,false);
}
function closeCommentForm(){
  const f=$('comment_editor_container');
  if(f){
    f.style.display='none';
    if(App.state.commentEditor){
      App.state.commentEditor.toggleFullscreen(false);
      App.state.commentEditor.value='';
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
  if(show) App.state.commentEditor.textarea.focus();
}
async function postComment(){
  const t=App.state.commentEditor.value.trim();if(!t||App.state.cur==null)return;
  try{await api.comment(App.state.cur,t);}catch(e){setStatus('ERROR: '+e.message,true);return;}
  closeCommentForm();
  setStatus('#'+App.state.cur+' comment added');
  App.activity.loadActivity();
}

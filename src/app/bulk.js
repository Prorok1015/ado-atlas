// Bulk multi-select (Ctrl/Cmd-click, Shift-range), tree drag-to-re-parent, and
// the bulk-edit apply flow. This is a SHARED subsystem used by tree/board/graph
// (selection sync) and by palette/filters (clearBulk/buildBulkControls) — so its
// functions stay BARE globals (like loading/badges/sprint-utils), NOT namespaced,
// to avoid churn at those bare call sites. Relocated from app.js (REFACTORING_PLAN.md).
// Reads bare state (bulkSel/bulkAnchor/dragIds/store/mode/cur/…) + calls App.tree/
// App.graph/App.board render fns at call time. Loads before app.js.
window.App = window.App || {};

/* ---------- bulk multi-select (tree): Ctrl/Cmd-click toggles, Shift-click ranges ---------- */
// Selectable elements of the active view (tree rows / board cards / timeline rows), in visual order.
function bulkEls(){return [...document.querySelectorAll(mode==='board'?'#board .bcard[data-id]':mode==='timeline'?'#timeline .tlrow[data-id]':'#tree .trow[data-id]')];}
function syncBulkRows(){                    // reflect bulkSel onto the rendered rows/cards (class + any checkbox)
  document.querySelectorAll('#tree .trow[data-id], #board .bcard[data-id], #timeline .tlrow[data-id]').forEach(r=>{
    const on=bulkSel.has(+r.dataset.id);r.classList.toggle('bulksel',on);
    const cb=r.querySelector('.tcheck');if(cb)cb.checked=on;});
}
function bulkSet(ids,on){ids.forEach(id=>{if(on)bulkSel.add(id);else bulkSel.delete(id);});updateBulkBar();syncBulkRows();App.graph.syncGraphBulk();}
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
  App.graph.syncGraphBulk();
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

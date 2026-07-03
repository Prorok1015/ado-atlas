// Create / edit a sprint (Board By-Sprint '+' column + sprint screen edit):
// the sprint modal, pending-items handoff, filter reload, and submit. Phase-1
// module of the App.* refactor (REFACTORING_PLAN.md). Date-picker glue lives in
// app/date-pickers.js (bare); pendingSprintItems and other state stay bare in
// app.js. Loads before app.js.
(function (App) {
  'use strict';

function updatePendingSprintItems() {
  const container = $('sprint-pending-container');
  const list = $('sprint-pending-list');
  if (!container || !list) return;
  if (pendingSprintItems && pendingSprintItems.length > 0) {
    container.style.display = 'block';
    list.innerHTML = '';
    pendingSprintItems.forEach(id => {
      const n = App.state.store.nodes[id];
      if (!n) return;
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; align-items:center; gap:6px; font-size:12px; margin-bottom:4px; padding:4px 6px; background:var(--panel2); border-radius:4px; border:1px solid var(--line);';
      
      const dot = document.createElement('i');
      dot.className = 'dot';
      dot.style.display = 'inline-block';
      dot.style.background = tyColor(n.type);
      
      const idSpan = document.createElement('span');
      idSpan.style.cssText = 'color:var(--muted); font-weight:600; flex:none;';
      idSpan.textContent = `#${App.backend.nid(id)}`;
      
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
  App.filters.renderFilters();                                 // also rebuilds the bulk Sprint dropdown
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
      if(openSprintPath===sprintEditPath&&$('sprintview').classList.contains('show'))App.board.renderSprint(sprintEditPath);
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
        const olds=pend.map(id=>({id,old:(App.state.store.nodes[id]?App.state.store.nodes[id].iteration:'')}));
        const res=await api.pool(pend.map(id=>async()=>{try{await api.updateItem(id,{iteration:newPath});if(App.state.store.nodes[id])App.state.store.nodes[id].iteration=newPath;return true;}catch(e){return false;}}),6);
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
        if(openSprintPath)App.board.renderSprint(openSprintPath);}
      else{canCreateSprint=false;setStatus("you don't have permission to create sprints",true);if(App.state.mode==='board')App.board.renderBoard();}
    }else $('sprint-err').textContent='ERROR: '+e.message;
  }finally{btn.disabled=false;$('sp_create').textContent=sprintMode==='edit'?'Save dates':'Create sprint';loadEnd();}
}

  App.sprint = { updatePendingSprintItems, showSprintModal, showSprintEdit, closeSprintModal, reloadSprintFilter, createSprintSubmit };
})(window.App);

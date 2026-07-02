// Tree view rendering — the hierarchical work-item tree. Phase-1 view module of
// the App.* refactor (REFACTORING_PLAN.md): IIFE publishing App.tree
// {renderTree, currentItems}; childrenUl/treeNode/toggle/activeText stay private.
// The bulk-select + drag-reparent subsystem (bulkSel/bulkSet/bulkToggle/bulkRange/
// bulkAnchor/ensureKids/…) stays BARE in app.js (shared with board/graph/palette/
// filters) and is read here at call time, along with const/state/badges/
// sprint-utils helpers and card-picker's tagList_/personColor. Loads before app.js.
(function (App) {
  'use strict';

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
    if(n.id===cur){row.classList.add('sel');App.state.selRow=row;}   // keep highlight across re-renders
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
    const el=$('tree');el.innerHTML='';App.state.selRow=null;
    const ul=document.createElement('ul');ul.className='tree';
    (store.top||store.roots).forEach(id=>{if(store.nodes[id])ul.appendChild(treeNode(store.nodes[id]));});
    el.appendChild(ul);
    setStatus(store.roots.length+' item(s)'+capNote());
  }

  App.tree = { renderTree, currentItems };
})(window.App);

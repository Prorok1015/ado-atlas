// Dependency links (sidebar Blocked-by / Blocks + the graph). Phase-1 leaf
// module of the App.* refactor (REFACTORING_PLAN.md): IIFE publishing App.deps.
//
// The editor shows two chip rows + an item picker for adding. Mutations also
// fire from the graph (drag a stub between nodes, or click an edge to delete).
// Both paths share the same state + undo plumbing so the views stay consistent.
//
// State: `depsState` is a BARE global that stays in app.js — it is reset from
// OUTSIDE this module (closePanel / openItem: `depsState.blockedBy=[];...`), so
// the declaration cannot move here. We read/mutate it bare at call time.
//
// Reads/writes other bare globals at call time ($, App.state.store, App.state.cur, App.state.cy, App.state.mode,
// App.state.edgeMode, App.state.depCache, api, tyColor, htmlEsc, loadStart, loadEnd, setStatus,
// openItem, pushAction, denyOnForbidden, createCardPicker, depsState) and the
// bare picker helpers depAdderProvider / depPickerOnChange (card-picker.js).
//
// depsArr + addDepLink are re-exposed as bare globals (window.*) because
// card-picker.js — a classic <script> that shares this scope and loads before
// app.js — references them bare (depsArr in depAdderProvider, addDepLink in
// depPickerOnChange). Keeping the bare names alive preserves that wiring.
//
// Loads before app.js.
(function (App) {
  'use strict';

  // Pick the per-direction array on the open item's deps state.
  function depsArr(dir){return dir==='blocks'?depsState.blocks:depsState.blockedBy;}
  function setDepsArr(dir,arr){if(dir==='blocks')depsState.blocks=arr;else depsState.blockedBy=arr;}

  const depBlockedByPicker=createCardPicker('s_deps_blockedby',{provider:depAdderProvider('blockedBy'),onChange:depPickerOnChange('blockedBy')});
  const depBlocksPicker=createCardPicker('s_deps_blocks',{provider:depAdderProvider('blocks'),onChange:depPickerOnChange('blocks')});

  // Render Blocked-by / Blocks chip rows from depsState. Titles for items the tree
  // hasn't loaded resolve lazily via api.item — same pattern as the parent card.
  function renderDeps(){
    const chip=(id,dir)=>{
      const n=App.state.store.nodes[id];
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
    document.querySelectorAll('#s_deps .depchip b[data-dir]').forEach(x=>x.onclick=()=>removeDepLink(App.state.cur,+x.dataset.id,x.dataset.dir));
    document.querySelectorAll('#s_deps .depopen').forEach(a=>a.onclick=(e)=>{e.preventDefault();openItem(+a.dataset.id);});
    // Lazy-load titles for ids not yet in the App.state.store (a single GET per id, cached on success)
    const missing=[...depsState.blockedBy,...depsState.blocks].filter(id=>!App.state.store.nodes[id]);
    missing.forEach(id=>{api.item(id).then(it=>{
      if(it&&it.id){App.state.store.nodes[it.id]=App.state.store.nodes[it.id]||it;if(App.state.cur!=null)renderDeps();}
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
    if(App.state.cur!==id)return;
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
    if(App.state.cur===from){const a=depsState.blocks;if(op==='add'){if(!a.includes(to))a.push(to);}else depsState.blocks=a.filter(x=>x!==to);}
    if(App.state.cur===to){const a=depsState.blockedBy;if(op==='add'){if(!a.includes(from))a.push(from);}else depsState.blockedBy=a.filter(x=>x!==from);}
    if(App.state.cur===from||App.state.cur===to)renderDeps();
    if(App.state.cy&&App.state.mode==='graph'&&App.state.edgeMode!=='hierarchy'){
      const eid='d_'+from+'_'+to;
      const existing=App.state.cy.getElementById(eid);
      if(op==='add'){if(existing.empty()&&App.state.cy.getElementById(String(from)).nonempty()&&App.state.cy.getElementById(String(to)).nonempty())
        App.state.cy.add({group:'edges',data:{id:eid,source:String(from),target:String(to),kind:'dep'}});}
      else{if(existing.nonempty())existing.remove();}
    }
  }
  async function addDepLink(focusId,otherId,dir){
    const {from,to}=depPair(focusId,otherId,dir);
    if(from===to){setStatus(window.i18n.t('status.cannotDependSelf'),true);return;}
    // Local dup-check only when the sidebar's open item IS the focus (else we have no fresh state)
    if(App.state.cur===focusId&&depsArr(dir).includes(otherId))return;
    loadStart('linking #'+from+' → #'+to+'…');
    try{
      await api.addDependency(from,to);
      App.state.depCache={};                                   // graph cache is per id-set; nuke wholesale
      applyDepLocal(from,to,'add');
      pushAction(`link #${from} → #${to}`,
        async()=>{try{await api.removeDependency(from,to);}catch(e){}App.state.depCache={};applyDepLocal(from,to,'remove');if(App.state.cur===focusId)await loadDeps(focusId);},
        async()=>{try{await api.addDependency(from,to);}catch(e){}App.state.depCache={};applyDepLocal(from,to,'add');if(App.state.cur===focusId)await loadDeps(focusId);});
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
      App.state.depCache={};
      applyDepLocal(from,to,'remove');
      pushAction(`unlink #${from} → #${to}`,
        async()=>{try{await api.addDependency(from,to);}catch(e){}App.state.depCache={};applyDepLocal(from,to,'add');if(App.state.cur===focusId)await loadDeps(focusId);},
        async()=>{try{await api.removeDependency(from,to);}catch(e){}App.state.depCache={};applyDepLocal(from,to,'remove');if(App.state.cur===focusId)await loadDeps(focusId);});
      setStatus(`unlinked #${from} → #${to}`);
    }catch(e){
      if(!denyOnForbidden(e,'remove dependencies'))setStatus('ERROR: '+e.message,true);
    }finally{loadEnd();}
  }

  // card-picker.js references these two bare (classic <script>, shared scope,
  // loads before app.js). Keep the bare names alive for that wiring.
  window.depsArr=depsArr;
  window.addDepLink=addDepLink;

  App.deps = { depsArr, setDepsArr, depBlockedByPicker, depBlocksPicker, renderDeps, loadDeps, depPair, applyDepLocal, addDepLink, removeDepLink };
})(window.App);

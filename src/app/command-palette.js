// Command palette (Ctrl/Cmd+K) — fuzzy action + item launcher.
// Phase-1 feature module of the App.* refactor (REFACTORING_PLAN.md): IIFE
// publishing App.palette; the registry (PALETTE_ACTIONS), palItems/palIdx state
// and the drawPalette/highlightPalette/paletteMatches helpers stay private.
// Registry actions call already-namespaced modules (App.create/App.settings/
// App.export/App.setup); other deps (runUndo/runRedo/refresh/clearBulk/openItem/
// App.state.store/stateColor/htmlEsc/setStatus/$/LayerManager) are bare globals read at
// call time. Loads before src/app.js.
(function (App) {
  'use strict';

  let palItems = [], palIdx = 0;
  const PALETTE_ACTIONS = [
    { kind: 'cmd', title: 'New work item', run: () => App.create.showNewItem() },
    { kind: 'cmd', title: 'Undo last change (Ctrl/Cmd+Z)', run: () => runUndo() },
    { kind: 'cmd', title: 'Redo (Ctrl/Cmd+Shift+Z)', run: () => runRedo() },
    { kind: 'cmd', title: 'Refresh list', run: () => refresh() },
    { kind: 'cmd', title: 'View: Tree', run: () => App.settings.switchMode('tree') },
    { kind: 'cmd', title: 'View: Graph', run: () => App.settings.switchMode('graph') },
    { kind: 'cmd', title: 'View: Board', run: () => App.settings.switchMode('board') },
    { kind: 'cmd', title: 'Export CSV', run: () => App.export.exportView('csv') },
    { kind: 'cmd', title: 'Export JSON', run: () => App.export.exportView('json') },
    { kind: 'cmd', title: 'Toggle theme', run: () => App.settings.cycleTheme() },
    { kind: 'cmd', title: 'Open settings', run: () => App.setup.showSetup(true) },
    { kind: 'cmd', title: 'Clear bulk selection', run: () => clearBulk() },
  ];

  function openPalette(){$('palette').classList.add('show');if (window.LayerManager) window.LayerManager.open($('palette'));const i=$('palette-input');i.value='';renderPalette('');i.focus();}
  function closePalette(){$('palette').classList.remove('show');if (window.LayerManager) window.LayerManager.close($('palette'));}
  function paletteMatches(q){
    q=(q||'').trim().toLowerCase();
    const toks=q.split(/\s+/).filter(Boolean),out=[];
    if(/^#?\d+$/.test(q)){const id=parseInt(q.replace('#',''),10);out.push({kind:'open',title:'Open #'+id,run:()=>openItem(App.backend.gid(id))});}
    if(toks.length){                         // only match items once the user has typed something
      let n=0;
      for(const node of Object.values(App.state.store.nodes)){
        const hay=('#'+App.backend.nid(node.id)+' '+(node.title||'')).toLowerCase();
        if(toks.every(t=>hay.includes(t))){out.push({kind:node.type||'item',title:`#${App.backend.nid(node.id)} ${node.title||''}`,state:node.state,run:()=>openItem(node.id)});if(++n>=40)break;}
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

  App.palette = { openPalette, closePalette, renderPalette, movePalette, runPalette };
})(window.App);

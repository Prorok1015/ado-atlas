// Graph view (cytoscape). Phase-1 leaf module of the App.* refactor
// (REFACTORING_PLAN.md): IIFE publishing App.graph.
//
// Owns the cytoscape instance's construction, styling (Excalidraw-ish node
// cards + dot grid), incremental render/diff, dagre layout, node-position
// persistence, bulk-highlight sync, and the "drag a stub to create a dep link"
// interaction.
//
// Reads/mutates bare globals at call time: cy, mode, App.state.edgeMode, App.state.rankDir, store,
// App.state.depCache, App.state.renderToken, App.state.maxNodesLimit, projectName, bulkSel, api, TYPE_COLOR,
// $, setStatus, openItem, loadStart, loadEnd, window.i18n, cytoscape (via
// cy.layout dagre). Calls bare helpers defined elsewhere: ensureKids,
// bulkToggle, customConfirm, reachable, and the card-picker.js badge helpers
// (tagDotsUri, cornerTagUri, bookmarkUri, avatarBadgeUri, sprintShort, cornerW,
// isOverdue, BLANK_IMG) plus badgeOn (app/badges.js). Dep mutations route
// through App.deps.addDepLink / App.deps.removeDepLink.
//
// `depDrag` is module-private state (used only within this file).
//
// The two document-level mousemove/mouseup listeners are registered once at
// load time inside the IIFE body — they drive the dep-drag ghost line.
//
// Loads before app.js.
(function (App) {
  'use strict';

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
  function mixHex(hex,toward,t){const a=hexToRgb(hex),b=hexToRgb(toward);return 'rgb('+a.map((v,i)=>Math.round(v+(b[i]-v)*t)).join(',')+')';}
  // Excalidraw-style fill: a soft pastel tint of the type colour toward the canvas
  const nodeFill=type=>{const c=TYPE_COLOR[type]||'#95a5a6';return document.body.classList.contains('light')?mixHex(c,'#ffffff',0.82):mixHex(c,'#11151b',0.70);};
  const nodeStroke=type=>TYPE_COLOR[type]||'#95a5a6';
  // Per-view "what to show" toggles. Each view exposes its own set of fields
  // through the popover anchored on the Controls box. Choices persist as one
  // nested object under `ado.badges`; the legacy `ado.graphBadges` flat key is
  // migrated on first load.
  /* badge fields/state + badgeOn/loadBadgesOn/saveBadgesOn -> app/badges.js (bare, shared across views) */

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
      if(mode==='graph'&&App.state.edgeMode!=='hierarchy')depHandleShow(nd);});
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
      await App.deps.removeDepLink(s,t,'blocks');
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
    await App.deps.addDepLink(d.sourceId,target,'blocks');   // source → target (source "blocks" target)
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
    const l=cy.layout({name:'dagre',rankDir:App.state.rankDir,ranker:'tight-tree',
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
    const token=++App.state.renderToken;                    // newest render wins; stale async results bail out
    let ids=[...reachable()].filter(id=>store.nodes[id]);
    if(!ids.length){cy.elements().remove();setStatus(window.i18n.t('status.nothingMatches'));return;}
    const originalCount = ids.length;
    let isTruncated = false;
    if (ids.length > App.state.maxNodesLimit) {
      ids = ids.slice(0, App.state.maxNodesLimit);
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
    if(App.state.edgeMode!=='hierarchy'){                     // dependencies: on-demand, cached
      const key=ids.slice().sort((a,b)=>a-b).join(',');
      let d=App.state.depCache[key];
      if(!d){
        loadStart('loading dependencies…');
        try{d=await api.deps(ids);App.state.depCache[key]=d;}
        catch(e){d=[];setStatus('ERROR: '+e.message,true);}
        finally{loadEnd();}
        if(token!==App.state.renderToken)return;
      }
      d.forEach(e=>edges.push({id:'d_'+e.source+'_'+e.target,source:String(e.source),target:String(e.target),kind:'dep'}));
    }
    if(token!==App.state.renderToken)return;
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

  App.graph = { gstyle, depHandleHide, syncGraphBulk, renderGraph };
})(window.App);

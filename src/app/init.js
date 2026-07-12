// Main initialisation: initialBoot(postSetup) runs after the PAT/OAuth is verified
// (legend, filters, first refresh, all toolbar/keyboard/settings/side-panel wiring),
// plus its helpers setupSettingsTooltips/loadIdentity/loadFilterData/
// wirePremiumPlaceholders. Relocated from app.js (bare, no IIFE) as Task D1.
// initialBoot is called bare from boot.js (DOMContentLoaded) and setup.js (post-setup),
// so it stays bare — pure relocation, zero call-site churn / no logic change. Relies
// on bare globals + App.* resolved at call time (api, $, App.*, openItem, refresh,
// setMode, renderViewHelp, createChild, wireSetup, and the shared state globals).
/* ---------- main init (runs after PAT is verified) ---------- */
let _booted=false;

// Hoisted to module scope because more than one wire* helper (below) references
// them: the followed-filter star reflects state from both the bulk bar and the
// filter-manager onChange; the AI button state is also refreshed via a registry
// callback + exposed on window; closeMore is dismissed from the Escape handler.
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
function closeMore() {
  const mp = $('morepanel'), mb = $('morebtn');
  if (!mp || !mb) return;
  mp.style.display = 'none';
  mb.classList.remove('on');
  if (window.LayerManager) window.LayerManager.close(mp);
}

async function initialBoot(postSetup){
  if(App.prefs){try{await App.prefs.load();}catch(e){}}   // memoised no-op if boot.js already hydrated; covers the setup.js -> initialBoot re-entry
  try{App.settings.applyTheme(App.prefs.get('theme')||'dark');}catch(e){}
  App.setup.updateProjectBadge();                  // reflect the active org/project in the title bar
  if(_booted){                           // settings re-save: just reload data
    iterCache=null;App.state.depCache={};assignees=[];projectStates=[];tagList=[];sprintPaths=[];sprintNames={};typeList=[];undoStack.length=0;redoStack.length=0;canCreateSprint=true;canEditSprint=true;canCreateItem=true;newSprints.clear();
    updateUndoButtons();updateCreateButtons();
    if (window.FilterBuilderModal && typeof window.FilterBuilderModal.preLoad === 'function') {
      window.FilterBuilderModal.preLoad(true);
    }
    await loadIdentity();await refresh();App.setup.warnIfPatExpiring();return;
  }
  _booted=true;

  if (window.FilterBuilderModal && typeof window.FilterBuilderModal.preLoad === 'function') {
    window.FilterBuilderModal.preLoad();
  }

  App.types.fillTypeSelect('c_type','Task');App.types.fillTypeSelect('n_type','Task');   // seed with fallback now; App.types.loadTypes() refills from ADO
  wireControls();
  wireBulkBar();
  wireEditorAndKeys();
  wireModals();
  loadBarLayout();applyBarLayout();              // apply the saved toolbar order / hidden set
  loadBulkLayout();applyBulkLayout();            // apply the saved bulk edit bar order / hidden set
  wireTreeDnD();                                  // drag tree rows to re-parent
  try {
    window.filterManager = new FilterManager({ quickFilterFields: App.filters.FILTERS.map(f => f.key) });
    window.filterManager.load();
    App.filters.renderFilters();
    App.filters.renderFavoriteFilters();
    App.filters.updateFilterCount();
    window.filterManager.onChange(() => {
      window.filterManager.save();
      updateFollowedBtnVisual();
      
      const ir = window.filterManager.getIR();
      if (ir && ir.order !== undefined) {
        const sortSel = $('f_sort');
        if (sortSel && sortSel.value !== (ir.order || '')) {
          sortSel.value = ir.order || '';
          App.prefs.set('sort', sortSel.value);
        }
      }

      App.filters.renderFilters();
      App.filters.updateFilterCount();
      App.filters.scheduleApply();
    });
    updateFollowedBtnVisual();
    App.settings.applyFollowNotify(App.prefs.get('followNotify')||'on');
    App.settings.applyMentionNotify(App.prefs.get('mentionNotify')||'on');
    App.settings.applyTelemetry(App.prefs.get('telemetry')||'on');
    {const ageSel = $('f_notify_age');
     if (ageSel) ageSel.value = App.prefs.get('notifyAge') || '172800';}
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
        App.prefs.set('notifyAge', ageSelect.value);
      };
    }
    const ss=App.prefs.get('sort');if(ss!==null)$('f_sort').value=ss;
    if(App.prefs.get('showEmpty')!=='0'){$('board').classList.add('showempty');$('empty_btn').classList.add('on');}
    const bg=App.prefs.get('boardGroup');if(bg){boardGroup=bg;$('grp').querySelectorAll('button').forEach(x=>x.classList.toggle('on',x.dataset.g===bg));}
    const tz2=App.prefs.get('tlZoom');if(tz2&&TL_PX[tz2]){App.state.tlZoom=tz2;$('tlzoom').querySelectorAll('button').forEach(x=>x.classList.toggle('on',x.dataset.z===tz2));}
    const tg=App.prefs.get('tlGroup');if(tg){App.state.tlGroup=tg;$('tl_group').value=tg;}
    const sg=App.prefs.get('sprintGroup');if(sg)sprintGroup=sg;
    const au=App.prefs.get('auto');if(au!==null){$('f_auto').value=au;App.settings.setAutoRefresh(au);}
    const sc=App.prefs.get('uiScale');
    if(sc!==null){
      const num=parseFloat(sc);
      if(!isNaN(num)){
        $('f_scale').value=num.toFixed(1);
        updateUiScale(num);
      }
    }
    const mn=App.prefs.get('maxNodes');if(mn!==null){App.state.maxNodesLimit=parseInt(mn,10);}
    const rd=App.prefs.get('rankDir');if(rd==='TB'||rd==='LR'){App.state.rankDir=rd;$('dir').querySelectorAll('button').forEach(x=>x.classList.toggle('on',x.dataset.d===rd));}
    // Hydrated here (not at app.js parse time) because App.prefs.load() only resolves during boot, after this module is parsed.
    const savedTlWidth=App.prefs.get('tlLabelWidth');if(savedTlWidth)tlLabelWidth=parseInt(savedTlWidth,10);
    const ps=App.prefs.get('pinnedSprints');if(ps){const p=JSON.parse(ps);if(Array.isArray(p))pinnedSprints=new Set(p);}}catch(e){}
  App.types.buildLegend();App.filters.renderFilters();App.filters.updateFilterCount();App.setup.updatePatBadge();updateUndoButtons();updateCreateButtons();
  setInterval(App.setup.updatePatBadge, 1800000); // refresh the PAT countdown badge every 30 minutes independently of the tasks auto-refresh setting
  await loadIdentity();
  try{
    const savedWidth=App.prefs.get('sideWidth');
    if(savedWidth)$('side').style.width=savedWidth;
    const savedMode=App.prefs.get('mode');
    if(savedMode&&savedMode!=='tree')setMode(savedMode);
  }catch(e){}
  renderViewHelp();                          // show the controls legend for the initial view
  const p=new URLSearchParams(location.search),root=p.get('root');
  if(root){await openItem(App.backend.gid(root));}
  if(App.state.mode==='tree')await App.snapshot.loadSnapshot();   // paint last session's tree instantly while the network refresh runs
  refresh().then(App.setup.warnIfPatExpiring);   // nudge after the list settles, if the PAT is near expiry
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
  App.filters.renderFilters();                          // re-render so Assigned chips include people
  loadFilterData().then(App.filters.renderFilters);     // states/tags/sprints fill in async (don't block first paint)
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
  if(explore)explore.addEventListener('click',()=>{ if(typeof closeMore === 'function') closeMore(); if(window.ProFeaturesPanel)window.ProFeaturesPanel.open(); });
  
  // Initialize the auto-styling for all [data-pro-feature] buttons
  if(window.ProButtonManager) window.ProButtonManager.init();
}

// ---- wiring helpers (extracted verbatim from initialBoot; order preserved) ----
function wireControls(){
  // switching view is render-only (no API): graph draws from the App.state.store, tree DOM persists
  $('mode').querySelectorAll('button').forEach(b=>b.onclick=()=>App.settings.switchMode(b.dataset.m));
  $('emode').querySelectorAll('button').forEach(b=>b.onclick=()=>{App.state.edgeMode=b.dataset.e;$('emode').querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===b));App.graph.depHandleHide();App.graph.renderGraph();});
  $('dir').querySelectorAll('button').forEach(b=>b.onclick=()=>{App.state.rankDir=b.dataset.d;$('dir').querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===b));App.prefs.set('rankDir',App.state.rankDir);App.graph.renderGraph({relayout:true,fit:true});});
  $('f_sort').onchange=()=>{
    App.prefs.set('sort',$('f_sort').value);
    if (window.filterManager) {
      const ir = window.filterManager.getIR();
      ir.order = $('f_sort').value || null;
      // We set activeIR without triggering full save/refresh loop, just silently update the order
      // so the filter builder has it next time it's opened.
      window.filterManager.activeIR = ir;
    }
    refresh();
  };
  for(let o=-12;o<=14;o++)$('f_tz').appendChild(new Option('UTC'+(o>=0?'+':'')+o,o));
  {const s=App.prefs.get('tz');if(s!==null&&s!=='')tzOffset=parseInt(s);}
  $('f_tz').value=tzOffset;
  $('f_tz').onchange=()=>{tzOffset=parseInt($('f_tz').value);App.prefs.set('tz',tzOffset);if(App.state.mode==='board')App.board.renderBoard();if(App.state.cur!=null)loadTimeline(App.state.cur);};
  // working-hours window for the active-time calc (defaults 9–17)
  {let ws=9,we=17;const wh=App.prefs.get('workHours');
    if(wh&&/^\d+-\d+$/.test(wh)){const m=wh.split('-');ws=+m[0];we=+m[1];}
    const r=api.setWorkHours(ws,we);$('f_wh_start').value=r.start;$('f_wh_end').value=r.end;}
  const applyWH=()=>{const r=api.setWorkHours($('f_wh_start').value,$('f_wh_end').value);
    $('f_wh_start').value=r.start;$('f_wh_end').value=r.end;
    App.prefs.set('workHours',r.start+'-'+r.end);
    if(App.state.mode==='board')App.board.renderBoard();if(App.state.cur!=null)loadTimeline(App.state.cur);};
  $('f_wh_start').onchange=applyWH;$('f_wh_end').onchange=applyWH;
  $('empty_btn').onclick=()=>{const on=$('board').classList.toggle('showempty');$('empty_btn').classList.toggle('on',on);App.prefs.set('showEmpty',on?'1':'0');
    if(App.state.mode==='board'&&boardGroup!=='sprint')App.board.renderBoard();};   // state/assignee add/remove empty columns in JS (sprints are CSS-only)
  $('grp').querySelectorAll('button').forEach(b=>b.onclick=()=>{boardGroup=b.dataset.g;$('grp').querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===b));App.prefs.set('boardGroup',boardGroup);App.board.renderBoard();});
  // timeline: zoom segment, group select, row click → editor
  $('tlzoom').querySelectorAll('button').forEach(b=>b.onclick=()=>{App.state.tlZoom=b.dataset.z;$('tlzoom').querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===b));App.prefs.set('tlZoom',App.state.tlZoom);App.timeline.render();});
  $('tl_group').onchange=()=>{App.state.tlGroup=$('tl_group').value;App.prefs.set('tlGroup',App.state.tlGroup);App.timeline.render();};
  $('timeline').addEventListener('click',e=>{const r=e.target.closest&&e.target.closest('.tlrow[data-id]');if(!r)return;
    const id=r.dataset.id;
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
        App.prefs.set('tlLabelWidth', tlLabelWidth);
        App.timeline.render();
      }
    });
  })();
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
  $('searchbtn').onclick=()=>{const t=$('search').value.trim();if(/^\d+$/.test(t)){openItem(App.backend.gid(t));return;}refresh();};
  $('search').addEventListener('keydown',e=>{if(e.key==='Enter')$('searchbtn').click();});
  // hard refresh: drop every per-session cache and re-fetch everything from the server
  $('refreshbtn').onclick=async()=>{
    const b=$('refreshbtn');b.classList.add('spinning');b.disabled=true;
    try{App.state.depCache={};iterCache=null;             // deps + sprints are cached per session
      await refresh();                          // refetch list + rebuild hierarchy from scratch
      if(App.state.cur!=null)openItem(App.state.cur);               // reload the open editor so its fields match server
    }finally{b.classList.remove('spinning');b.disabled=false;}
  };
  $('fit').onclick=()=>App.state.cy&&App.state.cy.fit(undefined,40);
  loadBadgesOn();                                                 // restore last "what to show on nodes" choices
  // The Badges trigger is now part of the Controls panel header (wired in renderViewHelp);
  // here we just handle outside-click dismissal of the popover.
  document.addEventListener('mousedown',e=>{
    const p=$('badgepanel');if(p.style.display==='none')return;
    const gb=$('vhbadge');if(!p.contains(e.target)&&e.target!==gb&&(!gb||!gb.contains(e.target)))p.style.display='none';});
  $('theme').onclick=App.settings.cycleTheme;
  try{window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change',()=>{if((App.prefs.get('theme')||'dark')==='auto')App.settings.applyTheme('auto');});}catch(e){}
  // Only wire real export buttons (data-x). Pro placeholders (data-pro-feature)
  // in the same segment are handled by the delegated premium handler.
  $('export').querySelectorAll('button[data-x]').forEach(b=>b.onclick=()=>App.export.exportView(b.dataset.x));
  $('f_auto').onchange=()=>{const s=$('f_auto').value;App.prefs.set('auto',s);App.settings.setAutoRefresh(s);};
  $('f_scale').onchange=()=>{const s=$('f_scale').value;try{updateUiScale(parseFloat(s));}catch(e){}};
  if(window.i18n&&$('f_lang')){$('f_lang').value=window.i18n.getLang();$('f_lang').onchange=()=>{window.i18n.setLang($('f_lang').value);};}
  $('f_follow_notify').onclick=App.settings.cycleFollowNotify;
  {const tb=$('f_telemetry');if(tb)tb.onclick=App.settings.cycleTelemetry;}
}
function wireBulkBar(){
  $('f_mention_notify').onclick=App.settings.cycleMentionNotify;
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
    const ids=[...App.state.bulkSel];
    if(!ids.length)return;
    const { followedItems = {} } = await chrome.storage.local.get("followedItems");
    const { org, project } = await api.getConfig();
    ids.forEach(id=>{
      const itemData = App.state.store.nodes[id];
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
    if(App.state.cur!=null)FollowManager.updateButtonState(App.state.cur);
    updateFollowedBtnVisual();
    syncBulkBarValues();
  };
  $('bulk_unfollow_btn').onclick=async()=>{
    const ids=[...App.state.bulkSel];
    if(!ids.length)return;
    const { followedItems = {} } = await chrome.storage.local.get("followedItems");
    ids.forEach(id=>{
      delete followedItems[id];
    });
    await chrome.storage.local.set({ followedItems });
    if(App.state.cur!=null)FollowManager.updateButtonState(App.state.cur);
    updateFollowedBtnVisual();
    syncBulkBarValues();
  };
  syncBulkDatePicker(null, null);
}
function wireEditorAndKeys(){
  // command palette (Ctrl/Cmd+K)
  document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.code==='KeyK'&&!e.altKey){e.preventDefault();
    $('palette').classList.contains('show')?App.palette.closePalette():App.palette.openPalette();}});
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
    e.preventDefault();App.create.showNewItem();});
  $('palette-input').addEventListener('input',e=>App.palette.renderPalette(e.target.value));
  $('palette-input').addEventListener('keydown',e=>{
    if(e.key==='ArrowDown'){e.preventDefault();e.stopPropagation();App.palette.movePalette(1);}
    else if(e.key==='ArrowUp'){e.preventDefault();e.stopPropagation();App.palette.movePalette(-1);}
    else if(e.key==='Enter'){e.preventDefault();e.stopPropagation();App.palette.runPalette();}
    else if(e.key==='Escape'){e.preventDefault();e.stopPropagation();App.palette.closePalette();}
  });
  $('palette').addEventListener('mousedown',e=>{if(e.target===$('palette'))App.palette.closePalette();});
  (function(){const rz=$('resizer'),side=$('side');let drag=false;     // resizable Work Item panel
    rz.addEventListener('mousedown',e=>{drag=true;rz.classList.add('active');document.body.style.cursor='col-resize';e.preventDefault();});
    document.addEventListener('mousemove',e=>{if(!drag)return;
      const w=Math.min(Math.max(window.innerWidth-e.clientX,300),Math.round(window.innerWidth*0.7));side.style.width=w+'px';});
    document.addEventListener('mouseup',()=>{if(drag){drag=false;rz.classList.remove('active');document.body.style.cursor='';if(App.state.cy)App.state.cy.resize();App.prefs.set('sideWidth',side.style.width);}});
  })();
  $('s_save').onclick=save;
  $('s_comment').onclick=()=>{App.activity.toggleActivityExpand(true);toggleComment();};
  // Wrap so the click Event isn't passed as `force` (which would skip the
  // discard-confirm check inside closePanel).
  $('s_close').onclick=()=>closePanel();
  $('s_follow').onclick=async()=>{
    if(App.state.cur==null||!App.state.activeItemData)return;
    await FollowManager.toggleFollow(App.state.cur,App.state.activeItemData);
  };
  // Native "leave site?" guard for page reload / tab close / Cmd+W. Modern
  // browsers ignore custom text — assigning any non-empty returnValue is enough
  // to trigger the dialog.
  window.addEventListener('beforeunload',e=>{
    if(dirty()){e.preventDefault();e.returnValue='';return '';}
  });
  
  const summarizeBtn = $('s_ai_summarize');
  if (summarizeBtn) {
    summarizeBtn.onclick = async () => {
      if (window.AISummarizer) {
        await window.AISummarizer.summarizeCurrentItem();
      }
    };
  }

  $('s_customize').onclick=()=>{setCustomizeTab('side');showCustomize();};   // gear in the panel header → open Customize on the sidebar tab
  $('s_copy_link').onclick = async () => {
    const url = $('s_link').href;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      const btn = $('s_copy_link');
      const origHtml = btn.innerHTML;
      btn.innerHTML = '<ui-icon name="check"></ui-icon>';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.innerHTML = origHtml;
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
      if (!hasFiles(e) || App.state.cur == null) return;
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
      if (App.state.cur == null || !hasFiles(e)) return;
      e.preventDefault();
      const fs = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
      if (fs.length && App.state.descEditor) {
        App.state.descEditor.uploadFiles(fs, false);
      }
    });
  }
  App.state.commentEditor = new MarkdownEditor('comment_editor_container', {
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
  $('s_desc_attach').onclick=e=>{e.preventDefault();if(App.state.cur!=null)App.state.descEditor.triggerAttachmentUpload();};  $('s_me').onclick=()=>assignedEditor.set(currentUser||'me');
  $('s_discard').onclick=discardChanges;
  parentEditor.wire();parentNew.wire();   // parent card + searchable picker (editor + New-item modal)
  assignedEditor.wire();assignedChild.wire();assignedNew.wire();   // assignee card + people picker
  sprintEditor.wire();sprintNew.wire();                           // sprint card + iteration picker
  App.deps.depBlockedByPicker.wire();App.deps.depBlocksPicker.wire();               // dependency adders (Blocked-by / Blocks)
  bulkAssignedPicker.wire();bulkSprintPicker.wire();bulkParentPicker.wire();
  assignedEditor.render();assignedChild.render();assignedNew.render();sprintEditor.render();sprintNew.render();tagsEditor.render();   // placeholder cards before first use
  App.deps.depBlockedByPicker.render();App.deps.depBlocksPicker.render();App.deps.renderDeps();   // dep card stubs + empty chip rows
  bulkAssignedPicker.render();bulkSprintPicker.render();bulkParentPicker.render();
  window.bulkTagsEditor = new TagsEditor('bulk_tag_container');
  bulkTagsEditor.render();
  // refreshDirty on every keystroke for ALL editable fields, so the chip flips
  // to "● Unsaved" the moment anything diverges from App.state.orig.
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
        if (el.id === 'palette') { e.preventDefault(); e.stopPropagation(); App.palette.closePalette(); return; }
        if (el.id === 'newitem-overlay') {
          e.preventDefault(); e.stopPropagation();
          if(parentNew.isOpen())parentNew.close();
          else if(assignedNew.isOpen())assignedNew.close();
          else if(sprintNew.isOpen())sprintNew.close();
          else App.create.closeNewItem();
          return;
        }
        if (el.id === 'sprint-overlay') { e.preventDefault(); e.stopPropagation(); App.sprint.closeSprintModal(); return; }
        if (el.id === 'customize-overlay') { e.preventDefault(); e.stopPropagation(); closeCustomize(); return; }
        if (el.id === 'setup-overlay') { e.preventDefault(); e.stopPropagation(); App.setup.hideSetup(); return; }
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
          [parentEditor, assignedEditor, assignedChild, assignedNew, sprintEditor, sprintNew, parentNew, App.deps.depBlockedByPicker, App.deps.depBlocksPicker].forEach(p => {
            if (p && p.isOpen && p.isOpen()) p.close();
          });
          return;
        }
        if (el.classList.contains('reactions-popover')) {
          e.preventDefault(); e.stopPropagation();
          App.activity.closeEmojiPicker();
          return;
        }
        if (el.classList.contains('fullscreen') || el.id === 'side') {
          e.preventDefault(); e.stopPropagation();
          if (el.classList.contains('md-editor')) {
            const btn = el.querySelector('.dbtn-full');
            if(btn)btn.click();
          } else if (el.dataset.sg === 'actions') {
            App.activity.toggleActivityFullscreen(false);
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
        else if(App.deps.depBlockedByPicker.isOpen())App.deps.depBlockedByPicker.close();
        else if(App.deps.depBlocksPicker.isOpen())App.deps.depBlocksPicker.close();
        else if($('comment_editor_container').style.display==='flex'){closeCommentForm();}
        else if($('child_form').style.display==='flex'){$('child_form').style.display='none';const cb=$('s_childbtn');if(cb)cb.classList.remove('on');}
        else if($('side').classList.contains('fullscreen'))toggleFullscreen(false);
        else closePanel();
      }
    }
  });
  $('s_childbtn').onclick=()=>{App.activity.toggleActivityExpand(true);const f=$('child_form');const show=f.style.display!=='flex';f.style.display=show?'flex':'none';f.style.flexDirection='column';$('s_childbtn').classList.toggle('on', show);if(show){$('c_prio').value = $('s_prio').value || '';$('c_title').focus();}};
  const atb = $('activity_toggle_btn');
  if (atb) {
    atb.onclick = () => {
      const actionsGroup = document.querySelector('.sgroup[data-sg="actions"]');
      if (actionsGroup && actionsGroup.classList.contains('fullscreen')) {
        App.activity.loadActivity();
        return;
      }
      const hidden = $('activity-content').classList.contains('hidden');
      App.activity.toggleActivityExpand(hidden);
    };
  }
  const saf = $('s_act_full');
  if (saf) {
    saf.onclick = () => App.activity.toggleActivityFullscreen();
  }
  App.activity.initActivityResizer();
  $('c_create').onclick=createChild;$('c_cancel').onclick=()=>{$('child_form').style.display='none';$('s_childbtn').classList.remove('on');};
  $('c_me').onclick=()=>assignedChild.set(currentUser||'me');
  $('c_title').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();createChild();}});
}
function wireModals(){
  // new-item modal (create from scratch)
  $('newbtn').onclick=()=>App.create.showNewItem();
  $('undobtn').onclick=runUndo;$('redobtn').onclick=runRedo;
  $('n_create').onclick=App.create.createNew;$('n_cancel').onclick=App.create.closeNewItem;
  $('n_me').onclick=()=>assignedNew.set(currentUser||'me');
  $('newitem-overlay').addEventListener('mousedown',e=>{if(e.target===$('newitem-overlay'))App.create.closeNewItem();});
  $('n_title').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();App.create.createNew();}});
  $('newitem-box').addEventListener('keydown',e=>{
    if(e.key==='Escape'){e.preventDefault();e.stopPropagation();if(parentNew.isOpen())parentNew.close();else if(assignedNew.isOpen())assignedNew.close();else if(sprintNew.isOpen())sprintNew.close();else App.create.closeNewItem();}
    else if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){e.preventDefault();App.create.createNew();}});
  // new-sprint modal (Board → By Sprint "＋" column)
  $('sp_create').onclick=App.sprint.createSprintSubmit;$('sp_cancel').onclick=App.sprint.closeSprintModal;
  $('sprint-overlay').addEventListener('mousedown',e=>{if(e.target===$('sprint-overlay'))App.sprint.closeSprintModal();});
  $('sprint-box').addEventListener('keydown',e=>{
    if(e.key==='Escape'){e.preventDefault();e.stopPropagation();App.sprint.closeSprintModal();}
    else if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){e.preventDefault();App.sprint.createSprintSubmit();}});
  $('sp_name').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();App.sprint.createSprintSubmit();}});
  // customize-toolbar dialog
  $('cz_open').onclick=showCustomize;$('cz_done').onclick=closeCustomize;$('cz_reset').onclick=resetCustomize;
  // customize-emojis dialog
  $('emojis_open').onclick=App.activity.showEmojisModal;$('emojis_save').onclick=App.activity.saveEmojis;$('emojis_cancel').onclick=App.activity.closeEmojisModal;$('emojis_reset').onclick=App.activity.resetEmojis;
  $('emojis-overlay').addEventListener('mousedown',e=>{if(e.target===$('emojis-overlay'))App.activity.closeEmojisModal();});
  $('emojis-box').addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();App.activity.closeEmojisModal();}});
  
  // Wire dynamic preview updates and file uploads for customize emojis overlay
  const emojiTypes = ['like', 'dislike', 'heart', 'hooray', 'smile', 'confused'];
  emojiTypes.forEach(type => {
    const input = $(`emoji_override_${type}`);
    if (input) {
      input.addEventListener('input', () => App.activity.updateEmojiInputPreview(type));
    }
  });
  document.querySelectorAll('.emoji-file-input').forEach(fileIn => {
    fileIn.addEventListener('change', e => {
      const type = fileIn.dataset.type;
      const file = e.target.files[0];
      if (file) {
        if (file.size > 256 * 1024) {
          App.activity.showEmojiRowError(type, 'File too large! Choose an image under 256KB.');
          fileIn.value = '';
          return;
        }
        const reader = new FileReader();
        reader.onload = ev => {
          const input = $(`emoji_override_${type}`);
          if (input) {
            input.value = ev.target.result;
            App.activity.updateEmojiInputPreview(type);
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
}

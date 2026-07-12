// Extensible, data-driven chip filters: the FILTERS field descriptor list plus
// rendering of the quick-filter chip rows, the active-filter count badge, and the
// debounced apply scheduler. Phase-1 leaf module of the App.* refactor
// (REFACTORING_PLAN.md): IIFE publishing App.filters.
// Reads/writes bare globals at call time ($, window.filterManager, projectStates,
// assignees, sprintPaths, sprintNames, tagList, currentUser, typeNames,
// getContextPopular, buildBulkControls, refresh, window.i18n, window.LayerManager)
// and keeps the applyTimer debounce state private. Loads before app.js.
(function (App) {
  'use strict';

  /* ---------- extensible chip filters (data-driven) ----------
     Add a field: one entry here + one in FILTER_FIELDS in api.js. */
  const FILTERS=[
    {key:'state',label:'State',values:()=>projectStates.length?projectStates:['New','Active','Resolved','Closed','Removed']},
    {key:'type',label:'Type',values:()=>typeNames()},
    {key:'priority',label:'Priority',values:()=>[1,2,3,4],fmt:v=>'P'+v},
    {key:'assigned',label:'Assigned',values:()=>['me',...assignees],fmt:v=>v==='me'?(currentUser?`${currentUser} (me)`:'me'):v},
    {key:'iteration',label:'Sprint',values:()=>sprintPaths,fmt:p=>sprintNames[p]||p},
    {key:'tags',label:'Tags',values:()=>tagList},
  ];
  function filterCount(){
    if (!window.filterManager) return 0;
    const ir = window.filterManager.getIR();
    let count = 0;
    const countRules = (rule) => {
      if (!rule) return 0;
      if (rule.kind === 'group') {
        return (rule.rules || []).reduce((acc, r) => acc + countRules(r), 0);
      }
      if (rule.kind === 'condition') {
        if (rule.value !== undefined && rule.value !== null) {
          if (Array.isArray(rule.value)) {
            return rule.value.length;
          }
          return String(rule.value).trim() !== '' ? 1 : 0;
        }
      }
      return 0;
    };
    count += countRules(ir.where);
    if (window.filterManager.isFollowed()) count++;
    return count;
  }
  function updateFilterCount(){const n=filterCount();const el=$('filt_count');if(el)el.textContent=n?('('+n+')'):'';}
  function renderFilters(){
    const chipsEl = $('filterchips');
    const indEl = $('advanced-filter-indicator');

    if (!window.filterManager) return;
    const isAdv = window.filterManager.isAdvanced();

    if (isAdv) {
      if (chipsEl) chipsEl.style.display = 'none';
      if (indEl) indEl.style.display = 'flex';
      const all=$('filt_clear_all');if(all)all.style.visibility='visible';
      return;
    }

    if (chipsEl) chipsEl.style.display = 'block';
    if (indEl) indEl.style.display = 'none';

    const el=$('filterchips');el.innerHTML='';
    // toggle the static "Clear all" in the Find row — visibility (not display)
    // keeps its slot reserved so the search input never shifts when filters appear
    const all=$('filt_clear_all');if(all)all.style.visibility=filterCount()>0?'visible':'hidden';
    FILTERS.forEach(f=>{
      const allVals=f.values()||[];
      if(!allVals.length&&!window.filterManager.hasFieldFilters(f.key))return;   // skip empty rows (e.g. tags/sprints not loaded yet)

      const limit = 10;
      const isLarge = allVals.length > limit;
      let valsToShow = allVals;
      if(isLarge){
        const selected = allVals.filter(v => window.filterManager.getChipState(f.key, v) === 'in');
        const popular=getContextPopular(f.key, allVals);
        const union=new Set([...selected,...popular]);
        if(f.key==='assigned')union.add('me');
        valsToShow=allVals.filter(v=>union.has(String(v)));
      }

      const row=document.createElement('div');row.className='frow';
      const lab=document.createElement('span');lab.className='fl';lab.textContent=f.label;row.appendChild(lab);
      // per-row clear "x" sits left of the chips. ALWAYS rendered so the chip
      // alignment doesn't jump when it appears/disappears; visibility:hidden
      // keeps the slot reserved when this filter has no selection.
      const x=document.createElement('button');
      x.className='fclear';x.title='clear this filter';x.innerHTML='<ui-icon name="x"></ui-icon>';
      if(window.filterManager.hasFieldFilters(f.key))
        x.onclick=()=>{window.filterManager.clearField(f.key);};
      else{x.style.visibility='hidden';x.tabIndex=-1;}
      row.appendChild(x);
      valsToShow.forEach(v=>{
        const ch=document.createElement('span');ch.className='chip';
        const st=window.filterManager.getChipState(f.key, v);if(st)ch.classList.add(st);
        ch.textContent=f.fmt?f.fmt(v):v;
        ch.onclick=()=>{
          const curSt = window.filterManager.getChipState(f.key, v);
          if (curSt === 'out') {
            window.filterManager.removeChip(f.key, v);
          } else {
            window.filterManager.toggleChip(f.key, v, !curSt ? 'in' : 'out');
          }
        };
        row.appendChild(ch);
      });
      if(isLarge){
        const wrap=document.createElement('div');
        wrap.className='f-dropdown-container';

        const inp=document.createElement('input');
        inp.type='text';
        inp.className='tag-search';
        inp.placeholder='Search ' + f.label.toLowerCase() + '...';
        inp.autocomplete='off';
        wrap.appendChild(inp);

        const clearBtn=document.createElement('button');
        clearBtn.type='button';
        clearBtn.className='search-clear-btn';
        clearBtn.innerHTML='<ui-icon name="x"></ui-icon>';
        clearBtn.style.display='none';
        wrap.appendChild(clearBtn);

        const updateClearBtn=()=>{
          clearBtn.style.display=inp.value?'inline-flex':'none';
        };

        const dropdown=document.createElement('div');
        dropdown.className='f-dropdown';
        dropdown.style.display='none';
        wrap.appendChild(dropdown);

        const showMatches=(q)=>{
          const query=q.toLowerCase().trim();
          const shownSet=new Set(valsToShow.map(String));
          const matches=allVals.filter(v=>{
            if(shownSet.has(String(v)))return false;
            return String(f.fmt?f.fmt(v):v).toLowerCase().includes(query);
          });
          dropdown.innerHTML='';
          if(!matches.length){
            const empty=document.createElement('div');
            empty.className='f-dropdown-item empty';
            empty.textContent=window.i18n.t('filter.noMatches');
            dropdown.appendChild(empty);
          } else {
            matches.forEach(val=>{
              const item=document.createElement('div');
              item.className='f-dropdown-item';
              item.textContent=f.fmt?f.fmt(val):val;
              item.onmousedown=(e)=>{
                e.preventDefault();
                window.filterManager.toggleChip(f.key, val, 'in');
                inp.value='';
                updateClearBtn();
                dropdown.style.display='none';
                if (window.LayerManager) window.LayerManager.close(dropdown);
              };
              dropdown.appendChild(item);
            });
          }
          dropdown.style.display='flex';
          if (window.LayerManager) window.LayerManager.open(dropdown, null, { isPopover: true });
          dropdown.style.left='0';
          dropdown.style.right='auto';
          dropdown.style.top='100%';
          dropdown.style.bottom='auto';
          dropdown.style.marginTop='4px';
          dropdown.style.marginBottom='0';
          const rect=dropdown.getBoundingClientRect();
          if(rect.right>window.innerWidth){
            dropdown.style.left='auto';
            dropdown.style.right='0';
          }
          if(rect.bottom>window.innerHeight){
            dropdown.style.top='auto';
            dropdown.style.bottom='100%';
            dropdown.style.marginTop='0';
            dropdown.style.marginBottom='4px';
          }
        };

        inp.onfocus=()=>{
          updateClearBtn();
          showMatches(inp.value);
        };
        inp.oninput=()=>{
          updateClearBtn();
          showMatches(inp.value);
        };
        inp.onblur=()=>{
          dropdown.style.display='none';
          if (window.LayerManager) window.LayerManager.close(dropdown);
          clearBtn.style.display='none';
        };
        clearBtn.onmousedown=e=>{
          e.preventDefault();
        };
        clearBtn.onclick=e=>{
          e.stopPropagation();
          inp.value='';
          updateClearBtn();
          showMatches('');
          inp.focus();
        };
        inp.onkeydown=e=>{
          if(e.key==='Escape'){
            dropdown.style.display='none';
            if (window.LayerManager) window.LayerManager.close(dropdown);
            clearBtn.style.display='none';
            inp.blur();
          } else if(e.key==='Enter'){
            e.preventDefault();
            const firstItem=dropdown.querySelector('.f-dropdown-item:not(.empty)');
            if(firstItem){
              firstItem.dispatchEvent(new MouseEvent('mousedown'));
            }
          }
        };
        row.appendChild(wrap);
      }
      el.appendChild(row);
    });
    buildBulkControls();                      // keep the bulk-bar dropdowns in sync with loaded data
  }
  let applyTimer=null;
  function scheduleApply(){clearTimeout(applyTimer);applyTimer=setTimeout(refresh,500);}  // debounce (long enough to click several chips)

  function renderFavoriteFilters() {
    const favCont = $('fav-filters');
    if (!favCont) return;
    
    let saved = [];
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(['fbSavedFilters'], (res) => {
        saved = res.fbSavedFilters || [];
        drawFavs(saved);
      });
    } else {
      saved = JSON.parse(localStorage.getItem('fbSavedFilters') || '[]');
      drawFavs(saved);
    }
    
    function drawFavs(filters) {
      favCont.innerHTML = '';
      const favs = filters.filter(f => f.favorite);
      if (favs.length === 0) {
        favCont.style.display = 'none';
        return;
      }
      favCont.style.display = 'flex';
      
      favs.forEach(f => {
        const btn = document.createElement('button');
        btn.className = 'btn btn-fav-filter';
        btn.title = 'Apply favorited filter';
        btn.innerHTML = `<ui-icon name="star" style="color:var(--state-resolved, #e3a008); font-size:0.8em; margin-right:4px;"></ui-icon> <span>${f.name}</span>`;
        btn.style.padding = '2px 8px';
        btn.style.fontSize = '0.85rem';
        btn.onclick = () => {
          if (window.filterManager) {
            window.filterManager.setIR(f.config);
            if (window.refresh) window.refresh();
          }
        };
        favCont.appendChild(btn);
      });
    }
  }

  App.filters = { FILTERS, filterCount, updateFilterCount, renderFilters, renderFavoriteFilters, scheduleApply };
})(window.App);

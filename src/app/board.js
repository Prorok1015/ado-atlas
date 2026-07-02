/* board.js — board (sprints) + custom card-drag + sprint-detail (Gantt) extracted from app.js.
   Classic <script>, shares ONE global scope. Internal calls stay bare; only functions with
   external callers in src/app.js are published on App.board.

   STAY-BARE references (defined elsewhere in the shared scope):
   - shared sprint/date helpers (app/sprint-utils.js): prettyDate, getIterations, isCurrentSprint,
     hh, colMeta, _sprint, iterCache, DONE_STATES, BOARD_TIME_CAP
   - badges (app/badges.js): badgeOn, BADGE_FIELDS_BY_VIEW
   - core state / helpers (app.js): $, htmlEsc, setStatus, openItem, refresh, loadStart, loadEnd,
     api, window.i18n, customConfirm, App.state.cy, mode, App.state.store, App.state.bulkSel, App.state.cur, boardBusy, pdrag, boardScroll,
     boardGroup, openSprintPath, projectStates, sprintPaths, sprintNames, pinnedSprints,
     TYPE_COLOR, tyColor, stateColor, prioColor, orderStates, cmpBySort, hexToRgb,
     App.state.boardToken, tzOffset, capNote, projectName, newSprints, canCreateSprint, suppressClick,
     pendingSprintItems, App.sprint.showSprintModal, App.sprint.showSprintEdit, togglePinSprint, currentUser, assignees,
     bulkToggle, bulkRange, pushAction, afterUndo, canEditSprint, sprintGroup, renderViewHelp
   - component-defined globals (components/card-picker.js): personColor, personChipT, tagList_

   NOTE: openSprintPath is declared bare in app.js (read+written outside this section), so it is NOT
   re-declared here — reference it bare.
*/
(function (App) {
  'use strict';

  // ISO date/datetime -> "30 May 2026" (UTC, so it never drifts a day across timezones)
  /* shared sprint/date helpers (prettyDate/getIterations/isCurrentSprint/hh/colMeta/_sprint/iterCache/DONE_STATES/BOARD_TIME_CAP) -> app/sprint-utils.js (bare) */

  async function annotateBoardTimes(){      // fill actual (active wall-clock) time per card + column Σ
    const token=App.state.boardToken;                 // current render's token — bail if a newer render starts
    const cards=[...document.querySelectorAll('#board .bcard[data-id]')];
    if(!cards.length)return;
    const ids=cards.map(c=>+c.dataset.id);
    const setCard=(c,act)=>{                 // act = hours or null
      const est=c.dataset.est?+c.dataset.est:null,lab=c.querySelector('.tlabel'),fill=c.querySelector('.tfill');
      if(act==null){if(lab)lab.innerHTML=est!=null?('est '+est+'h'):'<ui-icon name="clock"></ui-icon> —';return;}
      if(est!=null&&fill){const r=act/est;fill.style.width=Math.min(r,1)*100+'%';fill.style.background=r>1?'#e74c3c':'var(--accent)';
        if(lab)lab.textContent=`${Math.round(act)}/${est}h`;c.querySelector('.tbar').classList.toggle('over',r>1);}
      else if(lab)lab.innerHTML='<ui-icon name="clock"></ui-icon> '+hh(act);
    };
    if(ids.length>BOARD_TIME_CAP){setStatus(cards.length+' cards — filter to ≤'+BOARD_TIME_CAP+' to load actual time');
      cards.forEach(c=>setCard(c,null));return;}
    let t;try{t=await api.times(ids,tzOffset);}catch(e){return;}
    if(token!==App.state.boardToken)return;            // a newer renderBoard superseded us — don't write stale times
    cards.forEach(c=>{const sec=t[c.dataset.id];if(sec==null){setCard(c,null);return;}c.dataset.act=sec;setCard(c,sec/3600);});
    document.querySelectorAll('#board .bcol').forEach(col=>{let sa=0,se=0;
      col.querySelectorAll('.bcard[data-id]').forEach(c=>{sa+=+(c.dataset.act||0);se+=(c.dataset.est?+c.dataset.est:0);});
      const lab=col.querySelector('.colact'),fill=col.querySelector('.tbar.cbar .tfill'),ah=sa/3600;
      if(se>0&&fill){const r=ah/se;fill.style.width=Math.min(r,1)*100+'%';fill.style.background=r>1?'#e74c3c':'var(--accent)';
        const cb=col.querySelector('.cbar');if(cb)cb.classList.toggle('over',r>1);
        if(lab)lab.textContent=`Σ ${Math.round(ah)}/${Math.round(se)}h`;}
      else if(lab&&sa>0)lab.innerHTML='Σ<ui-icon name="clock"></ui-icon> '+hh(ah);});
  }
  async function renderBoard(){
    const token=++App.state.boardToken;
    const iters=await getIterations();
    if(token!==App.state.boardToken)return;                     // a newer renderBoard started — bail out
    const el=$('board');el.innerHTML='';
    const today=new Date().toISOString().slice(0,10);
    const info={},finish={};iters.forEach(it=>{info[it.path]=it;finish[it.path]=it.finish;});
    const items=App.state.store.roots.map(id=>App.state.store.nodes[id]).filter(Boolean);   // SAME data as tree/graph
    if(boardGroup==='assignee'){renderBoardByAssignee(el,items);setStatus(`${items.length} items`+capNote());annotateBoardTimes();return;}
    if(boardGroup==='state'){renderBoardByState(el,items);setStatus(`${items.length} items`+capNote());annotateBoardTimes();return;}
    const groups=new Map();
    items.forEach(n=>{const k=info[n.iteration]?n.iteration:'__none__';if(!groups.has(k))groups.set(k,[]);groups.get(k).push(n);});
    groups.forEach(arr=>arr.sort(cmpBySort));  // order within column = toolbar Sort
    const root=iters[0]?iters[0].path.split('\\')[0]:projectName;   // project root = "no sprint"
    const order=iters.map(it=>it.path);   // ALL dated sprints (empties revealed while dragging)
    order.push('__none__');   // always show the "No sprint" column (a drop target even when empty)
    const fragment=document.createDocumentFragment();
    order.forEach(k=>{
      const it=k==='__none__'?null:info[k];const fin=it?it.finish:null;
      const colItems=groups.get(k)||[];
      const col=document.createElement('div');col.className='bcol';
      if(it&&(!it.start||!it.finish))col.classList.add('dateless');
      const isPinned=pinnedSprints.has(k);
      if(k!=='__none__'&&!colItems.length&&!newSprints.has(k)&&!isPinned)col.classList.add('empty-sprint');   // hidden until a drag starts (but keep a just-created one visible)
      if(k==='__none__'&&!colItems.length)col.classList.add('collapsed');   // empty "No sprint" → narrow, expands on drag-hover
      if(it&&it.start&&it.finish&&today>=it.start.slice(0,10)&&today<=it.finish.slice(0,10))col.classList.add('current');
      const h=document.createElement('div');h.className='bhead';
      const dateBadge=it
        ?((!it.start||!it.finish)
          ?''
          :`<small>${(it.start||'').slice(0,10)}→${(fin||'').slice(0,10)}</small>`)
        :'';
      const pinBtn=k!=='__none__'?`<button class="pin-btn${isPinned?' pinned':''}" data-path="${htmlEsc(k)}" title="${isPinned?'Unpin column':'Pin column'}"><ui-icon name="pin"></ui-icon></button>`:'';
      h.innerHTML=(k==='__none__'?'No sprint':`${htmlEsc(it.name)} ${dateBadge} ${pinBtn}`)+'<br>'+colMeta(colItems);
      if(k!=='__none__'){
        h.style.cursor='pointer';h.title='open sprint timeline';
        h.addEventListener('click',(e)=>{
          if(e.target.closest('.pin-btn')){
            e.preventDefault();e.stopPropagation();
            togglePinSprint(k);
            return;
          }
          openSprint(k);
        });
      }
      const wrap=document.createElement('div');wrap.className='bcards';
      colItems.forEach(n=>wrap.appendChild(boardCard(n,fin,today)));
      if(!colItems.length){const ph=document.createElement('div');ph.className='empty';ph.textContent=window.i18n.t('board.dropHere');wrap.appendChild(ph);}
      col.dataset.field='iteration';col.dataset.val=(k==='__none__')?root:k;   // drop = change sprint
      col.append(h,wrap);fragment.appendChild(col);
    });
    if(canCreateSprint){                              // phantom "add sprint" column at the right end
      const add=document.createElement('div');add.className='bcol addcol';add.title='create a new sprint';
      add.innerHTML='<div class="addinner"><span class="plus">＋</span>New sprint</div>';
      add.onclick=()=>{if(suppressClick)return;pendingSprintItems=null;App.sprint.showSprintModal();};fragment.appendChild(add);   // plain click (not a drop)
    }
    el.appendChild(fragment);
    setStatus(`${items.length} items`+capNote());annotateBoardTimes();
  }
  function renderBoardByAssignee(el,items){
    const groups=new Map();
    items.forEach(n=>{const k=n.assigned||'';if(!groups.has(k))groups.set(k,[]);groups.get(k).push(n);});
    groups.forEach(arr=>arr.sort(cmpBySort));
    let names=[...groups.keys()].filter(k=>k);
    if($('board').classList.contains('showempty'))    // "∅ empty" on: also show team members with no items
      [currentUser,...assignees].forEach(a=>{if(a&&!groups.has(a)&&!names.includes(a))names.push(a);});
    names.sort((a,b)=>a.localeCompare(b));
    if(groups.has(''))names.push('');                 // Unassigned last
    const fragment=document.createDocumentFragment();
    names.forEach(k=>{
      const arr=groups.get(k)||[];
      const col=document.createElement('div');col.className='bcol';
      const h=document.createElement('div');h.className='bhead';
      h.innerHTML=(k?htmlEsc(k):'Unassigned')+'<br>'+colMeta(arr);
      const wrap=document.createElement('div');wrap.className='bcards';
      arr.forEach(n=>wrap.appendChild(boardCard(n,null,'')));   // no overdue colouring in assignee view
      if(!arr.length){const ph=document.createElement('div');ph.className='empty';ph.textContent=window.i18n.t('board.dropHere');wrap.appendChild(ph);}
      col.dataset.field='assigned';col.dataset.val=k;   // drop = reassign
      col.append(h,wrap);fragment.appendChild(col);
    });
    el.appendChild(fragment);
  }
  function renderBoardByState(el,items){
    const today=new Date().toISOString().slice(0,10);
    const groups=new Map();
    items.forEach(n=>{const k=n.state||'';if(!groups.has(k))groups.set(k,[]);groups.get(k).push(n);});
    groups.forEach(arr=>arr.sort(cmpBySort));
    let keys=[...groups.keys()].filter(k=>k);
    if($('board').classList.contains('showempty'))    // "∅ empty" on: also show project states with no items
      projectStates.forEach(s=>{if(!groups.has(s))keys.push(s);});
    const cols=orderStates(keys);
    if(groups.has(''))cols.push('');                  // items with no state last (rare)
    const fragment=document.createDocumentFragment();
    cols.forEach(k=>{
      const arr=groups.get(k)||[];
      const col=document.createElement('div');col.className='bcol';
      const h=document.createElement('div');h.className='bhead';
      h.innerHTML=(k?`<span class="sbadge" style="background:${stateColor(k)}">${htmlEsc(k)}</span>`:'(no state)')+'<br>'+colMeta(arr);
      const wrap=document.createElement('div');wrap.className='bcards';
      arr.forEach(n=>wrap.appendChild(boardCard(n,null,today)));   // overdue colouring by target date
      if(!arr.length){const ph=document.createElement('div');ph.className='empty';ph.textContent=window.i18n.t('board.dropHere');wrap.appendChild(ph);}
      col.dataset.field='state';col.dataset.val=k;   // drop = change state
      col.append(h,wrap);fragment.appendChild(col);
    });
    el.appendChild(fragment);
  }
  function boardCard(n,finish,today){
    const due=n.target?n.target.slice(0,10):(finish?finish.slice(0,10):null);
    const overdue=due&&due<today&&!DONE_STATES.includes(n.state);
    const c=document.createElement('div');c.className='bcard'+(overdue?' overdue':'')+(App.state.bulkSel.has(n.id)?' bulksel':'');
    c.style.borderLeftColor=tyColor(n.type);   // left marker = item TYPE colour
    c.dataset.id=n.id;c.dataset.est=(n.est!=null?n.est:'');
    // Gate each badge by the board's per-field toggle (in the Controls header).
    const showAssigned=badgeOn('assigned','board'),showType=badgeOn('type','board'),
          showPrio=badgeOn('priority','board'),showState=badgeOn('state','board'),
          showEst=badgeOn('est','board'),showTags=badgeOn('tags','board');
    const tagsHtml=(()=>{
      if(!showTags||!n.tags)return '';
      const ts=tagList_(n.tags);if(!ts.length)return '';
      const show=ts.slice(0,4),extra=ts.length-show.length;
      return `<div class="btags">`+
        show.map(t=>`<span class="ttag" style="background:${personColor(t)}" title="${htmlEsc(t)}">${htmlEsc(t)}</span>`).join('')+
        (extra>0?`<span class="ttag" style="background:var(--muted)" title="${htmlEsc(ts.slice(4).join(', '))}">+${extra}</span>`:'')+
        `</div>`;
    })();
    c.innerHTML=`<div class="bttl">${showAssigned&&n.assigned?personChipT(n.assigned):''}<span class="btxt">#${n.id} ${htmlEsc(n.title)}</span></div>`+
      `<div class="bmeta">`+(showType?`<span>${htmlEsc(n.type)}</span>`:'')+
      (showPrio&&n.priority?`<span class="prio" style="background:${prioColor(n.priority)}">P${n.priority}</span>`:'')+
      (showState?`<span>${htmlEsc(n.state)}</span>`:'')+(overdue?'<span class="od">overdue</span>':'')+`</div>`+
      tagsHtml+
      (showEst?`<div class="bfoot">`+(n.est!=null?`<div class="tbar"><div class="tfill"></div></div>`:'')+
        `<span class="tlabel">${n.est!=null?'est '+(+n.est)+'h':'<ui-icon name="clock"></ui-icon> …'}</span></div>`:'');
    c.addEventListener('mousedown',e=>{if(e.button===0&&!e.ctrlKey&&!e.metaKey&&!e.shiftKey)startCardDrag(e,n.id,c);});   // modifier = select, not drag
    c.onclick=(e)=>{if(suppressClick)return;
      if(e.ctrlKey||e.metaKey){e.preventDefault();bulkToggle(n.id);return;}        // Ctrl/Cmd: toggle in selection
      if(e.shiftKey){e.preventDefault();bulkRange(n.id);return;}                    // Shift: range from anchor (select or deselect)
      openItem(n.id);};
    return c;
  }
  async function moveCard(id,field,val){            // field: 'iteration' | 'assigned' | 'state'
    boardBusy=true;loadStart('moving #'+id+'…');
    const card=document.querySelector('.bcard[data-id="'+id+'"]');if(card)card.classList.add('moving');
    const old=App.state.store.nodes[id]?App.state.store.nodes[id][field]:'';   // snapshot for undo (still the pre-move value here)
    try{
      const body={};body[field]=val;
      const r=await api.updateItem(id,body);
      if(App.state.store.nodes[id])App.state.store.nodes[id][field]=val;   // node uses the same key names (iteration/assigned/state)
      pushAction('move #'+id,
        async()=>{await api.updateItem(id,{[field]:(old==null?'':old)});await afterUndo(id);},
        async()=>{await api.updateItem(id,{[field]:val});await afterUndo(id);});
      setStatus('#'+id+' moved → rev '+r.rev);
    }catch(e){setStatus('ERROR: '+e.message,true);}
    boardBusy=false;loadEnd();
    renderBoard();                                   // regroup from the (now updated) App.state.store
  }
  // Bulk move: drag a selected card → move every selected card to the dropped column.
  async function moveCards(ids,field,val){
    ids=ids.filter(id=>App.state.store.nodes[id]&&String(App.state.store.nodes[id][field]||'')!==String(val));   // skip ones already there
    if(!ids.length)return;
    const olds=ids.map(id=>({id,old:App.state.store.nodes[id][field]}));
    boardBusy=true;loadStart(`moving ${ids.length} item(s)…`);
    const res=await api.pool(ids.map(id=>async()=>{try{await api.updateItem(id,{[field]:val});if(App.state.store.nodes[id])App.state.store.nodes[id][field]=val;return true;}catch(e){return false;}}),6);
    boardBusy=false;loadEnd();
    const ok=res.filter(Boolean).length,fail=res.length-ok;
    if(ok)pushAction(`move ${ids.length} item(s)`,
      async()=>{await api.pool(olds.map(o=>async()=>{try{await api.updateItem(o.id,{[field]:(o.old==null?'':o.old)});}catch(e){}}),6);await afterUndo(null);},
      async()=>{await api.pool(ids.map(id=>async()=>{try{await api.updateItem(id,{[field]:val});}catch(e){}}),6);await afterUndo(null);});
    setStatus(`moved ${ok} item(s)`+(fail?`, ${fail} failed`:''),!!fail);
    renderBoard();
  }
  /* ---- custom pointer-based card drag (native HTML5 DnD was unreliable here) ---- */
  function startCardDrag(e,id,card){
    if(boardBusy)return;
    pdrag={id,sx:e.clientX,sy:e.clientY,card,active:false,hot:null,clone:null};
  }
  document.addEventListener('mousemove',e=>{
    if(!pdrag)return;
    if(!pdrag.active){
      if(Math.abs(e.clientX-pdrag.sx)+Math.abs(e.clientY-pdrag.sy)<5)return;   // movement threshold
      pdrag.active=true;
      const r=pdrag.card.getBoundingClientRect();
      const bulk=App.state.bulkSel.has(pdrag.id)&&App.state.bulkSel.size>1;
      const cl=pdrag.card.cloneNode(true);cl.className='bcard drag-ghost'+(bulk?' bulk':'');cl.style.width=r.width+'px';
      if(bulk){const b=document.createElement('span');b.className='dgcount';b.textContent=App.state.bulkSel.size;cl.appendChild(b);}   // count badge
      document.body.appendChild(cl);pdrag.clone=cl;
      // dim every card being moved (the whole selection on a bulk drag)
      pdrag.dragEls=bulk?[...document.querySelectorAll('#board .bcard[data-id]')].filter(el=>App.state.bulkSel.has(+el.dataset.id)):[pdrag.card];
      pdrag.dragEls.forEach(el=>el.classList.add('dragging'));
      $('board').classList.add('drag');document.body.style.cursor='grabbing';
    }
    pdrag.clone.style.left=(e.clientX+10)+'px';pdrag.clone.style.top=(e.clientY+10)+'px';
    const el=document.elementFromPoint(e.clientX,e.clientY);
    const c=el&&el.closest?el.closest('.bcol[data-field], .bcol.addcol'):null;   // addcol = "＋ New sprint" drop zone
    if(pdrag.hot&&pdrag.hot!==c)pdrag.hot.classList.remove('dropover');
    pdrag.hot=c;if(c)c.classList.add('dropover');
  });
  document.addEventListener('mouseup',async ()=>{
    if(!pdrag)return;const d=pdrag;pdrag=null;
    if(!d.active)return;                              // was a plain click — let onclick handle it
    (d.dragEls||[d.card]).forEach(el=>el.classList.remove('dragging'));if(d.clone)d.clone.remove();
    $('board').classList.remove('drag');document.body.style.cursor='';
    if(d.hot)d.hot.classList.remove('dropover');
    suppressClick=true;setTimeout(()=>{suppressClick=false;},30);   // swallow the click that follows a drag
    const col=d.hot;if(!col)return;
    const bulk=App.state.bulkSel.has(d.id)&&App.state.bulkSel.size>1;                     // dragged a selected card → move the whole selection
    const dropIds=bulk?[...bulkSel]:[d.id];
    if(col.classList.contains('addcol')){                            // dropped on "＋ New sprint" → create, then move them in
      pendingSprintItems=dropIds;App.sprint.showSprintModal();return;
    }
    const field=col.dataset.field,val=col.dataset.val||'';
    const node=App.state.store.nodes[d.id],curVal=node?(node[field]||''):'';   // field: iteration | assigned | state
    if(val===curVal&&!bulk)return;
    if(field==='iteration'){const it=_sprint(val),fin=it&&it.finish?it.finish.slice(0,10):null,today=new Date().toISOString().slice(0,10);
      if(fin&&fin<today&&!await customConfirm(window.i18n.t('move.sprintEndedConfirm', {sprint:it.name, date:fin, what:bulk?window.i18n.t('move.nItems',{count:App.state.bulkSel.size}):('#'+d.id)}), window.i18n.t('move.confirmTitle')))return;}
    if(bulk)moveCards([...bulkSel],field,val);else moveCard(d.id,field,val);
  });

  /* ---------- sprint detail (Gantt) ---------- */
  /* openSprintPath is declared bare in app.js (read+written outside this section) — reference bare, do not re-declare */
  function renderSprint(path){
    const it=_sprint(path);if(!it||!it.start||!it.finish)return false;
    const DAY=86400000,s0=Date.parse(it.start.slice(0,10)),f0=Date.parse(it.finish.slice(0,10));
    const N=Math.max(1,Math.round((f0-s0)/DAY)+1);
    const todayIdx=Math.round((Date.parse(new Date().toISOString().slice(0,10))-s0)/DAY);
    const showToday=todayIdx>=0&&todayIdx<N, todayLeft=(todayIdx+0.5)/N*100;
    const items=App.state.store.roots.map(id=>App.state.store.nodes[id]).filter(n=>n&&n.iteration===path);
    const el=$('sprintview');el.innerHTML='';
    const se=items.reduce((s,n)=>s+(n.est||0),0);
    const top=document.createElement('div');top.className='gtop';
    const curMark=isCurrentSprint(it)?`<span class="curdot" title="current sprint"></span>`:'';
    top.innerHTML=`<button class="btn" id="g_back" title="back to board">←</button>`+
      `<span style="display:inline-flex;align-items:center;gap:6px">${curMark}<b>${htmlEsc(it.name)}</b></span> <span style="color:var(--muted)">${it.start.slice(0,10)} → ${it.finish.slice(0,10)} · ${items.length} items`+
      `${se?' · Σest '+(Math.round(se*10)/10)+'h':''} · <span id="g_act">Σ<ui-icon name="clock"></ui-icon> …</span></span>`+
      (canEditSprint?`<button class="btn" id="g_editdates" title="edit sprint dates"><ui-icon name="edit"></ui-icon> dates</button>`:'')+
      `<button class="btn${sprintGroup==='assignee'?' on':''}" id="g_group" title="group rows by assignee" style="margin-left:auto">by assignee</button>`;
    el.appendChild(top);
    const head=document.createElement('div');head.className='ghead';
    const hl=document.createElement('div');hl.className='glabel';head.appendChild(hl);
    const gd=document.createElement('div');gd.className='gdays';
    for(let i=0;i<N;i++){const d=new Date(s0+i*DAY),c=document.createElement('div');c.textContent=d.getUTCDate();if(i===todayIdx)c.classList.add('gtodaycol');gd.appendChild(c);}
    head.appendChild(gd);
    const hr=document.createElement('div');hr.className='gright';hr.innerHTML='<small>est · <ui-icon name="clock"></ui-icon></small>';head.appendChild(hr);
    el.appendChild(head);
    const mkRow=(n)=>{
      const row=document.createElement('div');row.className='grow';row.dataset.id=n.id;
      const lab=document.createElement('div');lab.className='glabel';lab.textContent=`#${n.id} ${n.title}`;lab.title=n.title;
      const track=document.createElement('div');track.className='gtrack';track.style.backgroundSize=(100/N)+'% 100%';
      const ps=d=>d?Date.parse(d.slice(0,10)):null;
      let bs=ps(n.start),be=ps(n.target||n.due),soft=false;
      if(bs==null&&be==null){bs=s0;be=f0;soft=true;}   // no own dates → span the sprint (hatched)
      else{if(bs==null)bs=be;if(be==null)be=bs;}        // a single date → a point bar
      if(be<bs)be=bs;
      let si=Math.round((bs-s0)/DAY),ei=Math.round((be-s0)/DAY);
      si=Math.max(0,Math.min(si,N-1));ei=Math.max(si,Math.min(ei,N-1));
      const bar=document.createElement('div');bar.className='gbar'+(soft?' soft':'');
      bar.style.left=(si/N*100)+'%';bar.style.width=((ei-si+1)/N*100)+'%';
      bar.style.backgroundColor=tyColor(n.type);
      bar.textContent=(n.priority?'P'+n.priority+' ':'')+'#'+n.id+' '+n.title;bar.title=n.title;
      bar.onclick=()=>openItem(n.id);
      track.appendChild(bar);
      if(showToday){const tl=document.createElement('div');tl.className='gtoday';tl.style.left=todayLeft+'%';track.appendChild(tl);}
      const right=document.createElement('div');right.className='gright';
      right.innerHTML=`<span>${n.est!=null?'est '+(+n.est)+'h':''}</span> <span class="gact"><ui-icon name="clock"></ui-icon> …</span>`;
      row.append(lab,track,right);return row;
    };
    if(!items.length){const e=document.createElement('div');e.className='empty';e.style.padding='12px';e.textContent=window.i18n.t('empty.noItemsMatch');el.appendChild(e);}
    else if(sprintGroup==='assignee'){
      const groups=new Map();items.forEach(n=>{const k=n.assigned||'';if(!groups.has(k))groups.set(k,[]);groups.get(k).push(n);});
      const names=[...groups.keys()].filter(k=>k).sort((a,b)=>a.localeCompare(b));if(groups.has(''))names.push('');
      names.forEach(k=>{
        const arr=groups.get(k).sort(cmpBySort);
        const ge=arr.reduce((s,n)=>s+(n.est||0),0);
        const gh=document.createElement('div');gh.className='ggroup';gh.dataset.group=k;
        gh.innerHTML=`<span>${k?htmlEsc(k):'Unassigned'} · ${arr.length}${ge?' · Σest '+(Math.round(ge*10)/10)+'h':''}</span><span class="gact"><ui-icon name="clock"></ui-icon> …</span>`;
        el.appendChild(gh);
        arr.forEach(n=>{const r=mkRow(n);r.dataset.group=k;el.appendChild(r);});
      });
    } else items.forEach(n=>el.appendChild(mkRow(n)));
    $('g_back').onclick=backToBoard;
    {const eb=$('g_editdates');if(eb)eb.onclick=()=>App.sprint.showSprintEdit(path);}
    $('g_group').onclick=()=>{sprintGroup=sprintGroup==='assignee'?'none':'assignee';
      try{localStorage.setItem('ado.sprintGroup',sprintGroup);}catch(e){}renderSprint(path);};
    annotateSprintTimes(items.map(n=>n.id),path);
    return true;
  }
  async function annotateSprintTimes(ids,path){
    if(!ids.length||ids.length>BOARD_TIME_CAP){const t=$('g_act');if(t)t.innerHTML='Σ<ui-icon name="clock"></ui-icon> —';return;}
    let t;try{t=await api.times(ids,tzOffset);}catch(e){return;}
    if(path!==openSprintPath)return;         // the open sprint changed — don't write stale times
    let tot=0;const byGroup={};
    document.querySelectorAll('#sprintview .grow[data-id]').forEach(r=>{
      const sec=t[r.dataset.id],g=r.querySelector('.gact');
      if(sec!=null){tot+=sec;if(g)g.innerHTML='<ui-icon name="clock"></ui-icon> '+hh(sec/3600);
        if(r.dataset.group!=null)byGroup[r.dataset.group]=(byGroup[r.dataset.group]||0)+sec;}
      else if(g)g.innerHTML='<ui-icon name="clock"></ui-icon> —';
    });
    document.querySelectorAll('#sprintview .ggroup[data-group]').forEach(h=>{
      const g=h.querySelector('.gact');if(g)g.innerHTML='<ui-icon name="clock"></ui-icon> '+hh((byGroup[h.dataset.group]||0)/3600);});
    const top=$('g_act');if(top)top.innerHTML='Σ<ui-icon name="clock"></ui-icon> '+hh(tot/3600);
  }
  function openSprint(path){
    if(!_sprint(path))return;
    boardScroll={l:$('board').scrollLeft,t:$('board').scrollTop};
    if(renderSprint(path)){openSprintPath=path;$('board').classList.remove('show');$('sprintview').classList.add('show');renderViewHelp();}
    else{App.sprint.showSprintEdit(path);}
  }
  function backToBoard(){
    openSprintPath=null;$('sprintview').classList.remove('show');$('board').classList.add('show');
    if(boardScroll){$('board').scrollLeft=boardScroll.l;$('board').scrollTop=boardScroll.t;}
    renderViewHelp();
  }

  App.board = { annotateBoardTimes, renderBoard, renderBoardByAssignee, renderBoardByState, boardCard, moveCard, moveCards, startCardDrag, renderSprint, annotateSprintTimes, openSprint, backToBoard };
})(window.App);

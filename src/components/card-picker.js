// Localized string helper (guarded: degrades to the English fallback if i18n not ready).
const CP_L = (k, fallback, p) => (typeof window !== 'undefined' && window.i18n) ? window.i18n.t(k, p) : fallback;

function parentCardHtml(n, isBulk){
  return `<i class="dot" style="background:${tyColor(n.type)}"></i>`+
    `<span class="pcid">#${n.id}</span><span class="pctitle">${htmlEsc(n.title||'')}</span>`+
    (n.state?`<span class="pcstate" style="background:${stateColor(n.state)}">${htmlEsc(n.state)}</span>`:'');
}

function createCardPicker(base,opts){
  opts=opts||{};
  const onChange=opts.onChange||(()=>{});
  const prov=opts.provider;
  const V=()=>$(base),Card=()=>$(base+'_card'),Pick=()=>$(base+'_pick'),
        Search=()=>$(base+'_search'),Results=()=>$(base+'_results'),Open=()=>$(base+'_open');
  let idx=0,rows=[],searchTimer=null,searchTok=0,searching=false,hasMoved=false;
  function render(){
    const vEl=V(); if(!vEl)return;
    const card=Card();
    const v=vEl.value.trim(),openBtn=Open();
    if(openBtn)openBtn.style.display=(v&&prov.openValue)?'':'none';
    if(card) {
      card.dataset.val=v;                              // lets the provider drop stale async card renders
      prov.renderCard(v,card);
    }
  }
  function set(v,silent){
    const vEl=V(); if(!vEl)return;
    vEl.value=(v==null?'':String(v));
    render();
    close();
    if(!silent)onChange();
  }
  function get(){
    const vEl=V();
    return vEl ? vEl.value.trim() : '';
  }
  function open(){
    const p=Pick(); if(!p)return;
    if(p.style.display!=='none'){close();return;}   // toggle
    p.style.display='block';
    if (window.LayerManager) window.LayerManager.open(p, null, { isPopover: true });
    const i=Search();
    if(i){
      i.value='';
      results('');
      i.focus();
    } else {
      const vEl=V();
      results(vEl ? vEl.value : '');
    }
  }
  function close(){const p=Pick();if(p){p.style.display='none';if (window.LayerManager) window.LayerManager.close(p);}}
  function isOpen(){const p=Pick();return !!p&&p.style.display!=='none';}
  function results(q){
    rows=prov.localRows(q);idx=0;hasMoved=false;
    clearTimeout(searchTimer);const tok=++searchTok;searching=false;
    const run=prov.apiExpand?prov.apiExpand(q,rows):null;   // null → no server lookup for this query
    if(run){
      searching=true;
      searchTimer=setTimeout(async()=>{
        const next=await run();
        if(tok!==searchTok)return;                   // a newer query superseded this one
        rows=next;idx=Math.max(0,Math.min(idx,rows.length-1));searching=false;draw();
      },300);
    }
    draw();
  }
  function draw(){
    const list=Results(); if(!list)return;
    list.innerHTML=rows.map((r,i)=>`<div class="prow${i===idx?' on':''}" data-i="${i}">${r.html}</div>`).join('')
      +(searching?`<div class="prow"><span class="pkind"></span><span class="ptitle pcnone">${htmlEsc(CP_L('picker.searching', 'searching…'))}</span></div>`:'');
    list.querySelectorAll('.prow[data-i]').forEach(r=>{
      r.onmousedown=e=>{e.preventDefault();idx=+r.dataset.i;pick();};
      r.onmousemove=()=>{if(idx!==+r.dataset.i){idx=+r.dataset.i;highlight();}};
    });
    const first=list.querySelector('.prow[data-i]');     // cap the visible window at ~5 rows, rest scrolls
    if(first)list.style.maxHeight=(first.offsetHeight*5)+'px';
  }
  function highlight(){
    const list=Results(); if(!list)return;
    list.querySelectorAll('.prow[data-i]').forEach(r=>r.classList.toggle('on',+r.dataset.i===idx));
  }
  function move(d){
    if(!rows.length)return;
    hasMoved=true;
    idx=(idx+d+rows.length)%rows.length;
    highlight();
    const list=Results(); if(!list)return;
    const el=list.querySelector('.prow.on');if(el)el.scrollIntoView({block:'nearest'});
  }
  function pick(){const r=rows[idx];if(!r)return;set(r.value);}
  function wire(){
    const vEl=V(); if(!vEl)return;
    const isTextInput = vEl.tagName === 'INPUT' && vEl.type === 'text';

    const card=Card();
    if(card) {
      card.onclick=open;
    } else if(isTextInput) {
      vEl.addEventListener('focus', () => {
        if (!isOpen()) open();
      });
      vEl.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!isOpen()) open();
      });
    }

    if (isTextInput) {
      vEl.addEventListener('input', e => {
        if (!isOpen()) open();
        results(e.target.value);
      });
      vEl.addEventListener('keydown', e => {
        if(e.key==='ArrowDown'){e.preventDefault(); if(!isOpen())open(); move(1);}
        else if(e.key==='ArrowUp'){e.preventDefault(); if(!isOpen())open(); move(-1);}
        else if(e.key==='Enter'){
          if (isOpen() && rows[idx]) {
            const exactMatch = rows[idx].value.toLowerCase() === vEl.value.trim().toLowerCase();
            if (hasMoved || exactMatch) {
              e.preventDefault(); e.stopImmediatePropagation(); pick();
            }
          }
        }
        else if(e.key==='Escape'){e.preventDefault(); e.stopImmediatePropagation(); close(); if(!opts.keepTextOnClose)vEl.value = ''; vEl.blur();}
      });
    }

    const s=Search();
    if(s){
      s.addEventListener('input',e=>results(e.target.value));
      s.addEventListener('keydown',e=>{
        if(e.key==='ArrowDown'){e.preventDefault();move(1);}
        else if(e.key==='ArrowUp'){e.preventDefault();move(-1);}
        else if(e.key==='Enter'){
          const rows=Rows();
          if (idx>=0 && idx<rows.length) {
            e.preventDefault();
            e.stopPropagation();
            pick();
          }
        }
        else if(e.key==='Escape'){
          e.preventDefault();
          e.stopPropagation();
          close();
          if (!opts.keepTextOnClose && e.target && e.target.type === 'text') {
            e.target.value = '';
          }
          const c=Card();if(c)c.focus();
        }
      });
    }
    const ob=Open();if(ob)ob.onclick=()=>{const v=get();if(prov.openValue)prov.openValue(v);};
    document.addEventListener('mousedown',e=>{
      const p=Pick(), c=Card(), v=V();
      if(isOpen()&&p&&!p.contains(e.target)&&(!c||!c.contains(e.target))&&(!v||!v.contains(e.target))){
        close();
        if (!opts.keepTextOnClose && v && v.type === 'text') {
          v.value = '';
        }
      }
    });
  }
  function setDisabled(d){const c=Card();if(c)c.style.pointerEvents=d?'none':'';const v=V();if(v)v.disabled=!!d;}
  return {set,get,render,open,close,isOpen,wire,setDisabled};
}

/* --- provider: parent / any work-item (id+title, with server-side search) --- */
function itemRow(n){const badge=n.state?`<span class="pbadge" style="background:${stateColor(n.state)}">${htmlEsc(n.state)}</span>`:'';
  return {value:String(n.id),html:`<i class="dot" style="background:${tyColor(n.type)}"></i><span class="ptitle">#${n.id} ${htmlEsc(n.title||'')}</span>${badge}`};}

async function itemApiSearch(term){            // look up items the local tree hasn't loaded
  const m=term.match(/^#?(\d+)$/);
  if(m){try{const it=await api.item(parseInt(m[1],10));return it?[it]:[];}catch(e){return [];}}
  try{return (await api.search({text:term}))||[];}catch(e){return [];}
}

function itemPickerProvider(getExclude){
  getExclude=getExclude||(()=>null);
  return {
    openValue(v){if(/^\d+$/.test(v))openItem(parseInt(v,10));},
    renderCard(v,card){
      const isBulk = card.id === 'bulk_parent_card';
      if(!v){
        if (isBulk) {
          card.innerHTML = `<span class="pcnone">${htmlEsc(CP_L('picker.parent.placeholder', 'Parent…'))}</span>`;
        } else {
          card.innerHTML = `<span class="pcnone">${htmlEsc(CP_L('picker.parent.none', '(no parent)'))}</span>`;
        }
        return;
      }
      const n=store.nodes[v];
      if(n && n.title){card.innerHTML=parentCardHtml(n, isBulk);return;}
      card.innerHTML=`<i class="dot" style="background:#95a5a6"></i><span class="pcid">#${v}</span>` + (!isBulk ? `<span class="pctitle pcnone">${htmlEsc(CP_L('picker.loading', 'loading…'))}</span>` : '');
      const want=v;                               // resolve the title for an item that isn't in the loaded tree
      api.item(v).then(it=>{
        if(card.dataset.val!==want)return;
        if (it) { store.nodes[it.id] = Object.assign(store.nodes[it.id] || {}, it); }
        card.innerHTML=parentCardHtml(it, isBulk);
      })
      .catch(()=>{
        if(card.dataset.val===want) {
          card.innerHTML=`<i class="dot" style="background:#95a5a6"></i><span class="pcid">#${v}</span>`;
        }
      });
    },
    localRows(q){
      q=(q||'').trim().toLowerCase();const toks=q.split(/\s+/).filter(Boolean),ex=getExclude();
      const out=[{value:'',html:`<span class="pkind">—</span><span class="ptitle pcnone">${htmlEsc(CP_L('picker.parent.none', '(no parent)'))}</span>`}];
      if(/^#?\d+$/.test(q)){const id=parseInt(q.replace('#',''),10);if(id!==ex&&!store.nodes[id])out.push({value:String(id),raw:true,html:`<span class="pkind">id</span><span class="ptitle">${htmlEsc(CP_L('picker.useId', 'Use #'+id, { id: id }))}</span>`});}
      let n=0;
      for(const node of Object.values(store.nodes)){
        if(ex!=null&&node.id===ex)continue;         // an item can't be its own parent
        const hay=('#'+node.id+' '+(node.title||'')).toLowerCase();
        if(!toks.length||toks.every(t=>hay.includes(t))){out.push(itemRow(node));if(++n>=40)break;}
      }
      return out;
    },
    apiExpand(q,rows){
      const term=(q||'').trim();
      if(!(term.length>=2||/^#?\d+$/.test(term)))return null;   // too short → local matches only
      const ex=getExclude();
      return async()=>{
        const found=await itemApiSearch(term);
        const have=new Set(rows.filter(r=>r.value&&!r.raw).map(r=>r.value)),extra=[];
        found.slice(0,30).forEach(it=>{if(!it||!it.id||it.id===ex)return;
          store.nodes[it.id]=store.nodes[it.id]||it;
          const k=String(it.id);if(!have.has(k)){extra.push(itemRow(it));have.add(k);}});
        return rows.filter(r=>!(r.raw&&have.has(r.value))).concat(extra);   // drop "Use #id" once it resolved
      };
    },
  };
}

/* --- provider: assignee / person (team roster is fully loaded in `assignees`) --- */
function personColor(name){let h=0;name=String(name);for(let i=0;i<name.length;i++)h=(h*31+name.charCodeAt(i))>>>0;return `hsl(${h%360} 52% 45%)`;}
function personInitials(name){const p=String(name).trim().split(/\s+/).filter(Boolean);return (((p[0]||'')[0]||'')+(p.length>1?(p[p.length-1][0]||''):'')).toUpperCase()||'?';}
function personChip(name){return `<i class="pav" style="background:${personColor(name)}">${htmlEsc(personInitials(name))}</i>`;}
function personChipT(name){return `<i class="pav pavsm" title="${htmlEsc(name)}" style="background:${personColor(name)}">${htmlEsc(personInitials(name))}</i>`;}   // small, tooltipped — board cards
const BLANK_IMG="data:image/svg+xml;utf8,"+encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='1' height='1'></svg>");   // transparent slot for an absent multi-background layer
// All node badges are SVG drawn into a viewBox while width/height attrs are 3×
// the logical size — the browser rasterises at 3× then cytoscape scales down:
// crisp on HiDPI, no blur. Style is light & modern: thin strokes, soft fills.
const SVGSC=3;
const BADGE_FONT="-apple-system,Segoe UI,Roboto,sans-serif";
function svgTag(w,h,body){return 'data:image/svg+xml;utf8,'+encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='${w*SVGSC}' height='${h*SVGSC}' viewBox='0 0 ${w} ${h}'>${body}</svg>`);}
function hexToRgba(hex,a){const[r,g,b]=hexToRgb(hex);return `rgba(${r},${g},${b},${a})`;}
// readable text colour for a coloured chip (dark on light fills, white on dark)
function idealText(hex){const[r,g,b]=hexToRgb(hex);return (0.299*r+0.587*g+0.114*b)>150?'#1b2330':'#ffffff';}
// flat "bookmark" ribbon (tag with a soft V-notch) carrying a short label
function bookmarkUri(color,text,dir){
  text=String(text);const fs=text.length>1?9:12,W=18,H=24;
  const path=dir==='up'
    ? `M2 ${H-1} L2 6 Q2 4 4 4 L${W-4} 4 Q${W-2} 4 ${W-2} 6 L${W-2} ${H-1} L${W/2} ${H-6} Z`
    : `M2 3 Q2 1 4 1 L${W-4} 1 Q${W-2} 1 ${W-2} 3 L${W-2} ${H-4} L${W/2} ${H-9} L2 ${H-4} Z`;
  const ty=dir==='up'?17:13;
  return svgTag(W,H,`<path d='${path}' fill='${color}'/>`+
    `<text x='${W/2}' y='${ty}' font-size='${fs}' font-family='${BADGE_FONT}' font-weight='600' fill='#ffffff' text-anchor='middle'>${htmlEsc(text)}</text>`);
}
// rounded "pill": soft tinted fill + thin same-colour border + coloured text (Excalidraw-ish)
function pillW(text,max){return Math.round(Math.min(max||150,Math.max(26,10+String(text).length*6.4)));}
function pillUri(text,color,max){const w=pillW(text,max),h=18,light=document.body.classList.contains('light');
  const fill=light?hexToRgba(color,0.16):hexToRgba(color,0.28),txt=light?color:'#ffffff';
  return svgTag(w,h,`<rect x='0.75' y='0.75' rx='${h/2}' ry='${h/2}' width='${w-1.5}' height='${h-1.5}' fill='${fill}' stroke='${color}' stroke-width='1.2'/>`+
    `<text x='${w/2}' y='${h/2+3.6}' font-size='10.5' font-family='${BADGE_FONT}' font-weight='600' fill='${txt}' text-anchor='middle'>${htmlEsc(text)}</text>`);}
const statePillW=t=>pillW(t),statePillUri=(t,c)=>pillUri(t,c);
// assignee badge: same flat bookmark in the person's colour with their initials
function avatarBadgeUri(name){return bookmarkUri(personColor(name),personInitials(name),'down');}
// "corner tag": a coloured panel flush into a node corner (two edges square, the
// node corner rounded, the inner corner rounded) — reads as part of the node,
// not a floating pill. corner: 'bl' (bottom-left) | 'tr' (top-right).
function cornerW(text,max){return Math.round(Math.min(max||120,Math.max(22,9+String(text).length*6.1)));}
// rounded-rect path with a per-corner radius [tl,tr,br,bl]
function roundRectPath(w,h,r){const[tl,tr,br,bl]=r;
  return `M${tl} 0 L${w-tr} 0 Q${w} 0 ${w} ${tr} L${w} ${h-br} Q${w} ${h} ${w-br} ${h} `+
    `L${bl} ${h} Q0 ${h} 0 ${h-bl} L0 ${tl} Q0 0 ${tl} 0 Z`;}
// "corner tag": a coloured panel flush into a node corner — the matching node
// corner is rounded and the diagonally-opposite inner corner is rounded too;
// the two edges along the node sides are square. Reads as part of the node,
// not a floating pill. corner: 'tl' | 'tr' | 'bl' | 'br'.
function cornerTagUri(text,color,corner,max){const w=cornerW(text,max),h=16,ro=8,ri=7;
  // radii [tl,tr,br,bl]: round the node corner + its diagonal (inner) corner
  const R={tl:[ro,0,ri,0],tr:[0,ro,0,ri],br:[ri,0,ro,0],bl:[0,ri,0,ro]}[corner]||[0,0,0,0];
  return {w,h,uri:svgTag(w,h,`<path d='${roundRectPath(w,h,R)}' fill='${color}'/>`+
    `<text x='${w/2}' y='${h/2+3.4}' font-size='10' font-family='${BADGE_FONT}' font-weight='600' fill='${idealText(color)}' text-anchor='middle'>${htmlEsc(text)}</text>`)};}
// node tags: parse the ";"-list, take the short name of an iteration path
function tagList_(s){return String(s||'').split(/;\s*/).map(t=>t.trim()).filter(Boolean);}
function sprintShort(path){if(!path)return '';return sprintNames[path]||String(path).split('\\').pop();}
function isOverdue(n){const d=(n.target||n.due||'').slice(0,10);return !!d&&d<new Date().toISOString().slice(0,10)&&!DONE_STATES.includes(n.state);}
// a row of small, unobtrusive tag dots (max 6, "+N" overflow) as one image
function tagDotsUri(tagsStr){const ts=tagList_(tagsStr);if(!ts.length)return null;
  const show=ts.slice(0,6),extra=ts.length-show.length,gap=8,pad=2,r=3;
  const w=pad*2+show.length*gap+(extra>0?16:0),h=10;
  let x=pad+r,dots='';
  for(const t of show){dots+=`<circle cx='${x}' cy='${h/2}' r='${r}' fill='${personColor(t)}'/>`;x+=gap;}
  if(extra>0)dots+=`<text x='${x-r+1}' y='${h/2+3}' font-size='8' font-family='${BADGE_FONT}' font-weight='600' fill='#9aa7b4' text-anchor='start'>+${extra}</text>`;
  return {uri:svgTag(w,h,dots),w};}

function assigneePeople(){const seen=new Set(),out=[];   // current user first, then the deduped roster
  [currentUser,...assignees].forEach(a=>{if(a&&!seen.has(a)){seen.add(a);out.push(a);}});return out;}

function assigneePickerProvider(){
  return {
    renderCard(v,card){
      if(!v || v === '@empty'){card.innerHTML=`<span class="pcnone">${htmlEsc(CP_L('picker.assignee.unassigned', '(unassigned)'))}</span>`;return;}
      card.innerHTML=`${personChip(v)}<span class="pctitle">${htmlEsc(v)}</span>`;
    },
    localRows(q){
      q=(q||'').trim().toLowerCase();
      const out=[{value:'@empty',html:`<i class="pav pav0"></i><span class="ptitle pcnone">${htmlEsc(CP_L('picker.assignee.unassigned', '(unassigned)'))}</span>`}];
      if(currentUser&&(!q||currentUser.toLowerCase().includes(q)))
        out.push({value:currentUser,html:`${personChip(currentUser)}<span class="ptitle">${htmlEsc(currentUser)} <span class="pcnone">· ${htmlEsc(CP_L('picker.assignee.me', 'me'))}</span></span>`});
      let n=0;
      for(const a of assigneePeople()){
        if(a===currentUser)continue;
        if(q&&!a.toLowerCase().includes(q))continue;
        out.push({value:a,html:`${personChip(a)}<span class="ptitle">${htmlEsc(a)}</span>`});
        if(++n>=40)break;
      }
      return out;
    },
    // no apiExpand — the project roster is already loaded into `assignees`
  };
}

/* --- provider: sprint / iteration (the project's dated iterations, fully cached) --- */
function sprintRoot(){return (iterCache&&iterCache[0])?iterCache[0].path.split('\\')[0]:projectName;}   // project segment = "no sprint"
function sprintRangeText(it){const s=it.start?it.start.slice(0,10):'',f=it.finish?it.finish.slice(0,10):'';return (s||f)?(s+'→'+f):'';}
function sprintPickerProvider(getNone){
  getNone=getNone||(()=>'@empty');
  function isNone(v){return !v||v===getNone()||v==='@empty';}
  return {
    renderCard(v,card){
      if(isNone(v)){card.innerHTML=`<span class="pcnone">${htmlEsc(CP_L('picker.sprint.none', '(no sprint)'))}</span>`;return;}
      const it=_sprint(v);
      if(!it){card.innerHTML=`<span class="pctitle">${htmlEsc(v.split('\\').slice(1).join('\\')||v)}</span>`;return;}
      const rt=sprintRangeText(it);
      card.innerHTML=(isCurrentSprint(it)?`<span class="curdot" title="${htmlEsc(CP_L('picker.sprint.current', 'current sprint'))}"></span>`:'')+
        `<span class="pctitle">${htmlEsc(it.name)}</span>`+(rt?`<span class="pcnone" style="flex:none">${htmlEsc(rt)}</span>`:'');
    },
    localRows(q){
      q=(q||'').trim().toLowerCase();
      const out=[{value:getNone(),html:`<span class="pkind">—</span><span class="ptitle pcnone">${htmlEsc(CP_L('picker.sprint.none', '(no sprint)'))}</span>`}];
      for(const it of (iterCache||[])){
        if(q&&!it.name.toLowerCase().includes(q))continue;
        const rt=sprintRangeText(it);
        out.push({value:it.path,html:(isCurrentSprint(it)?'<span class="curdot"></span>':'<span class="pkind"></span>')+
          `<span class="ptitle">${htmlEsc(it.name)}</span>`+(rt?`<span class="pcnone" style="flex:none; margin-left:auto;">${htmlEsc(rt)}</span>`:'')});
      }
      return out;
    },
    // no apiExpand — iterations are already cached in iterCache
  };
}

function createParentField(base,opts){opts=opts||{};return createCardPicker(base,{onChange:opts.onChange, keepTextOnClose:opts.keepTextOnClose, provider:itemPickerProvider(opts.getExcludeId)});}
function createAssigneeField(base,opts){opts=opts||{};return createCardPicker(base,{onChange:opts.onChange, keepTextOnClose:opts.keepTextOnClose, provider:assigneePickerProvider()});}
function createSprintField(base,opts){opts=opts||{};return createCardPicker(base,{onChange:opts.onChange, keepTextOnClose:opts.keepTextOnClose, provider:sprintPickerProvider(opts.getNone)});}

// Adapter on top of itemPickerProvider: hides the items already linked in the
// chosen direction and always renders the card as a "+ add" affordance (the
// picker never holds a sticky value — every pick triggers an add and resets).
function depAdderProvider(dir){
  const base=itemPickerProvider(()=>App.state.cur);
  const blocked=()=>new Set(depsArr(dir).map(Number));
  return {
    renderCard(v,card){const t=dir==='blocks'?CP_L('picker.dep.addBlocks','add a blocked link'):CP_L('picker.dep.addBlockedBy','add a blocked-by link');
      card.innerHTML=`<span class="pcnone">＋ ${htmlEsc(t)}</span>`;},
    localRows(q){const ex=blocked();return base.localRows(q).filter(r=>!r.value||!ex.has(+r.value));},
    apiExpand(q,rows){const inner=base.apiExpand(q,rows);if(!inner)return null;
      const ex=blocked();return async()=>(await inner()).filter(r=>!r.value||!ex.has(+r.value));},
  };
}

// The hidden <input> keeps the last-picked id, but renderCard always shows the
// "+ add" affordance (independent of value), so we just reset the value to ''
// after each pick — no re-render needed.
function depPickerOnChange(dir){
  return ()=>{
    const baseId='s_deps_'+(dir==='blocks'?'blocks':'blockedby');
    const v=$(baseId).value.trim();
    $(baseId).value='';
    if(!/^\d+$/.test(v)||App.state.cur==null)return;
    addDepLink(App.state.cur,parseInt(v,10),dir);
  };
}

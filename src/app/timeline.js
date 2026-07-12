// Project-wide Timeline (Gantt — one continuous axis, no sprint cut-off).
// Phase-1 view module of the App.* refactor (REFACTORING_PLAN.md): IIFE
// publishing App.timeline.render; tlDates/tlKey/tlMonths stay private. The
// constants TL_DAY/TL_PX and the shared tlLabelWidth (also driven by the column
// resizer) remain bare globals in app.js and are read here at call time, along
// with App.state.store/$/_sprint/getIterations/badgeOn/colour helpers/etc. Loads before app.js.
(function (App) {
  'use strict';

  // Effective {s,e,soft} dates (ms) for an item, or null if it has none: prefer the
  // item's own start/target, else fall back to its sprint's dates (soft=true).
  function tlDates(n){
    const p=d=>d?Date.parse(String(d).slice(0,10)):null;
    let s=p(n.start),e=p(n.target||n.due),soft=false;
    if(s==null&&e==null){const it=n.iteration?_sprint(n.iteration):null;
      if(it&&it.start&&it.finish){s=p(it.start);e=p(it.finish);soft=true;}}
    if(s==null&&e==null)return null;
    if(s==null)s=e;if(e==null)e=s;if(e<s)e=s;
    return {s,e,soft};
  }
  function tlKey(n){                                 // row group key for the current grouping
    if(App.state.tlGroup==='sprint')return n.iteration?(sprintNames[n.iteration]||String(n.iteration).split('\\').pop()):'(no sprint)';
    if(App.state.tlGroup==='state')return n.state||'(no state)';
    if(App.state.tlGroup==='assignee')return n.assigned||'Unassigned';
    if(App.state.tlGroup==='type')return n.type||'(no type)';
    return '';
  }
  function tlMonths(t0,t1){                          // month segments spanning [t0,t1]
    const out=[];let y=new Date(t0).getUTCFullYear(),m=new Date(t0).getUTCMonth();
    for(;;){const start=Date.UTC(y,m,1),end=Date.UTC(y,m+1,1)-TL_DAY;if(start>t1)break;
      const lab=new Date(start).toLocaleString(window.i18n.getLang(),{month:'short'})+(m===0?(" '"+String(y).slice(2)):'');
      out.push({start,end,label:lab});m++;if(m>11){m=0;y++;}}
    return out;
  }
  async function renderTimeline(){
    const token=++App.state.tlToken;
    const iters=await getIterations();                // for the sprint-date fallback + sprint grouping
    if(token!==App.state.tlToken)return;
    const el=$('timeline');el.innerHTML='';
    const items=App.state.store.roots.map(id=>App.state.store.nodes[id]).filter(Boolean);
    const dated=[],undated=[];
    items.forEach(n=>{const d=tlDates(n);if(d){n._tl=d;dated.push(n);}else undated.push(n);});
    if(!dated.length){
      el.innerHTML='<div class="tlempty">'+(items.length?window.i18n.t('timeline.noDatedItems',{count:items.length}):window.i18n.t('status.nothingMatches'))+'</div>';
      setStatus(`${items.length} items · 0 scheduled`+capNote());return;
    }
    let min=Infinity,max=-Infinity;dated.forEach(n=>{if(n._tl.s<min)min=n._tl.s;if(n._tl.e>max)max=n._tl.e;});
    const today=Date.parse(new Date().toISOString().slice(0,10));
    min=Math.min(min,today);max=Math.max(max,today);                          // always include today
    const ms=new Date(min),me=new Date(max);
    const r0=Date.UTC(ms.getUTCFullYear(),ms.getUTCMonth(),1);                 // start of the first month
    const r1=Date.UTC(me.getUTCFullYear(),me.getUTCMonth()+3,1)-TL_DAY;        // +2 months of future runway past the last item / today
    const px=TL_PX[App.state.tlZoom]||TL_PX.week,LW=tlLabelWidth;
    const totalDays=Math.round((r1-r0)/TL_DAY)+1,W=Math.max(Math.round(totalDays*px),200);
    const xOf=t=>Math.round(((t-r0)/TL_DAY)*px);
    const wOf=(s,e)=>Math.max(Math.round(((e-s)/TL_DAY+1)*px),6);
    // axis (month labels) + gridlines (month / week) + weekend shading + today line
    const months=tlMonths(r0,r1);
    let axis='',grid='';
    months.forEach(m=>{const l=xOf(m.start),w=Math.round(((m.end-m.start)/TL_DAY+1)*px);
      axis+=`<div class="tlmonth" style="left:${l}px;width:${w}px">${htmlEsc(m.label)}</div>`;
      grid+=`<div class="tlvline" style="left:${l}px"></div>`;});
    if(App.state.tlZoom!=='month'){let d=r0-((new Date(r0).getUTCDay()+6)%7)*TL_DAY;   // week lines (Mondays)
      for(;d<=r1;d+=7*TL_DAY)if(d>=r0)grid+=`<div class="tlvline wk" style="left:${xOf(d)}px"></div>`;}
    if(App.state.tlZoom==='day'&&totalDays<=140)for(let d=r0;d<=r1;d+=TL_DAY){const wd=new Date(d).getUTCDay();
      if(wd===0||wd===6)grid+=`<div class="tlweekend" style="left:${xOf(d)}px;width:${px}px"></div>`;}
    if(today>=r0&&today<=r1)grid+=`<div class="tltoday" style="left:${xOf(today)+Math.round(px/2)}px"></div>`;
    // second axis tier: day numbers (day zoom) or week-start dates (week zoom)
    let ticks='';
    if(App.state.tlZoom==='day'){
      for(let d=r0;d<=r1;d+=TL_DAY){const dt=new Date(d),wd=dt.getUTCDay(),cls=(d===today?' now':((wd===0||wd===6)?' we':''));
        ticks+=`<div class="tltick${cls}" style="left:${xOf(d)}px;width:${px}px">${dt.getUTCDate()}</div>`;}
    }else if(App.state.tlZoom==='week'){
      for(let d=r0-((new Date(r0).getUTCDay()+6)%7)*TL_DAY;d<=r1;d+=7*TL_DAY){if(d<r0)continue;
        const dt=new Date(d),cls=(today>=d&&today<d+7*TL_DAY)?' now':'';
        ticks+=`<div class="tltick${cls}" style="left:${xOf(d)}px;width:${Math.round(7*px)}px">${dt.getUTCDate()}</div>`;}
    }
    // rows
    const ymd=ms=>new Date(ms).toISOString().slice(0,10);
    // Timeline label: dot + #id title + optional state pill + optional assignee chip — gated by Badges (timeline).
    const showTlPrio=badgeOn('priority','timeline'),showTlState=badgeOn('state','timeline'),showTlAsg=badgeOn('assigned','timeline');
    const lab=n=>`<div class="tllabel" style="width:${LW}px"><i class="dot" style="background:${tyColor(n.type)}"></i>`+
      (showTlAsg&&n.assigned?personChipT(n.assigned):'')+
      `<span class="tllab">#${App.backend.nid(n.id)} ${htmlEsc(n.title)}</span>`+
      (showTlState&&n.state?`<span class="sbadge tlst" style="background:${stateColor(n.state)}">${htmlEsc(n.state)}</span>`:'')+
      `</div>`;
    // sp (optional) = the group's sprint window {s,e}; bars outside it are flagged.
    const rowHTML=(n,sp)=>{const t=n._tl,oos=sp&&(t.s<sp.s||t.e>sp.e);
      const tip=`${n.start?prettyDate(n.start):(t.soft?'sprint start':'?')} → ${(n.target||n.due)?prettyDate(n.target||n.due):(t.soft?'sprint finish':'?')}`+(oos?'  dates fall outside the sprint':'');
      const prefix=(showTlPrio&&n.priority)?('P'+n.priority+' '):'';
      return `<div class="tlrow${App.state.bulkSel.has(n.id)?' bulksel':''}" data-id="${n.id}">${lab(n)}<div class="tltrack" style="width:${W}px"><div class="tlbar${t.soft?' soft':''}${oos?' oos':''}" style="left:${xOf(t.s)}px;width:${wOf(t.s,t.e)}px;background-color:${tyColor(n.type)}" title="${htmlEsc(tip)}">${htmlEsc(prefix)}#${App.backend.nid(n.id)} ${htmlEsc(n.title)}</div></div></div>`;};
    const byStart=(a,b)=>(a._tl.s-b._tl.s)||(a.id-b.id);
    const groupHead=(k,arr,sp)=>{
      let label=htmlEsc(k)+' · '+arr.length,track;
      if(sp){                                          // sprint grouping: draw the sprint's own date span as a reference line
        label+=`  (${ymd(sp.s)} → ${ymd(sp.e)})`;
        track=`<div class="tlsprintspan" style="left:${xOf(sp.s)}px;width:${wOf(sp.s,sp.e)}px" title="sprint window ${prettyDate(ymd(sp.s))} → ${prettyDate(ymd(sp.e))}"></div>`;
      }else{const datedInGroup = arr.filter(n=>n._tl);
        if(datedInGroup.length){const gs=Math.min(...datedInGroup.map(n=>n._tl.s)),ge=Math.max(...datedInGroup.map(n=>n._tl.e));
          track=`<div class="tlgroupbar" style="left:${xOf(gs)}px;width:${wOf(gs,ge)}px"></div>`;}
        else{track=`<div class="tlgroupbar" style="display:none"></div>`;}}
      return `<div class="tlgrouprow"><div class="tlgrouplabel" style="width:${LW}px">${label}</div><div class="tlgrouptrack" style="width:${W}px">${track}</div></div>`;};
    let rows='';
    if(App.state.tlGroup==='none'){
      dated.sort(byStart).forEach(n=>{rows+=rowHTML(n);});
      if(undated.length){
        rows+=`<div class="tlgrouprow"><div class="tlgrouplabel" style="width:${LW}px">No dates · ${undated.length}</div><div class="tlgrouptrack" style="width:${W}px"></div></div>`;
        undated.sort((a,b)=>a.id-b.id).forEach(n=>{rows+=`<div class="tlrow${App.state.bulkSel.has(n.id)?' bulksel':''}" data-id="${n.id}">${lab(n)}<div class="tltrack" style="width:${W}px"><span class="tlnodate">— no dates —</span></div></div>`;});
      }
    }else{
      const groups=new Map();
      items.forEach(n=>{const k=tlKey(n);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(n);});
      let keys=[...groups.keys()];keys=(App.state.tlGroup==='state')?orderStates(keys):keys.sort((a,b)=>a.localeCompare(b));
      keys.forEach(k=>{
        const arr=groups.get(k);
        const gDated=arr.filter(n=>n._tl).sort(byStart);
        const gUndated=arr.filter(n=>!n._tl).sort((a,b)=>a.id-b.id);
        let sp=null;
        if(App.state.tlGroup==='sprint'&&gDated.length){const it=_sprint(gDated[0].iteration);if(it&&it.start&&it.finish)sp={s:Date.parse(it.start.slice(0,10)),e:Date.parse(it.finish.slice(0,10))};}
        rows+=groupHead(k,arr,sp);
        gDated.forEach(n=>{rows+=rowHTML(n,sp);});
        gUndated.forEach(n=>{rows+=`<div class="tlrow${App.state.bulkSel.has(n.id)?' bulksel':''}" data-id="${n.id}">${lab(n)}<div class="tltrack" style="width:${W}px"><span class="tlnodate">— no dates —</span></div></div>`;});
      });
    }
    const prevScroll=el.scrollLeft;                  // preserve horizontal scroll across re-renders
    el.innerHTML=`<div class="tlcanvas">`+
      `<div class="tlhead"><div class="tlcorner" style="width:${LW}px">${months.length} mo · ${dated.length} scheduled<div class="tl-col-resizer"></div></div><div class="tlaxis" style="width:${W}px">${axis}${ticks}</div></div>`+
      `<div class="tlbody"><div class="tlgrid" style="left:${LW}px;width:${W}px">${grid}</div>${rows}</div></div>`;
    setStatus(`${dated.length} scheduled · ${undated.length} no dates`+capNote());
    if(prevScroll>0)el.scrollLeft=prevScroll;        // keep the user's position on a re-render
    else if(today>=r0&&today<=r1)el.scrollLeft=Math.max(0,xOf(today)-Math.round(el.clientWidth*0.35));   // first paint: centre on today
  }

  App.timeline = { render: renderTimeline };
})(window.App);

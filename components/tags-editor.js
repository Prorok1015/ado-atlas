const tagsEditor=(function(){let cur=[],adding=false,committing=false;
  const norm=s=>String(s||'').split(/[;,]/).map(t=>t.trim()).filter(Boolean);
  const uniq=a=>{const seen=new Set(),o=[];a.forEach(t=>{const k=t.toLowerCase();if(!seen.has(k)){seen.add(k);o.push(t);}});return o;};
  // User-initiated tag mutations auto-save via quickSave('tags'); set() skips
  // it (item load shouldn't fire a PATCH).
  function touched(){refreshDirty();quickSave('tags');}
  function commit(v){const a=norm(v);if(a.length){cur=uniq(cur.concat(a));touched();}}
  function render(){const box=$('s_tags');
    let html=cur.map((t,i)=>`<span class="tagchip" style="background:${personColor(t)}">${esc(t)}<b data-i="${i}" title="remove">×</b></span>`).join('');
    if(!cur.length&&!adding)html='<span class="pcnone">no tags</span>';
    html+=adding
      ? `<input id="s_taginp" class="taginp" list="tagsdl" placeholder="tag…" autocomplete="off"><button type="button" id="s_tagok" class="tagok" title="add tag">✓</button>`
      : `<button type="button" class="tagadd" id="s_tagplus" title="add a tag">＋</button>`;
    box.innerHTML=html;
    box.querySelectorAll('b[data-i]').forEach(x=>{
      x.onmousedown=e=>e.preventDefault();
      x.onclick=()=>{committing=true;cur.splice(+x.dataset.i,1);render();committing=false;touched();};
    });
    if(adding){const inp=$('s_taginp'),ok=$('s_tagok');inp.focus();
      function doCommit(){committing=true;commit(inp.value);inp.value='';render();adding=true;const ni=$('s_taginp');if(ni)ni.focus();committing=false;}
      ok.onmousedown=e=>e.preventDefault();
      ok.onclick=doCommit;
      inp.addEventListener('keydown',e=>{
        if(e.key==='Enter'||e.key===','){e.preventDefault();doCommit();}
        else if(e.key==='Escape'){e.preventDefault();e.stopPropagation();adding=false;render();}
        else if(e.key==='Backspace'&&!inp.value&&cur.length){committing=true;cur.pop();render();adding=true;const ni=$('s_taginp');if(ni)ni.focus();committing=false;touched();}});
      inp.addEventListener('change',()=>{if(inp.value.trim())doCommit();});
      inp.addEventListener('blur',()=>{if(!committing){commit(inp.value);adding=false;render();}});
    }else{const p=$('s_tagplus');if(p)p.onclick=()=>{adding=true;render();};}
  }
  return {render,
    add(s){commit(s);render();},
    set(s,silent){cur=uniq(norm(s));adding=false;render();if(!silent)refreshDirty();},
    value(){return cur.join('; ');}};
})();

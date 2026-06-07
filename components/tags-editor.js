const tagsEditor=(function(){let cur=[],adding=false,committing=false,disabled=false;
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
      ? `<span class="tagadd-wrap" style="display:inline-flex;align-items:center;gap:4px;">
           <span class="f-dropdown-container">
             <input id="s_taginp" class="taginp" placeholder="tag…" autocomplete="off">
             <div id="s_tag_dropdown" class="f-dropdown" style="display:none"></div>
           </span>
           <button type="button" id="s_tagok" class="tagok" title="add tag">✓</button>
         </span>`
      : `<button type="button" class="tagadd" id="s_tagplus" title="add a tag">＋</button>`;
    box.innerHTML=html;
    box.querySelectorAll('b[data-i]').forEach(x=>{
      x.onmousedown=e=>e.preventDefault();
      x.onclick=()=>{committing=true;cur.splice(+x.dataset.i,1);render();committing=false;touched();};
    });
    if(adding){const inp=$('s_taginp'),ok=$('s_tagok');
      const dropdown=$('s_tag_dropdown');
      const showMatches=(q)=>{
        const query=q.toLowerCase().trim();
        const shownSet=new Set(cur.map(t=>t.toLowerCase()));
        const matches=(typeof tagList!=='undefined'?tagList:[]).filter(v=>{
          if(shownSet.has(v.toLowerCase()))return false;
          return v.toLowerCase().includes(query);
        });
        dropdown.innerHTML='';
        if(!matches.length){
          const empty=document.createElement('div');
          empty.className='f-dropdown-item empty';
          empty.textContent='No matches';
          dropdown.appendChild(empty);
        } else {
          matches.forEach(val=>{
            const item=document.createElement('div');
            item.className='f-dropdown-item';
            item.textContent=val;
            item.onmousedown=(e)=>{
              e.preventDefault();
              committing=true;
              commit(val);
              dropdown.style.display='none';
              render();
              adding=true;
              const ni=$('s_taginp');if(ni)ni.focus();
              committing=false;
            };
            dropdown.appendChild(item);
          });
        }
        dropdown.style.display='flex';
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
      inp.addEventListener('focus',()=>showMatches(inp.value));
      inp.addEventListener('input',()=>showMatches(inp.value));
      function doCommit(){committing=true;commit(inp.value);inp.value='';render();adding=true;const ni=$('s_taginp');if(ni)ni.focus();committing=false;}
      ok.onmousedown=e=>e.preventDefault();
      ok.onclick=doCommit;
      inp.addEventListener('keydown',e=>{
        if(e.key==='Enter'||e.key===','){e.preventDefault();doCommit();}
        else if(e.key==='Escape'){e.preventDefault();e.stopPropagation();adding=false;render();}
        else if(e.key==='Backspace'&&!inp.value&&cur.length){committing=true;cur.pop();render();adding=true;const ni=$('s_taginp');if(ni)ni.focus();committing=false;touched();}});
      inp.addEventListener('change',()=>{if(inp.value.trim())doCommit();});
      inp.addEventListener('blur',()=>{if(!committing){commit(inp.value);adding=false;render();}});
      inp.focus();
      showMatches(inp.value);
    }else{const p=$('s_tagplus');if(p)p.onclick=()=>{adding=true;render();};}
    if(disabled){box.querySelectorAll('button').forEach(b=>b.disabled=true);box.style.pointerEvents='none';}else{box.style.pointerEvents='';}
  }
  function setDisabled(d){disabled=!!d;const box=$('s_tags');if(box){box.style.pointerEvents=d?'none':'';box.querySelectorAll('button').forEach(b=>b.disabled=d);}}
  return {render,setDisabled,
    add(s){commit(s);render();},
    set(s,silent){cur=uniq(norm(s));adding=false;render();if(!silent)refreshDirty();},
    value(){return cur.join('; ');}};
})();

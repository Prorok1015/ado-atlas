// @mention typeahead (description/comment editors) + full-screen editor toggle.
// Relocated from app.js (bare, no IIFE) as batch A2 of the side-panel refactor.
// markdown-editor.js calls openOrUpdateMention/closeMention/scheduleCloseMention/
// pickMention/moveMention bare and reads mentionState directly, so these MUST
// stay bare — pure relocation, zero call-site churn. toggleFullscreen is called
// bare from app.js (openItem wiring / closePanel / initialBoot). Relies on other
// bare globals resolved at call time: $, api, window.i18n, App.state.activeEditor,
// App.state.descEditor, App.state.cy, window.LayerManager, htmlEsc.
/* @mention typeahead: opens when the caret follows "@xxx" (no whitespace).
   Click / Enter inserts `@[Display](descriptor)` in markdown form, which
   mdToHtml then renders as an ADO mention anchor. */
const mentionState={open:false,query:'',start:-1,rows:[],idx:0,tok:0};
let mentionDebounceTimeout = null;
function findMentionTrigger(ta){
  const pos=ta.selectionStart;
  // Walk backward for an "@" with no whitespace or bracketing in between.
  // Stopping on [ ] ( ) prevents a freshly-inserted "@[Name](descriptor)" from
  // re-triggering the popup once the caret lands after the closing ).
  const v=ta.value;let i=pos-1;
  while(i>=0){
    const ch=v[i];
    if(ch==='@'){
      const prev=i>0?v[i-1]:'';
      // Trigger only when @ starts a token (after whitespace/punct/start).
      if(i===0||/\s|[(,;:.]/.test(prev))return {at:i,query:v.slice(i+1,pos)};
      return null;
    }
    if(ch==='\n'||ch===' '||ch==='\t'||ch==='['||ch===']'||ch==='('||ch===')')return null;
    if(pos-i>40)return null;             // give up after 40 chars without @
    i--;
  }
  return null;
}
let closeMentionTimeout = null;
function scheduleCloseMention(){
  if(closeMentionTimeout) clearTimeout(closeMentionTimeout);
  closeMentionTimeout = setTimeout(closeMention, 150);
}
function closeMention(){
  if(closeMentionTimeout){clearTimeout(closeMentionTimeout);closeMentionTimeout=null;}
  if(mentionDebounceTimeout){clearTimeout(mentionDebounceTimeout);mentionDebounceTimeout=null;}
  const p=$('s_mention');if(p){
    p.style.display='none';
    if (window.LayerManager) window.LayerManager.close(p);
  }
  mentionState.open=false;mentionState.query='';mentionState.start=-1;mentionState.rows=[];
}
function drawMention(){
  const p=$('s_mention');if(!p)return;
  if(!mentionState.rows.length){p.innerHTML='<div class="mempty">no matches — keep typing</div>';return;}
  p.innerHTML=mentionState.rows.map((r,i)=>
    `<div class="mrow${i===mentionState.idx?' on':''}" data-i="${i}">`+
      `<span class="mname">${htmlEsc(r.displayName)}${r.isGroup?' <span class="pcnone">(group)</span>':''}</span>`+
      (r.mail?`<span class="mmail">${htmlEsc(r.mail)}</span>`:'')+
    `</div>`).join('');
  p.querySelectorAll('.mrow').forEach(r=>{
    r.onmousedown=e=>{e.preventDefault();mentionState.idx=+r.dataset.i;pickMention();};
    r.onmouseenter=()=>{
      mentionState.idx=+r.dataset.i;
      p.querySelectorAll('.mrow').forEach((el, idx) => {
        el.classList.toggle('on', idx === mentionState.idx);
      });
    };
  });
}
function getCaretCoordinates(element, position) {
  const div = document.createElement('div');
  document.body.appendChild(div);

  const style = div.style;
  const computed = window.getComputedStyle(element);

  style.whiteSpace = 'pre-wrap';
  style.wordWrap = 'break-word';
  style.position = 'absolute';
  style.visibility = 'hidden';

  const properties = [
    'direction', 'boxSizing', 'width', 'height', 'overflowX', 'overflowY',
    'borderStyle', 'borderWidth', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontSize',
    'lineHeight', 'fontFamily', 'textAlign', 'textTransform', 'textIndent',
    'textDecoration', 'letterSpacing', 'wordSpacing'
  ];

  properties.forEach(prop => {
    style[prop] = computed[prop];
  });

  div.textContent = element.value.substring(0, position);

  const span = document.createElement('span');
  span.textContent = element.value.substring(position) || '.';
  div.appendChild(span);

  const lh = parseInt(computed.lineHeight || 0);
  const coordinates = {
    top: span.offsetTop + parseInt(computed.borderTopWidth || 0),
    left: span.offsetLeft + parseInt(computed.borderLeftWidth || 0),
    height: !isNaN(lh) && lh > 0 ? lh : (span.offsetHeight || 16)
  };

  document.body.removeChild(div);
  return coordinates;
}
function positionMention(){
  if(!App.state.activeEditor)return;
  const ta=App.state.activeEditor.textarea,p=$('s_mention');if(!ta||!p)return;
  
  if (p.parentNode !== App.state.activeEditor.container) {
    App.state.activeEditor.container.appendChild(p);
  }

  const caretPos=mentionState.start;
  const coords=getCaretCoordinates(ta,caretPos);
  const r=ta.getBoundingClientRect(),cr=App.state.activeEditor.container.getBoundingClientRect();
  
  const pWidth=p.offsetWidth||220;
  const maxLeft=r.right-cr.left-pWidth-8;
  const computedLeft=r.left-cr.left+coords.left-ta.scrollLeft;
  const left=Math.max(r.left-cr.left+8,Math.min(computedLeft,maxLeft));
  const top=r.top-cr.top+coords.top+coords.height-ta.scrollTop+4;
  
  p.style.left=left+'px';
  p.style.top=top+'px';
  p.style.maxWidth=r.width+'px';
}
async function openOrUpdateMention(){
  if(closeMentionTimeout){clearTimeout(closeMentionTimeout);closeMentionTimeout=null;}
  if(mentionDebounceTimeout){clearTimeout(mentionDebounceTimeout);mentionDebounceTimeout=null;}
  if(!App.state.activeEditor)return;
  const ta=App.state.activeEditor.textarea;if(!ta)return;
  const trig=findMentionTrigger(ta);
  if(!trig){closeMention();return;}
  mentionState.start=trig.at;mentionState.query=trig.query;mentionState.open=true;
  
  let p=$('s_mention');
  if (!p) {
    p = document.createElement('div');
    p.id = 's_mention';
    p.className = 'mention-pop';
    p.style.display = 'none';
    App.state.activeEditor.container.appendChild(p);
  }
  
  p.style.display='block';
  if (window.LayerManager) window.LayerManager.open(p, null, { isPopover: true });
  positionMention();
  const tok = ++mentionState.tok;
  if(!trig.query){
    let rows=[];
    try{rows=await api.searchIdentities("",20);}catch(e){rows=[];}
    if(tok!==mentionState.tok||!mentionState.open)return;
    mentionState.rows=rows;mentionState.idx=0;drawMention();
    return;
  }
  
  mentionDebounceTimeout = setTimeout(async () => {
    let rows=[];
    try{rows=await api.searchIdentities(trig.query,20);}catch(e){rows=[];}
    if(tok!==mentionState.tok||!mentionState.open)return;
    mentionState.rows=rows;mentionState.idx=0;drawMention();
  }, 150);
}
function pickMention(){
  if(!App.state.activeEditor)return;
  const r=mentionState.rows[mentionState.idx];if(!r)return;
  const ta=App.state.activeEditor.textarea,pos=ta.selectionStart,v=ta.value;
  
  let vsid = r.id || "";
  
  if (vsid.includes('.')) {
     vsid = vsid.split('.').pop();
  }
  
  if (/^[a-f0-9]{32}$/i.test(vsid)) {
     vsid = `${vsid.slice(0, 8)}-${vsid.slice(8, 12)}-${vsid.slice(12, 16)}-${vsid.slice(16, 20)}-${vsid.slice(20)}`;
  }
  
  const md = vsid ? `@[${r.displayName}](${vsid})` : `@${r.displayName}`;

  ta.value=v.slice(0,mentionState.start)+md+v.slice(pos);
  const at=mentionState.start+md.length;
  ta.selectionStart=ta.selectionEnd=at;
  closeMention();
  App.state.activeEditor.fireChange();
}
function moveMention(d){if(!mentionState.rows.length)return;
  mentionState.idx=(mentionState.idx+d+mentionState.rows.length)%mentionState.rows.length;
  drawMention();
}



/* ---------- full-screen editor toggle ---------- */
let _sideWidthBeforeFs='';
function toggleFullscreen(force){
  const side=$('side');
  const on=force===true||force===false?force:!side.classList.contains('fullscreen');
  let backdrop = document.getElementById('s_side_backdrop');
  if(on){
    if (!backdrop) {
      backdrop = document.createElement('div');
      backdrop.id = 's_side_backdrop';
      backdrop.className = 'modal-backdrop sidebar-backdrop';
      backdrop.onclick = () => toggleFullscreen(false);
      document.body.appendChild(backdrop);
    }
    // The user's inline width (from dragging #resizer) overrides the .fullscreen
    // class's `width: auto`. Stash it and clear so the panel fills the viewport,
    // then restore on exit.
    _sideWidthBeforeFs=side.style.width||'';
    side.style.width='';
    
    if (window.LayerManager) {
      window.LayerManager.open(side, backdrop);
    }
  } else {
    if (window.LayerManager) {
      window.LayerManager.close(side);
    }
    if (backdrop) {
      backdrop.remove();
    }
    if(_sideWidthBeforeFs){
      side.style.width=_sideWidthBeforeFs;
      _sideWidthBeforeFs='';
    }
  }
  side.classList.toggle('fullscreen',on);
  if(App.state.cy)try{App.state.cy.resize();}catch(e){}
}

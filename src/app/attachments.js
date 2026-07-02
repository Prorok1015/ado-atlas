// Attachments panel + description-preview image hydration + @mention coloring.
// Relocated from app.js (bare, no IIFE) as batch A1 of the side-panel refactor.
// Kept as bare globals in the shared script scope: markdown-editor.js and
// activity.js call descRenderOpts/hydratePreviewImages/colorMentions/renderAttachments
// bare, and read atchState directly — so these MUST stay bare. Relies on other
// bare globals resolved at call time: $, api, setStatus, htmlEsc, customConfirm,
// window.i18n, App.state.cur, App.state.descEditor, personColor, refreshDirty, App.state.openItemAbortCtrl.
// Description-preview renderer uses the project's work-item base URL so that
// `#123` shorthand in the markdown gets auto-linked back to that work item.
// descBase is derived from the open item's url (set by api.item()) — that way
// we don't have to know org/project here.
let descBase='';
function descRenderOpts(){return {workItemBase:descBase};}
// ADO attachment URLs require an Authorization header that the browser doesn't
// send for plain <img src=...>, so we fetch each one through the API helper and
// swap the src to a blob: URL. Cache keyed by attachment URL; revoked on item
// switch so memory doesn't grow without bound.
const attBlobs=new Map();
function isAdoAttachmentUrl(u){return /^https:\/\/[^/]+\/.+\/_apis\/wit\/attachments\/[^/?#]+/.test(u||'');}
function clearAttBlobs(){
  const urls=Array.from(attBlobs.values());
  attBlobs.clear();
  setTimeout(()=>{
    for(const u of urls)try{URL.revokeObjectURL(u);}catch(e){}
  },1000);
}
async function hydratePreviewImages(container){
  const pv=container||$('s_desc_prev');if(!pv)return;
  const imgs=Array.from(pv.querySelectorAll('img[data-src], img[src]'));
  const signal=App.state.openItemAbortCtrl?.signal;
  for(const img of imgs){
    if(signal?.aborted)return;
    // Prefer data-src (set by renderPreview to avoid unauthenticated browser fetch)
    const src=img.getAttribute('data-src')||img.getAttribute('src');
    if(!isAdoAttachmentUrl(src))continue;
    const cached=attBlobs.get(src);
    if(cached){img.src=cached;img.removeAttribute('data-src');continue;}
    try{
      const blob=await api.fetchAttachmentBlob(src,{signal});
      const blobUrl=URL.createObjectURL(blob);
      attBlobs.set(src,blobUrl);
      // Preview may have been re-rendered (or the user may have closed the panel)
      // by the time the blob arrives — only patch the element if it's still in the DOM.
      if(img.isConnected && !(signal?.aborted)){img.src=blobUrl;img.removeAttribute('data-src');}
    }catch(e){
      if(e.name==='AbortError')return;
      img.alt=(img.alt||'')+' [failed to load: '+e.message+']';
      img.style.opacity='.4';
    }
  }
}
function colorMentions(container){
  if(!container)return;
  const links=container.querySelectorAll('a[data-vss-mention]');
  links.forEach(a=>{
    const name=a.textContent.replace(/^@/,'').trim();
    if(!name)return;
    const baseColor=personColor(name);
    const bg=baseColor.replace('hsl','hsla').replace(')',', 0.12)');
    a.style.color=baseColor;
    a.style.background=bg;
  });
}

/* ---------- attachments + paste/drop + @mention typeahead (description editor) ----------
   atchState mirrors the AttachedFile relations for the open item. Add/remove are
   PATCHes against the work item's relations; uploads use the project attachments
   endpoint. Pasting an image into s_desc uploads it, links it, and inserts an
   image markdown at the caret in one shot. */
const atchState={list:[],wid:null,uploading:0};
function fmtBytes(n){if(n==null)return '';if(n<1024)return n+' B';if(n<1048576)return (n/1024).toFixed(1)+' K';return (n/1048576).toFixed(1)+' M';}
function isImageName(n){return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(n||'');}
function isImageMime(t){return /^image\//.test(t||'');}
function renderAttachments(){
  const box=$('s_atch');if(!box)return;
  const group=$('s_atch_group');
  const arr=atchState.list||[];
  if(App.state.cur==null || (group && group.classList.contains('sg-hidden'))){
    if(group)group.style.display='none';
    box.innerHTML='';
    return;
  }
  if(group)group.style.display='block';
  if(!arr.length&&!atchState.uploading){
    box.innerHTML=`<div class="atch-empty">${htmlEsc(window.i18n.t('attach.dropHere'))}</div>`;
    return;
  }
  const head=`<div class="atchhead"><span class="acount">${arr.length}</span> file(s)`+
    (atchState.uploading?` · <span class="spin"></span> uploading ${atchState.uploading}…`:'')+`</div>`;
  const rows=arr.map((a,i)=>{
    const icon=isImageName(a.name)?'<ui-icon name="image"></ui-icon>':'<ui-icon name="file-text"></ui-icon>';
    const size=a.size!=null?fmtBytes(a.size):'';
    return `<div class="atchrow" data-i="${i}">`+
      `<span class="aico">${icon}</span>`+
      `<a class="aname" href="#" title="${htmlEsc(a.url)}">${htmlEsc(a.name)}</a>`+
      (size?`<span class="asize">${size}</span>`:'')+
      `<button class="ains" title="insert ${isImageName(a.name)?'image':'link'} into the description"><ui-icon name="corner-down-left"></ui-icon> insert</button>`+
      `<button class="axdel" title="remove attachment"><ui-icon name="x"></ui-icon></button>`+
      `</div>`;
  }).join('');
  box.innerHTML=head+rows;
  box.querySelectorAll('.atchrow').forEach(row=>{
    const i=+row.dataset.i,a=arr[i];
    row.querySelector('.aname').onclick=async e=>{
      e.preventDefault();
      try{
        setStatus('downloading '+a.name+'…');
        const blob=await api.fetchAttachmentBlob(a.url);
        const url=URL.createObjectURL(blob);
        const link=document.createElement('a');
        link.href=url;
        link.download=a.name;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        setStatus('downloaded '+a.name);
      }catch(err){
        setStatus('download failed: '+err.message,true);
      }
    };
    row.querySelector('.ains').onclick=e=>{e.preventDefault();if(App.state.descEditor){App.state.descEditor.insertAtCursor((isImageName(a.name)?'!':'')+`[${a.name}](${a.url})`);refreshDirty();}};
    row.querySelector('.axdel').onclick=e=>{e.preventDefault();removeAttachment(a);};
  });
}
async function removeAttachment(a){
  if(App.state.cur==null)return;
  const wid=App.state.cur;
  if(!await customConfirm(window.i18n.t('attach.removeConfirm', {name:a.name}), window.i18n.t('attach.removeTitle')))return;
  try{
    const res=await api.removeAttachmentLink(wid,a.url);
    if(App.state.cur===wid){atchState.list=res.attachments||[];renderAttachments();}
    setStatus('#'+wid+' detached '+a.name);
  }catch(e){setStatus('detach failed: '+e.message,true);}
}

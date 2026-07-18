// Setup / connection flow: the setup modal (replaces the old /setup page), the
// org/project picker that runs after a PAT is pasted, and the PAT-expiry
// countdown badges. Phase-1 feature module of the App.* refactor
// (REFACTORING_PLAN.md): IIFE publishing App.setup; internal helpers stay
// private. Security-sensitive (OAuth + PAT) — logic is a verbatim, behavior-
// preserving move from app.js.
//
// Reads bare globals at call time (still declared in app.js / lib.js, loaded
// after this module): $, api, currentUser, projectName, htmlEsc, AdoLib, App.state.cur,
// dirty, setStatus, initialBoot, syncSetupExpiryPicker, window.LayerManager.
//
// Two module-local state vars used by the boot wiring in app.js (setupAuthMode,
// patAutoTimer) intentionally STAY in app.js as bare globals; setAuthPane() and
// the picker functions read/write them as bare globals at call time.
//
// Already-extracted siblings are namespaced where called (none in this section).
// Loads before app.js.
(function (App) {
  'use strict';

  /* ---------- setup modal (replaces /setup page) ---------- */
  // setupAuthMode (which auth pane is active) stays a bare global in app.js —
  // the boot wiring reads it directly.
  function setAuthPane(mode){
    setupAuthMode=(mode==='oauth')?'oauth':'pat';
    $('auth-pat').style.display=setupAuthMode==='pat'?'block':'none';
    $('auth-oauth').style.display=setupAuthMode==='oauth'?'block':'none';
    $('auth-mode').querySelectorAll('button').forEach(b=>b.classList.toggle('on',b.dataset.am===setupAuthMode));
  }
  function oauthTenantValue(){   // resolve the tenant dropdown (preset name or the custom GUID)
    const m=$('oauth-tenant-mode').value;
    return m==='custom'?$('oauth-tenant-id').value.trim():m;
  }
  function updateTenantField(){
    $('oauth-tenant-id').style.display=$('oauth-tenant-mode').value==='custom'?'block':'none';
  }
  async function doOauthSignIn(){
    const cid=$('oauth-client').value.trim(),tenant=oauthTenantValue();
    if(!cid){$('oauth-status').textContent=window.i18n.t('setup.oauth.enterClient', 'Enter the Application (client) ID first.');return;}
    const btn=$('oauth-signin');btn.disabled=true;btn.textContent=window.i18n.t('setup.oauth.signingIn', 'Signing in…');$('setup-err').textContent='';$('oauth-status').textContent='';
    try{
      const name=await api.oauthSignIn(cid,tenant);
      currentUser=name||'';
      $('oauth-status').innerHTML=name?('<ui-icon name="check"></ui-icon> ' + window.i18n.t('setup.oauth.signedInAs', 'Signed in as {name}', {name: htmlEsc(name)})):'<ui-icon name="check"></ui-icon> ' + window.i18n.t('setup.oauth.signedIn', 'Signed in');
      await loadSetupOrgs();                // populate org/project from the signed-in account
    }catch(e){
      $('oauth-status').textContent=window.i18n.t('setup.oauth.signInFailed', 'Sign-in failed: {error}', {error: e.message});
    }finally{ btn.disabled=false;btn.textContent=window.i18n.t('setup.oauth.signInWithMicrosoft', 'Sign in with Microsoft'); }
  }
  function showSetup(cancellable){
    $('setup-load-hint').innerHTML=window.i18n.t('setup.hintHtml', 'Paste a PAT, then fill in your Organization and Project (both are in your dev.azure.com/&lt;org&gt;/&lt;project&gt; URL). The project list fills in automatically once the org is set.');
    try{$('oauth-redirect').value=api.oauthRedirectUri();}catch(e){$('oauth-redirect').value=window.i18n.t('setup.oauth.availableOnceLoaded', '(available once the extension is loaded)');}
    const cfg=api.getConfig();   // promise — fill async
    cfg.then(c=>{
      $('setup-pat').value=c.pat||'';$('setup-org').value=c.org||'';$('setup-project').value=c.project||'';
      const expiry = c.patExpiry||'';
      $('setup-expiry').value=expiry;
      syncSetupExpiryPicker(expiry);
      updateSetupExpiryInfo();
      $('oauth-client').value=c.oauthClientId||'';
      const t=c.oauthTenant||'organizations';
      if(t==='organizations'){$('oauth-tenant-mode').value='organizations';$('oauth-tenant-id').value='';}
      else{$('oauth-tenant-mode').value='custom';$('oauth-tenant-id').value=t;}
      updateTenantField();
      setAuthPane(c.authMode==='oauth'?'oauth':'pat');
      $('oauth-status').innerHTML=(c.authMode==='oauth'&&c.oauthAccess)?(currentUser?('<ui-icon name="check"></ui-icon> '+window.i18n.t('setup.oauth.signedInAs', 'Signed in as {name}', {name: htmlEsc(currentUser)})):'<ui-icon name="check"></ui-icon> '+window.i18n.t('setup.oauth.signedIn', 'Signed in')):'';
      const signedIn=(c.authMode==='oauth')?!!c.oauthAccess:!!c.pat;
      if(c.org&&signedIn)loadSetupProjects();   // reopening settings: populate the project dropdown for the saved org
    });
    $('setup-err').textContent='';
    $('setup-cancel').style.display=cancellable?'inline-block':'none';
    const overlay = $('setup-overlay');
    overlay.classList.add('show');
    if (window.LayerManager) {
      window.LayerManager.open(overlay);
    }
  }
  function hideSetup(){
    const overlay = $('setup-overlay');
    overlay.classList.remove('show');
    if (window.LayerManager) {
      window.LayerManager.close(overlay);
    }
  }

  // api.js dispatches 'ado-401' on any HTTP 401 — the PAT expired or was revoked
  // mid-session. Reopen setup with a clear message instead of spraying errors.
  function handle401(){
    if($('setup-overlay').classList.contains('show'))return;   // already prompting — don't stack
    showSetup(true);
    $('setup-err').textContent=window.i18n.t('setup.authFailed', 'Authentication failed (HTTP 401) — your token/session is invalid. Re-connect below')
      +((App.state.cur!=null&&dirty())?window.i18n.t('setup.unsavedPreserved', ' (your unsaved changes to #{id} are preserved).', {id: App.state.cur}):'.');
  }
  // One-time nudge when the recorded PAT expiry is within 3 days (or already past).
  async function warnIfPatExpiring(){
    let exp='';try{exp=(await api.getConfig()).patExpiry||'';}catch(e){}
    const n=patDaysLeft(exp);
    if(n===null||n>3)return;
    setStatus(n<0?`<ui-icon name="alert-triangle"></ui-icon> ${window.i18n.t('setup.pat.expiredDaysAgo', 'PAT expired {n} day(s) ago — update it via settings', {n: -n})}`
                 :(n===0?`<ui-icon name="alert-triangle"></ui-icon> ${window.i18n.t('setup.pat.expiresToday', 'PAT expires today — update it via settings')}`:`<ui-icon name="alert-triangle"></ui-icon> ${window.i18n.t('setup.pat.expiresInDays', 'PAT expires in {n} day(s) — update it via settings', {n: n})}`),true);
  }

  /* ---------- setup picker: list the orgs / projects a PAT can access ----------
     Lets the user CHOOSE an org/project after pasting a PAT instead of typing.
     Both calls can legitimately fail for a narrowly-scoped PAT, so the inputs
     stay free-text and we just fall back to manual entry on error. */
  const SETUP_HINT = '';
  // patAutoTimer (debounce for auto-loading org/project after a PAT is pasted)
  // stays a bare global in app.js — the boot wiring sets/clears it directly.
  let _loadingOrgs=false;
  function fillDatalist(id,items){
    const dl=$(id);if(!dl)return;
    dl.innerHTML=(items||[]).map(v=>`<option value="${String(v).replace(/"/g,'&quot;')}"></option>`).join('');
  }
  async function loadSetupOrgs(){
    if(setupAuthMode==='pat'&&!$('setup-pat').value.trim()){$('setup-err').textContent=window.i18n.t('setup.pastePatFirst', 'Paste a PAT first.');return;}
    if(_loadingOrgs)return;_loadingOrgs=true;
    const btn=$('setup-load');if(btn){btn.disabled=true;btn.textContent=window.i18n.t('common.loading', 'Loading…');}$('setup-err').textContent='';
    try{
      if(setupAuthMode==='pat')await api.setConfig({authMode:'pat',pat:$('setup-pat').value.trim()});   // persist so the API can authenticate
      const list=await api.orgs();
      fillDatalist('setup-orglist',list);
      if(list.length){
        $('setup-load-hint').textContent=window.i18n.t('setup.foundOrgs', 'Found {count} organization(s) — pick one, then choose a project.', {count: list.length});
        if(!$('setup-org').value.trim()&&list.length===1)$('setup-org').value=list[0];   // single org → preselect
        if($('setup-org').value.trim())await loadSetupProjects();
      }else{
        $('setup-load-hint').textContent=window.i18n.t('setup.noOrgs', 'No organizations returned for this PAT — type the org name manually.');
      }
    }catch(e){
      $('setup-load-hint').textContent=window.i18n.t('setup.errListOrgs', 'Could not list organizations ({error}) — type the org and project manually.', {error: e.message});
    }finally{
      if(btn){btn.disabled=false;btn.textContent=window.i18n.t('common.load', 'Load');}_loadingOrgs=false;
    }
  }
  async function loadSetupProjects(){
    const org=$('setup-org').value.trim();
    if(!org)return;
    try{
      const list=await api.projects(org);
      fillDatalist('setup-projlist',list);
      if(list.length&&!$('setup-project').value.trim())$('setup-project').value=list[0];   // prefill the first project if none chosen yet
    }catch(e){
      showSetupOrgError(window.i18n.t('setup.orgNotFound', 'Organization not found or PAT has no permissions.'));
    }
  }
  function showSetupOrgError(message) {
    const inputEl = $('setup-org');
    if (!inputEl) return;
    const overlay = $('setup-overlay');
    if (!overlay) return;

    const existing = document.querySelector('.setup-org-error');
    if (existing) {
      if (window.LayerManager) window.LayerManager.close(existing);
      existing.remove();
    }

    const err = document.createElement('div');
    err.className = 'setup-org-error emoji-row-error';
    err.textContent = message;

    overlay.appendChild(err);

    const rRect = inputEl.getBoundingClientRect();
    const oRect = overlay.getBoundingClientRect();

    const top = rRect.top - oRect.top - 32;
    const left = rRect.left - oRect.left + 10;

    err.style.top = `${top}px`;
    err.style.left = `${left}px`;
    err.style.right = 'auto';

    if (window.LayerManager) {
      window.LayerManager.open(err, null, { isPopover: true });
    }

    setTimeout(() => {
      err.style.opacity = '0';
      setTimeout(() => {
        if (window.LayerManager) window.LayerManager.close(err);
        err.remove();
      }, 200);
    }, 4000);
  }

  /* ---------- PAT validity countdown ----------
     ADO can't tell a PAT-authenticated request when the PAT expires (the Token
     Lifecycle API needs an Entra token), so the user optionally records the
     expiry date and we count down from it. */
  function patDaysLeft(expiry){return AdoLib.patDaysLeft(expiry);}   // pure logic in lib.js
  function patDaysLabel(n){return n>=60?(Math.round(n/30)+'mo'):(n+'d');}
  async function updateProjectBadge(){
    const el=$('projbadge');if(!el)return;
    let org='',project='';
    try{const c=await api.getConfig();org=c.org||'';project=c.project||'';}catch(e){}
    if(!project){el.style.display='none';return;}
    el.style.display='inline-flex';
    el.innerHTML=(org?`<span class="pb-org">${htmlEsc(org)}</span><span class="pb-sep">/</span>`:'')+`<span class="pb-proj">${htmlEsc(project)}</span>`;
    el.title=window.i18n.t('setup.currentProjectTitle', 'Current project: {org}{project} — click to switch', {org: org?org+' / ':'', project: project});
  }
  async function updatePatBadge(){
    const el=$('patbadge');if(!el)return;
    let exp='';try{exp=(await api.getConfig()).patExpiry||'';}catch(e){}
    const n=patDaysLeft(exp);
    el.classList.remove('patok','patwarn','patbad');
    if(n===null){el.style.display='none';el.textContent='';el.title='';return;}
    el.style.display='inline-block';
    let cls,text,tip;
    if(n<0){cls='patbad';text=window.i18n.t('setup.pat.expired', 'PAT expired');tip=window.i18n.t('setup.pat.expiredTip', 'Personal Access Token expired {n} day(s) ago ({exp}).', {n: -n, exp});}
    else if(n===0){cls='patbad';text=window.i18n.t('setup.pat.today', 'PAT: today');tip=window.i18n.t('setup.pat.todayTip', 'Personal Access Token expires today ({exp}).', {exp});}
    else{cls=n<=3?'patbad':(n<=14?'patwarn':'patok');text=window.i18n.t('setup.pat.daysLeft', 'PAT: {label}', {label: patDaysLabel(n)});tip=window.i18n.t('setup.pat.daysLeftTip', 'Personal Access Token valid for {n} day(s) (until {exp}).', {n, exp});}
    el.textContent=text;el.classList.add(cls);el.title=tip+' ' + window.i18n.t('setup.pat.clickToUpdate', 'Click to update.');
  }
  function updateSetupExpiryInfo(){
    const t=$('setup-expiry-info');if(!t)return;
    const n=patDaysLeft($('setup-expiry').value);
    t.textContent=n===null?'':(n<0?window.i18n.t('setup.pat.expiredDaysAgoShort', 'expired {n} day(s) ago', {n: -n}):(n===0?window.i18n.t('setup.pat.expiresTodayShort', 'expires today'):window.i18n.t('setup.pat.daysLeftShort', '{n} day(s) left', {n})));
  }

  async function saveSetup(){
    const org=$('setup-org').value.trim();
    const project=$('setup-project').value.trim();
    if(!org){$('setup-err').textContent=window.i18n.t('setup.errOrgRequired', 'Organization is required.');return;}
    if(!project){$('setup-err').textContent=window.i18n.t('setup.errProjectRequired', 'Project is required.');return;}
    if(setupAuthMode==='pat'&&!$('setup-pat').value.trim()){$('setup-err').textContent=window.i18n.t('setup.errPatRequired', 'PAT is required.');return;}
    if(setupAuthMode==='oauth'){
      const c=await api.getConfig();
      if(!c.oauthAccess&&!c.oauthRefresh){$('setup-err').textContent=window.i18n.t('setup.errSignInFirst', 'Sign in with Microsoft first.');return;}
    }
    const btn=$('setup-save');btn.disabled=true;btn.textContent=window.i18n.t('common.validating', 'Validating…');
    $('setup-err').textContent='';
    try{
      // Persist first so api.me() picks up the new values; if it fails we surface a
      // clear error and let the user fix things instead of leaving stale state.
      if(setupAuthMode==='oauth')await api.setConfig({authMode:'oauth',org,project});
      else await api.setConfig({authMode:'pat',pat:$('setup-pat').value.trim(),org,project,patExpiry:$('setup-expiry').value});
      const name=await api.me();
      if(!name)throw new Error('authentication failed (no display name returned)');
      currentUser=name;projectName=project;
      updatePatBadge();
      hideSetup();
      btn.disabled=false;btn.textContent=window.i18n.t('setup.saveAndConnect', 'Save & Connect');
      await initialBoot(/*postSetup*/true);
    }catch(e){
      $('setup-err').textContent=window.i18n.t('setup.connectionFailed', 'Connection failed: {error}', {error: e.message});
      btn.disabled=false;btn.textContent=window.i18n.t('setup.saveAndConnect', 'Save & Connect');
    }
  }

  App.setup = {
    setAuthPane,
    updateTenantField,
    doOauthSignIn,
    showSetup,
    hideSetup,
    handle401,
    warnIfPatExpiring,
    loadSetupOrgs,
    loadSetupProjects,
    updateProjectBadge,
    updatePatBadge,
    updateSetupExpiryInfo,
    saveSetup,
  };
})(window.App);

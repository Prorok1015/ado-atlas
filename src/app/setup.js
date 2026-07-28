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
  let setupProviderMode = 'ado';
  let linearAuthMode = 'api_key';
  let githubAuthMode = 'token';

  function setProviderPane(provider){
    setupProviderMode = (provider === 'linear' || provider === 'github') ? provider : 'ado';
    const ado = $('setup-pane-ado'); if (ado) ado.style.display = setupProviderMode === 'ado' ? 'block' : 'none';
    const lin = $('setup-pane-linear'); if (lin) lin.style.display = setupProviderMode === 'linear' ? 'block' : 'none';
    const gh = $('setup-pane-github'); if (gh) gh.style.display = setupProviderMode === 'github' ? 'block' : 'none';
    const bar = $('setup-provider-mode');
    if (bar) {
      bar.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.provider === setupProviderMode));
    }
  }

  function setLinearAuthPane(mode) {
    linearAuthMode = mode === 'oauth' ? 'oauth' : 'api_key';
    const keyPane = $('linear-auth-key'); if (keyPane) keyPane.style.display = linearAuthMode === 'api_key' ? 'block' : 'none';
    const oauthPane = $('linear-auth-oauth'); if (oauthPane) oauthPane.style.display = linearAuthMode === 'oauth' ? 'block' : 'none';
    const bar = $('linear-auth-mode');
    if (bar) {
      bar.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.lam === linearAuthMode));
    }
  }

  function setGitHubAuthPane(mode) {
    githubAuthMode = mode === 'oauth' ? 'oauth' : 'token';
    const tokenPane = $('github-auth-token'); if (tokenPane) tokenPane.style.display = githubAuthMode === 'token' ? 'block' : 'none';
    const oauthPane = $('github-auth-oauth'); if (oauthPane) oauthPane.style.display = githubAuthMode === 'oauth' ? 'block' : 'none';
    const bar = $('github-auth-mode');
    if (bar) {
      bar.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.gam === githubAuthMode));
    }
  }

  async function handleLinearOAuthSignIn() {
    const clientId = ($('linear-oauth-client') ? $('linear-oauth-client').value : '').trim();
    const clientSecret = ($('linear-oauth-secret') ? $('linear-oauth-secret').value : '').trim();
    if (!clientId) {
      $('setup-err').textContent = window.i18n.t('setup.linear.enterClientId', 'Enter the OAuth Client ID first.');
      return;
    }
    const btn = $('linear-oauth-signin');
    btn.disabled = true;
    btn.textContent = window.i18n.t('setup.linear.signingIn', 'Signing in to Linear…');
    $('setup-err').textContent = '';
    try {
      if (!window.LinearProvider) throw new Error('LinearProvider is not available.');
      const user = await window.LinearProvider.oauthSignIn(clientId, clientSecret);
      currentUser = (user && (user.name || user.email)) || 'Linear User';
      $('linear-oauth-status').innerHTML = '<ui-icon name="check"></ui-icon> ' + window.i18n.t('setup.linear.signedInAs', 'Signed in as {name}', { name: htmlEsc(currentUser) });
    } catch (e) {
      $('setup-err').textContent = e.message;
    } finally {
      btn.disabled = false;
      btn.textContent = window.i18n.t('setup.linear.signIn', 'Sign in with Linear');
    }
  }

  async function handleGitHubOAuthSignIn() {
    const clientId = ($('github-oauth-client') ? $('github-oauth-client').value : '').trim();
    const clientSecret = ($('github-oauth-secret') ? $('github-oauth-secret').value : '').trim();
    if (!clientId) {
      $('setup-err').textContent = window.i18n.t('setup.github.enterClientId', 'Enter the OAuth Client ID first.');
      return;
    }
    const btn = $('github-oauth-signin');
    btn.disabled = true;
    btn.textContent = window.i18n.t('setup.github.signingIn', 'Signing in to GitHub…');
    $('setup-err').textContent = '';
    try {
      if (!window.GitHubProvider) throw new Error('GitHubProvider is not available.');
      const user = await window.GitHubProvider.oauthSignIn(clientId, clientSecret);
      currentUser = (user && (user.name || user.email)) || 'GitHub User';
      $('github-oauth-status').innerHTML = '<ui-icon name="check"></ui-icon> ' + window.i18n.t('setup.github.signedInAs', 'Signed in as {name}', { name: htmlEsc(currentUser) });
    } catch (e) {
      $('setup-err').textContent = e.message;
    } finally {
      btn.disabled = false;
      btn.textContent = window.i18n.t('setup.github.signIn', 'Sign in with GitHub');
    }
  }

  function showSetup(cancellable){
    const initialProvider = (App.backend && App.backend.activeId) || 'ado';
    setProviderPane(initialProvider);
    const bar = $('setup-provider-mode');
    if (bar) {
      bar.querySelectorAll('button').forEach(b => {
        b.onclick = () => setProviderPane(b.dataset.provider);
      });
    }

    const lbar = $('linear-auth-mode');
    if (lbar) {
      lbar.querySelectorAll('button').forEach(b => {
        b.onclick = () => setLinearAuthPane(b.dataset.lam);
      });
    }
    if ($('linear-oauth-signin')) $('linear-oauth-signin').onclick = handleLinearOAuthSignIn;
    if ($('linear-oauth-copy')) {
      $('linear-oauth-copy').onclick = () => {
        const input = $('linear-oauth-redirect');
        if (input && input.value) {
          navigator.clipboard.writeText(input.value);
          if (window.toast) window.toast(window.i18n.t('common.copied', 'Copied!'));
        }
      };
    }

    const gbar = $('github-auth-mode');
    if (gbar) {
      gbar.querySelectorAll('button').forEach(b => {
        b.onclick = () => setGitHubAuthPane(b.dataset.gam);
      });
    }
    if ($('github-oauth-signin')) $('github-oauth-signin').onclick = handleGitHubOAuthSignIn;
    if ($('github-oauth-copy')) {
      $('github-oauth-copy').onclick = () => {
        const input = $('github-oauth-redirect');
        if (input && input.value) {
          navigator.clipboard.writeText(input.value);
          if (window.toast) window.toast(window.i18n.t('common.copied', 'Copied!'));
        }
      };
    }

    if(window.LinearProvider){
      if ($('linear-oauth-redirect')) {
        $('linear-oauth-redirect').value = window.LinearProvider.oauthRedirectUri() || window.i18n.t('setup.oauth.availableOnceLoaded', '(available once the extension is loaded)');
      }
      window.LinearProvider.getConfig().then(lcfg=>{
        if($('setup-linear-key'))$('setup-linear-key').value=lcfg.apiKey||'';
        if($('setup-linear-team'))$('setup-linear-team').value=lcfg.teamId||'';
        if($('linear-oauth-client'))$('linear-oauth-client').value=lcfg.oauthClientId||'';
        if($('linear-oauth-secret'))$('linear-oauth-secret').value=lcfg.oauthClientSecret||'';
        setLinearAuthPane(lcfg.authMode === 'oauth' ? 'oauth' : 'api_key');
        if ($('linear-oauth-status')) {
          $('linear-oauth-status').innerHTML = (lcfg.authMode === 'oauth' && lcfg.oauthAccessToken) ? ('<ui-icon name="check"></ui-icon> ' + window.i18n.t('setup.linear.signedIn', 'Signed in')) : '';
        }
      });
    }

    if(window.GitHubProvider){
      if ($('github-oauth-redirect')) {
        $('github-oauth-redirect').value = window.GitHubProvider.oauthRedirectUri() || window.i18n.t('setup.oauth.availableOnceLoaded', '(available once the extension is loaded)');
      }
      window.GitHubProvider.getConfig().then(gcfg=>{
        if($('setup-github-token'))$('setup-github-token').value=gcfg.token||'';
        if($('setup-github-owner'))$('setup-github-owner').value=gcfg.owner||'';
        if($('setup-github-repo'))$('setup-github-repo').value=gcfg.repo||'';
        if($('github-oauth-client'))$('github-oauth-client').value=gcfg.oauthClientId||'';
        if($('github-oauth-secret'))$('github-oauth-secret').value=gcfg.oauthClientSecret||'';
        setGitHubAuthPane(gcfg.authMode === 'oauth' ? 'oauth' : 'token');
        if ($('github-oauth-status')) {
          $('github-oauth-status').innerHTML = (gcfg.authMode === 'oauth' && gcfg.oauthAccessToken) ? ('<ui-icon name="check"></ui-icon> ' + window.i18n.t('setup.github.signedIn', 'Signed in')) : '';
        }
      });
    }
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
    const provider=setupProviderMode||'ado';

    if(provider==='linear'){
      const key=$('setup-linear-key')?$('setup-linear-key').value.trim():'';
      const team=$('setup-linear-team')?$('setup-linear-team').value.trim():'';
      const clientId=$('linear-oauth-client')?$('linear-oauth-client').value.trim():'';
      const clientSecret=$('linear-oauth-secret')?$('linear-oauth-secret').value.trim():'';

      if(linearAuthMode==='api_key' && !key){
        $('setup-err').textContent=window.i18n.t('setup.errLinearKeyRequired', 'Personal API Key is required for Linear.');
        return;
      }
      if (linearAuthMode === 'oauth') {
        const cfg = window.LinearProvider ? await window.LinearProvider.getConfig() : {};
        if (!cfg.oauthAccessToken) {
          await handleLinearOAuthSignIn();
          const newCfg = window.LinearProvider ? await window.LinearProvider.getConfig() : {};
          if (!newCfg.oauthAccessToken) return;
        }
      }

      const btn=$('setup-save');btn.disabled=true;btn.textContent=window.i18n.t('common.validating', 'Validating…');
      $('setup-err').textContent='';
      try{
        if(window.LinearProvider){
          await window.LinearProvider.setConfig({
            authMode: linearAuthMode,
            apiKey: key,
            teamId: team,
            oauthClientId: clientId,
            oauthClientSecret: clientSecret,
          });
        }
        if(App.backend){
          App.backend.setActive('linear');
        }
        const me=await window.LinearProvider.me();
        currentUser=(me&&(me.name||me.email))||'Linear User';
        projectName=team||'Linear';
        hideSetup();
        btn.disabled=false;btn.textContent=window.i18n.t('setup.saveConnect', 'Save & Connect');
        await initialBoot(/*postSetup*/true);
      }catch(e){
        $('setup-err').textContent=window.i18n.t('setup.connectionFailed', 'Connection failed: {error}', {error: e.message});
        btn.disabled=false;btn.textContent=window.i18n.t('setup.saveConnect', 'Save & Connect');
      }
      return;
    }

    if (provider === 'github') {
      const token = $('setup-github-token') ? $('setup-github-token').value.trim() : '';
      const owner = $('setup-github-owner') ? $('setup-github-owner').value.trim() : '';
      const repo = $('setup-github-repo') ? $('setup-github-repo').value.trim() : '';
      const clientId = $('github-oauth-client') ? $('github-oauth-client').value.trim() : '';
      const clientSecret = $('github-oauth-secret') ? $('github-oauth-secret').value.trim() : '';

      if (!owner) { $('setup-err').textContent = window.i18n.t('setup.github.errOwnerRequired', 'Owner / Organization is required.'); return; }
      if (!repo) { $('setup-err').textContent = window.i18n.t('setup.github.errRepoRequired', 'Repository is required.'); return; }

      if (githubAuthMode === 'token' && !token) {
        $('setup-err').textContent = window.i18n.t('setup.github.errTokenRequired', 'Personal Access Token is required for GitHub.');
        return;
      }
      if (githubAuthMode === 'oauth') {
        const cfg = window.GitHubProvider ? await window.GitHubProvider.getConfig() : {};
        if (!cfg.oauthAccessToken) {
          await handleGitHubOAuthSignIn();
          const newCfg = window.GitHubProvider ? await window.GitHubProvider.getConfig() : {};
          if (!newCfg.oauthAccessToken) return;
        }
      }

      const btn = $('setup-save'); btn.disabled = true; btn.textContent = window.i18n.t('common.validating', 'Validating…');
      $('setup-err').textContent = '';
      try {
        if (window.GitHubProvider) {
          await window.GitHubProvider.setConfig({
            authMode: githubAuthMode,
            token,
            owner,
            repo,
            oauthClientId: clientId,
            oauthClientSecret: clientSecret,
          });
        }
        if (App.backend) {
          App.backend.setActive('github');
        }
        const me = await window.GitHubProvider.me();
        currentUser = (me && (me.name || me.email)) || 'GitHub User';
        projectName = `${owner}/${repo}`;
        hideSetup();
        btn.disabled = false; btn.textContent = window.i18n.t('setup.saveConnect', 'Save & Connect');
        await initialBoot(/*postSetup*/true);
      } catch (e) {
        $('setup-err').textContent = window.i18n.t('setup.connectionFailed', 'Connection failed: {error}', { error: e.message });
        btn.disabled = false; btn.textContent = window.i18n.t('setup.saveConnect', 'Save & Connect');
      }
      return;
    }

    // Azure DevOps Flow
    if(App.backend) App.backend.setActive('ado');
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

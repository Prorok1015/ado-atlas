// Theme (dark / light / auto-follow-system), follow/mention notification
// toggles, auto-refresh timer, and view-mode switching. Phase-1 leaf module of
// the App.* refactor (REFACTORING_PLAN.md): IIFE publishing App.settings.
// Internal helpers (systemDark, autoTick) and the autoTimer state stay private.
// Reads/writes bare globals at call time ($, App.state.cy, window.ICONS, chrome,
// updatePatBadge, pdrag, boardBusy, App.state.cur, dirty, refresh, setMode, renderGraph,
// renderBoard, renderTree) and calls App.timeline.render for the timeline view.
// Loads before app.js.
(function (App) {
  'use strict';

  // ---- Themes ---------------------------------------------------------------
  // SINGLE SOURCE OF TRUTH for what a theme is. The palettes themselves live in
  // premium.css (body.theme-<id>); `feature` ties a theme to its ProButtonManager
  // TIERS entry, which decides free / preview / pro — never hardcode a tier here
  // or in the markup (AGENTS.md §16).
  //
  // A light-BASED theme also gets `body.light`, so all existing light overrides
  // in the component stylesheets keep working untouched.
  //
  // theme-init.js keeps a minimal copy of the id -> base map for the pre-paint
  // path; if you add a theme, add it there too or it will flash on load.
  const THEMES = {
    dark:     { id:'dark',     base:'dark',  nameKey:'theme.dark',     fallback:'Dark' },
    light:    { id:'light',    base:'light', nameKey:'theme.light',    fallback:'Light' },
    ultra:    { id:'ultra',    base:'dark',  nameKey:'theme.ultra',    fallback:'Ultra Dark',    feature:'ultra_dark' },
    nocturne: { id:'nocturne', base:'dark',  nameKey:'theme.nocturne', fallback:'Nocturne',      feature:'nocturne' },
    paper:    { id:'paper',    base:'light', nameKey:'theme.paper',    fallback:'Paper',         feature:'premium_white' }
  };
  const THEME_ORDER = ['dark','light','ultra','nocturne','paper'];

  function systemDark(){try{return !window.matchMedia||window.matchMedia('(prefers-color-scheme: dark)').matches;}catch(e){return true;}}

  // 'auto' is not a theme — it resolves to one. Pro users choose which theme sits
  // on each side of the system switch; everyone else gets the plain dark/light pair.
  function resolveTheme(mode){
    if(mode!=='auto') return THEMES[mode] ? mode : 'dark';
    const paired=App.prefs.get(systemDark()?'themeNight':'themeDay');
    if(paired&&THEMES[paired]) return paired;
    return systemDark()?'dark':'light';
  }

  function applyTheme(mode){
    const id=resolveTheme(mode);
    const t=THEMES[id];
    // drop any previous theme-* class, then re-stamp
    Array.from(document.body.classList).forEach(c=>{ if(c.indexOf('theme-')===0) document.body.classList.remove(c); });
    document.body.classList.toggle('light', t.base==='light');
    if(id!=='dark'&&id!=='light') document.body.classList.add('theme-'+id);

    const tl=$('theme_label');if(tl)tl.textContent=themeName(id);
    // the ⚙ row keeps morepanel's one-line contract: a chip showing the current palette.
    const chip=$('theme_chip');
    if(chip){const v=readThemeTokens(id);chip.style.background=v.bg;chip.style.borderColor=v.line;chip.style.color=v.accent;}
    if(App.state.cy)App.state.cy.style().update();                         // re-evaluate theme-aware graph styles (parent label colour)
    renderThemeGallery();
  }

  // ---- Theme picker modal -----------------------------------------------------
  // The gallery needs room and — for the premium palettes — a place to sell itself, so it
  // lives in an overlay, exactly like "Customize layout…" and the emoji editor do. The ⚙
  // popover is a narrow label|control list; a stacked grid does not belong in it.
  let _themeReturnFocus=null;
  function openThemePicker(){
    const m=$('morepanel');if(m){m.style.display='none';const b=$('morebtn');if(b)b.classList.remove('on');}
    const ov=$('theme-overlay');if(!ov)return;
    _themeReturnFocus=document.activeElement;
    renderThemeGallery();
    ov.classList.add('show');
    if(window.LayerManager)window.LayerManager.open(ov);
    // LayerManager only manages z-index (no focus trap yet — audit C12), so at least land
    // the focus inside the dialog and give it back on close.
    const first=ov.querySelector('.theme-card[aria-checked="true"]')||ov.querySelector('.theme-card');
    if(first)first.focus();
  }
  function closeThemePicker(){
    const ov=$('theme-overlay');if(!ov)return;
    ov.classList.remove('show');
    if(window.LayerManager)window.LayerManager.close(ov);
    if(_themeReturnFocus&&_themeReturnFocus.focus)_themeReturnFocus.focus();
    _themeReturnFocus=null;
  }

  function themeName(id){
    const t=THEMES[id];if(!t)return id;
    return (window.i18n&&window.i18n.t)?window.i18n.t(t.nameKey,{},t.fallback)||t.fallback:t.fallback;
  }

  // Silent entitlement test — NO paywall, no side effects. gate() is for a user ACTION;
  // this is for "may we keep showing what they already have?".
  function isThemeAllowed(id){
    const t=THEMES[id];if(!t)return false;
    if(!t.feature)return true;                                             // free theme
    const EM=window.EntitlementManager,PBM=window.ProButtonManager;
    if(PBM&&PBM.isPreview(t.feature))return true;                          // Free Preview tier
    return !!(EM&&EM.isPro());
  }

  // A subscription can lapse while a premium theme is applied. Nothing else re-checks:
  // applyTheme() just paints, and theme-init.js runs pre-paint off localStorage with no
  // access to the entitlement. So without this, an expired subscriber would keep their Pro
  // theme forever the moment TIERS flips from 'preview' to 'pro'.
  //
  // Fall back to the theme's OWN BASE, not to 'dark': someone on Paper chose a LIGHT
  // interface, and slamming them into dark mode would be a worse bug than the one we fix.
  // The fallback is persisted, so the next boot reads a clean value and never flashes.
  // Registered as an entitlement guard (see EntitlementManager.registerGuard). Silent by
  // contract: it reverts and reports, it never opens a paywall.
  function enforceThemeEntitlement(){
    let changed=null;
    ['themeDay','themeNight'].forEach(slot=>{
      const id=App.prefs.get(slot);
      if(id&&THEMES[id]&&!isThemeAllowed(id)){
        App.prefs.set(slot, THEMES[id].base);                              // 'dark' | 'light'
        changed=changed||id;
      }
    });
    const cur=App.prefs.get('theme')||'dark';
    if(cur!=='auto'&&THEMES[cur]&&!isThemeAllowed(cur)){
      const fallback=THEMES[cur].base;
      App.prefs.set('theme',fallback);
      changed=cur;
      applyTheme(fallback);
    }else if(changed){
      applyTheme(cur);
    }
    return changed?themeName(changed):null;                                // label for the aggregated notice
  }

  // The ONLY way a premium theme gets applied by a user action. gate() honours
  // free / preview / pro straight from TIERS, so flipping a theme from 'preview' to
  // 'pro' locks it with zero code change here.
  function pickTheme(id){
    const t=THEMES[id];if(!t)return;
    if(t.feature&&window.EntitlementManager&&!window.EntitlementManager.gate(t.feature))return;
    App.prefs.set('theme',id);
    App.prefs.set('autoTheme','off');
    applyTheme(id);
  }

  function setAutoTheme(on){
    App.prefs.set('autoTheme',on?'on':'off');
    App.prefs.set('theme',on?'auto':resolveTheme('auto'));
    applyTheme(on?'auto':App.prefs.get('theme'));
  }

  function setPairedTheme(slot,id){                                        // slot: 'themeDay' | 'themeNight'
    const t=THEMES[id];if(!t)return;
    if(t.feature&&window.EntitlementManager&&!window.EntitlementManager.gate(t.feature)){renderThemeGallery();return;}
    App.prefs.set(slot,id);
    applyTheme('auto');
  }

  // Kept for the command palette / any caller that still wants the old 3-state cycle.
  function cycleTheme(){
    const cur=App.prefs.get('theme')||'dark';
    if(cur==='auto'){setAutoTheme(false);pickTheme('dark');return;}
    if(cur==='dark'){pickTheme('light');return;}
    if(cur==='light'){setAutoTheme(true);return;}
    pickTheme('dark');
  }

  // ---- Theme gallery (⚙ menu) ------------------------------------------------
  // Every card is a miniature of the real app rendered in that theme's own tokens —
  // the user picks by looking at the thing, not at a colour name.
  function swatchHtml(id){
    // Tokens are read from the stylesheet by probing a detached element with the
    // theme class, so the palette lives in exactly one place: premium.css.
    const vars=readThemeTokens(id);
    const v=Object.keys(vars).map(k=>'--sw-'+k+':'+vars[k]).join(';');
    return '<span class="theme-swatch" style="'+v+'">'
      +   '<span class="sw-top"><span class="sw-dot"></span><span class="sw-pill"></span></span>'
      +   '<span class="sw-body"><span class="sw-side"></span>'
      +     '<span class="sw-main">'
      +       '<span class="sw-row"></span><span class="sw-row dim"></span>'
      +       '<span class="sw-row acc"></span><span class="sw-row short"></span>'
      +     '</span>'
      +   '</span>'
      + '</span>';
  }

  // "Follow system" is a CHOICE, not a modifier — so it is a card in the same radiogroup,
  // not a checkbox beside it. Its swatch is a diagonal split of the two themes actually
  // paired right now, so the card itself answers "which pair is this?".
  function autoSwatchHtml(){
    const day=readThemeTokens(App.prefs.get('themeDay')||'light');
    const night=readThemeTokens(App.prefs.get('themeNight')||'dark');
    const v=['--sw-day-bg:'+day.bg,'--sw-day-accent:'+day.accent,'--sw-day-txt:'+day.txt,
             '--sw-night-bg:'+night.bg,'--sw-night-accent:'+night.accent,'--sw-night-txt:'+night.txt].join(';');
    return '<span class="theme-swatch theme-swatch-auto" style="'+v+'">'
      +   '<span class="sw-half sw-half-day"><span class="sw-mini"></span><span class="sw-mini short"></span></span>'
      +   '<span class="sw-half sw-half-night"><span class="sw-mini"></span><span class="sw-mini short"></span></span>'
      + '</span>';
  }

  const _tokenCache={};
  const SWATCH_TOKENS=['bg','panel','panel2','line','txt','muted','accent','sel'];
  function readThemeTokens(id){
    if(_tokenCache[id])return _tokenCache[id];
    const probe=document.createElement('div');
    probe.style.display='none';
    if(THEMES[id].base==='light')probe.classList.add('light');
    if(id!=='dark'&&id!=='light')probe.classList.add('theme-'+id);
    document.body.appendChild(probe);
    const cs=getComputedStyle(probe);
    const out={};
    SWATCH_TOKENS.forEach(t=>{out[t]=(cs.getPropertyValue('--'+t)||'').trim();});
    probe.remove();
    _tokenCache[id]=out;
    return out;
  }

  function renderThemeGallery(){
    const host=$('theme_gallery');if(!host)return;
    const auto=(App.prefs.get('autoTheme')||'off')==='on';
    // Exactly one card is checked. When "Auto" is on it is the selection — the concrete
    // theme it currently resolves to is shown as a sub-label, not as a second checkmark.
    const selected=auto?'auto':resolveTheme(App.prefs.get('theme')||'dark');
    const L=(k,f)=>(window.i18n&&window.i18n.t)?(window.i18n.t(k,{},f)||f):f;

    // `data-pro-feature` lets ProButtonManager own the badge + shimmer (and randomise the
    // shimmer phase, so the cards don't pulse in lockstep). `data-pro-ready` tells the global
    // placeholder listener to keep its hands off: this feature EXISTS and gates itself via
    // pickTheme() -> gate(). Without it the paywall would open on top of a working theme.
    const shell=(id,on,swatch,name,sub,feature)=>
        '<button type="button" class="theme-card" role="radio" aria-checked="'+on+'" data-theme="'+id+'"'
      +   (feature?' data-pro-feature="'+feature+'" data-pro-ready':'')
      +   ' title="'+htmlEsc(name)+'">'
      +   swatch
      +   '<span class="theme-name">'+htmlEsc(name)+'<ui-icon class="tick" name="check"></ui-icon></span>'
      +   (sub?'<span class="theme-sub">'+htmlEsc(sub)+'</span>':'')
      + '</button>';

    // The tier is already stated by the badge ProButtonManager injects (PRO / PREVIEW) —
    // no sub-label needed, it just crowds the card.
    const card=id=>shell(id, selected===id, swatchHtml(id), themeName(id), '', THEMES[id].feature);

    const autoCard=()=>shell('auto', selected==='auto', autoSwatchHtml(),
      L('theme.followSystem','Follow system'),
      auto ? L('theme.nowUsing','Now: {name}').replace('{name}', themeName(resolveTheme('auto'))) : '', null);

    const opts=(sel,base)=>THEME_ORDER.filter(i=>THEMES[i].base===base)
      .map(i=>'<option value="'+i+'"'+(sel===i?' selected':'')+'>'+htmlEsc(themeName(i))+'</option>').join('');

    host.innerHTML =
        '<div class="theme-group-label">'+htmlEsc(L('theme.group.included','Included'))+'</div>'
      + '<div class="theme-cards" role="radiogroup" aria-label="'+htmlEsc(L('settings.theme','Theme'))+'">'
      +   THEME_ORDER.filter(i=>!THEMES[i].feature).map(card).join('')
      +   autoCard()
      + '</div>'
      + '<div class="theme-group-label">'+htmlEsc(L('theme.group.pro','Pro'))+'</div>'
      + '<div class="theme-cards" role="radiogroup" aria-label="'+htmlEsc(L('theme.group.pro','Pro'))+'">'
      +   THEME_ORDER.filter(i=>THEMES[i].feature).map(card).join('')
      + '</div>'
      // the pairing selects belong to the Auto card, so they only exist while it is chosen
      + '<div class="theme-pair'+(auto?' on':'')+'">'
      +   '<div><label for="theme_day">'+htmlEsc(L('theme.day','Day'))+'</label>'
      +     '<select id="theme_day">'+opts(App.prefs.get('themeDay')||'light','light')+'</select></div>'
      +   '<div><label for="theme_night">'+htmlEsc(L('theme.night','Night'))+'</label>'
      +     '<select id="theme_night">'+opts(App.prefs.get('themeNight')||'dark','dark')+'</select></div>'
      + '</div>';

    host.querySelectorAll('.theme-card').forEach(b=>{
      b.onclick=()=>{ const id=b.dataset.theme; if(id==='auto')setAutoTheme(true); else pickTheme(id); };
      // badge + tier colour + shimmer, from the single source of truth (TIERS)
      if(window.ProButtonManager&&b.dataset.proFeature)window.ProButtonManager.apply(b);
    });
    const d=$('theme_day');   if(d)  d.onchange=()=>setPairedTheme('themeDay',d.value);
    const n=$('theme_night'); if(n)  n.onchange=()=>setPairedTheme('themeNight',n.value);
    if(window.ICONS){
      host.querySelectorAll('ui-icon[name="check"]').forEach(i=>{i.innerHTML=window.ICONS.check||'';});
      host.querySelectorAll('ui-icon[name="gem"]').forEach(i=>{i.innerHTML=window.ICONS.gem||'';});   // badge icon, injected by ProButtonManager
    }
  }
  function applyFollowNotify(status) {
    const btn = $('f_follow_notify');
    if (!btn) return;
    btn.title = 'notifications: ' + status + ' — click to change';
    btn.innerHTML = (status === 'on' ? '<ui-icon name="bell"></ui-icon> ' : '<ui-icon name="bell-off"></ui-icon> ') + `<span id="f_follow_notify_label">${status}</span>`;
  }
  function cycleFollowNotify() {
    const next = (App.prefs.get('followNotify') || 'on') === 'on' ? 'off' : 'on';
    App.prefs.set('followNotify', next);
    applyFollowNotify(next);
  }
  function applyMentionNotify(status) {
    const btn = $('f_mention_notify');
    if (!btn) return;
    btn.title = 'mention notifications: ' + status + ' — click to change';
    btn.innerHTML = (status === 'on' ? '<ui-icon name="bell"></ui-icon> ' : '<ui-icon name="bell-off"></ui-icon> ') + `<span id="f_mention_notify_label">${status}</span>`;
  }
  function cycleMentionNotify() {
    const next = (App.prefs.get('mentionNotify') || 'on') === 'on' ? 'off' : 'on';
    App.prefs.set('mentionNotify', next);
    applyMentionNotify(next);
  }
  function applyTelemetry(status) {
    const btn = $('f_telemetry');
    if (!btn) return;
    btn.title = 'usage analytics: ' + status + ' — click to change';
    btn.innerHTML = (status === 'on' ? '<ui-icon name="bar-chart"></ui-icon> ' : '<ui-icon name="slash"></ui-icon> ') + `<span id="f_telemetry_label">${status}</span>`;
  }
  function cycleTelemetry() {
    const next = (App.prefs.get('telemetry') || 'on') === 'on' ? 'off' : 'on';
    App.prefs.set('telemetry', next);
    applyTelemetry(next);
  }
  let autoTimer=null;
  function autoTick(){
    App.setup.updatePatBadge();                          // keep the countdown fresh on long-lived tabs
    if(document.hidden||pdrag||boardBusy)return;   // don't refetch hidden, or yank the board mid-drag
    if(App.state.cur!=null&&dirty())return;              // don't disrupt unsaved editor changes
    refresh();
  }
  function setAutoRefresh(sec){
    if(autoTimer){clearInterval(autoTimer);autoTimer=null;}
    sec=parseInt(sec,10)||0;
    if(sec>0)autoTimer=setInterval(autoTick,sec*1000);
  }
  function switchMode(m){setMode(m);App.prefs.set('mode',m);
    if(App.analytics)App.analytics.track('view_change',{mode:m});
    if(m==='graph')App.graph.renderGraph({fit:true});else if(m==='board')App.board.renderBoard();else if(m==='timeline')App.timeline.render();else App.tree.renderTree();}

  // The theme persists a value that may require an entitlement, so it registers a guard
  // instead of wiring onChange() itself. The manager guarantees it runs at boot and on
  // every entitlement change — nothing here has to remember to.
  if (window.EntitlementManager && window.EntitlementManager.registerGuard) {
    window.EntitlementManager.registerGuard('theme', enforceThemeEntitlement);
  }

  App.settings = { applyTheme, cycleTheme, pickTheme, setAutoTheme, setPairedTheme, isThemeAllowed, enforceThemeEntitlement, renderThemeGallery, openThemePicker, closeThemePicker, THEMES, THEME_ORDER, applyFollowNotify, cycleFollowNotify, applyMentionNotify, cycleMentionNotify, applyTelemetry, cycleTelemetry, setAutoRefresh, switchMode };
})(window.App);

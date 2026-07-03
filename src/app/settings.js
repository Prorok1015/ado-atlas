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

  function systemDark(){try{return !window.matchMedia||window.matchMedia('(prefers-color-scheme: dark)').matches;}catch(e){return true;}}
  function applyTheme(mode){
    const light=mode==='light'||(mode==='auto'&&!systemDark());
    document.body.classList.toggle('light',light);
    const btn=$('theme');
    if(btn){
      btn.title='theme: '+mode+(mode==='auto'?' (follows system)':'')+' — click to change';
      const iconEl=btn.querySelector('ui-icon');
      if(iconEl){
        const iconName=light?'sun':'moon';
        iconEl.setAttribute('name',iconName);
        if(window.ICONS&&window.ICONS[iconName]){
          iconEl.innerHTML=window.ICONS[iconName];
        }
      }
    }
    const tl=$('theme_label');if(tl)tl.textContent=mode;
    if(App.state.cy)App.state.cy.style().update();                        // re-evaluate theme-aware graph styles (parent label colour)
  }
  function cycleTheme(){
    let m=App.prefs.get('theme')||'dark';
    m=m==='dark'?'light':(m==='light'?'auto':'dark');
    App.prefs.set('theme',m);
    applyTheme(m);
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
    if(m==='graph')App.graph.renderGraph({fit:true});else if(m==='board')App.board.renderBoard();else if(m==='timeline')App.timeline.render();else App.tree.renderTree();}

  App.settings = { applyTheme, cycleTheme, applyFollowNotify, cycleFollowNotify, applyMentionNotify, cycleMentionNotify, setAutoRefresh, switchMode };
})(window.App);

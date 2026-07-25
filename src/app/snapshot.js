// Last-snapshot cache for an instant first paint.
// Phase-1 leaf module of the App.* refactor (REFACTORING_PLAN.md):
// IIFE that publishes its public API on App.snapshot. The internal helper
// `snapKey` stays private. Reads bare globals (`api`, `App.state.store`, `setStatus`,
// `renderTree`, `chrome`) at call time — they remain declared in app.js,
// which loads after this module.
(function (App) {
  'use strict';

  async function saveSnapshot() {
    try {
      if (!App.cache) return;
      if (App.state.store.roots.length > 1500 || Object.keys(App.state.store.nodes).length > 4000) return;   // skip very large views
      await App.cache.set('snapshot', {
        roots: App.state.store.roots,
        top: App.state.store.top || App.state.store.roots,
        nodes: App.state.store.nodes,
        kids: App.state.store.kids,
        expanded: [...App.state.store.expanded],
        ts: Date.now()
      });
    } catch (e) { /* cache is best-effort */ }
  }

  async function loadSnapshot() {
    try {
      if (!App.cache) return false;
      const d = await App.cache.get('snapshot', { ttlMs: 86400000 }); // ignore snapshots older than 24h
      if (!d || !d.roots || !d.roots.length) return false;
      App.state.store.nodes = d.nodes || {}; App.state.store.roots = d.roots; App.state.store.top = d.top || d.roots; App.state.store.kids = d.kids || {}; App.state.store.expanded = new Set(d.expanded || []);
      if (App.tree && typeof App.tree.renderTree === 'function') App.tree.renderTree();
      const age = Math.round((Date.now() - (d.ts || Date.now())) / 60000);
      if (typeof setStatus === 'function') setStatus(App.state.store.roots.length + ' item(s) · cached' + (age > 0 ? (' ' + age + 'm ago') : '') + ' — refreshing…');
      return true;
    } catch (e) { return false; }
  }

  App.snapshot = { saveSnapshot, loadSnapshot };
})(window.App);

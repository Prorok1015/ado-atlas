// Last-snapshot cache for an instant first paint.
// Phase-1 leaf module of the App.* refactor (REFACTORING_PLAN.md):
// IIFE that publishes its public API on App.snapshot. The internal helper
// `snapKey` stays private. Reads bare globals (`api`, `store`, `setStatus`,
// `renderTree`, `chrome`) at call time — they remain declared in app.js,
// which loads after this module.
(function (App) {
  'use strict';

  async function snapKey() {
    try {
      const c = await api.getConfig();
      return (c.org && c.project) ? ('snap:' + c.org + '/' + c.project) : null;
    } catch (e) { return null; }
  }

  async function saveSnapshot() {
    try {
      if (store.roots.length > 1500 || Object.keys(store.nodes).length > 4000) return;   // skip very large views
      const key = await snapKey(); if (!key) return;
      await chrome.storage.local.set({ [key]: { roots: store.roots, top: store.top || store.roots, nodes: store.nodes, kids: store.kids, expanded: [...store.expanded], ts: Date.now() } });
    } catch (e) { /* cache is best-effort */ }
  }

  async function loadSnapshot() {
    try {
      const key = await snapKey(); if (!key) return false;
      const r = await chrome.storage.local.get([key]); const d = r[key];
      if (!d || !d.roots || !d.roots.length) return false;
      if (d.ts && (Date.now() - d.ts) > 86400000) return false;   // ignore snapshots older than 24h
      store.nodes = d.nodes || {}; store.roots = d.roots; store.top = d.top || d.roots; store.kids = d.kids || {}; store.expanded = new Set(d.expanded || []);
      App.tree.renderTree();                              // instant tree from the cached snapshot
      const age = Math.round((Date.now() - (d.ts || Date.now())) / 60000);
      setStatus(store.roots.length + ' item(s) · cached' + (age > 0 ? (' ' + age + 'm ago') : '') + ' — refreshing…');
      return true;
    } catch (e) { return false; }
  }

  App.snapshot = { saveSnapshot, loadSnapshot };
})(window.App);

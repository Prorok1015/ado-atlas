// Export the current (filtered) view to CSV / JSON.
// First Phase-1 leaf module of the App.* refactor (REFACTORING_PLAN.md):
// IIFE that publishes its public API on App.export. Internal helpers stay
// private. Reads bare globals `App.state.store` and `setStatus` at call time (still
// declared in app.js, loaded after this module). Loads before app.js.
(function (App) {
  'use strict';

  const EXPORT_COLS = ['id','type','title','state','assigned','priority','iteration','parent','start','target','est','tags'];

  function exportRows() { return App.state.store.roots.map(id => App.state.store.nodes[id]).filter(Boolean); }

  function downloadFile(name, mime, text) {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportView(kind) {
    const rows = exportRows();
    if (!rows.length) { setStatus('nothing to export', true); return; }
    if (kind === 'json') {
      downloadFile('ado-atlas-export.json', 'application/json', JSON.stringify(rows.map(n => { const o = {}; EXPORT_COLS.forEach(k => o[k] = n[k]); return o; }), null, 2));
    } else {
      const cell = v => { v = (v == null ? '' : String(v)); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
      const csv = [EXPORT_COLS.join(',')].concat(rows.map(n => EXPORT_COLS.map(k => cell(n[k])).join(','))).join('\r\n');
      downloadFile('ado-atlas-export.csv', 'text/csv;charset=utf-8', '﻿' + csv);   // BOM so Excel reads UTF-8
    }
    setStatus('exported ' + rows.length + ' item(s) to ' + kind.toUpperCase());
  }

  App.export = { exportView };
})(window.App);

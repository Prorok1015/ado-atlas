// Work-item types sourced from ADO (no hard-coded list) + the type legend and
// type <select> population. Phase-1 leaf module of the App.* refactor
// (REFACTORING_PLAN.md): IIFE publishing App.types; internal calls stay local.
// Reads/writes bare globals (projectName, typeList, TYPE_COLOR, mode, App.state.cy, api,
// $, htmlEsc, typeNames, tyVar, tyColor, TYPES) at call time. Loads before app.js.
(function (App) {
  'use strict';

  async function loadTypes() {
    let types = [];
    try {
      const cached = localStorage.getItem('ado.types:' + projectName);
      if (cached) {
        types = JSON.parse(cached);
        if (Array.isArray(types) && types.length) {
          typeList = types;
          types.forEach(t => { if (t.color) { TYPE_COLOR[t.name] = t.color;
            document.documentElement.style.setProperty(tyVar(t.name), t.color); } });
          fillTypeSelect('c_type', 'Task'); fillTypeSelect('n_type', 'Task');
          buildLegend();
          repaintTypes();
        }
      }
    } catch (e) {}

    try { types = await api.workItemTypes(); } catch (e) { types = []; }
    if (types.length) {
      typeList = types;
      types.forEach(t => { if (t.color) { TYPE_COLOR[t.name] = t.color;   // canvas graph reads the hex map…
        document.documentElement.style.setProperty(tyVar(t.name), t.color); } });   // …DOM views read the CSS var (live update)
      try { localStorage.setItem('ado.types:' + projectName, JSON.stringify(types)); } catch (e) {}
    } else if (!typeList.length) {
      typeList = TYPES.map(n => ({ name: n, color: TYPE_COLOR[n] || '' }));     // offline fallback to the static defaults
    }
    fillTypeSelect('c_type', 'Task'); fillTypeSelect('n_type', 'Task');
    buildLegend();
    repaintTypes();                                  // colours just changed → repaint so defaults don't linger
  }

  // DOM views colour via the CSS vars set above, so they update live. Only the
  // canvas graph needs a nudge to re-read the hex map after the colours change.
  function repaintTypes() { if (mode === 'graph' && App.state.cy) App.state.cy.style().update(); }

  // (Re)populate a type <select> from the loaded types, keeping the current
  // choice if it's still valid, else falling back to `preferred` then the first.
  function fillTypeSelect(id, preferred) {
    const sel = $(id); if (!sel) return;
    const names = typeNames(), prev = sel.value;
    sel.innerHTML = ''; names.forEach(n => sel.appendChild(new Option(n, n)));
    sel.value = names.includes(prev) ? prev : (names.includes(preferred) ? preferred : (names[0] || ''));
  }

  function buildLegend() { $('legend').innerHTML = typeNames().map(k => `<span><i style="background:${tyColor(k)}"></i>${htmlEsc(k)}</span>`).join(''); }

  App.types = { loadTypes, repaintTypes, fillTypeSelect, buildLegend };
})(window.App);

// Create a brand-new work item from scratch (no parent required).
// Phase-1 feature module of the App.* refactor (REFACTORING_PLAN.md): IIFE
// publishing App.create. The card-picker instances parentNew/assignedNew/
// sprintNew are created in the boot wiring and stay bare globals (read here at
// call time), along with api/store/$/getIterations/refresh/openItem/etc.
// App.types.fillTypeSelect is already namespaced. Loads before app.js.
(function (App) {
  'use strict';

  let _newIterRoot = '';                               // sentinel path for "(no sprint)"

  async function showNewItem(parentId) {
    $('newitem-err').textContent = '';
    $('n_title').value = ''; $('n_prio').value = ''; assignedNew.set('', /*silent*/true);
    parentNew.set(parentId != null ? String(parentId) : '', /*silent*/true);   // render the parent card + close any open picker
    App.types.fillTypeSelect('n_type', 'Task');           // ensure options match the project's real types
    // sprint picker — same source as the editor's; "(no sprint)" = empty value
    try { const iters = await getIterations(); _newIterRoot = iters[0] ? iters[0].path.split('\\')[0] : (projectName || ''); }
    catch (e) { /* sprints are optional */ }
    sprintNew.set('', /*silent*/true);
    const overlay = $('newitem-overlay');
    overlay.classList.add('show');
    if (window.LayerManager) {
      window.LayerManager.open(overlay);
    }
    $('n_title').focus();
  }

  function closeNewItem() {
    parentNew.close();
    assignedNew.close();
    sprintNew.close();
    const overlay = $('newitem-overlay');
    overlay.classList.remove('show');
    if (window.LayerManager) {
      window.LayerManager.close(overlay);
    }
  }

  async function createNew() {
    const type = $('n_type').value, title = $('n_title').value.trim();
    if (!title) { $('newitem-err').textContent = 'Title is required.'; $('n_title').focus(); return; }
    const body = { type, title };
    const par = parentNew.get();
    if (par !== '') { if (!/^\d+$/.test(par)) { $('newitem-err').textContent = 'Parent must be a numeric work-item id.'; return; } body.parent = parseInt(par, 10); }
    const assigned = $('n_assigned').value.trim(); if (assigned) body.assigned = (assigned === 'me' ? (currentUser || assigned) : assigned);
    const prio = $('n_prio').value; if (prio) body.priority = Number(prio);
    const iter = $('n_iter').value; if (iter && iter !== _newIterRoot) body.iteration = iter;
    const btn = $('n_create'); btn.disabled = true; btn.textContent = 'Creating…'; loadStart('creating…');
    let r; try { r = await api.createItem(body); }
    catch (e) { if (denyOnForbidden(e, 'create work items')) { closeNewItem(); } else $('newitem-err').textContent = 'ERROR: ' + e.message; btn.disabled = false; btn.textContent = 'Create'; loadEnd(); return; }
    btn.disabled = false; btn.textContent = 'Create'; loadEnd();
    if (body.parent != null) delete store.kids[body.parent];   // parent's child list is now stale
    recordCreateUndo(r.id, body);
    closeNewItem();
    setStatus(`created #${r.id} (${type})` + (body.parent != null ? ` under #${body.parent}` : ' (top-level)'));
    await refresh();
    openItem(r.id);                                  // jump straight into the new item's editor
  }

  App.create = { showNewItem, closeNewItem, createNew };
})(window.App);

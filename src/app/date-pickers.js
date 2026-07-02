// Shared date-picker glue: manual date entry + the DateRangePicker sync helpers
// for the side editor (start/target, due), the bulk bar, sprint dates, and the
// setup PAT-expiry field. SHARED across editor/bulk/setup/sprint, so these stay
// BARE globals (bulk.js calls syncSideDatePicker/syncBulkDatePicker bare; setup.js
// calls syncSetupExpiryPicker bare). Relocated from app.js (REFACTORING_PLAN.md).
// Loads before app.js.
window.App = window.App || {};

function formatDisplayDate(dateStr) {
  if (!dateStr) return '';
  const parts = dateStr.slice(0, 10).split('-');
  if (parts.length !== 3) return dateStr;
  const d = new Date(Date.UTC(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10)));
  return d.toLocaleDateString(window.i18n.getLang(), { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}
function updateSprintRangeDisplay(start, finish) {
  const trigger = $('sprint-range-trigger');
  if (!trigger) return;
  if (start || finish) {
    const sPart = start ? formatDisplayDate(start) : '?';
    const fPart = finish ? formatDisplayDate(finish) : '?';
    trigger.value = `${sPart} — ${fPart}`;
  } else {
    trigger.value = '';
  }
}
function initSprintDatePickerEvents() {
  const trigger = $('sprint-range-trigger');
  if (trigger && !trigger.dataset.init) {
    trigger.dataset.init = '1';
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const popover = $('sprint-range-picker');
      const show = !popover.classList.contains('show');
      popover.classList.toggle('show', show);
      if (window.LayerManager) {
        if (show) window.LayerManager.open(popover, null, { isPopover: true });
        else window.LayerManager.close(popover);
      }
    });
    window.addEventListener('mousedown', (e) => {
      const popover = $('sprint-range-picker');
      if (popover && popover.classList.contains('show')) {
        if (!popover.contains(e.target) && !trigger.contains(e.target)) {
          popover.classList.remove('show');
          if (window.LayerManager) window.LayerManager.close(popover);
        }
      }
    });
    wireManualDateInput('sprint-range-trigger', 'sp_start', 'sp_finish', updateSprintRangeDisplay, false);
  }
}

function wireManualDateInput(triggerId, hiddenStartId, hiddenFinishId, syncFunc, isSingle) {
  const trigger = document.getElementById(triggerId);
  if (!trigger) return;
  
  trigger.addEventListener('change', () => {
    const text = trigger.value.trim();
    if (!text) {
      $(hiddenStartId).value = '';
      if (hiddenFinishId) $(hiddenFinishId).value = '';
      $(hiddenStartId).dispatchEvent(new Event('input'));
      $(hiddenStartId).dispatchEvent(new Event('change'));
      if (hiddenFinishId) {
        $(hiddenFinishId).dispatchEvent(new Event('input'));
        $(hiddenFinishId).dispatchEvent(new Event('change'));
      }
      syncFunc('', '');
      return;
    }
    
    const parsed = parseManualDates(text, isSingle);
    if (parsed) {
      $(hiddenStartId).value = parsed.start;
      if (hiddenFinishId) $(hiddenFinishId).value = parsed.finish;
      $(hiddenStartId).dispatchEvent(new Event('input'));
      $(hiddenStartId).dispatchEvent(new Event('change'));
      if (hiddenFinishId) {
        $(hiddenFinishId).dispatchEvent(new Event('input'));
        $(hiddenFinishId).dispatchEvent(new Event('change'));
      }
      syncFunc(parsed.start, parsed.finish);
    } else {
      const currentStart = $(hiddenStartId).value;
      const currentFinish = hiddenFinishId ? $(hiddenFinishId).value : '';
      syncFunc(currentStart, currentFinish);
    }
  });
  
  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      trigger.blur();
    }
  });
}

function parseManualDates(text, isSingle) {
  const parts = text.split(/[-—–~–]|\sto\s/).map(s => s.trim()).filter(Boolean);
  
  const parseSingle = (str) => {
    if (!str) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
      return str;
    }
    const d = new Date(str);
    if (!isNaN(d.getTime())) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    }
    return null;
  };
  
  const startStr = parseSingle(parts[0]);
  if (!startStr) return null;
  
  if (isSingle) {
    return { start: startStr, finish: startStr };
  } else {
    const finishStr = parseSingle(parts[1]) || startStr;
    return { start: startStr, finish: finishStr };
  }
}

let sideRangePicker = null;
function syncSideDatePicker(start, target) {
  const trigger = $('side-range-trigger');
  const popover = $('side-range-picker');
  if (!trigger || !popover) return;
  
  if (!trigger.dataset.init) {
    trigger.dataset.init = '1';
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const show = !popover.classList.contains('show');
      popover.classList.toggle('show', show);
      if (window.LayerManager) {
        if (show) window.LayerManager.open(popover, null, { isPopover: true });
        else window.LayerManager.close(popover);
      }
    });
    window.addEventListener('mousedown', (e) => {
      if (popover.classList.contains('show')) {
        if (!popover.contains(e.target) && !trigger.contains(e.target)) {
          popover.classList.remove('show');
          if (window.LayerManager) window.LayerManager.close(popover);
        }
      }
    });
    wireManualDateInput('side-range-trigger', 's_start', 's_target', syncSideDatePicker, false);
  }
  
  if (start || target) {
    const sPart = start ? formatDisplayDate(start) : '?';
    const tPart = target ? formatDisplayDate(target) : '?';
    trigger.value = `${sPart} — ${tPart}`;
  } else {
    trigger.value = '';
  }
  
  if (!sideRangePicker || !document.body.contains(sideRangePicker.container)) {
    sideRangePicker = new DateRangePicker('side-range-picker', {
      start,
      finish: target,
      onChange: ({start: s, finish: t}) => {
        $('s_start').value = s;
        $('s_target').value = t;
        
        $('s_start').dispatchEvent(new Event('input'));
        $('s_start').dispatchEvent(new Event('change'));
        $('s_target').dispatchEvent(new Event('input'));
        $('s_target').dispatchEvent(new Event('change'));
        
        syncSideDatePicker(s, t);
        if (s && t) {
          popover.classList.remove('show');
          if (window.LayerManager) window.LayerManager.close(popover);
        }
      }
    });
  } else {
    sideRangePicker.setRange(start, target);
  }
}

let bulkRangePicker = null;
function syncBulkDatePicker(start, target) {
  const trigger = $('bulk-range-trigger');
  const popover = $('bulk-range-picker');
  if (!trigger || !popover) return;
  
  if (!trigger.dataset.init) {
    trigger.dataset.init = '1';
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const show = !popover.classList.contains('show');
      popover.classList.toggle('show', show);
      if (window.LayerManager) {
        if (show) window.LayerManager.open(popover, null, { isPopover: true });
        else window.LayerManager.close(popover);
      }
    });
    window.addEventListener('mousedown', (e) => {
      if (popover.classList.contains('show')) {
        if (!popover.contains(e.target) && !trigger.contains(e.target)) {
          popover.classList.remove('show');
          if (window.LayerManager) window.LayerManager.close(popover);
        }
      }
    });
    wireManualDateInput('bulk-range-trigger', 'bulk_start', 'bulk_target', syncBulkDatePicker, false);
  }
  
  if (start || target) {
    const sPart = start ? formatDisplayDate(start) : '?';
    const tPart = target ? formatDisplayDate(target) : '?';
    trigger.value = `${sPart} — ${tPart}`;
  } else {
    trigger.value = '';
  }
  
  if (!bulkRangePicker) {
    bulkRangePicker = new DateRangePicker('bulk-range-picker', {
      start,
      finish: target,
      onChange: ({start: s, finish: t}) => {
        $('bulk_start').value = s;
        $('bulk_target').value = t;
        syncBulkDatePicker(s, t);
        if (s && t) {
          popover.classList.remove('show');
          if (window.LayerManager) window.LayerManager.close(popover);
        }
      }
    });
  } else {
    bulkRangePicker.setRange(start, target);
  }
}

let setupExpiryPicker = null;
function syncSetupExpiryPicker(expiry) {
  const trigger = $('setup-expiry-trigger');
  const popover = $('setup-expiry-picker');
  if (!trigger || !popover) return;
  
  if (!trigger.dataset.init) {
    trigger.dataset.init = '1';
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const show = !popover.classList.contains('show');
      popover.classList.toggle('show', show);
      if (window.LayerManager) {
        if (show) window.LayerManager.open(popover, null, { isPopover: true });
        else window.LayerManager.close(popover);
      }
    });
    window.addEventListener('mousedown', (e) => {
      if (popover.classList.contains('show')) {
        if (!popover.contains(e.target) && !trigger.contains(e.target)) {
          popover.classList.remove('show');
          if (window.LayerManager) window.LayerManager.close(popover);
        }
      }
    });
    wireManualDateInput('setup-expiry-trigger', 'setup-expiry', null, syncSetupExpiryPicker, true);
  }
  
  if (expiry) {
    trigger.value = formatDisplayDate(expiry);
  } else {
    trigger.value = '';
  }
  
  if (!setupExpiryPicker) {
    setupExpiryPicker = new DateRangePicker('setup-expiry-picker', {
      start: expiry,
      single: true,
      onChange: ({start: d}) => {
        $('setup-expiry').value = d;
        
        $('setup-expiry').dispatchEvent(new Event('input'));
        $('setup-expiry').dispatchEvent(new Event('change'));
        
        syncSetupExpiryPicker(d);
        if (d) {
          popover.classList.remove('show');
          if (window.LayerManager) window.LayerManager.close(popover);
        }
      }
    });
  } else {
    setupExpiryPicker.setRange(expiry, expiry);
  }
}

let sideDuePicker = null;
function syncSideDuePicker(due) {
  const trigger = $('side-due-trigger');
  const popover = $('side-due-picker');
  if (!trigger || !popover) return;
  
  if (!trigger.dataset.init) {
    trigger.dataset.init = '1';
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const show = !popover.classList.contains('show');
      popover.classList.toggle('show', show);
      if (window.LayerManager) {
        if (show) window.LayerManager.open(popover, null, { isPopover: true });
        else window.LayerManager.close(popover);
      }
    });
    window.addEventListener('mousedown', (e) => {
      if (popover.classList.contains('show')) {
        if (!popover.contains(e.target) && !trigger.contains(e.target)) {
          popover.classList.remove('show');
          if (window.LayerManager) window.LayerManager.close(popover);
        }
      }
    });
    wireManualDateInput('side-due-trigger', 's_due', null, syncSideDuePicker, true);
  }
  
  if (due) {
    trigger.value = formatDisplayDate(due);
  } else {
    trigger.value = '';
  }
  
  if (!sideDuePicker || !document.body.contains(sideDuePicker.container)) {
    sideDuePicker = new DateRangePicker('side-due-picker', {
      start: due,
      single: true,
      onChange: ({start: d}) => {
        $('s_due').value = d;
        
        $('s_due').dispatchEvent(new Event('input'));
        $('s_due').dispatchEvent(new Event('change'));
        
        syncSideDuePicker(d);
        if (d) {
          popover.classList.remove('show');
          if (window.LayerManager) window.LayerManager.close(popover);
        }
      }
    });
  } else {
    sideDuePicker.setRange(due, due);
  }
}

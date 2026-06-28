/* Advanced Filter Builder Modal Component */
(function(root) {
  "use strict";

  // Built-in fields that don't need their technical key displayed in the UI dropdown
  const BUILT_IN_FIELDS = new Set([
    'id', 'parent', 'state', 'type', 'priority', 'assigned', 'iteration', 'tags',
    'area', 'title', 'storypoints', 'estimate', 'start', 'target', 'finish', 'due',
    'remaining', 'completed', 'activity', 'risk', 'valuearea', 'desc', 'ac'
  ]);

  // Module level state
  let areaPaths = [];
  let modalElement = null;
  let currentIR = null;
  let activeSavedFilterIndex = null;
  let manageOpener = null;
  let onApplyCallback = null;
  let previewDebounceTimer = null;
  let fieldsList = [];
  let schemaLoaded = false;
  let schemaLoadPromise = null;
  let activeDocumentListeners = [];
  let modalEscapeHandler = null;

  // Returns the maximum number of saved filters allowed.
  // Single source of truth — adjust per subscription tier in the future.
  function getMaxSavedFilters() {
    return 5;
  }

  // Normalizes a filter configuration (full FilterIR or flat group)
  // to a standard FilterIR object structure for robust JSON comparison.
  function normalizeIRForComparison(config) {
    if (!config || typeof config !== 'object') return null;
    let ir = JSON.parse(JSON.stringify(config));
    if (ir.kind === 'group') {
      ir = { where: ir };
    }
    if (!ir.where || ir.where.kind !== 'group') {
      ir.where = { kind: 'group', logic: 'OR', rules: [] };
    }
    if (Array.isArray(ir.where.rules)) {
      if (ir.where.rules.length === 0) {
        ir.where.rules.push({ kind: 'group', logic: 'AND', rules: [] });
      }
    }
    ir.followed = ir.followed || null;
    return ir;
  }

  function addDocListener(type, handler) {
    document.addEventListener(type, handler);
    activeDocumentListeners.push({ type, handler });
  }

  function removeDocListener(type, handler) {
    document.removeEventListener(type, handler);
    activeDocumentListeners = activeDocumentListeners.filter(item => item.handler !== handler);
  }

  function clearAllDocListeners() {
    activeDocumentListeners.forEach(({ type, handler }) => {
      document.removeEventListener(type, handler);
    });
    activeDocumentListeners = [];
  }

  // Escape HTML helper
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // --- Area Paths Loader ---
  async function initAreaPaths() {
    if (areaPaths.length === 0 && window.api && typeof window.api.areas === 'function') {
      try {
        const paths = await window.api.areas();
        areaPaths = paths.map(p => p.path);
      } catch (e) {
        console.warn("Failed to load Area Paths:", e);
      }
    }
  }

  function loadSchemaData(force = false) {
    if (force) {
      schemaLoadPromise = null;
      schemaLoaded = false;
      areaPaths = [];
    }
    if (schemaLoadPromise) return schemaLoadPromise;

    const populatePromise = (window.api && typeof window.api.populateFieldRegistry === 'function')
      ? window.api.populateFieldRegistry().catch(e => console.warn("Failed to populate dynamic field registry:", e))
      : Promise.resolve();

    const areasPromise = initAreaPaths();

    schemaLoadPromise = Promise.all([populatePromise, areasPromise]).then(() => {
      schemaLoaded = true;
      if (window.api && typeof window.api.getFilterFields === 'function') {
        fieldsList = window.api.getFilterFields();
      } else {
        fieldsList = [];
      }
    });

    return schemaLoadPromise;
  }

  // --- Field metadata helpers ---
  function getFieldMeta(fieldId) {
    return fieldsList.find(f => f.id === fieldId) || null;
  }

  function getFieldLabel(field) {
    if (!field) return '';
    const meta = getFieldMeta(field);
    return meta ? meta.displayName : (field.charAt(0).toUpperCase() + field.slice(1));
  }

  // Determine Field Type
  function getFieldType(field) {
    const meta = getFieldMeta(field);
    return meta ? meta.type : 'string';
  }

  function getFieldValues(field) {
    const meta = getFieldMeta(field);
    if (meta && meta.allowedValues && meta.allowedValues.length) {
      return meta.allowedValues;
    }
    if (field === 'assigned') {
      const asg = typeof assignees !== 'undefined' ? assignees : [];
      return ['me', ...asg];
    }
    if (field === 'iteration') {
      return typeof sprintPaths !== 'undefined' ? sprintPaths : [];
    }
    if (field === 'tags') {
      return typeof tagList !== 'undefined' ? tagList : [];
    }
    if (field === 'area') {
      return areaPaths;
    }
    if (getFieldType(field) === 'boolean') {
      return ['True', 'False'];
    }
    return null;
  }

  function getDefaultOperator(field) {
    const type = getFieldType(field);
    if (type === 'tags') return 'CONTAINS';
    if (type === 'tree') return 'UNDER';

    const meta = getFieldMeta(field);
    const hasAllowed = meta && meta.allowedValues && meta.allowedValues.length > 0;

    if ((type === 'string') && !hasAllowed) {
      return 'CONTAINS';
    }
    return '=';
  }


  function validateInput(strategy, val, field) {
    if (!val || typeof val !== 'string') return false;
    if (val.startsWith('@')) {
      const filterFields = window.api ? window.api.FIELD_REGISTRY : null;
      if (window.FilterCompiler) {
        return window.FilterCompiler.validateToken(val, field, filterFields);
      }
      return true; // Fallback if not loaded
    }

    if (strategy === InputStrategies.dateTime) {
      const ms = Date.parse(val);
      if (isNaN(ms)) return false;
      // ADO rejects "2026-". We should ensure it's at least 4 chars.
      return val.length >= 4;
    }
    if (strategy === InputStrategies.numeric) {
      return !isNaN(Number(val));
    }
    if (strategy === InputStrategies.timeMath) {
      if (!isNaN(Number(val))) return true;
      try {
        const mathExpr = window.AdoLib.timeExprToMath(val);
        const num = window.AdoLib.evaluateMath(mathExpr);
        return !isNaN(num);
      } catch (e) {
        return false;
      }
    }
    return true;
  }
  
  function triggerInputError(el) {
    if (!el) return;
    el.classList.remove('error');
    void el.offsetWidth;
    el.classList.add('error');
    setTimeout(() => el.classList.remove('error'), 400);
  }

  // --- State Mutators ---
  async function updateState(mutationFn) {
    if (activeSavedFilterIndex !== null) {
      const draftStr = localStorage.getItem('fbDraftFilter');
      if (draftStr && draftStr !== JSON.stringify(currentIR)) {
        const confirmFn = window.customConfirm;
        const ok = confirmFn
          ? await confirmFn("Making changes to this saved filter will create a new draft. This will overwrite your existing draft filter. Do you want to proceed?", "Modify Loaded Filter")
          : confirm("Making changes to this saved filter will create a new draft. This will overwrite your existing draft filter. Do you want to proceed?");
        if (!ok) return;
        activeSavedFilterIndex = null;
      } else {
        activeSavedFilterIndex = null;
      }
    }
    if (mutationFn) {
      mutationFn();
    }
    renderCards();
    runLivePreview(true);
  }

  function toggleSpacerLogic() {
    currentIR.where.logic = currentIR.where.logic === 'AND' ? 'OR' : 'AND';
  }

  function addGroupCard() {
    currentIR.where.rules.push({
      kind: 'group',
      logic: 'AND',
      rules: []
    });
  }

  function deleteGroupCard(idx) {
    if (currentIR.where.rules.length > 1) {
      currentIR.where.rules.splice(idx, 1);
    }
  }

  function addCondition(cardIdx, field, op, value) {
    if (!value || String(value).trim() === '') return;
    
    const card = currentIR.where.rules[cardIdx];
    
    // Check for empty condition to overwrite
    const emptyCond = card.rules.find(r => r.kind === 'condition' && r.field === field && r.value === '');
    if (emptyCond) {
      emptyCond.op = op;
      emptyCond.value = value;
      return;
    }

    // Try merging with existing condition (IN / NOT IN)
    if (op === '=' || op === 'IN' || op === '<>' || op === 'NOT IN') {
      const isExclude = op === '<>' || op === 'NOT IN';
      const targetOp = isExclude ? 'NOT IN' : 'IN';
      const existing = card.rules.find(r => 
        r.kind === 'condition' && 
        r.field === field && 
        r.value !== '' && 
        (r.op === targetOp || r.op === (isExclude ? '<>' : '='))
      );
      
      if (existing) {
        const currentVals = Array.isArray(existing.value) ? existing.value : [existing.value];
        const newVals = Array.isArray(value) ? value : [value];
        for (const nv of newVals) {
          if (!currentVals.includes(nv)) {
            currentVals.push(nv);
          }
        }
        existing.op = targetOp;
        existing.value = currentVals;
        return;
      }
    }

    // Add new condition
    card.rules.push({
      kind: 'condition',
      field,
      op,
      value
    });
  }

  function removeConditionChip(cardIdx, ruleIdx, valToRemove) {
    const card = currentIR.where.rules[cardIdx];
    const cond = card.rules[ruleIdx];
    if (!cond) return;
    
    if (Array.isArray(cond.value)) {
      cond.value = cond.value.filter(v => v !== valToRemove);
      if (cond.value.length === 1) {
        cond.value = cond.value[0];
        if (cond.op === 'NOT IN') cond.op = '<>';
        else if (cond.op === 'IN') cond.op = '=';
      } else if (cond.value.length === 0) {
        cond.value = '';
      }
    } else {
      cond.value = '';
    }
    
    // Clean up empty conditions if there are multiple for this field
    const field = cond.field;
    const sameFieldConds = card.rules.filter(r => r.kind === 'condition' && r.field === field);
    if (sameFieldConds.length > 1 && cond.value === '') {
      card.rules.splice(ruleIdx, 1);
    }
  }

  function removeFieldRow(cardIdx, field) {
    const card = currentIR.where.rules[cardIdx];
    card.rules = card.rules.filter(r => !(r.kind === 'condition' && r.field === field));
  }

  function toggleConditionState(cardIdx, ruleIdx, val) {
    const card = currentIR.where.rules[cardIdx];
    const cond = card.rules[ruleIdx];
    if (!cond) return;
    
    const oppositeOpMap = {
      '=': '<>',
      '<>': '=',
      'IN': 'NOT IN',
      'NOT IN': 'IN',
      'CONTAINS': 'NOT CONTAINS',
      'NOT CONTAINS': 'CONTAINS',
      'UNDER': 'NOT UNDER',
      'NOT UNDER': 'UNDER',
      '>': '<=',
      '<=': '>',
      '<': '>=',
      '>=': '<'
    };
    
    const op = cond.op;
    const targetOp = oppositeOpMap[op];
    if (!targetOp) return;

    if (Array.isArray(cond.value)) {
      if (val) {
        cond.value = cond.value.filter(v => v !== val);
        if (cond.value.length === 1) {
          cond.value = cond.value[0];
          if (op === 'NOT IN') cond.op = '<>';
          else if (op === 'IN') cond.op = '=';
        } else if (cond.value.length === 0) {
          cond.value = '';
        }

        const field = cond.field;
        const sameFieldConds = card.rules.filter(r => r.kind === 'condition' && r.field === field);
        if (sameFieldConds.length > 1 && cond.value === '') {
          const idx = card.rules.indexOf(cond);
          if (idx !== -1) {
            card.rules.splice(idx, 1);
          }
        }

        const scalarTargetOp = (op === 'NOT IN' || op === '<>') ? '=' : '<>';
        addCondition(cardIdx, cond.field, scalarTargetOp, val);
      }
    } else {
      cond.op = targetOp;
    }
  }

  // --- Field Input Strategy Pattern ---
  const InputStrategies = {
    dateTime: {
      render(cardIdx, field) {
        if (!schemaLoaded) {
          return `
            <div class="f-dropdown-container fb-date-picker-row" style="position: relative; display: inline-flex; align-items: center; gap: 6px;">
              <input type="text" class="tag-search" placeholder="Loading schema..." disabled style="width: 100px;">
              <span class="spin" style="width: 12px; height: 12px; border-width: 1.5px;"></span>
            </div>
          `;
        }
        return `
          <div class="f-dropdown-container fb-date-picker-row" style="position: relative; display: inline-flex; align-items: center; gap: 4px;">
            <input type="hidden" id="fb-val-${cardIdx}-${field}">
            <input type="text" class="tag-search" id="fb-val-${cardIdx}-${field}_trigger" placeholder="Add date..." autocomplete="off" style="width: 100px;">
            <button type="button" class="btn-apply-chip" id="fb-apply-btn-${cardIdx}-${field}" title="Apply">✓</button>
            <div id="fb-val-${cardIdx}-${field}_picker" class="drp-popover" style="position: absolute; z-index: 1010;"></div>
          </div>
        `;
      },
      wire(cardIdx, field) {
        if (!schemaLoaded) return;
        const baseId = `fb-val-${cardIdx}-${field}`;
        const trigger = document.getElementById(baseId + '_trigger');
        const popover = document.getElementById(baseId + '_picker');
        const applyBtn = document.getElementById(`fb-apply-btn-${cardIdx}-${field}`);
        if (!trigger || !popover) return;

        trigger.onclick = (e) => {
          e.stopPropagation();
          const show = !popover.classList.contains('show');
          popover.classList.toggle('show', show);
          popover.style.display = show ? 'block' : '';
          if (window.LayerManager) {
            if (show) window.LayerManager.open(popover, null, { isPopover: true });
            else window.LayerManager.close(popover);
          }
        };

        const onMouseDownDate = (e) => {
          if (popover.classList.contains('show')) {
            if (!popover.contains(e.target) && !trigger.contains(e.target) && (!applyBtn || !applyBtn.contains(e.target))) {
              popover.classList.remove('show');
              popover.style.display = '';
              if (window.LayerManager) window.LayerManager.close(popover);
              removeDocListener('mousedown', onMouseDownDate);
            }
          }
        };
        
        trigger.addEventListener('focus', () => {
          addDocListener('mousedown', onMouseDownDate);
        });

        const submitManualDate = () => {
          const val = trigger.value.trim();
          if (val) {
            const parsed = window.AdoLib.parseOperatorValue(val);
            let dateStr = parsed.value.trim();
            if (dateStr) {
              if (!validateInput(InputStrategies.dateTime, dateStr, field)) {
                triggerInputError(trigger);
                return;
              }
              if (!dateStr.startsWith('@')) {
                const d = new Date(dateStr);
                if (!isNaN(d.getTime())) {
                  dateStr = d.toLocaleDateString('en-US');
                }
              }
              let op = parsed.op;
              if (op === '=') {
                op = getDefaultOperator(field);
              }
              updateState(() => addCondition(cardIdx, field, op, dateStr));
              trigger.value = '';
              popover.classList.remove('show');
              popover.style.display = '';
              if (window.LayerManager) window.LayerManager.close(popover);
            }
          }
        };

        if (applyBtn) {
          applyBtn.onclick = (e) => {
            e.stopPropagation();
            submitManualDate();
          };
        }

        trigger.onkeydown = (e) => {
          if (e.key === 'Enter') {
            submitManualDate();
          }
        };

        new window.DateRangePicker(baseId + '_picker', {
          single: false,
          onChange: (range) => {
            const start = range.start;
            const finish = range.finish;
            if (start && finish) {
              updateState(() => {
                if (start === finish) {
                  addCondition(cardIdx, field, '=', start);
                } else {
                  addCondition(cardIdx, field, 'RANGE', `${start}...${finish}`);
                }
              });
              trigger.value = '';
              popover.classList.remove('show');
              popover.style.display = '';
              if (window.LayerManager) window.LayerManager.close(popover);
            }
          }
        });
      }
    },

    picker: {
      render(cardIdx, field) {
        if (!schemaLoaded) {
          return `
            <div class="f-dropdown-container fb-card-picker-row" style="position: relative; display: inline-flex; align-items: center; gap: 6px;">
              <input class="tag-search" placeholder="Loading schema..." disabled autocomplete="off" style="font-size: 11px; padding: 2px 8px; min-height: 22px; height: 22px; line-height: 18px; border: 1px solid var(--line); border-radius: 4px; background: var(--panel);">
              <span class="spin" style="width: 12px; height: 12px; border-width: 1.5px;"></span>
            </div>
          `;
        }
        return `
          <div class="f-dropdown-container fb-card-picker-row" style="position: relative; display: inline-flex; align-items: center; gap: 4px;">
            <input type="text" id="fb-val-${cardIdx}-${field}" class="tag-search" placeholder="Choose..." autocomplete="off">
            <button type="button" class="btn-apply-chip" id="fb-apply-btn-${cardIdx}-${field}" title="Apply">✓</button>
            <div id="fb-val-${cardIdx}-${field}_pick" class="ppick" style="display:none; position:absolute; left:0; top:100%; z-index:1010;">
              <div id="fb-val-${cardIdx}-${field}_results" class="presults"></div>
            </div>
          </div>
        `;
      },
      wire(cardIdx, field) {
        if (!schemaLoaded) return;
        const baseId = `fb-val-${cardIdx}-${field}`;
        const inputEl = document.getElementById(baseId);
        const applyBtn = document.getElementById(`fb-apply-btn-${cardIdx}-${field}`);
        
        const submitValue = () => {
          const val = inputEl ? inputEl.value.trim() : '';
          if (val) {
            const parsed = window.AdoLib.parseOperatorValue(val);
            const str = parsed.value.trim();
            if (!validateInput(InputStrategies.picker, str, field)) {
              triggerInputError(inputEl);
              return;
            }
            
            const isNumericField = (type === 'numeric' || rawType === 'integer' || rawType === 'double');
            if (isNumericField && isNaN(Number(str)) && !str.startsWith('@')) {
              triggerInputError(inputEl);
              return;
            }
            
            if (field === 'iteration' && !str.startsWith('@') && window.sprintPaths) {
              if (!window.sprintPaths.some(p => p.toLowerCase() === str.toLowerCase())) {
                triggerInputError(inputEl);
                return;
              }
            }
            let op = parsed.op;
            if (op === '=') op = getDefaultOperator(field);
            
            updateState(() => addCondition(cardIdx, field, op, str));
            if (picker) {
              picker.set('', true);
            } else {
              inputEl.value = '';
            }
          }
        };

        const opts = {
          keepTextOnClose: true,
          onChange: submitValue
        };
        
        let picker;
        const type = getFieldType(field);
        const rawType = (window.api && window.api.FIELD_REGISTRY && window.api.FIELD_REGISTRY[field]) 
          ? window.api.FIELD_REGISTRY[field].type 
          : null;

        if (field === 'assigned' || type === 'user' || rawType === 'identity') {
          picker = window.createAssigneeField(baseId, opts);
        } else if (field === 'iteration') {
          picker = window.createSprintField(baseId, opts);
        } else if (field === 'parent' || field === 'id') {
          picker = window.createParentField(baseId, opts);
        }
        
        if (picker) {
          picker.wire();
          picker.render();
        }

        if (applyBtn) {
          applyBtn.onclick = (e) => {
            e.stopPropagation();
            submitValue();
          };
        }

        if (inputEl) {
          inputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submitValue();
            }
          });
        }
      }
    },

    autocomplete: {
      render(cardIdx, field) {
        if (!schemaLoaded) {
          return `
            <div class="f-dropdown-container" style="display: inline-flex; align-items: center; gap: 6px;">
              <input class="tag-search" placeholder="Loading schema..." disabled autocomplete="off">
              <span class="spin" style="width: 12px; height: 12px; border-width: 1.5px;"></span>
            </div>
          `;
        }
        return `
          <div class="f-dropdown-container" style="display: inline-flex; align-items: center; gap: 4px; position: relative;">
            <input id="fb-input-${cardIdx}-${field}" class="tag-search" placeholder="Add value..." autocomplete="off">
            <button type="button" class="btn-apply-chip" id="fb-apply-btn-${cardIdx}-${field}" title="Apply">✓</button>
            <div id="fb-dropdown-${cardIdx}-${field}" class="f-dropdown" style="display:none"></div>
          </div>
        `;
      },
      wire(cardIdx, field) {
        if (!schemaLoaded) return;
        const inputEl = document.getElementById(`fb-input-${cardIdx}-${field}`);
        const dropdownEl = document.getElementById(`fb-dropdown-${cardIdx}-${field}`);
        const applyBtn = document.getElementById(`fb-apply-btn-${cardIdx}-${field}`);
        if (!inputEl || !dropdownEl) return;

        const vals = getFieldValues(field);

        const showMatches = (q) => {
          if (!vals || !vals.length) return;
          const query = q.toLowerCase().trim();
          const matches = vals.filter(v => String(v).toLowerCase().includes(query));
          
          dropdownEl.innerHTML = '';
          if (matches.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'f-dropdown-item empty';
            empty.textContent = 'No matches';
            dropdownEl.appendChild(empty);
          } else {
            matches.forEach(val => {
              const item = document.createElement('div');
              item.className = 'f-dropdown-item';
              item.textContent = String(val);
              item.onmousedown = (e) => {
                e.preventDefault();
                updateState(() => addCondition(cardIdx, field, getDefaultOperator(field), val));
                inputEl.value = '';
                hideDropdown();
              };
              dropdownEl.appendChild(item);
            });
          }
          
          dropdownEl.style.display = 'flex';
          if (window.LayerManager) {
            window.LayerManager.open(dropdownEl, null, { isPopover: true });
          }
          dropdownEl.style.left = '0';
          dropdownEl.style.top = '100%';
        };

        const hideDropdown = () => {
          dropdownEl.style.display = 'none';
          if (window.LayerManager) {
            window.LayerManager.close(dropdownEl);
          }
        };

        inputEl.onfocus = () => showMatches(inputEl.value);
        inputEl.oninput = () => showMatches(inputEl.value);
        
        const submitValue = () => {
          const val = inputEl.value.trim();
          if (val) {
            const parsed = window.AdoLib.parseOperatorValue(val);
            let op = parsed.op;
            let cleanVal = parsed.value;
            if (op === '=') {
              op = getDefaultOperator(field);
            }
            updateState(() => addCondition(cardIdx, field, op, cleanVal));
            inputEl.value = '';
            hideDropdown();
          }
        };

        if (applyBtn) {
          applyBtn.onclick = (e) => {
            e.stopPropagation();
            submitValue();
          };
        }

        inputEl.onkeydown = (e) => {
          if (e.key === 'Enter') {
            submitValue();
          } else if (e.key === 'Escape') {
            e.stopPropagation();
            hideDropdown();
          }
        };

        const onMouseDown = (e) => {
          if (!inputEl.contains(e.target) && !dropdownEl.contains(e.target) && (!applyBtn || !applyBtn.contains(e.target))) {
            hideDropdown();
            removeDocListener('mousedown', onMouseDown);
          }
        };
        
        inputEl.addEventListener('focus', () => {
          addDocListener('mousedown', onMouseDown);
        });
      }
    },

    numeric: {
      render(cardIdx, field) {
        if (!schemaLoaded) {
          return `
            <div class="f-dropdown-container" style="display: inline-flex; align-items: center; gap: 6px;">
              <input type="text" class="tag-search" placeholder="Loading schema..." disabled>
              <span class="spin" style="width: 12px; height: 12px; border-width: 1.5px;"></span>
            </div>
          `;
        }
        return `
          <div class="f-dropdown-container" style="display: inline-flex; align-items: center; gap: 4px;">
            <input id="fb-input-${cardIdx}-${field}" type="text" class="tag-search" placeholder="Add value..." autocomplete="off">
            <button type="button" class="btn-apply-chip" id="fb-apply-btn-${cardIdx}-${field}" title="Apply">✓</button>
          </div>
        `;
      },
      wire(cardIdx, field) {
        if (!schemaLoaded) return;
        const inputEl = document.getElementById(`fb-input-${cardIdx}-${field}`);
        const applyBtn = document.getElementById(`fb-apply-btn-${cardIdx}-${field}`);
        if (!inputEl) return;

        const submitValue = () => {
          const val = inputEl.value.trim();
          if (val) {
            const parsed = window.AdoLib.parseOperatorValue(val);
            const numStr = String(parsed.value).trim();
            if (numStr !== '') {
              if (!validateInput(InputStrategies.numeric, numStr, field)) {
                triggerInputError(inputEl);
                return;
              }
              let op = parsed.op;
              if (op === '=') {
                op = getDefaultOperator(field);
              }
              updateState(() => addCondition(cardIdx, field, op, numStr));
              inputEl.value = '';
            }
          }
        };

        if (applyBtn) {
          applyBtn.onclick = (e) => {
            e.stopPropagation();
            submitValue();
          };
        }

        inputEl.onkeydown = (e) => {
          if (e.key === 'Enter') {
            submitValue();
          }
        };
      }
    },

    timeMath: {
      render(cardIdx, field) {
        if (!schemaLoaded) {
          return `
            <div class="f-dropdown-container" style="display: inline-flex; align-items: center; gap: 6px;">
              <input type="text" class="tag-search" placeholder="Loading schema..." disabled>
              <span class="spin" style="width: 12px; height: 12px; border-width: 1.5px;"></span>
            </div>
          `;
        }
        return `
          <div class="f-dropdown-container" style="display: inline-flex; align-items: center; gap: 4px;">
            <div class="time-input-wrap">
              <input id="fb-input-${cardIdx}-${field}" type="text" class="tag-search" placeholder="Add value..." autocomplete="off">
              <span class="time-hint-icon" title="Supports math expressions: h (hours), d (days = 8h), w (weeks = 40h), e.g. 1d + 4h"><ui-icon name="clock"></ui-icon></span>
            </div>
            <button type="button" class="btn-apply-chip" id="fb-apply-btn-${cardIdx}-${field}" title="Apply">✓</button>
          </div>
        `;
      },
      wire(cardIdx, field) {
        if (!schemaLoaded) return;
        const inputEl = document.getElementById(`fb-input-${cardIdx}-${field}`);
        const applyBtn = document.getElementById(`fb-apply-btn-${cardIdx}-${field}`);
        if (!inputEl) return;

        const submitValue = () => {
          const val = inputEl.value.trim();
          if (val) {
            const parsed = window.AdoLib.parseOperatorValue(val);
            const timeExpr = String(parsed.value).trim();
            if (timeExpr) {
              if (!validateInput(InputStrategies.timeMath, timeExpr, field)) {
                triggerInputError(inputEl);
                return;
              }
              let op = parsed.op;
              if (op === '=') {
                op = getDefaultOperator(field);
              }
              if (timeExpr.startsWith('@')) {
                updateState(() => addCondition(cardIdx, field, op, timeExpr));
                inputEl.value = '';
              } else {
                const mathExpr = window.AdoLib.timeExprToMath(timeExpr, 8);
                const total = window.AdoLib.evaluateMath(mathExpr);
                if (!isNaN(total) && isFinite(total)) {
                  const numStr = String(Number(total.toFixed(2)));
                  updateState(() => addCondition(cardIdx, field, op, numStr));
                  inputEl.value = '';
                } else {
                  triggerInputError(inputEl);
                }
              }
            }
          }
        };

        if (applyBtn) {
          applyBtn.onclick = (e) => {
            e.stopPropagation();
            submitValue();
          };
        }

        inputEl.onkeydown = (e) => {
          if (e.key === 'Enter') {
            submitValue();
          }
        };
      }
    },

    booleanDropdown: {
      render(cardIdx, field) {
        if (!schemaLoaded) {
          return `
            <div class="f-dropdown-container" style="display: inline-flex; align-items: center; gap: 6px;">
              <select class="tag-search" disabled style="width: 80px;">
                <option>Loading...</option>
              </select>
              <span class="spin" style="width: 12px; height: 12px; border-width: 1.5px;"></span>
            </div>
          `;
        }
        return `
          <div class="f-dropdown-container">
            <select id="fb-select-${cardIdx}-${field}" class="tag-search" style="width: 80px; padding: 2px 8px; cursor: pointer;">
              <option value="" disabled selected hidden>Select...</option>
              <option value="True">True</option>
              <option value="False">False</option>
            </select>
          </div>
        `;
      },
      wire(cardIdx, field) {
        if (!schemaLoaded) return;
        const selectEl = document.getElementById(`fb-select-${cardIdx}-${field}`);
        if (!selectEl) return;

        selectEl.onchange = () => {
          const val = selectEl.value;
          if (val) {
            updateState(() => addCondition(cardIdx, field, getDefaultOperator(field), val));
            selectEl.value = '';
          }
        };
      }
    }
  };

  function isTimeMathField(field) {
    if (!field) return false;
    const timeFields = ['remaining', 'estimate', 'completed', 'storypoints'];
    const timeRefs = [
      'microsoft.vsts.scheduling.remainingwork',
      'microsoft.vsts.scheduling.originalestimate',
      'microsoft.vsts.scheduling.completedwork',
      'microsoft.vsts.scheduling.storypoints'
    ];
    const timeLabels = [
      'remaining work',
      'original estimate',
      'completed work',
      'story points'
    ];

    if (timeFields.includes(field)) return true;

    const meta = getFieldMeta(field);
    if (meta) {
      if (meta.ref && timeRefs.includes(meta.ref.toLowerCase())) return true;
      if (meta.displayName && timeLabels.includes(meta.displayName.toLowerCase())) return true;
    }
    
    const label = getFieldLabel(field);
    if (label && timeLabels.includes(label.toLowerCase())) return true;

    return false;
  }

  function getInputStrategy(field) {
    if (isTimeMathField(field)) {
      return InputStrategies.timeMath;
    }

    const type = getFieldType(field);
    const rawType = (window.api && window.api.FIELD_REGISTRY && window.api.FIELD_REGISTRY[field]) 
      ? window.api.FIELD_REGISTRY[field].type 
      : null;

    if (type === 'date' || type === 'dateTime' || rawType === 'dateTime') {
      return InputStrategies.dateTime;
    }
    if (type === 'user' || rawType === 'identity' || field === 'assigned' || field === 'iteration' || field === 'parent' || field === 'id') {
      return InputStrategies.picker;
    }
    if (type === 'number' || rawType === 'integer' || rawType === 'double') {
      return InputStrategies.numeric;
    }
    if (type === 'boolean' || rawType === 'boolean') {
      return InputStrategies.booleanDropdown;
    }
    return InputStrategies.autocomplete;
  }

  function getTooltipHtml(field) {
    const filterFields = (window.api && window.api.FIELD_REGISTRY) || {};
    let ops = [];
    let macros = [];
    if (window.FilterCompiler) {
      ops = window.FilterCompiler.getSupportedOperators(field, filterFields);
      macros = window.FilterCompiler.getSupportedMacros(field, filterFields);
    }

    let html = 'Values within a field are joined by <b>OR</b>.<br>';
    if (ops.length > 0) {
      const opsFormatted = ops.map(op => op.replace(/</g, '&lt;').replace(/>/g, '&gt;'));
      html += '<br><b>Supported Operators:</b><br><code>' + opsFormatted.join(', ') + '</code>';
    }
    if (macros.length > 0) {
      html += '<br><br><b>Supported Macros:</b><br><code>' + macros.join(', ') + '</code>';
    }

    const strategy = getInputStrategy(field);
    if (strategy === InputStrategies.timeMath) {
      html += '<br><br><i>Supports math: 1d 4h</i>';
    }

    return html;
  }

  // --- Rendering Helpers ---
  function getAvailableFieldsForCard(card) {
    const existingFields = card.rules.map(r => r.field);
    const registryKeys = fieldsList.map(f => f.id);
    const available = registryKeys.filter(f => !existingFields.includes(f));
    available.sort((a, b) => getFieldLabel(a).localeCompare(getFieldLabel(b)));
    return available;
  }

  function renderChipsHtml(cardIdx, ruleIdx, rule) {
    if (rule.value === '') return '';
    const isExclude = ['<>', 'NOT IN', 'NOT CONTAINS', 'NOT UNDER', '<', '>'].includes(rule.op);
    let chipsHtml = '';

    
    const type = getFieldType(rule.field);
    const formatValue = (v) => {
      if (type === 'dateTime' && typeof v === 'string' && !v.startsWith('@')) {
        const d = new Date(v);
        if (!isNaN(d.getTime())) return d.toLocaleDateString();
      }
      return v;
    };
    
    if (Array.isArray(rule.value)) {
      rule.value.forEach(val => {
        chipsHtml += `
          <span class="chip ${isExclude ? 'out' : 'in'}" id="fb-chip-${cardIdx}-${ruleIdx}-${val}">
            <span>${htmlEsc(String(formatValue(val)))}</span>
            <span class="fb-chip-delete" data-card="${cardIdx}" data-rule="${ruleIdx}" data-val="${htmlEsc(String(val))}">&times;</span>
          </span>
        `;
      });
    } else {
      const cleanOp = rule.op.replace('NOT ', '');
      const displayOp = (cleanOp === '=' || cleanOp === '<>' || cleanOp === 'IN') ? '' : cleanOp + ' ';
      chipsHtml += `
        <span class="chip ${isExclude ? 'out' : 'in'}" id="fb-chip-${cardIdx}-${ruleIdx}">
          <span>${displayOp}${htmlEsc(String(formatValue(rule.value)))}</span>
          <span class="fb-chip-delete" data-card="${cardIdx}" data-rule="${ruleIdx}">&times;</span>
        </span>
      `;
    }
    return chipsHtml;
  }

  function createModalHtml() {
    return `
      <div id="filter-builder-backdrop" style="display:none">
        <div id="filter-builder-box">
          <div class="fb-header">
            <div style="display:flex; align-items:center; gap:8px;">
              <h2>Advanced Filter Builder</h2>
              <button class="fb-help-btn" id="fb-help-btn" title="Syntax Help"><ui-icon name="help"></ui-icon></button>
            </div>
            <div style="display:flex; align-items:center; gap:8px;">
              <a class="fb-icon-btn" href="https://github.com/Prorok1015/ado-atlas/issues" target="_blank" title="Report a Bug">
                <ui-icon name="bug"></ui-icon>
              </a>
              <button class="fb-close-btn" id="fb-close-btn"><ui-icon name="x"></ui-icon></button>
            </div>
          </div>
          <div id="fb-draft-banner" style="display:none; background:rgba(230, 126, 34, 0.1); color:#e67e22; padding:8px 16px; border-bottom:1px solid rgba(230, 126, 34, 0.3); align-items:center; justify-content:space-between; font-size:0.85rem;">
            <div><strong>Draft Restored</strong> — You have unapplied changes.</div>
            <button id="fb-discard-draft-btn" style="background:transparent; border:1px solid #e67e22; color:#e67e22; border-radius:4px; padding:4px 8px; cursor:pointer; font-size:0.8rem; transition:all 0.2s;">Discard Draft</button>
          </div>
          <div id="fb-ai-banner" style="display:none; background:rgba(114, 9, 183, 0.1); color:#a855f7; padding:8px 16px; border-bottom:1px solid rgba(114, 9, 183, 0.3); align-items:center; justify-content:space-between; font-size:0.85rem;">
            <div style="display:flex; align-items:center; gap:6px;"><span style="color:#a855f7; display:flex;"><ui-icon name="sparkles"></ui-icon></span> <strong>AI Search result is ready!</strong> — Click apply to load the generated filters.</div>
            <div style="display:flex; gap:6px;">
              <button id="fb-discard-ai-btn" style="background:transparent; border:1px solid rgba(114, 9, 183, 0.4); color:#a855f7; border-radius:4px; padding:4px 8px; cursor:pointer; font-size:0.8rem; transition:all 0.2s;">Dismiss</button>
              <button id="fb-apply-ai-btn" style="background:#7209b7; border:none; color:#fff; border-radius:4px; padding:4px 8px; cursor:pointer; font-size:0.8rem; transition:all 0.2s;">Apply AI Filter</button>
            </div>
          </div>
          <div class="fb-main-content">
            <div class="fb-body" id="fb-cards-container">
              <!-- Group cards rendered here -->
            </div>
            <div class="fb-preview-resizer" id="fb-preview-resizer"></div>
            <div class="fb-preview-panel">
              <div class="fb-preview-header">
                <div style="display:flex; align-items:center; gap:6px;">
                  <button id="fb-preview-toggle-btn" class="fb-icon-btn" style="margin:0; border:none;" title="Toggle Preview Sidebar">
                    <ui-icon name="chevron-right"></ui-icon>
                  </button>
                  <span class="preview-title">Preview</span>
                </div>
                <span id="fb-preview-count">0 items</span>
              </div>
              <div class="fb-preview-list" id="fb-preview-list">
                <div style="color:var(--muted); text-align:center; padding-top:20px;">No results matching filters</div>
              </div>
            </div>

                

            <div id="fb-preview-tab" class="fb-preview-tab" title="Open Preview">
              <ui-icon name="chevron-right"></ui-icon>
            </div>
          </div>
          <div class="fb-footer">
            <div class="fb-footer-left" style="display:flex; align-items:center; gap:8px;">
              <button class="fb-ie-btn fb-ie-btn--outline" id="fb-show-followed" style="display:flex; align-items:center; gap:6px;">
                <span class="fb-toggle-icon"><ui-icon name="star"></ui-icon></span>
                Only followed items
              </button>
              <button class="fb-ie-btn fb-ie-btn--outline" id="fb-ai-search-btn" style="position:relative; display:flex; align-items:center; gap:6px; background: linear-gradient(135deg, rgba(114,9,183,0.1), rgba(63,55,201,0.1)); border-color: rgba(99,102,241,0.3);" title="AI Search over work items (BETA)">
                <span style="color:#a855f7; display: flex; align-items: center;"><ui-icon name="sparkles"></ui-icon></span>
                AI Search...
                <span class="ai-beta-badge-tiny" style="position: absolute; top: -0.385rem; right: -0.385rem; font-size: 0.615rem; padding: 0 0.231rem;">BETA</span>
              </button>
            </div>
            <div class="fb-actions" style="display:flex; gap:8px;">
              <button class="fb-ie-btn fb-ie-btn--ghost" id="fb-manage-btn" title="Manage Saved Filters & Import/Export"><ui-icon name="folder"></ui-icon> Manage</button>
              <button class="fb-ie-btn fb-ie-btn--ghost" id="fb-save-btn" title="Save Current Filter"><ui-icon name="save"></ui-icon> Save</button>
              <button class="fb-ie-btn fb-ie-btn--outline" id="fb-cancel-btn">Cancel</button>
              <button class="fb-ie-btn fb-ie-btn--accent" id="fb-apply-btn">Apply Filter</button>
            </div>
          </div>
          
          <!-- Save Filter Dialog -->
          <div id="fb-save-dialog" style="display:none; position:absolute; inset:0; background:rgba(0,0,0,0.5); align-items:center; justify-content:center; z-index:100; backdrop-filter: blur(2px);">
            <div style="background:var(--panel); padding:20px; border-radius:10px; border:1px solid var(--line); width:300px; box-shadow: 0 10px 30px rgba(0,0,0,0.5);">
              <h3 style="margin-top:0; font-size:1rem; letter-spacing:0.3px;">Save Filter</h3>
              <input type="text" id="fb-save-name" placeholder="Filter Name..." class="tag-search" style="margin:12px 0; width:100%; box-sizing:border-box;">
              <div style="display:flex; justify-content:flex-end; gap:6px;">
                <button class="fb-ie-btn fb-ie-btn--outline" id="fb-save-cancel">Cancel</button>
                <button class="fb-ie-btn fb-ie-btn--accent" id="fb-save-confirm">Save</button>
              </div>
            </div>
          </div>

          <!-- Manage Filter Dialog -->
          <div id="fb-manage-dialog" class="fb-manage-dialog-overlay" style="display:none;">
            <div class="fb-manage-dialog-card">
              <div class="fb-manage-dialog-header">
                <h3>Manage Filters</h3>
                <button class="fb-close-btn" id="fb-manage-close">&times;</button>
              </div>
              
              <div class="fb-manage-tabs">
                <button class="fb-manage-tab active" id="fb-tab-list-btn"><ui-icon name="folder"></ui-icon> Saved Filters <span id="fb-saved-count" class="fb-saved-count"></span></button>
                <button class="fb-manage-tab" id="fb-tab-ie-btn"><ui-icon name="copy"></ui-icon> Import / Export</button>
              </div>
              
              <div id="fb-manage-pane-list" class="fb-manage-pane" style="display:flex;">
                <div id="fb-manage-list" class="fb-manage-list">
                  <!-- list renders here -->
                </div>
              </div>
              
              <div id="fb-manage-pane-ie" class="fb-manage-pane" style="display:none;">
                <div class="fb-ie-toolbar">
                  <div class="fb-ie-toolbar-start">
                    <button class="fb-ie-btn fb-ie-btn--ghost" id="fb-ie-paste"><ui-icon name="copy"></ui-icon> Paste</button>
                    <button class="fb-ie-btn fb-ie-btn--ghost" id="fb-ie-file-import"><ui-icon name="upload"></ui-icon> Import File</button>
                    <input type="file" id="fb-ie-file-input" accept=".json" style="display:none;" />
                  </div>
                  <div class="fb-ie-toolbar-end">
                    <button class="fb-ie-btn fb-ie-btn--icon" id="fb-ie-format" title="Format JSON"><ui-icon name="ruler"></ui-icon></button>
                    <button class="fb-ie-btn fb-ie-btn--icon" id="fb-ie-clear" title="Clear Text"><ui-icon name="trash"></ui-icon></button>
                  </div>
                </div>
                <textarea id="fb-ie-text" class="fb-ie-textarea" rows="8" placeholder="Paste FilterIR JSON here..."></textarea>
                <div id="fb-ie-status" class="fb-ie-status"></div>
                <div class="fb-ie-actions">
                  <div class="fb-ie-actions-secondary">
                    <button class="fb-ie-btn fb-ie-btn--ghost" id="fb-ie-copy"><ui-icon name="copy"></ui-icon> Copy</button>
                    <button class="fb-ie-btn fb-ie-btn--ghost" id="fb-ie-export" disabled><ui-icon name="download"></ui-icon> Export</button>
                  </div>
                  <div class="fb-ie-actions-primary">
                    <button class="fb-ie-btn fb-ie-btn--outline" id="fb-ie-import" disabled>Import to Builder</button>
                    <button class="fb-ie-btn fb-ie-btn--accent" id="fb-ie-apply" disabled>Apply & Execute</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
          </div>
        </div>
      </div>
    `;
  }

  function ensureModalElement() {
    if (!modalElement) {
      const div = document.createElement('div');
      div.innerHTML = createModalHtml();
      document.body.appendChild(div.firstElementChild);
      modalElement = document.getElementById('filter-builder-backdrop');

      
  function flashSuccess(btn, originalText) {
    if (!btn) return;
    const prevBg = btn.style.background;
    const prevCol = btn.style.color;
    btn.style.background = '#27ae60';
    btn.style.color = 'white';
    btn.innerHTML = '<ui-icon name="check-circle"></ui-icon> Success';
    setTimeout(() => {
      btn.style.background = prevBg;
      btn.style.color = prevCol;
      btn.innerHTML = originalText;
    }, 1500);
  }

  function flashCopySuccess(btn, originalText, isTextButton) {
    if (!btn) return;
    btn.innerHTML = isTextButton ? '<ui-icon name="check"></ui-icon> Copied' : '<ui-icon name="check"></ui-icon>';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.innerHTML = originalText;
      btn.classList.remove('copied');
    }, 1200);
  }



      // Save Filter Logic
      const saveBtn = document.getElementById('fb-save-btn');
      const saveDialog = document.getElementById('fb-save-dialog');
      const saveInput = document.getElementById('fb-save-name');
      if (saveBtn && saveDialog && saveInput) {
        saveBtn.onclick = () => {
          saveInput.value = '';
          const oldMsg = saveDialog.querySelector('.fb-save-limit-msg');
          if (oldMsg) oldMsg.remove();
          saveDialog.style.display = 'flex';
          saveInput.focus();
        };
        
        document.getElementById('fb-save-cancel').onclick = () => {
          saveDialog.style.display = 'none';
        };

        saveDialog.onclick = (e) => {
          if (e.target === saveDialog) {
            e.stopPropagation();
            saveDialog.style.display = 'none';
          }
        };
        
        const doActualSave = () => {
          const name = saveInput.value.trim();
          if (!name) return;
          const storage = (window.chrome && chrome.storage && chrome.storage.sync) || null;
          
          const doSave = (savedFilters) => {
            const maxFilters = getMaxSavedFilters();
            if (savedFilters.length >= maxFilters) {
              // Show a clear message about the saved filters limit
              let statusEl = saveDialog.querySelector('.fb-save-limit-msg');
              if (!statusEl) {
                statusEl = document.createElement('div');
                statusEl.className = 'fb-save-limit-msg';
                statusEl.style.cssText = 'color:#e74c3c; font-size:0.85rem; margin-bottom:8px; display:flex; align-items:center; gap:6px;';
                saveInput.parentNode.insertBefore(statusEl, saveInput.nextSibling);
              }
              statusEl.innerHTML = `<ui-icon name="alert-triangle"></ui-icon> You already have ${savedFilters.length}/${maxFilters} saved filters. Delete one to save a new one.`;
              saveInput.classList.add('error');
              setTimeout(() => saveInput.classList.remove('error'), 1500);
              return;
            }
            savedFilters.push({ id: Date.now().toString(), name, config: JSON.parse(JSON.stringify(currentIR)) });
            if (storage) {
              storage.set({ fbSavedFilters: savedFilters }, () => {
                saveDialog.style.display = 'none';
                flashSuccess(saveBtn, '<ui-icon name="save"></ui-icon> Save');
              });
            } else {
              localStorage.setItem('fbSavedFilters', JSON.stringify(savedFilters));
              saveDialog.style.display = 'none';
              flashSuccess(saveBtn, '<ui-icon name="save"></ui-icon> Save');
            }
          };

          if (storage) {
            storage.get(['fbSavedFilters'], (res) => doSave(res.fbSavedFilters || []));
          } else {
            doSave(JSON.parse(localStorage.getItem('fbSavedFilters') || '[]'));
          }
        };

        document.getElementById('fb-save-confirm').onclick = doActualSave;
        
        saveInput.onkeydown = (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            doActualSave();
          }
          if (e.key === 'Escape') {
            e.stopPropagation();
            saveDialog.style.display = 'none';
          }
        };
      }

      // Manage Filter Logic
      const manageBtn = document.getElementById('fb-manage-btn');
      const manageDialog = document.getElementById('fb-manage-dialog');
      const manageList = document.getElementById('fb-manage-list');
      const ieText = document.getElementById('fb-ie-text');
      if (manageBtn && manageDialog && manageList && ieText) {
        const tabListBtn = document.getElementById('fb-tab-list-btn');
        const tabIeBtn = document.getElementById('fb-tab-ie-btn');
        const paneList = document.getElementById('fb-manage-pane-list');
        const paneIe = document.getElementById('fb-manage-pane-ie');

         const setTab = (activeTab) => {
           if (activeTab === 'list') {
             if (tabListBtn) tabListBtn.classList.add('active');
             if (tabIeBtn) tabIeBtn.classList.remove('active');
             if (paneList) paneList.style.display = 'flex';
             if (paneIe) paneIe.style.display = 'none';
           } else {
             if (tabListBtn) tabListBtn.classList.remove('active');
             if (tabIeBtn) tabIeBtn.classList.add('active');
             if (paneList) paneList.style.display = 'none';
             if (paneIe) paneIe.style.display = 'flex';
           }
         };

        if (tabListBtn && tabIeBtn && paneList && paneIe) {
          tabListBtn.onclick = () => setTab('list');
          tabIeBtn.onclick = () => setTab('ie');
        }

        manageOpener = (initialJson = null) => {
          setTab('list');
          const storage = (window.chrome && chrome.storage && chrome.storage.sync) || null;
          const renderList = (savedFilters) => {
            manageList.innerHTML = '';
            
            // Update counter badge
            const countEl = document.getElementById('fb-saved-count');
            if (countEl) countEl.textContent = `${savedFilters.length}/${getMaxSavedFilters()}`;
            
            
            // Prepend Draft Filter if it exists in localStorage
            const draftStr = localStorage.getItem('fbDraftFilter');
            if (draftStr) {
              try {
                const draftConfig = JSON.parse(draftStr);
                const draftRow = document.createElement('div');
                draftRow.className = 'fb-filter-card draft-card';
                
                const isDraftActive = (activeSavedFilterIndex === null);
                if (isDraftActive) {
                  draftRow.classList.add('active');
                }
                
                const nameSpan = document.createElement('span');
                nameSpan.className = 'fb-filter-name';
                nameSpan.innerHTML = '<span style="color:var(--muted); font-size:0.75rem; text-transform:uppercase; font-weight:700; border: 1px solid var(--line); padding: 2px 5px; border-radius: 4px; margin-right: 8px; background:var(--panel2)">Draft</span> ' + (draftConfig.name || 'Unsaved Filter');
                draftRow.appendChild(nameSpan);
                
                const actions = document.createElement('div');
                actions.className = 'fb-filter-actions';
                
                if (isDraftActive) {
                  const activeBadge = document.createElement('span');
                  activeBadge.className = 'fb-active-badge';
                  activeBadge.innerHTML = '<ui-icon name="check"></ui-icon> Active';
                  actions.appendChild(activeBadge);
                }
                
                const clearDraftBtn = document.createElement('button');
                clearDraftBtn.className = 'fb-icon-btn';
                clearDraftBtn.title = 'Clear draft';
                clearDraftBtn.innerHTML = '<ui-icon name="trash"></ui-icon>';
                clearDraftBtn.style.border = 'none';
                clearDraftBtn.onclick = async (e) => {
                  e.stopPropagation();
                  const confirmFn = window.customConfirm;
                  const ok = confirmFn
                    ? await confirmFn("Are you sure you want to delete your current unsaved draft filter?", "Clear Draft")
                    : confirm("Are you sure you want to delete your current unsaved draft filter?");
                  if (ok) {
                    localStorage.removeItem('fbDraftFilter');
                    if (activeSavedFilterIndex === null) {
                      currentIR = JSON.parse(JSON.stringify(baseAppliedIR));
                      renderCards();
                      runLivePreview(false);
                    }
                    renderList(savedFilters);
                  }
                };
                actions.appendChild(clearDraftBtn);
                
                const shareDraftBtn = document.createElement('button');
                shareDraftBtn.className = 'fb-icon-btn';
                shareDraftBtn.title = 'Share / Download';
                shareDraftBtn.innerHTML = '<ui-icon name="share"></ui-icon>';
                shareDraftBtn.style.border = 'none';
                shareDraftBtn.onclick = async (e) => {
                  e.stopPropagation();
                  const filterName = draftConfig.name || 'Draft Filter';
                  const configText = JSON.stringify(draftConfig, null, 2);
                  const blob = new Blob([configText], { type: 'application/json' });
                  const file = new File([blob], `${filterName}.json`, { type: 'application/json' });
                  
                  if (navigator.share) {
                    if (navigator.canShare && navigator.canShare({ files: [file] })) {
                      try {
                        await navigator.share({
                          files: [file],
                          title: `Filter: ${filterName}`,
                          text: `Exported draft filter configuration: ${filterName}`
                        });
                        return;
                      } catch (err) {
                        if (err.name === 'AbortError') return;
                      }
                    }
                    
                    const txtFile = new File([blob], `${filterName}.json.txt`, { type: 'text/plain' });
                    if (navigator.canShare && navigator.canShare({ files: [txtFile] })) {
                      try {
                        await navigator.share({
                          files: [txtFile],
                          title: `Filter: ${filterName}`,
                          text: `Exported draft filter configuration: ${filterName}`
                        });
                        return;
                      } catch (err) {
                        if (err.name === 'AbortError') return;
                      }
                    }
                    
                    try {
                      await navigator.share({
                        title: `Filter: ${filterName}`,
                        text: configText
                      });
                      return;
                    } catch (err) {
                      if (err.name === 'AbortError') return;
                    }
                  }
                  
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `${filterName}.json`;
                  document.body.appendChild(a);
                  a.click();
                  document.body.removeChild(a);
                  URL.revokeObjectURL(url);
                };
                actions.appendChild(shareDraftBtn);
                
                const arrowSpan = document.createElement('span');
                arrowSpan.className = 'fb-filter-arrow';
                arrowSpan.innerHTML = '<ui-icon name="chevron-right"></ui-icon>';
                actions.appendChild(arrowSpan);
                
                draftRow.appendChild(actions);
                
                draftRow.onclick = () => {
                  activeSavedFilterIndex = null;
                  currentIR = JSON.parse(JSON.stringify(draftConfig));
                  renderCards();
                  runLivePreview(false);
                  manageDialog.style.display = 'none';
                  flashSuccess(manageBtn, '<ui-icon name="folder"></ui-icon> Manage');
                };
                
                manageList.appendChild(draftRow);
              } catch(e) {}
            }
            
            if (savedFilters.length === 0) {
              if (!draftStr) {
                manageList.innerHTML = '<div style="color:var(--muted);">No saved filters found.</div>';
              }
            } else {
              savedFilters.forEach((item, idx) => {
                const row = document.createElement('div');
                row.className = 'fb-filter-card';
                
                const isActive = (activeSavedFilterIndex === idx);
                if (isActive) {
                  row.classList.add('active');
                }
                
                const nameSpan = document.createElement('span');
                nameSpan.className = 'fb-filter-name';
                nameSpan.textContent = item.name;
                row.appendChild(nameSpan);
                
                const actions = document.createElement('div');
                actions.className = 'fb-filter-actions';
                
                if (isActive) {
                  const activeBadge = document.createElement('span');
                  activeBadge.className = 'fb-active-badge';
                  activeBadge.innerHTML = '<ui-icon name="check"></ui-icon> Active';
                  actions.appendChild(activeBadge);
                }
                
                const copyItemBtn = document.createElement('button');
                copyItemBtn.className = 'fb-icon-btn';
                copyItemBtn.title = 'Copy to clipboard';
                copyItemBtn.innerHTML = '<ui-icon name="copy"></ui-icon>';
                copyItemBtn.style.border = 'none';
                copyItemBtn.onclick = (e) => {
                  e.stopPropagation();
                  navigator.clipboard.writeText(JSON.stringify(item.config, null, 2));
                  flashCopySuccess(copyItemBtn, '<ui-icon name="copy"></ui-icon>', false);
                };

                const shareItemBtn = document.createElement('button');
                shareItemBtn.className = 'fb-icon-btn';
                shareItemBtn.title = 'Share / Download';
                shareItemBtn.innerHTML = '<ui-icon name="share"></ui-icon>';
                shareItemBtn.style.border = 'none';
                shareItemBtn.onclick = async (e) => {
                  e.stopPropagation();
                  const filterName = item.name || 'filter';
                  const configText = JSON.stringify(item.config, null, 2);
                  const blob = new Blob([configText], { type: 'application/json' });
                  const file = new File([blob], `${filterName}.json`, { type: 'application/json' });
                  
                  if (navigator.share) {
                    if (navigator.canShare && navigator.canShare({ files: [file] })) {
                      try {
                        await navigator.share({
                          files: [file],
                          title: `Filter: ${filterName}`,
                          text: `Exported filter configuration: ${filterName}`
                        });
                        return;
                      } catch (err) {
                        if (err.name === 'AbortError') return;
                      }
                    }
                    
                    const txtFile = new File([blob], `${filterName}.json.txt`, { type: 'text/plain' });
                    if (navigator.canShare && navigator.canShare({ files: [txtFile] })) {
                      try {
                        await navigator.share({
                          files: [txtFile],
                          title: `Filter: ${filterName}`,
                          text: `Exported filter configuration: ${filterName}`
                        });
                        return;
                      } catch (err) {
                        if (err.name === 'AbortError') return;
                      }
                    }
                    
                    try {
                      await navigator.share({
                        title: `Filter: ${filterName}`,
                        text: configText
                      });
                      return;
                    } catch (err) {
                      if (err.name === 'AbortError') return;
                    }
                  }
                  
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `${filterName}.json`;
                  document.body.appendChild(a);
                  a.click();
                  document.body.removeChild(a);
                  URL.revokeObjectURL(url);
                };

                const deleteItemBtn = document.createElement('button');
                deleteItemBtn.className = 'fb-icon-btn';
                deleteItemBtn.title = 'Delete';
                deleteItemBtn.innerHTML = '<ui-icon name="trash"></ui-icon>';
                deleteItemBtn.style.border = 'none';
                deleteItemBtn.onclick = async (e) => {
                  e.stopPropagation();
                  const confirmFn = window.customConfirm;
                  const ok = confirmFn
                    ? await confirmFn(`Are you sure you want to delete filter "${item.name}"?`, "Delete Filter")
                    : confirm(`Are you sure you want to delete filter "${item.name}"?`);
                  if (ok) {
                    savedFilters.splice(idx, 1);
                    if (activeSavedFilterIndex === idx) {
                      activeSavedFilterIndex = null;
                    } else if (activeSavedFilterIndex > idx) {
                      activeSavedFilterIndex--;
                    }
                    if (storage) {
                      storage.set({ fbSavedFilters: savedFilters }, () => renderList(savedFilters));
                    } else {
                      localStorage.setItem('fbSavedFilters', JSON.stringify(savedFilters));
                      renderList(savedFilters);
                    }
                  }
                };
                
                const arrowSpan = document.createElement('span');
                arrowSpan.className = 'fb-filter-arrow';
                arrowSpan.innerHTML = '<ui-icon name="chevron-right"></ui-icon>';
                
                actions.appendChild(copyItemBtn);
                actions.appendChild(shareItemBtn);
                actions.appendChild(deleteItemBtn);
                actions.appendChild(arrowSpan);
                row.appendChild(actions);
                
                row.onclick = () => {
                  activeSavedFilterIndex = idx;
                  currentIR = JSON.parse(JSON.stringify(item.config));
                  renderCards();
                  runLivePreview(false);
                  manageDialog.style.display = 'none';
                  flashSuccess(manageBtn, '<ui-icon name="folder"></ui-icon> Manage');
                };
                
                manageList.appendChild(row);
              });
            }
            
            if (initialJson !== null) {
              try {
                ieText.value = JSON.stringify(JSON.parse(initialJson), null, 2);
              } catch(e) { ieText.value = initialJson; }
            } else {
              ieText.value = JSON.stringify(currentIR, null, 2);
            }
            if (typeof validateJsonInput === 'function') {
              validateJsonInput(ieText.value);
            }
            manageDialog.style.display = 'flex';
          };
 
          if (storage) {
            storage.get(['fbSavedFilters'], (res) => renderList(res.fbSavedFilters || []));
          } else {
            renderList(JSON.parse(localStorage.getItem('fbSavedFilters') || '[]'));
          }
        };
        manageBtn.onclick = () => manageOpener();
        
        document.getElementById('fb-manage-close').onclick = () => {
          manageDialog.style.display = 'none';
        };

        manageDialog.onclick = (e) => {
          if (e.target === manageDialog) {
            e.stopPropagation();
            manageDialog.style.display = 'none';
          }
        };
        
        const ieStatus = document.getElementById('fb-ie-status');
        const ieImportBtn = document.getElementById('fb-ie-import');
        const ieApplyBtn = document.getElementById('fb-ie-apply');
        const ieExportBtn = document.getElementById('fb-ie-export');

        function validateJsonInput(text) {
          const trimmed = (text || '').trim();
          if (!trimmed) {
            if (ieStatus) ieStatus.innerHTML = '';
            if (ieImportBtn) ieImportBtn.disabled = true;
            if (ieApplyBtn) ieApplyBtn.disabled = true;
            if (ieExportBtn) ieExportBtn.disabled = true;
            return;
          }

          try {
            const config = JSON.parse(trimmed);
            const isGroup = (config.kind === 'group');
            const hasWhere = (config.where && config.where.kind === 'group');
            const isValidFilter = isGroup || hasWhere || (config.where === null) || (typeof config === 'object');
            
            if (isValidFilter) {
              let detail = 'Valid filter configuration';
              let count = 0;
              const countRules = (group) => {
                if (group && Array.isArray(group.rules)) {
                  group.rules.forEach(r => {
                    if (r.kind === 'condition') count++;
                    else if (r.kind === 'group') countRules(r);
                  });
                }
              };
              if (isGroup) countRules(config);
              else if (hasWhere) countRules(config.where);
              
              if (count > 0) detail += ` (${count} condition${count > 1 ? 's' : ''})`;
              
              if (ieStatus) {
                ieStatus.innerHTML = `<span style="color:#2da44e; display:inline-flex; align-items:center; gap:4px;"><ui-icon name="check-circle"></ui-icon> ${detail}</span>`;
              }
              const normalizedInput = normalizeIRForComparison(config);
              const normalizedCurrent = normalizeIRForComparison(currentIR);
              const normalizedApplied = normalizeIRForComparison(baseAppliedIR);

              const matchesCurrent = normalizedInput && normalizedCurrent && (JSON.stringify(normalizedInput) === JSON.stringify(normalizedCurrent));
              const matchesApplied = normalizedInput && normalizedApplied && (JSON.stringify(normalizedInput) === JSON.stringify(normalizedApplied));

              if (ieImportBtn) ieImportBtn.disabled = matchesCurrent;
              if (ieApplyBtn) ieApplyBtn.disabled = matchesApplied;
              if (ieExportBtn) ieExportBtn.disabled = false;
            } else {
              throw new Error('Not a valid filter configuration object');
            }
          } catch (err) {
            if (ieStatus) {
              ieStatus.innerHTML = `<span style="color:#e06c75; display:inline-flex; align-items:center; gap:4px;"><ui-icon name="alert-triangle"></ui-icon> Invalid JSON: ${err.message}</span>`;
            }
            if (ieImportBtn) ieImportBtn.disabled = true;
            if (ieApplyBtn) ieApplyBtn.disabled = true;
            if (ieExportBtn) ieExportBtn.disabled = true;
          }
        };

        ieText.oninput = () => validateJsonInput(ieText.value);

        const iePasteBtn = document.getElementById('fb-ie-paste');
        if (iePasteBtn) {
          iePasteBtn.onclick = async () => {
            try {
              const text = await navigator.clipboard.readText();
              ieText.value = text;
              validateJsonInput(text);
              try {
                const parsed = JSON.parse(text);
                ieText.value = JSON.stringify(parsed, null, 2);
              } catch (e) {}
              flashCopySuccess(iePasteBtn, '<ui-icon name="copy"></ui-icon> Paste', true);
            } catch (err) {
              if (window.customAlert) {
                window.customAlert('Could not read clipboard. Please paste manually (Ctrl+V).', 'Clipboard Error');
              } else {
                alert('Could not read clipboard. Please paste manually (Ctrl+V).');
              }
            }
          };
        }

        const ieFileImportBtn = document.getElementById('fb-ie-file-import');
        const ieFileInput = document.getElementById('fb-ie-file-input');
        if (ieFileImportBtn && ieFileInput) {
          ieFileImportBtn.onclick = () => {
            ieFileInput.click();
          };
          ieFileInput.onchange = (e) => {
            const file = e.target.files[0];
            if (file) {
              if (file.name.endsWith('.json')) {
                const reader = new FileReader();
                reader.onload = (event) => {
                  const text = event.target.result;
                  ieText.value = text;
                  validateJsonInput(text);
                  try {
                    const parsed = JSON.parse(text);
                    ieText.value = JSON.stringify(parsed, null, 2);
                  } catch (err) {}
                  flashCopySuccess(ieFileImportBtn, '<ui-icon name="upload"></ui-icon> Import File', true);
                };
                reader.readAsText(file);
              } else {
                if (window.customAlert) {
                  window.customAlert('Please select a valid .json file.', 'Import Error');
                } else {
                  alert('Please select a valid .json file.');
                }
              }
            }
            ieFileInput.value = '';
          };
        }

        const ieFormatBtn = document.getElementById('fb-ie-format');
        if (ieFormatBtn) {
          ieFormatBtn.onclick = () => {
            try {
              const parsed = JSON.parse(ieText.value);
              ieText.value = JSON.stringify(parsed, null, 2);
              validateJsonInput(ieText.value);
              flashCopySuccess(ieFormatBtn, '<ui-icon name="ruler"></ui-icon>', false);
            } catch (err) {
              if (window.customAlert) {
                window.customAlert('Cannot format invalid JSON.', 'Format Error');
              } else {
                alert('Cannot format invalid JSON.');
              }
            }
          };
        }

        const ieClearBtn = document.getElementById('fb-ie-clear');
        if (ieClearBtn) {
          ieClearBtn.onclick = () => {
            ieText.value = '';
            validateJsonInput('');
            flashCopySuccess(ieClearBtn, '<ui-icon name="trash"></ui-icon>', false);
          };
        }

        // Drag & Drop JSON files
        ieText.addEventListener('dragover', (e) => {
          e.preventDefault();
          ieText.style.borderColor = 'var(--accent)';
          ieText.style.background = 'rgba(47, 111, 237, 0.02)';
        });

        const resetDragStyles = () => {
          ieText.style.borderColor = '';
          ieText.style.background = '';
        };

        ieText.addEventListener('dragleave', resetDragStyles);
        ieText.addEventListener('drop', (e) => {
          e.preventDefault();
          resetDragStyles();
          const file = e.dataTransfer.files[0];
          if (file && file.name.endsWith('.json')) {
            const reader = new FileReader();
            reader.onload = (event) => {
              const text = event.target.result;
              ieText.value = text;
              validateJsonInput(text);
              try {
                const parsed = JSON.parse(text);
                ieText.value = JSON.stringify(parsed, null, 2);
              } catch (e) {}
            };
            reader.readAsText(file);
          } else {
            if (window.customAlert) {
              window.customAlert('Please drop a valid .json file.', 'Import Error');
            } else {
              alert('Please drop a valid .json file.');
            }
          }
        });
        
        document.getElementById('fb-ie-copy').onclick = () => {
          ieText.select();
          document.execCommand('copy');
          flashCopySuccess(document.getElementById('fb-ie-copy'), '<ui-icon name="copy"></ui-icon> Copy', true);
        };

        if (ieExportBtn) {
          ieExportBtn.onclick = async () => {
            try {
              const configText = ieText.value;
              const config = JSON.parse(configText);
              const filterName = config.name || 'Exported Filter';
              const blob = new Blob([configText], { type: 'application/json' });
              const file = new File([blob], `${filterName}.json`, { type: 'application/json' });
              
              if (navigator.share) {
                if (navigator.canShare && navigator.canShare({ files: [file] })) {
                  try {
                    await navigator.share({
                      files: [file],
                      title: `Filter: ${filterName}`,
                      text: `Exported filter configuration: ${filterName}`
                    });
                    return;
                  } catch (err) {
                    if (err.name === 'AbortError') return;
                  }
                }
                
                const txtFile = new File([blob], `${filterName}.json.txt`, { type: 'text/plain' });
                if (navigator.canShare && navigator.canShare({ files: [txtFile] })) {
                  try {
                    await navigator.share({
                      files: [txtFile],
                      title: `Filter: ${filterName}`,
                      text: `Exported filter configuration: ${filterName}`
                    });
                    return;
                  } catch (err) {
                    if (err.name === 'AbortError') return;
                  }
                }
                
                try {
                  await navigator.share({
                    title: `Filter: ${filterName}`,
                    text: configText
                  });
                  return;
                } catch (err) {
                  if (err.name === 'AbortError') return;
                }
              }
              
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `${filterName}.json`;
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
              URL.revokeObjectURL(url);
            } catch (e) {}
          };
        }
        
        document.getElementById('fb-ie-import').onclick = async () => {
          try {
            const config = JSON.parse(ieText.value);
            const draftStr = localStorage.getItem('fbDraftFilter');
            const doImport = () => {
              currentIR = config;
              activeSavedFilterIndex = null;
              renderCards();
              runLivePreview(true);
              const draftBanner = document.getElementById('fb-draft-banner');
              if (draftBanner && JSON.stringify(currentIR) !== JSON.stringify(baseAppliedIR)) {
                draftBanner.style.display = 'flex';
              }
              manageDialog.style.display = 'none';
              flashSuccess(manageBtn, '<ui-icon name="folder"></ui-icon> Manage');
            };
            
            if (draftStr && draftStr !== JSON.stringify(config)) {
              const confirmFn = window.customConfirm;
              const ok = confirmFn
                ? await confirmFn("Importing this filter will overwrite your current draft filter. Do you want to proceed?", "Overwrite Draft?")
                : confirm("Importing this filter will overwrite your current draft filter. Do you want to proceed?");
              if (ok) {
                doImport();
              }
            } else {
              doImport();
            }
          } catch (e) {}
        };
        
        document.getElementById('fb-ie-apply').onclick = () => {
          try {
            const config = JSON.parse(ieText.value);
            currentIR = config;
            manageDialog.style.display = 'none';
            apply();
          } catch (e) {}
        };

        // Trigger live validation immediately if the textarea has default loaded content
        if (ieText.value) {
          validateJsonInput(ieText.value);
        }
      }


      document.getElementById('fb-close-btn').onclick = close;
      document.getElementById('fb-cancel-btn').onclick = close;
      document.getElementById('fb-apply-btn').onclick = apply;

      const showFollowedEl = document.getElementById('fb-show-followed');
      if (showFollowedEl) {
        showFollowedEl.onclick = () => {
          if (!currentIR) currentIR = {};
          const isFollowed = showFollowedEl.classList.toggle('on');
          const icon = showFollowedEl.querySelector('.fb-toggle-icon');
          if (icon) icon.innerHTML = isFollowed ? '<ui-icon name="star-filled"></ui-icon>' : '<ui-icon name="star"></ui-icon>';
          currentIR.followed = isFollowed ? { in: ['yes'], not: [] } : null;
          runLivePreview();
        };
      }

      const fbAiSearchBtn = document.getElementById('fb-ai-search-btn');
      if (fbAiSearchBtn) {
        fbAiSearchBtn.onclick = () => {
          if (window.AISearchDialog) {
            window.AISearchDialog.open();
          }
        };
      }

      const helpBtn = document.getElementById('fb-help-btn');
      if (helpBtn) {
        helpBtn.onclick = (e) => {
          e.stopPropagation();
          if (window.tutorialManagerInstance) {
            const config = window.tutorialManagerInstance.registry['v1.2.0_advanced_filter_syntax'];
            if (config) {
              window.tutorialManagerInstance.start('v1.2.0_advanced_filter_syntax', config);
            }
          }
        };
      }

      const previewToggleBtn = document.getElementById('fb-preview-toggle-btn');
      const previewTab = document.getElementById('fb-preview-tab');
      const previewPanel = document.querySelector('.fb-preview-panel');
      const resizer = document.getElementById('fb-preview-resizer');
      
      const togglePreview = () => {
        if (!previewPanel) return;
        const isHidden = previewPanel.classList.toggle('hidden');
        if (isHidden) {
          if (resizer) resizer.style.display = 'none';
          if (previewTab) previewTab.style.display = 'block';
        } else {
          if (resizer) resizer.style.display = '';
          if (previewTab) previewTab.style.display = 'none';
        }
      };

      if (previewToggleBtn) previewToggleBtn.onclick = togglePreview;
      if (previewTab) previewTab.onclick = togglePreview;

      if (resizer && previewPanel) {
        let isResizing = false;
        let startX = 0;
        let startWidth = 0;

        resizer.onmousedown = (e) => {
          isResizing = true;
          resizer.classList.add('active');
          startX = e.clientX;
          startWidth = previewPanel.getBoundingClientRect().width;
          document.body.style.cursor = 'col-resize';
          e.preventDefault();
        };

        const onMouseMove = (e) => {
          if (!isResizing) return;
          const diff = startX - e.clientX;
          let newWidth = startWidth + diff;
          const boxEl = document.getElementById('filter-builder-box');
          const maxAllowed = boxEl ? Math.floor(boxEl.clientWidth / 2) : 500;
          newWidth = Math.max(200, Math.min(newWidth, maxAllowed));
          previewPanel.style.width = newWidth + 'px';
        };

        const onMouseUp = () => {
          if (isResizing) {
            isResizing = false;
            resizer.classList.remove('active');
            document.body.style.cursor = '';
          }
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);

        // Cleanup function for when modal closes
        const oldClose = close;
        close = () => {
          document.removeEventListener('mousemove', onMouseMove);
          document.removeEventListener('mouseup', onMouseUp);
          oldClose();
        };
      }

      modalElement.onclick = function(e) {
        if (e.target === modalElement) close();
      };
    }
  }

  // --- Rendering Dynamic Core ---
  function renderCards() {
    clearAllDocListeners();
    const container = document.getElementById('fb-cards-container');
    if (!container) return;
    
    container.innerHTML = '';
    const rootGroup = currentIR.where;
    const cards = rootGroup.rules;

    cards.forEach((card, cardIdx) => {
      // 1. Logical divider between cards
      if (cardIdx > 0) {
        const spacer = document.createElement('div');
        spacer.className = 'fb-spacer';
        spacer.innerHTML = `
          <div class="fb-spacer-line"></div>
          <button class="fb-spacer-toggle" id="fb-spacer-toggle-${cardIdx}">${rootGroup.logic || 'OR'}</button>
        `;
        container.appendChild(spacer);
        document.getElementById(`fb-spacer-toggle-${cardIdx}`).onclick = () => updateState(toggleSpacerLogic);
      }

      // 2. Render card block
      const cardEl = document.createElement('div');
      cardEl.className = 'fb-group-card';
      
      let cardHeaderHtml = `
        <div class="fb-group-card-header">
          <span class="fb-group-card-title">Filter Group Card ${cardIdx + 1}</span>
          ${cards.length > 1 ? `<button class="fb-group-card-delete" id="fb-card-delete-${cardIdx}">Delete Card</button>` : ''}
        </div>
      `;

      // Group conditions by unique fields
      const fieldsInCard = [];
      card.rules.forEach(r => {
        if (r.kind === 'condition' && !fieldsInCard.includes(r.field)) {
          fieldsInCard.push(r.field);
        }
      });
      let rowsHtml = '';
      fieldsInCard.forEach(field => {
        const conds = card.rules
          .map((rule, ruleIdx) => ({ rule, ruleIdx }))
          .filter(x => x.rule.kind === 'condition' && x.rule.field === field);

        const displayName = getFieldLabel(field);
        const strategy = getInputStrategy(field);

        let chipsHtml = '';
        conds.forEach(({ rule, ruleIdx }) => {
          chipsHtml += renderChipsHtml(cardIdx, ruleIdx, rule);
        });

        rowsHtml += `
          <div class="fb-field-row">
            <div class="fb-field-label-wrap">
              <button class="fb-field-delete" id="fb-field-delete-${cardIdx}-${field}" title="Remove Field row">&times;</button>
              <span class="fb-field-label">${displayName}:</span>
              <span class="logic-hint" data-tooltip-html="${htmlEsc(getTooltipHtml(field))}"><ui-icon name="help"></ui-icon></span>
            </div>
            <div class="fb-chips-container">
              ${chipsHtml}
              ${strategy.render(cardIdx, field)}
            </div>
          </div>
        `;
      });

      cardEl.innerHTML = `
        ${cardHeaderHtml}
        ${rowsHtml}
        <div class="f-dropdown-container fb-add-field-container" style="margin-top: 12px; align-self: flex-start; display: flex; align-items: center; gap: 6px;">
          <input id="fb-add-field-input-${cardIdx}" class="tag-search" 
            placeholder="${schemaLoaded ? '+ Add Field...' : 'Loading schema...'}" 
            autocomplete="off" 
            ${schemaLoaded ? '' : 'disabled'}>
          ${schemaLoaded ? '' : '<span class="spin" style="width: 12px; height: 12px; border-width: 1.5px;"></span>'}
          <div id="fb-add-field-dropdown-${cardIdx}" class="f-dropdown" style="display:none"></div>
        </div>
      `;

      container.appendChild(cardEl);

      // 3. Wire card action events
      if (cards.length > 1) {
        document.getElementById(`fb-card-delete-${cardIdx}`).onclick = () => updateState(() => deleteGroupCard(cardIdx));
      }

      // 4. Wire "+ Add Field..." Autocomplete & Dropdown
      if (schemaLoaded) {
        const addFieldInp = document.getElementById(`fb-add-field-input-${cardIdx}`);
        const addFieldDropdown = document.getElementById(`fb-add-field-dropdown-${cardIdx}`);
        const availableFields = getAvailableFieldsForCard(card);

        const showFields = (q) => {
          const query = q.toLowerCase().trim();
          const matches = availableFields.filter(f => {
            const label = getFieldLabel(f);
            return label.toLowerCase().includes(query) || f.toLowerCase().includes(query);
          });
          
          addFieldDropdown.innerHTML = '';
          if (matches.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'f-dropdown-item empty';
            empty.textContent = 'No matching fields';
            addFieldDropdown.appendChild(empty);
          } else {
            matches.forEach(f => {
              const item = document.createElement('div');
              item.className = 'f-dropdown-item';
              const isPredefined = BUILT_IN_FIELDS.has(f);
              const labelText = getFieldLabel(f);
              item.innerHTML = isPredefined ? labelText : `${labelText} <span style="font-size:10px; color:var(--muted); margin-left:auto;">${f}</span>`;
              item.onmousedown = (e) => {
                e.preventDefault();
                updateState(() => {
                  card.rules.push({
                    kind: 'condition',
                    field: f,
                    op: getDefaultOperator(f),
                    value: ''
                  });
                });
                addFieldInp.value = '';
                hideFields();
              };
              addFieldDropdown.appendChild(item);
            });
          }
          
          addFieldDropdown.style.display = 'flex';
          if (window.LayerManager) {
            window.LayerManager.open(addFieldDropdown, null, { isPopover: true });
          }
          addFieldDropdown.style.left = '0';
          addFieldDropdown.style.top = '100%';
        };
        
        const hideFields = () => {
          addFieldDropdown.style.display = 'none';
          if (window.LayerManager) {
            window.LayerManager.close(addFieldDropdown);
          }
        };

        addFieldInp.onfocus = () => showFields(addFieldInp.value);
        addFieldInp.oninput = () => showFields(addFieldInp.value);
        
        addFieldInp.onkeydown = (e) => {
          if (e.key === 'Enter') {
            const val = addFieldInp.value.trim().toLowerCase();
            const found = availableFields.find(f => {
              const label = getFieldLabel(f).toLowerCase();
              return label === val || f.toLowerCase() === val;
            });
            if (found) {
              updateState(() => {
                card.rules.push({
                  kind: 'condition',
                  field: found,
                  op: getDefaultOperator(found),
                  value: ''
                });
              });
              addFieldInp.value = '';
              hideFields();
            }
          } else if (e.key === 'Escape') {
            e.stopPropagation();
            hideFields();
          }
        };

        const onMouseDownFields = (e) => {
          if (!addFieldInp.contains(e.target) && !addFieldDropdown.contains(e.target)) {
            hideFields();
            removeDocListener('mousedown', onMouseDownFields);
          }
        };
        
        addFieldInp.addEventListener('focus', () => {
          addDocListener('mousedown', onMouseDownFields);
        });
      }

      // 5. Wire row components, chips, and strategies
      fieldsInCard.forEach(field => {
        document.getElementById(`fb-field-delete-${cardIdx}-${field}`).onclick = () => {
          updateState(() => removeFieldRow(cardIdx, field));
        };

        const conds = card.rules
          .map((rule, ruleIdx) => ({ rule, ruleIdx }))
          .filter(x => x.rule.kind === 'condition' && x.rule.field === field);

        conds.forEach(({ rule, ruleIdx }) => {
          if (rule.value === '') return;
          if (Array.isArray(rule.value)) {
            rule.value.forEach(val => {
              const chip = document.getElementById(`fb-chip-${cardIdx}-${ruleIdx}-${val}`);
              if (chip) {
                chip.onclick = (e) => {
                  if (e.target.classList.contains('fb-chip-delete')) {
                    updateState(() => removeConditionChip(cardIdx, ruleIdx, val));
                  } else {
                    updateState(() => toggleConditionState(cardIdx, ruleIdx, val));
                  }
                };
              }
            });
          } else {
            const chip = document.getElementById(`fb-chip-${cardIdx}-${ruleIdx}`);
            if (chip) {
              chip.onclick = (e) => {
                if (e.target.classList.contains('fb-chip-delete')) {
                  updateState(() => removeConditionChip(cardIdx, ruleIdx));
                } else {
                  updateState(() => toggleConditionState(cardIdx, ruleIdx, rule.value));
                }
              };
            }
          }
        });

        // Wire field value picker strategy
        const strategy = getInputStrategy(field);
        strategy.wire(cardIdx, field);
      });
    });

    let globalTooltip = document.getElementById('fb-global-logic-tooltip');
    if (!globalTooltip) {
      globalTooltip = document.createElement('div');
      globalTooltip.id = 'fb-global-logic-tooltip';
      globalTooltip.className = 'logic-tooltip';
      globalTooltip.style.display = 'none';
      document.body.appendChild(globalTooltip);
    }

    container.querySelectorAll('.logic-hint').forEach(hint => {
      hint.onmouseenter = () => {
        if (window.LayerManager) {
          globalTooltip.innerHTML = window.AdoLib.htmlUnesc(hint.getAttribute('data-tooltip-html'));
          const rect = hint.getBoundingClientRect();
          globalTooltip.style.position = 'absolute';
          globalTooltip.style.top = (rect.bottom + window.scrollY + 6) + 'px';
          globalTooltip.style.left = (rect.left + window.scrollX - 10) + 'px';
          globalTooltip.style.display = 'block';
          window.LayerManager.open(globalTooltip, hint, { isPopover: true, direction: 'bottom' });
        }
      };
      hint.onmouseleave = () => {
        if (window.LayerManager) {
          globalTooltip.style.display = 'none';
          window.LayerManager.close(globalTooltip);
        }
      };
    });

    // 6. Add group OR button
    const addGroupBtn = document.createElement('button');
    addGroupBtn.className = 'fb-add-group-btn';
    addGroupBtn.innerHTML = `&#43; Add OR Group`;
    addGroupBtn.onclick = () => updateState(addGroupCard);
    container.appendChild(addGroupBtn);
  }

  // --- Live Results Preview Panel ---
  let baseAppliedIR = null;
  function runLivePreview(saveToDraft = true) {
    // Sync the draft banner: show only when currentIR differs from the applied filter
    const draftBanner = document.getElementById('fb-draft-banner');
    if (draftBanner && baseAppliedIR) {
      const isDraft = JSON.stringify(currentIR) !== JSON.stringify(baseAppliedIR);
      draftBanner.style.display = isDraft ? 'flex' : 'none';
    }

    if (saveToDraft && currentIR && activeSavedFilterIndex === null) {
      localStorage.setItem('fbDraftFilter', JSON.stringify(currentIR));
    }
    clearTimeout(previewDebounceTimer);
    previewDebounceTimer = setTimeout(async () => {
      const listEl = document.getElementById('fb-preview-list');
      const countEl = document.getElementById('fb-preview-count');
      if (!listEl) return;

      listEl.innerHTML = '<div style="color:var(--muted); text-align:center; padding-top:20px;">Loading preview...</div>';

      try {
        if (!window.api || typeof window.api.search !== 'function') {
          listEl.innerHTML = '<div style="color:var(--muted); text-align:center; padding-top:20px;">API search unavailable</div>';
          return;
        }

        const results = await window.api.search({ filters: currentIR });
        const displayLimit = 20;
        const sliced = results.slice(0, displayLimit);

        countEl.textContent = `${results.length} items`;

        if (results.length === 0) {
          listEl.innerHTML = '<div style="color:var(--muted); text-align:center; padding-top:20px;">No results matching filters</div>';
          return;
        }

        const getTypeColor = (type) => {
          if (typeof window.tyColor === 'function') return window.tyColor(type);
          if (typeof tyColor === 'function') return tyColor(type);
          return '#5b6b7d';
        };

        const getPrioColor = (prio) => {
          if (typeof window.prioColor === 'function') return window.prioColor(prio);
          if (typeof prioColor === 'function') return prioColor(prio);
          const colors = { 1: '#e74c3c', 2: '#e67e22', 3: '#f1c40f', 4: '#95a5a6' };
          return colors[prio] || '#5b6b7d';
        };

        const treeItemsHtml = sliced.map(n => {
          return `
            <li>
              <div class="trow" data-id="${n.id}">
                <span class="tog leaf"></span>
                <i class="dot" style="background:${getTypeColor(n.type)}"></i>
                <span class="lab">#${n.id} ${htmlEsc(n.title)}</span>
              </div>
            </li>
          `;
        }).join('');

        listEl.innerHTML = `<ul class="tree">${treeItemsHtml}</ul>`;


        if (results.length > displayLimit) {
          const extra = document.createElement('div');
          extra.style.cssText = 'color:var(--muted); font-size:0.8rem; text-align:center; padding:10px 4px 4px 4px;';
          extra.textContent = `...and ${results.length - displayLimit} more items`;
          listEl.appendChild(extra);
        }

      } catch (e) {
        listEl.innerHTML = `<div style="color:#ff6b6b; text-align:center; padding-top:20px;">Error running preview: ${e.message}</div>`;
      }
    }, 400);
  }

  // --- External API ---
  async function open(initialIR, onApply) {
    ensureModalElement();
    onApplyCallback = onApply;

    const helpPanel = document.getElementById('fb-help-panel');
    if (helpPanel) {
      helpPanel.classList.remove('show');
    }

    // Normalize FilterIR structure
    baseAppliedIR = JSON.parse(JSON.stringify(initialIR || { where: { kind: 'group', logic: 'OR', rules: [] } }));
    if (!baseAppliedIR.where || baseAppliedIR.where.kind !== 'group') baseAppliedIR.where = { kind: 'group', logic: 'OR', rules: [] };
    if (baseAppliedIR.where.rules.length === 0) baseAppliedIR.where.rules.push({ kind: 'group', logic: 'AND', rules: [] });

    let draftIR = null;
    try {
      const draftStr = localStorage.getItem('fbDraftFilter');
      if (draftStr) draftIR = JSON.parse(draftStr);
    } catch(e) {}

    // Check if a draft is effectively empty (no actual filter conditions)
    const isDraftEmpty = (ir) => {
      if (!ir || !ir.where || !Array.isArray(ir.where.rules)) return true;
      for (const group of ir.where.rules) {
        if (group && group.kind === 'group' && Array.isArray(group.rules) && group.rules.length > 0) return false;
      }
      return true;
    };

    // If draft is empty, discard it — use the applied filter instead
    if (draftIR && isDraftEmpty(draftIR)) {
      localStorage.removeItem('fbDraftFilter');
      draftIR = null;
    }
    
    const draftBanner = document.getElementById('fb-draft-banner');
    if (draftIR && JSON.stringify(draftIR) !== JSON.stringify(baseAppliedIR)) {
      currentIR = draftIR;
      if (draftBanner) draftBanner.style.display = 'flex';
    } else {
      currentIR = JSON.parse(JSON.stringify(baseAppliedIR));
      if (draftBanner) draftBanner.style.display = 'none';
    }
    const discardBtn = document.getElementById('fb-discard-draft-btn');
    if (discardBtn) {
      discardBtn.onclick = () => {
        localStorage.removeItem('fbDraftFilter');
        if (draftBanner) draftBanner.style.display = 'none';
        currentIR = JSON.parse(JSON.stringify(baseAppliedIR));
        updateState();
      };
    }

    // Show AI result banner if there is a pending AI search result
    const aiBanner = document.getElementById('fb-ai-banner');
    if (aiBanner) {
      if (window.AISearchDialog && window.AISearchDialog.hasPendingResult && window.AISearchDialog.hasPendingResult()) {
        aiBanner.style.display = 'flex';
        
        document.getElementById('fb-apply-ai-btn').onclick = async () => {
          const hasRules = currentIR && currentIR.where && currentIR.where.rules && currentIR.where.rules.some(r => r.rules && r.rules.length > 0);
          if (hasRules && window.customConfirm) {
            const confirm = await window.customConfirm(
              "Discard active edits and apply the AI search filters?",
              "Apply AI Filter"
            );
            if (!confirm) return;
          }
          aiBanner.style.display = 'none';
          if (window.AISearchDialog && window.AISearchDialog.getPendingResult) {
            const ir = window.AISearchDialog.getPendingResult();
            if (ir) {
              setIR(ir);
              window.AISearchDialog.clearPendingResult();
            }
          }
        };
        
        document.getElementById('fb-discard-ai-btn').onclick = () => {
          aiBanner.style.display = 'none';
          if (window.AISearchDialog && window.AISearchDialog.clearPendingResult) {
            window.AISearchDialog.clearPendingResult();
          }
        };
      } else {
        aiBanner.style.display = 'none';
      }
    }

    const hasFollowed = !!(currentIR.followed && currentIR.followed.in && currentIR.followed.in.includes('yes'));
    const showFollowedEl = document.getElementById('fb-show-followed');
    if (showFollowedEl) {
      if (hasFollowed) {
        showFollowedEl.classList.add('on');
        const icon = showFollowedEl.querySelector('.fb-toggle-icon');
        if (icon) icon.innerHTML = '<ui-icon name="star-filled"></ui-icon>';
      } else {
        showFollowedEl.classList.remove('on');
        const icon = showFollowedEl.querySelector('.fb-toggle-icon');
        if (icon) icon.innerHTML = '<ui-icon name="star"></ui-icon>';
      }
    }

    // Immediately open modal
    modalElement.style.display = 'flex';
    if (window.LayerManager) {
      window.LayerManager.open(modalElement, null, { isModal: true });
    }

    if (!modalEscapeHandler) {
      modalEscapeHandler = (e) => {
        if (e.key === 'Escape') {
          const saveDialog = document.getElementById('fb-save-dialog');
          const manageDialog = document.getElementById('fb-manage-dialog');
          
          if (saveDialog && saveDialog.style.display === 'flex') {
            saveDialog.style.display = 'none';
            return;
          }
          if (manageDialog && manageDialog.style.display === 'flex') {
            manageDialog.style.display = 'none';
            return;
          }
          
          close();
        }
      };
      document.addEventListener('keydown', modalEscapeHandler);
    }

    if (schemaLoaded) {
      updateState();
    } else {
      updateState();
      loadSchemaData().then(() => {
        updateState();
      });
    }
  }

  function close() {
    clearAllDocListeners();
    if (modalEscapeHandler) {
      document.removeEventListener('keydown', modalEscapeHandler);
      modalEscapeHandler = null;
    }
    if (modalElement) {
      modalElement.style.display = 'none';
      if (window.LayerManager) {
        window.LayerManager.close(modalElement);
      }
    }
  }

  function apply() {
    const showFollowedEl = document.getElementById('fb-show-followed');

    if (showFollowedEl) {
      currentIR.followed = showFollowedEl.classList.contains('on') ? { in: ['yes'], not: [] } : null;
    }
    localStorage.removeItem('fbDraftFilter');

    if (onApplyCallback) {
      onApplyCallback(currentIR);
    }
    close();
  }

  function setIR(ir) {
    localStorage.removeItem('fbDraftFilter');
    const draftBanner = document.getElementById('fb-draft-banner');
    if (draftBanner) draftBanner.style.display = 'none';

    currentIR = normalizeIRForComparison(ir);
    updateState();
  }

  // Export module functions
  root.FilterBuilderModal = {
    open,
    close,
    setIR,
    preLoad: loadSchemaData
  };

})(typeof globalThis !== "undefined" ? globalThis : window);

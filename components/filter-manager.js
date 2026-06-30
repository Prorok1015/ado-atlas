(function (root, factory) {
  const FilterManager = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = FilterManager;
  } else {
    root.FilterManager = FilterManager;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  class FilterManager {
    constructor(options = {}) {
      this.fieldRegistry = options.fieldRegistry || null;
      this.listeners = [];
      this.activeIR = null;
      /** @type {Set<string>} Field keys that the quick-filter UI can represent (e.g. 'type','state'). */
      this.quickFilterFields = new Set(options.quickFilterFields || []);
      this.clear();
    }

    /**
     * Mutates the root AND group inside activeIR to toggle the state of a value on a field.
     * @param {string} field 
     * @param {string|number} val 
     * @param {'in'|'out'} mode 
     */
    toggleChip(field, val, mode) {
      if (mode !== 'in' && mode !== 'out') return;
      const current = this.getChipState(field, val);

      if (current === mode) {
        this.removeChip(field, val);
        return;
      }

      const andGroup = this._getRootAndGroup();
      const { inc, exc } = this._getFieldValues(andGroup, field);
      const vStr = String(val);

      // Toggle on: add to target list, remove from other list
      let newInc = inc;
      let newExc = exc;
      if (mode === 'in') {
        newExc = exc.filter(x => String(x) !== vStr);
        if (!inc.map(String).includes(vStr)) {
          newInc.push(val);
        }
      } else if (mode === 'out') {
        newInc = inc.filter(x => String(x) !== vStr);
        if (!exc.map(String).includes(vStr)) {
          newExc.push(val);
        }
      }
      this._setFieldValues(andGroup, field, newInc, newExc);
      this._notify();
    }

    /**
     * Removes a value on a field from both inclusion and exclusion lists.
     * @param {string} field 
     * @param {string|number} val 
     */
    removeChip(field, val) {
      const andGroup = this._getRootAndGroup();
      const { inc, exc } = this._getFieldValues(andGroup, field);
      const vStr = String(val);
      const newInc = inc.filter(x => String(x) !== vStr);
      const newExc = exc.filter(x => String(x) !== vStr);
      this._setFieldValues(andGroup, field, newInc, newExc);
      this._notify();
    }

    /**
     * Returns the state of a specific value for a field: 'in', 'out' or null.
     * @param {string} field 
     * @param {string|number} val 
     * @returns {'in'|'out'|null}
     */
    getChipState(field, val) {
      const andGroup = this._getRootAndGroup();
      const { inc, exc } = this._getFieldValues(andGroup, field);
      const vStr = String(val);
      if (inc.map(String).includes(vStr)) return 'in';
      if (exc.map(String).includes(vStr)) return 'out';
      return null;
    }

    /**
     * Replaces the active FilterIR state.
     * @param {object} newIR 
     */
    setIR(newIR) {
      this.activeIR = JSON.parse(JSON.stringify(newIR || {
        where: {
          kind: 'group',
          logic: 'OR',
          rules: []
        }
      }));
      if (!this.activeIR.followed) {
        this.activeIR.followed = null;
      }
      this._normalize();
      this._notify();
    }

    /**
     * Returns a copy of the active FilterIR state.
     * @returns {object}
     */
    getIR() {
      return JSON.parse(JSON.stringify(this.activeIR));
    }

    /**
     * Clears all filter state to an empty FilterIR layout.
     */
    clear() {
      this.activeIR = {
        where: {
          kind: 'group',
          logic: 'OR',
          rules: [
            {
              kind: 'group',
              logic: 'AND',
              rules: []
            }
          ]
        },
        followed: null
      };
      this._notify();
    }

    /**
     * Checks if followed filters are active.
     * @returns {boolean}
     */
    isFollowed() {
      return !!(this.activeIR && this.activeIR.followed && this.activeIR.followed.in && this.activeIR.followed.in.includes('yes'));
    }

    /**
     * Toggles followed filters on or off.
     * @param {boolean} active 
     */
    toggleFollowed(active) {
      if (!this.activeIR) this._normalize();
      if (active) {
        this.activeIR.followed = { in: ['yes'], not: [] };
      } else {
        this.activeIR.followed = null;
      }
      this._notify();
    }

    /**
     * Returns true if the FilterIR has complex logic beyond a single AND group with basic operators.
     * @returns {boolean}
     */
    isAdvanced() {
      const where = this.activeIR && this.activeIR.where;
      if (!where || !Array.isArray(where.rules)) return false;

      // If there is more than one child under root OR group, it is complex
      if (where.rules.length > 1) return true;
      if (where.rules.length === 0) return false;

      const andGroup = where.rules[0];
      if (!andGroup || andGroup.kind !== 'group' || andGroup.logic !== 'AND' || !Array.isArray(andGroup.rules)) {
        return true;
      }

      // Every condition must use a field known to the quick-filter UI and a simple operator.
      // quickFilterFields is populated by the app layer — no backend-specific names here.
      const qf = this.quickFilterFields;
      for (const r of andGroup.rules) {
        if (!r || r.kind !== 'condition') return true;
        const op = (r.op || '=').toUpperCase();
        const simpleOps = ['=', '<>', 'IN', 'NOT IN', 'CONTAINS', 'NOT CONTAINS'];
        if (!simpleOps.includes(op)) return true;
        if (!qf.has(r.field)) return true;
      }

      return false;
    }

    /**
     * Clears all rules/conditions for a specific field.
     * @param {string} field 
     */
    clearField(field) {
      const andGroup = this._getRootAndGroup();
      andGroup.rules = andGroup.rules.filter(r => !(r && r.kind === 'condition' && r.field === field));
      this._notify();
    }

    /**
     * Checks if a field has any active filter conditions.
     * @param {string} field 
     * @returns {boolean}
     */
    hasFieldFilters(field) {
      const andGroup = this._getRootAndGroup();
      return andGroup.rules.some(r => r && r.kind === 'condition' && r.field === field);
    }

    /**
     * Loads FilterIR from localStorage key 'ado.filterIR', with migration path from old keys.
     */
    load() {
      let loadedIR = null;
      try {
        if (typeof localStorage !== 'undefined') {
          const sIR = localStorage.getItem('ado.filterIR');
          if (sIR) {
            loadedIR = JSON.parse(sIR);
          } else {
            // Migrate from advanced filter IR if present
            const sAdv = localStorage.getItem('ado.filtersAdvanced');
            if (sAdv) {
              loadedIR = JSON.parse(sAdv);
              // Migrate followed if present in flat filters
              const sFlat = localStorage.getItem('ado.filters');
              if (sFlat) {
                const fstate = JSON.parse(sFlat);
                if (fstate.followed && fstate.followed['yes'] === 'in') {
                  loadedIR.followed = { in: ['yes'], not: [] };
                }
                localStorage.removeItem('ado.filters');
              }
              localStorage.removeItem('ado.filtersAdvanced');
            } else {
              // Migrate from flat filters if present
              const sFlat = localStorage.getItem('ado.filters');
              if (sFlat) {
                const fstate = JSON.parse(sFlat);
                loadedIR = this._fstateToIR(fstate);
                if (fstate.followed && fstate.followed['yes'] === 'in') {
                  loadedIR.followed = { in: ['yes'], not: [] };
                }
                localStorage.removeItem('ado.filters');
              }
            }
          }
        }
      } catch (e) {
        console.error("FilterManager: failed to load or migrate filters:", e);
      }

      if (loadedIR) {
        this.setIR(loadedIR);
        this.save(); // Save the migrated version under the new key
      } else {
        this.clear();
      }
    }

    /**
     * Saves the current active FilterIR state to localStorage key 'ado.filterIR'.
     */
    save() {
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem('ado.filterIR', JSON.stringify(this.activeIR));
        }
      } catch (e) {
        console.error("FilterManager: failed to save filters:", e);
      }
    }

    /**
     * Registers a listener to receive notifications when filter state changes.
     * @param {function} listener 
     * @returns {function} unsubscribe callback
     */
    onChange(listener) {
      if (typeof listener === 'function') {
        this.listeners.push(listener);
      }
      return () => {
        this.listeners = this.listeners.filter(l => l !== listener);
      };
    }

    // --- Private Helper Methods ---

    _getRootAndGroup() {
      this._normalize();
      return this.activeIR.where.rules.find(r => r && r.kind === 'group' && r.logic === 'AND');
    }

    _normalize() {
      if (!this.activeIR) {
        this.activeIR = {};
      }
      if (!this.activeIR.where || this.activeIR.where.kind !== 'group') {
        this.activeIR.where = {
          kind: 'group',
          logic: 'OR',
          rules: []
        };
      }
      if (!Array.isArray(this.activeIR.where.rules)) {
        this.activeIR.where.rules = [];
      }
      let andGroup = this.activeIR.where.rules.find(r => r && r.kind === 'group' && r.logic === 'AND');
      if (!andGroup) {
        andGroup = { kind: 'group', logic: 'AND', rules: [] };
        this.activeIR.where.rules.unshift(andGroup);
      }
      if (this.activeIR.followed === undefined) {
        this.activeIR.followed = null;
      }
    }

    _getFieldValues(andGroup, field) {
      const inc = [];
      const exc = [];
      for (const r of andGroup.rules) {
        if (r && r.kind === 'condition' && r.field === field) {
          const op = (r.op || '=').toUpperCase();
          const val = r.value;
          if (op === 'IN' || op === 'CONTAINS') {
            const arr = Array.isArray(val) ? val : [val];
            inc.push(...arr);
          } else if (op === '=') {
            inc.push(val);
          } else if (op === 'NOT IN' || op === 'NOT CONTAINS') {
            const arr = Array.isArray(val) ? val : [val];
            exc.push(...arr);
          } else if (op === '<>') {
            exc.push(val);
          }
        }
      }
      return { inc, exc };
    }

    _setFieldValues(andGroup, field, inc, exc) {
      andGroup.rules = andGroup.rules.filter(r => !(r && r.kind === 'condition' && r.field === field));

      const isTags = this._isTagsField(field);

      if (inc.length > 0) {
        let op;
        let value;
        if (isTags) {
          op = 'CONTAINS';
          value = inc;
        } else if (inc.length > 1) {
          op = 'IN';
          value = inc;
        } else {
          op = '=';
          value = inc[0];
        }
        andGroup.rules.push({
          kind: 'condition',
          field: field,
          op: op,
          value: value
        });
      }

      if (exc.length > 0) {
        let op;
        let value;
        if (isTags) {
          op = 'NOT CONTAINS';
          value = exc;
        } else if (exc.length > 1) {
          op = 'NOT IN';
          value = exc;
        } else {
          op = '<>';
          value = exc[0];
        }
        andGroup.rules.push({
          kind: 'condition',
          field: field,
          op: op,
          value: value
        });
      }
    }

    _isTagsField(field) {
      const reg = this.fieldRegistry || (typeof window !== 'undefined' && window.api && window.api.FIELD_REGISTRY);
      if (reg && reg[field]) {
        return reg[field].type === 'tags' || reg[field].contains;
      }
      return field === 'tags';
    }

    _notify() {
      const state = this.getIR();
      for (const l of this.listeners) {
        try {
          l(state);
        } catch (e) {
          console.error("FilterManager: listener callback threw error:", e);
        }
      }
    }

    _fstateToIR(fstate) {
      if (!fstate) return null;
      const rules = [];
      for (const key of Object.keys(fstate)) {
        if (key === 'followed') continue;
        const m = fstate[key] || {};
        const inc = [], exc = [];
        
        if (Array.isArray(m.in) || Array.isArray(m.not)) {
          // Compiled DB format { in: [...], not: [...] }
          if (Array.isArray(m.in)) inc.push(...m.in);
          if (Array.isArray(m.not)) exc.push(...m.not);
        } else {
          // Raw fstate format { value: 'in' | 'out' }
          for (const v in m) {
            if (m[v] === 'in') inc.push(v);
            else if (m[v] === 'out') exc.push(v);
          }
        }
        
        const isTags = this._isTagsField(key);

        if (inc.length) {
          rules.push({
            kind: 'condition',
            field: key,
            op: isTags ? 'CONTAINS' : (inc.length > 1 ? 'IN' : '='),
            value: (isTags || inc.length > 1) ? inc : inc[0]
          });
        }
        if (exc.length) {
          rules.push({
            kind: 'condition',
            field: key,
            op: isTags ? 'NOT CONTAINS' : (exc.length > 1 ? 'NOT IN' : '<>'),
            value: (isTags || exc.length > 1) ? exc : exc[0]
          });
        }
      }

      return {
        where: {
          kind: 'group',
          logic: 'OR',
          rules: rules.length ? [
            {
              kind: 'group',
              logic: 'AND',
              rules: rules
            }
          ] : []
        }
      };
    }
  }

  return FilterManager;
});

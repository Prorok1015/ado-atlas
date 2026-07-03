// App.prefs — the single canonical preferences layer (SETTINGS_SYNC_SPEC Phase 1).
//
// Replaces the ~35 scattered `ado.*` localStorage keys (and the notify keys the
// service worker reads) with ONE registry-driven store, so that later enabling
// cross-device roaming is an adapter swap rather than a call-site rewrite.
//
// Contract (kept deliberately localStorage-shaped so existing call-sites are a
// pure swap — `localStorage.getItem('ado.x')` -> `App.prefs.get('x')`):
//   await load()      hydrate the in-memory cache from chrome.storage (once, early in boot)
//   get(key)          SYNC read from cache; value is a STRING (or the registry default, null)
//   set(key,val)      update cache + async write-through + fire onChange
//   remove(key)       delete a key (mirrors localStorage.removeItem)
//   getAll()          shallow snapshot of the cache
//   onChange(cb)      (key,val) notifications — infra for Phase 2 sync-dirty marking
//   export()          { v, ts, values } containing ONLY scope:'sync' keys (the sync payload)
//   import(blob)      merge sync-scoped keys from a payload (Phase 2 adds per-key LWW by ts)
//   REGISTRY          the single source of truth: { key: { default, scope, area, type, ... } }
//
// DESIGN NOTES
// - Values are strings, exactly like localStorage: get() returns the cached string
//   (or REGISTRY[key].default, which is null for every key so call-sites keep their
//   own `||fallback` / `!==null` logic and behaviour stays byte-identical). `type` is
//   metadata for Phase 2 (de)serialization, not applied here.
// - Backend is chrome.storage.local for BOTH areas in Phase 1 (see `area`): device
//   keys never roam; sync keys will move to a StorageAdapter (chrome.storage.sync /
//   cloud) in Phase 2. The `_area()`/`_backend` seam below is where that slots in.
// - SECRETS FIREWALL: PAT / OAuth tokens / org·project config / ai_custom_config* /
//   license_key / __dev_force_pro are NOT in the REGISTRY and never pass through here.
//   export() emits only scope:'sync' keys, so secrets can't leak into a payload.
// - Boot-critical prefs (theme/uiScale/lang) additionally MIRROR to localStorage
//   (mirrorLS) because theme-init.js / i18n-init.js read them synchronously before
//   App (and before chrome.storage, which is async) exists — that avoids FOUC.
// - Notify prefs (followNotify/mentionNotify/notifyAge) keep their BARE chrome.storage
//   .local key names (storageKey) because background.js reads them there; routing the
//   page through App.prefs must not change where the service worker looks.
// Loaded right after state-globals.js, before feature modules that read prefs at boot.
(function () {
  const g = (typeof window !== 'undefined') ? window : globalThis;
  g.App = g.App || {};

  // Every persisted preference lives here. storageKey defaults to `ado.<key>` (the
  // legacy localStorage name, kept for continuity + one-time migration); notify keys
  // override it to their bare chrome.storage name. scope = sync|device (roaming intent,
  // Phase 2); area = sync|local (physical backend; both are chrome.storage.local now).
  const REGISTRY = {
    // ---- UI preferences (sync) ----
    theme:        { default: null, scope: 'sync',   area: 'sync',  type: 'string', mirrorLS: true },
    lang:         { default: null, scope: 'sync',   area: 'sync',  type: 'string', mirrorLS: true }, // also read by worker via chrome.storage.local['ado.lang']
    uiScale:      { default: null, scope: 'sync',   area: 'sync',  type: 'number', mirrorLS: true },
    tz:           { default: null, scope: 'sync',   area: 'sync',  type: 'number' },
    workHours:    { default: null, scope: 'sync',   area: 'sync',  type: 'string' },
    sort:         { default: null, scope: 'sync',   area: 'sync',  type: 'string' },
    auto:         { default: null, scope: 'sync',   area: 'sync',  type: 'number' },
    showEmpty:    { default: null, scope: 'sync',   area: 'sync',  type: 'bool'   },
    boardGroup:   { default: null, scope: 'sync',   area: 'sync',  type: 'string' },
    sprintGroup:  { default: null, scope: 'sync',   area: 'sync',  type: 'string' },
    tlZoom:       { default: null, scope: 'sync',   area: 'sync',  type: 'string' },
    tlGroup:      { default: null, scope: 'sync',   area: 'sync',  type: 'string' },
    timelineView: { default: null, scope: 'sync',   area: 'sync',  type: 'string' },
    rankDir:      { default: null, scope: 'sync',   area: 'sync',  type: 'string' },
    maxNodes:     { default: null, scope: 'sync',   area: 'sync',  type: 'number' },
    viewhelp:     { default: null, scope: 'sync',   area: 'sync',  type: 'bool'   },
    badges:       { default: null, scope: 'sync',   area: 'sync',  type: 'json'   },
    graphBadges:  { default: null, scope: 'sync',   area: 'sync',  type: 'json'   }, // legacy v1 badges; read-only migration source in badges.js
    custom_emojis:{ default: null, scope: 'sync',   area: 'sync',  type: 'json'   },
    // ---- Layouts (sync) ----
    layout:       { default: null, scope: 'sync',   area: 'sync',  type: 'string' },
    sideOrder:    { default: null, scope: 'sync',   area: 'sync',  type: 'json'   },
    sideHidden:   { default: null, scope: 'sync',   area: 'sync',  type: 'json'   },
    barOrder:     { default: null, scope: 'sync',   area: 'sync',  type: 'json'   },
    barHidden:    { default: null, scope: 'sync',   area: 'sync',  type: 'json'   },
    bulkOrder:    { default: null, scope: 'sync',   area: 'sync',  type: 'json'   },
    bulkHidden:   { default: null, scope: 'sync',   area: 'sync',  type: 'json'   },
    // ---- Saved filters (sync) ----
    filters:         { default: null, scope: 'sync', area: 'sync', type: 'json' }, // legacy flat filters (migration source)
    filterIR:        { default: null, scope: 'sync', area: 'sync', type: 'json' },
    filtersAdvanced: { default: null, scope: 'sync', area: 'sync', type: 'json' }, // legacy advanced filters (migration source)
    // ---- Notifications (sync intent, but MUST live in chrome.storage.local for the worker) ----
    followNotify:  { default: null, scope: 'sync', area: 'local', type: 'string', storageKey: 'followNotify', worker: true },
    mentionNotify: { default: null, scope: 'sync', area: 'local', type: 'string', storageKey: 'mentionNotify', worker: true },
    notifyAge:     { default: null, scope: 'sync', area: 'local', type: 'number', storageKey: 'notifyAge',    worker: true },
    // ---- Device-scoped (screen/device specific — never roams) ----
    mode:                     { default: null, scope: 'device', area: 'local', type: 'string' }, // last active view
    sideWidth:                { default: null, scope: 'device', area: 'local', type: 'string' },
    tlLabelWidth:             { default: null, scope: 'device', area: 'local', type: 'number' },
    activityHeight:           { default: null, scope: 'device', area: 'local', type: 'string' },
    activityCommentsCollapsed:{ default: null, scope: 'device', area: 'local', type: 'bool'   },
    activityHistoryCollapsed: { default: null, scope: 'device', area: 'local', type: 'bool'   },
    pinnedSprints:            { default: null, scope: 'device', area: 'local', type: 'json'   },
  };

  // NOT owned by App.prefs (deliberately outside the registry):
  //  * Secrets — see firewall note above.
  //  * Cache class (SETTINGS_SYNC_SPEC §3): per-project `ado.positions:<proj>` and
  //    `ado.types:<proj>` stay direct-localStorage caches (ephemeral, dynamic key,
  //    never synced).
  //  * `ado.collapsed.<groupId>` — dynamic-key, device-scoped collapse state; device
  //    prefs never roam, so it stays direct localStorage until a Phase 2 dynamic-key
  //    facility (if ever needed).

  const MIGRATED_FLAG = 'ado.__prefsMigrated';
  const SCHEMA_VERSION = 1;

  const _cache = {};        // logical key -> string value (only keys that are set)
  const _listeners = [];
  let _loadPromise = null;

  function storageKeyFor(key) { return REGISTRY[key].storageKey || ('ado.' + key); }

  // ---- backend seam: Phase 1 = chrome.storage.local for every area. Phase 2 routes
  // area:'sync' keys through the active StorageAdapter (chrome.storage.sync / cloud).
  function _hasChrome() {
    return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
  }
  const _mem = {};          // fallback store when chrome.storage is unavailable (tests/degraded)
  async function _get(keys) {
    if (_hasChrome()) { try { return await chrome.storage.local.get(keys); } catch (e) { return {}; } }
    const out = {}; (Array.isArray(keys) ? keys : [keys]).forEach(k => { if (k in _mem) out[k] = _mem[k]; }); return out;
  }
  async function _set(obj) {
    if (_hasChrome()) { try { return await chrome.storage.local.set(obj); } catch (e) { return; } }
    Object.assign(_mem, obj);
  }
  async function _remove(keys) {
    if (_hasChrome()) { try { return await chrome.storage.local.remove(keys); } catch (e) { return; } }
    (Array.isArray(keys) ? keys : [keys]).forEach(k => { delete _mem[k]; });
  }

  function _emit(key, val) {
    for (const cb of _listeners) { try { cb(key, val); } catch (e) {} }
  }

  // One-time, non-destructive import of legacy `ado.*` localStorage values into the
  // new store, mapped through the registry. Leaves localStorage untouched.
  function _migrateLegacy() {
    const patch = {};
    for (const key of Object.keys(REGISTRY)) {
      if (REGISTRY[key].worker) continue;   // notify keys were never in localStorage (already bare in chrome.storage.local)
      if (key in _cache) continue;          // already hydrated from the new store
      let v = null;
      try { v = localStorage.getItem('ado.' + key); } catch (e) {}
      if (v !== null) { _cache[key] = v; patch[storageKeyFor(key)] = v; }
    }
    patch[MIGRATED_FLAG] = true;
    _set(patch);   // async write-through; fire-and-forget
  }

  const prefs = {
    REGISTRY,

    // Hydrate the cache once. Memoised: safe to await from multiple boot entry points.
    load() {
      if (_loadPromise) return _loadPromise;
      _loadPromise = (async () => {
        const keys = Object.keys(REGISTRY).map(storageKeyFor);
        keys.push(MIGRATED_FLAG);
        const stored = await _get(keys);
        for (const key of Object.keys(REGISTRY)) {
          const sk = storageKeyFor(key);
          if (sk in stored) _cache[key] = stored[sk];
        }
        if (!stored[MIGRATED_FLAG]) _migrateLegacy();
      })();
      return _loadPromise;
    },

    get(key) {
      const r = REGISTRY[key];
      if (!r) { console.warn('App.prefs.get: unknown key', key); return null; }
      return (key in _cache) ? _cache[key] : r.default;
    },

    set(key, val) {
      const r = REGISTRY[key];
      if (!r) { console.warn('App.prefs.set: unknown key', key); return; }
      const s = String(val);           // localStorage-style coercion (numbers/bools -> string)
      _cache[key] = s;
      _set({ [storageKeyFor(key)]: s });
      if (r.mirrorLS) { try { localStorage.setItem('ado.' + key, s); } catch (e) {} }
      _emit(key, s);
    },

    remove(key) {
      const r = REGISTRY[key];
      if (!r) { console.warn('App.prefs.remove: unknown key', key); return; }
      delete _cache[key];
      _remove(storageKeyFor(key));
      if (r.mirrorLS) { try { localStorage.removeItem('ado.' + key); } catch (e) {} }
      _emit(key, null);
    },

    getAll() { return Object.assign({}, _cache); },

    onChange(cb) {
      if (typeof cb === 'function') _listeners.push(cb);
      return () => { const i = _listeners.indexOf(cb); if (i >= 0) _listeners.splice(i, 1); };
    },

    // The sync payload: ONLY scope:'sync' keys that are actually set. Device-scoped
    // keys and (by construction) secrets are excluded.
    export() {
      const values = {};
      for (const key of Object.keys(REGISTRY)) {
        if (REGISTRY[key].scope !== 'sync') continue;
        if (key in _cache) values[key] = _cache[key];
      }
      return { v: SCHEMA_VERSION, ts: Date.now(), values };
    },

    // Merge a sync payload. Unknown or non-sync keys are ignored (secret firewall).
    // Phase 2 will resolve conflicts with per-key last-write-wins by ts.
    import(blob) {
      if (!blob || typeof blob !== 'object' || !blob.values) return;
      for (const key of Object.keys(blob.values)) {
        const r = REGISTRY[key];
        if (!r || r.scope !== 'sync') continue;
        this.set(key, blob.values[key]);
      }
    },
  };

  g.App.prefs = prefs;
  if (typeof module !== 'undefined' && module.exports) module.exports = prefs;
})();

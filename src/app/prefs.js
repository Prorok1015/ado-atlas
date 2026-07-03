// App.prefs — the single canonical preferences layer (SETTINGS_SYNC_SPEC).
//
// Replaces the ~35 scattered `ado.*` localStorage keys (and the notify keys the
// service worker reads) with ONE registry-driven store. Phase 1 routed every pref
// through here over chrome.storage.local; Phase 2 (this file) adds cross-device
// roaming for sync-scoped keys via a StorageAdapter — no call-site change.
//
// Contract (kept deliberately localStorage-shaped so existing call-sites are a
// pure swap — `localStorage.getItem('ado.x')` -> `App.prefs.get('x')`):
//   await load()      hydrate the in-memory cache from the backend(s) (once, early in boot)
//   get(key)          SYNC read from cache; value is a STRING (or the registry default, null)
//   set(key,val)      update cache + write-through + fire onChange
//   remove(key)       delete a key (mirrors localStorage.removeItem)
//   getAll()          shallow snapshot of the cache
//   onChange(cb)      (key,val) notifications — fires on local set AND on remote roam
//   export()          { v, ts, values, meta } containing ONLY scope:'sync' keys (sync/backup payload)
//   import(blob)      merge sync-scoped keys — per-key LWW by ts when blob.meta present, else whole-blob adopt
//   REGISTRY          the single source of truth: { key: { default, scope, area, type, ... } }
//
// PHASE 2 — cross-device sync
// - Two storage areas, chosen per key by REGISTRY.area:
//     area:'local' -> chrome.storage.local  (device-scoped keys + notify keys the worker reads; never roams)
//     area:'sync'  -> the ACTIVE sync adapter (see _syncAdapter): chrome.storage.sync for
//                     roaming (Free + Pro), LocalArea when sync is unavailable/offline
//                     (still works, no roam). Pro cloud sync is an ENGINE on top (push/pull
//                     of export() blobs with ts-LWW), not an area — contract: SPEC §9.
// - sync-area keys are DUAL-WRITTEN: chrome.storage.local (immediate, always-durable local
//   copy) + a debounced push to the sync adapter (rate-limit friendly). load() prefers the
//   sync value and falls back to the local copy — so a Phase-1 install (all keys in local)
//   loses nothing and is promoted into the sync area on first Phase-2 boot.
// - PULL is live: chrome.storage.onChanged (area 'sync') updates the cache + local mirror +
//   fires onChange, so a change on device A lands on device B. chrome.storage.sync already
//   does per-key last-writer-wins across devices; the per-key `ts` meta (ado.__prefsMeta)
//   is what the CloudAdapter's explicit LWW + export/import round-tripping use.
// - Roaming is AUTOMATIC (per spec): as soon as Chrome Sync is on, sync-scoped prefs roam.
//   No opt-in toggle (a Pro sync toggle can gate the CloudAdapter later).
//
// SECRETS FIREWALL: PAT / OAuth tokens / org·project config / ai_custom_config* /
//   license_key / __dev_force_pro are NOT in the REGISTRY and never pass through here.
//   export() emits only scope:'sync' keys, so secrets can't leak into a payload; the sync
//   area only ever receives area:'sync' keys, so secrets never reach chrome.storage.sync.
// - Boot-critical prefs (theme/uiScale/lang) additionally MIRROR to localStorage (mirrorLS)
//   because theme-init.js / i18n-init.js read them synchronously before App (and before
//   chrome.storage, which is async) exists — that avoids FOUC, and remote roams update the
//   mirror too so the next reload's boot scripts see the roamed value.
// - Notify prefs (followNotify/mentionNotify/notifyAge) keep their BARE storageKey (no
//   ado. prefix) because background.js reads them. They are area:'sync' so they roam;
//   the worker reads chrome.storage.sync with a chrome.storage.local fallback (background.js
//   getSyncedPref) — the dual-write keeps that local copy for the fallback. followedItems/
//   mentionedItems are NOT prefs — they stay in chrome.storage.local (own channel, later).
// Loaded right after state-globals.js, before feature modules that read prefs at boot.
(function () {
  const g = (typeof window !== 'undefined') ? window : globalThis;
  g.App = g.App || {};

  // Every persisted preference lives here. storageKey defaults to `ado.<key>` (the
  // legacy localStorage name, kept for continuity + one-time migration); notify keys
  // override it to their bare chrome.storage name. scope = sync|device (roaming intent);
  // area = sync|local (which chrome.storage area / adapter backs it).
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
    // NOTE: the side-panel layout (ado.layout / ado.sideOrder / ado.sideHidden) is a
    // DYNAMIC per-work-item-type key family (ado.layout, ado.layout.Bug, ...) read
    // synchronously in the deep side-panel path — it stays direct localStorage for now
    // (see the dynamic-key note below). Only the static bar/bulk layout keys live here.
    barOrder:     { default: null, scope: 'sync',   area: 'sync',  type: 'json'   },
    barHidden:    { default: null, scope: 'sync',   area: 'sync',  type: 'json'   },
    bulkOrder:    { default: null, scope: 'sync',   area: 'sync',  type: 'json'   },
    bulkHidden:   { default: null, scope: 'sync',   area: 'sync',  type: 'json'   },
    // ---- Saved filters (sync) ----
    filters:         { default: null, scope: 'sync', area: 'sync', type: 'json' }, // legacy flat filters (migration source)
    filterIR:        { default: null, scope: 'sync', area: 'sync', type: 'json' },
    filtersAdvanced: { default: null, scope: 'sync', area: 'sync', type: 'json' }, // legacy advanced filters (migration source)
    // ---- Notifications (sync + roaming). Bare storageKey (no ado. prefix) because the
    // service worker reads them. area:'sync' so they roam via chrome.storage.sync; the
    // worker reads chrome.storage.sync (with a chrome.storage.local fallback) — see
    // background.js getSyncedPref. The dual-write keeps a local copy for that fallback.
    followNotify:  { default: null, scope: 'sync', area: 'sync', type: 'string', storageKey: 'followNotify', worker: true },
    mentionNotify: { default: null, scope: 'sync', area: 'sync', type: 'string', storageKey: 'mentionNotify', worker: true },
    notifyAge:     { default: null, scope: 'sync', area: 'sync', type: 'number', storageKey: 'notifyAge',    worker: true },
    // Anonymous usage telemetry (GA4). Opt-out: null/'on' = enabled, 'off' = disabled.
    // Bare storageKey + worker:true because the service worker's GA client reads it
    // directly (src/core/analytics.js enabled()); area:'sync' so the choice roams.
    telemetry:     { default: null, scope: 'sync', area: 'sync', type: 'string', storageKey: 'telemetry',   worker: true },
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
  //    prefs never roam, so it stays direct localStorage (a device-scoped dynamic family
  //    would just add a DYNAMIC entry with area:'local' if ever wanted).

  // DYNAMIC-KEY FAMILIES — full keys that share a prefix (e.g. the side-panel layout is
  // stored PER work-item-type: ado.layout, ado.layout.Bug, ...). They don't fit the static
  // REGISTRY (unbounded key set) but still need to roam. Handled by getDynamic/setDynamic/
  // removeDynamic + a small index (DYN_INDEX_KEY) so load() can hydrate them without a
  // full-store scan. Roaming rides chrome.storage.sync's native per-key merge (no ts-meta;
  // dynamic keys are NOT part of export()/import() — that stays static-registry only).
  const DYNAMIC = [
    { prefix: 'ado.layout', scope: 'sync', area: 'sync', type: 'json' },   // side-panel layout schema, per work-item-type
  ];

  const MIGRATED_FLAG = 'ado.__prefsMigrated';
  const META_KEY = 'ado.__prefsMeta';   // { logicalKey: ts } — per-key last-write time (roams in the sync area)
  const DYN_INDEX_KEY = 'ado.__dynKeys'; // JSON array of live dynamic full keys (roams in the sync area)
  const SCHEMA_VERSION = 1;
  const SYNC_FLUSH_MS = 800;            // debounce window for pushing sync-area writes (chrome.storage.sync rate limits)

  const _cache = {};        // logical key -> string value (only keys that are set)
  const _meta = {};         // logical key -> ts (sync-scoped keys)
  const _dirty = new Set(); // sync-scoped keys changed locally since the last flush
  const _dynCache = {};     // dynamic full key -> string value
  const _dynDirty = new Set(); // dynamic full keys changed locally since the last flush
  const _dynIndex = new Set(); // all dynamic full keys currently set (persisted as DYN_INDEX_KEY)
  const _listeners = [];
  let _loadPromise = null;
  let _flushTimer = null;
  let _listenerWired = false;

  // Match a full storage key to its dynamic family (exact prefix or prefix + '.').
  function _dynClassify(fullKey) {
    for (const d of DYNAMIC) { if (fullKey === d.prefix || fullKey.startsWith(d.prefix + '.')) return d; }
    return null;
  }
  function _parseJSONArray(raw) {
    if (!raw) return null;
    try { const a = JSON.parse(raw); return Array.isArray(a) ? a : null; } catch (e) { return null; }
  }

  function storageKeyFor(key) { return REGISTRY[key].storageKey || ('ado.' + key); }

  // Reverse map (sync-area storageKey -> logical key) for the onChanged roam handler.
  const _skToKey = {};
  for (const key of Object.keys(REGISTRY)) {
    if (REGISTRY[key].area === 'sync') _skToKey[storageKeyFor(key)] = key;
  }

  function _now() { return Date.now(); }

  // ---------------------------------------------------------------------------
  // Storage adapters. Each = { get(keys)->Promise<obj>, set(obj)->Promise, remove(keys)->Promise }.
  // ---------------------------------------------------------------------------
  function _hasChromeLocal() { return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local; }
  function _hasChromeSync()  { return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync; }

  const _mem = {};   // in-memory fallback (tests / degraded environments without chrome.storage)
  const LocalArea = {
    name: 'local',
    async get(keys) {
      if (_hasChromeLocal()) { try { return await chrome.storage.local.get(keys); } catch (e) { return {}; } }
      const out = {}; (Array.isArray(keys) ? keys : [keys]).forEach(k => { if (k in _mem) out[k] = _mem[k]; }); return out;
    },
    async set(obj) {
      if (_hasChromeLocal()) { try { return await chrome.storage.local.set(obj); } catch (e) { return; } }
      Object.assign(_mem, obj);
    },
    async remove(keys) {
      if (_hasChromeLocal()) { try { return await chrome.storage.local.remove(keys); } catch (e) { return; } }
      (Array.isArray(keys) ? keys : [keys]).forEach(k => { delete _mem[k]; });
    },
  };
  const ChromeSyncArea = {
    name: 'sync',
    available() { return _hasChromeSync(); },
    async get(keys)   { try { return await chrome.storage.sync.get(keys); } catch (e) { return {}; } },
    async set(obj)    { try { return await chrome.storage.sync.set(obj);  } catch (e) { return; } },
    async remove(keys){ try { return await chrome.storage.sync.remove(keys); } catch (e) { return; } },
  };
  // NOTE — Pro cloud sync is NOT a get/set storage area: the custom backend is a
  // push/pull-of-blobs service (per-key LWW by ts), so it's an ENGINE layered on top of
  // this store, not an adapter in _syncAdapter(). It reuses export()/import()/reconcile()
  // and rides the already-wired chrome.storage.onChanged pull path (the worker writes the
  // merged doc into chrome.storage.sync). Contract: SETTINGS_SYNC_SPEC §9. BLOCKED until
  // the Go backend is live (EntitlementManager.activate() throws "not available").

  // Active adapter for area:'sync' keys: chrome.storage.sync when available (Free + Pro
  // roaming), else LocalArea (sync off / unavailable — still durable, just no roaming).
  function _syncAdapter() {
    return ChromeSyncArea.available() ? ChromeSyncArea : LocalArea;
  }
  function _syncIsRemote() { return _syncAdapter() !== LocalArea; }

  function _emit(key, val) {
    for (const cb of _listeners) { try { cb(key, val); } catch (e) {} }
  }

  function _parseMeta(raw) {
    if (!raw) return null;
    try { const m = JSON.parse(raw); return (m && typeof m === 'object') ? m : null; } catch (e) { return null; }
  }
  function _syncMeta() {   // meta snapshot for the sync-scoped keys only
    const m = {};
    for (const key of Object.keys(REGISTRY)) {
      if (REGISTRY[key].area === 'sync' && key in _meta) m[key] = _meta[key];
    }
    return m;
  }

  // Immediate local durability + (for sync-area keys) a debounced push to the sync adapter.
  function _persist(key) {
    const sk = storageKeyFor(key);
    LocalArea.set({ [sk]: _cache[key] });
    if (REGISTRY[key].area === 'sync' && _syncIsRemote()) { _dirty.add(key); _scheduleFlush(); }
  }
  function _persistRemove(key) {
    const sk = storageKeyFor(key);
    LocalArea.remove(sk);
    if (REGISTRY[key].area === 'sync' && _syncIsRemote()) { _dirty.add(key); _scheduleFlush(); }
  }
  function _persistDyn(fk) {
    LocalArea.set({ [fk]: _dynCache[fk] });
    const c = _dynClassify(fk);
    if (c && c.area === 'sync' && _syncIsRemote()) { _dynDirty.add(fk); _scheduleFlush(); }
  }
  function _persistDynRemove(fk) {
    LocalArea.remove(fk);
    const c = _dynClassify(fk);
    if (c && c.area === 'sync' && _syncIsRemote()) { _dynDirty.add(fk); _scheduleFlush(); }
  }

  function _scheduleFlush() {
    if (_flushTimer) return;
    if (typeof setTimeout === 'undefined') { _flushSync(); return; }
    _flushTimer = setTimeout(_flushSync, SYNC_FLUSH_MS);
  }
  function _flushSync() {
    _flushTimer = null;
    const adapter = _syncAdapter();
    if (adapter === LocalArea) { _dirty.clear(); _dynDirty.clear(); return; }   // nothing to roam
    const removeKeys = [];
    // Write each key on its own set() call: chrome.storage.sync enforces an 8KB/item
    // quota, so an oversized value (e.g. a big filterIR) fails ALONE instead of blocking
    // the whole batch. Its always-present local copy keeps it working; a Pro CloudAdapter
    // (no cap) removes the limit. Writes are debounced + pref changes are infrequent, so
    // this stays well under chrome.storage.sync's write-op rate limit.
    for (const key of _dirty) {
      const r = REGISTRY[key];
      if (!r || r.area !== 'sync') continue;
      const sk = storageKeyFor(key);
      if (key in _cache) adapter.set({ [sk]: _cache[key] }); else removeKeys.push(sk);
    }
    _dirty.clear();
    // Dynamic-key families (side-panel layout, ...) — same per-key discipline; also push
    // the key index so other devices know which dynamic keys exist.
    let indexDirty = false;
    for (const fk of _dynDirty) {
      const c = _dynClassify(fk);
      if (!c || c.area !== 'sync') continue;
      if (fk in _dynCache) adapter.set({ [fk]: _dynCache[fk] }); else removeKeys.push(fk);
      indexDirty = true;
    }
    _dynDirty.clear();
    if (removeKeys.length) adapter.remove(removeKeys);
    adapter.set({ [META_KEY]: JSON.stringify(_syncMeta()) });
    if (indexDirty) adapter.set({ [DYN_INDEX_KEY]: JSON.stringify([..._dynIndex]) });
  }

  // Apply a value that came FROM a remote source (import / roam) WITHOUT bumping ts to now:
  // adopt the remote ts so subsequent LWW comparisons are correct.
  function _applyRemote(key, val, ts) {
    _cache[key] = val;
    if (ts != null) _meta[key] = ts;
    LocalArea.set({ [storageKeyFor(key)]: val });
    if (REGISTRY[key].area === 'sync' && _syncIsRemote()) { _dirty.add(key); _scheduleFlush(); }
    if (REGISTRY[key].mirrorLS) { try { localStorage.setItem('ado.' + key, val); } catch (e) {} }
    _emit(key, val);
  }

  // One-time, non-destructive import of legacy `ado.*` localStorage values into the
  // new store, mapped through the registry. Leaves localStorage untouched.
  function _migrateLegacy() {
    for (const key of Object.keys(REGISTRY)) {
      if (REGISTRY[key].worker) continue;   // notify keys were never in localStorage (already bare in chrome.storage.local)
      if (key in _cache) continue;          // already hydrated from the new store
      let v = null;
      try { v = localStorage.getItem('ado.' + key); } catch (e) {}
      if (v !== null) {
        _cache[key] = v;
        LocalArea.set({ [storageKeyFor(key)]: v });
        if (REGISTRY[key].scope === 'sync' && !(key in _meta)) _meta[key] = _now();
      }
    }
    LocalArea.set({ [MIGRATED_FLAG]: true });
  }

  // Promote sync-scoped values that exist locally (Phase-1 install / legacy migration)
  // but are not yet in the sync area — the first-boot local->sync lift.
  function _promoteToSync(syncStored) {
    for (const key of Object.keys(REGISTRY)) {
      if (REGISTRY[key].area !== 'sync') continue;
      if (!(key in _cache)) continue;
      if (storageKeyFor(key) in syncStored) continue;   // already roamed
      if (!(key in _meta)) _meta[key] = _now();
      _dirty.add(key);
    }
    if (_dirty.size) _scheduleFlush();
  }

  // Hydrate dynamic-key families from the index (sync value wins, local is the fallback).
  // A second round-trip keyed by the indexed full keys — avoids scanning the whole store.
  async function _loadDynamic(adapter, localIndexRaw, syncIndexRaw) {
    const wanted = new Set();
    for (const raw of [localIndexRaw, syncIndexRaw]) {
      const arr = _parseJSONArray(raw);
      if (arr) arr.forEach(k => { if (_dynClassify(k)) wanted.add(k); });
    }
    if (!wanted.size) return;
    const dk = [...wanted];
    const [dynLocal, dynSync] = await Promise.all([
      LocalArea.get(dk),
      (adapter !== LocalArea) ? adapter.get(dk) : Promise.resolve({}),
    ]);
    for (const fk of dk) {
      if (fk in dynSync) { _dynCache[fk] = dynSync[fk]; _dynIndex.add(fk); }
      else if (fk in dynLocal) { _dynCache[fk] = dynLocal[fk]; _dynIndex.add(fk); }
    }
  }

  // Live pull: react to sync-area changes from other devices (chrome already resolved the
  // per-key merge). Updates the cache + local mirror + mirrorLS + fires onChange.
  function _wireOnChanged() {
    if (_listenerWired) return;
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.onChanged) return;
    if (_syncAdapter() !== ChromeSyncArea) return;   // only meaningful when roaming via chrome.storage.sync
    _listenerWired = true;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      for (const sk in changes) {
        if (sk === META_KEY) {
          const m = _parseMeta(changes[sk].newValue);
          if (m) for (const k in m) { if ((m[k] || 0) > (_meta[k] || 0)) _meta[k] = m[k]; }
          continue;
        }
        if (sk === DYN_INDEX_KEY) {
          const arr = _parseJSONArray(changes[sk].newValue);
          if (arr) arr.forEach(k => { if (_dynClassify(k)) _dynIndex.add(k); });
          continue;
        }
        const dc = _dynClassify(sk);
        if (dc) {                                        // dynamic-family key roamed
          const dv = changes[sk].newValue;
          if (dv === undefined) {
            if (sk in _dynCache) { delete _dynCache[sk]; _dynIndex.delete(sk); LocalArea.remove(sk); _emit(sk, null); }
          } else if (_dynCache[sk] !== dv) {
            _dynCache[sk] = dv; _dynIndex.add(sk); LocalArea.set({ [sk]: dv }); _emit(sk, dv);
          }
          continue;
        }
        const key = _skToKey[sk];
        if (!key) continue;
        const nv = changes[sk].newValue;
        if (nv === undefined) {                        // removed on another device
          if (key in _cache) { delete _cache[key]; LocalArea.remove(sk); if (REGISTRY[key].mirrorLS) { try { localStorage.removeItem('ado.' + key); } catch (e) {} } _emit(key, null); }
          continue;
        }
        if (_cache[key] === nv) continue;              // our own write echoed back
        _cache[key] = nv;
        LocalArea.set({ [sk]: nv });
        if (REGISTRY[key].mirrorLS) { try { localStorage.setItem('ado.' + key, nv); } catch (e) {} }
        _emit(key, nv);
      }
    });
  }

  // Pure per-key LWW merge (exported for tests): remote wins only when strictly newer.
  function reconcile(localValues, localMeta, remoteValues, remoteMeta) {
    const values = Object.assign({}, localValues);
    const meta = Object.assign({}, localMeta);
    for (const k of Object.keys(remoteValues || {})) {
      const rts = (remoteMeta && remoteMeta[k]) || 0;
      if (rts > (meta[k] || 0)) { values[k] = remoteValues[k]; meta[k] = rts; }
    }
    return { values, meta };
  }

  const prefs = {
    REGISTRY,
    _reconcile: reconcile,   // test hook

    // Hydrate the cache once. Memoised: safe to await from multiple boot entry points.
    load() {
      if (_loadPromise) return _loadPromise;
      _loadPromise = (async () => {
        const localKeys = [MIGRATED_FLAG], syncKeys = [];
        for (const key of Object.keys(REGISTRY)) {
          (REGISTRY[key].area === 'sync' ? syncKeys : localKeys).push(storageKeyFor(key));
        }
        const adapter = _syncAdapter();
        const [localStored, syncStored] = await Promise.all([
          LocalArea.get([...localKeys, ...syncKeys, META_KEY, DYN_INDEX_KEY]),   // sync keys' local copy is the fallback
          (adapter !== LocalArea) ? adapter.get([...syncKeys, META_KEY, DYN_INDEX_KEY]) : Promise.resolve({}),
        ]);
        for (const key of Object.keys(REGISTRY)) {
          const sk = storageKeyFor(key);
          if (REGISTRY[key].area === 'sync') {
            if (sk in syncStored) _cache[key] = syncStored[sk];          // roamed value wins
            else if (sk in localStored) _cache[key] = localStored[sk];   // Phase-1 leftover / offline
          } else if (sk in localStored) {
            _cache[key] = localStored[sk];
          }
        }
        Object.assign(_meta, _parseMeta(localStored[META_KEY]) || {}, _parseMeta(syncStored[META_KEY]) || {});
        if (!localStored[MIGRATED_FLAG]) _migrateLegacy();
        if (adapter !== LocalArea) _promoteToSync(syncStored);
        await _loadDynamic(adapter, localStored[DYN_INDEX_KEY], syncStored[DYN_INDEX_KEY]);
        _wireOnChanged();
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
      if (r.scope === 'sync') _meta[key] = _now();
      _persist(key);
      if (r.mirrorLS) { try { localStorage.setItem('ado.' + key, s); } catch (e) {} }
      _emit(key, s);
    },

    remove(key) {
      const r = REGISTRY[key];
      if (!r) { console.warn('App.prefs.remove: unknown key', key); return; }
      delete _cache[key];
      if (r.scope === 'sync') _meta[key] = _now();   // tombstone ts so a stale remote set can't resurrect it
      _persistRemove(key);
      if (r.mirrorLS) { try { localStorage.removeItem('ado.' + key); } catch (e) {} }
      _emit(key, null);
    },

    getAll() { return Object.assign({}, _cache); },

    // Dynamic-key families (full storage key, e.g. 'ado.layout.Bug'). SYNC read from cache;
    // roams like a static key of the family's area. Not part of export()/import().
    getDynamic(fullKey) {
      if (!_dynClassify(fullKey)) { console.warn('App.prefs.getDynamic: unregistered dynamic key', fullKey); return null; }
      return (fullKey in _dynCache) ? _dynCache[fullKey] : null;
    },
    setDynamic(fullKey, val) {
      if (!_dynClassify(fullKey)) { console.warn('App.prefs.setDynamic: unregistered dynamic key', fullKey); return; }
      const s = String(val);
      _dynCache[fullKey] = s;
      _dynIndex.add(fullKey);
      _persistDyn(fullKey);
      _emit(fullKey, s);
    },
    removeDynamic(fullKey) {
      if (!_dynClassify(fullKey)) { console.warn('App.prefs.removeDynamic: unregistered dynamic key', fullKey); return; }
      delete _dynCache[fullKey];
      _dynIndex.delete(fullKey);
      _persistDynRemove(fullKey);
      _emit(fullKey, null);
    },

    onChange(cb) {
      if (typeof cb === 'function') _listeners.push(cb);
      return () => { const i = _listeners.indexOf(cb); if (i >= 0) _listeners.splice(i, 1); };
    },

    // The sync/backup payload: ONLY scope:'sync' keys that are set, with their per-key ts.
    // Device-scoped keys and (by construction) secrets are excluded.
    export() {
      const values = {}, meta = {};
      for (const key of Object.keys(REGISTRY)) {
        if (REGISTRY[key].scope !== 'sync') continue;
        if (key in _cache) { values[key] = _cache[key]; meta[key] = _meta[key] || 0; }
      }
      return { v: SCHEMA_VERSION, ts: _now(), values, meta };
    },

    // Merge a sync payload. Unknown / non-sync keys are ignored (secret firewall).
    // With blob.meta -> per-key last-write-wins by ts; without meta -> whole-blob adopt
    // (a fresh device / manual restore).
    import(blob) {
      if (!blob || typeof blob !== 'object' || !blob.values) return;
      const useLWW = blob.meta && typeof blob.meta === 'object';
      for (const key of Object.keys(blob.values)) {
        const r = REGISTRY[key];
        if (!r || r.scope !== 'sync') continue;
        if (useLWW) {
          const rts = blob.meta[key] || 0;
          if (rts > (_meta[key] || 0)) _applyRemote(key, String(blob.values[key]), rts);
        } else {
          _applyRemote(key, String(blob.values[key]), blob.ts || _now());
        }
      }
    },
  };

  g.App.prefs = prefs;
  if (typeof module !== 'undefined' && module.exports) module.exports = prefs;
})();

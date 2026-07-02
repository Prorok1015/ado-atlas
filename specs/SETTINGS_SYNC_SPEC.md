# Settings storage + cross-device sync — design spec

Foundation for syncing user preferences across devices, gated as a paid (Pro) feature.
Prepared on branch `feature/premium-subscription` after the modularization refactor.

## 1. Goals

- One canonical **preferences layer** (`App.prefs`) replacing the ~35 scattered
  `ado.*` localStorage keys + relevant `chrome.storage.local` keys.
- Sync-ready by construction: enabling roaming = swapping the storage adapter, not
  rewriting call-sites.
- **Hybrid backend**: Free tier roams via built-in `chrome.storage.sync`; Pro tier
  roams via a custom cloud backend tied to the subscription identity. Both behind one
  `StorageAdapter` interface.
- Secrets (PAT / OAuth tokens / AI API keys / license) are **firewalled out** of any
  export or sync — non-negotiable.

## 2. Two layers — do NOT conflate

| Layer | What | Lifetime | Synced? |
|---|---|---|---|
| **`App.state`** | runtime: cy, cur, live mode, orig, store, bulkSel, render tokens, editors | per session, in-memory | ❌ never |
| **`App.prefs`** (new) | persisted user preferences + layouts + saved filters | durable | ✅ (sync-scoped keys) |

`App.state` is **not** the sync target. Some `App.state` fields are *seeded* from
`App.prefs` at boot (e.g. `mode ← prefs.mode`, `rankDir ← prefs.rankDir`,
`maxNodesLimit ← prefs.maxNodes`) and written back on change — that seeding is the
only relationship.

## 3. Data classification

| Class | Keys (current) | Destination | Sync |
|---|---|---|---|
| Runtime | cy, cur, mode(live), orig, store, bulkSel, *Token | `App.state` | ❌ |
| UI prefs | theme, lang, tz, workHours, sort, auto, uiScale, showEmpty, boardGroup, sprintGroup, tlZoom, tlGroup, timelineView, rankDir, maxNodes, viewhelp, badges, graphBadges | `App.prefs` (scope: sync) | ✅ |
| Layouts | layout, side/bar/bulk Order+Hidden | `App.prefs` (scope: sync) | ✅ |
| Saved filters | filters, filterIR, filtersAdvanced | `App.prefs` (scope: sync) | ✅ |
| Notifications | followNotify, mentionNotify, notifyAge | `App.prefs` (scope: sync) — but MUST live in a `chrome.storage` area the service worker can read | ✅ |
| Device-local | sideWidth, tlLabelWidth, activityHeight, activity*Collapsed, last mode | `App.prefs` (scope: **device**) | ❌ (screen/device specific) |
| User data | followedItems | separate "user-data" stream (Phase 2+), NOT in the prefs blob | ✅ (own channel) |
| Cache | snapshot (per project) | `chrome.storage.local`, ephemeral | ❌ |
| 🔒 Secrets | config (org/project/PAT/OAuth), ai_custom_config* (API keys), license_key, __dev_force_pro | `chrome.storage.local` only | 🔒 NEVER |

`pinnedSprints` = borderline (per-project selection). Treat as device-scoped pref for
now (revisit with followedItems as user-data).

## 4. `App.prefs` API

```
App.prefs
  await load()            // called once, early in boot, before initialBoot wiring/restore.
                          // hydrates the in-memory cache from the backend(s).
  get(key)                // SYNC read from cache (keeps the ~35 call-sites synchronous)
  set(key, val)           // update cache + async write-through to the right area; fire onChange
  getAll()                // full snapshot
  onChange(cb)            // (key, val) notifications (drives live re-render + sync-dirty marking)
  export()                // → { v, ts, values } containing ONLY scope:'sync' keys — the sync payload
  import(blob)            // validate + migrate by version + merge (conflict resolution) + persist
  REGISTRY                // { key: { default, scope:'sync'|'device', area:'sync'|'local', type } }
```

**Registry is the single source of truth** for defaults, sync-scope, and (de)serialization.
`get` falls back to `REGISTRY[key].default`. Adding a pref = one registry entry.

## 5. Storage backend (in-memory cache + async areas)

Because most call-sites read prefs synchronously (hot paths + boot), `App.prefs` keeps
a **synchronous in-memory cache**, hydrated once via `await load()` at boot, with
async write-through. Backend areas:

- **device-scoped** → `chrome.storage.local` (never roams).
- **sync-scoped** → the active `StorageAdapter`:
  - `ChromeSyncAdapter` = `chrome.storage.sync` (Free tier roaming; ~100KB total /
    8KB per item — fine for prefs, watch large filter blobs).
  - `CloudAdapter` = custom backend keyed by subscription identity (Pro; no size cap).
  - Default (no entitlement / offline) = `chrome.storage.local` (no roaming, still works).

Why `chrome.storage`, not `localStorage`: (a) the service worker can read it (notify
prefs), (b) swapping local→sync→cloud is the same async API, (c) roaming is then an
adapter swap. Trade-off: async + a boot-time `await load()` (acceptable; already have
async boot).

**Legacy migration**: on first `load()`, if the new store is empty but legacy `ado.*`
localStorage keys exist, import them once into `App.prefs` (mapped by the registry),
then mark migrated. One-time, non-destructive.

## 6. Sync engine (Phase 2 — Pro)

- **Push**: debounced; on `set` of a sync-scoped key, mark dirty; flush dirty keys to
  the adapter with a per-key `ts`.
- **Pull**: on login / periodic; fetch remote, `import()` with **last-write-wins per
  key by `ts`** (simple, predictable; no field merge). Whole-blob replace only on
  first pull to a fresh device.
- **Gating**: cloud sync enabled only when `EntitlementManager` reports Pro; else the
  Free `chrome.storage.sync` adapter (or local). The sync toggle is a Pro feature in
  the existing paywall.
- **Secrets firewall**: `export()` emits only `scope:'sync'` registry keys; secrets
  are not in the registry at all, so they can never leak into a payload.

## 7. followedItems (separate user-data stream)

Larger and more volatile than prefs; already in `chrome.storage.local` and read by the
service worker. Sync it via its **own** channel/endpoint (not the prefs blob) so prefs
stay small and within `chrome.storage.sync` limits. Design in Phase 2.

## 8. Phased plan

**Phase 1 (now — no backend, behavior-identical):**
1. `src/app/prefs.js` → `App.prefs`: REGISTRY (all keys classified) + in-memory cache
   + `load/get/set/getAll/onChange/export/import`, backed by `chrome.storage.local`
   (device + sync areas both local for now) + one-time legacy `ado.*` import.
2. `await App.prefs.load()` early in boot (before `initialBoot` restores).
3. Incrementally migrate `localStorage.getItem/setItem('ado.*')` call-sites →
   `App.prefs.get/set` (same low-risk batched technique as the App.state migration;
   gate + smoke each). Sort each remaining bare var into runtime (`App.state`) vs
   pref (`App.prefs`).
4. Keep secrets in `chrome.storage.local`, explicitly outside `App.prefs`.

**Phase 2 (later — Pro):**
5. `ChromeSyncAdapter` + `CloudAdapter`; sync engine (push/pull, LWW); wire behind
   `EntitlementManager`; add the sync toggle to settings/paywall.
6. followedItems user-data sync (own channel).

Because everything routes through `App.prefs` + `export/import`, Phase 2 is an adapter
+ engine addition, not a call-site rewrite.

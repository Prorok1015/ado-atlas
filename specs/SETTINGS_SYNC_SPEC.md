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

### Implementation status (2026-07-03)

- **Phase 1 — DONE.** `App.prefs` live; every static `ado.*` pref routed through it;
  secrets firewalled; legacy migrated once.
- **Phase 2a — DONE.** StorageAdapter seam (`LocalArea`/`ChromeSyncArea`); `area:'sync'`
  keys roam via `chrome.storage.sync` (Free), dual-written to local (durable fallback);
  live pull via `chrome.storage.onChanged`; per-key `ts` meta + `export()/import()` LWW.
- **Phase 2b — DONE.** Notify prefs roam (`background.js` reads sync-first via
  `getSyncedPref`).
- **Phase 2c — DONE.** Dynamic-key facility (`getDynamic/setDynamic/removeDynamic` +
  `DYNAMIC` prefix registry + `ado.__dynKeys` index) → the per-wtype side-panel layout
  (`ado.layout[.<wtype>]`) roams. **Free-tier roaming is complete.**
- **Phase 2 (cloud) — remaining, BLOCKED on the Go backend.** Contract in §9 below.

## 9. Cloud prefs-sync API contract (Pro, Phase 2)

The Pro tier roams prefs via the custom backend instead of (or in addition to)
`chrome.storage.sync` — no per-item size cap, cross-browser, tied to the subscription
identity. The client already produces/consumes the exact payload (`export()` /
`import()` with per-key `ts`, `reconcile()` LWW); this section defines the wire contract
so the Go backend and the client `CloudSync` engine can be built independently.

### 9.1 Model

- One **prefs document per subscription identity** (keyed by `license_key`, or a stable
  user id the license maps to). Document = the `export()` shape: `{ v, ts, values, meta }`
  where `values` = `{ syncKey: stringValue }` and `meta` = `{ syncKey: ts }` (ms epoch).
- **Only `scope:'sync'` keys** ever appear (the client `export()` guarantees this) —
  device-scoped keys and secrets are structurally absent. The server MUST reject/ignore
  any key it cannot classify as a known sync pref (defence in depth).
- **Conflict resolution = per-key last-write-wins by `meta[key]` ts** (same as the client
  `reconcile()`), applied on both push (merge client→server) and pull (merge server→client).
  No field-level merge inside a value.
- Dynamic-key families (side-panel layout `ado.layout[.<wtype>]`) are NOT part of this
  blob (they roam via chrome.storage.sync's native merge). A later revision may add a
  parallel dynamic section; out of scope here.

### 9.2 Auth

- Every request carries `Authorization: Bearer <license_key>` and a JSON `installation_id`
  (both live in `chrome.storage.local`, never in the prefs blob). The backend validates
  the license against the billing provider (see PREMIUM_IMPLEMENTATION_DESIGN `/api/license/*`)
  and resolves it to the identity that owns the prefs document.
- All requests over TLS. The server never returns secrets and never accepts a `values`
  key that isn't a registered sync pref.

### 9.3 Endpoints

**`GET /api/prefs/pull`**
→ `200 { v, ts, values, meta }` — the current server document (empty `values`/`meta` for
a fresh identity). The client `import()`s it (per-key LWW; whole-blob adopt on a fresh
device where local meta is empty).

**`POST /api/prefs/push`** — body `{ v, values, meta }` (the client's changed keys, or a
full export).
→ `200 { v, ts, values, meta }` — the server merges the body into the stored document by
per-key LWW (`meta[k]` decides), persists, and returns the **authoritative merged**
document. The client `import()`s the response (idempotent — its own newer keys win, the
server's newer keys are adopted). A key present in `values` with a **newer** `meta` ts
overwrites; older is ignored. (Deletions: a key absent from `values` is left as-is; to
propagate a removal, send `values[key] = null` with a fresh `meta[key]` — server tombstones
by ts. Optional for v1.)

### 9.4 Errors (client must never lose local prefs)

| Status | Meaning | Client action |
|---|---|---|
| 401 | invalid/expired license | disable cloud sync, fall back to chrome.storage.sync/local; do NOT wipe local |
| 402 / 403 | not Pro / entitlement lapsed | disable cloud sync; keep local |
| 409 | version/precondition mismatch | `pull` then retry `push` (rebase) |
| 429 | rate limited | exponential backoff; keep dirty set for the next flush |
| 5xx / network | server/offline | keep local, retry on next debounced flush / next pull tick |

Schema version `v`: bump on incompatible payload changes; the server migrates older `v`
on read. Unknown future keys are ignored, not rejected (forward-compat).

### 9.5 Client `CloudSync` engine (wiring, when the backend is live)

- **Gating:** active only when `EntitlementManager.isPro()` AND a backend base URL is
  configured. Otherwise the Free `chrome.storage.sync` path stands (unchanged).
- **Push:** hook the existing debounced flush — instead of (or in addition to) writing
  `chrome.storage.sync`, `POST /api/prefs/push` with `export()` (or just the dirty keys +
  their meta), then `import()` the merged response.
- **Pull:** on login/boot and on a periodic `chrome.alarms` tick (and optionally on window
  focus) → `GET /api/prefs/pull` → `import()`.
- **Transport in the service worker:** the worker owns the network I/O (it has the
  `license_key`/`installation_id` and runs on alarms). The page requests a push via
  `chrome.runtime.sendMessage` (like `fetchCloudAI`); the worker performs the authenticated
  call and writes the merged result into `chrome.storage.sync`, so the page picks it up
  through the **already-wired `chrome.storage.onChanged` pull path** — no new page plumbing.
- **Rate/coalescing:** debounce push (already 800ms); coalesce bursts; pull interval
  measured in minutes. Respect `429` backoff.

This keeps secrets server-side and out of every payload, reuses the client's existing
`export()/import()/reconcile()`, and lands as a backend + a worker-side engine — no
change to the ~35 pref call-sites.

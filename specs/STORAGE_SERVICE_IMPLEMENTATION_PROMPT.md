# Implementation prompt — `StorageService` (isolate `chrome.storage.local`)

Point a fresh session at this file (e.g. `@specs/STORAGE_SERVICE_IMPLEMENTATION_PROMPT.md реализуй`).
Everything below is the task — executable fully autonomously, mirroring the contract that
shipped `App.prefs` (`specs/PREFS_IMPLEMENTATION_PROMPT.md`).

---

## Why

`DISTRIBUTION_CHANNELS_SPEC.md` Phase 1 = a portable Data Layer. The network seam already
exists (all fetch is behind the `api`/`App.backend` Provider). The remaining portability
blocker is **storage**: the app makes **~85 direct `chrome.storage.local` calls across 15
files** (incl. the service worker). Those don't exist on the SaaS/Tauri/ADO-Marketplace
targets. This task extracts them behind one `StorageService` KV abstraction with a swappable
backend — chrome.storage.local stays the default, so **behaviour is identical today**, and a
future channel just registers a different backend (localStorage/IndexedDB, Tauri fs, ADO
`ExtensionDataService`).

Note: `App.prefs` already abstracts the *preferences* KV (device + sync areas). `StorageService`
is the lower-level device KV that App.prefs' local area — and every non-pref site (auth/config,
AI configs, entitlement, followedItems, snapshot, tutorial, field cache, notifications) — sit on.

## Autonomy contract

- Work end-to-end, no questions. Run the gate yourself and keep it green before each commit:
  ```
  npm run test    # check-globals + check-i18n + check-prefs + lib + ai
  ```
  (WSL: `npm` = Windows npm on the mount. Fallback: `"/mnt/c/Program Files/nodejs/node.exe"`
  per tool.) `node --check` each changed file.
- The gate is STATIC. This change is behaviour-identical by construction (chrome backend is the
  default), so risk is low — but the service worker + auth/config path are involved, so the user
  runs ONE manual Chrome smoke at the end (produce the checklist).
- One logical batch = one commit. End messages with
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Branch `feature/premium-subscription`.

## Read first

1. `.agents/AGENTS.md` §1 (IIFE + `global` export; run `npm run check`), §11 (dual-layer caching).
2. `src/app/prefs.js` — the pattern to mirror (registry-driven KV over chrome.storage with an
   in-memory fallback + adapter seam). `StorageService` is the same idea, one level down, and
   `App.prefs`' `LocalArea` should delegate to it.
3. `src/core/api/core.js` — the auth/config + secrets read/write (`STORE_KEYS`, `getConfig`/
   `setConfig`/`clearConfig`) — the most critical caller, used by BOTH page and service worker.
4. `background.js` — service worker; uses `chrome.storage.local` directly and via `importScripts`.

## Scope

**IN:** introduce `StorageService` and route EVERY direct `chrome.storage.local.{get,set,remove,clear}`
through it (default backend = chrome.storage.local; swappable; in-memory fallback when chrome is
absent). Behaviour identical. Files with direct `chrome.storage.local` (verify with a fresh grep —
`grep -rl "chrome.storage.local" src background.js`):
`src/core/api/core.js`, `src/core/api/endpoints.js`, `src/core/api/query.js`,
`src/app/prefs.js` (its LocalArea → delegate), `src/app/snapshot.js`, `src/app/bulk.js`,
`src/app/init.js`, `src/components/i18n.js`, `src/components/entitlement-manager.js`,
`src/components/tutorial-manager.js`, `src/components/follow-manager.js`,
`src/ai/ai-provider.js`, `src/ai/custom-cloud-provider.js`, `src/components/ai-search-dialog.js`,
and `background.js`.

**OUT (do NOT build now):**
- The non-chrome backends themselves (SaaS/Tauri/Marketplace adapters) — only the seam + default.
- `chrome.storage.sync` — already encapsulated by `App.prefs`' `ChromeSyncArea` (roaming is
  chrome-specific; a non-chrome backend maps it to its own store). Leave it in prefs; note it.
- Other `chrome.*` (runtime messaging, notifications, alarms, tabs, identity, i18n/getURL) — those
  are a separate `PlatformService` env-abstraction for a later prompt. STORAGE only here.

## Design constraints (decided — implement exactly)

- **`StorageService`** in `src/core/storage.js`, IIFE exporting a global (call it
  `StorageService` — NOT `Storage`, which is a built-in DOM interface). Loaded FIRST in the core
  chain: in `index.html` **before** `src/core/lib.js`/api, and as the FIRST `importScripts(...)`
  entry in `background.js` (core/api/core.js reads config through it, and the worker needs it).
  Register in `tools/check-globals.js` too.
- **Interface mirrors `chrome.storage.local`** (so migration is a near-mechanical swap and all
  `await` call-sites are unchanged):
  ```
  StorageService.get(keysOrNull)  -> Promise<obj>   // string | string[] | null(all) — same as chrome
  StorageService.set(obj)         -> Promise<void>
  StorageService.remove(keys)     -> Promise<void>   // string | string[]
  StorageService.clear()          -> Promise<void>
  StorageService.setBackend(impl) -> void            // swap the backend (channel adapters, later)
  ```
  Default backend = `chrome.storage.local` when present; else an in-memory `Map` fallback
  (keeps node/tests + degraded envs working). The backend is a small object with the same
  get/set/remove/clear shape → channel adapters implement that.
- **Migration is a pure swap:** `chrome.storage.local.get(x)` → `StorageService.get(x)`, etc.
  Do NOT change keys, values, call-site logic, or `await` structure. `chrome.storage.local.get`
  already returns a promise in MV3, so signatures match exactly.
- **`App.prefs` delegation:** prefs.js `LocalArea` currently calls chrome.storage.local — repoint
  it at `StorageService` (its `_hasChromeLocal()`/`_mem` fallback logic is superseded by
  StorageService's own fallback). Keep prefs' `ChromeSyncArea` (sync) as-is.
- **`chrome.storage.onChanged`:** prefs uses it for the SYNC area (roam) — leave that. If any
  LOCAL onChanged listener exists, expose `StorageService.onChanged(cb)` and route it; otherwise
  skip (document that cross-context change events are a chrome-only concern the backends opt into).
- **Secrets note (no behaviour change here):** `StorageService` is just a KV; it does NOT change
  the secrets firewall (what syncs stays App.prefs' concern — secrets are absent from the
  registry). But flag in the module header that on a non-extension backend (SaaS localStorage)
  secrets are less isolated than extension storage — a security decision for the channel adapter,
  out of scope now.

## Step-by-step plan (gate green + commit each)

1. **`src/core/storage.js`** — `StorageService` (interface above + chrome/in-memory default +
   `setBackend`). Register in `index.html` (before lib/api), `background.js` importScripts (first),
   `tools/check-globals.js`. Gate.
2. **Core batch:** `core/api/core.js` (config/secrets — the critical one), `endpoints.js`
   (field cache), `query.js`, then `background.js` — swap to `StorageService`. Gate (+ note the
   worker path is now exercised; smoke later).
3. **App batch:** `prefs.js` (LocalArea → delegate), `snapshot.js`, `bulk.js`, `init.js`. Gate.
4. **Components/AI batch:** `i18n.js`, `entitlement-manager.js`, `tutorial-manager.js`,
   `follow-manager.js`, `ai-provider.js`, `custom-cloud-provider.js`, `ai-search-dialog.js`. Gate.
5. **Audit:** `grep -rn "chrome.storage.local" src background.js` → the ONLY remaining occurrence
   is inside `StorageService`'s chrome backend. Gate.

## Verification discipline

- After each batch: `node --check` changed files; `npm run test` green; grep that no stray
  `chrome.storage.local` remains outside `storage.js`.
- Confirm `StorageService` loads before its first caller in BOTH `index.html` and
  `background.js` (core/api/core.js calls it at import time indirectly — load order matters).
- IIFE + single global; no top-level leaks (check-globals). Pointer comments must not contain `*/`.

## Definition of done

- `StorageService` live; every direct `chrome.storage.local` routed through it (grep-clean);
  chrome default → behaviour identical; `App.prefs` LocalArea delegates to it; sync + other
  `chrome.*` explicitly out of scope (documented). `npm run test` green; `git status` clean;
  per-batch commits. Update memory (`backend-provider-plan`/a distribution note) with what
  shipped + that channel backends now slot in via `StorageService.setBackend`.

## Hand-off for the user's single final smoke

Chrome checklist: app boots (auth/config read via StorageService), setup save/connect works,
prefs persist + roam, snapshot restore, followed items + notifications still fire (service worker
reads config/notify via StorageService), AI provider config persists, tutorials-seen persists,
entitlement/`__dev_force_pro` still gates. No `ReferenceError`, no lost settings.

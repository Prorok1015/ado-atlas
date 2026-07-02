# Implementation prompt — `App.prefs` settings layer (Phase 1)

Point a new session at this file (e.g. `@specs/PREFS_IMPLEMENTATION_PROMPT.md реализуй`).
Everything below is the task.

---

## Autonomy contract (read carefully)

- **Work end-to-end, fully autonomously. Do NOT ask the user questions** — all design
  decisions are already made (below + in the specs). If something is genuinely
  ambiguous, pick the option most consistent with the specs and this prompt, note it in
  the commit message, and continue.
- **Do NOT wait for the user to run smoke tests between steps.** After every module /
  migration batch, run the automated gate yourself:
  ```
  npm run test        # check-globals + check-i18n + lib(78) + ai(19); must be all-green
  ```
  (In this WSL repo `npm` resolves to the Windows npm on the mount and works. If it ever
  doesn't, fall back to `"/mnt/c/Program Files/nodejs/node.exe" tools/check-globals.js`
  + the two test files.) Commit one logical step at a time only when the gate is green.
- **The user runs exactly ONE manual smoke — at the very end.** So `npm run test` is
  your per-step safety net. But note: it is STATIC — it canNOT catch runtime breakage
  (missing ref, TDZ, load order, wrong async). Compensate with the static discipline in
  "Verification" below (this refactor's history is full of gate-invisible escapes).
- End every commit message with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Work on branch `feature/premium-subscription`. One step = one commit.

## Read first (context)

1. `specs/SETTINGS_SYNC_SPEC.md` — the design you are implementing (Phase 1).
2. Memory `settings-sync-plan` — decisions + constraints. Also `refactor-app-modularization`
   (regex-hazard lessons) and `backend-provider-plan` (why prefs comes first).
3. `specs/BACKEND_PROVIDER_SPEC.md` §13.1 — do NOT do composite IDs here, but be aware
   prefs feeds provider selection later.
4. Skim `src/app/state-globals.js` (the `App.state` sibling), `src/app/settings.js`
   (name `App.settings` is TAKEN — UI behaviors), and the existing `ado.*` usage.

## Scope

**IN (this task):** SETTINGS_SYNC_SPEC Phase 1 — introduce `App.prefs` and route all
persisted preferences through it, then finish the remaining bare-state migration using
`App.prefs` as the vehicle (sorting each leftover into runtime→`App.state` vs
pref→`App.prefs`). Behavior must stay identical (no functional/UX change).

**OUT (defer, do NOT build):** the sync engine, `ChromeSyncAdapter`/`CloudAdapter`,
cloud backend, entitlement gating of sync, followedItems sync, the provider/backend
abstraction, composite IDs, federation. Design the adapter *interface* so those slot in
later, but ship only the local backend.

## Design constraints (decided — implement exactly)

- **`App.prefs`** module in `src/app/prefs.js` (bare `App.prefs = {...}`, loaded early —
  after `state-globals.js`, before feature modules that read prefs at boot). API:
  `await load()`, `get(key)`, `set(key,val)`, `getAll()`, `onChange(cb)`, `export()`,
  `import(blob)`, and `REGISTRY`.
- **Backend = `chrome.storage` (async) + in-memory synchronous cache.** `load()` (awaited
  early in boot, before `initialBoot`'s restores) hydrates the cache; `get()` is SYNC
  from cache (so the ~35 existing synchronous call-sites stay synchronous — just swap
  `localStorage.getItem('ado.x')` → `App.prefs.get('x')`); `set()` updates cache +
  async write-through + fires `onChange`. Reason for chrome.storage over localStorage:
  the service worker can read it, and later local→sync→cloud is one async API (adapter
  swap). Device-scoped keys → `chrome.storage.local`; sync-scoped → the adapter (local
  for now).
- **REGISTRY is the single source of truth**: every pref = `{ default, scope:'sync'|'device',
  area, type }`. `get` falls back to `REGISTRY[key].default`. Classify per
  SETTINGS_SYNC_SPEC §3 (UI prefs/layouts/saved filters/notify = sync; sideWidth/
  tlLabelWidth/activityHeight/collapse states/last-mode/pinnedSprints = device).
- **Secrets firewall (critical):** PAT / OAuth tokens / org·project config / AI API keys
  (`ai_custom_config*`) / `license_key` / `__dev_force_pro` are NOT in the REGISTRY and
  NEVER go through `App.prefs` — they stay in `chrome.storage.local` as today. `export()`
  emits ONLY `scope:'sync'` keys, so secrets can't leak.
- **One-time legacy migration:** on first `load()`, if the new store is empty but legacy
  `ado.*` localStorage keys exist, import them into `App.prefs` via the REGISTRY (map
  `ado.x`→`x`), then set a migrated flag. Non-destructive (leave localStorage as-is).
- **Notify prefs** (`followNotify`/`mentionNotify`/`notifyAge`) currently live in
  `chrome.storage.local` and are read by the **service worker** — keep them in a
  chrome.storage area the worker reads; route the PAGE's access through `App.prefs`, but
  do NOT break `background.js`'s reads (verify).
- **`App.settings` stays** (UI behaviors) — do not rename; `App.prefs` is the new sibling.

## Step-by-step plan (one commit each, `npm run test` green before commit)

1. **`src/app/prefs.js`** — REGISTRY (all `ado.*` keys classified + notify) + in-memory
   cache + `load/get/set/getAll/onChange/export/import` + legacy `ado.*` import. Register
   in `index.html` (right after `state-globals.js`) and `tools/check-globals.js`. Also
   register in `background.js importScripts` IF the worker will read prefs (notify) — else
   leave worker reading chrome.storage.local directly. Gate.
2. **Wire boot:** `await App.prefs.load()` early in `initialBoot` (before any localStorage
   restore in the tail) and before `wire*` helpers that read prefs. Gate.
3. **Migrate `ado.*` call-sites → `App.prefs.get/set`** in batches by area (view controls,
   layouts, filters, board/timeline, misc), converting BOTH reads and writes; delete the
   now-dead `localStorage.getItem/setItem('ado.*')`. Use the boundary-regex discipline
   (below). Gate after each batch. Keep behavior identical.
4. **Finish the remaining bare-state split** (the work deferred earlier): for each leftover
   bare global in `app.js`/modules, route it to `App.state` (pure runtime: bulkAnchor,
   dragIds, boardBusy, boardScroll, pdrag, treeEverLoaded, openSprintPath, iterCache,
   typeList, depsState, reactionCache, currentComments/History, activeCommentEditors,
   canCreate*, newSprints, pendingSprintItems, sprintGroup(runtime copy), currentUser,
   assignees, projectStates, tagList, sprintPaths, sprintNames, listCapped) or to
   `App.prefs` (anything persisted via `ado.*`). Do it in small batches, gate each.
   (This is optional-nice-to-have; if risk/time is high, land steps 1–3 first and stop —
   they are the foundation. Prefer correctness over completeness.)
5. **`export()/import()` sanity**: add a tiny node check (or extend a test) that a
   round-trip `import(export())` is stable and contains only sync-scoped keys (no
   secrets). Gate.

## Verification discipline (because there is NO per-step human smoke)

For EVERY batch that moves/renames identifiers:
- Use the boundary regex `(?<![.\w])VAR(?![\w])` — **never** `[.\w$]` in the lookbehind
  (perl interpolates `$]`). It also skips `...VAR` **spreads** — after each batch also
  grep `\.\.\.VAR` and fix. Watch ES6 shorthand `{VAR}`, object keys `VAR:`, string
  literals / element-ids (`$('x')`), and same-name LOCALS.
- After each batch: `node --check` each changed file; grep for leftover bare refs
  (WITHOUT line-level exclusions that could hide a second ref on the same line); confirm
  no `App.prefs`/`App.state` mis-write into a string or key.
- Pointer/section comments must not contain `*/`.
- Never let a top-level (load-time) reference precede its definition across files
  (load order in index.html).

## Definition of done

- `App.prefs` live; every `ado.*` localStorage access routed through it; secrets provably
  outside it (`export()` has zero secret keys); legacy values migrated once; remaining
  bare state sorted into `App.state`/`App.prefs` (or steps 1–3 landed if 4 was scoped
  out — say so).
- `npm run test` all-green; `git status` clean; each step its own commit.
- Update memory `settings-sync-plan` (Phase 1 done + what remains for Phase 2) and add a
  short note to `RESUME_REFACTOR_PROMPT.md` if architecture changed.

## Hand-off for the user's single final smoke

At the very end, output a concise Chrome smoke checklist covering every pref surface so
the user verifies once: theme/lang/timezone/work-hours/sort/auto-refresh/UI-scale,
board grouping + show-empty, timeline zoom/group + label width, graph rankDir/edge-mode/
maxNodes, sidebar/toolbar/bulk-bar layouts (order+hidden) persist across reload, saved
filters, follow/mention notify + notify-age (and that background notifications still
fire), pinned sprints, badges — each should persist across a reload exactly as before,
with no console `ReferenceError`.

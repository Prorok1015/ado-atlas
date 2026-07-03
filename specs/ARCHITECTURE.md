# ADO Atlas modularization refactor — COMPLETE

Branch `feature/premium-subscription`. This refactor (planned in `REFACTORING_PLAN.md`)
is **done**. This doc records the final architecture and how to keep working within it.

## Result

- `src/app.js` **8867 → 595 lines** (−93%). It now holds only shared helpers +
  bare state that many modules mutate (setStatus/customConfirm/refresh/setMode/
  renderViewHelp/renderBadgePanel + the editor const pickers + createChild/
  denyOnForbidden + misc).
- `src/core/api.js` (1850) → **8 files** in `src/core/api/` (core → http-auth →
  query → endpoints → graph → items → time → facade), byte-equivalent concatenation.
- `src/styles/app.css` (2098) → **9 files** in `src/styles/` (base → toolbar → views
  → side-panel → panels → fields-modals → pickers → layout-builder → tutorial),
  byte-equivalent, cascade order preserved.
- All 23 core view/editor/selection state fields live on **`App.state`**
  (`src/app/state-globals.js`); no compatibility bridge remains.
- `initialBoot` decomposed into `wireControls`/`wireBulkBar`/`wireEditorAndKeys`/
  `wireModals` (in `src/app/init.js`); boot orchestration tail stays inline.
- Tutorials JSON moved to `src/components/tutorials/`.

## Settings layer — `App.prefs` (SETTINGS_SYNC_SPEC Phase 1 + Phase 2a done)

- `src/app/prefs.js` (`App.prefs`, loaded right after `state-globals.js`) is now the
  single canonical store for persisted prefs: a registry-driven, localStorage-shaped
  (string values) SYNC cache, hydrated via `await App.prefs.load()` (awaited in `boot.js`
  DOMContentLoaded + top of `initialBoot`). API: `load/get/set/remove/getAll/onChange/
  export/import` + `REGISTRY`.
- **Phase 2a (cross-device roaming) shipped:** StorageAdapter seam — LocalArea
  (`chrome.storage.local`), ChromeSyncArea (`chrome.storage.sync`, Free roaming),
  CloudArea (Pro, **stub** — Go backend not live). `_syncAdapter()` picks tier-aware
  (Pro+cloud→Cloud future; else chrome.storage.sync; else Local offline). `area:'sync'`
  keys are DUAL-WRITTEN (immediate local copy + debounced per-key push to the sync
  adapter); `load()` prefers the roamed value, falls back to local (Phase-1 installs lose
  nothing, promoted to sync on first boot). Live pull via `chrome.storage.onChanged`
  (area 'sync') → cache+mirror+onChange (applies on next render/reload). Per-key `ts` meta
  (`ado.__prefsMeta`) + `export()`→`{v,ts,values,meta}`; `import()` = per-key LWW by ts
  (or whole-blob adopt when no meta). Roaming is AUTOMATIC (no opt-in toggle). No manifest
  change (`storage` permission already covers `.sync`).
- **Phase 2b done:** notify prefs (followNotify/mentionNotify/notifyAge) now roam
  (area 'local'→'sync'); `background.js` `getSyncedPref()` reads chrome.storage.sync
  first, falls back to local — so the worker sees roams even when the page is closed.
- **Phase 2c done:** dynamic-key facility (`getDynamic/setDynamic/removeDynamic` + prefix
  registry `DYNAMIC` + roamed index `ado.__dynKeys`) → the per-wtype side-panel layout
  (`ado.layout[.<wtype>]`) roams (per-key, under the 8KB quota). loadSideLayout stays sync.
  **Free-tier roaming is now complete** (UI prefs, layouts incl. side-panel, filters, notify).
- **Phase 2 remaining (blocked/cloud-only):** wire `CloudArea` to the Go backend
  [BLOCKED — stub; and no `/api/prefs/*` contract exists yet, only `/api/license|ai/*`];
  optional Pro sync toggle (Free is automatic); `followedItems` own user-data channel
  (wants the cloud backend — too big for chrome.storage.sync).
- Every **static** `ado.*` pref is routed through `App.prefs.get/set` (theme, lang,
  uiScale, tz, workHours, sort, auto, showEmpty, board/sprint group, tl zoom/group,
  timelineView, rankDir, maxNodes, viewhelp, badges, custom_emojis, mode, bar/bulk
  layout, filterIR, notify follow/mention/age, sideWidth, tlLabelWidth, activity
  height/collapse, pinnedSprints).
- **Left as direct localStorage on purpose:** pre-App boot scripts
  (`theme-init.js`/`i18n-init.js`, synchronous, pre-chrome.storage — App.prefs mirrors
  theme/uiScale/lang there via `mirrorLS`); and the DYNAMIC-key families — per-project
  caches `ado.positions/types:<proj>`, the per-work-item-type side layout
  `ado.layout[.<wtype>]` (+ legacy `ado.sideOrder`/`sideHidden`), and `ado.collapsed.<id>`.
  These are deferred to a **Phase 2 dynamic-key facility** + the StorageAdapter/sync engine.
- **Secrets firewall:** PAT/OAuth/config/`ai_custom_config*`/`license_key`/`__dev_force_pro`
  are NOT in the REGISTRY and never touch App.prefs; `export()` emits only `scope:'sync'`
  keys (verified by `tools/check-prefs.js`). The service worker still reads the raw
  `chrome.storage.local` keys App.prefs writes (`ado.lang`, `followNotify`/`mentionNotify`/
  `notifyAge`) — `background.js` unchanged.
- **Parse-time gotcha:** `pinnedSprints`/`tlLabelWidth` were hydrated at app.js parse
  time (before `load()` resolves), so their hydration moved into `initialBoot`'s
  post-load restore block.

## Architecture (no-bundler)

Classic `<script>`s in one shared global scope; load order in `index.html`.
`window.App` is the single namespace. Two kinds of modules:

1. **`App.<area>` IIFE modules** — where the surface was already namespaced or has a
   clean public API: graph, board, tree, timeline, deps, palette, settings, setup,
   snapshot, sprint, activity, export, types, filters, item-create.
2. **Bare relocation files** — where components (`markdown-editor.js`, `card-picker.js`,
   `tags-editor.js`) and other modules call the functions **bare**, so hiding them in an
   IIFE would break untouched callers. These stay bare, just moved to their own file:
   loading, badges, sprint-utils, bulk, date-pickers, undo, attachments, mention,
   side-panel, editor, layout, init, boot.

**Rule that drove every decision:** if a symbol is referenced bare from an untouched
component or an already-extracted module, it STAYS bare (relocate, don't namespace) —
namespacing pervasive infra is churn with no benefit. `$`, `api`, `AdoLib` stay global.

## Load order (index.html)

`namespace → const → loading → badges → state-globals → undo → sprint-utils → export
→ types → timeline → item-create → settings → snapshot → setup → command-palette →
filters → dependencies → activity → graph → board → tree → bulk → date-pickers →
attachments → mention → side-panel → editor → layout → sprint-edit → init → app.js →
**boot.js (last)**`. `src/core/api/*` load in dependency order before the app scripts;
`background.js importScripts` mirrors that api order for the service worker.

## Gate (run before every commit — Windows node only)

```
NODE="/mnt/c/Program Files/nodejs/node.exe"
"$NODE" tools/check-globals.js   # → "Global-scope check OK"
"$NODE" tests/lib.test.js        # → 78 passed
"$NODE" tests/ai.test.js         # → 19 passed
```
Every new `src/**/*.js` must be added to `tools/check-globals.js` AND `index.html`
(and `background.js` if the service worker needs it). `build.ps1` copies `src/`
recursively, so new subfolders ship automatically.

## Hard lessons (see memory `refactor-app-modularization`)

- **check-globals is static** — it catches duplicate top-level names + syntax, NOT
  runtime breakage (missing bare ref, TDZ, load order, wrong SVG attr). Every
  runtime-affecting change needs a manual Chrome smoke.
- **Pointer/banner comments must not contain `*/`** (`register*/time` closed a block
  comment early).
- **Regex state migration** (`(?<![.\w])VAR(?![\w])`): never `[.\w$]` in the lookbehind
  (perl interpolates `$]`); it also skips `...VAR` spreads (fix separately); watch ES6
  shorthand `{VAR}`, object keys `VAR:`, SVG attrs (`cy=`), element-id strings
  (`$('cy')`), and same-name LOCALS (theme/auth `mode`, `cur` in lib.js) — several of
  these are gate-invisible, so grep-review the diff and `node --check` each file.

## Optional remaining work (NOT required — modularization goal met)

- Migrate the rest of the app.js-declared bare state (bulkAnchor/dragIds/boardBusy/
  boardGroup/canCreate*/currentUser/assignees/projectStates/tagList/sprint*/
  pinnedSprints/openSprintPath/iterCache/typeList/depsState/reactionCache/… + the
  module-local state in attachments/mention/side-panel/layout/editor) onto `App.state`.
- Root layout: `manifest.json` must stay at root; `index.html` + `background.js` are
  conventionally kept at root beside it (moving them means rewriting all relative
  `src/` paths + importScripts + the getURL call — Chrome-only to verify).

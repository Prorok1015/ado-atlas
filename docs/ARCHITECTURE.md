# ADO Atlas — architecture & working notes

Branch `feature/premium-subscription`. The modularization refactor is **done**; this doc is
the living reference for the codebase architecture, conventions, and how to keep working
within it (updated as `App.prefs`, the Provider seam, etc. land).
Outstanding roadmap items are tracked via GitHub Issues #29—#67.

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

## Settings layer — `App.prefs` (Settings Sync Phase 1 + Phase 2a done)

- Local preference storage and free-tier roaming via `chrome.storage.sync` are fully implemented (Phase 1, 2a, 2b, 2c). Cloud sync for Pro users is tracked in [Issue #62](https://github.com/Prorok1015/ado-atlas/issues/62).

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

## Gate (run before every commit)

```
npm run test   # check-globals + check-i18n-keys + check-prefs + lib.test (79) + ai.test (19)
```
In this WSL repo `npm` resolves to the Windows npm on the mount. Fallback (run each with the
Windows node directly): `NODE="/mnt/c/Program Files/nodejs/node.exe"` then
`"$NODE" tools/check-globals.js` (→ "Global-scope check OK"), `tools/check-i18n-keys.js`,
`tools/check-prefs.js`, `tests/lib.test.js` (→ 79 passed), `tests/ai.test.js` (→ 19 passed).
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

## Composite/Global IDs Migration (Issue #60 / #64) — DONE
- Migration to opaque composite/global ID strings (e.g. `"ado:123"`) is fully complete across the entire API and UI boundaries.
- Cache version bumped to `snap:v2:` to invalidate stale numeric snapshot states.

## Architectural & Security Guidelines (Extracted from Specs)

### 1. Secrets Firewall (Non-negotiable)
- All connection configurations (Azure DevOps PATs, Entra ID OAuth tokens, AI API keys, and Pro license keys) must **never** be registered under \`App.prefs\`.
- Secrets must reside strictly in local storage (\`chrome.storage.local\`) and are blocked from any settings sync, exports, or backups.

### 2. Telemetry Anonymity & Separation
- **No Identity Linking**: The client-side telemetry ID (\`client_id\` in \`ga_client_id\`) and the license validation ID (\`installation_id\`) are generated independently as random UUIDs.
- There must be **no way to map** anonymous usage stats to a specific license key or user account.
- Telemetry payloads must never include PII, PAT tokens, or work-item field contents.

### 3. Capability-Driven UI (Vendor Abstraction)
- Do not assume Azure DevOps features are globally active (e.g., sprints, story points, or parent-child hierarchy).
- Before rendering UI components (like the Gantt timeline, sprint board columns, or dependency graphs), query \`api.capabilities\` to ensure they degrade gracefully when a provider does not support them (Jira/GitHub compatibility).

### 4. Feature Gating Model (Free Preview)
- **Three-State Gating**:
  - \`free\`: Feature is blocked; clicking it triggers the premium paywall modal.
  - \`preview\`: Feature is fully functional but marked with a gold \`PRO · Free Preview\` badge and shows a one-time onboarding banner (cached in local storage).
  - \`pro\`: Feature is fully functional without badges or banners.
- Preview features must be defined statically in the client-side configuration array in \`EntitlementManager\` to run without backend dependencies.

### 5. Multi-Channel Distribution & CORS Architecture
- **Microsoft Edge Add-ons**: Built using the same Chromium bundle, but must account for a separate extension redirect URI (e.g. \`https://<edge-id>.chromiumapp.org/\`) in the Entra ID application registration.
- **Standalone Web App (SaaS)**: Runs in-browser on our domain. Bypasses Azure DevOps CORS restrictions using either Entra ID OAuth 2.0 or a lightweight server-side API proxy. Support "Share View" by serializing filtered board states to Firestore and generating secure, read-only shortlinks.
- **Native ADO Marketplace Extension**: Embeds via iframe inside Azure DevOps using the Microsoft SDK. Automatically obtains credentials using \`SDK.getAppToken()\` and resolves hosts using \`SDK.getHostContext()\`.
- **Desktop App (Tauri)**: Wraps the frontend using system Webview. Bypasses browser CORS restrictions by executing fetch calls on the OS level (Rust backend) and stores settings locally in config files.

### 6. Unified Filter Pipeline & Filter IR (Intermediate Representation)
- **Backend-Agnostic Query Model**: All filter inputs (the top quick-filter chips, the advanced visual filter constructor modal, and the Natural Language AI search dialogue) must serialize rules into a unified, flat \`FilterIR\` JSON object.
- **Semantic Mapping**: The \`FilterIR\` uses vendor-neutral semantic keys (such as \`state\`, \`assignee\`, \`priority\`, \`storypoints\`) rather than platform-specific database fields (e.g., \`System.State\`).
- **Compiler Layer**: Compiling \`FilterIR\` to vendor-specific languages (e.g. WIQL for Azure DevOps, JQL for Jira) is strictly isolated inside the compiler/adapter code (like \`FilterCompiler\` and \`buildClauses\` in \`lib.js\`).

### 7. Schema-Driven UI & Visual Layout Customizer
- **Layout Definition**: Sidebar layouts, and in the future, the Toolbar and Bulk Edit forms, are rendered dynamically from a JSON schema stored per work-item type (e.g. \`ado.layout.<WType>\`).
- **Visual Builder**: Customizations are conducted via an interactive split-screen visual builder modal. The left side (Toolbox) lists available unused fields and structural elements (groups, rows, dividers, hint text blocks). The right side (Canvas) displays a drag-and-drop live preview of the layout.
- **Grid Layouts**: Layout schemas support grid structures like collapsible sections (Groups) and columns (Rows) to allow fields to display side-by-side.

### 8. Licensing Validation & Device Binding (Anti-Leaking)
- **Device ID Generation**: A unique \`installation_id\` (random UUID v4) is generated at first install and stored locally in \`chrome.storage.local\`.
- **Server Binding**: During license key activation, the client sends both the \`license_key\` and \`installation_id\` to the authentication API (\`POST /api/license/activate\`). The backend registers and binds this device ID to the subscription.
- **Activation Limits**: A single subscription key is capped at a maximum of **3 active devices** (e.g., home PC, office PC, laptop).
- **Grace Period**: To protect users from transient network or server offline failures, a 7-day grace period is enforced. A license remains functional on a device if the last successful online validation timestamp occurred within 7 days.

### 9. Client-Side Pro Features Architecture
- **Analytics Dashboard**: Computes metrics from the work-item Revisions API (`GET {proj}/_apis/wit/workItems/{id}/updates` pooled with concurrency limit 6). Shows Cycle Time distribution percentiles, Flow Efficiency (business hours aware), WIP / CFD cumulative flow stacked area charts, Aging WIP, and Stale Items (no revisions for N days). All math calculations are pure functions in `lib.js` (unit tested) and plots are rendered as responsive inline SVGs with no external CDN charting libraries.
- **Conditional Formatting**: Restyles cards in Board, rows in Tree, and bars in Timeline using user-defined rule objects `{ when: FilterIR-condition, then: styles }`. Rule matching and style merging are executed as pure functions in `lib.js` (unit tested) using the `FilterIR` predicate model.
- **Quick Task Templates**: Named presets saved to `App.prefs` (sync pref `taskTemplates`) that prefill the create-item form (title, tags, iteration, description boilerplate). Managed via a custom overlay canvas.
- **Ultra-Dark Theme**: A premium dark palette styled under the `body.ultra` class. Enabled pre-boot by reading theme configurations from local storage to avoid flashing unstyled content (FOUC).
- **Advanced Export**: Vector SVG exports of the timeline (serialized DOM SVGs) and analytics CSV reports containing per-item cycle times, target dates, and state durations calculated via `lib.js`.

### 10. Localization Engine (Runtime i18n)
- **On-The-Fly Switching**: Localization is managed via a custom client-side run-time layer (`window.i18n.t(key, params)`) that reads translation dictionaries asynchronously from local JSON locale files. This enables runtime language toggles without full page refreshes.
- **English Fallback**: English (`en.json`) is the primary dictionary and must load first or inline to serve as the fallback for any missing translation keys in other languages.
- **Interpolation**: Variable interpolation (e.g., `{count} items`) is implemented in `lib.js` as a pure, dependency-free utility to remain fully unit-testable.
- **DOM Translation Hooks**: Static DOM elements are translated using custom attributes: `data-i18n="translation_key"` updates text content, and `data-i18n-title="translation_key"` updates tooltips.
- **RTL Language Support**: Setting a language automatically updates the root document direction (`dir="rtl"`) if that language is flagged as right-to-left.

### 11. Settings Manager (`App.prefs` Details)
- **Hybrid Storage & Sync**: Houses preferences inside an asynchronous storage KV (`chrome.storage.local` or `chrome.storage.sync`) but maintains a synchronous in-memory cache populated once during early boot. This allows existing hot-path UI code to query preferences synchronously using `App.prefs.get(key)`.
- **Sync & Device Scope Routing**: Uses a single source of truth (`REGISTRY`) to classify preference keys:
  - `scope: 'sync'`: UI configurations (theme, lang, scale), layouts, and saved filters are written to sync storage for roaming.
  - `scope: 'device'`: Screen dimensions, widths, collapsed/expanded states, and pinned sprints are written to local device storage.
- **Secrets Isolation (Firewall)**: Authentication tokens, PATs, org configs, and license keys must **never** be registered under `App.prefs`. The `export()` method only exports registered `scope: 'sync'` keys, guaranteeing zero leaks of user secrets into settings backups or synced blobs.





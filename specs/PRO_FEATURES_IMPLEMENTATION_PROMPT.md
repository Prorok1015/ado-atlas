# Implementation prompt — client-side Pro features (no backend)

Point a fresh session at this file (e.g. `@specs/PRO_FEATURES_IMPLEMENTATION_PROMPT.md реализуй`).
Everything below is the task. It is written to be executed **fully autonomously** by any
model, mirroring the contract that shipped `App.prefs` (`specs/PREFS_IMPLEMENTATION_PROMPT.md`).

---

## Autonomy contract (read carefully)

- **Work end-to-end, fully autonomously. Do NOT ask the user questions.** All decisions are
  made below or in the referenced specs. If something is genuinely ambiguous, pick the option
  most consistent with the specs + existing code, note it in the commit message, and continue.
- **Do NOT wait for the user to smoke between steps.** After every feature / logical step run
  the automated gate yourself and keep it green before committing:
  ```
  npm run test    # check-globals + check-i18n + check-prefs + lib + ai ; must be all-green
  ```
  In this WSL repo `npm` resolves to Windows npm on the mount. If it ever fails, fall back to
  `"/mnt/c/Program Files/nodejs/node.exe" tools/check-globals.js` (+ `tools/check-i18n-keys.js`,
  `tools/check-prefs.js`, `tests/lib.test.js`, `tests/ai.test.js`) and `node --check <file>` per file.
- The gate is **STATIC** — it cannot catch runtime breakage (missing ref, load order, wrong
  render). Compensate with the discipline in "Verification" below; each feature is behind a Pro
  gate so exercise it with `__dev_force_pro` (see §"Dev/testing").
- **One feature = one (or a few) commit(s).** End every commit message with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Work on branch `feature/premium-subscription`.
- **The user runs ONE manual smoke at the very end** — produce the checklist in "Hand-off".

## Scope

This prompt covers **only the client-side Pro features that need NO backend** — they compute
from Azure DevOps data (already reachable via the `api.*` facade) and gate on the existing
`EntitlementManager`. This is "block 1" of the remaining spec work.

**IN (build these):**
1. **Analytics 👑 dashboard** — Cycle Time, Flow Efficiency, WIP / Cumulative Flow trend,
   Stale / Aging items (velocity + burndown optional). Source: work-item Revisions API.
2. **Conditional Formatting** — user rules that restyle cards in Board/Tree/Timeline.
3. **Quick task templates** — saved presets that prefill the create-item form.
4. **Ultra-Dark theme** — a third theme option beyond dark/light/auto.
5. **Advanced Timeline/Gantt + analytics export** — SVG (vector) export of the timeline and
   CSV export of analytics/timeline data. (PDF/Excel = OPTIONAL, see the feature note.)

**OUT (do NOT build — backend-blocked or separate blocks):** anything needing the Go backend —
license activate/validate, Hosted AI (`cloud_ai`), Hosted OAuth (`hosted_oauth`), cloud prefs
sync (SETTINGS_SYNC_SPEC §9), `share_link`, team features (`shared_views`, `tv_dashboard`,
`scheduled_reports`, `cross_project`). Also OUT: the `BACKEND_PROVIDER_SPEC` provider seam.

## Read first (context)

1. `specs/MONETIZATION_AND_ANALYTICS_SPEC.md` §2 (tier feature list), §5 Этап 3 (premium-feature
   roadmap: Revisions API → Cycle Time / Flow Efficiency on the client; SVG export; saved filters).
2. `.agents/AGENTS.md` — **non-negotiable conventions** (IIFE + `global` export; `LayerManager`
   for all overlays; `customConfirm`/`customAlert` — never native dialogs; theme CSS vars, never
   hardcoded colors; pure/dependency-free `lib.js` + Node tests; async render tokens; all ADO
   REST via `api.*`; dynamic layout via schema).
3. `src/components/entitlement-manager.js` — the gate: `EntitlementManager.isPro()`,
   `.gate(feature)` (opens paywall + returns false for Free), `__dev_force_pro`.
4. `src/app/init.js` `wirePremiumPlaceholders()` (~line 262) — the single delegated
   `[data-pro-feature]` click handler. `src/components/premium-paywall.js` (`PremiumPaywall.open`)
   and `src/components/pro-features.js` (the `CATALOG` of every planned Pro item + its `status`).
5. `src/app/prefs.js` — **persist every new preference through `App.prefs`** (add REGISTRY
   entries; do NOT invent new `localStorage`/`chrome.storage` access). Read its header for the
   REGISTRY shape (`{ default, scope, area, type }`) and the secrets firewall.
6. The modules you will touch: `src/app/settings.js` (theme), `src/app/board.js` + `src/app/tree.js`
   + `src/app/timeline.js` (card/row render), `src/app/item-create.js` (create form),
   `src/app/export.js` (export), `src/core/api/*` (Revisions/updates + batch fetch — see how
   `background.js runAllNotificationChecks` already pulls `/_apis/wit/workItems/{id}/updates`).
7. `src/components/i18n.js` + `src/locales/*.json` — every user-facing string is an i18n key in
   ALL locales (en is the base; `tools/check-i18n-keys.js` enforces key parity across en/ru/es/de).

## Shared design constraints (apply to EVERY feature)

- **Gating.** Each feature has a key already present in the pro-features `CATALOG`
  (`analytics`, `an_cycle`, `an_cfd`, `an_aging`, `an_stale`, `an_blocked`,
  `conditional_formatting`, `ultra_dark`, `quick_templates`, `export`). A Free user clicking the
  entry point must get the paywall; a Pro user must get the real feature. Use the existing
  delegated handler — do NOT scatter `isPro()` checks. **Add a live-handler dispatch** to
  `wirePremiumPlaceholders`:
  ```js
  const PRO_HANDLERS = {
    analytics: () => App.analytics.open(),
    conditional_formatting: () => App.condFormat.openEditor(),
    quick_templates: () => App.templates.openManager(),
    export: () => App.export.openProExport(),   // etc.
  };
  // inside the delegated click, after gate(feature) passes (Pro):
  if (PRO_HANDLERS[feature]) { PRO_HANDLERS[feature](); return; }
  if (window.customAlert) window.customAlert(i18n.t('pro.comingSoon'), i18n.t('pro.title')); // fallback for not-yet-built keys
  ```
  Free path is unchanged (`gate()` opens the paywall and returns false). Entry points already in
  the markup: `#analytics_btn` (`data-pro-feature="analytics"`, toolbar) and the export seg's
  `data-pro-feature="export"` PDF/Excel buttons (`index.html`). Add new entry points with the
  same `data-pro-feature="<key>"` markup + a Pro badge (`<span class="pro-badge-tiny"><ui-icon
  name="gem"></ui-icon>PRO</span>`) so gating + upsell come for free.
- **Ultra-Dark is the exception** to the gate-on-click pattern — it's a theme value; see its note.
- **Persistence → `App.prefs` only.** Any new saved setting (conditional-format rules, templates,
  analytics options) gets a REGISTRY entry in `src/app/prefs.js` (`scope:'sync'` for user prefs so
  they roam; `area:'sync'`). Read via `App.prefs.get(key)`, write via `App.prefs.set(key, JSON.stringify(...))`
  — mirror the existing string-valued call-sites. Never add raw `localStorage`/`chrome.storage`.
- **Pure logic → `lib.js` + unit tests.** All analytics math (cycle time, flow efficiency, WIP
  series, aging buckets) and conditional-format rule evaluation MUST be pure, DOM-free functions
  added to `src/core/lib.js` (exported from its return object) with unit tests in
  `tests/lib.test.js` using `node:assert`. The DOM/render layer calls them. This is how the gate
  actually verifies the hard parts.
- **UI conventions.** New modules are IIFE files exporting to `global` (or `App.<area>`), styled
  only with theme CSS vars, icons via `<ui-icon name="...">` (NEVER emoji), overlays via
  `LayerManager.open/close`, confirmations via `customConfirm`/`customAlert`. Register each new
  `src/**/*.js` in BOTH `index.html` (correct load-order) AND `tools/check-globals.js`. `build.ps1`
  ships `src/` recursively, so no build change for new files under `src/`.
- **No external CDN / network libs** (extension CSP + review). Prefer **hand-rolled inline SVG**
  for charts (the app already renders SVG timelines/graphs). If a charting/PDF lib is truly
  unavoidable, VENDOR it into `vendor/`, add it to `index.html` + `manifest.json` CSP + confirm
  `build.ps1` copies `vendor/`, and note why in the commit. Default: no new dependency.
- **ADO data via `api.*` only** (AGENTS §10). For history use the Revisions/updates endpoint
  (`GET {proj}/_apis/wit/workItems/{id}/updates`) through `api.req(...)`/`api.pool(...)`; batch
  base fields via `api.batchFetch`. Respect async render tokens (AGENTS §9) for any async panel.
- **i18n parity.** Add every string to `src/locales/en.json` (base) AND `ru.json`/`es.json`/`de.json`
  (translate; if unsure, a reasonable translation is fine) — `check-i18n-keys` fails on missing
  keys. `pseudo.json` is auto/coverage — follow whatever the other locales do for it.
- After shipping a feature, flip its `status` in `pro-features.js` `CATALOG` from `'planned'`
  (or `'stub'`) toward reality — use `'stub'` if the entry point is wired but the feature is
  partial, and keep it honest.

## Dev / testing (how to exercise a Pro feature without a license)

`EntitlementManager.isPro()` returns true when `chrome.storage.local.__dev_force_pro` is set.
In the extension's DevTools console: `chrome.storage.local.set({__dev_force_pro:true})` then
reload. Unset with `chrome.storage.local.remove('__dev_force_pro')`. Use this to smoke the Pro
path; verify the Free path (unset) still shows the paywall.

---

## Feature specs

### 1. Analytics 👑 dashboard  (keys: `analytics`, `an_cycle`, `an_cfd`, `an_aging`, `an_stale`, `an_blocked`)

**Entry point:** existing `#analytics_btn` (toolbar). Pro → open the dashboard; Free → paywall.
**Module:** new `src/app/analytics.js` → `App.analytics` (`open()`, `close()`, internal render).
Present as a full-screen overlay/panel via `LayerManager` (like `ProFeaturesPanel`/AI dialog), NOT
a 5th view-mode (keeps `settings.switchMode` untouched). It analyses the CURRENTLY loaded/filtered
item set (`App.state.store`) plus fetched history.

**Data:** fetch each relevant item's revisions via `api` (updates endpoint) — reuse the shape
`background.js` already parses (revision `rev`, `revisedDate`, `fields['System.State'].newValue`,
`System.BoardColumn`, etc.). Pool with `api.pool(tasks, 6)`. Cache results in memory + guard with
an async render token (AGENTS §9); abort on close.

**Metrics (pure functions in `lib.js`, unit-tested):**
- **Cycle Time** — per item, time from first "in progress"-class state to "done"-class state
  (use the DONE/started state sets already in the app; `sprint-utils.js` has `DONE_STATES`).
  Dashboard shows distribution (histogram/percentiles p50/p85) as inline SVG.
- **Flow Efficiency** — active time / total lead time per item (working-hours aware: reuse
  `api.setWorkHours` / the `businessSeconds` helper in `lib.js`).
- **WIP / Cumulative Flow (`an_cfd`)** — count of items per state over time (stacked area, SVG).
- **Aging WIP (`an_aging`)** — for in-progress items, age since entering current state.
- **Stale items (`an_stale`)** — items with no revision newer than N days (N configurable, a
  sync pref, default 14). **Blocked (`an_blocked`)** — items tagged/flagged blocked (best-effort
  from tags/state; if not derivable, render an empty-state and mark the catalog item honest).
**Charts:** inline SVG, theme-var colors, responsive `viewBox`. No external lib unless vendored.
**Persist:** analytics options (e.g. stale threshold, selected metric) via `App.prefs` (sync).
**Acceptance:** Pro opens a dashboard with at least Cycle Time + Flow Efficiency + WIP/CFD +
Stale, computed from real revisions, theme-correct in light/dark, no console errors; Free → paywall;
pure metric fns covered by `tests/lib.test.js`. Land Cycle Time first (one commit), then add the
rest incrementally (a commit each) — the sub-keys map to catalog items you flip to shipped.

### 2. Conditional Formatting  (key: `conditional_formatting`)

**What:** user-defined rules `{ when: <FilterIR-like condition>, then: {color|border|badge|bold} }`
that restyle Board cards, Tree rows, and Timeline bars.
**Reuse the FilterIR:** a rule's condition SHOULD reuse the existing FilterIR predicate model so
you can evaluate it with the same compiler logic (`src/core/filter-compiler.js` / `lib.js`) against
a normalized item — do NOT invent a parallel condition language. Rule evaluation = a pure function
in `lib.js` (`itemMatchesRule(item, rule)`), unit-tested.
**Editor:** `App.condFormat.openEditor()` — a `LayerManager` modal to add/edit/reorder/delete
rules (list + a simple field/op/value row + style picker). Entry point: a new gear/button (e.g.
in the Controls/view-help area or a toolbar button) with `data-pro-feature="conditional_formatting"`.
**Apply:** during card/row render in `board.js`, `tree.js`, `timeline.js`, run the rules (first
match or all-merge — pick first-match, document it) and apply inline style hooks that resolve to
theme vars where possible; a custom rule color is user-chosen so a raw color IS allowed there
(document this as the one sanctioned exception). Re-render when rules change.
**Persist:** `App.prefs` key `condFormatRules` (sync, JSON array).
**Acceptance:** a rule "state = Blocked → red left border" visibly restyles matching cards in all
three views, persists across reload, roams (it's a sync pref); Free → paywall; matcher unit-tested.

### 3. Quick task templates  (key: `quick_templates`)

**What:** named presets that prefill the create-item form (type, title prefix, tags, default
parent/iteration, description boilerplate, priority).
**Integration:** `src/app/item-create.js` (the create form). Add a "Templates ▾" control on the
create panel; picking one prefills the fields. A manager (`App.templates.openManager()`,
`LayerManager` modal) to CRUD templates. Entry point button `data-pro-feature="quick_templates"`.
**Persist:** `App.prefs` key `taskTemplates` (sync, JSON array of `{id,name,fields}`).
**Acceptance:** create a template, pick it → form prefilled; CRUD works; persists + roams; Free →
paywall.

### 4. Ultra-Dark theme  (key: `ultra_dark`)

**What:** a third theme beyond `dark`/`light`/`auto` — a deeper, higher-contrast dark palette.
**This is a theme value, not a click-gated modal.** Extend the theme system:
- `src/app/settings.js` `applyTheme`/`cycleTheme` — allow value `'ultra'`. Gate it: only apply
  `'ultra'` if `EntitlementManager.isPro()`; if a Free user has it stored (e.g. after lapse),
  fall back to `'dark'`. The theme selector UI must show Ultra-Dark with a Pro badge and route
  Free clicks to the paywall (`gate('ultra_dark')`).
- `src/boot/theme-init.js` — recognise `'ultra'` at pre-boot (add `body.ultra` alongside the
  `body.light` logic) so there's no flash. Note `theme-init.js` reads `localStorage['ado.theme']`
  synchronously; `App.prefs` mirrors `theme` to localStorage (`mirrorLS`) so this keeps working.
- `src/styles/base.css` — add a `body.ultra { ... }` block redefining the color tokens (same
  token names as `:root`/`body.light`), so the whole UI adapts with zero per-component changes.
**Persist:** already the `theme` pref in `App.prefs` (just a new allowed value).
**Acceptance:** Pro can switch to Ultra-Dark; it persists (+ roams), no FOUC on reload; Free sees
the badge and gets the paywall; light/dark/auto unaffected.

### 5. Advanced Timeline/Gantt + analytics export  (key: `export`)

**What:** vector (SVG) export of the Timeline/Gantt and CSV export of analytics/timeline data.
Free export already ships CSV/JSON of the view (`data-x` buttons → `App.export.exportView`); the
Pro placeholders are the `data-pro-feature="export"` PDF/Excel buttons.
**Do (client-only):** `App.export.openProExport()` (or direct handlers) →
- **Timeline → SVG**: serialize the timeline's rendered SVG (or build one) into a downloadable
  `.svg` (theme-neutral or current theme). This is the concrete, dependency-free deliverable.
- **Analytics/timeline → CSV**: richer CSV than the free one (per-item dates, cycle time, state
  durations). CSV generation is a pure `lib.js` function + unit test.
**PDF / Excel = OPTIONAL** and only if a lib is VENDORED (see the no-CDN rule). If you skip them,
keep the paywall/"coming soon" for those specific buttons and ship SVG + analytics-CSV; say so in
the commit and keep the catalog honest.
**Acceptance:** Pro can download a timeline `.svg` and an analytics `.csv`; Free → paywall on the
Pro buttons; CSV builder unit-tested.

## Step-by-step plan (gate green + commit each)

Independent features — land in this order (each its own commit(s); flip its `CATALOG` status):
1. **Ultra-Dark** (smallest, self-contained; proves the theme + gate path).
2. **Quick templates** (contained to item-create + a modal + one pref).
3. **Conditional formatting** (pure matcher in lib.js + editor modal + 3 render call-sites).
4. **Analytics dashboard** (largest; Cycle Time first, then Flow/CFD/Aging/Stale as follow-up
   commits). Put ALL math in lib.js with tests before wiring the SVG.
5. **Export** (SVG + analytics CSV; CSV builder in lib.js + test).

For each: add i18n keys (all locales), register new files in `index.html` + `check-globals.js`,
add `App.prefs` REGISTRY entries for new prefs, wire the `data-pro-feature` entry point +
`PRO_HANDLERS` dispatch, add lib.js pure fns + `tests/lib.test.js` cases, run `npm run test`
green, smoke the Pro path with `__dev_force_pro` and the Free path without it, commit.

## Verification discipline (no per-step human smoke)

- `node --check` every changed/new file; `npm run test` green before each commit (includes
  `check-globals`, `check-i18n` parity, `check-prefs`, lib + ai unit tests).
- New pure logic MUST have `tests/lib.test.js` coverage (that's the only automated proof of the
  math/matchers — the render layer is browser-only).
- Manually reason through: is the Free path still gated (paywall, not the feature)? Does the Pro
  path launch via `PRO_HANDLERS`? Is every string an i18n key present in all locales? Any hardcoded
  color that isn't a user-chosen conditional-format value? Any raw `localStorage`/`chrome.storage`
  that should be `App.prefs`? New file registered in `index.html` AND `check-globals.js`?
- Overlays via `LayerManager`; dialogs via `customConfirm`/`customAlert`; icons via `<ui-icon>`.
- Pointer/section comments must not contain `*/`. IIFE + `global`/`App.*` export only; no new
  top-level globals (check-globals catches collisions).

## Definition of done

- Features 1–5 (with Export/PDF/Excel possibly SVG+CSV only, noted) shipped, each gated: Free →
  paywall, Pro → real feature via `PRO_HANDLERS`. `__dev_force_pro` exercises the Pro path.
- All new prefs go through `App.prefs` (roam as sync); all new strings in all 4 locales; all new
  pure logic unit-tested. `npm run test` all-green; `git status` clean; per-feature commits.
- `pro-features.js` `CATALOG` statuses updated to reflect what shipped.
- Update memory (`monetization`/`premium` note if present, else add one) with what shipped +
  what remains (backend-blocked items); add a short note to `specs/ARCHITECTURE.md` if
  architecture changed (new `App.analytics`/`App.condFormat`/`App.templates` modules).

## Hand-off for the user's single final smoke

Output a concise Chrome checklist: set `__dev_force_pro`, reload; verify each — Analytics opens
and shows real Cycle Time/Flow/CFD/Stale with no console errors (light + dark + ultra); a
conditional-format rule restyles Board/Tree/Timeline and persists across reload; a task template
prefills the create form; Ultra-Dark applies with no FOUC and survives reload; timeline SVG +
analytics CSV download. Then UNSET `__dev_force_pro`, reload, and confirm every entry point shows
the paywall instead (Free path). No `ReferenceError` anywhere.

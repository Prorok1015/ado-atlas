# Implementation prompt — composite/global work-item ids (BACKEND_PROVIDER_SPEC §13.1)

Point a session that CAN run the extension in Chrome at this file. Everything below is the
task. Unlike the other prompts, this one **requires browser smoking** (see the contract).

---

## Why this is its own prompt (read first)

Adopting composite ids (`"ado:123"`, `"jira:PROJ-45"`) so federated providers never collide
is an **atomic** change — the app's item id becomes an opaque string EVERYWHERE at once
(store keys, cy node ids, bulkSel, `data-id` attributes, snapshot). It cannot be shipped
half-done: a mixed numeric/composite state breaks every lookup. It spans **~65 coordinated
sites across the deepest, most-entangled modules** (graph/tree/board/side-panel/editor/
snapshot + the whole `api` boundary). Its dominant failure mode — one missed `Number(id)`
coercion, or one un-stripped `#${id}` showing "#ado:123" — is **invisible to `npm run test`**
(static gate). So it must be done as one coordinated change and then **smoked in Chrome**.

The **foundation is already committed** (commit f1f3db5, dormant/additive, app still numeric):
- `lib.js`: pure `gidMake(provider,native)` / `gidNative(gid)` / `gidProvider(gid)` (+ tests).
- `App.backend.gid(native)` (wrap a native id → active provider's global id; tolerant) and
  `App.backend.nid(gid)` (native id, for DISPLAY + native-needing spots).
This prompt is the remaining transformation that flips ids to composite and consumes those helpers.

## Autonomy contract

- Work autonomously, but this change is **atomic**: make ALL the coordinated edits below,
  keep `npm run test` green, run the exhaustive grep audit (bottom), THEN smoke in Chrome
  before committing. Do NOT commit a partially-applied state.
- If splitting across commits, they must all land together (no smoke request between an
  emit-side and app-side that would leave the app broken). Prefer: one big coordinated
  commit after gate + audit + smoke.
- End commit messages with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Branch `feature/premium-subscription`.

## Design

The item id is an **opaque string** `"<providerId>:<nativeId>"`. Translate only at the two edges:
- **API boundary (core/api):** EMIT composite (every returned id/parent/dep/map-key); STRIP
  to native (`AdoLib.gidNative`) before building any ADO REST URL / WIQL.
- **Display:** show the native part (`App.backend.nid(id)` → "#123", never "#ado:123").
Everything in between (store, cy, bulkSel, `data-id`) carries the composite string unchanged;
the app must simply STOP coercing ids to numbers. User-typed / URL / notification native ids
are normalized to composite via `App.backend.gid(...)` at entry.

## The four categories + exact sites (measured — verify as you go)

### A. core/api — EMIT composite (output side)
1. `src/core/api/http-auth.js` `mapWorkItem` (~L169): `id: rawItem.id` → `id: AdoLib.gidMake('ado', rawItem.id)`. After the field loop, before `return mapped`: `if (mapped.parent != null && mapped.parent !== '') mapped.parent = AdoLib.gidMake('ado', mapped.parent);`
2. `src/core/api/items.js` `depsFromRelations` (~L12): push `AdoLib.gidMake('ado', tid)` into blocks/blockedBy.
3. `src/core/api/graph.js` `deps` (~L36): edges — `edges.push({ source: AdoLib.gidMake('ado', src), target: AdoLib.gidMake('ado', dst) })` (internal idSet/keys stay native).
4. `src/core/api/graph.js` `parents` (~L69): return keys AND values as composite — build native `out` then remap: key `gidMake('ado', w.id)`, value `parent != null ? gidMake('ado', parent) : null`.
5. `src/core/api/graph.js` `childCounts` (~L91): remap return keys to `gidMake('ado', id)` (values are counts).
6. `src/core/api/time.js` `times` (~L52): remap return keys to `gidMake('ado', wid)` (values are seconds). `timeline` keys by STATE → no change.
7. `src/core/api/items.js` `createItem` (~L457): `parent` arg is native-or-composite → `const pnat = parent != null ? AdoLib.gidNative(parent) : null;` use `pnat` in the relation URL. Returns `mapWorkItem(d)` → already composite.

### B. core/api — STRIP native (input side) — ONE centralized wrapper
Add to the END of `src/core/api/facade.js` (after the `api = {…}` literal) a table-driven
wrapper (keeps the ~20 methods' signatures, strips ids before the ADO call):
```js
(function () {
  const A = (typeof window !== "undefined" ? window : self).api;
  if (!A || typeof AdoLib === "undefined") return;
  const nid = AdoLib.gidNative;
  const ID_POS = {   // arg positions that are work-item ids
    item:[0], dependencies:[0], updateItem:[0], deleteItem:[0], history:[0],
    comment:[0], comments:[0], updateComment:[0], deleteComment:[0],
    addCommentReaction:[0], removeCommentReaction:[0], commentReactionUsers:[0],
    addAttachmentLink:[0], removeAttachmentLink:[0], browserUrl:[0], timeline:[0],
    children:[0], setParent:[0,1], addDependency:[0,1], removeDependency:[0,1],
  };
  for (const name in ID_POS) { const orig = A[name], pos = ID_POS[name]; if (typeof orig!=="function") continue;
    A[name] = function (...a){ for (const p of pos) if (a[p]!=null) a[p]=nid(a[p]); return orig.apply(this,a); }; }
  for (const name of ["deps","parents","childCounts","times"]) { const orig=A[name]; if (typeof orig!=="function") continue;
    A[name] = function (ids,...r){ return orig.call(this, Array.isArray(ids)?ids.map(nid):ids, ...r); }; }
})();
```
(`createItem` takes an object → handled in A7. `list`/`roots`/`search` take filter objects, no id
arg. Comment `cid`/reaction type are NOT ids — only the listed positions are stripped.)
Register nothing new; facade.js already loads last in the api chain (index.html + background.js).

### C. app — STOP coercing ids (drop `Number(...)` / `+dataset.id`)
Replace each coercion with the raw string:
- `src/app/graph.js`: L30 `id=Number(id)`→`id=String(id)`; L124 `Number(e.target.data('id'))`→`e.target.data('id')`; L140 same; L172 `Number(node.data('id'))`→`node.data('id')`; L205 `Number(nd.data('id'))`→`nd.data('id')`; L218 `Number(d.hot.data('id'))`→`d.hot.data('id')`; L143 `Number(ed.data('source'))`/`Number(ed.data('target'))`→ drop Number; L222 `bulkSel.has(Number(nd.data('id')))`→`bulkSel.has(nd.data('id'))`.
- `src/app.js` L432: `store.nodes[Number(nd.data('id'))]`→`store.nodes[nd.data('id')]`.
- `src/app/bulk.js`: L15,21,162,169,179 `+…dataset.id`→`…dataset.id`.
- `src/app/board.js`: L31 `+c.dataset.id`, L238 `+el.dataset.id`→ drop `+`.
- `src/app/init.js` L303 `+r.dataset.id`→`r.dataset.id`.
- `src/app/side-panel.js` L401 `+r.dataset.id`→`r.dataset.id`.
- `src/app/dependencies.js` L49 `+x.dataset.id`, L50 `+a.dataset.id`→ drop `+`.
- `src/app/editor.js` L375 `Number(v.parent)===id` → `String(v.parent)===String(id)` (both composite from the parent picker / current item).
Then grep for any surviving `+…dataset.id` / `Number(…data('id'))` / `parseInt(…dataset.id`.

### D. app — DISPLAY strip + INPUT normalize
**Display** — wrap the shown id with `App.backend.nid(...)` at these `#${id}` / `'#'+id` sites
(id here comes from the store = composite): `bulk.js:268`, `board.js:177,202,265,297,309`,
`editor.js:248,443,481`, `command-palette.js:38` (`#${node.id}`, node from store), `dependencies.js:41`,
`graph.js:35` (node label) `+56,103` (edge label `'#'+e.data('id')`), `item-create.js:56`,
`tree.js:34`, `sprint-edit.js:29`, `timeline.js:84,91`, `card-picker.js:6,172` (`n.id` from store),
`side-panel.js:399,554,1177,1336`, `filter-builder-modal.js:2377`. (For a graph NODE label, set the
cy node's display id when building nodes, or strip in the label fn.)
**Input normalize** — a bare native id typed/received becomes composite via `App.backend.gid(...)`:
- `init.js:431` search `openItem(parseInt(t))` → `openItem(App.backend.gid(t))` (keep the `/^\d+$/` numeric-search gate — it detects "user typed an id"; §13.1 note: later make provider-aware).
- `init.js:177` root URL param → `openItem(App.backend.gid(root))`.
- `command-palette.js:33` `openItem(id)` (from `#123`) → `openItem(App.backend.gid(id))`.
- `card-picker.js:212` `!App.state.store.nodes[id]` (id native from input) → check `store.nodes[App.backend.gid(id)]`; L183/386/387 open/dep-link by typed id → `App.backend.gid(v)`.
- `item-create.js:45` parent input stays native for the create call (createItem strips) — leave the `/^\d+$/` validation; it's a native ADO id the user types.
- `follow-manager.js:16` `openItemCallback(parseInt(msg.id,10))` → `openItemCallback(App.backend.gid(msg.id))` (notification carries a native id).
- Consider normalizing inside `openItem` itself (side-panel) as a backstop: if `!String(id).includes(':')` → `id = App.backend.gid(id)`.
`command-palette.js:37` / `card-picker.js:216` show `'#'+id` where id is native user input → no strip needed.

### E. snapshot — version the cache key
`src/app/snapshot.js` (~L13) stores the whole store keyed `snap:<org>/<project>` — old snapshots
hold NUMERIC ids. Bump the key (e.g. `snap:v2:<org>/<project>`) so stale numeric snapshots are
ignored (snapshot is an ephemeral cache; safe to invalidate). Verify restore rebuilds a
composite-keyed store.

## Exhaustive grep audit (run after the edits — must all be clean)
```
grep -rnE "\+[A-Za-z_.]*\.dataset\.id|Number\([^)]*\.data\('id'\)|parseInt\([^)]*dataset\.id" src   # → none
grep -rnE "store\.(nodes|kids|parent)\[Number|store\.(nodes|kids|parent)\[parseInt" src              # → none
grep -rnE "#\\\$\{[^}]*\.id[^}]*\}|'#'\s*\+\s*[A-Za-z_.]*\.id" src                                    # → each is nid()-wrapped or native-input
grep -rn "gidMake\|gidNative" src/core/api   # → every emit/strip point present
```
Also: `node --check` each changed file; confirm the facade wrapper doesn't double-wrap; confirm
`deps`/`parents`/`childCounts`/`times` outputs are composite-keyed.

## Smoke checklist (Chrome — REQUIRED before commit)
Tree: expand/collapse, skip-ancestor (filter a parent out, child still nests), child counts show.
Graph: nodes render, node/edge labels show "#123" (NOT "#ado:123"), tap opens item, dependency
drag creates/removes a link, bulk-select highlights in graph. Board: cards show "#123", drag-move
(single + multi-select) works, sprint grouping. Timeline: rows show "#123". Side panel: open item,
header/kids/deps show "#123", re-parent via picker, dependency chips open/remove. Bulk: select in
tree, bar count correct, bulk apply. Search "123" opens the item; command palette "#123" opens;
create with a numeric parent; open via notification (?root=123). Snapshot: reload restores. NO
`ReferenceError`, NO "#ado:123" anywhere, NO broken selection/graph.

## Definition of done
All A–E applied; `npm run test` green; grep audit clean; Chrome smoke passes; one coordinated
commit. Then the app is federation-ready (ids opaque) and AggregateProvider (§13.2, Provider
phase 5) can slot in. Update memory `backend-provider-plan` (composite ids done) + `RESUME_REFACTOR_PROMPT`.

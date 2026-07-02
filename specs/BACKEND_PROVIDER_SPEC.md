# Backend provider abstraction — decouple the app from Azure DevOps

Goal: make the tracker backend pluggable so a new provider (Jira, GitHub Issues, …)
can be added and the rest of the app works out of the box. Branch
`feature/premium-subscription`. Companion to `SETTINGS_SYNC_SPEC.md` (per-provider
connection config lives in the prefs/secrets layer).

## 1. Where we already are (measured)

- **Transport seam already exists.** The app never touches the network directly — it
  calls the global `api.*` (62-method facade in `src/core/api/`). No `fetch`/XHR to
  ADO outside `core/`. Swapping backends = providing a different `api` implementation.
- **Domain model is ~80% normalized.** `mapWorkItem()` already emits a provider-shaped
  item: `{ id, rev, type, title, state, assigned, parent, priority, iteration, area,
  start, target, due, est, tags, desc, ac, storypoints, remaining, completed, activity,
  risk, valuearea, deps, attachments, relations, fields, has_ac }`.
- **What leaks ADO into app/UI (the real work):** vocabulary + concepts baked into UI
  text, ids, and logic — sprint (121), iteration (56), PAT (205), project (47), org
  (40), rev (36), `Microsoft.VSTS.*` field refs (34), `System.*` (9), `dev.azure` (4).
  Plus ADO-only fields (storypoints/risk/valuearea/activity) and ADO auth (PAT/OAuth +
  org/project) surfaced in setup + all over.

So: keep the `api` seam, formalize it as a **Provider contract**, add a **capability
layer** so non-ADO providers degrade gracefully, abstract **auth/config**, and
**de-leak terminology**.

## 2. Non-goals

- Not rewriting the ADO client — it becomes `AdoProvider` (the current `core/api/*`
  behind the contract). No behavior change for ADO users.
- Not building Jira/GitHub providers now — only the seam + a capability model that a
  second provider can slot into. Adding the 2nd provider is what *validates* the seam.

## 3. Provider contract (`Provider`)

The active provider is exposed as the existing global `api` (keep the name → zero
churn to 60+ call-sites). Grouped capability areas (from today's facade):

- **meta**: `id`, `label`, `capabilities` (§5), `fieldSchema` (§6), `terms` (§7)
- **auth**: `connect(config)`, `signOut()`, `getConfig()`, `setConfig()`,
  `me()`, `isAuthed()` — replaces ADO PAT/OAuth/org/project specifics (§8)
- **query**: `list({text,order,filters,parent,signal})`, `search`, `roots`,
  `children`, `parents`, `childCounts` — replaces WIQL internals
- **items**: `item`, `createItem`, `updateItem`, `deleteItem`, `setParent`, `batchUpdate`
- **relations/deps**: `dependencies`, `addDependency`, `removeDependency`, `deps` (graph)
- **iterations/sprints**: `iterations`, `createSprint`, `updateSprintDates` (capability-gated)
- **taxonomy**: `workItemTypes`, `states`, `areas`, `assignees`, `tags`,
  `getWorkItemTypeFields`, `searchIdentities`
- **activity**: `comment(s)`, `updateComment`, `deleteComment`, `*CommentReaction*`, `history`
- **attachments**: `uploadAttachment`, `add/removeAttachmentLink`, `fetchAttachmentBlob`
- **misc**: `browserUrl(id)`, work-hours are app-side (stay in prefs, not provider)

Every method returns the **canonical model** (§4), never raw backend payloads. The
`fields` passthrough + provider-specific bits stay inside the provider.

## 4. Canonical domain model (provider-neutral)

Formalize what `mapWorkItem` already produces. A provider maps its native payloads
to/from these; the app only knows these:

- **Item**: `{ id, key?, type, title, state, assignee, parentId, priority, tags[],
  desc, ac?, dates:{start,target,due}, estimate?, points?, custom:{}, deps:{blockedBy,
  blocks}, attachments[], url, rev/version }`
- **Sprint/Iteration**: `{ id, path?, name, start, finish }` (capability-gated)
- **User**: `{ id, name, email?, avatar? }`
- **Comment / HistoryEvent / Attachment / Relation** — normalized shapes.

ADO-only fields (storypoints/risk/valuearea/activity) move under `custom` keyed by
**semantic id**, surfaced only when the provider's `fieldSchema` declares them.

## 5. Capability descriptor (the crux of "works out of the box")

Providers differ: GitHub Issues has no sprints/points/hierarchy; Jira has sprints +
different fields + workflow states. The app must render only what's supported.

```
capabilities = {
  hierarchy: true|false,        // parent/children tree (GitHub Issues: false)
  sprints: true|false,          // iteration/sprint board column
  dependencies: true|false,     // blocked-by/blocks graph
  states: 'enum'|'workflow',    // fixed set vs per-type workflow
  points: true|false,           // story points
  timeTracking: true|false,     // remaining/completed
  attachments: true|false,
  mentions: true|false,
  reactions: true|false,
  history: true|false,
  customFields: true|false,
  areas: true|false,
}
```

UI reads capabilities to hide/disable views + fields + toolbar buttons (Board's sprint
grouping, the deps graph, story-point badges, the Gantt, etc.). Views that a provider
can't back are hidden, not broken. This is the main app-side work.

## 6. Field schema (replace hardcoded FIELD_REGISTRY)

Today `FIELD_REGISTRY` hardcodes ADO refs (`System.Title`, `Microsoft.VSTS...`). Move
it behind the provider: `provider.fieldSchema` maps **semantic keys** (title, state,
assignee, priority, points, …) → provider field metadata (native ref, type, editable,
options). The app addresses fields by semantic key only; the provider owns the mapping.
Custom fields become schema entries, not special-cased.

## 7. Terminology / labels (i18n)

"Sprint" (ADO/Jira) vs "Milestone" (GitHub); "Work item" vs "Issue" vs "Ticket".
Provider supplies a `terms` map (`item`, `sprint`, `type`, `state`, `assignee`, …);
UI uses `provider.terms.sprint`-style labels via i18n, not hardcoded "sprint".

## 8. Auth / connection abstraction

ADO: PAT **or** OAuth(Entra) + org + project. Jira: API token + site + email. GitHub:
PAT/OAuth + repo/org. Generalize:

- `provider.connectionSchema` = declarative fields (type, label, secret?, required) →
  the setup modal renders the form **dynamically** from the schema (no ADO-specific
  markup).
- `provider.connect(config)` validates + stores. Secrets (tokens) go to
  `chrome.storage.local` and are **firewalled from sync** (see SETTINGS_SYNC_SPEC §
  secrets). Non-secret bits (site/org/project) may be prefs.
- `me()`/`isAuthed()` uniform.

## 9. Provider registry + selection

- `App.backend` registry: `register(provider)`, `get(id)`, `active`, `setActive(id)`.
- Active provider is written into `api` (global) at boot after selection; call-sites
  unchanged.
- Selected provider id = a pref; its connection config = per-provider (prefs +
  secrets). Multiple configured providers possible; one active.
- The service worker (notifications) also needs the active provider — it imports the
  same provider modules (mirrors today's `background.js importScripts`).

## 10. Phasing

1. **Formalize the contract (no behavior change):** document `api` as the Provider
   interface; wrap the current `core/api/*` as `AdoProvider` exposing
   `capabilities`/`fieldSchema`/`terms`/`connectionSchema` (all ADO values) via
   `App.backend.register(AdoProvider)` and point `api` at it. Gate green, ADO identical.
2. **Capability-gate the UI:** replace hardcoded assumptions (always-sprints,
   always-hierarchy, always-points, PAT/org/project setup) with reads of
   `api.capabilities` / `api.fieldSchema` / `api.terms` / `api.connectionSchema`.
   ADO advertises everything → still identical. This is the bulk of the work.
3. **De-leak vocabulary:** route sprint/iteration/PAT/org/project UI strings + field
   handling through `terms` + `fieldSchema`. Rename internal ADO-isms where cheap.
4. **Prove the seam:** implement a second provider (GitHub Issues is smallest — flat,
   no sprints/points, labels-as-states) end-to-end; fix whatever leaks surface. Then
   Jira.

## 11. Hard parts / risks

- **Hierarchy**: GitHub Issues is flat (or task-lists) → `hierarchy:false` must make
  tree/graph degrade to a list. Tree/graph assume parent/children today.
- **Sprints/points/Gantt**: GitHub has none → hide Board sprint mode + Timeline Gantt.
- **States**: ADO/Jira per-type workflows vs GitHub open/closed + labels → `states`
  capability + provider-supplied state sets/colors.
- **Queries**: WIQL is ADO-specific; the app already passes a neutral
  `{text,order,filters}` IR (filter-compiler) → each provider translates the IR to its
  query language. Keep the IR provider-neutral.
- **Dependencies / mentions / reactions / history / attachments**: availability varies
  → all capability-gated.
- **Rate limits / pagination / auth refresh** differ per provider — contained inside
  the provider.
- **Real-time / rev semantics**: `rev`/version conflict handling differs.

## 12. Relation to other work

- **App.prefs / sync**: active-provider id + non-secret connection config are prefs
  (per provider); tokens are secrets (never synced). The provider's `capabilities`
  also decide which prefs/keys are relevant.
- **AI search**: already provider-abstracted (`aiProviderRegistry`) — mirror that
  pattern (registry + capability + active) for the tracker backend.
- **Order of work**: do `App.prefs` (Phase 1 of the sync spec) first — connection
  config + active-provider selection want a real prefs layer. Then Provider Phase 1–2.

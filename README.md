# ADO Atlas (Chrome Extension)

Tree / Graph / Board / Sprint Gantt over Azure DevOps work items.
Talks to `dev.azure.com` directly from the browser — no local server, no Python.

Point it at **any** Azure DevOps organization and project: you supply the org,
project, and a Personal Access Token on first run.

> **Independent project — not affiliated with or endorsed by Microsoft.**
> "Azure DevOps" is a trademark of Microsoft Corporation. Your token and data
> stay on your device; the extension only ever contacts Azure DevOps. See
> [PRIVACY.md](PRIVACY.md). Publishing to the Chrome Web Store: see
> [PUBLISHING.md](PUBLISHING.md).

## Install (one-time, per machine)

1. Unzip the bundle (or clone this folder).
2. Open `chrome://extensions` in Chrome / Edge / Brave.
3. Toggle **Developer mode** (top-right).
4. Click **Load unpacked**, pick the unzipped folder.
5. Pin the extension icon (puzzle-piece menu → 📌 next to "ADO Atlas").

## First run

Click the toolbar icon → a new tab opens. The setup overlay offers two ways to
authenticate (pick the tab at the top):

- **Microsoft sign-in** *(Entra ID OAuth)* — one click, no token to copy, and it
  refreshes automatically. Requires a one-time Entra app registration — see
  [OAUTH-SETUP.md](OAUTH-SETUP.md).
- **Token** *(PAT)* — paste a Personal Access Token; zero external setup.

Either way you then pick an **Organization** and **Project**.

### Using a PAT (Token tab)

- **Personal Access Token** — create at
  [dev.azure.com → User settings → Personal access tokens](https://dev.azure.com/_usersSettings/tokens).
  Minimum scopes:
    - **Work Items** — Read, write & manage
    - **Project and team** — Read (used for the Assigned filter / "me" shortcut)
- **Organization** — your ADO org (the `<org>` in `dev.azure.com/<org>/...`).
- **Project** — the ADO project (the `<project>` in `dev.azure.com/<org>/<project>/...`).

After pasting the PAT, the extension **automatically** lists the organizations
that PAT can access and the projects inside the org you pick, so you can choose
them from the dropdowns instead of typing (there's also a **Load** button to
re-run it). If your PAT is scoped too narrowly to enumerate them, just type the
org/project names in directly — you can read them from your
`dev.azure.com/<org>/<project>` URL.

All three fields are required — the extension ships with no built-in defaults,
so it is not tied to any particular organization or project.

- **PAT expiry** *(optional)* — copy the expiration date shown on the token
  page. The toolbar then displays a validity countdown (e.g. `PAT: 12d`) that
  turns amber within 14 days and red within 3 days / once expired. Azure DevOps
  can't report a PAT's expiry to a PAT-authenticated request, so this date is
  recorded locally; it does not change anything if left blank.

The PAT is stored in `chrome.storage.local` on this machine only — it is not
synced via your Google account. Reopen the modal any time from the **⚙ settings
menu** (top-right of the toolbar) → **Connection** (e.g. to rotate the PAT or
switch to another org/project).

If the PAT expires or is revoked while you're working, the next request returns
HTTP 401 and the setup modal reopens automatically asking for a fresh token.

## Views & filters

- **Current project** — a pill next to the **ADO Atlas** title shows the active
  `org / project` so you always know which one you're looking at; click it to
  switch (opens the connection settings).
- **Tree / Graph / Board / Timeline** toggle in the toolbar. The Board groups
  cards **by Sprint**, **by State** (a classic Kanban — drag a card between
  columns to change its state), or **by Assignee**. Dragging also works to change
  sprint (by-Sprint) or reassign (by-Assignee).
- **Timeline** — a project-wide Gantt on one continuous axis (not cut up by
  sprint like the per-sprint Gantt). Each item is a bar from its **Start** to its
  **Target/Due**; items with no dates of their own fall back to their **sprint's**
  dates (shown hatched/faded), and anything still undated is listed in a **No
  dates** section at the bottom. The axis always includes today and ~2 months of
  future runway past the last item, so it doesn't end abruptly. **Zoom** Day /
  Week / Month (horizontal scroll; it opens centred on today) — the axis shows
  month labels with a second tier of day numbers (Day zoom) or week-start dates
  (Week zoom). Optionally **group**
  rows by Sprint / State / Assignee / Type. Grouped **by Sprint**, each group
  header draws the **sprint's own date window** as an accent line, and any item
  whose dates fall outside it gets an amber outline — so a task that crosses
  sprints or doesn't fit its sprint's dates stands out at a glance. Click a bar
  or row to open the editor. (Read-only for now — drag-to-reschedule is a
  planned follow-up.)
- **∅ empty** (board toolbar) shows empty columns too: every project **state**
  (by-State) and every team member (by-Assignee) gets a column even with no
  cards, so you can drag an item into an as-yet-unused state/assignee. (For
  by-Sprint it reveals empty sprints as narrow drop targets while dragging.)
- **New sprint** (Board → By Sprint): a dashed **＋ New sprint** column at the
  right end opens a dialog to create a dated iteration. It needs permission to
  add iteration nodes in ADO — if the create is denied (HTTP 403) the column
  disappears for the session. The new sprint is also added to the project's
  default team (best-effort) so native ADO planning sees it, and immediately
  becomes selectable in the Sprint filter.
- **Edit sprint dates** — open a sprint (click its board header) and use
  **✎ dates** in the sprint view to change its start/finish. Needs "edit node"
  permission; on HTTP 403 the button hides for the session.
- **Filters** (chip panel): State, Type, Priority, Assigned, **Sprint**, and
  **Tags**. State, **Type**, and Tag values are read from your project (the Type
  list is your process's real work-item types — no hard-coded list), sprints
  from its iterations. Click a chip once to include, again to exclude. The same
  panel also holds the **Find** box (search by id or text) and the **Sort**
  selector — for a quick jump you can also use the Command palette (Ctrl/Cmd-K).
- Large result sets are capped at 2000 items; when that happens the status bar
  shows `· capped, narrow the filters` so you know you're not seeing everything.
- **Export** (toolbar): download the current filtered view as **CSV** or **JSON**.
- **⚙ Settings menu** (top-right of the toolbar) groups the less-frequently-used
  controls in one popover: **Theme** (dark → light → **auto**, follows your OS),
  **Auto-refresh**, **Timezone**, **Work hours**, **Customize toolbar…**, and the
  **Connection** button that reopens the PAT / org / project modal.
- **Customize toolbar** (⚙ menu) — drag the rows to reorder the toolbar controls
  and uncheck any you don't use to hide them; changes apply live and are
  remembered (per browser). "Reset to default" restores the original layout.
- **Auto-refresh** (in the **⚙** menu) re-fetches the list every 1 / 5 / 15 min
  (paused while you have unsaved edits, are dragging a card, or the tab is hidden).
- **Bulk edit** (Tree view): **Ctrl/Cmd-click** toggles a row in the selection;
  **Shift-click** applies your last action to a whole range — select a range after
  selecting, or *deselect* a range after deselecting. Or hover a row and tick its
  checkbox (it only appears on hover / when selected). A plain click still opens
  the item. A bar appears letting you set State, Sprint, Priority, or Assignee on
  every selected item at once (applied in parallel, then the list refreshes).
- **Undo / Redo** — the **↶ / ↷** toolbar buttons (or **Ctrl/Cmd-Z** and
  **Ctrl/Cmd-Shift-Z / Ctrl-Y**, outside a text field) walk a stack of mutating
  actions: an editor save (fields + re-parent), a board drag, a bulk edit, or a
  create (undo deletes the item to ADO's Recycle Bin, so it stays recoverable;
  redo re-creates it). Shortcuts are keyed on the physical key, so they work on
  non-Latin keyboard layouts too. Also in the Command palette.
- **Command palette** — press **Ctrl/Cmd-K** to fuzzy-find any loaded item by id
  or title, or run a quick command (switch view, refresh, export, theme,
  settings, undo). ↑/↓ to navigate, Enter to open, Esc to close.
- **Work hours** (`N–N`, in the **⚙** menu next to the timezone): the local
  Mon–Fri window used to compute "active time" on cards and in the sprint Gantt.
- Requests **retry automatically** on throttling (HTTP 429, honoring
  `Retry-After`) and transient `5xx` errors with exponential backoff.
- The last view is **cached** (`chrome.storage.local`) and painted instantly on
  open while the live refresh runs in the background.

## Creating a work item

- **✚ New** (toolbar) — create a brand-new item from scratch. Pick a **Type**
  (the dropdown lists your process's real work-item types, fetched from ADO —
  not a hard-coded set) and **Title** (required); **Priority**, **Assignee**,
  **Sprint**, and **Parent** are all optional. The Parent uses the same
  searchable card picker as the editor — search by id/title or leave it
  **(no parent)** for a top-level item. On save the list refreshes and the new
  item opens in the editor.
  Shortcuts: press **N** anywhere (when not typing) to open it, **Ctrl/Cmd+Enter**
  to submit, **Esc** to cancel. Also reachable from the **Command palette**
  (Ctrl/Cmd-K → "New work item"). The **✚ New** and **+ Child** buttons hide
  themselves for the session if a create is denied (HTTP 403 — no permission).
- **+ Child** (item editor) — create an item already parented under the one
  you're viewing; the form stays open for rapid multi-create.

## Editing a work item

Click any item to open the side editor. Beyond the usual fields:

- **Parent** — shown as a card (type dot, id, title, state) for the current
  parent. Click it to open a searchable picker — it matches loaded items
  instantly and, as you type, also runs a **server-side search** (by title, or
  fetches an exact id) so you can pick items that aren't loaded in the tree. The
  list shows ~5 rows and scrolls. Pick a result or choose **(no parent)** to
  detach; Save applies the re-parent. The **↗** button opens the parent.
- **Description / Acceptance Criteria** — edited as **Markdown** with a live
  **preview** toggle. Supported: headings (`#`–`######`), **bold** (`**`/`__`),
  *italic* (`*`), ~~strikethrough~~ (`~~`), `inline code`, fenced code blocks,
  bullet/numbered lists, `>` blockquotes, `---` rules, and `[links](https://…)`.
  ADO stores descriptions as HTML, so the field round-trips: the item's HTML is
  converted to Markdown on load and your Markdown back to HTML on save (what the
  preview shows is what gets saved).
- **🕑 Activity** — shows the item's existing comments and a field-change history
  (state, assignee, sprint, priority, parent, …) pulled from its revisions.

## What's inside

| File | Purpose |
|---|---|
| `manifest.json` | MV3 declaration: `host_permissions` for `dev.azure.com`, `storage`, action with full-tab UI |
| `background.js` | Service worker: on icon click, open `index.html` in a tab (focuses an existing one if it's already open) |
| `index.html` | Single-page UI shell + setup-modal markup |
| `app.css` | Styles (dark + light theme, board / Gantt, modal) |
| `lib.js` | Pure, dependency-free helpers (WIQL builder, html⇄text, business-hours, PAT countdown) — shared by `api.js`/`app.js` and unit-tested |
| `api.js` | ADO REST client — direct calls to `dev.azure.com` using the PAT |
| `app.js` | Tree / Graph / Board / Sprint / Editor logic |
| `vendor/` | Cytoscape + dagre + cytoscape-dagre (bundled, no CDN) |
| `icons/` | Toolbar icons (16/48/128) |
| `build.bat` | One-shot zip into `dist/ado-atlas-extension.zip` |
| `tests/` | Node unit tests for `lib.js` (`npm test`) |

## Build (only when sharing / publishing)

Double-click `build.bat` on Windows, or run `npm run build` (both call
`build.ps1`). Result: `dist\ado-atlas-extension.zip` — a Web Store-ready package
with `manifest.json` at the root, spec-correct forward-slash paths, and only the
runtime files (no tests/docs). For publishing to the Chrome Web Store, follow
[PUBLISHING.md](PUBLISHING.md).

## Tests

The pure logic in `lib.js` has unit tests (no dependencies, no browser):

```
npm test        # or: node tests/lib.test.js
```

## Troubleshooting

- **`HTTP 401`** on first load — PAT is stale or doesn't have the right scopes.
  Click **⚙**, paste a fresh one.
- **Empty list, no errors** — the WIQL `[System.TeamProject] = @project` filter
  matched nothing. Make sure the org/project in the setup match your ADO URL
  (`dev.azure.com/<org>/<project>/...`).
- **CORS error in DevTools** — `host_permissions` in `manifest.json` is broken.
  Confirm it lists `https://dev.azure.com/*`. After editing the manifest, click
  the ↻ icon on the extension card in `chrome://extensions`.
- **The icon does nothing** — open `chrome://extensions`, click "service worker"
  under the extension card to see its console.

## License

**Proprietary — © 2026 Zakhar Lebediuk, all rights reserved.** The source is
visible for review only; no rights to use, copy, modify, or redistribute it are
granted. See [LICENSE](LICENSE). Bundled third-party libraries in `vendor/`
remain under their own MIT licenses — see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
For commercial licensing, contact prorok1015@gmail.com.

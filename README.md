# ADO Atlas (Chrome Extension)

Tree / Graph / Board / Sprint Gantt over Azure DevOps work items.
Talks to `dev.azure.com` directly from the browser — no local server, no Python.

Point it at **any** Azure DevOps organization and project: you supply the org,
project, and a Personal Access Token on first run.

## Install (one-time, per machine)

1. Unzip the bundle (or clone this folder).
2. Open `chrome://extensions` in Chrome / Edge / Brave.
3. Toggle **Developer mode** (top-right).
4. Click **Load unpacked**, pick the unzipped folder.
5. Pin the extension icon (puzzle-piece menu → 📌 next to "ADO Atlas").

## First run

Click the toolbar icon → a new tab opens. The setup overlay asks for:

- **Personal Access Token** — create at
  [dev.azure.com → User settings → Personal access tokens](https://dev.azure.com/_usersSettings/tokens).
  Minimum scopes:
    - **Work Items** — Read, write & manage
    - **Project and team** — Read (used for the Assigned filter / "me" shortcut)
- **Organization** — your ADO org (the `<org>` in `dev.azure.com/<org>/...`).
- **Project** — the ADO project (the `<project>` in `dev.azure.com/<org>/<project>/...`).

After pasting the PAT, click **Load** (or press Enter): the extension lists the
organizations that PAT can access and the projects inside the org you pick, so
you can choose them from the dropdowns instead of typing. If your PAT is scoped
too narrowly to enumerate them, just type the org/project names in directly.

All three fields are required — the extension ships with no built-in defaults,
so it is not tied to any particular organization or project.

- **PAT expiry** *(optional)* — copy the expiration date shown on the token
  page. The toolbar then displays a validity countdown (e.g. `PAT: 12d`) that
  turns amber within 14 days and red within 3 days / once expired. Azure DevOps
  can't report a PAT's expiry to a PAT-authenticated request, so this date is
  recorded locally; it does not change anything if left blank.

The PAT is stored in `chrome.storage.local` on this machine only — it is not
synced via your Google account. Reopen the modal any time with the **⚙** button
in the toolbar (e.g. to rotate the PAT or switch to another org/project).

## What's inside

| File | Purpose |
|---|---|
| `manifest.json` | MV3 declaration: `host_permissions` for `dev.azure.com`, `storage`, action with full-tab UI |
| `background.js` | Service worker: on icon click, open `index.html` in a tab (focuses an existing one if it's already open) |
| `index.html` | Single-page UI shell + setup-modal markup |
| `app.css` | Styles (dark + light theme, board / Gantt, modal) |
| `api.js` | ADO REST client — direct calls to `dev.azure.com` using the PAT |
| `app.js` | Tree / Graph / Board / Sprint / Editor logic |
| `vendor/` | Cytoscape + dagre + cytoscape-dagre (bundled, no CDN) |
| `icons/` | Toolbar icons (16/48/128) |
| `build.bat` | One-shot zip into `dist/ado-atlas-extension.zip` |

## Build (only when sharing)

Double-click `build.bat` on Windows (or run `powershell Compress-Archive ...`
on any OS). Result lands in `dist\ado-atlas-extension.zip`.

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

[MIT](LICENSE).

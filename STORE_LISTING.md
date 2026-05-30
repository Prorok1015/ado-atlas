# Chrome Web Store listing — copy & answers

Paste these into the Web Store Developer Dashboard. The privacy/homepage URLs
below assume GitHub Pages is served from this repo's `docs/` folder at
`https://prorok1015.github.io/ado-atlas/` (see PUBLISHING.md, Phase 2). **If your
GitHub username or repo name differs, update the URLs accordingly.**

- **Homepage URL:** `https://prorok1015.github.io/ado-atlas/`
- **Privacy policy URL:** `https://prorok1015.github.io/ado-atlas/privacy.html`

---

## Product name
ADO Atlas

## Summary / short description (max 132 chars)
Visualize and manage your Azure DevOps work items as a tree, dependency graph, kanban board, and sprint Gantt — in your browser.

## Category
Developer Tools

## Language
English

## Detailed description
ADO Atlas is a fast, no-server way to see and edit your Azure DevOps work items
without leaving your browser. It talks directly to the Azure DevOps REST API
using your Personal Access Token — there is no backend and nothing is sent to any
third party.

Views
• Tree — the parent/child hierarchy of epics, features, stories, tasks and bugs.
• Graph — an interactive dependency/hierarchy graph.
• Board — a kanban grouped by Sprint, State, or Assignee; drag cards to update.
• Sprint Gantt — per-sprint timeline with planned dates and active time.

Work with items
• Inline editor: title, state, assignee, priority, sprint, dates, estimate,
  description and acceptance criteria, re-parenting, comments and change history.
• Filters by State, Type, Priority, Assignee, Sprint and Tags.
• Bulk edit: select items and set State / Sprint / Priority / Assignee at once.
• Command palette (Ctrl/Cmd-K) to jump to any item or run a quick action.
• Export the current view to CSV or JSON.

Privacy first
• Your token and data never leave your device, except requests to your own Azure
  DevOps. No analytics, no tracking, no third-party servers.
• A PAT-expiry countdown reminds you before your token lapses.

ADO Atlas is an independent project and is not affiliated with or endorsed by
Microsoft. "Azure DevOps" is a trademark of Microsoft Corporation.

Privacy policy: https://prorok1015.github.io/ado-atlas/privacy.html

---

## Privacy practices tab

### Single purpose (required)
ADO Atlas lets a user view and manage their own Azure DevOps work items as a
tree, dependency graph, kanban board, and sprint Gantt chart, by calling the
Azure DevOps REST API directly with the user's Personal Access Token.

### Permission justifications
- **storage** — Persists the user's connection settings (organization, project),
  their Personal Access Token, UI preferences, and a local cache of recently
  viewed work items, so the extension works across sessions without re-entering
  them. All of this stays on the user's device.
- **Host permission `https://dev.azure.com/*`** — The extension's sole function is
  to read and update the user's Azure DevOps work items; it calls the Azure
  DevOps REST API on this host directly from the browser using the user's PAT.
  No data passes through any third-party server.
- **Host permission `https://app.vssps.visualstudio.com/*`** — Used only to let
  the user pick their organization and project (the Azure DevOps profile/accounts
  endpoints live on this host). It is a convenience; the user can also type the
  organization and project manually.
- **identity** — Powers the optional "Sign in with Microsoft" alternative to a
  PAT (`chrome.identity.launchWebAuthFlow`), so the user can authenticate with
  their Microsoft Entra ID account.
- **Host permission `https://login.microsoftonline.com/*`** — Microsoft sign-in
  only: completes the OAuth (PKCE) sign-in and refreshes the access token. Not
  contacted when the user authenticates with a PAT.

### Are you using remote code?
**No.** All scripts (including the Cytoscape/dagre libraries) are bundled in the
package; nothing is loaded from a remote URL and no `eval` is used.

### Data usage — what the item collects (disclosures)
- **Authentication information** (the Personal Access Token, or the Microsoft
  Entra ID OAuth access/refresh tokens): handled. Stored locally on the device;
  transmitted only to Azure DevOps (and, for sign-in, to Microsoft's login
  service) to authenticate the user's own requests. Not sent to the developer or
  any third party.
- **Website content** (the user's work-item data fetched from Azure DevOps):
  fetched from the user's Azure DevOps and cached locally on the device only.
- The extension does **not** collect: personally identifiable information beyond
  the above, location, health, financial/payment info, web history, or user
  activity/analytics.

### Data usage certifications (check all that apply — all true here)
- I do **not** sell or transfer user data to third parties (outside approved use
  cases — the data is sent only to the user's own Azure DevOps service).
- I do **not** use or transfer user data for purposes unrelated to the item's
  single purpose.
- I do **not** use or transfer user data to determine creditworthiness or for
  lending purposes.

### Privacy policy URL
`https://prorok1015.github.io/ado-atlas/privacy.html`

---

## Graphic assets to prepare (you must create these)
- **Store icon** 128×128 PNG — already in `icons/icon-128.png`.
- **Screenshots** — 1–5, **1280×800** (preferred) or 640×400, PNG/JPEG. Suggested:
  1. Tree view with the editor open.
  2. Board grouped by State (kanban).
  3. Dependency graph.
  4. Sprint Gantt.
  5. Filters + command palette.
  Use a demo/sample Azure DevOps project so no confidential data is shown.
- **Small promo tile** 440×280 (optional).
- Do **not** include Microsoft logos or imagery in any asset.

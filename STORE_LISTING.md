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
using your Personal Access Token (or Microsoft sign-in) — there is no backend
and nothing is sent to any third party.

Views
• Tree — the parent/child hierarchy of epics, features, stories, tasks and bugs.
• Graph — an interactive dependency/hierarchy graph.
• Board — a kanban grouped by Sprint, State, or Assignee; drag cards to update.
• Sprint Gantt — per-sprint timeline with planned dates and active time.

Work-item editor
• Inline editor for title, state, assignee, priority, sprint, dates, estimate,
  description and acceptance criteria, re-parenting, comments and change history.
• Live markdown description with side-by-side preview, attached image hydration,
  and #N → work-item autolinks.
• Drag, drop, or paste files (including screenshots) right into the description
  to upload them as Azure DevOps attachments in one shot.
• @-mention typeahead with real Azure DevOps mentions that fire notifications.
• Format toolbar — bold, italic, strike, inline code, headings, lists, quote,
  link — with Ctrl/Cmd+B/I/K/` shortcuts.
• Full-screen editor mode for long descriptions.
• Hybrid save: state / priority / assignee / sprint / tags / dates auto-commit
  on change; title / description / acceptance criteria stay on a manual Save
  (Ctrl/Cmd+S) with a sticky save-status chip and a discard-confirm guard on
  panel close, item switch, and page reload.

Filters and bulk actions
• Filters by State, Type, Priority, Assignee, Sprint and Tags.
• Bulk edit: select items and set State / Sprint / Priority / Assignee at once.
• Command palette (Ctrl/Cmd-K) to jump to any item or run a quick action.
• Export the current view to CSV or JSON.

Privacy first
• Your token and data never leave your device, except requests to your own Azure
  DevOps. No analytics, no tracking, no third-party servers.
• Files you attach go straight to your Azure DevOps; the extension keeps no
  local copy of the bytes.
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
  This includes uploading attachments the user pastes / drops into the
  description (`_apis/wit/attachments`), authenticated re-fetches of inline
  attachment images so they can be displayed in the preview, and the
  `_apis/IdentityPicker/Identities` typeahead used by the @-mention editor.
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
- **Website content** (the user's work-item data fetched from Azure DevOps,
  including titles, descriptions, comments, attachments the user uploads via
  the description editor, and identity-typeahead results for @-mentions):
  fetched from / sent to the user's own Azure DevOps organization only, and
  cached locally on the device for the work-item editor session. Attachment
  bytes are never copied or transmitted anywhere other than the user's Azure
  DevOps organization.
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
  1. Tree view with the work-item editor open.
  2. Board grouped by State (kanban).
  3. Dependency graph.
  4. Description editor in full-screen mode with the format toolbar,
     an inline attachment image, and the @-mention popup visible.
  5. Sprint Gantt or filters + command palette.
  Use a demo/sample Azure DevOps project so no confidential data is shown.
- **Small promo tile** 440×280 (optional).
- Do **not** include Microsoft logos or imagery in any asset.

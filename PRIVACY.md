# Privacy Policy — ADO Atlas

**Effective date:** 2026-05-30

ADO Atlas ("the extension") is an independent browser extension that displays and
manages your Azure DevOps work items. This policy explains exactly what data the
extension handles and where it goes. In short: **everything stays on your device,
and the only server it talks to is Azure DevOps itself.**

ADO Atlas is **not affiliated with, sponsored by, or endorsed by Microsoft**.
"Azure DevOps" is a trademark of Microsoft Corporation.

## What the extension stores

All of the following is stored **locally on your device** (Chrome
`chrome.storage.local` and `localStorage`) and is never sent to the developer or
any third party:

- **Your credentials** — either a Personal Access Token (PAT) you enter, or, if
  you use **Microsoft sign-in**, the OAuth access and refresh tokens issued by
  Microsoft Entra ID (plus the app client ID and tenant you configure). Used to
  authenticate to Azure DevOps.
- **Connection settings** — your Azure DevOps organization and project, and an
  optional PAT expiry date you can enter for a validity countdown.
- **UI preferences** — theme, sort order, timezone/working hours, active view,
  filters, auto-refresh interval, panel width.
- **A local cache** of recently viewed work items (titles, states, assignees,
  ids, dates, tags) used to render the last view instantly. This cache is
  ignored after 24 hours and can be cleared at any time.

## What the extension sends, and to whom

The extension makes network requests **only** to Azure DevOps (and, for Microsoft
sign-in, the Microsoft login service), over HTTPS, authenticated with your
credentials:

- `https://dev.azure.com` — to read and update your work items.
- `https://app.vssps.visualstudio.com` — only when you click **Load** in setup,
  to list the organizations and projects your account can access (a convenience;
  you can type them manually instead).
- `https://login.microsoftonline.com` — **only if you use Microsoft sign-in**, to
  complete the OAuth sign-in and to refresh the access token. Not contacted at
  all when you authenticate with a PAT.

These hosts are the only ones the extension is permitted to contact (enforced by
its Content Security Policy). The extension contains **no analytics, no
telemetry, no advertising, and no third-party servers.** No data is ever
transmitted to the developer.

## How your data is used

Your token and settings are used solely to provide the extension's single
purpose: viewing and managing your own Azure DevOps work items. Your data is
**not sold, rented, or shared** with anyone, and is **not used** for advertising,
profiling, or any purpose unrelated to that feature.

## Data retention and your control

- Data persists locally until you remove it. Removing/uninstalling the extension
  deletes its stored data.
- You can rotate or replace your PAT at any time via the **⚙** settings.
- We recommend creating a **short-lived PAT** with the minimum scopes (Work Items
  read/write, Project & Team read); the extension shows a countdown to its expiry.

## Security

Your PAT is stored locally by the browser and transmitted only to Azure DevOps
over HTTPS in the standard `Authorization` header. Because the PAT is a
credential, treat your device accordingly and prefer a short expiry. The
extension never logs or displays your PAT after entry.

## Limited Use disclosure

ADO Atlas's use of information received from Azure DevOps adheres to the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq),
including the **Limited Use** requirements. Specifically, the extension only uses
the data to provide and improve its single user-facing purpose, does not transfer
the data to third parties (it is sent only to your own Azure DevOps service),
does not use it for advertising, and does not allow humans to read it.

## Changes to this policy

If this policy changes, the updated version will be published at this URL with a
new effective date.

## Contact

Questions about this policy: **prorok1015@gmail.com**

# Microsoft sign-in (Entra ID OAuth) — setup

ADO Atlas can authenticate with **Microsoft sign-in** instead of a Personal
Access Token: you click "Sign in with Microsoft" once, and the extension uses an
Entra ID access token that **refreshes itself** — no token to copy, no expiry to
babysit.

OAuth requires a **one-time app registration** in Microsoft Entra ID (this is how
Microsoft grants the extension permission to act on your behalf). It takes ~3
minutes. After that, signing in is one click.

> **Only for work/school accounts.** Azure DevOps OAuth is an Entra (work/school)
> resource — it does not exist for **personal Microsoft accounts**. If you sign
> in to `dev.azure.com` with a personal account (outlook/hotmail/live), use the
> **Token (PAT)** tab instead; OAuth won't work for you.
>
> Prefer zero setup? The PAT method works for any account — just stay on the **Token** tab.

## 1. Register an app in Entra ID

1. Open the [Azure Portal](https://portal.azure.com) → **Microsoft Entra ID** →
   **App registrations** → **New registration**.
2. **Name:** anything (e.g. `ADO Atlas`).
3. **Supported account types:** *Accounts in any organizational directory
   (multitenant)* if you'll use the default `organizations` tenant. (Choose
   single-tenant if you only ever sign in to one org.)
4. **Redirect URI:** leave blank for now → **Register**.

## 2. Add the redirect URI

1. Open the extension, go to **Microsoft sign-in**, and **copy the Redirect URI**
   it shows (looks like `https://<extension-id>.chromiumapp.org/`).
2. In the app registration → **Authentication** → **Add a platform** → **Mobile
   and desktop applications** → add a **custom redirect URI** with that exact
   value → **Configure**.
3. (Recommended) On the same Authentication page, set **Allow public client
   flows** to **Yes** and save. The extension is a public client and uses PKCE —
   there is **no client secret**.

## 3. Grant Azure DevOps permission

1. App registration → **API permissions** → **Add a permission** → **Azure
   DevOps** → **Delegated permissions** → check **user_impersonation** → **Add
   permissions**.
2. If your tenant requires admin approval, click **Grant admin consent** (or an
   admin approves at first sign-in).

## 4. Connect the extension

1. App registration → **Overview** → copy the **Application (client) ID**.
2. In the extension's **Microsoft sign-in** tab, paste the **Application (client)
   ID** and pick the **Account type / tenant**: *Work or school account*
   (`organizations`) or *Specific tenant ID* (paste a tenant GUID to pin one
   organization). (Personal accounts aren't offered — Azure DevOps OAuth doesn't
   support them.)
3. Click **Sign in with Microsoft**, complete the Microsoft prompt and consent.
4. Pick your **organization** and **project** (they auto-populate after sign-in)
   → **Save & Connect**.

## Notes & troubleshooting

- **The Redirect URI depends on the extension's ID.** A published Web Store
  extension has a stable ID, so register it once. An *unpacked* dev build gets a
  new ID per machine unless you pin it with a `key` in `manifest.json` — the
  setup screen always shows the current value to register.
- **`AADSTS50011` / redirect mismatch:** the URI in Entra must match the one
  shown in the extension exactly (including the trailing `/`).
- **`AADSTS65001` / consent required:** grant admin consent in step 3, or have an
  admin approve.
- **Org not listed after sign-in:** make sure your Microsoft account is a member
  of the Azure DevOps organization, and that the org allows Entra-based access.
- **Tokens** (access + refresh) are stored locally in `chrome.storage.local` and
  sent only to `login.microsoftonline.com` (to refresh) and Azure DevOps. See
  [PRIVACY.md](PRIVACY.md). Use **Token** tab → switch back to PAT anytime.

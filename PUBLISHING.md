# Publishing ADO Atlas to the Chrome Web Store

A step-by-step checklist from here to "live". Items marked **[repo ✅]** are
already done in this repository; **[you]** items must be done by you (account,
payment, hosting, screenshots, dashboard) and can't be automated.

---

## Phase 0 — Repository readiness  **[repo ✅]**
- Manifest V3, narrow `host_permissions`, Content-Security-Policy locking
  `connect-src` to the two Azure DevOps hosts.
- No remote code: Cytoscape/dagre are bundled in `vendor/`; no CDN, no `eval`.
- Security pass done (stored-XSS fixed, escaping hardened) and 28 unit tests green.
- `PRIVACY.md` (privacy policy), `STORE_LISTING.md` (dashboard copy), and this file.
- Microsoft non-affiliation disclaimer in the README and in the in-app setup modal.
- `build.bat` packages **only** the runtime files (no `tests/`, `package.json`,
  or docs) into `dist/ado-atlas-extension.zip`.

### One thing to confirm yourself
The in-app **Privacy** link and the README point at
`https://github.com/Prorok1015/ado-atlas`. If your repository/URL differs, update
the link in `index.html` (the setup-modal disclaimer) and `README.md` before
building.

## Phase 1 — Developer account  **[you]**
1. Go to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).
2. **Enable 2-Step Verification** on the Google account (required to publish).
3. Pay the **one-time $5 registration fee** and accept the developer agreement.
4. Complete any contact-info/identity verification Google prompts for.

## Phase 2 — Host the privacy policy  **[you]**
The store requires a public Privacy Policy URL (you handle a PAT = sensitive data).
Easiest options:
- **GitHub Pages:** enable Pages on your repo; the policy will be served at
  `https://<user>.github.io/<repo>/PRIVACY` (or push `PRIVACY.md` content as
  `index.html` to a `gh-pages` branch).
- **Or** paste `PRIVACY.md` into a public Gist / any static host.
Copy the resulting URL — you'll paste it into `STORE_LISTING.md`'s `<PRIVACY_URL>`
placeholders and the dashboard.

## Phase 3 — Build the package  **[you, 1 command]**
- Windows: double-click `build.bat`, or run `npm run build` / `powershell -File build.ps1`.
  Result: `dist\ado-atlas-extension.zip`.
- The zip has `manifest.json` at its root, uses forward-slash paths, and contains
  only runtime files (the build was verified to produce a spec-correct package).
- Sanity check: load `dist` (unzipped) via `chrome://extensions` → Developer mode
  → **Load unpacked**, and confirm the extension works end-to-end with a real PAT
  (tree/board/graph render, editing works) — this also verifies the CSP didn't
  block anything.

## Phase 4 — Screenshots & assets  **[you]**
Create 1–5 screenshots at **1280×800** (see `STORE_LISTING.md` for suggested
shots). Use a demo Azure DevOps project so nothing confidential is shown. The
128×128 store icon already exists at `icons/icon-128.png`.

## Phase 5 — Create the store item  **[you]**
1. Dashboard → **Add new item** → upload `dist/ado-atlas-extension.zip`.
2. **Store listing tab:** paste name, summary, detailed description, category
   (Developer Tools), language, screenshots, icon — all in `STORE_LISTING.md`.
3. **Privacy practices tab:** paste the single-purpose statement, the per-permission
   justifications, answer "remote code: No", fill the data-collection disclosures,
   check the three data-usage certifications, and enter the Privacy Policy URL —
   all prepared in `STORE_LISTING.md`.
4. **Distribution:** choose Public (or Unlisted for a private rollout) and regions.

## Phase 6 — Submit & review  **[you]**
- Submit for review. Review typically takes from a few hours to a few days; broad
  host permissions + credential handling can mean a longer review. Make sure the
  permission justifications are filled (they are, in `STORE_LISTING.md`).
- If Google asks for clarification, point to the local-only data model and the
  privacy policy.

## Phase 7 — After launch  **[you]**
- For every update: bump `"version"` in `manifest.json`, re-run `build.bat`,
  upload the new zip, and resubmit (updates are also reviewed).
- Optional: verify a domain to get the **verified publisher** badge.
- Keep `npm test` green before each release (`npm test`).

---

### Quick reference — what can't be skipped
1. Privacy Policy URL + filled privacy practices (because of the PAT).
2. 2FA + paid developer account.
3. Microsoft non-affiliation disclaimer; no Microsoft logos in assets.
4. Clear permission justifications + single purpose.

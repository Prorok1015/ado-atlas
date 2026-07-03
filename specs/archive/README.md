# Archived design specs

Historical design documents for features that are **already implemented and shipped**.
Kept for reference/history only — they are not active TODOs and may lag the code.

- `ADVANCED_LAYOUT_CUSTOMIZATION_SPEC.md` — visual sidebar/toolbar layout builder (shipped; code in `src/app/layout.js`).
- `AI_INTEGRATION_SPEC.md` — AI search over work items (shipped; `src/ai/*`, `src/components/ai-search-dialog.js`).
- `FILTER_CONSTRUCTOR_SPEC.md` — visual filter builder + FilterIR (shipped; `src/components/filter-builder-modal.js`, `src/core/filter-compiler.js`).
- `LOCALIZATION_SPEC.md` — i18n (EN/RU/ES/DE) (shipped; `src/components/i18n.js`, `src/locales/*`).

Executed implementation prompts (kept for history; the feature shipped):

- `PREFS_IMPLEMENTATION_PROMPT.md` — the `App.prefs` settings layer prompt (shipped; `src/app/prefs.js`). Its design doc, `SETTINGS_SYNC_SPEC.md`, stays ACTIVE one level up because the cloud-sync phase (§9) is still pending.

Active specs live one level up in `specs/`.

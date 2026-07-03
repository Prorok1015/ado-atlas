# ADO Atlas Custom Behavior Rules

- **Use Custom Dialogs Only**: Never use browser native system dialogs like `alert()`, `confirm()`, or `prompt()`. Always use custom in-app modal dialogs (such as `customConfirm` or `customAlert`) to maintain styling consistency.

# Architectural Patterns & Guidelines

## 1. Global Scope Management & Collision Guard
- **Context**: The project loads classic `<script>` tags in `index.html` (such as `lib.js`, `api.js`, components, and `app.js`) which share a single global scope.
- **Rules**:
  - Encapsulate file/module contents inside an IIFE or UMD wrapper: `(function(global) { 'use strict'; ... })(typeof globalThis !== 'undefined' ? globalThis : window);`
  - Explicitly export public interfaces by assigning them to the `global` object (e.g., `global.MyComponent = MyComponent;`). Do not pollute the global scope with top-level local variables or helper functions.
  - Run the global check before committing: `npm run check` (runs `tools/check-globals.js` to ensure no top-level name collisions occur).

## 2. Pure Helper Functions Isolation (`lib.js`)
- **Rules**:
  - `lib.js` must contain ONLY pure, deterministic, and dependency-free functions.
  - No DOM manipulation, no browser/extension API access (e.g., no `chrome.*`), and no network requests (`fetch`/`xhr`).
  - Everything in `lib.js` must run successfully in pure Node.js environments to remain fully unit-testable.

## 3. Backend-Agnostic Query Format (Filter IR)
- **Rules**:
  - All filtering mechanisms (visual quick chips, advanced filter builder modal, and AI natural language search) must output a unified `FilterIR` structure.
  - The `FilterIR` uses abstract keys (like `state`, `assignee`, `storypoints`) rather than vendor-specific fields (e.g., `System.State` or `System.AssignedTo`).
  - Compiling `FilterIR` to vendor languages (like WIQL for Azure DevOps) is isolated strictly inside compiler/adapter logic in `lib.js` (e.g., `buildClauses` and `FilterCompiler`).

## 4. AI Provider Abstraction & Registry
- **Rules**:
  - Consumer features (such as AI search or translators) must never instantiate or bind directly to a specific AI model or endpoint (like Chrome Built-in AI or cloud APIs).
  - Interact with AI solely through the `AIProvider` interface (`prompt()`, `promptJSON()`) by retrieving the active provider from `global.aiProviderRegistry` (using `registry.getActive()`).

## 5. Self-Contained UI Component Lifecycle
- **Rules**:
  - Complex UI panels (e.g., `AISearchDialog`, `FilterBuilderModal`) must handle their own DOM creation (using template strings and dynamic injection), event listeners, and state caching internally.
  - Expose a minimal public interface (such as `.open()`, `.close()`, `.hasPendingResult()`) to `app.js`.
  - Always prefer custom in-app dialogs (like `window.customConfirm` and `window.customAlert`) over native browser dialogs.

## 6. Lightweight Zero-Dependency Testing
- **Rules**:
  - Keep tests dependency-free using the native Node.js `node:assert` module.
  - Run tests with `npm test`. Write unit tests for new features/helpers in `tests/lib.test.js` or `tests/ai.test.js` to ensure correctness without needing a full browser context.

## 7. Popover & Overlay Stacking (`LayerManager`)
- **Rules**:
  - All overlay elements, modals, popovers, dropdowns, and sidebar panels MUST be managed via the global `LayerManager`.
  - When showing/opening an overlay or popover, call `window.LayerManager.open(element, backdrop, options)`.
  - When hiding/dismissing it, call `window.LayerManager.close(element)`.
  - Do not assign arbitrary hardcoded `z-index` values in CSS or inline scripts. `LayerManager` is the single source of truth for layered DOM elements stacking order, dynamically computing z-indices to prevent occlusion.

## 8. Theme-Dependent CSS & Styling
- **Rules**:
  - All UI elements must derive their colors, backgrounds, borders, shadows, and text styles from the project's CSS variables (e.g., `var(--bg)`, `var(--panel)`, `var(--line)`, `var(--txt)`, `var(--muted)`, `var(--accent)`, `var(--field)`, `var(--sel)`).
  - Never use hardcoded hex/RGB values for base interface styling (such as buttons, backgrounds, or borders) to ensure seamless support for both light and dark modes.
  - When the light theme is activated, a `.light` class is appended to `document.body` (handled early by `theme-init.js` to avoid flash). All color tokens are redefined there.
  - Dynamic colors (such as work item types, states, and priorities) must be referenced via CSS variable hooks (e.g., `--ty-epic`, `--state-new`) with fallback constants, letting updates propagate live without full DOM re-renders.

## 9. Async Render Tokens & Race Condition Guard
- **Rules**:
  - For async rendering/updating pipelines (such as Cytoscape graph rendering, board refreshing, sidebar loading), use incrementing session-wide tokens (e.g., `renderToken`, `boardToken`, `openToken`).
  - Capture a local copy of the token before starting an async task. Compare the local token to the global token inside the async callbacks/resolutions. If they do not match, immediately bail out to ignore stale async results.
  - Cancel network calls using `AbortController` (e.g., `openItemAbortCtrl`) when switching active context or active items.

## 10. API Throttling, Retries & Entra Authorization
- **Rules**:
  - All outgoing Azure DevOps REST requests must go through the centralized `req()` helper in `api.js` to ensure robust error/throttling handling.
  - Automatically retry requests in case of rate limiting (HTTP 429) or transient server errors (HTTP 5xx) with exponential backoff (up to `MAX_RETRIES = 3`).
  - Set the custom header `"X-TFS-FedAuthRedirect": "Suppress"` on all REST calls to force a clean HTTP `401` response on auth expiration/failure, preventing the browser from popping up a native authentication credential prompt.
  - Catch `401 Unauthorized` responses and dispatch a global `"ado-401"` CustomEvent on `window` to notify the UI to show the connection setup panel.

## 11. Dual-Layer Caching (Memory + Persistent Storage)
- **Rules**:
  - Cache heavy metadata fetches (e.g., project fields, work item types, team rosters) using a double-layered approach: local variables/objects for memory caching, and `chrome.storage.local` for persistent storage caching.
  - Invalidation: Clear caches during configuration updates (via `setConfig`) or manual disconnection (via `clearConfig`).

## 12. Dynamic Layout Configuration & Schema-Driven Rendering
- **Rules**:
  - Sidebar fields and layout structure must be rendered dynamically using a structured JSON layout definition stored per work item type (e.g., `ado.layout.<Wtype>`).
  - Avoid hardcoding static columns/structures in HTML/JS; utilize layout groups (sections), rows, and columns dynamically built from the schema.



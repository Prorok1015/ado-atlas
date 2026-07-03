// App.analytics — thin page-side telemetry facade. Extension pages can't reach GA
// directly (Manifest V3 CSP: script-src 'self', and connect-src has no GA host), so
// every event is forwarded to the service worker, which owns the GA4 Measurement
// Protocol client (src/core/analytics.js) and the host_permission to POST there.
//
// track() is fire-and-forget and swallows all errors: the worker may be asleep, the
// message channel may close, telemetry may be off — none of that must affect the UI.
// The opt-out gate lives worker-side (reads the `telemetry` pref), so callers here
// don't need to check it. Load right after namespace.js so App exists.
(function (App) {
  'use strict';

  function track(name, params) {
    try {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return;
      const p = chrome.runtime.sendMessage({ action: 'ga', name, params: params || {} });
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (_) {
      // never throw from a telemetry call
    }
  }

  App.analytics = { track };
})(window.App);

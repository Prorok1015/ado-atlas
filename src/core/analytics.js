// GA4 Measurement Protocol client — runs INSIDE the service worker (background.js
// importScripts this file). Manifest V3 forbids loading gtag.js on extension pages
// (script-src 'self'), so instead of a page-side library we POST events straight to
// the GA4 ingest endpoint. Doing it from the worker keeps one code path, avoids the
// page CSP entirely (the page never talks to GA — it messages the worker), and the
// cross-origin fetch is authorised by the "https://www.google-analytics.com/*"
// host_permission in manifest.json.
//
// Frontend code fires events via App.analytics.track() (src/app/analytics.js), which
// sends { action:'ga', name, params } to the worker; the worker calls collect() here.
//
// Privacy: no PII, no ADO content, no tokens are ever sent — only coarse usage
// signals (which view is open, feature toggles). The client_id is a random UUID with
// no link to the user's identity, and the whole pipeline is gated by the `telemetry`
// preference (opt-out from Settings). Nothing here can throw into the caller.
(function (g) {
  'use strict';

  // === CONFIGURATION ==========================================================
  // GA4 → Admin → Data streams → (your Web stream):
  //   MEASUREMENT_ID — the "G-XXXXXXXXXX" shown at the top of the stream.
  //   API_SECRET     — Measurement Protocol API secrets → Create secret.
  // The API secret is a write-only ingest key (it can send events but cannot read
  // any data), so shipping it inside the extension is the intended MP model.
  // Until BOTH are replaced with real values, telemetry stays disabled (no network).
  const MEASUREMENT_ID = 'G-XXXXXXXXXX';
  const API_SECRET = 'REPLACE_WITH_API_SECRET';

  const PLACEHOLDER_MID = 'G-XXXXXXXXXX';
  const PLACEHOLDER_SECRET = 'REPLACE_WITH_API_SECRET';

  const ENDPOINT = 'https://www.google-analytics.com/mp/collect';
  const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // GA4's default 30-minute session window

  function configured() {
    return MEASUREMENT_ID !== PLACEHOLDER_MID && API_SECRET !== PLACEHOLDER_SECRET;
  }

  // GA4 event names must be <=40 chars, start with a letter, and contain only
  // letters, digits and underscores. Sanitise so a sloppy caller can't drop events.
  function sanitizeName(n) {
    const s = String(n || 'event').toLowerCase()
      .replace(/[^a-z0-9_]/g, '_')
      .replace(/^[^a-z]+/, '')
      .slice(0, 40);
    return s || 'event';
  }

  // Stable, anonymous per-install id. Random UUID, persisted in local storage so it
  // survives worker restarts. Not tied to any account or the license installation_id.
  async function ensureClientId() {
    try {
      const { ga_client_id } = await chrome.storage.local.get('ga_client_id');
      if (ga_client_id) return ga_client_id;
      const id = crypto.randomUUID();
      await chrome.storage.local.set({ ga_client_id: id });
      return id;
    } catch (_) {
      return 'anon';
    }
  }

  // GA4 needs session_id + engagement_time_msec on each event for the hit to count
  // toward sessions/active-users in reports. Session state lives in chrome.storage
  // .session (cleared when the browser closes) and rolls over after 30 idle minutes.
  async function sessionParams() {
    let sess;
    const now = Date.now();
    try {
      sess = (await chrome.storage.session.get('ga_session')).ga_session;
    } catch (_) { /* session area unavailable — fall through to a fresh session */ }
    if (!sess || (now - sess.ts) > SESSION_TIMEOUT_MS) {
      sess = { id: String(now), ts: now };
    } else {
      sess.ts = now;
    }
    try { await chrome.storage.session.set({ ga_session: sess }); } catch (_) {}
    return { session_id: sess.id, engagement_time_msec: 100 };
  }

  // Telemetry is opt-out: enabled unless the user set the `telemetry` pref to 'off'.
  // The pref roams via chrome.storage.sync (App.prefs area:'sync', worker:true) and
  // dual-writes to local, so read sync-first with a local fallback (mirrors
  // background.js getSyncedPref). Returns false when not configured — no key, no send.
  async function enabled() {
    if (!configured()) return false;
    try {
      const s = await chrome.storage.sync.get('telemetry');
      if (s && s.telemetry !== undefined) return s.telemetry !== 'off';
    } catch (_) {}
    try {
      const l = await chrome.storage.local.get('telemetry');
      if (l && l.telemetry !== undefined) return l.telemetry !== 'off';
    } catch (_) {}
    return true; // default on
  }

  // Fire a single event. Fire-and-forget: any failure (offline, opt-out, bad config)
  // is swallowed — analytics must never surface an error to the app.
  async function collect(name, params) {
    try {
      if (!(await enabled())) return;
      const client_id = await ensureClientId();
      const base = await sessionParams();
      let appVersion;
      try { appVersion = chrome.runtime.getManifest().version; } catch (_) {}
      const body = {
        client_id,
        events: [{
          name: sanitizeName(name),
          params: Object.assign({ app_version: appVersion }, base, params || {})
        }]
      };
      const url = ENDPOINT +
        '?measurement_id=' + encodeURIComponent(MEASUREMENT_ID) +
        '&api_secret=' + encodeURIComponent(API_SECRET);
      await fetch(url, { method: 'POST', body: JSON.stringify(body), keepalive: true });
    } catch (_) {
      // never throw
    }
  }

  g.AdoAnalytics = { collect, ensureClientId, configured, enabled };
})(typeof self !== 'undefined' ? self : globalThis);

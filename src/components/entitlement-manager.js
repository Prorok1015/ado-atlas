(function (global) {
  'use strict';

  // EntitlementManager: single source of truth for the user's subscription tier
  // (Free / Pro / Team). It only READS cached state synchronously; the heavy
  // lifting (license activation / daily validation) talks to the Go backend and
  // is filled in at Stage 2 — for now these are stubs.
  //
  // NOTE: this is the billing/premium gate. The unrelated per-item "follow"
  // feature lives in FollowManager (components/follow-manager.js).

  // Localized string helper (guarded: degrades to the English fallback if i18n not ready).
  const L = (k, fallback, p) => (typeof window !== 'undefined' && window.i18n) ? window.i18n.t(k, p) : fallback;

  const STORAGE_KEY = 'entitlement';
  const GRACE_DAYS = 7;
  const GRACE_MS = GRACE_DAYS * 24 * 60 * 60 * 1000;

  const DEFAULT_STATE = {
    tier: 'free',          // 'free' | 'pro' | 'team'
    status: 'none',        // 'active' | 'past_due' | 'canceled' | 'none'
    expires_at: 0,         // epoch ms
    last_validated_at: 0   // epoch ms — basis for the offline grace period
  };

  const EntitlementManager = {
    _state: Object.assign({}, DEFAULT_STATE),
    _licenseKey: '',
    _devForcePro: false,   // chrome.storage.local.__dev_force_pro — manual testing toggle
    _listeners: [],

    async init() {
      try {
        const data = await chrome.storage.local.get([STORAGE_KEY, 'license_key', '__dev_force_pro']);
        if (data[STORAGE_KEY]) this._state = Object.assign({}, DEFAULT_STATE, data[STORAGE_KEY]);
        this._licenseKey = data.license_key || '';
        this._devForcePro = !!data.__dev_force_pro;
      } catch (e) {
        console.warn('EntitlementManager.init failed:', e);
      }
      this._notify();
      return this;
    },

    // True if the user currently has Pro/Team access. Honours a grace period so a
    // transient offline / validation failure does NOT lock out a paying user.
    isPro() {
      if (this._devForcePro) return true;
      const s = this._state;
      if (s.tier === 'free') return false;
      if (s.status === 'active') return true;
      if (Date.now() - (s.last_validated_at || 0) < GRACE_MS) return true;
      return false;
    },

    getTier() { return this._devForcePro ? 'pro' : this._state.tier; },
    getStatus() { return this._state.status; },
    getExpiry() { return this._state.expires_at; },

    // STUB (Stage 2): POST /api/license/activate {license_key, installation_id}
    // to the Go backend, then persist the returned entitlement and notify.
    async activate(licenseKey) {
      void licenseKey;
      throw new Error(L('entitlement.activationUnavailable', 'Premium activation is not available yet — coming soon.'));
    },

    // STUB (Stage 2): POST /api/license/validate; invoked from the background
    // alarm. On network error it MUST NOT downgrade (grace period covers it).
    async refresh() {
      return this.isPro();
    },

    async deactivate() {
      this._state = Object.assign({}, DEFAULT_STATE);
      this._licenseKey = '';
      try {
        await chrome.storage.local.set({ [STORAGE_KEY]: this._state, license_key: '' });
      } catch (e) { /* ignore */ }
      this._notify();
    },

    onChange(cb) { if (typeof cb === 'function') this._listeners.push(cb); },

    _notify() {
      this._listeners.forEach(cb => { try { cb(this); } catch (e) { console.error(e); } });
    },

    // Gate helper: returns true if the feature is allowed. Otherwise opens the
    // paywall and returns false, so callers read like: `if (!EM.gate('x')) return;`
    gate(feature) {
      if (this.isPro()) return true;
      // Free Preview: if the feature is marked as preview in the manager, allow it
      if (global.ProButtonManager && global.ProButtonManager.isPreview(feature)) return true;
      if (global.PremiumPaywall) global.PremiumPaywall.open(feature);
      return false;
    }
  };

  global.EntitlementManager = EntitlementManager;

})(typeof globalThis !== 'undefined' ? globalThis : window);

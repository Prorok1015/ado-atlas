// Lightweight in-app i18n runtime → window.i18n. Chrome's native chrome.i18n
// takes the language from the browser UI and cannot switch at runtime, so the
// in-app UI uses this layer instead (chrome.i18n / _locales is reserved for
// Web Store metadata only). Dictionaries are flat "key -> string" JSON under
// locales/<lang>.json, fetched on demand. English is the base/fallback: it is
// loaded first and awaited during init() so a translation is always available,
// then any missing key falls back en -> the key itself (nothing disappears).
//
// Pattern: IIFE + export to global, matching the other components. Depends on
// global.formatMessage (lib.js) for interpolation and global.i18nDetectLang
// (i18n-init.js) for the initial language. References them lazily at call time,
// so script order among siblings is not load-order sensitive.
(function (global) {
  'use strict';

  const FALLBACK = 'en';
  const RTL_LANGS = new Set(/* 'ar', 'he' — populate when RTL locales are added */);

  let lang = FALLBACK;
  let dict = {};         // active dictionary
  let fallbackDict = {}; // English, loaded once and kept resident
  const listeners = [];

  function cleanGlobalIds(val) {
    if (typeof val === 'string' && val.startsWith('ado:')) {
      const idx = val.indexOf(':');
      return val.slice(idx + 1);
    }
    if (Array.isArray(val)) {
      return val.map(cleanGlobalIds);
    }
    if (val && typeof val === 'object') {
      const copy = {};
      for (const [k, v] of Object.entries(val)) {
        copy[k] = cleanGlobalIds(v);
      }
      return copy;
    }
    return val;
  }

  async function load(l) {
    try {
      const res = await fetch(chrome.runtime.getURL(`src/locales/${l}.json`));
      return res.ok ? await res.json() : {};
    } catch (e) {
      return {};
    }
  }

  function interpolate(tmpl, params) {
    return (typeof global.formatMessage === 'function')
      ? global.formatMessage(tmpl, params)
      : String(tmpl == null ? '' : tmpl);
  }

  const i18n = {
    // Load the English fallback (awaited so t() is usable immediately), then
    // apply the initial language silently (caller renders + applyDOM once).
    async init(initialLang) {
      fallbackDict = await load(FALLBACK);
      const detect = (typeof global.i18nDetectLang === 'function') ? global.i18nDetectLang() : FALLBACK;
      await this.setLang(initialLang || detect, { silent: true });
      return this;
    },

    // Resolve key -> string. Lookup order: active dict -> English -> the key.
    t(key, fallbackOrParams, params) {
      let tmpl, actualParams;
      if (typeof fallbackOrParams === 'string') {
        tmpl = (key in dict) ? dict[key]
             : (key in fallbackDict) ? fallbackDict[key]
             : fallbackOrParams;
        actualParams = params;
      } else {
        tmpl = (key in dict) ? dict[key]
             : (key in fallbackDict) ? fallbackDict[key]
             : key;
        actualParams = fallbackOrParams;
      }
      return interpolate(tmpl, cleanGlobalIds(actualParams));
    },

    getLang() { return lang; },

    availableLangs() { return ['en', 'ru', 'es', 'de']; },

    async setLang(l, opts = {}) {
      lang = l || FALLBACK;
      dict = (lang === FALLBACK) ? fallbackDict : await load(lang);
      // Persist via App.prefs: writes chrome.storage.local['ado.lang'] (read by the
      // service worker for notification i18n) and mirrors localStorage['ado.lang']
      // (read synchronously by i18n-init.js pre-boot). Fall back to direct writes if
      // the prefs layer isn't present (e.g. i18n used standalone).
      if (typeof App !== 'undefined' && App.prefs) {
        App.prefs.set('lang', lang);
      } else {
        try { localStorage.setItem('ado.lang', lang); } catch (e) {}
        try { chrome.storage.local.set({ 'ado.lang': lang }); } catch (e) {}
      }
      document.documentElement.setAttribute('lang', lang);
      document.documentElement.setAttribute('dir', RTL_LANGS.has(lang) ? 'rtl' : 'ltr');
      if (!opts.silent) {
        this.applyDOM();
        listeners.forEach(cb => { try { cb(lang); } catch (e) {} });
      }
      return lang;
    },

    // Subscribe to language changes; dynamic/self-rendered panels re-render here.
    onChange(cb) { if (typeof cb === 'function') listeners.push(cb); },

    // Translate static markup tagged with data-i18n* attributes. The element's
    // own content stays as the English default, so untranslated keys degrade
    // gracefully. Call with a sub-root to (re)translate a freshly built panel.
    applyDOM(root = document) {
      root.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = i18n.t(el.dataset.i18n); });
      root.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = i18n.t(el.dataset.i18nTitle); });
      root.querySelectorAll('[data-i18n-placeholder]').forEach(el => { el.placeholder = i18n.t(el.dataset.i18nPlaceholder); });
      root.querySelectorAll('[data-i18n-html]').forEach(el => { el.innerHTML = i18n.t(el.dataset.i18nHtml); });
      // Rich help bubbles use a custom data-tooltip-html attribute (not title);
      // data-i18n-tooltip carries the key and the value may contain HTML.
      root.querySelectorAll('[data-i18n-tooltip]').forEach(el => { el.setAttribute('data-tooltip-html', i18n.t(el.dataset.i18nTooltip)); });
    }
  };

  global.i18n = i18n;
})(typeof globalThis !== 'undefined' ? globalThis : window);

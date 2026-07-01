// Resolve the active UI language as early as possible — before the main UI
// renders — so <html lang> is correct and there is no flash of the wrong
// language. Mirrors theme-init.js: a tiny classic <script> in <head>, no deps.
// Precedence: explicit user choice (localStorage) > browser UI language >
// navigator.language > 'en'. Only the 2-letter primary subtag is used. The
// resolved value is exposed as window.i18nDetectLang() for components/i18n.js.
(function () {
  try {
    var saved = localStorage.getItem('ado.lang');
    var detected = saved || ((chrome && chrome.i18n && chrome.i18n.getUILanguage && chrome.i18n.getUILanguage()) || navigator.language || 'en').slice(0, 2);
    document.documentElement.setAttribute('lang', detected);
    window.i18nDetectLang = function () { return detected; };
  } catch (e) {
    window.i18nDetectLang = function () { return 'en'; };
  }
})();

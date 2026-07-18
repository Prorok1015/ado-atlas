// Pre-boot: stamps the theme class on <body> BEFORE first paint, straight off
// localStorage (chrome.storage is async and would resolve too late). This is the
// only thing standing between the user and a flash of the wrong theme, so it has
// to know EVERY theme — premium ones included, or a Pro user sees the stock theme
// for one frame on every load. App.prefs mirrors `theme`/`themeDay`/`themeNight`/
// `uiScale`/`lang` into localStorage (mirrorLS) precisely so this can run sync.
//
// THEME_BASE duplicates the base of THEMES in src/app/settings.js (the source of
// truth). Deliberate: this file must not depend on the app being loaded.
(function() {
  try {
    const savedScale = parseFloat(localStorage.getItem('ado.uiScale')) || 1.0;
    document.documentElement.style.fontSize = (13 * savedScale) + 'px';

    const THEME_BASE = {                 // theme id -> 'dark' | 'light'
      dark: 'dark', light: 'light',
      ultra: 'dark', nocturne: 'dark', paper: 'light'
    };

    let mode = localStorage.getItem('ado.theme') || 'dark';
    const systemDark = !window.matchMedia || window.matchMedia('(prefers-color-scheme: dark)').matches;

    // 'auto' follows the OS. Pro users pick which theme sits on each side of the
    // switch (themeDay / themeNight); everyone else gets the plain dark/light pair.
    if (mode === 'auto') {
      const paired = localStorage.getItem(systemDark ? 'ado.themeNight' : 'ado.themeDay');
      mode = (paired && THEME_BASE[paired]) ? paired : (systemDark ? 'dark' : 'light');
    }

    const base = THEME_BASE[mode] || 'dark';
    if (base === 'light') document.body.classList.add('light');
    if (mode !== 'dark' && mode !== 'light') document.body.classList.add('theme-' + mode);
  } catch(e) {}
})();

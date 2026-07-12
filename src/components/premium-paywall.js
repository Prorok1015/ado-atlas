(function (global) {
  'use strict';

  // PremiumPaywall: self-contained promo / activation modal shown when a Free user
  // hits a Pro feature, or via the "Analytics" (Pro) button. Two columns: left =
  // feature pitch + license activation, right = full list of Pro benefits (the
  // feature that triggered the paywall is highlighted). Builds its own DOM + styles
  // lazily and stacks through LayerManager (project rules: no native dialogs, no
  // hardcoded z-index, theme-dependent colours via CSS vars).
  //
  // STUB (Stage 1): "Activate" calls EntitlementManager.activate() (throws "coming
  // soon"); "Get Pro" opens the marketing/checkout page.

  // TODO(Stage 2): replace with the Lemon Squeezy checkout URL.
  const BUY_URL = 'https://prorok1015.github.io/ado-atlas/#pricing';

  // Lazy, guarded i18n helper. Falls back to the English literal when the runtime
  // is not present (so this file degrades gracefully even outside the app).
  const L = (k, p, fallback) => (typeof global.i18n !== 'undefined' && global.i18n)
    ? global.i18n.t(k, p)
    : (fallback != null ? fallback : k);

  // Per-feature pitch shown on the left (keyed by data-pro-feature value).
  // `titleKey`/`descKey` resolve at render time so language switches re-pitch.
  const FEATURES = {
    analytics:      { titleKey: 'paywall.feature.analytics.title',     descKey: 'paywall.feature.analytics.desc' },
    filter_presets: { titleKey: 'paywall.feature.filterPresets.title', descKey: 'paywall.feature.filterPresets.desc' },
    hosted_oauth:   { titleKey: 'paywall.feature.hostedOauth.title',   descKey: 'paywall.feature.hostedOauth.desc' },
    cloud_ai:       { titleKey: 'paywall.feature.cloudAi.title',       descKey: 'paywall.feature.cloudAi.desc' },
    export:         { titleKey: 'paywall.feature.export.title',        descKey: 'paywall.feature.export.desc' },
    default:        { titleKey: 'paywall.feature.default.title',       descKey: 'paywall.feature.default.desc' }
  };

  // The full benefit list shown on the right. `key` ties a row to a FEATURES key so
  // the triggering feature can be highlighted; rows without a feature key (e.g. UI
  // extras) just list extra value. `textKey` resolves at render time.
  const BENEFITS = [
    { key: 'analytics',      icon: 'bar-chart', textKey: 'paywall.benefit.analytics' },
    { key: 'cloud_ai',       icon: 'cloud',     textKey: 'paywall.benefit.cloudAi' },
    { key: 'hosted_oauth',   icon: 'key',       textKey: 'paywall.benefit.hostedOauth' },
    { key: 'filter_presets', icon: 'save',      textKey: 'paywall.benefit.filterPresets' },
    { key: 'export',         icon: 'download',  textKey: 'paywall.benefit.export' },
    { key: 'ui',             icon: 'sparkles',  textKey: 'paywall.benefit.ui' }
  ];

  let built = false;
  let backdropEl = null;
  let panelEl = null;
  let titleEl = null;
  let descEl = null;
  let keyInput = null;
  let activateBtn = null;
  let msgEl = null;
  let benefitsEl = null;
  // Remembers the current pitch so an open dialog can re-render on language switch.
  let activeFeature = null;
  let activeInfo = null;

  function injectStyles() {
    if (document.getElementById('premium-paywall-styles')) return;
    const style = document.createElement('style');
    style.id = 'premium-paywall-styles';
    style.textContent = `
      .pw-backdrop{position:fixed;inset:0;background:rgba(8,10,18,.55);backdrop-filter:blur(4px);display:none;align-items:center;justify-content:center;}
      .pw-backdrop.show{display:flex;}
      .pw-panel{position:relative;width:min(760px,94vw);max-height:92vh;overflow:auto;border-radius:16px;color:var(--txt);
        background:linear-gradient(160deg,var(--panel) 0%,var(--panel2) 100%);
        border:1px solid var(--line);box-shadow:0 24px 70px rgba(0,0,0,.45);font-family:inherit;}
      .pw-body{display:flex;flex-wrap:wrap;}
      .pw-left{flex:1 1 320px;min-width:0;padding:28px 26px;}
      .pw-right{flex:1 1 260px;padding:28px 24px;background:rgba(242,169,0,.06);border-left:1px solid var(--line);}
      .pw-badge{margin-bottom:4px;}
      .pw-badge span{display:inline-flex;align-items:center;gap:.3em;font-weight:800;font-size:.92rem;
        letter-spacing:.08em;text-transform:uppercase;padding:.28rem .85rem;border-radius:.5rem;
        background:linear-gradient(135deg,#ffe07a,#f2a900);color:#4a3500;
        box-shadow:0 4px 16px rgba(242,169,0,.35);}
      .pw-badge span ui-icon svg{width:1em;height:1em;}
      .pw-title{font-size:1.32rem;font-weight:700;margin:12px 0 6px;color:#ffd86b;}
      .pw-desc{font-size:.92rem;line-height:1.5;color:var(--muted);margin:0 0 18px;}
      .pw-key-row{display:flex;gap:8px;margin-bottom:10px;}
      .pw-key-row input{flex:1;background:var(--field);border:1px solid var(--line);
        border-radius:9px;padding:9px 11px;color:var(--txt);font-size:.9rem;letter-spacing:.04em;}
      .pw-key-row input:focus{outline:none;border-color:#f2a900;}
      .pw-btn{border:none;border-radius:9px;padding:9px 16px;font-size:.9rem;font-weight:600;cursor:pointer;}
      .pw-btn-activate{background:rgba(242,169,0,.16);color:#ffd86b;border:1px solid rgba(242,169,0,.45);}
      .pw-btn-activate:hover{background:rgba(242,169,0,.26);}
      .pw-btn-buy{display:block;width:100%;text-align:center;margin-top:6px;
        background:linear-gradient(90deg,#ffd86b,#ffb347);color:#1a1304;text-decoration:none;
        padding:11px;border-radius:10px;font-weight:700;}
      .pw-btn-buy:hover{filter:brightness(1.05);}
      .pw-msg{min-height:18px;font-size:.82rem;margin:8px 0 0;color:#e0584f;}
      .pw-close{position:absolute;top:14px;right:16px;background:none;border:none;color:var(--muted);
        font-size:20px;cursor:pointer;line-height:1;z-index:1;}
      .pw-close:hover{color:var(--txt);}
      .pw-right-title{font-size:.78rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;
        color:#cf9416;margin:0 0 14px;}
      .pw-benefits{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:12px;}
      .pw-benefit{display:flex;gap:10px;align-items:flex-start;font-size:.86rem;line-height:1.4;color:var(--txt);}
      .pw-benefit ui-icon{color:#f2a900;flex:none;margin-top:1px;}
      .pw-benefit.active{background:rgba(242,169,0,.14);border-radius:8px;padding:6px 8px;margin:-6px -8px;font-weight:600;}
      .pw-seeall{margin-top:16px;background:none;border:none;padding:0;cursor:pointer;font:inherit;
        font-size:.82rem;font-weight:600;color:#cf9416;}
      .pw-seeall:hover{text-decoration:underline;}
      /* Light theme: pale gold is invisible on a light panel — darken it. */
      body.light .pw-title{color:#9a6a00;}
      body.light .pw-btn-activate{color:#8a5e00;}
      body.light .pw-right-title{color:#9a6a00;}
      body.light .pw-seeall{color:#9a6a00;}
      @media (max-width:640px){.pw-right{border-left:none;border-top:1px solid var(--line);}}
    `;
    document.head.appendChild(style);
  }

  function build() {
    if (built) return;
    injectStyles();

    backdropEl = document.createElement('div');
    backdropEl.className = 'pw-backdrop';

    panelEl = document.createElement('div');
    panelEl.className = 'pw-panel';
    panelEl.innerHTML = `
      <button class="pw-close" type="button" aria-label="Close" data-i18n-title="common.close">&times;</button>
      <div class="pw-body">
        <div class="pw-left">
          <div class="pw-badge"><span><ui-icon name="gem"></ui-icon><span data-i18n="paywall.badge.pro">Pro</span></span></div>
          <div class="pw-title"></div>
          <p class="pw-desc"></p>
          <div class="pw-key-row">
            <input type="text" data-i18n-placeholder="paywall.licenseKey.placeholder" placeholder="Paste your license key…" spellcheck="false" autocomplete="off">
            <button class="pw-btn pw-btn-activate" type="button" data-i18n="paywall.activate">Activate</button>
          </div>
          <p class="pw-msg"></p>
          <a class="pw-btn-buy" target="_blank" rel="noopener noreferrer" data-i18n="paywall.buy">Get ADO Atlas Pro — $5/mo</a>
        </div>
        <div class="pw-right">
          <div class="pw-right-title" data-i18n="paywall.everythingInPro">Everything in Pro</div>
          <ul class="pw-benefits">
            ${BENEFITS.map(b => `<li class="pw-benefit" data-key="${b.key}"><ui-icon name="${b.icon}"></ui-icon><span data-i18n="${b.textKey}"></span></li>`).join('')}
          </ul>
          <button type="button" class="pw-seeall" data-i18n="paywall.seeAll">See all Pro features →</button>
        </div>
      </div>
    `;
    backdropEl.appendChild(panelEl);
    document.body.appendChild(backdropEl);

    titleEl = panelEl.querySelector('.pw-title');
    descEl = panelEl.querySelector('.pw-desc');
    keyInput = panelEl.querySelector('.pw-key-row input');
    activateBtn = panelEl.querySelector('.pw-btn-activate');
    msgEl = panelEl.querySelector('.pw-msg');
    benefitsEl = panelEl.querySelector('.pw-benefits');
    const buyLink = panelEl.querySelector('.pw-btn-buy');
    buyLink.href = BUY_URL;

    panelEl.querySelector('.pw-close').addEventListener('click', () => PremiumPaywall.close());
    backdropEl.addEventListener('click', (e) => { if (e.target === backdropEl) PremiumPaywall.close(); });
    activateBtn.addEventListener('click', onActivate);
    keyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') onActivate(); });

    const seeAll = panelEl.querySelector('.pw-seeall');
    if (seeAll) seeAll.addEventListener('click', () => {
      PremiumPaywall.close();
      if (global.ProFeaturesPanel) global.ProFeaturesPanel.open();
    });

    // Translate the static markup, then re-pitch on language switch so an open
    // dialog updates live.
    if (global.i18n) {
      global.i18n.applyDOM(panelEl);
      global.i18n.onChange(() => {
        if (!built) return;
        global.i18n.applyDOM(panelEl);
        renderPitch();
      });
    }

    built = true;
  }

  // Renders the left-column title/desc for the currently active feature pitch.
  function renderPitch() {
    if (!titleEl || !descEl) return;
    const f = activeInfo || FEATURES[activeFeature] || FEATURES.default;
    // info from ProFeaturesPanel carries literal title/desc (catalog items aren't
    // all localized); FEATURES entries carry i18n keys resolved here.
    titleEl.textContent = f.title != null ? f.title : L(f.titleKey);
    descEl.textContent = f.desc != null ? f.desc : L(f.descKey);
  }

  async function onActivate() {
    const key = (keyInput.value || '').trim();
    if (!key) { setMsg(L('paywall.msg.enterKey', null, 'Please enter a license key.'), true); return; }
    setMsg(L('paywall.msg.activating', null, 'Activating…'), false);
    activateBtn.disabled = true;
    try {
      await global.EntitlementManager.activate(key);
      setMsg(L('paywall.msg.activated', null, 'Activated! Enjoy Pro.'), false);
    } catch (e) {
      // EntitlementManager errors are not UI chrome — surface as-is, falling back
      // to a localized generic failure when no message is supplied.
      setMsg(e.message || L('paywall.msg.activationFailed', null, 'Activation failed.'), true);
    } finally {
      activateBtn.disabled = false;
    }
  }

  function setMsg(text, isError) {
    if (!msgEl) return;
    msgEl.textContent = text;
    msgEl.style.color = isError ? '#ff9b9b' : '#9be3a8';
  }

  const PremiumPaywall = {
    // open(feature, info?) — `info` ({title, desc}) overrides the FEATURES lookup,
    // used by ProFeaturesPanel to pitch catalog items that have no FEATURES entry.
    open(feature, info) {
      build();
      activeFeature = feature;
      activeInfo = info || null;
      renderPitch();
      // Highlight the benefit row that matches the triggering feature.
      benefitsEl.querySelectorAll('.pw-benefit').forEach(li => {
        li.classList.toggle('active', li.dataset.key === feature);
      });
      setMsg('', false);
      keyInput.value = '';
      backdropEl.classList.add('show');
      if (global.LayerManager) global.LayerManager.open(panelEl, backdropEl, { isPopover: false });
      setTimeout(() => keyInput && keyInput.focus(), 0);
    },

    close() {
      if (!backdropEl) return;
      backdropEl.classList.remove('show');
      if (global.LayerManager) global.LayerManager.close(panelEl);
    }
  };

  global.PremiumPaywall = PremiumPaywall;

})(typeof globalThis !== 'undefined' ? globalThis : window);

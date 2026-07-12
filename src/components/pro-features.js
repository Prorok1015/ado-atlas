(function (global) {
  'use strict';

  // ProFeaturesPanel: a self-contained "Explore ADO Atlas Pro" overview modal that
  // lists EVERY planned premium feature grouped by category, each as a clickable
  // tile that opens the paywall for that feature. Purpose: a single screen to see
  // the full premium surface / scope of work. Theme-dependent, gold accents,
  // ui-icons (no emoji), stacked via LayerManager.
  //
  // `status` per item: 'stub' = has an in-context UI placeholder already;
  // 'partial' = base feature exists free, Pro adds more; 'planned' = not started.

  // Lazy, guarded i18n helper. Falls back to an English literal so the panel
  // degrades gracefully when the runtime is absent.
  const L = (k, p, fallback) => (typeof global.i18n !== 'undefined' && global.i18n)
    ? global.i18n.t(k, p)
    : (fallback != null ? fallback : k);

  // Catalog rows carry i18n keys (titleKey/descKey) resolved at render time; the
  // English literal lives in locales/en.json. groupKey localizes the section head.
  const CATALOG = [
    { groupKey: 'proFeatures.group.analytics', icon: 'bar-chart', items: [
      { key: 'analytics',   titleKey: 'proFeatures.item.analytics.title',  descKey: 'proFeatures.item.analytics.desc',  status: 'stub' },
      { key: 'an_cycle',    titleKey: 'proFeatures.item.anCycle.title',    descKey: 'proFeatures.item.anCycle.desc',    status: 'planned' },
      { key: 'an_cfd',      titleKey: 'proFeatures.item.anCfd.title',      descKey: 'proFeatures.item.anCfd.desc',      status: 'planned' },
      { key: 'an_aging',    titleKey: 'proFeatures.item.anAging.title',    descKey: 'proFeatures.item.anAging.desc',    status: 'planned' },
      { key: 'an_burndown', titleKey: 'proFeatures.item.anBurndown.title', descKey: 'proFeatures.item.anBurndown.desc', status: 'planned' },
      { key: 'an_velocity', titleKey: 'proFeatures.item.anVelocity.title', descKey: 'proFeatures.item.anVelocity.desc', status: 'planned' },
      { key: 'an_stale',    titleKey: 'proFeatures.item.anStale.title',    descKey: 'proFeatures.item.anStale.desc',    status: 'planned' },
      { key: 'an_blocked',  titleKey: 'proFeatures.item.anBlocked.title',  descKey: 'proFeatures.item.anBlocked.desc',  status: 'planned' },
      { key: 'an_team_throughput', titleKey: 'proFeatures.item.anTeamThroughput.title', descKey: 'proFeatures.item.anTeamThroughput.desc', status: 'planned' },
      { key: 'an_team_avg_cycle',  titleKey: 'proFeatures.item.anTeamAvgCycle.title',  descKey: 'proFeatures.item.anTeamAvgCycle.desc',  status: 'planned' },
      { key: 'an_team_top',        titleKey: 'proFeatures.item.anTeamTop.title',        descKey: 'proFeatures.item.anTeamTop.desc',        status: 'planned' }
    ]},
    { groupKey: 'proFeatures.group.ai', icon: 'sparkles', items: [
      { key: 'cloud_ai',   titleKey: 'proFeatures.item.cloudAi.title',   descKey: 'proFeatures.item.cloudAi.desc',   status: 'stub' },
      { key: 'ai_summary', titleKey: 'proFeatures.item.aiSummary.title', descKey: 'proFeatures.item.aiSummary.desc', status: 'planned' },
      { key: 'ai_deps',    titleKey: 'proFeatures.item.aiDeps.title',    descKey: 'proFeatures.item.aiDeps.desc',    status: 'planned' },
      { key: 'ai_reports', titleKey: 'proFeatures.item.aiReports.title', descKey: 'proFeatures.item.aiReports.desc', status: 'planned' },
      { key: 'ai_risk',    titleKey: 'proFeatures.item.aiRisk.title',    descKey: 'proFeatures.item.aiRisk.desc',    status: 'planned' }
    ]},
    { groupKey: 'proFeatures.group.viz', icon: 'layout', items: [
      { key: 'conditional_formatting', titleKey: 'proFeatures.item.conditionalFormatting.title', descKey: 'proFeatures.item.conditionalFormatting.desc', status: 'planned' },
      { key: 'saved_views',     titleKey: 'proFeatures.item.savedViews.title',     descKey: 'proFeatures.item.savedViews.desc',     status: 'planned' },
      { key: 'swimlanes',       titleKey: 'proFeatures.item.swimlanes.title',      descKey: 'proFeatures.item.swimlanes.desc',      status: 'planned' },
      { key: 'critical_path',   titleKey: 'proFeatures.item.criticalPath.title',   descKey: 'proFeatures.item.criticalPath.desc',   status: 'planned' },
      { key: 'baseline_gantt',  titleKey: 'proFeatures.item.baselineGantt.title',  descKey: 'proFeatures.item.baselineGantt.desc',  status: 'planned' },
      { key: 'ultra_dark',      titleKey: 'proFeatures.item.ultraDark.title',      descKey: 'proFeatures.item.ultraDark.desc',      status: 'planned' },
      { key: 'premium_white',   titleKey: 'proFeatures.item.premiumWhite.title',   descKey: 'proFeatures.item.premiumWhite.desc',   status: 'planned' },
      { key: 'quick_templates', titleKey: 'proFeatures.item.quickTemplates.title', descKey: 'proFeatures.item.quickTemplates.desc', status: 'planned' }
    ]},
    { groupKey: 'proFeatures.group.filters', icon: 'folder', items: [
      { key: 'filter_presets', titleKey: 'proFeatures.item.filterPresets.title', descKey: 'proFeatures.item.filterPresets.desc', status: 'partial' }
    ]},
    { groupKey: 'proFeatures.group.signIn', icon: 'key', items: [
      { key: 'hosted_oauth', titleKey: 'proFeatures.item.hostedOauth.title', descKey: 'proFeatures.item.hostedOauth.desc', status: 'stub' }
    ]},
    { groupKey: 'proFeatures.group.export', icon: 'download', items: [
      { key: 'export',     titleKey: 'proFeatures.item.export.title',    descKey: 'proFeatures.item.export.desc',    status: 'stub' },
      { key: 'share_link', titleKey: 'proFeatures.item.shareLink.title', descKey: 'proFeatures.item.shareLink.desc', status: 'planned' }
    ]},
    { groupKey: 'proFeatures.group.team', icon: 'user', items: [
      { key: 'shared_views',     titleKey: 'proFeatures.item.sharedViews.title',      descKey: 'proFeatures.item.sharedViews.desc',      status: 'planned' },
      { key: 'tv_dashboard',     titleKey: 'proFeatures.item.tvDashboard.title',      descKey: 'proFeatures.item.tvDashboard.desc',      status: 'planned' },
      { key: 'scheduled_reports',titleKey: 'proFeatures.item.scheduledReports.title', descKey: 'proFeatures.item.scheduledReports.desc', status: 'planned' },
      { key: 'cross_project',    titleKey: 'proFeatures.item.crossProject.title',     descKey: 'proFeatures.item.crossProject.desc',     status: 'planned' }
    ]}
  ];

  const STATUS = {
    stub:    { labelKey: 'proFeatures.status.stub',    cls: 'pf-st-stub' },
    partial: { labelKey: 'proFeatures.status.partial', cls: 'pf-st-partial' },
    planned: { labelKey: 'proFeatures.status.planned', cls: 'pf-st-planned' }
  };

  let built = false;
  let backdropEl = null;
  let panelEl = null;

  function injectStyles() {
    if (document.getElementById('pro-features-styles')) return;
    const style = document.createElement('style');
    style.id = 'pro-features-styles';
    style.textContent = `
      .pf-backdrop{position:fixed;inset:0;background:rgba(8,10,18,.55);backdrop-filter:blur(4px);display:none;align-items:center;justify-content:center;}
      .pf-backdrop.show{display:flex;}
      .pf-panel{position:relative;width:min(880px,94vw);max-height:90vh;overflow:auto;border-radius:16px;color:var(--txt);
        background:linear-gradient(160deg,var(--panel) 0%,var(--panel2) 100%);
        border:1px solid var(--line);box-shadow:0 24px 70px rgba(0,0,0,.45);font-family:inherit;padding:26px 28px;}
      .pf-head{display:flex;align-items:center;gap:.5em;margin:0 0 4px;}
      .pf-head .pf-badge{display:inline-flex;align-items:center;gap:.3em;font-weight:800;font-size:.8rem;letter-spacing:.08em;
        text-transform:uppercase;padding:.22rem .7rem;border-radius:.5rem;background:linear-gradient(135deg,#ffe07a,#f2a900);color:#4a3500;}
      .pf-head .pf-badge ui-icon svg{width:1em;height:1em;}
      .pf-head h2{font-size:1.2rem;margin:0;font-weight:700;}
      .pf-sub{color:var(--muted);font-size:.86rem;margin:0 0 18px;}
      .pf-group{margin-bottom:18px;}
      .pf-group-title{display:flex;align-items:center;gap:.45em;font-size:.78rem;font-weight:700;text-transform:uppercase;
        letter-spacing:.06em;color:#cf9416;margin:0 0 10px;}
      .pf-group-title ui-icon{color:#f2a900;}
      .pf-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(238px,1fr));gap:10px;}
      .pf-tile{text-align:left;cursor:pointer;background:var(--field);border:1px solid var(--line);border-radius:10px;
        padding:11px 13px;color:var(--txt);font:inherit;transition:border-color .12s,background .12s;}
      .pf-tile:hover{border-color:#f2a900;background:rgba(242,169,0,.06);}
      .pf-tile-top{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:3px;}
      .pf-tile-title{font-weight:600;font-size:.9rem;}
      .pf-tile-desc{color:var(--muted);font-size:.78rem;line-height:1.35;}
      .pf-tag{flex:none;font-size:.6rem;font-weight:700;text-transform:uppercase;letter-spacing:.03em;
        padding:.1rem .4rem;border-radius:.35rem;white-space:nowrap;}
      .pf-st-stub{background:rgba(34,197,94,.18);color:#48d178;}
      .pf-st-partial{background:rgba(242,169,0,.18);color:#e0a82e;}
      .pf-st-planned{background:var(--panel2);color:var(--muted);border:1px solid var(--line);}
      .pf-close{position:absolute;top:14px;right:16px;background:none;border:none;color:var(--muted);font-size:20px;cursor:pointer;line-height:1;}
      .pf-close:hover{color:var(--txt);}
      body.light .pf-group-title{color:#9a6a00;}
      body.light .pf-st-partial{color:#9a6a00;}
    `;
    document.head.appendChild(style);
  }

  function build() {
    if (built) return;
    injectStyles();

    backdropEl = document.createElement('div');
    backdropEl.className = 'pf-backdrop';

    panelEl = document.createElement('div');
    panelEl.className = 'pf-panel';

    const groupsHtml = CATALOG.map(g => `
      <div class="pf-group">
        <div class="pf-group-title"><ui-icon name="${g.icon}"></ui-icon><span data-i18n="${g.groupKey}"></span></div>
        <div class="pf-grid">
          ${g.items.map(it => `
            <button type="button" class="pf-tile" data-key="${it.key}">
              <div class="pf-tile-top">
                <span class="pf-tile-title" data-i18n="${it.titleKey}"></span>
                <span class="pf-tag ${STATUS[it.status].cls}" data-i18n="${STATUS[it.status].labelKey}"></span>
              </div>
              <div class="pf-tile-desc" data-i18n="${it.descKey}"></div>
            </button>`).join('')}
        </div>
      </div>`).join('');

    panelEl.innerHTML = `
      <button class="pf-close" type="button" aria-label="Close" data-i18n-title="common.close">&times;</button>
      <div class="pf-head"><span class="pf-badge"><ui-icon name="gem"></ui-icon><span data-i18n="proFeatures.badge.pro">Pro</span></span><h2 data-i18n="proFeatures.title">Explore ADO Atlas Pro</h2></div>
      <p class="pf-sub" data-i18n="proFeatures.subtitle">Everything planned for the paid tier. Click any feature for details.</p>
      ${groupsHtml}
    `;
    backdropEl.appendChild(panelEl);
    document.body.appendChild(backdropEl);

    // Translate static markup; re-apply on language switch so an open panel updates.
    if (global.i18n) {
      global.i18n.applyDOM(panelEl);
      global.i18n.onChange(() => { if (built) global.i18n.applyDOM(panelEl); });
    }

    panelEl.querySelector('.pf-close').addEventListener('click', () => ProFeaturesPanel.close());
    backdropEl.addEventListener('click', (e) => { if (e.target === backdropEl) ProFeaturesPanel.close(); });

    // Tile → open the paywall for that feature (one modal at a time).
    panelEl.querySelectorAll('.pf-tile').forEach(tile => {
      tile.addEventListener('click', () => {
        const key = tile.dataset.key;
        const item = findItem(key);
        ProFeaturesPanel.close();
        if (global.PremiumPaywall) {
          // Hand the paywall resolved (localized) strings for catalog items that
          // have no dedicated FEATURES entry of their own.
          global.PremiumPaywall.open(key, item ? { title: L(item.titleKey), desc: L(item.descKey) } : null);
        }
      });
    });

    built = true;
  }

  function findItem(key) {
    for (const g of CATALOG) {
      const it = g.items.find(i => i.key === key);
      if (it) return it;
    }
    return null;
  }

  const ProFeaturesPanel = {
    open() {
      build();
      backdropEl.classList.add('show');
      if (global.LayerManager) global.LayerManager.open(panelEl, backdropEl, { isPopover: false });
    },
    close() {
      if (!backdropEl) return;
      backdropEl.classList.remove('show');
      if (global.LayerManager) global.LayerManager.close(panelEl);
    }
  };

  global.ProFeaturesPanel = ProFeaturesPanel;

})(typeof globalThis !== 'undefined' ? globalThis : window);

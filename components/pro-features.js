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

  const CATALOG = [
    { group: 'Analytics', icon: 'bar-chart', items: [
      { key: 'analytics',   title: 'Analytics module',        desc: 'Process-analytics workspace built from work-item revision history.', status: 'stub' },
      { key: 'an_cycle',    title: 'Cycle / Lead Time',       desc: 'Time-in-state and end-to-end delivery time per work item.', status: 'planned' },
      { key: 'an_cfd',      title: 'Cumulative Flow (CFD)',   desc: 'Stacked state distribution over time — spot bottlenecks and growing WIP.', status: 'planned' },
      { key: 'an_aging',    title: 'Aging WIP',               desc: 'How long in-progress items have been open — a strong daily-standup signal.', status: 'planned' },
      { key: 'an_burndown', title: 'Burndown / Burnup',       desc: 'Sprint progress against scope, with scope-change tracking.', status: 'planned' },
      { key: 'an_velocity', title: 'Velocity',                desc: 'Completed story points / count per sprint, per team.', status: 'planned' },
      { key: 'an_stale',    title: 'Stale Items',             desc: 'Board of items stuck in a state longer than N days.', status: 'planned' },
      { key: 'an_blocked',  title: 'Blocked-time analytics',  desc: 'Total time items spent blocked.', status: 'planned' }
    ]},
    { group: 'AI', icon: 'sparkles', items: [
      { key: 'cloud_ai',   title: 'ADO Atlas Cloud AI',       desc: 'Cloud GPT / Claude via our proxy — no API key of your own.', status: 'stub' },
      { key: 'ai_summary', title: 'AI Sprint Summary',        desc: 'Auto digest: what shipped, what is stuck, risks.', status: 'planned' },
      { key: 'ai_deps',    title: 'AI dependency explainer',  desc: 'Plain-language "why does this block the release" on the graph.', status: 'planned' },
      { key: 'ai_reports', title: 'Natural-language reports', desc: 'Ask questions like "what slowed last sprint" and get an answer.', status: 'planned' },
      { key: 'ai_risk',    title: 'Risk detection',           desc: 'Flags items at risk of missing their date from revision dynamics.', status: 'planned' }
    ]},
    { group: 'Visualization & QoL', icon: 'layout', items: [
      { key: 'conditional_formatting', title: 'Conditional formatting', desc: 'Colour cards by rules (priority, age, assignee, custom fields).', status: 'planned' },
      { key: 'saved_views',     title: 'Saved Views',           desc: 'Save a mode + filter + grouping combo and switch in one click.', status: 'planned' },
      { key: 'swimlanes',       title: 'Board swimlanes',       desc: 'Group the board into lanes by epic / assignee / priority.', status: 'planned' },
      { key: 'critical_path',   title: 'Critical path',         desc: 'Highlight the dependency chain that drives the deadline on Timeline.', status: 'planned' },
      { key: 'baseline_gantt',  title: 'Gantt baseline',        desc: 'Compare planned vs actual dates on the Timeline.', status: 'planned' },
      { key: 'ultra_dark',      title: 'Ultra Dark theme',      desc: 'Extra high-contrast dark theme variant.', status: 'planned' },
      { key: 'quick_templates', title: 'Quick-create templates',desc: 'One-click work-item templates for repetitive creation.', status: 'planned' }
    ]},
    { group: 'Filters', icon: 'folder', items: [
      { key: 'filter_presets', title: 'Synced filter presets', desc: 'Free saves 5 locally; Pro stores in the cloud, syncs across devices/accounts and raises the limit.', status: 'partial' }
    ]},
    { group: 'Sign-in', icon: 'key', items: [
      { key: 'hosted_oauth', title: '1-Click Microsoft Sign-in', desc: 'Sign in with Microsoft in one click — no Entra app to register.', status: 'stub' }
    ]},
    { group: 'Export & Integrations', icon: 'download', items: [
      { key: 'export',     title: 'Advanced Export (PDF/Excel)', desc: 'High-res Gantt/Timeline (SVG/PDF) and analytics to CSV/Excel.', status: 'stub' },
      { key: 'share_link', title: 'Public share link',           desc: 'Read-only snapshot link to a graph/timeline for stakeholders without ADO access.', status: 'planned' }
    ]},
    { group: 'Team & Enterprise', icon: 'user', items: [
      { key: 'shared_views',     title: 'Shared presets / dashboards', desc: 'Team-wide shared filters, views and dashboards.', status: 'planned' },
      { key: 'tv_dashboard',     title: 'TV / kiosk dashboards',       desc: 'Read-only kiosk mode for standup screens.', status: 'planned' },
      { key: 'scheduled_reports',title: 'Scheduled reports',           desc: 'Weekly sprint metrics to email / Slack / Teams.', status: 'planned' },
      { key: 'cross_project',    title: 'Cross-project / org boards',  desc: 'Aggregate items from several projects / organizations.', status: 'planned' }
    ]}
  ];

  const STATUS = {
    stub:    { label: 'Stub in UI', cls: 'pf-st-stub' },
    partial: { label: 'Free + Pro', cls: 'pf-st-partial' },
    planned: { label: 'Planned',    cls: 'pf-st-planned' }
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
        <div class="pf-group-title"><ui-icon name="${g.icon}"></ui-icon>${g.group}</div>
        <div class="pf-grid">
          ${g.items.map(it => `
            <button type="button" class="pf-tile" data-key="${it.key}">
              <div class="pf-tile-top">
                <span class="pf-tile-title">${it.title}</span>
                <span class="pf-tag ${STATUS[it.status].cls}">${STATUS[it.status].label}</span>
              </div>
              <div class="pf-tile-desc">${it.desc}</div>
            </button>`).join('')}
        </div>
      </div>`).join('');

    panelEl.innerHTML = `
      <button class="pf-close" type="button" aria-label="Close">&times;</button>
      <div class="pf-head"><span class="pf-badge"><ui-icon name="gem"></ui-icon>Pro</span><h2>Explore ADO Atlas Pro</h2></div>
      <p class="pf-sub">Everything planned for the paid tier. Click any feature for details.</p>
      ${groupsHtml}
    `;
    backdropEl.appendChild(panelEl);
    document.body.appendChild(backdropEl);

    panelEl.querySelector('.pf-close').addEventListener('click', () => ProFeaturesPanel.close());
    backdropEl.addEventListener('click', (e) => { if (e.target === backdropEl) ProFeaturesPanel.close(); });

    // Tile → open the paywall for that feature (one modal at a time).
    panelEl.querySelectorAll('.pf-tile').forEach(tile => {
      tile.addEventListener('click', () => {
        const key = tile.dataset.key;
        const item = findItem(key);
        ProFeaturesPanel.close();
        if (global.PremiumPaywall) {
          global.PremiumPaywall.open(key, item ? { title: item.title, desc: item.desc } : null);
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
      if (global.LayerManager) global.LayerManager.open(panelEl, backdropEl, { isPopover: true });
    },
    close() {
      if (!backdropEl) return;
      backdropEl.classList.remove('show');
      if (global.LayerManager) global.LayerManager.close(panelEl);
    }
  };

  global.ProFeaturesPanel = ProFeaturesPanel;

})(typeof globalThis !== 'undefined' ? globalThis : window);

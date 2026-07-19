(function (global) {
  'use strict';

  // ProCatalog — THE single registry of premium features. Everything about a feature is
  // declared here, once: which group it lives in, what it's called, whether it's built,
  // and who may use it.
  //
  // Before this existed, one feature was declared in THREE places — TIERS
  // (pro-button-manager), FEATURES (premium-paywall) and CATALOG (pro-features) — and every
  // omission failed SILENTLY:
  //   missing from TIERS   -> getTier() defaulted it to 'pro'; nobody chose that
  //   missing from FEATURES-> the paywall quietly pitched the generic blurb
  //   missing from CATALOG -> the feature was invisible in "Explore ADO Atlas Pro"
  // 16 of the 33 features had no tier of their own. tools/check-premium.js now fails the
  // build on any such gap.
  //
  // TWO INDEPENDENT AXES — do not conflate them:
  //   tier   'free' | 'preview' | 'pro'            WHO MAY USE IT. The gate reads this.
  //          'preview' = Free Preview: works for everyone today, wears a gold PREVIEW badge.
  //          Flipping a tier is the ONLY thing needed to gate or ungate a feature.
  //   status 'planned' | 'stub' | 'partial' | 'live'   WHETHER IT IS BUILT. Never access.
  //          'live' = shipped and usable · 'stub' = placeholder UI only · 'planned' = not started
  //
  // pitchTitleKey / pitchDescKey are optional: the paywall's per-feature pitch. Without them
  // it falls back to the generic copy — which is fine for a feature nobody clicks directly.
  const GROUPS = [
    { group: 'proFeatures.group.analytics', icon: 'bar-chart', items: [
      { key: 'analytics', tier: 'preview', status: 'stub', titleKey: 'proFeatures.item.analytics.title', descKey: 'proFeatures.item.analytics.desc', pitchTitleKey: 'paywall.feature.analytics.title', pitchDescKey: 'paywall.feature.analytics.desc' },
      { key: 'an_cycle', tier: 'preview', status: 'planned', titleKey: 'proFeatures.item.anCycle.title', descKey: 'proFeatures.item.anCycle.desc' },
      { key: 'an_cfd', tier: 'preview', status: 'planned', titleKey: 'proFeatures.item.anCfd.title', descKey: 'proFeatures.item.anCfd.desc' },
      { key: 'an_aging', tier: 'preview', status: 'planned', titleKey: 'proFeatures.item.anAging.title', descKey: 'proFeatures.item.anAging.desc' },
      { key: 'an_burndown', tier: 'preview', status: 'planned', titleKey: 'proFeatures.item.anBurndown.title', descKey: 'proFeatures.item.anBurndown.desc' },
      { key: 'an_velocity', tier: 'preview', status: 'planned', titleKey: 'proFeatures.item.anVelocity.title', descKey: 'proFeatures.item.anVelocity.desc' },
      { key: 'an_stale', tier: 'preview', status: 'planned', titleKey: 'proFeatures.item.anStale.title', descKey: 'proFeatures.item.anStale.desc' },
      { key: 'an_blocked', tier: 'preview', status: 'planned', titleKey: 'proFeatures.item.anBlocked.title', descKey: 'proFeatures.item.anBlocked.desc' },
      { key: 'an_team_throughput', tier: 'preview', status: 'planned', titleKey: 'proFeatures.item.anTeamThroughput.title', descKey: 'proFeatures.item.anTeamThroughput.desc' },
      { key: 'an_team_avg_cycle', tier: 'preview', status: 'planned', titleKey: 'proFeatures.item.anTeamAvgCycle.title', descKey: 'proFeatures.item.anTeamAvgCycle.desc' },
      { key: 'an_team_top', tier: 'preview', status: 'planned', titleKey: 'proFeatures.item.anTeamTop.title', descKey: 'proFeatures.item.anTeamTop.desc' },
    ]},
    { group: 'proFeatures.group.ai', icon: 'sparkles', items: [
      { key: 'cloud_ai', tier: 'pro', status: 'stub', titleKey: 'proFeatures.item.cloudAi.title', descKey: 'proFeatures.item.cloudAi.desc', pitchTitleKey: 'paywall.feature.cloudAi.title', pitchDescKey: 'paywall.feature.cloudAi.desc' },
      { key: 'deep_research', tier: 'pro', status: 'planned', titleKey: 'proFeatures.item.deepResearch.title', descKey: 'proFeatures.item.deepResearch.desc', pitchTitleKey: 'paywall.feature.deepResearch.title', pitchDescKey: 'paywall.feature.deepResearch.desc' },
      { key: 'ai_summary', tier: 'pro', status: 'planned', titleKey: 'proFeatures.item.aiSummary.title', descKey: 'proFeatures.item.aiSummary.desc' },
      { key: 'ai_deps', tier: 'pro', status: 'planned', titleKey: 'proFeatures.item.aiDeps.title', descKey: 'proFeatures.item.aiDeps.desc' },
      { key: 'ai_reports', tier: 'pro', status: 'planned', titleKey: 'proFeatures.item.aiReports.title', descKey: 'proFeatures.item.aiReports.desc' },
      { key: 'ai_risk', tier: 'pro', status: 'planned', titleKey: 'proFeatures.item.aiRisk.title', descKey: 'proFeatures.item.aiRisk.desc' },
    ]},
    { group: 'proFeatures.group.viz', icon: 'layout', items: [
      { key: 'conditional_formatting', tier: 'preview', status: 'planned', titleKey: 'proFeatures.item.conditionalFormatting.title', descKey: 'proFeatures.item.conditionalFormatting.desc' },
      { key: 'saved_views', tier: 'pro', status: 'planned', titleKey: 'proFeatures.item.savedViews.title', descKey: 'proFeatures.item.savedViews.desc' },
      { key: 'swimlanes', tier: 'pro', status: 'planned', titleKey: 'proFeatures.item.swimlanes.title', descKey: 'proFeatures.item.swimlanes.desc' },
      { key: 'critical_path', tier: 'pro', status: 'planned', titleKey: 'proFeatures.item.criticalPath.title', descKey: 'proFeatures.item.criticalPath.desc' },
      { key: 'baseline_gantt', tier: 'pro', status: 'planned', titleKey: 'proFeatures.item.baselineGantt.title', descKey: 'proFeatures.item.baselineGantt.desc' },
      { key: 'ultra_dark', tier: 'preview', status: 'live', titleKey: 'proFeatures.item.ultraDark.title', descKey: 'proFeatures.item.ultraDark.desc', pitchTitleKey: 'paywall.feature.ultraDark.title', pitchDescKey: 'paywall.feature.ultraDark.desc' },
      { key: 'nocturne', tier: 'preview', status: 'live', titleKey: 'proFeatures.item.nocturne.title', descKey: 'proFeatures.item.nocturne.desc', pitchTitleKey: 'paywall.feature.nocturne.title', pitchDescKey: 'paywall.feature.nocturne.desc' },
      { key: 'premium_white', tier: 'preview', status: 'live', titleKey: 'proFeatures.item.premiumWhite.title', descKey: 'proFeatures.item.premiumWhite.desc', pitchTitleKey: 'paywall.feature.premiumWhite.title', pitchDescKey: 'paywall.feature.premiumWhite.desc' },
      { key: 'quick_templates', tier: 'preview', status: 'planned', titleKey: 'proFeatures.item.quickTemplates.title', descKey: 'proFeatures.item.quickTemplates.desc' },
    ]},
    { group: 'proFeatures.group.filters', icon: 'folder', items: [
      { key: 'filter_presets', tier: 'pro', status: 'partial', titleKey: 'proFeatures.item.filterPresets.title', descKey: 'proFeatures.item.filterPresets.desc', pitchTitleKey: 'paywall.feature.filterPresets.title', pitchDescKey: 'paywall.feature.filterPresets.desc' },
    ]},
    { group: 'proFeatures.group.signIn', icon: 'key', items: [
      { key: 'hosted_oauth', tier: 'pro', status: 'stub', titleKey: 'proFeatures.item.hostedOauth.title', descKey: 'proFeatures.item.hostedOauth.desc', pitchTitleKey: 'paywall.feature.hostedOauth.title', pitchDescKey: 'paywall.feature.hostedOauth.desc' },
    ]},
    { group: 'proFeatures.group.export', icon: 'download', items: [
      { key: 'export', tier: 'preview', status: 'stub', titleKey: 'proFeatures.item.export.title', descKey: 'proFeatures.item.export.desc', pitchTitleKey: 'paywall.feature.export.title', pitchDescKey: 'paywall.feature.export.desc' },
      { key: 'share_link', tier: 'pro', status: 'planned', titleKey: 'proFeatures.item.shareLink.title', descKey: 'proFeatures.item.shareLink.desc' },
    ]},
    { group: 'proFeatures.group.team', icon: 'user', items: [
      { key: 'shared_views', tier: 'pro', status: 'planned', titleKey: 'proFeatures.item.sharedViews.title', descKey: 'proFeatures.item.sharedViews.desc' },
      { key: 'tv_dashboard', tier: 'pro', status: 'planned', titleKey: 'proFeatures.item.tvDashboard.title', descKey: 'proFeatures.item.tvDashboard.desc' },
      { key: 'scheduled_reports', tier: 'pro', status: 'planned', titleKey: 'proFeatures.item.scheduledReports.title', descKey: 'proFeatures.item.scheduledReports.desc' },
      { key: 'cross_project', tier: 'pro', status: 'planned', titleKey: 'proFeatures.item.crossProject.title', descKey: 'proFeatures.item.crossProject.desc' },
    ]},  ];

  const BY_KEY = new Map();
  for (const g of GROUPS) for (const it of g.items) BY_KEY.set(it.key, Object.assign({ group: g.group }, it));

  const ProCatalog = {
    GROUPS,
    get(key) { return BY_KEY.get(key) || null; },
    has(key) { return BY_KEY.has(key); },
    keys() { return [...BY_KEY.keys()]; },

    // Who may use it. Unknown key -> 'pro': fail CLOSED. A feature nobody declared must not
    // be given away by accident; check-premium.js is what stops it silently reaching here.
    tier(key) { const f = BY_KEY.get(key); return f ? f.tier : 'pro'; },

    isPreview(key) { return this.tier(key) === 'preview'; },
    isLive(key) { const f = BY_KEY.get(key); return !!f && f.status === 'live'; }
  };

  global.ProCatalog = ProCatalog;

  if (typeof module !== 'undefined' && module.exports) module.exports = ProCatalog;
})(typeof globalThis !== 'undefined' ? globalThis : window);

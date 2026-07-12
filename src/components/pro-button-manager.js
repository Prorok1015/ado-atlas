(function (global) {
  'use strict';

  // ProButtonManager: A declarative styling engine for premium features.
  // Instead of hardcoding classes and badges on every button, we just mark the element
  // with `data-pro-feature="<feature_key>"`. This manager checks the TIERS dictionary,
  // assigns the correct CSS class ('pro-glow' for paid, 'pro-preview' for free preview),
  // generates and injects the corresponding auto-badge, and randomizes the shimmer
  // animation phase so adjacent buttons don't flash in lock-step.
  
  // Single Source of Truth for feature tiers.
  // Any feature key NOT listed here defaults to 'pro'.
  const TIERS = {
    // ---- Free Preview (champagne / soft gold) ----
    analytics: 'preview',
    an_cycle: 'preview',
    an_cfd: 'preview',
    an_aging: 'preview',
    an_burndown: 'preview',
    an_velocity: 'preview',
    an_stale: 'preview',
    an_blocked: 'preview',
    an_team_throughput: 'preview',
    an_team_avg_cycle: 'preview',
    an_team_top: 'preview',
    conditional_formatting: 'preview',
    quick_templates: 'preview',
    export: 'preview',
    ultra_dark: 'preview',
    premium_white: 'preview'

    // ---- Pro (gold) — Everything else ----
    // cloud_ai, hosted_oauth, filter_presets, shared_views,
    // tv_dashboard, scheduled_reports, cross_project, share_link,
    // saved_views, swimlanes, critical_path, baseline_gantt,
    // ai_summary, ai_deps, ai_reports, ai_risk
  };

  class ProButtonManager {
    static init() {
      this.refresh();
      
      // We could use a MutationObserver here for dynamically added UI elements,
      // but for now, any code building dynamic UI can just call ProButtonManager.apply(el)
      // or ProButtonManager.refresh() if it adds new `data-pro-feature` elements.
    }

    static refresh() {
      document.querySelectorAll('[data-pro-feature]').forEach(el => this.apply(el));
    }

    static getTier(feature) {
      return TIERS[feature] || 'pro';
    }

    static isPreview(feature) {
      return this.getTier(feature) === 'preview';
    }

    static apply(el) {
      const feature = el.dataset.proFeature;
      if (!feature) return;

      const tier = this.getTier(feature);
      const isPreview = tier === 'preview';
      const cssClass = isPreview ? 'pro-preview' : 'pro-glow';

      // 1. Swap classes
      el.classList.remove('pro-glow', 'pro-preview');
      el.classList.add(cssClass);

      // 2. Randomise shimmer phase (0.0s to 7.0s) & duration (6.0s to 8.0s)
      el.style.setProperty('--pro-delay', `${(Math.random() * 7).toFixed(1)}s`);
      el.style.setProperty('--pro-dur', `${(6 + Math.random() * 2).toFixed(1)}s`);

      // 3. Inject/Update Auto-Badge
      let badge = el.querySelector('.pro-badge-auto');
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'pro-badge-auto';
        el.appendChild(badge);
      }
      
      if (isPreview) {
        badge.classList.remove('pro-badge-tier-pro');
        badge.classList.add('pro-badge-tier-preview');
        badge.innerHTML = `<ui-icon name="gem"></ui-icon>PREVIEW`;
      } else {
        badge.classList.remove('pro-badge-tier-preview');
        badge.classList.add('pro-badge-tier-pro');
        badge.innerHTML = `<ui-icon name="gem"></ui-icon>PRO`;
      }
    }
  }

  // Export public interface
  global.ProButtonManager = ProButtonManager;

})(typeof globalThis !== 'undefined' ? globalThis : window);

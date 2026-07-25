(function (App) {
  'use strict';

  // In-memory cache for work item revision histories to avoid repeated fetches
  const revisionCache = new Map();
  let cachedProject = '';
  let activeView = 'dashboard';
  let selectedArenaMetric = 'tasks';
  let selectedSprintPath = '';
  let burndownMetric = 'points';
  let throughputTimeframe = 'last4weeks';
  let currentController = null;
  let currentRenderToken = 0;
  let currentUserDisplayName = '';

  // Localisation helper
  const L = (key, fallback, params) => (window.i18n && window.i18n.t) ? window.i18n.t(key, fallback, params) : fallback;

  function track(name, params) {
    try {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return;
      const p = chrome.runtime.sendMessage({ action: 'ga', name, params: params || {} });
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (_) {
      // never throw from a telemetry call
    }
  }

  function clearCache() {
    revisionCache.clear();
  }

  function cleanup() {
    if (currentController) {
      currentController.abort();
      currentController = null;
    }
  }

  function exportToCsv(filename, headers, rows) {
    const csvContent = [
      headers.map(h => `"${String(h).replace(/"/g, '""')}"`).join(','),
      ...rows.map(row => row.map(cell => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(','))
    ].join('\r\n');

    const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  function renderAnalytics() {
    // Clear cache if project switched
    if (window.projectName !== cachedProject) {
      clearCache();
      cachedProject = window.projectName;
    }

    if (App.prefs && App.prefs.get && App.prefs.get('analytics_active_view')) {
      activeView = App.prefs.get('analytics_active_view');
    }

    const container = document.getElementById('analytics');
    if (!container) return;

    // Initialize layout structure if not already built
    if (!container.querySelector('.analytics-sidebar')) {
      container.innerHTML = `
        <div class="analytics-sidebar">
          <div class="analytics-sidebar-title">${L('analytics.title', 'Analytics')}</div>
          
          <div class="analytics-menu-section-header">${L('analytics.menu.overview', 'Overview')}</div>
          <button class="analytics-menu-btn" data-view="dashboard">
            <ui-icon name="grid"></ui-icon> <span>${L('analytics.menu.dashboard', 'Dashboard')}</span>
          </button>
          <button class="analytics-menu-btn" data-view="cycle_time">
            <ui-icon name="clock"></ui-icon> <span>${L('analytics.menu.cycle', 'Cycle & Lead Time')}</span>
          </button>
          <button class="analytics-menu-btn" data-view="cfd">
            <ui-icon name="bar-chart"></ui-icon> <span>${L('analytics.menu.cfd', 'Cumulative Flow (CFD)')}</span>
          </button>
          <button class="analytics-menu-btn" data-view="aging_wip">
            <ui-icon name="activity"></ui-icon> <span>${L('analytics.menu.aging', 'Aging WIP')}</span>
          </button>

          <div class="analytics-menu-section-header">${L('analytics.menu.team', 'Team')}</div>
          <button class="analytics-menu-btn" data-view="profile">
            <ui-icon name="user"></ui-icon> <span>${L('analytics.menu.profile', 'My Profile')}</span>
          </button>
          <button class="analytics-menu-btn" data-view="leaderboard">
            <ui-icon name="trophy"></ui-icon> <span>${L('analytics.menu.leaderboard', 'Team Arena')}</span>
          </button>
          <button class="analytics-menu-btn" data-view="throughput">
            <ui-icon name="users"></ui-icon> <span>${L('analytics.menu.throughput', 'Team Throughput')}</span>
          </button>

          <div class="analytics-menu-section-header">${L('analytics.menu.sprint', 'Sprint')}</div>
          <button class="analytics-menu-btn" data-view="burndown">
            <ui-icon name="trending-down"></ui-icon> <span>${L('analytics.menu.burndown', 'Burndown Chart')}</span>
          </button>
          <button class="analytics-menu-btn" data-view="velocity">
            <ui-icon name="trending-up"></ui-icon> <span>${L('analytics.menu.velocity', 'Sprint Velocity')}</span>
          </button>

          <div class="analytics-menu-section-header">${L('analytics.menu.flow', 'Flow')}</div>
          <button class="analytics-menu-btn" data-view="stale_items">
            <ui-icon name="alert-circle"></ui-icon> <span>${L('analytics.menu.stale', 'Stale Items')}</span>
          </button>
          <button class="analytics-menu-btn" data-view="blocked_time">
            <ui-icon name="slash"></ui-icon> <span>${L('analytics.menu.blocked', 'Blocked Time')}</span>
          </button>
        </div>
        <div class="analytics-main">
          <div class="analytics-filter-toolbar" id="analytics_filter_toolbar">
            <div class="analytics-filter-group">
              <label>${L('analytics.filter.assignee', 'Assignee:')}</label>
              <select id="an_sel_assignee" class="analytics-filter-select">
                <option value="all">${L('analytics.filter.allAssignees', 'All Assignees')}</option>
              </select>
            </div>
            <div class="analytics-filter-group">
              <label>${L('analytics.filter.type', 'Item Type:')}</label>
              <select id="an_sel_type" class="analytics-filter-select">
                <option value="all">${L('analytics.filter.allTypes', 'All Item Types')}</option>
                <option value="User Story">User Story</option>
                <option value="Bug">Bug</option>
                <option value="Task">Task</option>
                <option value="Feature">Feature</option>
                <option value="Epic">Epic</option>
              </select>
            </div>
            <div class="analytics-filter-group">
              <label>${L('analytics.filter.timeframe', 'Timeframe:')}</label>
              <select id="an_sel_timeframe" class="analytics-filter-select">
                <option value="all">${L('analytics.filter.allTime', 'All Time')}</option>
                <option value="last30">${L('analytics.filter.last30', 'Last 30 Days')}</option>
                <option value="last90">${L('analytics.filter.last90', 'Last 90 Days')}</option>
              </select>
            </div>
          </div>

          <div class="analytics-loading" style="display:none">
            <div class="spinner-ring"></div>
            <div class="analytics-loading-text">${L('analytics.loading', 'Loading history...')} <span id="analytics_progress">0/0</span></div>
          </div>
          <div class="analytics-content"></div>
        </div>
      `;
    }

    // Update active highlight on menu buttons
    container.querySelectorAll('.analytics-menu-btn').forEach(btn => {
      const isActive = btn.dataset.view === activeView;
      btn.classList.toggle('active', isActive);
      btn.onclick = () => {
        container.querySelectorAll('.analytics-menu-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeView = btn.dataset.view;
        if (App.prefs && App.prefs.set) App.prefs.set('analytics_active_view', activeView);
        refreshAnalyticsView();
      };
    });

    refreshAnalyticsView();
  }

  const analyticsFilters = {
    assignee: 'all',
    type: 'all',
    timeframe: 'all'
  };

  function getAnalyticsFilteredNodes(customNodes) {
    const allNodes = customNodes || Object.values((App.state && App.state.store && App.state.store.nodes) || {});
    if (allNodes.length === 0) return [];

    const now = new Date();
    return allNodes.filter(node => {
      if (analyticsFilters.assignee !== 'all') {
        const assignedName = (node.assigned || '').toLowerCase();
        if (!assignedName.includes(analyticsFilters.assignee.toLowerCase())) {
          return false;
        }
      }
      if (analyticsFilters.type !== 'all') {
        const itemType = (node.type || '').toLowerCase();
        if (itemType !== analyticsFilters.type.toLowerCase()) {
          return false;
        }
      }
      if (analyticsFilters.timeframe !== 'all') {
        const rawDate = node.changeddate || node.createddate || node.changedDate || node.createdDate;
        if (rawDate) {
          const itemDate = new Date(rawDate);
          if (!isNaN(itemDate.getTime())) {
            if (analyticsFilters.timeframe === 'last30') {
              const past30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
              if (itemDate < past30) return false;
            } else if (analyticsFilters.timeframe === 'last90') {
              const past90 = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
              if (itemDate < past90) return false;
            }
          }
        }
      }
      return true;
    });
  }

  let analyticsItemsCache = null;

  async function queryAnalyticsItemsForView(viewName) {
    const rules = [];

    // 1. Timeframe filter (if user selected last30 or last90)
    if (analyticsFilters.timeframe === 'last30') {
      rules.push({
        kind: 'condition',
        field: 'changeddate',
        op: '>=',
        value: '@today - 30'
      });
    } else if (analyticsFilters.timeframe === 'last90') {
      rules.push({
        kind: 'condition',
        field: 'changeddate',
        op: '>=',
        value: '@today - 90'
      });
    }

    // 2. Assignee filter (if active)
    if (analyticsFilters.assignee && analyticsFilters.assignee !== 'all') {
      rules.push({
        kind: 'condition',
        field: 'assigned',
        op: '=',
        value: analyticsFilters.assignee
      });
    }

    // 3. Work Item Type filter (if active)
    if (analyticsFilters.type && analyticsFilters.type !== 'all') {
      rules.push({
        kind: 'condition',
        field: 'type',
        op: '=',
        value: analyticsFilters.type
      });
    }

    const filterIR = {
      where: {
        kind: 'group',
        logic: 'AND',
        rules: rules
      }
    };

    if (typeof api !== 'undefined' && typeof api.list === 'function') {
      try {
        const items = await api.list({ filters: filterIR, order: 'changeddate_desc' });
        if (items && items.length > 0) {
          analyticsItemsCache = items;
          const storeMap = (App.state && App.state.store && App.state.store.nodes) || {};
          items.forEach(node => {
            if (node && node.id) storeMap[node.id] = node;
          });
          return items;
        }
      } catch (e) {
        console.warn("Analytics api.list execution failed, falling back to cached items:", e);
      }
    }

    if (analyticsItemsCache && analyticsItemsCache.length > 0) {
      return getAnalyticsFilteredNodes(analyticsItemsCache);
    }

    const storeNodes = Object.values((App.state && App.state.store && App.state.store.nodes) || {});
    return getAnalyticsFilteredNodes(storeNodes);
  }

  function getProjectAssignees() {
    const nodes = Object.values((App.state && App.state.store && App.state.store.nodes) || {});
    const set = new Set();
    nodes.forEach(n => {
      if (n.assigned) set.add(n.assigned);
    });
    if (Array.isArray(window.assignees)) {
      window.assignees.forEach(a => set.add(a));
    }
    return [...set].sort();
  }

  function wireAnalyticsFilterBar(container) {
    const bar = container.querySelector('#analytics_filter_toolbar');
    if (!bar) return;

    const viewsWithFilters = ['cycle_time', 'aging_wip', 'stale_items', 'blocked_time', 'cfd'];
    const shouldShow = viewsWithFilters.includes(activeView);
    bar.classList.toggle('hidden', !shouldShow);
    bar.style.display = shouldShow ? 'flex' : 'none';
    if (!shouldShow) return;

    const assigneesList = getProjectAssignees();
    const assSel = bar.querySelector('#an_sel_assignee');
    const typeSel = bar.querySelector('#an_sel_type');
    const tfSel = bar.querySelector('#an_sel_timeframe');

    if (assSel && assSel.options.length <= 1) {
      assSel.innerHTML = `<option value="all">${L('analytics.filter.allAssignees', 'All Assignees')}</option>` +
        (Array.isArray(assigneesList) ? assigneesList : []).map(a => `<option value="${htmlEsc(a)}"${analyticsFilters.assignee === a ? ' selected' : ''}>${htmlEsc(a)}</option>`).join('');
    }

    if (assSel) assSel.onchange = (e) => { analyticsFilters.assignee = e.target.value; refreshAnalyticsView(); };
    if (typeSel) typeSel.onchange = (e) => { analyticsFilters.type = e.target.value; refreshAnalyticsView(); };
    if (tfSel) tfSel.onchange = (e) => { analyticsFilters.timeframe = e.target.value; refreshAnalyticsView(); };
  }

  let lastTargetNodes = null;

  async function refreshAnalyticsView() {
    if (App.state.mode !== 'analytics') return;
    const container = document.getElementById('analytics');
    if (container) wireAnalyticsFilterBar(container);

    if (typeof loadFilterData === 'function' && (!window.stateCategories || Object.keys(window.stateCategories).length === 0)) {
      try { await loadFilterData(); } catch (_) {}
    }

    const loader = document.querySelector('#analytics .analytics-loading');
    if (loader) loader.style.display = 'flex';

    let targetNodes = await queryAnalyticsItemsForView(activeView);
    if (!targetNodes || targetNodes.length === 0) {
      targetNodes = Object.values((App.state && App.state.store && App.state.store.nodes) || {});
    }
    lastTargetNodes = targetNodes;
    const ids = targetNodes.map(n => n.id);

    if (ids.length === 0) {
      showEmptyState();
      setStatus(`0 ${L('analytics.items', 'items')}`);
      return;
    }

    setStatus(`${ids.length} ${L('analytics.items', 'items')}`);
    fetchAndRender(ids, targetNodes);
  }

  function showEmptyState() {
    const content = document.querySelector('#analytics .analytics-content');
    if (!content) return;
    content.innerHTML = `
      <div class="analytics-empty">
        <ui-icon name="bar-chart" style="font-size: 3rem; color: var(--muted); margin-bottom: 1rem; display: block; text-align: center;"></ui-icon>
        <h3>${L('analytics.empty.title', 'No items match the active filters')}</h3>
        <p>${L('analytics.empty.desc', 'Adjust your search query or quick filters in the toolbar to load data for analytics.')}</p>
      </div>
    `;
  }

  async function loadPersistentHistoryCache(ids) {
    if (!App.cache) return;
    try {
      const histMap = (await App.cache.get('history')) || {};
      const storeNodes = (App.state && App.state.store && App.state.store.nodes) || {};
      
      for (const id of ids) {
        if (revisionCache.has(id)) continue;
        const cached = histMap[id];
        const node = storeNodes[id];
        if (cached && node && cached.rev === node.rev && Array.isArray(cached.hist)) {
          revisionCache.set(id, cached.hist);
        }
      }
    } catch (_) {}
  }

  async function savePersistentHistoryCache() {
    if (!App.cache) return;
    try {
      const storeNodes = (App.state && App.state.store && App.state.store.nodes) || {};
      const objToSave = {};
      let count = 0;
      for (const [id, hist] of revisionCache.entries()) {
        if (count > 2000) break;
        const node = storeNodes[id];
        const rev = node ? node.rev : 1;
        objToSave[id] = { rev, hist: hist || [] };
        count++;
      }
      await App.cache.set('history', objToSave);
    } catch (_) {}
  }

  async function fetchAndRender(ids, targetNodes) {
    const loader = document.querySelector('#analytics .analytics-loading');
    const progressSpan = document.getElementById('analytics_progress');
    const content = document.querySelector('#analytics .analytics-content');
    if (!loader || !content) return;

    if (!currentUserDisplayName && typeof api !== 'undefined' && typeof api.me === 'function') {
      try {
        currentUserDisplayName = await api.me();
      } catch (_) {}
    }

    await loadPersistentHistoryCache(ids);

    const missingIds = ids.filter(id => !revisionCache.has(id));

    if (missingIds.length > 0) {
      cleanup();
      currentController = new AbortController();
      const myToken = ++currentRenderToken;

      loader.style.display = 'flex';
      content.style.display = 'none';
      progressSpan.textContent = `0/${missingIds.length}`;

      let loadedCount = 0;
      try {
        await api.pool(missingIds.map(id => async () => {
          if (myToken !== currentRenderToken) return;
          try {
            const hist = await api.history(id, { signal: currentController.signal });
            revisionCache.set(id, hist || []);
          } catch (err) {
            if (err.name === 'AbortError') throw err;
            revisionCache.set(id, []);
          }
          if (myToken !== currentRenderToken) return;
          loadedCount++;
          progressSpan.textContent = `${loadedCount}/${missingIds.length}`;
        }), 12);
      } catch (err) {
        if (err.name === 'AbortError' || myToken !== currentRenderToken) {
          return;
        }
      }

      if (myToken !== currentRenderToken) return;
      savePersistentHistoryCache();
      loader.style.display = 'none';
      content.style.display = 'block';
    } else {
      loader.style.display = 'none';
      content.style.display = 'block';
    }

    drawActiveView(targetNodes);
  }

  // --- Helper Date & State Functions ---

  function daysBetween(d1, d2) {
    const t1 = new Date(d1).getTime();
    const t2 = new Date(d2).getTime();
    if (isNaN(t1) || isNaN(t2)) return 0;
    const diff = (t2 - t1) / (1000 * 60 * 60 * 24);
    return Math.max(0, Math.round(diff * 10) / 10);
  }

  function drawActiveView(overrideNodes) {
    const container = document.getElementById('analytics');
    if (container) wireAnalyticsFilterBar(container);

    const content = document.querySelector('#analytics .analytics-content');
    if (!content) return;

    // Apply smooth fade/slide-in transition using CSS transition classes
    content.className = 'analytics-content view-transition';

    const sourceNodes = overrideNodes || lastTargetNodes;
    const allItems = (sourceNodes && sourceNodes.length > 0)
      ? sourceNodes
      : Object.values((App.state && App.state.store && App.state.store.nodes) || {});

    const items = getAnalyticsFilteredNodes(allItems);

    if (activeView === 'dashboard') {
      renderDashboard(content, allItems);
    } else if (activeView === 'profile') {
      renderProfile(content, allItems);
    } else if (activeView === 'cycle_time') {
      renderCycleLeadTime(content, items);
    } else if (activeView === 'cfd') {
      renderCFDSummary(content, items);
    } else if (activeView === 'aging_wip') {
      renderAgingWIP(content, items);
    } else if (activeView === 'stale_items') {
      renderStaleItems(content, items);
    } else if (activeView === 'blocked_time') {
      renderBlockedTime(content, items);
    } else if (activeView === 'leaderboard') {
      renderLeaderboard(content, allItems);
    } else if (activeView === 'burndown') {
      renderBurndown(content, allItems);
    } else if (activeView === 'velocity') {
      renderVelocity(content, allItems);
    } else if (activeView === 'throughput') {
      renderThroughput(content, allItems);
    }
  }

  function animateCountUp(element, endValue, duration, suffix = '') {
    if (!element) return;
    const start = 0;
    const startTime = performance.now();
    
    function update(currentTime) {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const val = start + progress * (endValue - start);
      
      if (Number.isInteger(endValue)) {
        element.textContent = Math.floor(val) + suffix;
      } else {
        element.textContent = val.toFixed(1) + suffix;
      }
      
      if (progress < 1) {
        requestAnimationFrame(update);
      } else {
        element.textContent = endValue + suffix;
      }
    }
    requestAnimationFrame(update);
  }

  function getItemPoints(item) {
    if (!item) return 0;
    let val = item.storypoints || item.estimate || item.storyPoints || item.effort || item.size || item.points;
    if ((val === undefined || val === null || val === 0) && item.fields) {
      val = item.fields['Microsoft.VSTS.Scheduling.StoryPoints'] ||
            item.fields['Microsoft.VSTS.Scheduling.Effort'] ||
            item.fields['Microsoft.VSTS.Scheduling.Size'] ||
            item.fields['Custom.StoryPoints'];
    }
    const n = Number(val);
    return isNaN(n) ? 0 : n;
  }

  function getItemHist(id) {
    if (!id) return [];
    if (revisionCache.has(id)) return revisionCache.get(id) || [];
    const rawId = App.backend ? App.backend.rawNid(id) : String(id).replace(/^[a-z]+:/, '');
    if (revisionCache.has(rawId)) return revisionCache.get(rawId) || [];
    const gid = App.backend ? App.backend.gid(id) : ('ado:' + rawId);
    if (revisionCache.has(gid)) return revisionCache.get(gid) || [];
    return [];
  }

  function buildGithubCalendarHTML(items) {
    const heatMapDates = {};
    for (const it of items) {
      if (!isCompletedState(it.state)) continue;
      const hist = getItemHist(it.id);
      let completionDate = null;
      for (let i = hist.length - 1; i >= 0; i--) {
        const update = hist[i];
        const stateChange = (update.changes || []).find(c => c.field === 'State');
        if (stateChange && isCompletedState(stateChange.to)) {
          completionDate = update.date;
          break;
        }
      }
      if (!completionDate) completionDate = it.changeddate || it.createddate;
      if (completionDate) {
        const dStr = new Date(completionDate).toISOString().slice(0, 10);
        heatMapDates[dStr] = (heatMapDates[dStr] || 0) + 1;
      }
    }

    const langCode = (window.i18n && typeof window.i18n.getLang === 'function')
      ? window.i18n.getLang()
      : (App.prefs ? App.prefs.get('lang') || 'ru' : 'ru');

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // ISO Day of week: 0 = Mon, 1 = Tue, 2 = Wed, 3 = Thu, 4 = Fri, 5 = Sat, 6 = Sun
    const isoDay = (today.getDay() + 6) % 7;
    const numWeeks = 52;
    const totalDays = numWeeks * 7 + isoDay;

    const startDate = new Date(today);
    startDate.setDate(today.getDate() - totalDays);

    const weeks = [];
    const monthLabels = [];
    let lastMonth = -1;

    let curDate = new Date(startDate);
    let totalCompletedYear = 0;

    for (let w = 0; w < numWeeks + 1; w++) {
      const weekDays = [];
      for (let d = 0; d < 7; d++) {
        if (curDate > today) {
          weekDays.push(null);
        } else {
          const dStr = curDate.toISOString().slice(0, 10);
          const count = heatMapDates[dStr] || 0;
          totalCompletedYear += count;
          let level = 0;
          if (count > 0) {
            if (count === 1) level = 1;
            else if (count <= 3) level = 2;
            else if (count <= 5) level = 3;
            else level = 4;
          }

          const month = curDate.getMonth();
          if (month !== lastMonth && d === 0) {
            const mName = curDate.toLocaleString(langCode, { month: 'short' });
            monthLabels.push({ name: mName, col: w });
            lastMonth = month;
          }

          weekDays.push({
            date: dStr,
            dateObj: new Date(curDate),
            count,
            level
          });
        }
        curDate.setDate(curDate.getDate() + 1);
      }
      weeks.push(weekDays);
    }

    const monthHeaderHTML = monthLabels.map(m => {
      return `<span class="gh-month-label" style="grid-column: ${m.col + 2}">${htmlEsc(m.name)}</span>`;
    }).join('');

    const dayLabelsHTML = `
      <span class="gh-day-label" style="grid-row: 2">${L('analytics.day.mon', 'Mon')}</span>
      <span class="gh-day-label" style="grid-row: 4">${L('analytics.day.wed', 'Wed')}</span>
      <span class="gh-day-label" style="grid-row: 6">${L('analytics.day.fri', 'Fri')}</span>
    `;

    let cellsHTML = '';
    weeks.forEach((week, colIdx) => {
      week.forEach((day, rowIdx) => {
        if (!day) return;
        const formattedDate = day.dateObj.toLocaleDateString(langCode, { year: 'numeric', month: 'long', day: 'numeric' });
        const titleText = `${day.count} ${L('analytics.itemsCompletedOn', 'tasks completed on')} ${formattedDate}`;
        cellsHTML += `<div class="heatmap-day lvl-${day.level}" style="grid-column: ${colIdx + 2}; grid-row: ${rowIdx + 2}" title="${htmlEsc(titleText)}"></div>`;
      });
    });

    return `
      <div class="gh-calendar-card">
        <div class="gh-calendar-header">
          <div class="analytics-sidebar-title" style="padding-left:0; margin:0; font-size:0.875rem;">${L('analytics.dashboard.activity', 'Completions Calendar')}</div>
          <span class="gh-calendar-summary">${totalCompletedYear} ${L('analytics.dashboard.tasksCompletedInYear', 'tasks completed in the last year')}</span>
        </div>
        <div class="gh-calendar-wrapper">
          <div class="gh-calendar-grid">
            ${monthHeaderHTML}
            ${dayLabelsHTML}
            ${cellsHTML}
          </div>
        </div>
        <div class="gh-calendar-footer">
          <div class="stacked-bar-legend">
            <span class="legend-text">${L('analytics.dashboard.less', 'Less')}</span>
            <span class="legend-dot lvl-0" style="background:var(--line); width:10px; height:10px; border-radius:2px;"></span>
            <span class="legend-dot lvl-1" style="background:rgba(47, 111, 237, 0.25); width:10px; height:10px; border-radius:2px;"></span>
            <span class="legend-dot lvl-2" style="background:rgba(47, 111, 237, 0.5); width:10px; height:10px; border-radius:2px;"></span>
            <span class="legend-dot lvl-3" style="background:rgba(47, 111, 237, 0.75); width:10px; height:10px; border-radius:2px;"></span>
            <span class="legend-dot lvl-4" style="background:var(--accent); width:10px; height:10px; border-radius:2px;"></span>
            <span class="legend-text">${L('analytics.dashboard.more', 'More')}</span>
          </div>
        </div>
      </div>
    `;
  }

  async function renderDashboard(container, items) {
    let totalItems = items.length;
    let activeItems = 0;
    let blockedItems = 0;
    let staleItems = 0;
    let itemsOver7d = 0;
    let committedPts = 0;
    let deliveredPts = 0;
    
    const now = new Date();
    
    for (const item of items) {
      const isCompleted = isCompletedState(item.state);
      const isInProgress = isInProgressState(item.state);
      const sp = getItemPoints(item);
      
      committedPts += sp;
      if (isCompleted) {
        deliveredPts += sp;
      }
      if (isInProgress) {
        activeItems++;
      }
      
      const tagStr = item.tags || '';
      const titleStr = item.title || '';
      if (tagStr.toLowerCase().includes('blocked') || titleStr.toLowerCase().includes('[blocked]')) {
        blockedItems++;
      }
      
      const lastChanged = item.changeddate || item.createddate || now.toISOString();
      const days = daysBetween(lastChanged, now.toISOString());
      if (!isCompleted && days >= 7) {
        staleItems++;
      }
      
      if (isInProgress) {
        const hist = getItemHist(item.id);
        let transitionDate = null;
        for (const update of hist) {
          const stateChange = (update.changes || []).find(c => c.field === 'State');
          if (stateChange && stateChange.to === item.state) {
            transitionDate = update.date;
            break;
          }
        }
        if (!transitionDate) transitionDate = item.changeddate || item.createddate || now.toISOString();
        const age = daysBetween(transitionDate, now.toISOString());
        if (age > 7) {
          itemsOver7d++;
        }
      }
    }
    
    const sprintHealth = AdoLib.calculateSprintHealth(deliveredPts, committedPts, activeItems, itemsOver7d, blockedItems, staleItems, totalItems);
    
    let healthClass = 'health-good';
    if (sprintHealth < 50) healthClass = 'health-critical';
    else if (sprintHealth < 80) healthClass = 'health-warn';

    const radius = 36;
    const circ = 2 * Math.PI * radius;
    const strokeDash = `${(sprintHealth / 100) * circ} ${circ}`;

    const velValues = [15, 24, 18, 30, deliveredPts];
    const rateValues = [70, 85, 60, 90, committedPts > 0 ? Math.round((deliveredPts / committedPts) * 100) : 100];
    
    const completedCycles = [];
    for (const item of items) {
      if (!isCompletedState(item.state)) continue;
      const hist = getItemHist(item.id);
      const chronological = hist.slice().reverse();
      const createdDate = item.createddate || (chronological[0] ? chronological[0].date : null);
      if (!createdDate) continue;
      
      let completionDate = null;
      for (let i = hist.length - 1; i >= 0; i--) {
        const update = hist[i];
        const stateChange = (update.changes || []).find(c => c.field === 'State');
        if (stateChange && isCompletedState(stateChange.to)) {
          completionDate = update.date;
          break;
        }
      }
      if (!completionDate) completionDate = item.changeddate || createdDate;
      
      let startDate = null;
      for (const update of chronological) {
        const stateChange = (update.changes || []).find(c => c.field === 'State');
        if (stateChange && isInProgressState(stateChange.to)) {
          startDate = update.date;
          break;
        }
      }
      if (!startDate) startDate = createdDate;
      completedCycles.push(daysBetween(startDate, completionDate));
    }
    
    const avgCycle = completedCycles.length ? (completedCycles.reduce((s, x) => s + x, 0) / completedCycles.length).toFixed(1) : '0.0';
    const cycleValues = completedCycles.length ? completedCycles.slice(-5) : [0, 0, 0, 0, 0];

    const velSpark = AdoLib.generateSparklinePoints(velValues, 120, 30);
    const rateSpark = AdoLib.generateSparklinePoints(rateValues, 120, 30);
    const cycleSpark = AdoLib.generateSparklinePoints(cycleValues, 120, 30);

    const heatMapDates = {};
    for (const it of items) {
      if (!isCompletedState(it.state)) continue;
      const hist = getItemHist(it.id);
      let completionDate = null;
      for (let i = hist.length - 1; i >= 0; i--) {
        const update = hist[i];
        const stateChange = (update.changes || []).find(c => c.field === 'State');
        if (stateChange && isCompletedState(stateChange.to)) {
          completionDate = update.date;
          break;
        }
      }
      if (!completionDate) completionDate = it.changeddate || it.createddate;
      if (completionDate) {
        const dStr = new Date(completionDate).toISOString().slice(0, 10);
        heatMapDates[dStr] = (heatMapDates[dStr] || 0) + 1;
      }
    }
    
    const heatmapGridItems = [];
    for (let i = 83; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dStr = d.toISOString().slice(0, 10);
      const count = heatMapDates[dStr] || 0;
      let level = 0;
      if (count > 0) {
        if (count <= 1) level = 1;
        else if (count <= 2) level = 2;
        else if (count <= 4) level = 3;
        else level = 4;
      }
      heatmapGridItems.push({ date: dStr, count, level });
    }

    const completionsMap = new Map();
    for (const item of items) {
      if (!isCompletedState(item.state)) continue;
      const name = item.assigned || 'Unassigned';
      if (name === 'Unassigned') continue;
      completionsMap.set(name, (completionsMap.get(name) || 0) + 1);
    }
    const spotlightList = Array.from(completionsMap.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);

    const meName = currentUserDisplayName || 'You';
    const playerStats = AdoLib.calculatePlayerStats(items, {}, meName);
    playerStats.completionDates = [];
    for (const it of items) {
      if (it.assigned !== meName || !isCompletedState(it.state)) continue;
      const hist = revisionCache.get(it.id) || [];
      let completionDate = null;
      for (let i = hist.length - 1; i >= 0; i--) {
        const update = hist[i];
        const stateChange = (update.changes || []).find(c => c.field === 'State');
        if (stateChange && isCompletedState(stateChange.to)) {
          completionDate = update.date;
          break;
        }
      }
      if (!completionDate) completionDate = it.changeddate || it.createddate;
      if (completionDate) playerStats.completionDates.push(new Date(completionDate).toISOString().slice(0, 10));
    }
    const achievements = AdoLib.calculateAchievements(playerStats);
    const unlockedAchievements = achievements.filter(a => a.unlocked);

    let sprints = [];
    try {
      if (typeof getIterations === 'function') {
        sprints = await getIterations();
      }
    } catch (_) {}
    const datedSprints = sprints.filter(s => s.start && s.finish);
    const activeSprint = datedSprints.find(isCurrentSprint) || datedSprints[datedSprints.length - 1];
    let miniBurndownSVG = '';
    if (activeSprint) {
      const start = new Date(activeSprint.start);
      const end = new Date(activeSprint.finish);
      const sprintDates = [];
      let cur = new Date(start);
      while (cur <= end) {
        sprintDates.push(cur.toISOString().slice(0, 10));
        cur.setDate(cur.getDate() + 1);
        if (sprintDates.length > 45) break;
      }
      const historyDict = {};
      items.forEach(it => {
        historyDict[it.id] = revisionCache.get(it.id) || [];
      });
      const dataPoints = AdoLib.generateBurndownData(items, historyDict, sprintDates, activeSprint.path);
      let yMax = 0;
      dataPoints.forEach(p => {
        if (p.remainingPoints > yMax) yMax = p.remainingPoints;
      });
      if (yMax <= 0) yMax = 10;
      
      const svgW = 200;
      const svgH = 80;
      const scaleX = (idx) => (idx / (dataPoints.length - 1)) * svgW;
      const scaleY = (val) => svgH - (val / yMax) * svgH;
      
      let pathD = '';
      dataPoints.forEach((p, idx) => {
        const x = scaleX(idx);
        const y = scaleY(p.remainingPoints);
        if (idx === 0) pathD = `M ${x} ${y}`;
        else {
          pathD += ` L ${x} ${scaleY(dataPoints[idx-1].remainingPoints)} L ${x} ${y}`;
        }
      });
      miniBurndownSVG = `
        <svg viewBox="0 0 ${svgW} ${svgH}" width="100%" height="${svgH}" style="display:block; overflow:visible;">
          <path d="${pathD}" fill="none" stroke="var(--accent)" stroke-width="2" />
        </svg>
      `;
    }

    const raidBoss = AdoLib.calculateRaidBoss ? AdoLib.calculateRaidBoss(items) : { bossName: 'Sprint Titan', totalHp: 10, currentHp: 5, damageDealt: 5, criticalHits: 0, hpPercent: 50, isDefeated: false };

    container.innerHTML = `
      <div class="analytics-header">
        <h2>${L('analytics.dashboard.title', 'Sprint Dashboard')}</h2>
        <p class="analytics-desc">${L('analytics.dashboard.desc', 'Real-time overview of sprint progress, flow metrics, and achievements.')}</p>
      </div>

      <!-- Sprint Raid Boss Widget -->
      <div class="analytics-section raid-boss-card" style="background: linear-gradient(135deg, rgba(230, 81, 0, 0.1), rgba(245, 124, 0, 0.05)); border: 1px solid rgba(245, 124, 0, 0.3); border-radius: 0.769rem; padding: 1.2rem; margin-bottom: 1.5rem;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.8rem;">
          <div style="display: flex; align-items: center; gap: 0.615rem;">
            <span style="font-size: 1.8rem;">${raidBoss.isDefeated ? '🏆' : '👾'}</span>
            <div>
              <h3 style="margin: 0; font-size: 1.154rem; color: var(--txt);">${htmlEsc(L('analytics.raidboss.titan', raidBoss.bossName))} ${raidBoss.isDefeated ? L('analytics.raidboss.defeated', '(Defeated!)') : ''}</h3>
              <span style="font-size: 0.769rem; color: var(--muted);">${L('analytics.raidboss.title', 'Sprint Raid Boss')} • ${L('analytics.raidboss.damage', 'Damage Dealt')}: ${raidBoss.damageDealt} SP • ${L('analytics.raidboss.crits', 'Crits')}: ${raidBoss.criticalHits}</span>
            </div>
          </div>
          <div style="font-size: 1.2rem; font-weight: 700; color: ${raidBoss.isDefeated ? 'var(--success)' : 'var(--danger)'};">
            ${raidBoss.currentHp} / ${raidBoss.totalHp} HP
          </div>
        </div>
        <div style="height: 12px; background: var(--line); border-radius: 6px; overflow: hidden;">
          <div style="height: 100%; width: ${raidBoss.hpPercent}%; background: linear-gradient(90deg, #ff416c, #ff4b2b); transition: width 0.5s ease;"></div>
        </div>
      </div>

      const completionPct = committedPts > 0 ? Math.round((deliveredPts / committedPts) * 100) : 100;
    
      let rankBadgeClass = 'b-rank';
      let rankBadgeLabel = 'B-RANK';
      if (sprintHealth >= 85) { rankBadgeClass = 's-rank'; rankBadgeLabel = 'S-RANK ⭐'; }
      else if (sprintHealth >= 70) { rankBadgeClass = 'a-rank'; rankBadgeLabel = 'A-RANK'; }
      else if (sprintHealth < 50) { rankBadgeClass = 'danger-rank'; rankBadgeLabel = 'DANGER ⚠️'; }

      <div class="dashboard-grid">
        <!-- Metric Card 1: Sprint Health (Party HP) -->
        <div class="metric-card gamified-card dashboard-col-3">
          <div class="gamified-card-header">
            <span class="metric-label">${L('analytics.dashboard.partyVitality', 'Party Vitality')}</span>
            <span class="gamified-rank-badge ${rankBadgeClass}">${rankBadgeLabel}</span>
          </div>
          <div class="health-ring-wrapper" style="margin: 0.5rem auto;">
            <svg class="health-ring-svg" width="90" height="90" viewBox="0 0 100 100">
              <circle class="health-ring-bg" cx="50" cy="50" r="36" />
              <circle class="health-ring-fill ${healthClass}" cx="50" cy="50" r="36" stroke-dasharray="${strokeDash}" />
            </svg>
            <div class="health-ring-text">
              <span class="health-ring-score" id="dash_health_val">${sprintHealth}%</span>
            </div>
          </div>
          <div class="gamified-subtext">
            <span>${L('analytics.dashboard.debuffs', 'Debuffs')}: ${blockedItems} ${L('analytics.blocked.metric', 'Blocked')}</span>
            <span>${staleItems} Stale</span>
          </div>
        </div>

        <!-- Metric Card 2: Raid Power (Velocity / EXP) -->
        <div class="metric-card gamified-card dashboard-col-3">
          <div class="gamified-card-header">
            <span class="metric-label">${L('analytics.dashboard.raidPower', 'Raid Power & EXP')}</span>
            <span class="gamified-rank-badge a-rank">⚡ EXP BOOST</span>
          </div>
          <div class="metric-value" id="dash_velocity_val" style="display:flex; align-items:baseline; gap:0.25rem;">
            ${deliveredPts} <span style="font-size:0.85rem; color:var(--muted); font-weight:normal;">/ ${committedPts} EXP</span>
          </div>
          <div class="gamified-exp-bar-wrapper">
            <div class="gamified-exp-bar-bg">
              <div class="gamified-exp-bar-fill" style="width: ${committedPts > 0 ? Math.min(100, Math.round((deliveredPts/committedPts)*100)) : 0}%;"></div>
            </div>
          </div>
          <div class="metric-sparkline-container" style="height: 1.8rem; margin-top: 0.5rem;">
            <svg viewBox="0 0 120 30" width="100%" height="100%">
              <path class="metric-sparkline-path" d="M ${velSpark}" />
            </svg>
          </div>
        </div>

        <!-- Metric Card 3: Quest Clearance -->
        <div class="metric-card gamified-card dashboard-col-3">
          <div class="gamified-card-header">
            <span class="metric-label">${L('analytics.dashboard.questClearance', 'Quest Clearance')}</span>
            <span class="gamified-rank-badge s-rank">⚔️ ${completionPct >= 100 ? 'CLEARED' : 'IN RAID'}</span>
          </div>
          <div class="metric-value" id="dash_completion_val">
            ${completionPct}%
          </div>
          <div class="gamified-exp-bar-wrapper">
            <div class="gamified-exp-bar-bg">
              <div class="gamified-exp-bar-fill" style="width: ${completionPct}%; background: linear-gradient(90deg, #ffd700, #ff8c00);"></div>
            </div>
          </div>
          <div class="metric-sparkline-container" style="height: 1.8rem; margin-top: 0.5rem;">
            <svg viewBox="0 0 120 30" width="100%" height="100%">
              <path class="metric-sparkline-path" d="M ${rateSpark}" style="stroke: #ffd700;" />
            </svg>
          </div>
        </div>

        <!-- Metric Card 4: Agility & Speedrun -->
        <div class="metric-card gamified-card dashboard-col-3">
          <div class="gamified-card-header">
            <span class="metric-label">${L('analytics.dashboard.agilityPace', 'Agility & Speedrun')}</span>
            <span class="gamified-rank-badge b-rank">⏱️ ${Number(avgCycle) <= 5 ? 'SWIFT ⚡' : 'NORMAL'}</span>
          </div>
          <div class="metric-value" id="dash_cycle_val">
            ${avgCycle}<span style="font-size: 1.2rem; font-weight:600;">d</span>
          </div>
          <div class="gamified-subtext">
            <span>${L('analytics.dashboard.avgResolution', 'Average days to resolve tasks')}</span>
          </div>
          <div class="metric-sparkline-container" style="height: 1.8rem; margin-top: 0.5rem;">
            <svg viewBox="0 0 120 30" width="100%" height="100%">
              <path class="metric-sparkline-path" d="M ${cycleSpark}" style="stroke: #2ecc71;" />
            </svg>
          </div>
        </div>

        <!-- Activity Heatmap (GitHub Style Calendar) -->
        <div class="metric-card dashboard-col-12">
          ${buildGithubCalendarHTML(items)}
        </div>

        <!-- Team Spotlight (Top 3) -->
        <div class="metric-card dashboard-col-6">
          <div class="analytics-sidebar-title" style="padding-left:0; margin-bottom:0.75rem; font-size:0.875rem;">${L('analytics.dashboard.spotlight', 'Team Spotlight')}</div>
          <div style="display:flex; flex-direction:column; gap:0.75rem;">
            ${spotlightList.length === 0 ? `
              <div class="analytics-empty-section">${L('analytics.dashboard.noSpotlight', 'No active contributors this sprint.')}</div>
            ` : spotlightList.map((s, idx) => `
              <div class="spotlight-card">
                <span class="spotlight-rank">#${idx + 1}</span>
                <div class="spotlight-avatar">${s.name.slice(0, 2).toUpperCase()}</div>
                <div class="spotlight-details">
                  <div class="spotlight-name">${htmlEsc(s.name)}</div>
                  <div class="spotlight-value">${s.count} ${L('analytics.dashboard.tasksCompleted', 'tasks completed')}</div>
                </div>
              </div>
            `).join('')}
          </div>
        </div>

        <!-- Achievements Horizontal Feed -->
        <div class="metric-card dashboard-col-6">
          <div class="analytics-sidebar-title" style="padding-left:0; margin-bottom:0.75rem; font-size:0.875rem;">${L('analytics.dashboard.myAchievements', 'My Achievements')}</div>
          <div class="achievement-feed">
            ${unlockedAchievements.length === 0 ? `
              <div class="analytics-empty-section">${L('analytics.dashboard.noAchievements', 'No achievements unlocked yet. Keep delivering!')}</div>
            ` : unlockedAchievements.map(a => `
              <div class="feed-achievement-item" title="${htmlEsc(a.desc)}">
                <span>${a.emoji}</span>
                <strong>${htmlEsc(a.name)}</strong>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    `;

    animateCountUp(document.getElementById('dash_health_val'), sprintHealth, 1000, '%');
    animateCountUp(document.getElementById('dash_velocity_val'), deliveredPts, 1000);
    animateCountUp(document.getElementById('dash_completion_val'), committedPts > 0 ? Math.round((deliveredPts / committedPts) * 100) : 100, 1000, '%');
    animateCountUp(document.getElementById('dash_cycle_val'), parseFloat(avgCycle), 1000, 'd');
  }

  function renderProfile(container, items) {
    const meName = currentUserDisplayName || 'You';
    const playerStats = AdoLib.calculatePlayerStats(items, {}, meName);
    playerStats.completionDates = [];
    let completedBugs = 0;
    for (const it of items) {
      if (it.assigned !== meName || !isCompletedState(it.state)) continue;
      const hist = revisionCache.get(it.id) || [];
      let completionDate = null;
      for (let i = hist.length - 1; i >= 0; i--) {
        const update = hist[i];
        const stateChange = (update.changes || []).find(c => c.field === 'State');
        if (stateChange && isCompletedState(stateChange.to)) {
          completionDate = update.date;
          break;
        }
      }
      if (!completionDate) completionDate = it.changeddate || it.createddate;
      if (completionDate) playerStats.completionDates.push(new Date(completionDate).toISOString().slice(0, 10));
      if ((it.type || '').toLowerCase() === 'bug') completedBugs++;
    }
    playerStats.bugCount = completedBugs;

    const xpLevel = AdoLib.calculateXPAndLevel(playerStats);
    const achievements = AdoLib.calculateAchievements(playerStats);
    
    const longestStr = AdoLib._longestStreak(playerStats.completionDates);
    const currentStr = AdoLib._currentStreak(playerStats.completionDates);
    const flowCombo = AdoLib.calculateFlowCombo ? AdoLib.calculateFlowCombo(playerStats.completionDates) : { multiplier: 1.0, label: 'No Active Combo' };

    const taskCount = playerStats.completedTasksCount;
    const spPoints = playerStats.completedStoryPoints;
    const avgCycle = playerStats.cycleTimes.length ? (playerStats.cycleTimes.reduce((s, x) => s + x, 0) / playerStats.cycleTimes.length).toFixed(1) : '0.0';

    container.innerHTML = `
      <div class="analytics-header">
        <h2>${L('analytics.profile.title', 'My Profile')}</h2>
        <p class="analytics-desc">${L('analytics.profile.desc', 'Track your gamified achievements, task completion streaks, and personal velocity stats.')}</p>
      </div>

      <!-- Player Card -->
      <div class="player-card">
        <div class="player-avatar-large">${meName.slice(0, 2).toUpperCase()}</div>
        <div class="player-details">
          <div class="player-name-title">
            ${htmlEsc(meName)}
            ${flowCombo.multiplier > 1.0 ? `<span class="flow-combo-badge" style="background: linear-gradient(135deg, #f12711, #f5af19); color: #fff; padding: 2px 8px; border-radius: 10px; font-size: 0.769rem; font-weight: 700; margin-left: 8px;">🔥 ${htmlEsc(flowCombo.label)}</span>` : ''}
          </div>
          <span class="player-level-badge">Level ${xpLevel.level}</span>
          <div class="xp-progress-container">
            <div class="xp-progress-bar">
              <div class="xp-progress-fill" style="width: ${xpLevel.progressPercent}%"></div>
            </div>
            <span class="xp-progress-text">${xpLevel.xpInLevel} / ${xpLevel.xpNeededForNextLevel} XP</span>
          </div>
        </div>
      </div>

      <!-- Streak & Metric Cards -->
      <div class="analytics-metrics-grid">
        <div class="metric-card">
          <div class="metric-value" id="profile_tasks_val">${taskCount}</div>
          <div class="metric-label">${L('analytics.profile.tasks', 'Completed Tasks')}</div>
        </div>
        <div class="metric-card">
          <div class="metric-value" id="profile_points_val">${spPoints}</div>
          <div class="metric-label">${L('analytics.profile.points', 'Story Points')}</div>
        </div>
        <div class="metric-card">
          <div class="metric-value" id="profile_streak_val">${currentStr}d</div>
          <div class="metric-label">${L('analytics.profile.currentStreak', 'Current Streak')} (Max ${longestStr}d)</div>
        </div>
        <div class="metric-card">
          <div class="metric-value" id="profile_cycle_val">${avgCycle}d</div>
          <div class="metric-label">${L('analytics.profile.cycle', 'Avg Cycle Time')}</div>
        </div>
      </div>

      <!-- Achievements Grid -->
      <div class="analytics-section">
        <h3>${L('analytics.profile.achievements', 'Achievements')}</h3>
        <div class="achievements-grid">
          ${achievements.map(a => `
            <div class="achievement-card ${a.unlocked ? '' : 'locked'}" title="${htmlEsc(a.desc)}">
              <div class="achievement-emoji-container">
                ${a.emoji}
              </div>
              <div class="achievement-info">
                <div class="achievement-name">${htmlEsc(a.name)}</div>
                <div class="achievement-desc">${htmlEsc(a.desc)}</div>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;

    animateCountUp(document.getElementById('profile_tasks_val'), taskCount, 1000);
    animateCountUp(document.getElementById('profile_points_val'), spPoints, 1000);
    animateCountUp(document.getElementById('profile_streak_val'), currentStr, 1000, 'd');
    animateCountUp(document.getElementById('profile_cycle_val'), parseFloat(avgCycle), 1000, 'd');
  }

  // --- 1. Cycle & Lead Time View ---
  function renderCycleLeadTime(container, items) {
    const completed = [];
    items.forEach(item => {
      if (!isCompletedState(item.state)) return;
      const history = revisionCache.get(item.id) || [];
      const chronological = history.slice().reverse();

      // Creation date from item metadata or first update
      const createdDate = item.createdDate || item.createddate || (chronological[0] ? chronological[0].date : null);
      if (!createdDate) return;

      // Find completion date: last transition to closed/done state
      let completionDate = null;
      for (let i = history.length - 1; i >= 0; i--) {
        const update = history[i];
        const stateChange = (update.changes || []).find(c => c.field === 'State');
        if (stateChange && isCompletedState(stateChange.to)) {
          completionDate = update.date;
          break;
        }
      }
      if (!completionDate) completionDate = item.changedDate || item.changeddate || createdDate;

      // Find start date: first transition to active/in-progress state
      let startDate = null;
      for (const update of chronological) {
        const stateChange = (update.changes || []).find(c => c.field === 'State');
        if (stateChange && isInProgressState(stateChange.to)) {
          startDate = update.date;
          break;
        }
      }
      if (!startDate) startDate = createdDate;

      const lead = daysBetween(createdDate, completionDate);
      const cycle = daysBetween(startDate, completionDate);

      completed.push({
        id: item.id,
        title: item.title,
        type: item.type,
        state: item.state,
        lead,
        cycle
      });
    });

    const avgLead = completed.length ? (completed.reduce((sum, x) => sum + x.lead, 0) / completed.length).toFixed(1) : '0.0';
    const avgCycle = completed.length ? (completed.reduce((sum, x) => sum + x.cycle, 0) / completed.length).toFixed(1) : '0.0';

    container.innerHTML = `
      <div class="analytics-header">
        <h2>${L('analytics.cycle.title', 'Cycle & Lead Time')}</h2>
        <p class="analytics-desc">${L('analytics.cycle.desc', 'Measure the time tasks spend in your development pipeline. Lead Time spans from creation to completion; Cycle Time measures from active start to completion.')}</p>
      </div>

      <div class="analytics-metrics-grid">
        <div class="metric-card">
          <div class="metric-value">${avgLead}d</div>
          <div class="metric-label">${L('analytics.cycle.avgLead', 'Avg Lead Time')}</div>
        </div>
        <div class="metric-card">
          <div class="metric-value">${avgCycle}d</div>
          <div class="metric-label">${L('analytics.cycle.avgCycle', 'Avg Cycle Time')}</div>
        </div>
        <div class="metric-card">
          <div class="metric-value">${completed.length}</div>
          <div class="metric-label">${L('analytics.cycle.completed', 'Completed Items')}</div>
        </div>
      </div>

      <div class="analytics-section">
        <h3>${L('analytics.cycle.log', 'Completed Items Log')}</h3>
        ${completed.length === 0 ? `
          <div class="analytics-empty-section">${L('analytics.cycle.empty', 'No completed items found in the current filtered set.')}</div>
        ` : `
          <div class="table-container">
            <table class="analytics-table">
              <thead>
                <tr>
                  <th>${L('analytics.table.id', 'ID')}</th>
                  <th>${L('analytics.table.type', 'Type')}</th>
                  <th>${L('analytics.table.title', 'Title')}</th>
                  <th>${L('analytics.table.lead', 'Lead Time')}</th>
                  <th>${L('analytics.table.cycle', 'Cycle Time')}</th>
                </tr>
              </thead>
              <tbody>
                ${completed.map(x => `
                  <tr onclick="App.sidePanel && App.sidePanel.openItem('${x.id}')">
                    <td>#${App.backend ? App.backend.nid(x.id) : x.id}</td>
                    <td><span class="wi-type">${x.type}</span></td>
                    <td class="table-title">${htmlEsc(x.title)}</td>
                    <td><strong>${x.lead}d</strong></td>
                    <td><strong>${x.cycle}d</strong></td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        `}
      </div>
    `;
  }

  // --- 2. CFD Summary View ---
  function renderCFDSummary(container, items) {
    const counts = {};
    items.forEach(item => {
      counts[item.state] = (counts[item.state] || 0) + 1;
    });

    const statesList = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
    const total = items.length;

    // Define colors for visual bar
    const colors = ['#2f6fed', '#2ebb4e', '#e0a13c', '#9b59b6', '#e74c3c', '#7f8c8d'];

    const barSegments = statesList.map((state, idx) => {
      const pct = ((counts[state] / total) * 100).toFixed(1);
      const color = colors[idx % colors.length];
      return `<div style="width: ${pct}%; background: ${color};" title="${state}: ${counts[state]} (${pct}%)"></div>`;
    }).join('');

    container.innerHTML = `
      <div class="analytics-header">
        <h2>${L('analytics.cfd.title', 'Cumulative Flow (CFD) Summary')}</h2>
        <p class="analytics-desc">${L('analytics.cfd.desc', 'Track task volumes by state to observe workflow stability, flow velocity, and bottleneck patterns.')}</p>
      </div>

      <div class="analytics-section">
        <h3>${L('analytics.cfd.dist', 'State Distribution')}</h3>
        <div class="stacked-bar-container">
          <div class="stacked-bar">${barSegments}</div>
        </div>
        <div class="stacked-bar-legend">
          ${statesList.map((state, idx) => {
            const color = colors[idx % colors.length];
            return `
              <div class="legend-item">
                <span class="legend-dot" style="background: ${color}"></span>
                <span class="legend-text">${state}: <strong>${counts[state]}</strong> (${((counts[state]/total)*100).toFixed(0)}%)</span>
              </div>
            `;
          }).join('')}
        </div>
      </div>

      <div class="analytics-section">
        <h3>${L('analytics.cfd.items', 'Items by State')}</h3>
        <div class="table-container">
          <table class="analytics-table">
            <thead>
              <tr>
                <th>${L('analytics.table.id', 'ID')}</th>
                <th>${L('analytics.table.type', 'Type')}</th>
                <th>${L('analytics.table.title', 'Title')}</th>
                <th>${L('analytics.table.state', 'State')}</th>
                <th>${L('analytics.table.assigned', 'Assigned To')}</th>
              </tr>
            </thead>
            <tbody>
              ${items.map(x => `
                <tr onclick="App.sidePanel && App.sidePanel.openItem('${x.id}')">
                  <td>#${App.backend ? App.backend.nid(x.id) : x.id}</td>
                  <td><span class="wi-type">${x.type}</span></td>
                  <td class="table-title">${htmlEsc(x.title)}</td>
                  <td><span class="state-badge">${x.state}</span></td>
                  <td>${htmlEsc(x.assigned || 'Unassigned')}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  // --- 3. Aging WIP View ---
  function renderAgingWIP(container, items) {
    const active = [];
    const now = new Date().toISOString();

    items.forEach(item => {
      if (!isInProgressState(item.state)) return;
      const history = revisionCache.get(item.id) || [];

      // Find latest transition to the current state
      let transitionDate = null;
      for (const update of history) {
        const stateChange = (update.changes || []).find(c => c.field === 'State');
        if (stateChange && stateChange.to === item.state) {
          transitionDate = update.date;
          break;
        }
      }
      if (!transitionDate) transitionDate = item.changeddate || item.createddate || now;

      const age = daysBetween(transitionDate, now);
      active.push({
        id: item.id,
        title: item.title,
        type: item.type,
        state: item.state,
        assigned: item.assigned,
        age
      });
    });

    active.sort((a, b) => b.age - a.age);

    container.innerHTML = `
      <div class="analytics-header">
        <h2>${L('analytics.aging.title', 'Aging WIP (Work in Progress)')}</h2>
        <p class="analytics-desc">${L('analytics.aging.desc', 'Monitor active items to spot tasks that are taking longer than expected. Left unchecked, aging WIP slows pipeline delivery.')}</p>
      </div>

      <div class="analytics-metrics-grid">
        <div class="metric-card">
          <div class="metric-value">${active.length}</div>
          <div class="metric-label">${L('analytics.aging.active', 'Active Items')}</div>
        </div>
        <div class="metric-card">
          <div class="metric-value">
            ${active.filter(x => x.age > 7).length}
          </div>
          <div class="metric-label">${L('analytics.aging.warn', 'Aging > 7 Days')}</div>
        </div>
      </div>

      <div class="analytics-section">
        <h3>${L('analytics.aging.log', 'Active Work Item Age Log')}</h3>
        ${active.length === 0 ? `
          <div class="analytics-empty-section">${L('analytics.aging.empty', 'No active items in progress. All items are either in a backlog or completed state.')}</div>
        ` : `
          <div class="table-container">
            <table class="analytics-table">
              <thead>
                <tr>
                  <th>${L('analytics.table.id', 'ID')}</th>
                  <th>${L('analytics.table.title', 'Title')}</th>
                  <th>${L('analytics.table.state', 'State')}</th>
                  <th>${L('analytics.table.assigned', 'Assigned To')}</th>
                  <th>${L('analytics.table.age', 'Age in State')}</th>
                </tr>
              </thead>
              <tbody>
                ${active.map(x => {
                  let alertClass = '';
                  let icon = '';
                  if (x.age > 14) {
                    alertClass = 'critical-age';
                    icon = '<ui-icon name="alert-circle" style="color: var(--danger); vertical-align: text-bottom; margin-right: 4px;"></ui-icon>';
                  } else if (x.age > 7) {
                    alertClass = 'warn-age';
                    icon = '<ui-icon name="alert-triangle" style="color: var(--accent); vertical-align: text-bottom; margin-right: 4px;"></ui-icon>';
                  }
                  return `
                    <tr onclick="App.sidePanel && App.sidePanel.openItem('${x.id}')">
                      <td>#${App.backend ? App.backend.nid(x.id) : x.id}</td>
                      <td class="table-title">${htmlEsc(x.title)}</td>
                      <td><span class="state-badge">${x.state}</span></td>
                      <td>${htmlEsc(x.assigned || 'Unassigned')}</td>
                      <td class="${alertClass}">${icon}<strong>${x.age}d</strong></td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>
        `}
      </div>
    `;
  }

  // --- 4. Stale Items View ---
  function renderStaleItems(container, items) {
    const stale = [];
    const now = new Date().toISOString();

    items.forEach(item => {
      if (isCompletedState(item.state)) return;
      const lastChanged = item.changeddate || item.createddate || now;
      const days = daysBetween(lastChanged, now);

      if (days >= 7) {
        stale.push({
          id: item.id,
          title: item.title,
          type: item.type,
          state: item.state,
          assigned: item.assigned,
          lastChanged,
          days
        });
      }
    });

    stale.sort((a, b) => b.days - a.days);

    container.innerHTML = `
      <div class="analytics-header">
        <h2>${L('analytics.stale.title', 'Stale Items')}</h2>
        <p class="analytics-desc">${L('analytics.stale.desc', 'Find items in non-completed states that have not had updates, comments, or revisions in the last 7 days.')}</p>
      </div>

      <div class="analytics-metrics-grid">
        <div class="metric-card">
          <div class="metric-value">${stale.length}</div>
          <div class="metric-label">${L('analytics.stale.metric', 'Stale Items (>= 7 Days)')}</div>
        </div>
      </div>

      <div class="analytics-section">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
          <h3 style="margin: 0;">${L('analytics.stale.log', 'Stale Items Log')}</h3>
          ${stale.length > 0 ? `<button class="analytics-export-btn" id="export_stale_csv"><ui-icon name="download"></ui-icon> Export CSV</button>` : ''}
        </div>
        ${stale.length === 0 ? `
          <div class="analytics-empty-section">${L('analytics.stale.empty', 'No stale items found. All active items have been updated recently.')}</div>
        ` : `
          <div class="table-container">
            <table class="analytics-table">
              <thead>
                <tr>
                  <th>${L('analytics.table.id', 'ID')}</th>
                  <th>${L('analytics.table.title', 'Title')}</th>
                  <th>${L('analytics.table.state', 'State')}</th>
                  <th>${L('analytics.table.assigned', 'Assigned To')}</th>
                  <th>${L('analytics.table.inactive', 'Inactive For')}</th>
                </tr>
              </thead>
              <tbody>
                ${stale.map(x => `
                  <tr onclick="App.sidePanel && App.sidePanel.openItem('${x.id}')">
                    <td>#${App.backend ? App.backend.nid(x.id) : x.id}</td>
                    <td class="table-title">${htmlEsc(x.title)}</td>
                    <td><span class="state-badge">${x.state}</span></td>
                    <td>${htmlEsc(x.assigned || 'Unassigned')}</td>
                    <td><strong style="color: var(--danger);">${x.days} days</strong></td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        `}
      </div>
    `;

    const btn = container.querySelector('#export_stale_csv');
    if (btn) {
      btn.onclick = () => {
        exportToCsv('stale_items.csv', ['ID', 'Title', 'State', 'Assigned', 'Days Inactive'], stale.map(x => [App.backend ? App.backend.nid(x.id) : x.id, x.title, x.state, x.assigned || 'Unassigned', x.days]));
      };
    }
  }

  // --- 5. Blocked Time View ---
  function renderBlockedTime(container, items) {
    const blocked = [];

    items.forEach(item => {
      const tagStr = item.tags || '';
      const titleStr = item.title || '';
      const isBlocked = tagStr.toLowerCase().includes('blocked') || titleStr.toLowerCase().includes('[blocked]');

      if (isBlocked) {
        blocked.push({
          id: item.id,
          title: item.title,
          type: item.type,
          state: item.state,
          assigned: item.assigned,
          tags: tagStr
        });
      }
    });

    container.innerHTML = `
      <div class="analytics-header">
        <h2>${L('analytics.blocked.title', 'Blocked Time')}</h2>
        <p class="analytics-desc">${L('analytics.blocked.desc', 'Lists items currently marked as blocked (having "Blocked" in their tags or title prefix).')}</p>
      </div>

      <div class="analytics-metrics-grid">
        <div class="metric-card">
          <div class="metric-value">${blocked.length}</div>
          <div class="metric-label">${L('analytics.blocked.metric', 'Blocked Items')}</div>
        </div>
      </div>

      <div class="analytics-section">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
          <h3 style="margin: 0;">${L('analytics.blocked.log', 'Blocked Items Log')}</h3>
          ${blocked.length > 0 ? `<button class="analytics-export-btn" id="export_blocked_csv"><ui-icon name="download"></ui-icon> Export CSV</button>` : ''}
        </div>
        ${blocked.length === 0 ? `
          <div class="analytics-empty-section">${L('analytics.blocked.empty', 'No blocked items found in the current filtered set.')}</div>
        ` : `
          <div class="table-container">
            <table class="analytics-table">
              <thead>
                <tr>
                  <th>${L('analytics.table.id', 'ID')}</th>
                  <th>${L('analytics.table.title', 'Title')}</th>
                  <th>${L('analytics.table.state', 'State')}</th>
                  <th>${L('analytics.table.assigned', 'Assigned To')}</th>
                  <th>${L('analytics.table.tags', 'Tags')}</th>
                </tr>
              </thead>
              <tbody>
                ${blocked.map(x => `
                  <tr onclick="App.sidePanel && App.sidePanel.openItem('${x.id}')">
                    <td>#${App.backend ? App.backend.nid(x.id) : x.id}</td>
                    <td class="table-title">
                      <ui-icon name="slash" style="color: var(--danger); vertical-align: text-bottom; margin-right: 4px;"></ui-icon>
                      <strong class="critical-text">${htmlEsc(x.title)}</strong>
                    </td>
                    <td><span class="state-badge">${x.state}</span></td>
                    <td>${htmlEsc(x.assigned || 'Unassigned')}</td>
                    <td class="table-tags">${htmlEsc(x.tags)}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        `}
      </div>
    `;

    const btn = container.querySelector('#export_blocked_csv');
    if (btn) {
      btn.onclick = () => {
        exportToCsv('blocked_items.csv', ['ID', 'Title', 'State', 'Assigned', 'Tags'], blocked.map(x => [App.backend ? App.backend.nid(x.id) : x.id, x.title, x.state, x.assigned || 'Unassigned', x.tags]));
      };
    }
  }

  // --- 6. Team Arena (Leaderboards) View ---
  function renderLeaderboard(container, items) {
    const statsMap = new Map();

    items.forEach(item => {
      if (!isCompletedState(item.state)) return;
      const history = revisionCache.get(item.id) || [];
      const chronological = history.slice().reverse();

      const createdDate = item.createddate || (chronological[0] ? chronological[0].date : null);
      if (!createdDate) return;

      let completionDate = null;
      for (let i = history.length - 1; i >= 0; i--) {
        const update = history[i];
        const stateChange = (update.changes || []).find(c => c.field === 'State');
        if (stateChange && isCompletedState(stateChange.to)) {
          completionDate = update.date;
          break;
        }
      }
      if (!completionDate) completionDate = item.changeddate || createdDate;

      let startDate = null;
      for (const update of chronological) {
        const stateChange = (update.changes || []).find(c => c.field === 'State');
        if (stateChange && isInProgressState(stateChange.to)) {
          startDate = update.date;
          break;
        }
      }
      if (!startDate) startDate = createdDate;

      const cycle = daysBetween(startDate, completionDate);
      const sp = Number(item.storypoints || item.est || 0);
      const isBug = (item.type || '').toLowerCase() === 'bug';
      const assigneeName = item.assigned || 'Unassigned';

      if (assigneeName === 'Unassigned') return;

      if (!statsMap.has(assigneeName)) {
        statsMap.set(assigneeName, {
          name: assigneeName,
          tasks: 0,
          points: 0,
          bugs: 0,
          cycles: [],
          completionDates: []
        });
      }

      const st = statsMap.get(assigneeName);
      st.tasks++;
      st.points += sp;
      if (isBug) st.bugs++;
      st.cycles.push(cycle);
      st.completionDates.push(new Date(completionDate).toISOString().slice(0, 10));
    });

    const team = [];
    for (const [name, st] of statsMap.entries()) {
      const avgCycle = st.cycles.length ? (st.cycles.reduce((sum, x) => sum + x, 0) / st.cycles.length) : null;
      
      const statsObj = {
        completedTasksCount: st.tasks,
        completedStoryPoints: st.points,
        bugCount: st.bugs,
        cycleTimes: st.cycles,
        completionDates: st.completionDates
      };
      const achievements = AdoLib.calculateAchievements(statsObj);
      const unlockedEmojis = achievements.filter(a => a.unlocked).map(a => a.emoji).slice(0, 5).join(' ');

      team.push({
        name,
        tasks: st.tasks,
        points: Math.round(st.points * 10) / 10,
        bugs: st.bugs,
        avgCycle,
        achievements: unlockedEmojis || '—'
      });
    }

    if (team.length === 0) {
      container.innerHTML = `
        <div class="analytics-header">
          <h2>${L('analytics.arena.title', 'Team Arena')}</h2>
          <p class="analytics-desc">${L('analytics.arena.desc', 'Celebrate team performance with friendly competition. Toggle metrics to see who currently leads the board.')}</p>
        </div>
        <div class="analytics-empty-section">${L('analytics.arena.empty', 'Not enough completed items to build the leaderboard.')}</div>
      `;
      return;
    }

    team.sort((a, b) => {
      if (selectedArenaMetric === 'tasks') return b.tasks - a.tasks;
      if (selectedArenaMetric === 'points') return b.points - a.points;
      if (selectedArenaMetric === 'bugs') return b.bugs - a.bugs;
      if (selectedArenaMetric === 'speed') {
        if (a.avgCycle === null) return 1;
        if (b.avgCycle === null) return -1;
        return a.avgCycle - b.avgCycle;
      }
      return 0;
    });

    const first = team[0] || null;
    const second = team[1] || null;
    const third = team[2] || null;

    const valStr = (x) => {
      if (!x) return '';
      if (selectedArenaMetric === 'tasks') return `${x.tasks} ${L('analytics.arena.tasks', 'Tasks')}`;
      if (selectedArenaMetric === 'points') return `${x.points} SP`;
      if (selectedArenaMetric === 'bugs') return `${x.bugs} ${L('analytics.arena.bugs', 'Bugs')}`;
      if (selectedArenaMetric === 'speed') return x.avgCycle !== null ? `${x.avgCycle.toFixed(1)}d` : '—';
      return '';
    };

    let sprintCommitted = 0;
    let sprintDelivered = 0;
    for (const item of items) {
      const sp = Number(item.storypoints || item.estimate || 0);
      sprintCommitted += sp;
      if (isCompletedState(item.state)) {
        sprintDelivered += sp;
      }
    }
    const challengePct = sprintCommitted > 0 ? Math.min(100, Math.round((sprintDelivered / sprintCommitted) * 100)) : 100;

    const seasonalTitles = AdoLib.calculateSeasonalTitles ? AdoLib.calculateSeasonalTitles(items) : {};

    container.innerHTML = `
      <div class="analytics-header">
        <h2>${L('analytics.arena.title', 'Team Arena')}</h2>
        <p class="analytics-desc">${L('analytics.arena.desc', 'Celebrate team performance with friendly competition. Toggle metrics to see who currently leads the board.')}</p>
      </div>

      <div class="arena-toggle-group">
        <button class="arena-toggle-btn ${selectedArenaMetric === 'tasks' ? 'active' : ''}" data-metric="tasks">
          <ui-icon name="check-square"></ui-icon> <span>${L('analytics.arena.slayer', 'Task Slayer')}</span>
        </button>
        <button class="arena-toggle-btn ${selectedArenaMetric === 'points' ? 'active' : ''}" data-metric="points">
          <ui-icon name="zap"></ui-icon> <span>${L('analytics.arena.velocity', 'Velocity Champion')}</span>
        </button>
        <button class="arena-toggle-btn ${selectedArenaMetric === 'speed' ? 'active' : ''}" data-metric="speed">
          <ui-icon name="clock"></ui-icon> <span>${L('analytics.arena.speed', 'Speedrunner')}</span>
        </button>
        <button class="arena-toggle-btn ${selectedArenaMetric === 'bugs' ? 'active' : ''}" data-metric="bugs">
          <ui-icon name="target"></ui-icon> <span>${L('analytics.arena.hunter', 'Bug Hunter')}</span>
        </button>
      </div>

      <div class="podium-wrapper">
        <div class="podium-col second">
          ${second ? `
            <div class="podium-avatar">${second.name.slice(0,2).toUpperCase()}</div>
            <div class="podium-name">${htmlEsc(second.name)}</div>
            <div class="podium-value">${valStr(second)}</div>
            <div class="podium-bar">
              <span class="podium-medal">🥈</span>
            </div>
          ` : '<div class="podium-bar empty"></div>'}
        </div>

        <div class="podium-col first">
          ${first ? `
            <div class="podium-avatar">${first.name.slice(0,2).toUpperCase()}</div>
            <div class="podium-name">${htmlEsc(first.name)}</div>
            <div class="podium-value">${valStr(first)}</div>
            <div class="podium-bar">
              <span class="podium-medal">🥇</span>
            </div>
          ` : '<div class="podium-bar empty"></div>'}
        </div>

        <div class="podium-col third">
          ${third ? `
            <div class="podium-avatar">${third.name.slice(0,2).toUpperCase()}</div>
            <div class="podium-name">${htmlEsc(third.name)}</div>
            <div class="podium-value">${valStr(third)}</div>
            <div class="podium-bar">
              <span class="podium-medal">🥉</span>
            </div>
          ` : '<div class="podium-bar empty"></div>'}
        </div>
      </div>

      <!-- Sprint Challenge Block -->
      <div class="analytics-section">
        <h3>🏆 ${L('analytics.arena.sprintChallenge', 'Sprint Challenge')}</h3>
        <p class="analytics-desc" style="margin-bottom: 0.75rem;">
          ${L('analytics.arena.challengeDesc', 'Complete committed story points to unlock the team bounty!')} 
          <strong>${sprintDelivered} / ${sprintCommitted} SP (${challengePct}%)</strong>
        </p>
        <div class="xp-progress-bar" style="height: 0.75rem; border-radius: 8px;">
          <div class="xp-progress-fill" style="width: ${challengePct}%; border-radius: 8px;"></div>
        </div>
      </div>

      <div class="analytics-section">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
          <h3 style="margin: 0;">Team Scoreboard</h3>
          ${team.length > 0 ? `<button class="analytics-export-btn" id="export_leaderboard_csv"><ui-icon name="download"></ui-icon> Export CSV</button>` : ''}
        </div>
        <div class="table-container">
          <table class="analytics-table">
            <thead>
              <tr>
                <th>Rank</th>
                <th>Assignee</th>
                <th>${L('analytics.arena.tasks', 'Tasks')}</th>
                <th>${L('analytics.arena.points', 'Story Points')}</th>
                <th>${L('analytics.arena.speedDays', 'Days Avg')}</th>
                <th>${L('analytics.arena.bugs', 'Bugs')}</th>
                <th>${L('analytics.arena.achievements', 'Achievements')}</th>
              </tr>
            </thead>
            <tbody>
              ${team.map((x, idx) => {
                let badge = `${idx + 1}`;
                if (idx === 0) badge = '🥇';
                else if (idx === 1) badge = '🥈';
                else if (idx === 2) badge = '🥉';

                const sTitle = seasonalTitles[x.name];
                const titleBadgeHtml = sTitle ? ` <span class="seasonal-badge" style="background: var(--line); border-radius: 8px; padding: 2px 6px; font-size: 0.769rem;" title="${htmlEsc(sTitle.title)}">${sTitle.badge} ${htmlEsc(sTitle.title)}</span>` : '';

                return `
                  <tr>
                    <td><strong>${badge}</strong></td>
                    <td class="table-title"><strong>${htmlEsc(x.name)}</strong>${titleBadgeHtml}</td>
                    <td>${x.tasks}</td>
                    <td>${x.points} SP</td>
                    <td>${x.avgCycle !== null ? `${x.avgCycle.toFixed(1)}d` : '—'}</td>
                    <td>${x.bugs}</td>
                    <td>${x.achievements}</td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;

    const expBtn = container.querySelector('#export_leaderboard_csv');
    if (expBtn) {
      expBtn.onclick = () => {
        exportToCsv('team_leaderboard.csv', ['Rank', 'Assignee', 'Tasks', 'Points', 'Avg Days', 'Bugs'], team.map((x, idx) => [idx + 1, x.name, x.tasks, x.points, x.avgCycle !== null ? x.avgCycle.toFixed(1) : '—', x.bugs]));
      };
    }

    container.querySelectorAll('.arena-toggle-btn').forEach(btn => {
      btn.onclick = () => {
        selectedArenaMetric = btn.dataset.metric;
        drawActiveView();
      };
    });
  }

  // --- 7. Burndown View ---
  async function renderBurndown(container, items) {
    let sprints = [];
    try {
      if (typeof getIterations === 'function') {
        sprints = await getIterations();
      }
    } catch (_) {}

    // Filter to sprints that have start and end dates
    const datedSprints = sprints.filter(s => s.start && s.finish);

    if (datedSprints.length === 0) {
      container.innerHTML = `
        <div class="analytics-header">
          <h2>${L('analytics.burndown.title', 'Burndown / Burnup Chart')}</h2>
          <p class="analytics-desc">${L('analytics.burndown.desc', 'Track day-by-day sprint scope against completed work to assess sprint delivery success.')}</p>
        </div>
        <div class="analytics-empty-section">No dated iterations (sprints) found in this project.</div>
      `;
      return;
    }

    // Default selected sprint if empty
    if (!selectedSprintPath || !datedSprints.some(s => s.path === selectedSprintPath)) {
      const active = datedSprints.find(isCurrentSprint);
      selectedSprintPath = active ? active.path : datedSprints[0].path;
    }

    const selectedSprint = datedSprints.find(s => s.path === selectedSprintPath);

    // Reconstruct list of dates in this sprint (daily array)
    const start = new Date(selectedSprint.start);
    const end = new Date(selectedSprint.finish);
    const sprintDates = [];
    let cur = new Date(start);
    while (cur <= end) {
      sprintDates.push(cur.toISOString().slice(0, 10));
      cur.setDate(cur.getDate() + 1);
      if (sprintDates.length > 45) break; // sanity safeguard
    }

    // Fetch revision cache history mapped to item dictionary
    const historyDict = {};
    items.forEach(it => {
      historyDict[it.id] = revisionCache.get(it.id) || [];
    });

    // Run pure math function from AdoLib
    const dataPoints = AdoLib.generateBurndownData(items, historyDict, sprintDates, selectedSprint.path);

    // Compute Y max scale
    const isPoints = burndownMetric === 'points';
    let yMax = 0;
    dataPoints.forEach(p => {
      const val = isPoints ? p.totalPoints : p.totalTasks;
      if (val > yMax) yMax = val;
    });
    if (yMax <= 0) yMax = 10;
    const yMaxRounded = Math.ceil(yMax / 5) * 5;

    // SVG parameters
    const svgW = 680;
    const svgH = 340;
    const padL = 50;
    const padR = 20;
    const padT = 30;
    const padB = 50;
    const chartW = svgW - padL - padR;
    const chartH = svgH - padT - padB;

    const scaleX = (idx) => padL + (idx / (dataPoints.length - 1)) * chartW;
    const scaleY = (val) => padT + chartH - (val / yMaxRounded) * chartH;

    // Ideal trend path (Diagonal line from start total to 0 at end)
    const firstPoint = dataPoints[0];
    const initialVal = isPoints ? firstPoint.totalPoints : firstPoint.totalTasks;
    const idealX1 = scaleX(0);
    const idealY1 = scaleY(initialVal);
    const idealX2 = scaleX(dataPoints.length - 1);
    const idealY2 = scaleY(0);

    // Build SVG remaining & total scope points path
    let remainingPathD = '';
    let totalPathD = '';

    dataPoints.forEach((p, idx) => {
      const remVal = isPoints ? p.remainingPoints : p.remainingTasks;
      const totVal = isPoints ? p.totalPoints : p.totalTasks;
      const x = scaleX(idx);
      const yRem = scaleY(remVal);
      const yTot = scaleY(totVal);

      if (idx === 0) {
        remainingPathD = `M ${x} ${yRem}`;
        totalPathD = `M ${x} ${yTot}`;
      } else {
        // Stepped line renderer: draw horizontal, then vertical to next point
        const prevX = scaleX(idx - 1);
        remainingPathD += ` L ${x} ${scaleY(isPoints ? dataPoints[idx-1].remainingPoints : dataPoints[idx-1].remainingTasks)} L ${x} ${yRem}`;
        totalPathD += ` L ${x} ${scaleY(isPoints ? dataPoints[idx-1].totalPoints : dataPoints[idx-1].totalTasks)} L ${x} ${yTot}`;
      }
    });

    let areaPathD = '';
    if (dataPoints.length > 0) {
      const firstX = scaleX(0);
      const lastX = scaleX(dataPoints.length - 1);
      const chartBottom = padT + chartH;
      areaPathD = `${remainingPathD} L ${lastX} ${chartBottom} L ${firstX} ${chartBottom} Z`;
    }

    // Render Y gridlines & axis labels
    const gridLines = [];
    for (let i = 0; i <= 5; i++) {
      const val = (yMaxRounded / 5) * i;
      const y = scaleY(val);
      gridLines.push(`
        <line x1="${padL}" y1="${y}" x2="${svgW - padR}" y2="${y}" stroke="var(--line)" stroke-dasharray="2 2" />
        <text x="${padL - 10}" y="${y + 4}" fill="var(--muted)" font-size="11" text-anchor="end">${Math.round(val)}</text>
      `);
    }

    // Render X gridlines & dates
    const xLabels = [];
    const dateStep = Math.max(1, Math.round(dataPoints.length / 6));
    dataPoints.forEach((p, idx) => {
      if (idx % dateStep === 0 || idx === dataPoints.length - 1) {
        const x = scaleX(idx);
        const pretty = p.date.slice(5); // e.g. "07-01"
        xLabels.push(`
          <line x1="${x}" y1="${padT}" x2="${x}" y2="${padT + chartH}" stroke="var(--line)" stroke-dasharray="2 2" />
          <text x="${x}" y="${padT + chartH + 18}" fill="var(--muted)" font-size="11" text-anchor="middle">${pretty}</text>
        `);
      }
    });

    container.innerHTML = `
      <div class="analytics-header">
        <h2>${L('analytics.burndown.title', 'Burndown / Burnup Chart')}</h2>
        <p class="analytics-desc">${L('analytics.burndown.desc', 'Track day-by-day sprint scope against completed work to assess sprint delivery success.')}</p>
      </div>

      <div class="chart-controls-panel">
        <div class="control-group">
          <label>${L('analytics.burndown.sprint', 'Select Sprint:')}</label>
          <select id="burndown_sprint_select">
            ${datedSprints.map(s => `<option value="${htmlEsc(s.path)}" ${s.path === selectedSprintPath ? 'selected' : ''}>${htmlEsc(s.name)}</option>`).join('')}
          </select>
        </div>

        <div class="control-group">
          <label>${L('analytics.burndown.metric', 'Toggle Metric:')}</label>
          <div class="arena-toggle-group" style="margin: 0;">
            <button class="arena-toggle-btn ${isPoints ? 'active' : ''}" data-metric="points">Story Points</button>
            <button class="arena-toggle-btn ${!isPoints ? 'active' : ''}" data-metric="tasks">Task Count</button>
          </div>
        </div>
      </div>

      <div class="chart-container" style="padding: 1.5rem; background: var(--panel); border: 1px solid var(--line); border-radius: 0.615rem;">
        <svg viewBox="0 0 ${svgW} ${svgH}" width="100%" height="${svgH}" style="display: block; overflow: visible;">
          <defs>
            <linearGradient id="burndownGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.35"/>
              <stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/>
            </linearGradient>
          </defs>

          <!-- Grid & Ticks -->
          ${gridLines.join('')}
          ${xLabels.join('')}

          <!-- Ideal burndown dashed diagonal line -->
          <line x1="${idealX1}" y1="${idealY1}" x2="${idealX2}" y2="${idealY2}" stroke="var(--muted)" stroke-dasharray="4 4" stroke-width="2" />

          <!-- Gradient Area under remaining points line -->
          <path d="${areaPathD}" fill="url(#burndownGrad)" />

          <!-- Total Scope line (scope tracking) -->
          <path d="${totalPathD}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-opacity="0.4" stroke-dasharray="3 1" />

          <!-- Remaining points line (stepped line) -->
          <path d="${remainingPathD}" fill="none" stroke="var(--accent)" stroke-width="3" />

          <!-- Circle Points -->
          ${dataPoints.map((p, idx) => {
            const remVal = isPoints ? p.remainingPoints : p.remainingTasks;
            const x = scaleX(idx);
            const y = scaleY(remVal);
            return `
              <circle cx="${x}" cy="${y}" r="4" fill="var(--accent)" stroke="var(--panel)" stroke-width="2" style="cursor: pointer;">
                <title>${p.date}: ${remVal} ${isPoints ? 'SP' : 'Tasks'} remaining / ${isPoints ? p.totalPoints : p.totalTasks} total</title>
              </circle>
            `;
          }).join('')}
        </svg>

        <div class="chart-legend" style="margin-top: 1rem; display: flex; justify-content: center; gap: 1.5rem; font-size: 0.846rem;">
          <div style="display: flex; align-items: center; gap: 0.385rem;">
            <span style="display:inline-block; width:1rem; height:0.2rem; border-top:2px dashed var(--muted);"></span>
            <span>${L('analytics.burndown.legend.ideal', 'Ideal Burndown')}</span>
          </div>
          <div style="display: flex; align-items: center; gap: 0.385rem;">
            <span style="display:inline-block; width:1rem; height:0.2rem; background:var(--accent);"></span>
            <span>${L('analytics.burndown.legend.remaining', 'Remaining Work')}</span>
          </div>
          <div style="display: flex; align-items: center; gap: 0.385rem;">
            <span style="display:inline-block; width:1rem; height:0.2rem; border-top:2px dashed var(--accent); opacity: 0.5;"></span>
            <span>${L('analytics.burndown.legend.total', 'Total Scope')}</span>
          </div>
        </div>
      </div>
    `;

    // Wire up events
    container.querySelector('#burndown_sprint_select').onchange = (e) => {
      selectedSprintPath = e.target.value;
      drawActiveView();
    };

    container.querySelectorAll('.chart-controls-panel .arena-toggle-btn').forEach(btn => {
      btn.onclick = () => {
        burndownMetric = btn.dataset.metric;
        drawActiveView();
      };
    });
  }

  // --- 8. Sprint Velocity View ---
  async function renderVelocity(container, items) {
    let sprints = [];
    try {
      if (typeof getIterations === 'function') {
        sprints = await getIterations();
      }
    } catch (_) {}

    const datedSprints = sprints.filter(s => s.start && s.finish);

    if (datedSprints.length === 0) {
      container.innerHTML = `
        <div class="analytics-header">
          <h2>${L('analytics.velocity.title', 'Historical Sprint Velocity')}</h2>
          <p class="analytics-desc">${L('analytics.velocity.desc', 'Compare committed vs delivered work items and story points across recent sprints.')}</p>
        </div>
        <div class="analytics-empty-section">No dated iterations (sprints) found.</div>
      `;
      return;
    }

    // Sort chronologically and take last 5 sprints
    const recentSprints = datedSprints
      .sort((a, b) => new Date(a.start) - new Date(b.start))
      .slice(-5);

    const historyDict = {};
    items.forEach(it => {
      historyDict[it.id] = revisionCache.get(it.id) || [];
    });

    // Run pure math calculation
    const velocityData = AdoLib.calculateSprintVelocity(items, historyDict, recentSprints);

    // Compute max scale
    let yMax = 0;
    velocityData.forEach(s => {
      if (s.committedPoints > yMax) yMax = s.committedPoints;
      if (s.deliveredPoints > yMax) yMax = s.deliveredPoints;
    });
    if (yMax <= 0) yMax = 10;
    const yMaxRounded = Math.ceil(yMax / 10) * 10;

    const svgW = 680;
    const svgH = 340;
    const padL = 50;
    const padR = 20;
    const padT = 30;
    const padB = 50;
    const chartW = svgW - padL - padR;
    const chartH = svgH - padT - padB;

    const scaleY = (val) => padT + chartH - (val / yMaxRounded) * chartH;
    const numSprints = velocityData.length;
    const groupW = chartW / numSprints;
    const barW = groupW * 0.35;

    // Y axis labels & grid lines
    const gridLines = [];
    for (let i = 0; i <= 5; i++) {
      const val = (yMaxRounded / 5) * i;
      const y = scaleY(val);
      gridLines.push(`
        <line x1="${padL}" y1="${y}" x2="${svgW - padR}" y2="${y}" stroke="var(--line)" stroke-dasharray="2 2" />
        <text x="${padL - 10}" y="${y + 4}" fill="var(--muted)" font-size="11" text-anchor="end">${Math.round(val)}</text>
      `);
    }

    // Render bars for each sprint
    const barsMarkup = [];
    velocityData.forEach((s, idx) => {
      const groupX = padL + idx * groupW;
      const commX = groupX + groupW * 0.15;
      const delivX = commX + barW + groupW * 0.05;

      const commY = scaleY(s.committedPoints);
      const delivY = scaleY(s.deliveredPoints);

      const commH = Math.max(0, padT + chartH - commY);
      const delivH = Math.max(0, padT + chartH - delivY);

      barsMarkup.push(`
        <!-- Committed Bar (Gray/Blue) -->
        <rect x="${commX}" y="${commY}" width="${barW}" height="${commH}" fill="var(--line)" rx="3" ry="3" style="transition: all 0.3s ease;">
          <animate attributeName="height" from="0" to="${commH}" dur="0.8s" fill="freeze" />
          <animate attributeName="y" from="${padT + chartH}" to="${commY}" dur="0.8s" fill="freeze" />
          <title>Committed: ${s.committedPoints} SP (${s.committedTasks} tasks)</title>
        </rect>
        <text x="${commX + barW/2}" y="${commY - 6}" fill="var(--muted)" font-size="10" font-weight="bold" text-anchor="middle">${Math.round(s.committedPoints)}</text>

        <!-- Delivered Bar (Green/Accent) -->
        <rect x="${delivX}" y="${delivY}" width="${barW}" height="${delivH}" fill="var(--accent)" rx="3" ry="3" style="transition: all 0.3s ease;">
          <animate attributeName="height" from="0" to="${delivH}" dur="0.8s" fill="freeze" />
          <animate attributeName="y" from="${padT + chartH}" to="${delivY}" dur="0.8s" fill="freeze" />
          <title>Delivered: ${s.deliveredPoints} SP (${s.deliveredTasks} tasks)</title>
        </rect>
        <text x="${delivX + barW/2}" y="${delivY - 6}" fill="var(--accent)" font-size="10" font-weight="bold" text-anchor="middle">${Math.round(s.deliveredPoints)}</text>

        <!-- Sprint Title -->
        <text x="${groupX + groupW/2}" y="${padT + chartH + 20}" fill="var(--txt)" font-size="11" font-weight="500" text-anchor="middle">${htmlEsc(s.sprintName)}</text>
      `);
    });

    container.innerHTML = `
      <div class="analytics-header">
        <h2>${L('analytics.velocity.title', 'Historical Sprint Velocity')}</h2>
        <p class="analytics-desc">${L('analytics.velocity.desc', 'Compare committed vs delivered work items and story points across recent sprints.')}</p>
      </div>

      <div class="chart-container" style="padding: 1.5rem; background: var(--panel); border: 1px solid var(--line); border-radius: 0.615rem; margin-top: 1.5rem;">
        <svg viewBox="0 0 ${svgW} ${svgH}" width="100%" height="${svgH}" style="display: block; overflow: visible;">
          ${gridLines.join('')}
          ${barsMarkup.join('')}
        </svg>

        <div class="chart-legend" style="margin-top: 1rem; display: flex; justify-content: center; gap: 1.5rem; font-size: 0.846rem;">
          <div style="display: flex; align-items: center; gap: 0.385rem;">
            <span style="display:inline-block; width:1rem; height:0.6rem; background:var(--line); border-radius:2px;"></span>
            <span>${L('analytics.velocity.legend.committed', 'Committed')}</span>
          </div>
          <div style="display: flex; align-items: center; gap: 0.385rem;">
            <span style="display:inline-block; width:1rem; height:0.6rem; background:var(--accent); border-radius:2px;"></span>
            <span>${L('analytics.velocity.legend.delivered', 'Delivered')}</span>
          </div>
        </div>
      </div>
    `;
  }

  // --- 9. Team Throughput View ---
  function renderThroughput(container, items) {
    const now = new Date();
    let startDate = '';
    const endDate = now.toISOString();

    if (throughputTimeframe === 'last4weeks') {
      const fourWeeksAgo = new Date(now.getTime() - 28 * 24 * 60 * 60 * 1000);
      startDate = fourWeeksAgo.toISOString();
    } else {
      const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
      startDate = ninetyDaysAgo.toISOString();
    }

    const historyDict = {};
    items.forEach(it => {
      historyDict[it.id] = revisionCache.get(it.id) || [];
    });

    // Run pure math team throughput calculation
    const counts = AdoLib.calculateTeamThroughput(items, historyDict, startDate, endDate);

    // Convert to sorted array
    const data = Object.keys(counts).map(name => ({
      name,
      count: counts[name]
    })).sort((a, b) => b.count - a.count);

    if (data.length === 0) {
      container.innerHTML = `
        <div class="analytics-header">
          <h2>${L('analytics.throughput.title', 'Team Throughput')}</h2>
          <p class="analytics-desc">${L('analytics.throughput.desc', 'Compare tasks completed by each team member within the selected date range.')}</p>
        </div>
        <div class="chart-controls-panel">
          <div class="control-group">
            <label>${L('analytics.throughput.range', 'Select Range:')}</label>
            <select id="throughput_range_select">
              <option value="last4weeks" ${throughputTimeframe === 'last4weeks' ? 'selected' : ''}>${L('analytics.throughput.range.last4weeks', 'Last 4 Weeks')}</option>
              <option value="last90days" ${throughputTimeframe === 'last90days' ? 'selected' : ''}>${L('analytics.throughput.range.last90days', 'Last 90 Days')}</option>
            </select>
          </div>
        </div>
        <div class="analytics-empty-section">No tasks were completed in this timeframe.</div>
      `;
      return;
    }

    // Set SVG sizing based on number of assignees (horizontal bar chart)
    const rowH = 40;
    const padL = 120;
    const padR = 40;
    const padT = 20;
    const padB = 20;
    const svgW = 680;
    const chartW = svgW - padL - padR;
    const svgH = padT + padB + data.length * rowH;

    const maxCount = Math.max(...data.map(x => x.count));
    const scaleX = (val) => (val / maxCount) * chartW;

    const bars = data.map((x, idx) => {
      const y = padT + idx * rowH;
      const barW = Math.max(10, scaleX(x.count));
      return `
        <!-- Assignee Name -->
        <text x="${padL - 10}" y="${y + 24}" fill="var(--txt)" font-size="11" font-weight="600" text-anchor="end">${htmlEsc(x.name)}</text>
        
        <!-- Throughput Bar -->
        <rect x="${padL}" y="${y + 10}" width="${barW}" height="20" fill="var(--accent)" rx="4" ry="4">
          <animate attributeName="width" from="0" to="${barW}" dur="0.8s" fill="freeze" />
          <title>${x.count} tasks completed</title>
        </rect>
        
        <!-- Score label inside or outside the bar -->
        <text x="${padL + barW + 8}" y="${y + 24}" fill="var(--accent)" font-size="11" font-weight="bold">${x.count}</text>
      `;
    });

    container.innerHTML = `
      <div class="analytics-header">
        <h2>${L('analytics.throughput.title', 'Team Throughput')}</h2>
        <p class="analytics-desc">${L('analytics.throughput.desc', 'Compare tasks completed by each team member within the selected date range.')}</p>
      </div>

      <div class="chart-controls-panel">
        <div class="control-group">
          <label>${L('analytics.throughput.range', 'Select Range:')}</label>
          <select id="throughput_range_select" style="min-width: 10rem;">
            <option value="last4weeks" ${throughputTimeframe === 'last4weeks' ? 'selected' : ''}>${L('analytics.throughput.range.last4weeks', 'Last 4 Weeks')}</option>
            <option value="last90days" ${throughputTimeframe === 'last90days' ? 'selected' : ''}>${L('analytics.throughput.range.last90days', 'Last 90 Days')}</option>
          </select>
        </div>
      </div>

      <div class="chart-container" style="padding: 1.5rem; background: var(--panel); border: 1px solid var(--line); border-radius: 0.615rem; margin-top: 1.5rem;">
        <svg viewBox="0 0 ${svgW} ${svgH}" width="100%" height="${svgH}" style="display: block; overflow: visible;">
          ${bars.join('')}
        </svg>
      </div>
    `;

    // Wire up timeframe selection change
    container.querySelector('#throughput_range_select').onchange = (e) => {
      throughputTimeframe = e.target.value;
      drawActiveView();
    };
  }

  // Export module interface
  App.analytics = { track, renderAnalytics, cleanup, clearCache };

})(window.App);

(function (App) {
  'use strict';

  // In-memory cache for work item revision histories to avoid repeated fetches
  const revisionCache = new Map();
  let cachedProject = '';
  let activeView = 'cycle_time';
  let currentController = null;
  let currentRenderToken = 0;

  // Localisation helper
  const L = (key, fallback) => (window.i18n && window.i18n.t) ? window.i18n.t(key) : fallback;

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

  function renderAnalytics() {
    // Clear cache if project switched
    if (window.projectName !== cachedProject) {
      clearCache();
      cachedProject = window.projectName;
    }

    const container = document.getElementById('analytics');
    if (!container) return;

    // Initialize layout structure if not already built
    if (!container.querySelector('.analytics-sidebar')) {
      container.innerHTML = `
        <div class="analytics-sidebar">
          <div class="analytics-sidebar-title">${L('analytics.title', 'Analytics')}</div>
          <button class="analytics-menu-btn active" data-view="cycle_time">
            <ui-icon name="clock"></ui-icon> <span>${L('analytics.menu.cycle', 'Cycle & Lead Time')}</span>
          </button>
          <button class="analytics-menu-btn" data-view="cfd">
            <ui-icon name="bar-chart"></ui-icon> <span>${L('analytics.menu.cfd', 'Cumulative Flow (CFD)')}</span>
          </button>
          <button class="analytics-menu-btn" data-view="aging_wip">
            <ui-icon name="activity"></ui-icon> <span>${L('analytics.menu.aging', 'Aging WIP')}</span>
          </button>
          <button class="analytics-menu-btn" data-view="stale_items">
            <ui-icon name="alert-circle"></ui-icon> <span>${L('analytics.menu.stale', 'Stale Items')}</span>
          </button>
          <button class="analytics-menu-btn" data-view="blocked_time">
            <ui-icon name="slash"></ui-icon> <span>${L('analytics.menu.blocked', 'Blocked Time')}</span>
          </button>
        </div>
        <div class="analytics-main">
          <div class="analytics-loading" style="display:none">
            <div class="spinner-ring"></div>
            <div class="analytics-loading-text">${L('analytics.loading', 'Loading history...')} <span id="analytics_progress">0/0</span></div>
          </div>
          <div class="analytics-content"></div>
        </div>
      `;

      // Wire sidebar tab buttons
      container.querySelectorAll('.analytics-menu-btn').forEach(btn => {
        btn.onclick = () => {
          container.querySelectorAll('.analytics-menu-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          activeView = btn.dataset.view;
          drawActiveView();
        };
      });
    }

    const ids = (App.state.store.roots || []).slice();
    if (ids.length === 0) {
      showEmptyState();
      setStatus('0 items');
      return;
    }

    setStatus(`${ids.length} items`);
    fetchAndRender(ids);
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

  async function fetchAndRender(ids) {
    const loader = document.querySelector('#analytics .analytics-loading');
    const progressSpan = document.getElementById('analytics_progress');
    const content = document.querySelector('#analytics .analytics-content');
    if (!loader || !content) return;

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
        }), 6);
      } catch (err) {
        if (err.name === 'AbortError' || myToken !== currentRenderToken) {
          return;
        }
      }

      if (myToken !== currentRenderToken) return;
      loader.style.display = 'none';
      content.style.display = 'block';
    } else {
      loader.style.display = 'none';
      content.style.display = 'block';
    }

    drawActiveView();
  }

  // --- Helper Date & State Functions ---

  function daysBetween(d1, d2) {
    const t1 = new Date(d1).getTime();
    const t2 = new Date(d2).getTime();
    if (isNaN(t1) || isNaN(t2)) return 0;
    const diff = (t2 - t1) / (1000 * 60 * 60 * 24);
    return Math.max(0, Math.round(diff * 10) / 10);
  }

  function isCompletedState(state) {
    if (!state) return false;
    const s = state.toLowerCase();
    return s === 'closed' || s === 'done' || s === 'completed' || s === 'resolved' || s === 'removed';
  }

  function isInProgressState(state) {
    if (!state) return false;
    const s = state.toLowerCase();
    return s === 'active' || s === 'doing' || s === 'in progress' || s === 'committed' || s === 'started' || s === 'progress';
  }

  function drawActiveView() {
    const content = document.querySelector('#analytics .analytics-content');
    if (!content) return;

    const ids = App.state.store.roots || [];
    const items = ids.map(id => App.state.store.nodes[id]).filter(Boolean);

    if (activeView === 'cycle_time') {
      renderCycleLeadTime(content, items);
    } else if (activeView === 'cfd') {
      renderCFDSummary(content, items);
    } else if (activeView === 'aging_wip') {
      renderAgingWIP(content, items);
    } else if (activeView === 'stale_items') {
      renderStaleItems(content, items);
    } else if (activeView === 'blocked_time') {
      renderBlockedTime(content, items);
    }
  }

  // --- 1. Cycle & Lead Time View ---
  function renderCycleLeadTime(container, items) {
    const completed = [];
    items.forEach(item => {
      if (!isCompletedState(item.state)) return;
      const history = revisionCache.get(item.id) || [];
      const chronological = history.slice().reverse();

      // Creation date from item metadata or first update
      const createdDate = item.createddate || (chronological[0] ? chronological[0].date : null);
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
      if (!completionDate) completionDate = item.changeddate || createdDate;

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
        <h3>${L('analytics.stale.log', 'Stale Items Log')}</h3>
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
        <h3>${L('analytics.blocked.log', 'Blocked Items Log')}</h3>
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
  }

  // Export module interface
  App.analytics = { track, renderAnalytics, cleanup, clearCache };

})(window.App);

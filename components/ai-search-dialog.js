(function(global) {
  'use strict';

  let modalEl = null;
  let textInput = null;
  let submitBtn = null;
  let applyDirectBtn = null;
  let applyDirectly = false;
  let cancelBtn = null;
  let closeBtn = null;
  let progressContainer = null;
  let progressFill = null;
  let progressStatus = null;
  let errorEl = null;
  let activeProvider = null;
  let downloadProgressActive = false;
  let selectedLevel = 'auto';

  // AI Provider settings elements
  let settingsToggleBtn = null;

  // Background states
  let isDialogVisible = false;
  let isSearchingActive = false;
  let currentResult = null;

  // Background floating card elements
  let backgroundStatusEl = null;
  let backgroundProgressFill = null;
  let backgroundPercentText = null;
  let backgroundStatusText = null;
  let backgroundCloseBtn = null;
  let backgroundActionBtn = null;

  function initDOM() {
    if (modalEl) return;
    selectedLevel = localStorage.getItem('aiSearchReasoningLevel') || 'auto';

    modalEl = document.createElement('div');
    modalEl.id = 'ai-search-modal';
    modalEl.className = 'ai-modal-overlay';
    modalEl.style.display = 'none';

    modalEl.innerHTML = `
      <div class="ai-modal-wrapper" style="position: relative; display: flex; flex-direction: row; align-items: flex-start;">
        <!-- Left Tabs Container -->
        <div id="ai-modal-tabs-container" class="ai-modal-tabs-container"></div>

        <div class="ai-modal-card">
          <div class="ai-modal-header" style="display: flex; justify-content: space-between; align-items: center;">
            <h3 class="ai-modal-title">
              <span class="ai-sparkles-icon" style="color:#a855f7; display:flex; align-items:center;"><ui-icon name="sparkles"></ui-icon></span> AI Search
              <span class="ai-beta-badge-text">BETA</span>
              <span class="logic-hint" id="ai-search-help-trigger" style="cursor: pointer; display: flex; align-items: center;" data-tooltip-html="<b>Privacy-First On-Device AI</b><br/><br/>This feature runs <b>entirely locally</b> on your machine using Google Chrome's built-in Gemini Nano model.<br/><br/>🔒 <b>100% Private & Secure:</b> Your queries, dynamic fields, and work item data never leave your browser and are never sent to external servers.">
                <ui-icon name="help"></ui-icon>
              </span>
            </h3>
            <div style="display: flex; align-items: center; gap: 8px;">
              <button id="ai-search-toggle-help-btn" style="background: transparent; border: 1px solid var(--line, #333); border-radius: 4px; color: var(--muted, #aaa); padding: 4px 8px; font-size: 0.72rem; font-weight: 600; cursor: pointer; display: flex; align-items: center; gap: 4px;">
                <span style="display:flex; align-items:center;"><ui-icon name="book"></ui-icon></span> <span id="ai-search-toggle-help-text">Hide Help</span>
              </button>
              <button class="ai-modal-close" id="ai-search-close-btn">&times;</button>
            </div>
          </div>
          <div class="ai-modal-body" style="display:flex; flex-direction:row; gap:20px; padding:20px; align-items:stretch;">
            <div class="ai-main-content" style="flex:1; display:flex; flex-direction:column; gap:16px;">
              <div class="ai-modal-desc">
                Describe what you're looking for in plain language, and AI will configure the search filters for you.
              </div>
              <div class="ai-textarea-wrapper">
                <textarea id="ai-search-text-input" placeholder="e.g., active bugs assigned to me created in the last week..." rows="4" maxlength="800"></textarea>
                <div class="ai-char-counter"><span id="ai-char-count">0</span>/800</div>
              </div>
              
              <div class="ai-reasoning-container">
                <span class="ai-reasoning-label">Reasoning Depth:</span>
                <div class="ai-reasoning-options">
                  <button class="ai-reasoning-btn ${selectedLevel === 'auto' ? 'active' : ''}" data-level="auto" title="Automatically chooses the best depth based on query complexity">Auto</button>
                  <button class="ai-reasoning-btn ${selectedLevel === 'fast' ? 'active' : ''}" data-level="fast" title="Fast 1-pass response, best for simple queries">Fast</button>
                  <button class="ai-reasoning-btn ${selectedLevel === 'balanced' ? 'active' : ''}" data-level="balanced" title="2-pass schema-filtered. Recommended balance of speed and quality">Balanced</button>
                  <button class="ai-reasoning-btn ${selectedLevel === 'thorough' ? 'active' : ''}" data-level="thorough" title="3-pass reasoning with self-correction. Best for complex logic">Thorough</button>
                </div>
              </div>
              
              <div class="ai-progress-container" id="ai-search-progress" style="display: none;">
                <div class="ai-progress-header">
                  <span class="ai-progress-status" id="ai-search-status-text">Processing...</span>
                  <span class="ai-progress-percent" id="ai-search-percent-text">0%</span>
                </div>
                <div class="ai-progress-bar-bg">
                  <div class="ai-progress-bar-fill" id="ai-search-progress-fill" style="width: 0%;"></div>
                </div>
              </div>
              
              <div class="ai-error-message" id="ai-search-error-msg" style="display: none;"></div>
            </div>

            <!-- Right Tutorial Sidebar -->
            <div class="ai-tutorial-sidebar" style="width: 240px; padding-left: 20px; border-left: 1px solid var(--line, #333); display: flex; flex-direction: column; gap: 12px; flex-shrink: 0; box-sizing: border-box;">
              <h4 style="margin: 0; font-size: 0.8rem; font-weight: 700; color: var(--accent, #a855f7); text-transform: uppercase; letter-spacing: 0.5px; display: flex; align-items: center; gap: 6px;">
                <span style="display:inline-flex; align-items:center; color:#a855f7;"><ui-icon name="sparkles"></ui-icon></span> How to search
              </h4>
              <div style="font-size: 0.76rem; line-height: 1.45; color: var(--muted, #aaa); display: flex; flex-direction: column; gap: 10px;">
                <div>
                  Describe your request in natural language. AI will resolve dates, paths, fields, and assignees.
                </div>
                <div style="background: rgba(255,255,255,0.02); border: 1px solid var(--line, #333); padding: 8px 10px; border-radius: 6px; display: flex; flex-direction: column; gap: 6px;">
                  <strong style="color: var(--txt);">💡 Examples (Click to try):</strong>
                  <div style="display: flex; flex-direction: column; gap: 6px;">
                    <div>• <span class="example-link">active bugs assigned to me created in the last 2 weeks</span></div>
                    <div>• <span class="example-link">resolved user stories in Sprint 15 or 16</span></div>
                    <div>• <span class="example-link">tasks for Alex and me with high priority</span></div>
                  </div>
                </div>
                <div>
                  <strong>🌐 Multilingual:</strong> Write in English, Russian, French, etc. Roster names are mapped automatically.
                </div>
              </div>
            </div>
          </div>
          <div class="ai-modal-footer" style="display: flex; gap: 8px; justify-content: flex-end; padding: 16px 20px; border-top: 1px solid var(--line, #333);">
            <button class="btn btn-secondary" id="ai-search-cancel-btn">Cancel</button>
            <button class="btn btn-primary" id="ai-search-submit-btn" disabled>Search</button>
            <button class="btn btn-primary" id="ai-search-apply-direct-btn" style="background: linear-gradient(135deg, #7209b7, #3f37c9); border-color: #560bad;" disabled>Apply directly</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(modalEl);

    // Initialize floating background status card
    backgroundStatusEl = document.createElement('div');
    backgroundStatusEl.id = 'ai-background-status';
    backgroundStatusEl.className = 'ai-background-card';
    backgroundStatusEl.style.display = 'none';
    backgroundStatusEl.innerHTML = `
      <div class="ai-bg-header">
        <span class="ai-bg-title" style="display:flex; align-items:center; gap:6px;"><span style="color:#a855f7; display:flex; align-items:center;"><ui-icon name="sparkles"></ui-icon></span> AI Search Task</span>
        <button class="ai-bg-close-btn" id="ai-bg-close-btn">&times;</button>
      </div>
      <div class="ai-bg-body">
        <div class="ai-bg-status-row">
          <span class="ai-bg-status-text" id="ai-bg-status-text">Processing...</span>
          <span class="ai-bg-percent" id="ai-bg-percent">0%</span>
        </div>
        <div class="ai-bg-progress-bar-bg">
          <div class="ai-bg-progress-bar-fill" id="ai-bg-progress-fill" style="width: 0%;"></div>
        </div>
      </div>
      <div class="ai-bg-footer" style="display: none; justify-content: flex-end; gap: 6px; margin-top: 8px;">
        <button class="btn btn-secondary btn-sm" id="ai-bg-dismiss-btn" style="padding:2px 8px; font-size:0.75rem;">Dismiss</button>
        <button class="btn btn-primary btn-sm" id="ai-bg-action-btn" style="padding:2px 8px; font-size:0.75rem; background:#7209b7; border-color:#7209b7;">View Filters</button>
      </div>
    `;
    document.body.appendChild(backgroundStatusEl);

    textInput = document.getElementById('ai-search-text-input');
    submitBtn = document.getElementById('ai-search-submit-btn');
    applyDirectBtn = document.getElementById('ai-search-apply-direct-btn');
    cancelBtn = document.getElementById('ai-search-cancel-btn');
    closeBtn = document.getElementById('ai-search-close-btn');
    progressContainer = document.getElementById('ai-search-progress');
    progressFill = document.getElementById('ai-search-progress-fill');
    progressStatus = document.getElementById('ai-search-status-text');
    errorEl = document.getElementById('ai-search-error-msg');

    // Bind settings panel variables
    settingsToggleBtn = document.getElementById('ai-settings-toggle-btn');

    backgroundProgressFill = document.getElementById('ai-bg-progress-fill');
    backgroundPercentText = document.getElementById('ai-bg-percent');
    backgroundStatusText = document.getElementById('ai-bg-status-text');
    backgroundCloseBtn = document.getElementById('ai-bg-close-btn');
    backgroundActionBtn = document.getElementById('ai-bg-action-btn');
    const backgroundDismissBtn = document.getElementById('ai-bg-dismiss-btn');

    // Bind event handlers
    textInput.addEventListener('input', handleTextInput);
    textInput.addEventListener('keydown', handleKeyDown);
    
    submitBtn.addEventListener('click', () => {
      applyDirectly = false;
      handleSubmit();
    });
    applyDirectBtn.addEventListener('click', () => {
      applyDirectly = true;
      handleSubmit();
    });



    cancelBtn.addEventListener('click', close);
    closeBtn.addEventListener('click', close);
    modalEl.addEventListener('click', (e) => {
      if (e.target === modalEl) close();
    });

    // Settings Panel Trigger
    if (settingsToggleBtn) {
      settingsToggleBtn.addEventListener('click', () => {
        if (global.AISettingsDialog) {
          global.AISettingsDialog.open();
        }
      });
    }

    // Bind reasoning selector buttons
    const reasoningBtns = modalEl.querySelectorAll('.ai-reasoning-btn');
    reasoningBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        reasoningBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        selectedLevel = btn.getAttribute('data-level');
        localStorage.setItem('aiSearchReasoningLevel', selectedLevel);
      });
    });
    // Bind example links to fill input
    const exampleLinks = modalEl.querySelectorAll('.example-link');
    exampleLinks.forEach(link => {
      link.addEventListener('click', () => {
        textInput.value = link.textContent;
        handleTextInput();
        textInput.focus();
      });
    });
    // Hover tooltip binding using global logic-tooltip element
    const helpTrigger = document.getElementById('ai-search-help-trigger');
    let globalTooltip = document.getElementById('fb-global-logic-tooltip');
    if (!globalTooltip) {
      globalTooltip = document.createElement('div');
      globalTooltip.id = 'fb-global-logic-tooltip';
      globalTooltip.className = 'logic-tooltip';
      globalTooltip.style.display = 'none';
      document.body.appendChild(globalTooltip);
    }

    if (helpTrigger) {
      helpTrigger.onmouseenter = () => {
        if (window.LayerManager) {
          globalTooltip.innerHTML = helpTrigger.getAttribute('data-tooltip-html');
          const rect = helpTrigger.getBoundingClientRect();
          globalTooltip.style.position = 'absolute';
          globalTooltip.style.top = (rect.bottom + window.scrollY + 6) + 'px';
          globalTooltip.style.left = (rect.left + window.scrollX - 10) + 'px';
          globalTooltip.style.display = 'block';
          window.LayerManager.open(globalTooltip, helpTrigger, { isPopover: true, direction: 'bottom' });
        }
      };
      helpTrigger.onmouseleave = () => {
        if (window.LayerManager) {
          globalTooltip.style.display = 'none';
          window.LayerManager.close(globalTooltip);
        }
      };
    }

    // Setup help sidebar toggle preference
    let hideHelp = localStorage.getItem('aiSearchHideHelp') === 'true';

    function updateHelpLayout() {
      const sidebar = modalEl.querySelector('.ai-tutorial-sidebar');
      const card = modalEl.querySelector('.ai-modal-card');
      const toggleText = document.getElementById('ai-search-toggle-help-text');
      const toggleBtn = document.getElementById('ai-search-toggle-help-btn');
      
      if (hideHelp) {
        if (sidebar) sidebar.style.display = 'none';
        if (card) card.style.width = '480px';
        if (toggleText) toggleText.textContent = 'Show Help';
        if (toggleBtn) {
          toggleBtn.style.borderColor = 'var(--line, #333)';
          toggleBtn.style.color = 'var(--muted, #aaa)';
        }
      } else {
        if (sidebar) sidebar.style.display = 'flex';
        if (card) card.style.width = '720px';
        if (toggleText) toggleText.textContent = 'Hide Help';
        if (toggleBtn) {
          toggleBtn.style.borderColor = 'var(--accent, #a855f7)';
          toggleBtn.style.color = 'var(--accent, #a855f7)';
        }
      }
    }

    // Apply layout on load
    updateHelpLayout();

    const toggleHelpBtn = document.getElementById('ai-search-toggle-help-btn');
    if (toggleHelpBtn) {
      toggleHelpBtn.addEventListener('click', () => {
        hideHelp = !hideHelp;
        localStorage.setItem('aiSearchHideHelp', hideHelp ? 'true' : 'false');
        updateHelpLayout();
      });
    }

    backgroundCloseBtn.onclick = () => {
      backgroundStatusEl.style.display = 'none';
    };
    backgroundDismissBtn.onclick = () => {
      backgroundStatusEl.style.display = 'none';
    };
    backgroundActionBtn.onclick = () => {
      backgroundStatusEl.style.display = 'none';
      if (currentResult) {
        localStorage.removeItem('fbDraftFilter');
        global.FilterBuilderModal.open(currentResult.ir, (newIR) => {
          if (window.filterManager) {
            window.filterManager.setIR(newIR);
          }
        });
        currentResult = null;
      }
    };
  }

  const DEFAULT_GEMINI_MODELS = [
    'gemini-3.1-flash-lite',
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-2.0-pro-exp',
    'gemini-1.5-flash',
    'gemini-1.5-pro'
  ];

  const DEFAULT_OPENAI_MODELS = [
    'gpt-4o-mini',
    'gpt-4o',
    'o1-mini',
    'o1',
    'o3-mini'
  ];

  let allAvailableModels = [];
  let hideModelDropdown = () => {};

  async function testConnection(type, apiKey, endpoint) {
    let url = '';
    let headers = { 'Content-Type': 'application/json' };
    
    if (type === 'openai') {
      let baseUrl = endpoint || 'https://api.openai.com';
      if (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);
      if (baseUrl.endsWith('/chat/completions')) {
        baseUrl = baseUrl.slice(0, -17);
      } else if (baseUrl.endsWith('/v1')) {
        baseUrl = baseUrl.slice(0, -3);
      }
      url = `${baseUrl}/v1/models`;
      headers['Authorization'] = `Bearer ${apiKey}`;
    } else {
      let baseUrl = endpoint || 'https://generativelanguage.googleapis.com';
      if (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);
      url = `${baseUrl}/v1/models?key=${apiKey}`;
    }

    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
          action: 'fetchCloudAI',
          url,
          method: 'GET',
          headers
        }, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!response) {
            reject(new Error("No response received from background script"));
            return;
          }
          if (response.status !== 200) {
            let errMsg = response.text;
            try {
              const parsed = JSON.parse(response.text);
              if (parsed.error && parsed.error.message) errMsg = parsed.error.message;
            } catch (e) {}
            reject(new Error(`API returned status ${response.status}: ${errMsg}`));
            return;
          }
          try {
            resolve(JSON.parse(response.text));
          } catch (e) {
            reject(new Error("Failed to parse API JSON response"));
          }
        });
      });
    } else {
      const res = await fetch(url, { method: 'GET', headers });
      if (!res.ok) {
        const text = await res.text();
        let errMsg = text;
        try {
          const parsed = JSON.parse(text);
          if (parsed.error && parsed.error.message) errMsg = parsed.error.message;
        } catch (e) {}
        throw new Error(`API returned status ${res.status}: ${errMsg}`);
      }
      return res.json();
    }
  }

  let localProviders = [];
  let activeLocalId = null;

  let settingsModalEl = null;
  let settingsConnectionsList = null;
  let settingsAddConnBtn = null;
  let settingsFormEmptyState = null;
  let settingsFormContent = null;
  let settingsConnNameInput = null;
  let settingsCloudTypeSelect = null;
  let settingsApiKeyInput = null;
  let settingsTestKeyBtn = null;
  let settingsVerifyStatusEl = null;
  let settingsKeyHintEl = null;
  let settingsEndpointInput = null;
  let settingsModelInput = null;
  let settingsModelDropdown = null;
  let settingsDeleteConnBtn = null;
  let settingsSaveBtn = null;
  let settingsCancelBtn = null;
  let settingsCloseBtn = null;

  function initSettingsDOM() {
    if (settingsModalEl) return;

    settingsModalEl = document.createElement('div');
    settingsModalEl.id = 'ai-settings-modal';
    settingsModalEl.className = 'ai-modal-overlay';
    settingsModalEl.style.display = 'none';

    settingsModalEl.innerHTML = `
      <div class="ai-modal-card ai-settings-modal-card" style="width: 760px; max-width: 95vw;">
        <div class="ai-modal-header">
          <h3 class="ai-modal-title" style="display:flex; align-items:center; gap:6px;">
            <span style="color:#a855f7; display:flex; align-items:center;"><ui-icon name="settings"></ui-icon></span>
            AI Search Configuration <span class="ai-beta-badge-text">BETA</span>
          </h3>
          <button class="ai-modal-close" id="ai-settings-close-btn">&times;</button>
        </div>
        <div class="ai-settings-container" style="display: flex; flex-direction: row; height: 480px; align-items: stretch; background: var(--panel, #1e1e1e);">
          
          <!-- Left Pane: Connection List -->
          <div class="ai-settings-sidebar" style="width: 220px; border-right: 1px solid var(--line, #333); display: flex; flex-direction: column; padding: 12px; gap: 10px; flex-shrink: 0; box-sizing: border-box;">
            <div style="font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted, #888); margin-bottom: 4px;">API Connections</div>
            <div id="ai-settings-connections-list" style="display: flex; flex-direction: column; gap: 6px; flex: 1; overflow-y: auto;">
              <!-- Connection items rendered here -->
            </div>
            <button class="btn btn-secondary btn-sm" id="ai-settings-add-conn-btn" style="width: 100%; display: flex; align-items: center; justify-content: center; gap: 4px; font-size: 0.78rem; padding: 6px 0; font-weight: 600; border-radius: 6px; cursor: pointer;">
              <span style="display:inline-flex; align-items:center; font-size:1.1em; font-weight: bold;">+</span> Add Connection
            </button>
          </div>

          <!-- Right Pane: Edit Form -->
          <div class="ai-settings-form-pane" style="flex: 1; display: flex; flex-direction: column; padding: 16px; gap: 14px; overflow-y: auto; box-sizing: border-box;">
            <div id="ai-settings-form-empty-state" style="display: none; flex: 1; align-items: center; justify-content: center; flex-direction: column; color: var(--muted, #888); text-align: center; gap: 8px; height: 100%;">
              <span style="font-size: 1.5rem; opacity: 0.5; color: #a855f7;"><ui-icon name="cloud"></ui-icon></span>
              <span>No connection selected. Add or select a connection to edit.</span>
            </div>
            <div id="ai-settings-form-content" style="display: flex; flex-direction: column; gap: 12px;">
              <div class="ai-settings-instructions" style="font-size: 0.76rem; background: var(--panel2, rgba(255,255,255,0.02)); border: 1px solid var(--line, #333); padding: 8px 10px; border-radius: 8px; color: var(--muted, #aaa); line-height: 1.35; margin-bottom: 2px;">
                Configure connection endpoint and model parameters below. API keys are stored securely in local browser storage.
              </div>
              
              <div class="ai-settings-row" style="display:flex; flex-direction:column; gap:4px;">
                <label style="font-size:0.82rem; font-weight:600; color:var(--txt);">Connection Name</label>
                <input type="text" id="ai-settings-conn-name" placeholder="e.g. My Gemini Connection" style="padding:6px; background:var(--field, #121212); border:1px solid var(--line, #333); border-radius:4px; color:var(--txt); font-size: 0.85rem;">
              </div>

              <div class="ai-settings-row" style="display:flex; flex-direction:column; gap:4px;">
                <label style="font-size:0.82rem; font-weight:600; color:var(--txt);">Cloud Provider Type</label>
                <select id="ai-settings-cloud-type" style="padding:6px; background:var(--field, #121212); border:1px solid var(--line, #333); border-radius:4px; color:var(--txt); font-size: 0.85rem;">
                  <option value="gemini">Google Gemini API</option>
                  <option value="openai">OpenAI (or Compatible)</option>
                </select>
              </div>

              <div class="ai-settings-row" style="display:flex; flex-direction:column; gap:4px;">
                <label style="font-size:0.82rem; font-weight:600; color:var(--txt);">API Key / Token</label>
                <div style="display:flex; gap:6px;">
                  <input type="password" id="ai-settings-api-key" placeholder="Paste your API Key here" style="flex:1; padding:6px; background:var(--field, #121212); border:1px solid var(--line, #333); border-radius:4px; color:var(--txt); font-size: 0.85rem;">
                  <button class="btn btn-secondary btn-sm" id="ai-settings-test-key-btn" style="padding:0 10px; font-size:0.75rem; height:28px; border-radius:4px; font-weight:600;">Verify</button>
                </div>
                <div id="ai-settings-key-hint" style="font-size:0.72rem; color:var(--muted, #888); margin-top:2px;"></div>
                <div id="ai-settings-verify-status" style="font-size:0.72rem; display:none; margin-top:2px;"></div>
              </div>

              <div class="ai-settings-row" style="display:flex; flex-direction:column; gap:4px;">
                <label style="font-size:0.82rem; font-weight:600; color:var(--txt);">API Endpoint (Optional)</label>
                <input type="text" id="ai-settings-endpoint" placeholder="e.g. https://generativelanguage.googleapis.com" style="padding:6px; background:var(--field, #121212); border:1px solid var(--line, #333); border-radius:4px; color:var(--txt); font-size: 0.85rem;">
              </div>

              <div class="ai-settings-row" style="display:flex; flex-direction:column; gap:4px; position:relative;">
                <label style="font-size:0.82rem; font-weight:600; color:var(--txt);">Model Name</label>
                <div class="f-dropdown-container" style="display:flex; flex-direction:column; width:100%; position:relative;">
                  <input type="text" id="ai-settings-model" placeholder="e.g. gemini-3.1-flash-lite" style="width:100%; padding:6px; background:var(--field, #121212); border:1px solid var(--line, #333); border-radius:4px; color:var(--txt); box-sizing:border-box; font-size: 0.85rem;">
                  <div id="ai-settings-model-dropdown" class="f-dropdown" style="display:none; position:absolute; left:0; top:100%; width:100%; max-height:140px; overflow-y:auto; box-sizing:border-box; z-index:9600;"></div>
                </div>
              </div>

              <div style="margin-top: 6px;">
                <button class="btn btn-sm" id="ai-settings-delete-conn-btn" style="background:transparent; border:1px solid #ef4444; color:#ef4444; font-size:0.75rem; padding:4px 10px; border-radius:4px; font-weight:600; display:flex; align-items:center; gap:4px; cursor:pointer;">
                  Delete Connection
                </button>
              </div>
            </div>

          </div>
        </div>
        <div class="ai-modal-footer" style="display: flex; gap: 8px; justify-content: flex-end; padding: 12px 20px; border-top: 1px solid var(--line, #333); background: var(--panel, #1e1e1e);">
          <button class="btn btn-secondary" id="ai-settings-cancel-btn">Cancel</button>
          <button class="btn btn-primary" id="ai-settings-save-btn" style="background: #7209b7; border-color: #7209b7;">Save Config</button>
        </div>
      </div>
    `;

    document.body.appendChild(settingsModalEl);

    settingsConnectionsList = document.getElementById('ai-settings-connections-list');
    settingsAddConnBtn = document.getElementById('ai-settings-add-conn-btn');
    settingsFormEmptyState = document.getElementById('ai-settings-form-empty-state');
    settingsFormContent = document.getElementById('ai-settings-form-content');
    settingsConnNameInput = document.getElementById('ai-settings-conn-name');
    settingsCloudTypeSelect = document.getElementById('ai-settings-cloud-type');
    settingsApiKeyInput = document.getElementById('ai-settings-api-key');
    settingsTestKeyBtn = document.getElementById('ai-settings-test-key-btn');
    settingsVerifyStatusEl = document.getElementById('ai-settings-verify-status');
    settingsKeyHintEl = document.getElementById('ai-settings-key-hint');
    settingsEndpointInput = document.getElementById('ai-settings-endpoint');
    settingsModelInput = document.getElementById('ai-settings-model');
    
    // Create the dropdown programmatically and append to the overlay backdrop so it escapes form pane clipping
    settingsModelDropdown = document.createElement('div');
    settingsModelDropdown.id = 'ai-settings-model-dropdown';
    settingsModelDropdown.className = 'f-dropdown';
    settingsModelDropdown.style.display = 'none';
    settingsModelDropdown.style.position = 'fixed';
    settingsModelDropdown.style.maxHeight = '140px';
    settingsModelDropdown.style.overflowY = 'auto';
    settingsModelDropdown.style.boxSizing = 'border-box';
    settingsModelDropdown.style.zIndex = '9600';
    settingsModalEl.appendChild(settingsModelDropdown);

    settingsDeleteConnBtn = document.getElementById('ai-settings-delete-conn-btn');
    settingsSaveBtn = document.getElementById('ai-settings-save-btn');
    settingsCancelBtn = document.getElementById('ai-settings-cancel-btn');
    settingsCloseBtn = document.getElementById('ai-settings-close-btn');

    settingsCloudTypeSelect.addEventListener('change', () => {
      if (settingsCloudTypeSelect.value === 'openai') {
        settingsEndpointInput.placeholder = 'e.g., https://api.openai.com/v1/chat/completions';
        if (!settingsModelInput.value.trim() || settingsModelInput.value === 'gemini-3.1-flash-lite') {
          settingsModelInput.value = 'gpt-4o-mini';
        }
        allAvailableModels = DEFAULT_OPENAI_MODELS;
      } else {
        settingsEndpointInput.placeholder = 'e.g., https://generativelanguage.googleapis.com';
        if (!settingsModelInput.value.trim() || settingsModelInput.value === 'gpt-4o-mini') {
          settingsModelInput.value = 'gemini-3.1-flash-lite';
        }
        allAvailableModels = DEFAULT_GEMINI_MODELS;
      }
      updateKeyHint();
      if (settingsModelDropdown.style.display !== 'none') {
        showModelDropdownImpl();
      }
    });

    settingsAddConnBtn.addEventListener('click', () => {
      if (localProviders.length >= 4) return;
      saveCurrentFormValues();
      const newId = 'custom-cloud-' + Date.now();
      const newConn = {
        id: newId,
        displayName: 'New Connection',
        providerType: 'gemini',
        apiKey: '',
        endpoint: '',
        modelName: 'gemini-3.1-flash-lite',
        isEnabled: true
      };
      localProviders.push(newConn);
      activeLocalId = newId;
      renderConnectionsList();
      loadSelectedConnectionToForm();
    });

    settingsDeleteConnBtn.addEventListener('click', async () => {
      const p = localProviders.find(item => item.id === activeLocalId);
      if (!p) return;

      const confirmFn = window.customConfirm || global.customConfirm;
      const isConfirmed = confirmFn ? await confirmFn(`Delete connection "${p.displayName}"?`, 'Confirm Delete') : confirm(`Delete connection "${p.displayName}"?`);
      if (!isConfirmed) return;

      localProviders = localProviders.filter(item => item.id !== activeLocalId);
      activeLocalId = localProviders.length > 0 ? localProviders[0].id : null;
      renderConnectionsList();
      loadSelectedConnectionToForm();
    });

    settingsCancelBtn.addEventListener('click', () => {
      AISettingsDialog.close();
    });
    settingsCloseBtn.addEventListener('click', () => {
      AISettingsDialog.close();
    });
    settingsModalEl.addEventListener('click', (e) => {
      if (e.target === settingsModalEl) AISettingsDialog.close();
    });

    function renderModelDropdown(filterText = '') {
      if (!settingsModelDropdown) return;
      settingsModelDropdown.innerHTML = '';
      
      const normalizedQuery = filterText.toLowerCase().trim();
      const filtered = allAvailableModels.filter(m => m.toLowerCase().includes(normalizedQuery));
      
      if (filtered.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'f-dropdown-item empty';
        empty.textContent = 'No matching models';
        settingsModelDropdown.appendChild(empty);
      } else {
        filtered.forEach(modelName => {
          const item = document.createElement('div');
          item.className = 'f-dropdown-item';
          item.textContent = modelName;
          
          item.addEventListener('click', (e) => {
            e.stopPropagation();
            settingsModelInput.value = modelName;
            hideModelDropdownImpl();
          });
          settingsModelDropdown.appendChild(item);
        });
      }
    }

    function showModelDropdownImpl() {
      if (!settingsModelDropdown || !settingsModelInput) return;
      renderModelDropdown(settingsModelInput.value);
      
      const rect = settingsModelInput.getBoundingClientRect();
      settingsModelDropdown.style.left = `${rect.left}px`;
      settingsModelDropdown.style.top = `${rect.bottom + 4}px`;
      settingsModelDropdown.style.width = `${rect.width}px`;
      settingsModelDropdown.style.display = 'flex';
      
      if (window.LayerManager) {
        window.LayerManager.open(settingsModelDropdown, null, { isPopover: true });
      }
    }

    function hideModelDropdownImpl() {
      if (!settingsModelDropdown) return;
      settingsModelDropdown.style.display = 'none';
      if (window.LayerManager) {
        window.LayerManager.close(settingsModelDropdown);
      }
    }
    
    hideModelDropdown = hideModelDropdownImpl;

    settingsModelInput.addEventListener('focus', () => {
      if (allAvailableModels.length > 0) {
        showModelDropdownImpl();
      }
    });

    settingsModelInput.addEventListener('input', () => {
      if (allAvailableModels.length > 0) {
        showModelDropdownImpl();
      }
    });

    document.addEventListener('mousedown', (e) => {
      if (!settingsModelDropdown || !settingsModelInput) return;
      if (!settingsModelDropdown.contains(e.target) && !settingsModelInput.contains(e.target)) {
        hideModelDropdownImpl();
      }
    });

    const formPane = settingsModalEl.querySelector('.ai-settings-form-pane');
    if (formPane) {
      formPane.addEventListener('scroll', () => {
        hideModelDropdownImpl();
      });
    }

    settingsTestKeyBtn.addEventListener('click', async () => {
      const type = settingsCloudTypeSelect.value;
      const apiKey = settingsApiKeyInput.value.trim();
      const endpoint = settingsEndpointInput.value.trim();

      if (!apiKey) {
        settingsVerifyStatusEl.style.display = 'block';
        settingsVerifyStatusEl.style.color = '#ef4444';
        settingsVerifyStatusEl.textContent = 'Please enter an API Key first.';
        return;
      }

      settingsVerifyStatusEl.style.display = 'block';
      settingsVerifyStatusEl.style.color = '#a855f7';
      settingsVerifyStatusEl.textContent = 'Verifying connection...';
      allAvailableModels = [];
      hideModelDropdownImpl();

      try {
        const result = await testConnection(type, apiKey, endpoint);
        let models = [];
        
        if (type === 'openai') {
          if (result.data && Array.isArray(result.data)) {
            models = result.data
              .map(m => m.id)
              .filter(id => id.includes('gpt') || id.includes('o1') || id.includes('o3') || id.includes('claude'));
          }
        } else {
          if (result.models && Array.isArray(result.models)) {
            models = result.models
              .map(m => {
                const name = m.name || '';
                return name.startsWith('models/') ? name.substring(7) : name;
              })
              .filter(name => name.includes('gemini') || name.includes('learnlm'));
          }
        }

        if (models.length === 0) {
          settingsVerifyStatusEl.style.color = '#eab308';
          settingsVerifyStatusEl.textContent = '✓ Connected, but no matching models were found.';
          return;
        }

        models.sort();
        allAvailableModels = models;

        settingsVerifyStatusEl.style.color = '#22c55e';
        settingsVerifyStatusEl.textContent = `✓ Connected! ${models.length} models loaded. Select from dropdown or type.`;
        showModelDropdownImpl();

      } catch (err) {
        settingsVerifyStatusEl.style.color = '#ef4444';
        settingsVerifyStatusEl.textContent = `❌ Verification failed: ${err.message}`;
      }
    });

    settingsSaveBtn.addEventListener('click', async () => {
      saveCurrentFormValues();
      
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        await chrome.storage.local.set({ ai_custom_providers: localProviders });

        // Ensure active provider choice is still valid
        let selected = 'chrome-prompt-api';
        const data = await chrome.storage.local.get(['ai_selected_provider']);
        if (data.ai_selected_provider) selected = data.ai_selected_provider;

        if (selected !== 'chrome-prompt-api' && !localProviders.some(p => p.id === selected)) {
          // Reset selected provider if deleted
          await chrome.storage.local.set({ ai_selected_provider: localProviders[0]?.id || 'chrome-prompt-api' });
        }
      }

      if (global.aiProviderRegistry) {
        await global.aiProviderRegistry.reloadCustomProviders();
      }
      
      AISettingsDialog.close();
      
      if (modalEl && modalEl.style.display !== 'none') {
        await updateAvailabilityUI();
      }
      if (window.updateAIFilterButtonState) {
        window.updateAIFilterButtonState();
      }
    });
  }

  function saveCurrentFormValues() {
    if (!activeLocalId) return;
    const p = localProviders.find(item => item.id === activeLocalId);
    if (!p) return;

    p.displayName = settingsConnNameInput.value.trim() || 'Untitled Connection';
    p.providerType = settingsCloudTypeSelect.value;
    p.apiKey = settingsApiKeyInput.value.trim();
    p.endpoint = settingsEndpointInput.value.trim();
    p.modelName = settingsModelInput.value.trim() || (p.providerType === 'openai' ? 'gpt-4o-mini' : 'gemini-3.1-flash-lite');
  }

  function renderConnectionsList() {
    if (!settingsConnectionsList) return;
    settingsConnectionsList.innerHTML = '';

    localProviders.forEach(p => {
      const item = document.createElement('div');
      item.className = `ai-settings-item ${p.id === activeLocalId ? 'active' : ''}`;
      
      // Determine badge color
      const isGemini = p.providerType === 'gemini';
      const badgeText = isGemini ? 'Gemini' : 'OpenAI';
      const badgeStyle = isGemini 
        ? 'background: rgba(168, 85, 247, 0.15); color: #c084fc; border: 1px solid rgba(168, 85, 247, 0.3);' 
        : 'background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.3);';

      item.style.cssText = `
        padding: 8px 10px;
        border-radius: 6px;
        cursor: pointer;
        display: flex;
        flex-direction: column;
        gap: 3px;
        border: 1px solid transparent;
        transition: all 0.15s ease-in-out;
        box-sizing: border-box;
      `;

      item.innerHTML = `
        <div style="font-size: 0.8rem; font-weight: 600; color: var(--txt); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${p.displayName}</div>
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 4px;">
          <span style="font-size: 0.6rem; font-weight: 600; border-radius: 4px; padding: 1px 4px; text-transform: uppercase; ${badgeStyle}">${badgeText}</span>
          <span style="font-size: 0.65rem; color: ${p.apiKey ? '#22c55e' : '#eab308'}; font-weight: 500;">${p.apiKey ? 'Configured' : 'Unconfigured'}</span>
        </div>
      `;

      item.addEventListener('click', () => {
        if (p.id === activeLocalId) return;
        saveCurrentFormValues();
        activeLocalId = p.id;
        renderConnectionsList();
        loadSelectedConnectionToForm();
      });

      // Hover styles via JavaScript for robustness
      item.addEventListener('mouseenter', () => {
        if (p.id !== activeLocalId) {
          item.style.backgroundColor = 'var(--panel2, rgba(255,255,255,0.03))';
          item.style.borderColor = 'var(--line, #333)';
        }
      });
      item.addEventListener('mouseleave', () => {
        if (p.id !== activeLocalId) {
          item.style.backgroundColor = 'transparent';
          item.style.borderColor = 'transparent';
        }
      });

      // Selected styles applied via CSS class but fallback inline style just in case
      if (p.id === activeLocalId) {
        item.style.backgroundColor = 'rgba(168, 85, 247, 0.08)';
        item.style.borderColor = '#a855f7';
      }

      settingsConnectionsList.appendChild(item);
    });

    if (settingsAddConnBtn) {
      if (localProviders.length >= 4) {
        settingsAddConnBtn.disabled = true;
        settingsAddConnBtn.style.opacity = '0.5';
        settingsAddConnBtn.style.cursor = 'not-allowed';
        settingsAddConnBtn.title = 'Maximum of 4 custom connections reached';
      } else {
        settingsAddConnBtn.disabled = false;
        settingsAddConnBtn.style.opacity = '1';
        settingsAddConnBtn.style.cursor = 'pointer';
        settingsAddConnBtn.title = '';
      }
    }
  }

  function updateKeyHint() {
    if (!settingsKeyHintEl || !settingsCloudTypeSelect) return;
    const type = settingsCloudTypeSelect.value;
    if (type === 'openai') {
      settingsKeyHintEl.innerHTML = `Get your API key at <a href="https://platform.openai.com/api-keys" target="_blank" style="color:#10b981; text-decoration:underline;">OpenAI API Keys</a>.`;
    } else {
      settingsKeyHintEl.innerHTML = `Get your API key at <a href="https://aistudio.google.com/" target="_blank" style="color:#a855f7; text-decoration:underline;">Google AI Studio</a>.`;
    }
  }

  function loadSelectedConnectionToForm() {
    if (!activeLocalId) {
      settingsFormEmptyState.style.display = 'flex';
      settingsFormContent.style.display = 'none';
      return;
    }

    settingsFormEmptyState.style.display = 'none';
    settingsFormContent.style.display = 'flex';

    const p = localProviders.find(item => item.id === activeLocalId);
    if (!p) return;

    settingsConnNameInput.value = p.displayName || '';
    settingsCloudTypeSelect.value = p.providerType || 'gemini';
    settingsApiKeyInput.value = p.apiKey || '';
    settingsEndpointInput.value = p.endpoint || '';
    settingsModelInput.value = p.modelName || '';
    settingsVerifyStatusEl.style.display = 'none';
    settingsVerifyStatusEl.textContent = '';
    allAvailableModels = p.providerType === 'openai' ? DEFAULT_OPENAI_MODELS : DEFAULT_GEMINI_MODELS;

    if (p.providerType === 'openai') {
      settingsEndpointInput.placeholder = 'e.g., https://api.openai.com/v1/chat/completions';
    } else {
      settingsEndpointInput.placeholder = 'e.g., https://generativelanguage.googleapis.com';
    }
    updateKeyHint();
  }

  async function loadSettingsToUI() {
    let configs = [];
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      const data = await chrome.storage.local.get(['ai_custom_providers']);
      configs = data.ai_custom_providers || [];
    }

    localProviders = configs.map(c => ({...c}));
    activeLocalId = localProviders.length > 0 ? localProviders[0].id : null;

    renderConnectionsList();
    loadSelectedConnectionToForm();
  }

  const AISettingsDialog = {
    open: function() {
      initSettingsDOM();
      loadSettingsToUI();
      settingsModalEl.style.display = 'flex';
      if (window.LayerManager) {
        window.LayerManager.open(settingsModalEl);
      }
    },
    close: function() {
      if (settingsModalEl) {
        if (typeof hideModelDropdown === 'function') {
          hideModelDropdown();
        }
        settingsModalEl.style.display = 'none';
        if (window.LayerManager) {
          window.LayerManager.close(settingsModalEl);
        }
      }
    }
  };
  global.AISettingsDialog = AISettingsDialog;

  function handleTextInput() {
    const val = textInput.value;
    document.getElementById('ai-char-count').textContent = val.length;

    // Check if input is valid and we are not downloading/generating
    const isGenerating = progressContainer.style.display === 'block' && !downloadProgressActive;
    if (val.trim().length > 0 && !isGenerating && !downloadProgressActive) {
      submitBtn.removeAttribute('disabled');
      applyDirectBtn.removeAttribute('disabled');
    } else {
      submitBtn.setAttribute('disabled', 'true');
      applyDirectBtn.setAttribute('disabled', 'true');
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!submitBtn.hasAttribute('disabled')) {
        applyDirectly = false;
        handleSubmit();
      }
    } else if (e.key === 'Escape') {
      close();
    }
  }

  async function updateProviderCardsUI() {
    const container = document.getElementById('ai-modal-tabs-container');
    if (!container) return;
    container.innerHTML = '';

    // Determine which tab is active based on storage
    let selectedProvider = 'chrome-prompt-api';
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      const data = await chrome.storage.local.get(['ai_selected_provider']);
      if (data.ai_selected_provider) selectedProvider = data.ai_selected_provider;
    }

    if (global.aiProviderRegistry) {
      await global.aiProviderRegistry.ensureInitialized();
    }
    const allProviders = global.aiProviderRegistry ? global.aiProviderRegistry.providers : [];

    // Helper to get globalTooltip
    let globalTooltip = document.getElementById('fb-global-logic-tooltip');
    if (!globalTooltip) {
      globalTooltip = document.createElement('div');
      globalTooltip.id = 'fb-global-logic-tooltip';
      globalTooltip.className = 'logic-tooltip';
      globalTooltip.style.display = 'none';
      document.body.appendChild(globalTooltip);
    }

    // 1. Render Gemini Nano Tab
    const nanoProvider = allProviders.find(p => p.id === 'chrome-prompt-api');
    if (nanoProvider) {
      const avail = await nanoProvider.getAvailability();
      let badgeText = 'Checking...';
      let badgeColor = '#eab308';
      if (avail === 'available' || avail === 'supported') {
        badgeText = '✓ Available';
        badgeColor = '#22c55e';
      } else if (avail === 'downloadable') {
        badgeText = '⬇ Downloadable';
        badgeColor = '#eab308';
      } else if (avail === 'downloading') {
        badgeText = '🔄 Downloading...';
        badgeColor = '#3b82f6';
      } else {
        badgeText = '❌ Unsupported';
        badgeColor = '#ef4444';
      }

      const nanoTab = document.createElement('div');
      nanoTab.className = `ai-modal-tab ${selectedProvider === 'chrome-prompt-api' ? 'active' : ''}`;
      nanoTab.id = 'ai-provider-tab-nano';
      nanoTab.innerHTML = `<span style="display:flex; align-items:center; color:#60a5fa;"><ui-icon name="sparkles"></ui-icon></span>`;
      
      nanoTab.onmouseenter = () => {
        if (window.LayerManager) {
          globalTooltip.innerHTML = `
            <div style="font-weight: 600; font-size: 0.85rem; margin-bottom: 2px;">Gemini Nano</div>
            <div style="font-size: 0.72rem; color: var(--muted, #888); margin-bottom: 4px;">Built-in Local AI</div>
            <div style="font-size: 0.72rem; font-weight: 500; color: ${badgeColor};">${badgeText}</div>
          `;
          globalTooltip.classList.add('right-tooltip');
          globalTooltip.style.transform = 'none'; // reset global CSS translate
          globalTooltip.style.display = 'block';
          const rect = nanoTab.getBoundingClientRect();
          const tooltipWidth = globalTooltip.offsetWidth || 180;
          const tooltipHeight = globalTooltip.offsetHeight || 60;
          globalTooltip.style.position = 'absolute';
          globalTooltip.style.top = (rect.top + window.scrollY + (rect.height - tooltipHeight) / 2) + 'px';
          globalTooltip.style.left = (rect.right + window.scrollX + 8) + 'px';
          window.LayerManager.open(globalTooltip, nanoTab, { isPopover: true, direction: 'right' });
        }
      };
      nanoTab.onmouseleave = () => {
        if (window.LayerManager) {
          globalTooltip.classList.remove('right-tooltip');
          globalTooltip.style.display = 'none';
          window.LayerManager.close(globalTooltip);
        }
      };

      nanoTab.addEventListener('click', () => selectProvider('chrome-prompt-api'));
      container.appendChild(nanoTab);
    }

    // 1b. ADO Atlas Cloud AI (Pro) placeholder tab — not yet live; opens the paywall.
    {
      const proTab = document.createElement('div');
      proTab.className = 'ai-modal-tab';
      proTab.id = 'ai-provider-tab-pro';
      proTab.style.position = 'relative';
      proTab.innerHTML = `<span style="display:flex; align-items:center; color:#f2a900;"><ui-icon name="cloud"></ui-icon></span><span class="pro-badge-tiny" style="position:absolute; top:-0.3rem; left:-0.3rem; pointer-events:none; z-index:5;"><ui-icon name="gem"></ui-icon>PRO</span>`;
      proTab.onmouseenter = () => {
        if (window.LayerManager) {
          globalTooltip.innerHTML = `
            <div style="font-weight: 600; font-size: 0.85rem; margin-bottom: 2px;">ADO Atlas Cloud AI</div>
            <div style="font-size: 0.72rem; color: var(--muted, #888); margin-bottom: 4px;">Cloud GPT / Claude via our proxy — no API key needed</div>
            <div style="font-size: 0.72rem; font-weight: 700; color: #f2a900;">PRO</div>
          `;
          globalTooltip.classList.add('right-tooltip');
          globalTooltip.style.transform = 'none';
          globalTooltip.style.display = 'block';
          const rect = proTab.getBoundingClientRect();
          const tooltipHeight = globalTooltip.offsetHeight || 60;
          globalTooltip.style.position = 'absolute';
          globalTooltip.style.top = (rect.top + window.scrollY + (rect.height - tooltipHeight) / 2) + 'px';
          globalTooltip.style.left = (rect.right + window.scrollX + 8) + 'px';
          window.LayerManager.open(globalTooltip, proTab, { isPopover: true, direction: 'right' });
        }
      };
      proTab.onmouseleave = () => {
        if (window.LayerManager) {
          globalTooltip.classList.remove('right-tooltip');
          globalTooltip.style.display = 'none';
          window.LayerManager.close(globalTooltip);
        }
      };
      proTab.addEventListener('click', () => { if (window.PremiumPaywall) window.PremiumPaywall.open('cloud_ai'); });
      container.appendChild(proTab);
    }

    // 2. Render Custom Cloud Connections (BYOK only). The hosted 'ado-atlas-cloud'
    // (Pro) provider holds no local config/key, so it is not a BYOK card — it gets
    // its own dedicated card in Stage 2 and is excluded here.
    const customProviders = allProviders.filter(p => p.id !== 'chrome-prompt-api' && p.id !== 'custom-cloud' && p.id !== 'ado-atlas-cloud');
    for (const provider of customProviders) {
      const isGemini = provider.config.providerType === 'gemini';
      const isConfigured = !!provider.config.apiKey;
      
      const badgeText = isConfigured ? '✓ Configured' : '⚙ Unconfigured';
      const badgeColor = isConfigured ? '#22c55e' : '#eab308';
      
      let subtitle = isGemini ? 'Google AI Studio' : 'OpenAI Platform';
      if (provider.config.endpoint) {
        try {
          const urlObj = new URL(provider.config.endpoint);
          subtitle = urlObj.hostname;
        } catch (e) {
          subtitle = 'Custom Endpoint';
        }
      }

      const tab = document.createElement('div');
      tab.className = `ai-modal-tab ${selectedProvider === provider.id ? 'active' : ''}`;
      tab.id = `ai-provider-tab-${provider.id}`;
      
      const iconColor = isGemini ? '#a855f7' : '#10b981';

      tab.innerHTML = `<span style="display:flex; align-items:center; color:${iconColor};"><ui-icon name="cloud"></ui-icon></span>`;
      
      tab.onmouseenter = () => {
        if (window.LayerManager) {
          globalTooltip.innerHTML = `
            <div style="font-weight: 600; font-size: 0.85rem; margin-bottom: 2px;">${provider.displayName}</div>
            <div style="font-size: 0.72rem; color: var(--muted, #888); margin-bottom: 4px;">${subtitle}</div>
            <div style="font-size: 0.72rem; font-weight: 500; color: ${badgeColor};">${badgeText}</div>
          `;
          globalTooltip.classList.add('right-tooltip');
          globalTooltip.style.transform = 'none'; // reset global CSS translate
          globalTooltip.style.display = 'block';
          const rect = tab.getBoundingClientRect();
          const tooltipWidth = globalTooltip.offsetWidth || 180;
          const tooltipHeight = globalTooltip.offsetHeight || 60;
          globalTooltip.style.position = 'absolute';
          globalTooltip.style.top = (rect.top + window.scrollY + (rect.height - tooltipHeight) / 2) + 'px';
          globalTooltip.style.left = (rect.right + window.scrollX + 8) + 'px';
          window.LayerManager.open(globalTooltip, tab, { isPopover: true, direction: 'right' });
        }
      };
      tab.onmouseleave = () => {
        if (window.LayerManager) {
          globalTooltip.classList.remove('right-tooltip');
          globalTooltip.style.display = 'none';
          window.LayerManager.close(globalTooltip);
        }
      };

      tab.addEventListener('click', () => selectProvider(provider.id));
      container.appendChild(tab);
    }

    // 3. Render Add/Config Tab
    const settingsTab = document.createElement('div');
    settingsTab.className = 'ai-modal-tab add-tab';
    settingsTab.id = 'ai-provider-tab-settings';
    settingsTab.style.marginTop = '12px'; // separator margin
    settingsTab.innerHTML = `<span style="display:flex; align-items:center; color:#a855f7; font-size:1.1rem;"><ui-icon name="plus"></ui-icon></span>`;
    
    settingsTab.onmouseenter = () => {
      if (window.LayerManager) {
        globalTooltip.innerHTML = `
          <div style="font-weight: 600; font-size: 0.85rem; margin-bottom: 2px;">Configure AI...</div>
          <div style="font-size: 0.72rem; color: var(--muted, #888);">Manage models and API connections</div>
        `;
        globalTooltip.classList.add('right-tooltip');
        globalTooltip.style.transform = 'none'; // reset global CSS translate
        globalTooltip.style.display = 'block';
        const rect = settingsTab.getBoundingClientRect();
        const tooltipWidth = globalTooltip.offsetWidth || 200;
        const tooltipHeight = globalTooltip.offsetHeight || 45;
        globalTooltip.style.position = 'absolute';
        globalTooltip.style.top = (rect.top + window.scrollY + (rect.height - tooltipHeight) / 2) + 'px';
        globalTooltip.style.left = (rect.right + window.scrollX + 8) + 'px';
        window.LayerManager.open(globalTooltip, settingsTab, { isPopover: true, direction: 'right' });
      }
    };
    settingsTab.onmouseleave = () => {
      if (window.LayerManager) {
        globalTooltip.classList.remove('right-tooltip');
        globalTooltip.style.display = 'none';
        window.LayerManager.close(globalTooltip);
      }
    };

    settingsTab.addEventListener('click', () => {
      if (global.AISettingsDialog) {
        global.AISettingsDialog.open();
      }
    });
    container.appendChild(settingsTab);
  }

  async function selectProvider(providerId) {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      await chrome.storage.local.set({ ai_selected_provider: providerId });
    }

    if (window.updateAIFilterButtonState) {
      window.updateAIFilterButtonState();
    }
    
    await updateAvailabilityUI();
  }

  async function updateAvailabilityUI() {
    if (!global.aiProviderRegistry) {
      showError("AI Service Layer is not initialized.");
      return;
    }

    await updateProviderCardsUI();
    activeProvider = await global.aiProviderRegistry.getActive();
    const helpTrigger = document.getElementById('ai-search-help-trigger');
    if (helpTrigger) {
      if (activeProvider && activeProvider.id === 'chrome-prompt-api') {
        helpTrigger.setAttribute('data-tooltip-html', 
          '<b>Privacy-First On-Device AI</b><br/><br/>' +
          'This feature runs <b>entirely locally</b> on your machine using Google Chrome\'s built-in Gemini Nano model.<br/><br/>' +
          '🔒 <b>100% Private & Secure:</b> Your queries, dynamic fields, and work item data never leave your browser and are never sent to external servers.'
        );
      } else {
        helpTrigger.setAttribute('data-tooltip-html', 
          '<b>Custom Cloud AI</b><br/><br/>' +
          'This feature calls your configured cloud AI endpoint (Google Gemini or OpenAI).<br/><br/>' +
          '🌐 <b>External Requests:</b> Your queries, dynamic fields, and work item metadata will be sent to the configured provider API to compile the search filters.'
        );
      }
    }

    if (!activeProvider) {
      showError("Chrome Built-in AI is not supported. Please configure a Custom Cloud AI provider under 'Configure AI...' to enable search.");
      textInput.setAttribute('disabled', 'true');
      submitBtn.setAttribute('disabled', 'true');
      applyDirectBtn.setAttribute('disabled', 'true');
      return;
    }

    const avail = await activeProvider.getAvailability();
    if (avail === 'unsupported') {
      showError("Built-in AI is unsupported on this device. Ensure your system meets hardware requirements (at least 22GB free space) and flags are enabled.");
      textInput.setAttribute('disabled', 'true');
      submitBtn.setAttribute('disabled', 'true');
      applyDirectBtn.setAttribute('disabled', 'true');
    } else if (avail === 'downloadable') {
      if (activeProvider.id === 'chrome-prompt-api') {
        showInfo("Built-in Gemini Nano model is ready to download. Searching will download the model first (~22MB download, ~250MB unpacked).");
        submitBtn.textContent = 'Download & Search';
      } else {
        showInfo("Custom Cloud provider requires configuration. Click 'Configure AI...' to input your API Key.");
        submitBtn.textContent = 'Search';
      }
      handleTextInput();
    } else if (avail === 'downloading') {
      showProgress("Downloading on-device AI model...", 0);
      submitBtn.setAttribute('disabled', 'true');
      applyDirectBtn.setAttribute('disabled', 'true');
      activeProvider.ensureReady((progress) => {
        showProgress("Downloading on-device AI model...", progress);
      }).then(() => {
        updateAvailabilityUI();
      }).catch(e => {
        showError("Model download failed: " + e.message);
      });
    } else {
      clearStatus();
      submitBtn.textContent = 'Search (Preview)';
      handleTextInput();
    }
  }

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.className = 'ai-error-message';
    errorEl.style.display = 'block';
  }

  function showInfo(msg) {
    errorEl.textContent = msg;
    errorEl.className = 'ai-info-message';
    errorEl.style.display = 'block';
  }

  function clearStatus() {
    errorEl.style.display = 'none';
    errorEl.textContent = '';
  }

  function showProgress(statusText, progressVal) {
    progressContainer.style.display = 'block';
    progressStatus.textContent = statusText;
    const pct = Math.round(progressVal * 100);
    document.getElementById('ai-search-percent-text').textContent = pct + '%';
    progressFill.style.width = pct + '%';
    submitBtn.setAttribute('disabled', 'true');
    applyDirectBtn.setAttribute('disabled', 'true');

    // Also update background status card
    if (backgroundStatusEl) {
      backgroundStatusText.textContent = statusText;
      backgroundPercentText.textContent = pct + '%';
      backgroundProgressFill.style.width = pct + '%';
      backgroundStatusEl.querySelector('.ai-bg-footer').style.display = 'none';

      if (!isDialogVisible) {
        backgroundStatusEl.style.display = 'flex';
      }
    }
  }

  function hideProgress() {
    progressContainer.style.display = 'none';
    progressFill.style.width = '0%';
    document.getElementById('ai-search-percent-text').textContent = '0%';
  }

  async function handleSubmit() {
    const query = textInput.value.trim();
    if (!query) return;

    clearStatus();
    textInput.setAttribute('disabled', 'true');
    submitBtn.setAttribute('disabled', 'true');
    applyDirectBtn.setAttribute('disabled', 'true');
    isSearchingActive = true;
    currentResult = null;

    try {
      const avail = await activeProvider.getAvailability();
      if (avail === 'downloadable' || avail === 'downloading') {
        downloadProgressActive = true;
        showProgress("Downloading on-device AI model (first-time only)...", 0);
        await activeProvider.ensureReady((progress) => {
          showProgress("Downloading on-device AI model...", progress);
        });
        downloadProgressActive = false;
      }

      showProgress("Generating filters with AI...", 0.0);
      
      const result = await global.aiSearchService.search(query, {
        reasoningLevel: selectedLevel,
        onProgress: (status, percent) => {
          showProgress(status, percent);
        }
      });
      isSearchingActive = false;
      
      hideProgress();
      
      if (isDialogVisible) {
        close();
        
        // Clear quick search input field when AI search successfully finishes and applies filters
        const searchInput = document.getElementById('search');
        if (searchInput) {
          searchInput.value = '';
          const clearBtn = document.getElementById('search-clear');
          if (clearBtn) clearBtn.style.display = 'none';
        }

        if (applyDirectly) {
          if (window.filterManager) {
            window.filterManager.setIR(result.ir);
          }
        } else {
          if (global.FilterBuilderModal) {
            if (result.warnings && result.warnings.length > 0) {
              const warnText = "AI Warnings:\n" + result.warnings.join("\n");
              if (window.customAlert) {
                window.customAlert(warnText, "AI Search Warning");
              } else {
                alert(warnText);
              }
            }
            localStorage.removeItem('fbDraftFilter');
            global.FilterBuilderModal.open(result.ir, (newIR) => {
              if (window.filterManager) {
                window.filterManager.setIR(newIR);
              }
            });
          }
        }
      } else {
        // Dialog is hidden, show background success card
        currentResult = result;
        if (backgroundStatusEl) {
          backgroundStatusText.textContent = "AI Search completed successfully!";
          backgroundPercentText.textContent = "100%";
          backgroundProgressFill.style.width = "100%";
          backgroundStatusEl.querySelector('.ai-bg-footer').style.display = 'flex';
          backgroundStatusEl.style.display = 'flex';
        }
      }
    } catch (e) {
      isSearchingActive = false;
      downloadProgressActive = false;
      hideProgress();
      
      if (isDialogVisible) {
        textInput.removeAttribute('disabled');
        handleTextInput();
        showError("Search failed: " + e.message);
      } else {
        if (backgroundStatusEl) {
          backgroundStatusText.textContent = "❌ AI Search failed: " + e.message;
          backgroundPercentText.textContent = "Error";
          backgroundProgressFill.style.width = "0%";
          backgroundStatusEl.style.display = 'flex';
        }
      }
    }
  }

  function open(initialQuery) {
    initDOM();
    isDialogVisible = true;
    modalEl.style.display = 'flex';
    
    // Hide background floating card when reopening
    backgroundStatusEl.style.display = 'none';
    
    // Pre-fill query or keep existing text
    if (initialQuery !== undefined && initialQuery !== '') {
      textInput.value = initialQuery;
    } else if (textInput.value) {
      // Keep whatever text is already written
    } else {
      textInput.value = '';
    }
    
    document.getElementById('ai-char-count').textContent = textInput.value.length;
    textInput.removeAttribute('disabled');
    submitBtn.setAttribute('disabled', 'true');
    hideProgress();
    clearStatus();

    // If search is currently active, sync the progress display
    if (isSearchingActive) {
      showProgress(progressStatus.textContent || "Processing...", parseFloat(progressFill.style.width) / 100);
    }

    if (window.LayerManager) {
      window.LayerManager.open(modalEl);
    }

    updateAvailabilityUI();
    
    setTimeout(() => textInput.focus(), 50);
  }

  function close() {
    if (!modalEl) return;
    modalEl.style.display = 'none';
    isDialogVisible = false;
    
    // Make sure to close the logic-tooltip popover if active
    const globalTooltip = document.getElementById('fb-global-logic-tooltip');
    if (globalTooltip && window.LayerManager) {
      globalTooltip.style.display = 'none';
      window.LayerManager.close(globalTooltip);
    }

    if (window.LayerManager) {
      window.LayerManager.close(modalEl);
    }
    
    // Show background floating status if search is running active
    if (isSearchingActive && backgroundStatusEl) {
      backgroundStatusEl.style.display = 'flex';
    }
  }

  function hasPendingResult() {
    return currentResult !== null;
  }

  function getPendingResult() {
    return currentResult ? currentResult.ir : null;
  }

  function clearPendingResult() {
    currentResult = null;
    if (backgroundStatusEl) {
      backgroundStatusEl.style.display = 'none';
    }
  }

  async function applyPendingResult() {
    if (currentResult) {
      const draftStr = localStorage.getItem('fbDraftFilter');
      let hasDraft = false;
      if (draftStr) {
        try {
          const draft = JSON.parse(draftStr);
          if (draft && draft.where && draft.where.rules && draft.where.rules.length > 0) {
            if (draft.where.rules.some(r => r.rules && r.rules.length > 0)) {
              hasDraft = true;
            }
          }
        } catch (e) {}
      }

      if (hasDraft && window.customConfirm) {
        const confirm = await window.customConfirm(
          "You have unsaved draft filters. Overwrite them with the AI search results?",
          "Overwrite Draft"
        );
        if (!confirm) return;
      }

      const ir = currentResult.ir;
      clearPendingResult();
      localStorage.removeItem('fbDraftFilter');
      if (global.FilterBuilderModal) {
        global.FilterBuilderModal.open(ir, (newIR) => {
          if (window.filterManager) {
            window.filterManager.setIR(newIR);
          }
        });
      }
    }
  }

  // Export Dialog UI
  global.AISearchDialog = {
    open,
    close,
    hasPendingResult,
    getPendingResult,
    clearPendingResult,
    applyPendingResult
  };

})(typeof globalThis !== 'undefined' ? globalThis : window);

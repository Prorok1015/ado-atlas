(function(global) {
  'use strict';

  let modalEl = null;
  let textInput = null;
  let submitBtn = null;
  let cancelBtn = null;
  let closeBtn = null;
  let progressContainer = null;
  let progressFill = null;
  let progressStatus = null;
  let errorEl = null;
  let activeProvider = null;
  let downloadProgressActive = false;
  let selectedLevel = 'auto';

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
      <div class="ai-modal-card">
        <div class="ai-modal-header">
          <h3 class="ai-modal-title">
            <span class="ai-sparkles-icon" style="color:#a855f7; display:flex; align-items:center;"><ui-icon name="sparkles"></ui-icon></span> AI Search
            <span class="logic-hint" id="ai-search-help-trigger" style="cursor: pointer; display: flex; align-items: center;" data-tooltip-html="<b>Privacy-First On-Device AI</b><br/><br/>This feature runs <b>entirely locally</b> on your machine using Google Chrome's built-in Gemini Nano model.<br/><br/>🔒 <b>100% Private & Secure:</b> Your queries, dynamic fields, and work item data never leave your browser and are never sent to external servers.">
              <ui-icon name="help"></ui-icon>
            </span>
          </h3>
          <button class="ai-modal-close" id="ai-search-close-btn">&times;</button>
        </div>
        <div class="ai-modal-body">
          <div class="ai-modal-desc">
            Describe what you're looking for in plain language (English or Russian), and AI will configure the search filters for you.
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
        <div class="ai-modal-footer">
          <button class="btn btn-secondary" id="ai-search-cancel-btn">Cancel</button>
          <button class="btn btn-primary" id="ai-search-submit-btn" disabled>Search</button>
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
    cancelBtn = document.getElementById('ai-search-cancel-btn');
    closeBtn = document.getElementById('ai-search-close-btn');
    progressContainer = document.getElementById('ai-search-progress');
    progressFill = document.getElementById('ai-search-progress-fill');
    progressStatus = document.getElementById('ai-search-status-text');
    errorEl = document.getElementById('ai-search-error-msg');

    backgroundProgressFill = document.getElementById('ai-bg-progress-fill');
    backgroundPercentText = document.getElementById('ai-bg-percent');
    backgroundStatusText = document.getElementById('ai-bg-status-text');
    backgroundCloseBtn = document.getElementById('ai-bg-close-btn');
    backgroundActionBtn = document.getElementById('ai-bg-action-btn');
    const backgroundDismissBtn = document.getElementById('ai-bg-dismiss-btn');

    // Bind event handlers
    textInput.addEventListener('input', handleTextInput);
    textInput.addEventListener('keydown', handleKeyDown);
    submitBtn.addEventListener('click', handleSubmit);
    cancelBtn.addEventListener('click', close);
    closeBtn.addEventListener('click', close);
    modalEl.addEventListener('click', (e) => {
      if (e.target === modalEl) close();
    });

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

  function handleTextInput() {
    const val = textInput.value;
    document.getElementById('ai-char-count').textContent = val.length;

    // Check if input is valid and we are not downloading/generating
    const isGenerating = progressContainer.style.display === 'flex' && !downloadProgressActive;
    if (val.trim().length > 0 && !isGenerating && !downloadProgressActive) {
      submitBtn.removeAttribute('disabled');
    } else {
      submitBtn.setAttribute('disabled', 'true');
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!submitBtn.hasAttribute('disabled')) {
        handleSubmit();
      }
    } else if (e.key === 'Escape') {
      close();
    }
  }

  async function updateAvailabilityUI() {
    if (!global.aiProviderRegistry) {
      showError("AI Service Layer is not initialized.");
      return;
    }

    activeProvider = await global.aiProviderRegistry.getActive();
    if (!activeProvider) {
      showError("Chrome Built-in AI is not supported. Please ensure you are running Chrome 131+ and have enabled prompt-api-for-gemini-nano flags.");
      textInput.setAttribute('disabled', 'true');
      submitBtn.setAttribute('disabled', 'true');
      return;
    }

    const avail = await activeProvider.getAvailability();
    if (avail === 'unsupported') {
      showError("Built-in AI is unsupported on this device. Ensure your system meets hardware requirements (at least 22GB free space) and flags are enabled.");
      textInput.setAttribute('disabled', 'true');
      submitBtn.setAttribute('disabled', 'true');
    } else if (avail === 'downloadable') {
      showInfo("Built-in Gemini Nano model is ready to download. Searching will download the model first (~22MB download, ~250MB unpacked).");
      submitBtn.textContent = 'Download & Search';
    } else if (avail === 'downloading') {
      showProgress("Downloading on-device AI model...", 0);
      submitBtn.setAttribute('disabled', 'true');
      activeProvider.ensureReady((progress) => {
        showProgress("Downloading on-device AI model...", progress);
      }).then(() => {
        updateAvailabilityUI();
      }).catch(e => {
        showError("Model download failed: " + e.message);
      });
    } else {
      clearStatus();
      submitBtn.textContent = 'Search';
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

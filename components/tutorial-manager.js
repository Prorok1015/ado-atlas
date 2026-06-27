function positionPopover(popoverEl, targetEl, position) {
  const tr = targetEl.getBoundingClientRect();
  const pr = popoverEl.getBoundingClientRect();
  let top = 0, left = 0;

  switch (position) {
    case 'top':
      top = tr.top - pr.height - 8;
      left = tr.left + (tr.width - pr.width) / 2;
      break;
    case 'bottom':
      top = tr.bottom + 8;
      left = tr.left + (tr.width - pr.width) / 2;
      break;
    case 'left':
      top = tr.top + (tr.height - pr.height) / 2;
      left = tr.left - pr.width - 8;
      break;
    case 'right':
      top = tr.top + (tr.height - pr.height) / 2;
      left = tr.right + 8;
      break;
  }

  // Handle screen boundary constraints
  left = Math.max(8, Math.min(left, window.innerWidth - pr.width - 8));
  top = Math.max(8, Math.min(top, window.innerHeight - pr.height - 8));

  popoverEl.style.top = `${top + window.scrollY}px`;
  popoverEl.style.left = `${left + window.scrollX}px`;
}

class TutorialManager {
  constructor() {
    this.registry = {};
    this.seen = {};
    this.currentTutorial = null;
    this.currentStepIndex = 0;
    this.backdrop = null;
    this.popover = null;
    this.highlightedElement = null;
    this.highlightedElementOriginalPosition = null;
    this.waitTimeout = null;
    this.elevatedAncestors = [];
  }

  async init() {
    try {
      const response = await fetch(chrome.runtime.getURL('components/tutorials.json'));
      this.registry = await response.json();
    } catch (e) {
      console.error('Failed to load tutorials registry:', e);
      return;
    }

    const data = await chrome.storage.local.get("tutorials_seen");
    this.seen = data.tutorials_seen || {};

    // Check if there are unseen tutorials
    const unseenIds = Object.keys(this.registry).filter(id => !this.seen[id]);
    
    if (unseenIds.length > 0 && !window.tutorialPromptShown) {
      window.tutorialPromptShown = true;
      this.showStartupPrompt(unseenIds);
    } else {
      this.checkAvailableTutorials();
    }

    // Re-check when user interacts (e.g. opens a panel/sidebar)
    // Using capture phase (true) to bypass stopPropagation() on elements like #morebtn
    document.addEventListener('click', () => {
      setTimeout(() => this.checkAvailableTutorials(), 150);
    }, true);

    // Bind to the Replay Tours button
    const tutBtn = document.getElementById('tutorialbtn');
    if (tutBtn) {
      tutBtn.onclick = () => this.showReplayModal();
    }
  }

  showStartupPrompt(unseenIds) {
    if (document.querySelector('.tut-prompt-overlay')) return;

    const overlay = document.createElement('div');
    overlay.className = 'tut-prompt-overlay';
    
    const listHtml = unseenIds.map(id => {
      const name = this.registry[id]?.title || id;
      return `<div class="tut-prompt-item"><span class="dot"></span>${name}</div>`;
    }).join('');

    overlay.innerHTML = `
      <div class="tut-prompt-box">
        <h2><ui-icon name="smile"></ui-icon> Welcome to ADO Atlas!</h2>
        <p>Would you like to keep interactive tutorials enabled to guide you through the features, or skip them all?</p>
        <p class="tut-prompt-hint"><ui-icon name="lightbulb"></ui-icon> You can always manage and replay tours from <strong>Settings → Interactive Tours</strong></p>
        <div class="tut-prompt-list">
          ${listHtml}
        </div>
        <div class="tut-prompt-buttons">
          <button class="tut-btn tut-prompt-skip">Skip All</button>
          <button class="tut-btn tut-btn-primary tut-prompt-start">Keep Tutorials</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    overlay.querySelector('.tut-prompt-skip').onclick = async () => {
      overlay.remove();
      const data = await chrome.storage.local.get("tutorials_seen");
      const seen = data.tutorials_seen || {};
      for (const id of unseenIds) {
        seen[id] = true;
        this.seen[id] = true;
      }
      await chrome.storage.local.set({ tutorials_seen: seen });
      this.checkAvailableTutorials();
    };

    overlay.querySelector('.tut-prompt-start').onclick = () => {
      overlay.remove();
      this.checkAvailableTutorials();
    };
  }

  showReplayModal() {
    if (document.querySelector('.tut-prompt-overlay')) return;

    // Close settings popover so it doesn't overlap
    const morePanel = document.querySelector('#morepanel');
    if (morePanel) {
      morePanel.style.display = 'none';
      const moreBtn = document.querySelector('#morebtn');
      if (moreBtn) moreBtn.classList.remove('on');
      if (window.LayerManager) window.LayerManager.close(morePanel);
    }

    const overlay = document.createElement('div');
    overlay.className = 'tut-prompt-overlay';
    overlay.addEventListener('mousedown', e => e.stopPropagation());
    
    const itemsHtml = Object.keys(this.registry).map(id => {
      const name = this.registry[id]?.title || id;
      const isCompleted = !!this.seen[id];
      const statusText = isCompleted ? '<ui-icon name="check-circle"></ui-icon> Completed' : '<ui-icon name="clock"></ui-icon> New';
      return `
        <div class="tut-replay-item" style="display:flex; justify-content:space-between; align-items:center; gap:12px; font-size:0.846rem; border-bottom:1px solid var(--line); padding:8px 0;">
          <span>${name} <small style="color:var(--muted); font-size:0.75rem;">(${statusText})</small></span>
          <button class="tut-btn tut-replay-start" data-id="${id}" style="padding:4px 8px;">Run</button>
        </div>
      `;
    }).join('');

    overlay.innerHTML = `
      <div class="tut-prompt-box" style="width: 25rem;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <h2 style="margin:0;"><ui-icon name="book"></ui-icon> Feature Tours</h2>
          <button class="tut-btn tut-close-replay" style="border:none; background:transparent; font-size:1.1rem; padding:0; cursor:pointer; color:var(--txt);">✕</button>
        </div>
        <p>Select any tour to replay it. Follow the highlights to explore the features.</p>
        <div class="tut-replay-list" style="display:flex; flex-direction:column; max-height:200px; overflow-y:auto;">
          ${itemsHtml}
        </div>
        <div class="tut-prompt-buttons" style="margin-top:8px;">
          <button class="tut-btn tut-replay-reset-all" style="margin-right:auto;">Reset All</button>
          <button class="tut-btn tut-btn-primary tut-close-replay">Close</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    overlay.querySelectorAll('.tut-close-replay').forEach(btn => {
      btn.onclick = () => overlay.remove();
    });
    
    // Bind Start buttons
    overlay.querySelectorAll('.tut-replay-start').forEach(btn => {
      btn.onclick = () => {
        const id = btn.dataset.id;
        overlay.remove();
        
        // Temporarily mark as unseen so we can run it
        delete this.seen[id];
        
        // Handle contextual triggers before starting
        if (id === 'v1.2.0_display_settings') {
          const moreBtn = document.querySelector('#morebtn');
          const morePanel = document.querySelector('#morepanel');
          if (moreBtn && morePanel && morePanel.style.display === 'none') {
            moreBtn.click();
          }
        }
        
        if (id === 'v1.2.0_sidebar_features') {
          const side = document.querySelector('#side');
          if (side && side.classList.contains('hidden')) {
            if (window.customAlert) {
              window.customAlert('Please click on any work item to open the sidebar and start the sidebar tour.', 'Sidebar Tour');
            } else {
              alert('Please click on any work item to open the sidebar and start the sidebar tour.');
            }
          }
        }

        if (id === 'v1.2.0_advanced_filter_syntax') {
          const advBtn = document.querySelector('#advanced_filter_btn');
          if (advBtn) {
            advBtn.click();
          }
        }

        this.start(id, this.registry[id]);
      };
    });

    overlay.querySelector('.tut-replay-reset-all').onclick = async () => {
      overlay.remove();
      await chrome.storage.local.remove("tutorials_seen");
      this.seen = {};
      this.checkAvailableTutorials();
    };
  }

  checkAvailableTutorials() {
    if (this.currentTutorial || document.querySelector('.tut-prompt-overlay')) return; // Already running a tutorial or prompt is open

    for (const [id, config] of Object.entries(this.registry)) {
      if (!this.seen[id]) {
        // Look up target of the first step
        const firstStep = config.steps[0];
        const target = document.querySelector(firstStep.element);
        if (target) {
          const rect = target.getBoundingClientRect();
          const isVisible = rect.width > 0 && rect.height > 0;
          if (isVisible) {
            this.start(id, config);
            break;
          }
        }
      }
    }
  }

  start(id, config) {
    this.currentTutorial = { id, ...config };
    this.currentStepIndex = 0;
    this.showStep();
  }

  showStep() {
    this.cleanupStep();

    const step = this.currentTutorial.steps[this.currentStepIndex];
    
    if (step.element === '#fb-tab-list-btn' || step.element === '#fb-tab-ie-btn') {
      const dialog = document.getElementById('fb-manage-dialog');
      if (dialog && dialog.style.display === 'none') {
        const manageBtn = document.getElementById('fb-manage-btn');
        if (manageBtn) manageBtn.click();
      }
      const tabBtn = document.getElementById(step.element.substring(1));
      if (tabBtn) {
        // Wait a tiny fraction to allow the click handler to register
        setTimeout(() => tabBtn.click(), 20);
      }
    }
    
    const checkAndShow = () => {
      const target = document.querySelector(step.element);
      if (!target) {
        // Element not in DOM, keep waiting
        this.waitTimeout = setTimeout(checkAndShow, 100);
        return;
      }

      const rect = target.getBoundingClientRect();
      const isVisible = rect.width > 0 && rect.height > 0;
      if (!isVisible) {
        // Element is in DOM but not visible (e.g. sidebar panel closed), wait for it to open
        this.waitTimeout = setTimeout(checkAndShow, 100);
        return;
      }

      // Element is visible, clear the timeout
      if (this.waitTimeout) {
        clearTimeout(this.waitTimeout);
        this.waitTimeout = null;
      }

      // Scroll target into view
      target.scrollIntoView({ block: 'nearest' });

      // Create overlay backdrop
      if (!this.backdrop) {
        this.backdrop = document.createElement('div');
        this.backdrop.className = 'tut-backdrop';
        this.backdrop.addEventListener('mousedown', e => e.stopPropagation());
        document.body.appendChild(this.backdrop);
      }

      // Elevate target element
      this.highlightedElement = target;
      const compPos = window.getComputedStyle(target).position;
      if (compPos === 'static') {
        this.highlightedElementOriginalPosition = target.style.position;
        target.style.position = 'relative';
      } else {
        this.highlightedElementOriginalPosition = null;
      }
      target.classList.add('tut-highlighted');

      // Elevate ancestors to solve stacking context issues
      this.elevatedAncestors = [];
      let parent = target.parentElement;
      while (parent && parent !== document.body) {
        const style = window.getComputedStyle(parent);
        if (style.position !== 'static' || style.zIndex !== 'auto') {
          parent.classList.add('tut-ancestor-elevated');
          this.elevatedAncestors.push(parent);
        }
        parent = parent.parentElement;
      }

      // Create popover
      if (!this.popover) {
        this.popover = document.createElement('div');
        this.popover.className = 'tut-popover';
        this.popover.addEventListener('mousedown', e => e.stopPropagation());
        document.body.appendChild(this.popover);
      }

      const isLast = this.currentStepIndex === this.currentTutorial.steps.length - 1;
      const prevButtonHtml = this.currentStepIndex > 0 ? '<button class="tut-btn tut-prev">Prev</button>' : '';
      
      this.popover.innerHTML = `
        <h3>${step.title}</h3>
        <p>${step.text}</p>
        <div class="tut-footer">
          <span class="tut-steps-indicator">${this.currentStepIndex + 1} / ${this.currentTutorial.steps.length}</span>
          <div class="tut-buttons">
            <button class="tut-btn tut-skip">Skip</button>
            ${prevButtonHtml}
            <button class="tut-btn tut-btn-primary tut-next">${isLast ? 'Finish' : 'Next'}</button>
          </div>
        </div>
      `;

      positionPopover(this.popover, target, step.position);

      this.popover.querySelector('.tut-skip').onclick = () => this.end(true);
      this.popover.querySelector('.tut-next').onclick = () => this.next();
      if (this.currentStepIndex > 0) {
        this.popover.querySelector('.tut-prev').onclick = () => this.prev();
      }
    };

    checkAndShow();
  }

  next() {
    this.currentStepIndex++;
    if (this.currentStepIndex < this.currentTutorial.steps.length) {
      this.showStep();
    } else {
      this.end(false);
    }
  }

  prev() {
    if (this.currentStepIndex > 0) {
      this.currentStepIndex--;
      this.showStep();
    }
  }

  cleanupStep() {
    if (this.waitTimeout) {
      clearTimeout(this.waitTimeout);
      this.waitTimeout = null;
    }
    if (this.highlightedElement) {
      this.highlightedElement.classList.remove('tut-highlighted');
      if (this.highlightedElementOriginalPosition !== null && this.highlightedElementOriginalPosition !== undefined) {
        this.highlightedElement.style.position = this.highlightedElementOriginalPosition;
      }
      this.highlightedElement = null;
      this.highlightedElementOriginalPosition = null;
    }
    if (this.elevatedAncestors) {
      this.elevatedAncestors.forEach(el => el.classList.remove('tut-ancestor-elevated'));
      this.elevatedAncestors = [];
    }
    if (this.backdrop) {
      this.backdrop.remove();
      this.backdrop = null;
    }
    if (this.popover) {
      this.popover.remove();
      this.popover = null;
    }
    
    // Close manage dialog if next step is not pointing to it
    const manageDialog = document.getElementById('fb-manage-dialog');
    if (manageDialog && manageDialog.style.display !== 'none') {
      const nextStep = this.currentTutorial && this.currentStepIndex < this.currentTutorial.steps.length ? this.currentTutorial.steps[this.currentStepIndex] : null;
      const nextElement = nextStep ? nextStep.element : '';
      if (nextElement !== '.fb-manage-dialog-card' && !nextElement.includes('fb-manage-dialog')) {
        manageDialog.style.display = 'none';
      }
    }
  }

  async end(skipped) {
    this.cleanupStep();
    if (this.backdrop) { this.backdrop.remove(); this.backdrop = null; }
    if (this.popover) { this.popover.remove(); this.popover = null; }

    if (this.currentTutorial) {
      const id = this.currentTutorial.id;
      const data = await chrome.storage.local.get("tutorials_seen");
      const seen = data.tutorials_seen || {};
      seen[id] = true;
      await chrome.storage.local.set({ tutorials_seen: seen });
      this.seen[id] = true;
      this.currentTutorial = null;

      // Automatically chain next tutorial if toolbar completed successfully
      if (id === 'v1.2.0_toolbar_controls' && !skipped) {
        const moreBtn = document.querySelector('#morebtn');
        const morePanel = document.querySelector('#morepanel');
        if (moreBtn && morePanel && morePanel.style.display === 'none') {
          moreBtn.click();
        }
      }
    }

    // Always recheck to see if open/closed panels immediately satisfy other tutorials
    setTimeout(() => this.checkAvailableTutorials(), 200);
  }

  static async reset(id = null) {
    if (id) {
      const data = await chrome.storage.local.get("tutorials_seen");
      const seen = data.tutorials_seen || {};
      delete seen[id];
      await chrome.storage.local.set({ tutorials_seen: seen });
      console.log(`Tutorial '${id}' progress reset. Please reload to apply changes.`);
    } else {
      await chrome.storage.local.remove("tutorials_seen");
      console.log("All tutorials progress reset. Please reload to apply changes.");
    }
  }
}

window.TutorialManager = TutorialManager;

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

    // Initial check on boot
    this.checkAvailableTutorials();

    // Re-check when user interacts (e.g. opens a panel/sidebar)
    // Using capture phase (true) to bypass stopPropagation() on elements like #morebtn
    document.addEventListener('click', () => {
      setTimeout(() => this.checkAvailableTutorials(), 150);
    }, true);
  }

  checkAvailableTutorials() {
    if (this.currentTutorial) return; // Already running a tutorial

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
      this.highlightedElement = null;
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

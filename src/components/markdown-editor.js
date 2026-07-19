// Localized string helper (guarded: degrades to the English fallback if i18n not ready).
const MD_L = (k, fallback, p) => (typeof window !== 'undefined' && window.i18n) ? window.i18n.t(k, p) : fallback;

class MarkdownEditor {
  constructor(containerEl, options = {}) {
    this.container = typeof containerEl === 'string' ? document.getElementById(containerEl) : containerEl;
    this.container.classList.add('md-editor');
    this.options = Object.assign({
      label: '',
      placeholder: '',
      allowAttachments: false,
      allowMentions: false,
      onInput: () => {}
    }, options);

    this.isEditMode = true;
    this.render();
    this.initElements();
    this.bindEvents();

    // Re-localize the static toolbar/labels when the interface language switches,
    // preserving the current text, edit/preview mode and disabled state.
    if (typeof window !== 'undefined' && window.i18n) {
      window.i18n.onChange(() => this.relocalize());
    }
  }

  // Rebuilds the static chrome (toolbar titles, label, placeholder, dropzone)
  // for the active language without losing editor content or state.
  relocalize() {
    if (!this.container || !this.textarea) return;
    if (this.container.classList.contains('fullscreen')) return; // avoid disrupting an active fullscreen session
    const text = this.textarea.value;
    const wasEdit = this.isEditMode;
    const wasDisabled = this.textarea.disabled;
    this.render();
    this.initElements();
    this.bindEvents();
    this.textarea.value = text;
    if (!wasEdit) this.togglePreview(true);
    if (wasDisabled) this.setDisabled(true);
  }

  render() {
    this.container.innerHTML = `
      <div class="desc-tools">
        <label class="dlabel">${htmlEsc(this.options.label)}</label>
        <div class="dfmt">
          <button type="button" class="dbtn dbtn-i-only" data-fmt="bold"   title="${htmlEsc(MD_L('md.bold', 'Bold (Ctrl+B)'))}"><b>B</b></button>
          <button type="button" class="dbtn dbtn-i-only" data-fmt="italic" title="${htmlEsc(MD_L('md.italic', 'Italic (Ctrl+I)'))}"><i>I</i></button>
          <button type="button" class="dbtn dbtn-i-only" data-fmt="strike" title="${htmlEsc(MD_L('md.strike', 'Strikethrough'))}"><s>S</s></button>
          <button type="button" class="dbtn dbtn-i-only" data-fmt="code"   title="${htmlEsc(MD_L('md.code', 'Inline code'))}">&lt;/&gt;</button>
          <span class="dsep"></span>
          <button type="button" class="dbtn dbtn-i-only" data-fmt="h"      title="${htmlEsc(MD_L('md.heading', 'Heading (cycles #, ##, ###)'))}">H</button>
          <button type="button" class="dbtn dbtn-i-only" data-fmt="ul"     title="${htmlEsc(MD_L('md.bulletedList', 'Bulleted list'))}">•</button>
          <button type="button" class="dbtn dbtn-i-only" data-fmt="ol"     title="${htmlEsc(MD_L('md.numberedList', 'Numbered list'))}">1.</button>
          <button type="button" class="dbtn dbtn-i-only" data-fmt="quote"  title="${htmlEsc(MD_L('md.quote', 'Quote'))}">”</button>
          <button type="button" class="dbtn dbtn-i-only" data-fmt="link"   title="${htmlEsc(MD_L('md.insertLink', 'Insert link'))}"><ui-icon name="link"></ui-icon></button>
          <button type="button" class="dbtn dbtn-i-only" data-fmt="table"  title="${htmlEsc(MD_L('md.insertTable', 'Insert table'))}"><ui-icon name="table"></ui-icon></button>
          <span class="dsep"></span>
          <button type="button" class="dbtn icon ai-btn" id="ai-fmt-btn" title="AI Edit Text" style="color:var(--accent)"><ui-icon name="sparkles"></ui-icon></button>
        </div>
        <div class="dtspacer"></div>
        <button type="button" class="dbtn icon dbtn-toggle" title="${htmlEsc(MD_L('md.togglePreview', 'Toggle preview / edit'))}"><ui-icon name="eye"></ui-icon></button>
        <button type="button" class="dbtn icon dbtn-full" title="${htmlEsc(MD_L('md.toggleFullscreen', 'Toggle fullscreen mode (Esc to exit)'))}"><ui-icon name="maximize"></ui-icon></button>
      </div>
      <div class="desc-wrap">
        <textarea placeholder="${htmlEsc(this.options.placeholder)}"></textarea>
        <div class="mdview" style="display:none"></div>
        ${this.options.allowAttachments ? `<div class="desc-dropzone"><div class="ddz-inner"><ui-icon name="paperclip"></ui-icon> ${htmlEsc(MD_L('md.dropToAttach', 'Drop to attach & insert into description'))}</div></div>` : ''}
      </div>
      ${this.options.allowAttachments ? '<input type="file" multiple style="display:none">' : ''}
    `;
  }

  adjustHeight() {
    const ta = this.textarea;
    if (!ta) return;
    if (this.container.classList.contains('fullscreen')) {
      ta.style.height = '';
      return;
    }
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  }

  initElements() {
    this.textarea = this.container.querySelector('textarea');
    this.previewDiv = this.container.querySelector('.mdview');
    this.toggleBtn = this.container.querySelector('.dbtn-toggle');
    this.fullBtn = this.container.querySelector('.dbtn-full');
    this.toolsDiv = this.container.querySelector('.dfmt');
    this.fileInput = this.container.querySelector('input[type="file"]');
    this.dropzone = this.container.querySelector('.desc-dropzone');
    this.wrap = this.container.querySelector('.desc-wrap');
    this.adjustHeight();
  }

  bindEvents() {
    this.toggleBtn.onclick = (e) => { e.preventDefault(); this.togglePreview(); };
    this.fullBtn.onclick = (e) => { e.preventDefault(); this.toggleFullscreen(); };
    this.toolsDiv.onclick = (e) => {
      const b = e.target.closest('.dbtn[data-fmt]');
      if (b) {
        e.preventDefault();
        this.handleFormat(b.dataset.fmt);
      }
    };
    
    const handleSelection = (e) => {
      const ta = this.textarea;
      const s = ta.selectionStart;
      const end = ta.selectionEnd;
      if (s !== end && (end - s) >= 1) {
        const selectedText = ta.value.slice(s, end).trim();
        if (selectedText) {
          let x = 0;
          let y = 0;
          if (e && e.type === 'mouseup') {
            x = e.clientX;
            y = e.clientY;
          } else {
            // Keyboard selection fallback
            const rect = ta.getBoundingClientRect();
            x = rect.left + rect.width / 2;
            y = rect.top + 20;
          }
          this.showSelectionIndicator(x, y, selectedText, s, end);
          return;
        }
      }
      this.hideSelectionIndicator();
    };

    this.textarea.addEventListener('mouseup', handleSelection);
    this.textarea.addEventListener('keyup', handleSelection);

    // Hide indicator on blur to prevent ghosting, unless clicking indicator itself
    this.textarea.addEventListener('blur', () => {
      setTimeout(() => {
        if (document.activeElement !== this.selectionIndicator) {
          this.hideSelectionIndicator();
        }
      }, 150);
    });

    // Toolbar AI Button
    const aiBtn = this.container.querySelector('#ai-fmt-btn');
    if (aiBtn) {
      aiBtn.addEventListener('mousedown', (e) => {
        e.preventDefault();
      });
      aiBtn.onclick = (e) => {
        e.preventDefault();
        const ta = this.textarea;
        const s = ta.selectionStart;
        const end = ta.selectionEnd;
        let selectedText = '';
        let isWhole = false;
        if (s !== end) {
          selectedText = ta.value.slice(s, end);
        } else {
          selectedText = ta.value;
          isWhole = true;
        }

        if (!selectedText.trim()) return;

        // Position popover near the AI button itself
        const rect = aiBtn.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height + 10;

        if (window.AITextEditor) {
          window.AITextEditor.open(selectedText, { x, y }, (newText) => {
            if (newText && newText !== selectedText) {
              if (isWhole) {
                ta.value = newText;
                ta.selectionStart = 0;
                ta.selectionEnd = ta.value.length;
              } else {
                ta.value = ta.value.slice(0, s) + newText + ta.value.slice(end);
                ta.selectionStart = s;
                ta.selectionEnd = s + newText.length;
              }
              ta.focus();
              this.fireChange();
            }
          });
        }
      };
    }

    this.textarea.oninput = () => {
      if (this.options.onInput) this.options.onInput();
      this.adjustHeight();
    };
    this.textarea.onchange = () => {
      if (this.options.onInput) this.options.onInput();
      this.adjustHeight();
    };

    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.adjustHeight());
      this.resizeObserver.observe(this.textarea);
    } else {
      if (!this._windowResizeBound) {
        window.addEventListener('resize', () => this.adjustHeight());
        this._windowResizeBound = true;
      }
    }
    this.textarea.addEventListener('keydown', (e) => {
      if (this.options.allowMentions) {
        App.state.activeEditor = this;
        if (mentionState.open) {
          if (e.key === 'ArrowDown') { e.preventDefault(); moveMention(1); return; }
          if (e.key === 'ArrowUp') { e.preventDefault(); moveMention(-1); return; }
          if (e.key === 'Enter') { if (mentionState.rows.length) { e.preventDefault(); pickMention(); return; } }
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMention(); return; }
        }
      }
      if (e.ctrlKey || e.metaKey) {
        const k = e.key.toLowerCase();
        if (k === 'b') { e.preventDefault(); this.handleFormat('bold'); }
        else if (k === 'i') { e.preventDefault(); this.handleFormat('italic'); }
        else if (k === 'k') { e.preventDefault(); this.handleFormat('link'); }
        else if (e.key === '`') { e.preventDefault(); this.handleFormat('code'); }
      }
    });

    if (this.options.allowAttachments) {
      this.fileInput.onchange = (e) => {
        const f = Array.from(e.target.files || []);
        e.target.value = '';
        if (f.length) this.uploadFiles(f, false);
      };
      this.textarea.addEventListener('paste', (e) => {
        if (App.state.cur == null) return;
        const items = (e.clipboardData && e.clipboardData.items) || [], files = [];
        for (const it of items) {
          if (it.kind === 'file') {
            const f = it.getAsFile();
            if (f) files.push(f);
          }
        }
        if (files.length) {
          e.preventDefault();
          this.uploadFiles(files, true);
        }
      });

      const hasFiles = e => ! ! (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'));
      let dragDepth = 0;
      this.wrap.addEventListener('dragenter', e => {
        if (!hasFiles(e) || App.state.cur == null) return;
        e.preventDefault(); dragDepth++; this.wrap.classList.add('dragover');
      });
      this.wrap.addEventListener('dragleave', e => {
        if (!hasFiles(e)) return;
        dragDepth--; if (dragDepth <= 0) { dragDepth = 0; this.wrap.classList.remove('dragover'); }
      });
      this.wrap.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
      this.wrap.addEventListener('drop', e => {
        dragDepth = 0; this.wrap.classList.remove('dragover');
        if (App.state.cur == null || !hasFiles(e)) return;
        e.preventDefault();
        const fs = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
        if (fs.length) this.uploadFiles(fs, true);
      });
    }

    if (this.options.allowMentions) {
      this.textarea.addEventListener('focus', () => { App.state.activeEditor = this; });
      this.textarea.addEventListener('input', () => { App.state.activeEditor = this; openOrUpdateMention(); });
      this.textarea.addEventListener('click', () => { App.state.activeEditor = this; openOrUpdateMention(); });
      this.textarea.addEventListener('keyup', e => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
          App.state.activeEditor = this; openOrUpdateMention();
        }
      });
      this.textarea.addEventListener('blur', () => { scheduleCloseMention(); });
    }
  }

  get value() { return this.textarea.value; }
  set value(val) { this.set(val, false); }
  set(val, silent = false) {
    this.textarea.value = val || '';
    if (!silent && this.options.onInput) this.options.onInput();
    if (!this.isEditMode) {
      this.renderPreview();
    }
    this.adjustHeight();
  }

  togglePreview(forceOn) {
    const on = forceOn !== undefined ? forceOn : (this.textarea.style.display !== 'none');
    this.isEditMode = !on;
    if (on) {
      if (this.options.allowMentions && App.state.activeEditor === this) {
        closeMention();
      }
      this.renderPreview();
      this.textarea.style.display = 'none';
      this.previewDiv.style.display = 'block';
      this.toggleBtn.innerHTML = '<ui-icon name="edit"></ui-icon>';
      this.toggleBtn.title = MD_L('md.switchToEdit', 'switch to edit mode');
      this.toggleBtn.classList.add('on');
      this.container.classList.add('preview-mode');
    } else {
      this.previewDiv.style.display = 'none';
      this.textarea.style.display = 'block';
      this.toggleBtn.innerHTML = '<ui-icon name="eye"></ui-icon>';
      this.toggleBtn.title = MD_L('md.togglePreview', 'Toggle preview / edit');
      this.toggleBtn.classList.remove('on');
      this.container.classList.remove('preview-mode');
      this.textarea.focus();
    }
  }

  toggleFullscreen(forceOn) {
    const on = forceOn !== undefined ? forceOn : !this.container.classList.contains('fullscreen');
    
    let backdropId = 's_editor_backdrop_' + this.container.id;
    let backdrop = document.getElementById(backdropId);
    
    if (on) {
      if (!this._origParent) {
        this._origParent = this.container.parentNode;
        this._origNextSibling = this.container.nextSibling;
      }
      this.container.classList.add('fullscreen');
      this.fullBtn.classList.add('on');
      this.fullBtn.title = MD_L('md.exitFullscreen', 'Exit fullscreen mode');

      if (!backdrop) {
        backdrop = document.createElement('div');
        backdrop.id = backdropId;
        backdrop.className = 'modal-backdrop editor-backdrop';
        backdrop.onclick = () => this.toggleFullscreen(false);
        document.body.appendChild(backdrop);
      }
      
      // Move editor container to body to break out of any parent stacking context
      document.body.appendChild(this.container);

      if (window.LayerManager) {
        window.LayerManager.open(this.container, backdrop);
      }

      if (this.isEditMode) {
        this.textarea.focus();
      }
    } else {
      this.container.classList.remove('fullscreen');
      this.fullBtn.classList.remove('on');
      this.fullBtn.title = MD_L('md.toggleFullscreen', 'Toggle fullscreen mode (Esc to exit)');
      
      if (window.LayerManager) {
        window.LayerManager.close(this.container);
      }
      
      if (backdrop) {
        backdrop.remove();
      }
      
      // Restore to original parent
      if (this._origParent) {
        if (this._origNextSibling) {
          this._origParent.insertBefore(this.container, this._origNextSibling);
        } else {
          this._origParent.appendChild(this.container);
        }
        this._origParent = null;
        this._origNextSibling = null;
      }
    }
    this.adjustHeight();
  }

  renderPreview() {
    let html = mdToHtml(this.textarea.value, descRenderOpts());
    // Replace src of ADO attachment URLs with a placeholder BEFORE setting innerHTML
    // to prevent the browser from firing unauthenticated requests (→ 401/500 redirect).
    // The real URL is stashed in data-src for hydratePreviewImages to pick up.
    html = html.replace(
      /(<img\s[^>]*?)src="(https:\/\/[^"]+\/_apis\/wit\/attachments\/[^"]+)"/gi,
      '$1src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" data-src="$2"'
    );
    this.previewDiv.innerHTML = html;
    hydratePreviewImages(this.previewDiv);
    if (typeof colorMentions === 'function') colorMentions(this.previewDiv);
    hydrateCodeBlocks(this.previewDiv);
  }

  handleFormat(kind) {
    switch (kind) {
      case 'bold':   return this.wrapSel('**', '**');
      case 'italic': return this.wrapSel('*', '*');
      case 'strike': return this.wrapSel('~~', '~~');
      case 'code':   return this.wrapSel('`', '`');
      case 'h':      return this.cycleHeading();
      case 'ul':     return this.prefixLines(() => '- ', true);
      case 'ol':     return this.prefixLines(i => (i + 1) + '. ', true);
      case 'quote':  return this.prefixLines(() => '> ', true);
      case 'link':   return this.insertLink();
      case 'table':  return this.insertTable();
    }
  }



  wrapSel(before, after) {
    if (!this.isEditMode) this.togglePreview(false);
    const ta = this.textarea;
    const s = ta.selectionStart, e = ta.selectionEnd, v = ta.value;
    const sel = v.slice(s, e) || 'text';
    const around = v.slice(Math.max(0, s - before.length), s) === before && v.slice(e, e + after.length) === after;
    if (around) {
      ta.value = v.slice(0, s - before.length) + sel + v.slice(e + after.length);
      ta.selectionStart = s - before.length; ta.selectionEnd = e - before.length;
    } else {
      const ins = before + sel + after;
      ta.value = v.slice(0, s) + ins + v.slice(e);
      ta.selectionStart = s + before.length; ta.selectionEnd = s + before.length + sel.length;
    }
    ta.focus(); this.fireChange();
  }

  prefixLines(getPrefix, toggleable) {
    if (!this.isEditMode) this.togglePreview(false);
    const ta = this.textarea;
    const s = ta.selectionStart, e = ta.selectionEnd, v = ta.value;
    const lsRaw = v.lastIndexOf('\n', s - 1) + 1;
    const leRaw = v.indexOf('\n', Math.max(e - 1, lsRaw));
    const lEnd = leRaw < 0 ? v.length : leRaw;
    const block = v.slice(lsRaw, lEnd);
    const lines = block.split('\n');
    let newLines;
    if (toggleable) {
      const p0 = getPrefix(0);
      const all = lines.every(l => !l.length || l.startsWith(p0));
      if (all) {
        newLines = lines.map(l => l.startsWith(p0) ? l.slice(p0.length) : l);
      } else {
        newLines = lines.map((l, i) => l.length ? getPrefix(i) + l : l);
      }
    } else {
      newLines = lines.map((l, i) => l.length ? getPrefix(i) + l : l);
    }
    const text = newLines.join('\n');
    ta.value = v.slice(0, lsRaw) + text + v.slice(lEnd);
    ta.selectionStart = lsRaw; ta.selectionEnd = lsRaw + text.length;
    ta.focus(); this.fireChange();
  }

  cycleHeading() {
    if (!this.isEditMode) this.togglePreview(false);
    const ta = this.textarea;
    const s = ta.selectionStart, v = ta.value;
    const ls = v.lastIndexOf('\n', s - 1) + 1;
    const le = v.indexOf('\n', s); const lEnd = le < 0 ? v.length : le;
    const line = v.slice(ls, lEnd);
    const m = line.match(/^(#{1,3})\s+(.*)$/);
    let next;
    if (!m) next = '# ' + line;
    else if (m[1].length === 1) next = '## ' + m[2];
    else if (m[1].length === 2) next = '### ' + m[2];
    else next = m[2];
    ta.value = v.slice(0, ls) + next + v.slice(lEnd);
    const caret = ls + next.length;
    ta.selectionStart = ta.selectionEnd = caret;
    ta.focus(); this.fireChange();
  }

  async insertLink() {
    if (!this.isEditMode) this.togglePreview(false);
    const ta = this.textarea;
    const s = ta.selectionStart, e = ta.selectionEnd, v = ta.value;
    const sel = v.slice(s, e);
    
    if (typeof customLinkPrompt !== 'function') {
      const url = prompt(MD_L('md.linkUrlPrompt', 'Link URL (https://…)'), 'https://');
      if (!url || !/^https?:\/\//i.test(url)) return;
      const linkText = sel || MD_L('md.linkText', 'link text');
      const ins = `[${linkText}](${url})`;
      ta.value = v.slice(0, s) + ins + v.slice(e);
      ta.selectionStart = s + 1; ta.selectionEnd = s + 1 + linkText.length;
      ta.focus(); this.fireChange();
      return;
    }
    
    const result = await customLinkPrompt(sel);
    if (!result) {
      ta.focus();
      return;
    }
    
    const ins = `[${result.text}](${result.url})`;
    ta.value = v.slice(0, s) + ins + v.slice(e);
    ta.selectionStart = s + 1;
    ta.selectionEnd = s + 1 + result.text.length;
    ta.focus();
    this.fireChange();
  }

  insertTable() {
    if (!this.isEditMode) this.togglePreview(false);
    const ta = this.textarea;
    const s = ta.selectionStart, e = ta.selectionEnd, v = ta.value;
    const tableTemplate = 
`| Header 1 | Header 2 |
| --- | --- |
| Cell 1 | Cell 2 |`;
    
    ta.value = v.slice(0, s) + tableTemplate + v.slice(e);
    ta.selectionStart = ta.selectionEnd = s + tableTemplate.length;
    ta.focus();
    this.fireChange();
  }

  insertAtCursor(text) {
    const ta = this.textarea;
    const hidden = ta.offsetParent === null;
    const s = hidden ? ta.value.length : ta.selectionStart;
    const e = hidden ? ta.value.length : ta.selectionEnd;
    const v = ta.value;
    const before = v.slice(0, s), after = v.slice(e);
    const pad = text.startsWith('!') || text.startsWith('[') ? (before.length && !before.endsWith('\n') ? '\n' : '') : '';
    const tail = text.startsWith('!') ? '\n' : '';
    const ins = pad + text + tail;
    ta.value = before + ins + after;
    const at = before.length + ins.length;
    ta.selectionStart = ta.selectionEnd = at;
    ta.focus(); this.fireChange();
  }

  setDisabled(disabled) {
    this.textarea.disabled = !!disabled;
    this.container.classList.toggle('disabled', !!disabled);
    if (disabled && this.isEditMode) this.togglePreview(true);
  }

  fireChange() {
    this.textarea.dispatchEvent(new Event('input', { bubbles: true }));
    if (!this.isEditMode) {
      this.renderPreview();
    }
  }

  triggerAttachmentUpload() {
    if (this.fileInput) {
      this.fileInput.click();
    }
  }

  async uploadFiles(files, insertIntoEditor = false) {
    if (!files || !files.length || App.state.cur == null) return;
    const wid = App.state.cur;
    for (const f of files) {
      atchState.uploading++; renderAttachments();
      let up;
      try { up = await api.uploadAttachment(f); }
      catch (e) { atchState.uploading--; renderAttachments(); setStatus(MD_L('md.uploadFailed', 'upload failed: ' + e.message, { error: e.message }), true); continue; }
      let res;
      try { res = await api.addAttachmentLink(wid, up.url, up.name, ''); }
      catch (e) { atchState.uploading--; renderAttachments(); setStatus(MD_L('md.attachFailed', 'attach failed: ' + e.message, { error: e.message }), true); continue; }
      atchState.uploading--;
      if (App.state.cur !== wid) { renderAttachments(); continue; }
      atchState.list = res.attachments || [];
      if (insertIntoEditor) {
        const md = (isImageMime(f.type) || isImageName(f.name) ? '!' : '') + `[${up.name}](${up.url})`;
        this.insertAtCursor(md);
      }
      renderAttachments();
      const nwid = (window.App && window.App.backend) ? window.App.backend.nid(wid) : wid;
      setStatus(MD_L('md.attached', '#' + nwid + ' attached ' + up.name, { id: nwid, name: up.name }));
    }
  }

  showSelectionIndicator(x, y, selectedText, s, end) {
    this.currentSelection = { x, y, text: selectedText, start: s, end: end };

    if (!this.selectionIndicator) {
      this.selectionIndicator = document.createElement('button');
      this.selectionIndicator.type = 'button';
      this.selectionIndicator.className = 'ai-selection-indicator';
      this.selectionIndicator.innerHTML = '<ui-icon name="sparkles"></ui-icon>';
      this.selectionIndicator.style.position = 'fixed';
      this.selectionIndicator.style.zIndex = '20100';
      this.selectionIndicator.style.display = 'none';
      
      this.selectionIndicator.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      
      this.selectionIndicator.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.hideSelectionIndicator();
        
        const sel = this.currentSelection;
        if (sel && window.AITextEditor) {
          const ta = this.textarea;
          window.AITextEditor.open(sel.text, { x: sel.x, y: sel.y + 10 }, (newText) => {
            if (newText && newText !== sel.text) {
              ta.value = ta.value.slice(0, sel.start) + newText + ta.value.slice(sel.end);
              ta.selectionStart = sel.start;
              ta.selectionEnd = sel.start + newText.length;
              ta.focus();
              this.fireChange();
            }
          });
        }
      });

      document.body.appendChild(this.selectionIndicator);
      if (typeof App !== 'undefined' && App.icons && typeof App.icons.init === 'function') {
        App.icons.init(this.selectionIndicator);
      }
    }

    this.selectionIndicator.style.left = `${x - 12}px`;
    this.selectionIndicator.style.top = `${y - 32}px`;
    this.selectionIndicator.style.display = 'block';
  }

  hideSelectionIndicator() {
    if (this.selectionIndicator) {
      this.selectionIndicator.style.display = 'none';
    }
  }
}

function hydrateCodeBlocks(container) {
  if (!container) return;
  const pres = container.querySelectorAll("pre");
  pres.forEach(pre => {
    if (pre.closest(".md-code-block")) return;
    
    const rawText = pre.textContent.replace(/\n$/, '');
    
    const registry = (window.AdoLib && window.AdoLib.highlightRegistry) || {};
    const aliases = (window.AdoLib && window.AdoLib.langAliases) || {};
    const meta = (window.AdoLib && window.AdoLib.langMeta) || {};
    
    let initialLang = pre.getAttribute("data-lang") || "";
    if (initialLang) {
      initialLang = initialLang.toLowerCase();
      if (aliases[initialLang]) {
        initialLang = aliases[initialLang];
      }
    }

    const isExplicit = pre.hasAttribute("data-explicit");

    // -- build wrapper --
    const wrapper = document.createElement("div");
    wrapper.className = "md-code-block";

    // -- header bar --
    const header = document.createElement("div");
    header.className = "md-code-header";

    // left side: language indicator
    const langSide = document.createElement("span");
    langSide.className = "md-lang-indicator";

    const dot = document.createElement("span");
    dot.className = "md-lang-dot";
    const dotColor = (meta[initialLang] && meta[initialLang].color) || (meta[''] && meta[''].color) || '#8b949e';
    dot.style.background = dotColor;
    langSide.appendChild(dot);

    if (isExplicit) {
      const badge = document.createElement("span");
      badge.className = "md-lang-lbl";
      const m = meta[initialLang] || meta[''];
      badge.textContent = m ? m.label : (initialLang || 'Text');
      langSide.appendChild(badge);
    } else {
      const select = document.createElement("select");
      select.className = "md-lang-selector";
      
      const languages = [
        { value: "", label: (meta[''] && meta[''].label) || "Text" },
        ...Object.keys(registry).map(lang => ({
          value: lang,
          label: (meta[lang] && meta[lang].label) || lang
        }))
      ];
      
      languages.forEach(l => {
        const opt = document.createElement("option");
        opt.value = l.value;
        opt.textContent = l.label;
        if (l.value === initialLang) {
          opt.selected = true;
        }
        select.appendChild(opt);
      });
      langSide.appendChild(select);
    }

    header.appendChild(langSide);

    // right side: copy button
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "md-copy-btn";
    const COPY_ICON = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
    const CHECK_ICON = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#26a269" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
    btn.innerHTML = COPY_ICON;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(rawText).then(() => {
        btn.innerHTML = CHECK_ICON;
        btn.classList.add("success");
        setTimeout(() => {
          btn.innerHTML = COPY_ICON;
          btn.classList.remove("success");
        }, 2000);
      }).catch(err => {
        console.error("Failed to copy code: ", err);
      });
    });

    header.appendChild(btn);

    // -- assemble: replace pre in DOM with wrapper(header + pre) --
    pre.parentNode.insertBefore(wrapper, pre);
    wrapper.appendChild(header);
    wrapper.appendChild(pre);

    // -- language change handler for auto-detected blocks --
    if (!isExplicit) {
      const select = langSide.querySelector("select");
      select.addEventListener("change", () => {
        const newLang = select.value;
        const highlightFn = (window.AdoLib && window.AdoLib.highlightCode);
        if (!highlightFn) return;

        const newColor = (meta[newLang] && meta[newLang].color) || (meta[''] && meta[''].color) || '#8b949e';
        dot.style.background = newColor;

        pre.innerHTML = highlightFn(rawText, newLang);
      });
    }
  });
}

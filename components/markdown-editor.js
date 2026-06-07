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
  }

  render() {
    this.container.innerHTML = `
      <div class="desc-tools">
        <label class="dlabel">${esc(this.options.label)}</label>
        <div class="dfmt">
          <button type="button" class="dbtn dbtn-i-only" data-fmt="bold"   title="Bold (Ctrl+B)"><b>B</b></button>
          <button type="button" class="dbtn dbtn-i-only" data-fmt="italic" title="Italic (Ctrl+I)"><i>I</i></button>
          <button type="button" class="dbtn dbtn-i-only" data-fmt="strike" title="Strikethrough"><s>S</s></button>
          <button type="button" class="dbtn dbtn-i-only" data-fmt="code"   title="Inline code">&lt;/&gt;</button>
          <span class="dsep"></span>
          <button type="button" class="dbtn dbtn-i-only" data-fmt="h"      title="Heading (cycles #, ##, ###)">H</button>
          <button type="button" class="dbtn dbtn-i-only" data-fmt="ul"     title="Bulleted list">•</button>
          <button type="button" class="dbtn dbtn-i-only" data-fmt="ol"     title="Numbered list">1.</button>
          <button type="button" class="dbtn dbtn-i-only" data-fmt="quote"  title="Quote">❝</button>
          <button type="button" class="dbtn dbtn-i-only" data-fmt="link"   title="Insert link">🔗</button>
        </div>
        <div class="dtspacer"></div>
        <button type="button" class="dbtn icon dbtn-toggle" title="Toggle preview / edit">👁</button>
        <button type="button" class="dbtn icon dbtn-full" title="Toggle fullscreen mode (Esc to exit)">⛶</button>
      </div>
      <div class="desc-wrap">
        <textarea placeholder="${esc(this.options.placeholder)}"></textarea>
        <div class="mdview" style="display:none"></div>
        ${this.options.allowAttachments ? '<div class="desc-dropzone"><div class="ddz-inner">📎 Drop to attach & insert into description</div></div>' : ''}
      </div>
      ${this.options.allowAttachments ? '<input type="file" multiple style="display:none">' : ''}
    `;
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
    this.textarea.oninput = () => {
      if (this.options.onInput) this.options.onInput();
    };
    this.textarea.onchange = () => {
      if (this.options.onInput) this.options.onInput();
    };
    this.textarea.addEventListener('keydown', (e) => {
      if (this.options.allowMentions) {
        activeEditor = this;
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
        if (cur == null) return;
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
        if (!hasFiles(e) || cur == null) return;
        e.preventDefault(); dragDepth++; this.wrap.classList.add('dragover');
      });
      this.wrap.addEventListener('dragleave', e => {
        if (!hasFiles(e)) return;
        dragDepth--; if (dragDepth <= 0) { dragDepth = 0; this.wrap.classList.remove('dragover'); }
      });
      this.wrap.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
      this.wrap.addEventListener('drop', e => {
        dragDepth = 0; this.wrap.classList.remove('dragover');
        if (cur == null || !hasFiles(e)) return;
        e.preventDefault();
        const fs = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
        if (fs.length) this.uploadFiles(fs, true);
      });
    }

    if (this.options.allowMentions) {
      this.textarea.addEventListener('focus', () => { activeEditor = this; });
      this.textarea.addEventListener('input', () => { activeEditor = this; openOrUpdateMention(); });
      this.textarea.addEventListener('click', () => { activeEditor = this; openOrUpdateMention(); });
      this.textarea.addEventListener('keyup', e => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
          activeEditor = this; openOrUpdateMention();
        }
      });
      this.textarea.addEventListener('blur', () => { scheduleCloseMention(); });
    }
  }

  get value() { return this.textarea.value; }
  set value(val) {
    this.textarea.value = val || '';
    if (this.options.onInput) this.options.onInput();
    if (!this.isEditMode) {
      this.renderPreview();
    }
  }

  togglePreview(forceOn) {
    const on = forceOn !== undefined ? forceOn : (this.textarea.style.display !== 'none');
    this.isEditMode = !on;
    if (on) {
      if (this.options.allowMentions && activeEditor === this) {
        closeMention();
      }
      this.renderPreview();
      this.textarea.style.display = 'none';
      this.previewDiv.style.display = 'block';
      this.toggleBtn.textContent = '✎';
      this.toggleBtn.title = 'switch to edit mode';
      this.toggleBtn.classList.add('on');
      this.container.classList.add('preview-mode');
    } else {
      this.previewDiv.style.display = 'none';
      this.textarea.style.display = 'block';
      this.toggleBtn.textContent = '👁';
      this.toggleBtn.title = 'toggle preview / edit';
      this.toggleBtn.classList.remove('on');
      this.container.classList.remove('preview-mode');
      this.textarea.focus();
    }
  }

  toggleFullscreen(forceOn) {
    const on = forceOn !== undefined ? forceOn : !this.container.classList.contains('fullscreen');
    this.container.classList.toggle('fullscreen', on);
    this.fullBtn.classList.toggle('on', on);
    this.fullBtn.title = on ? 'Exit fullscreen mode' : 'Toggle fullscreen mode (Esc to exit)';
    
    let backdropId = 's_editor_backdrop_' + this.container.id;
    let backdrop = document.getElementById(backdropId);
    if (on) {
      if (!backdrop) {
        backdrop = document.createElement('div');
        backdrop.id = backdropId;
        backdrop.className = 'modal-backdrop editor-backdrop';
        backdrop.onclick = () => this.toggleFullscreen(false);
        const fsParent = this.container.parentNode.closest('.sgroup.fullscreen, #side.fullscreen');
        if (fsParent) {
          fsParent.appendChild(backdrop);
        } else {
          document.body.appendChild(backdrop);
        }
      }
      if (this.isEditMode) {
        this.textarea.focus();
      }
    } else {
      if (backdrop) {
        backdrop.remove();
      }
    }
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
      const url = prompt('Link URL (https://…)', 'https://');
      if (!url || !/^https?:\/\//i.test(url)) return;
      const ins = `[${sel || 'link text'}](${url})`;
      ta.value = v.slice(0, s) + ins + v.slice(e);
      ta.selectionStart = s + 1; ta.selectionEnd = s + 1 + (sel || 'link text').length;
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
    if (!files || !files.length || cur == null) return;
    const wid = cur;
    for (const f of files) {
      atchState.uploading++; renderAttachments();
      let up;
      try { up = await api.uploadAttachment(f); }
      catch (e) { atchState.uploading--; renderAttachments(); setStatus('upload failed: ' + e.message, true); continue; }
      let res;
      try { res = await api.addAttachmentLink(wid, up.url, up.name, ''); }
      catch (e) { atchState.uploading--; renderAttachments(); setStatus('attach failed: ' + e.message, true); continue; }
      atchState.uploading--;
      if (cur !== wid) { renderAttachments(); continue; }
      atchState.list = res.attachments || [];
      if (insertIntoEditor) {
        const md = (isImageMime(f.type) || isImageName(f.name) ? '!' : '') + `[${up.name}](${up.url})`;
        this.insertAtCursor(md);
      }
      renderAttachments();
      setStatus('#' + wid + ' attached ' + up.name);
    }
  }
}

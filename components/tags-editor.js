class TagsEditor {
  constructor(containerId, options = {}) {
    this.containerId = containerId;
    this.options = {
      onChange: () => {},
      idPrefix: containerId + '_',
      ...options
    };
    this.cur = [];
    this.adding = false;
    this.committing = false;
    this.disabled = false;
  }

  norm(s) {
    return String(s || '').split(/[;,]/).map(t => t.trim()).filter(Boolean);
  }

  uniq(a) {
    const seen = new Set(), o = [];
    a.forEach(t => {
      const k = t.toLowerCase();
      if (!seen.has(k)) {
        seen.add(k);
        o.push(t);
      }
    });
    return o;
  }

  touched() {
    this.options.onChange(this.value());
  }

  commit(v) {
    const a = this.norm(v);
    if (a.length) {
      this.cur = this.uniq(this.cur.concat(a));
      this.touched();
    }
  }

  render() {
    const box = document.getElementById(this.containerId);
    if (!box) return;

    let opClass = '';
    if (this.containerId === 'bulk_tag_container' || box.closest('#bulkbar')) {
      const activeOpBtn = document.getElementById('bulk_tag_op_seg') ? document.getElementById('bulk_tag_op_seg').querySelector('button.on') : null;
      const op = activeOpBtn ? activeOpBtn.dataset.op : 'add';
      opClass = op === 'add' ? 'add' : 'remove';
    }

    let html = this.cur.map((t, i) => 
      `<span class="tagchip ${opClass}" style="background:${personColor(t)}">${esc(t)}<b data-i="${i}" title="remove">×</b></span>`
    ).join('');

    if (!this.cur.length && !this.adding) {
      html = '<span class="pcnone">no tags</span>';
    }

    const inpId = this.options.idPrefix + 'taginp';
    const dropdownId = this.options.idPrefix + 'tag_dropdown';
    const okId = this.options.idPrefix + 'tagok';
    const plusId = this.options.idPrefix + 'tagplus';

    html += this.adding
      ? `<span class="tagadd-wrap" style="display:inline-flex;align-items:center;gap:4px;">
           <span class="f-dropdown-container">
             <input id="${inpId}" class="taginp" placeholder="tag…" autocomplete="off">
             <div id="${dropdownId}" class="f-dropdown" style="display:none"></div>
           </span>
           <button type="button" id="${okId}" class="tagok" title="add tag">✓</button>
         </span>`
      : `<button type="button" class="tagadd" id="${plusId}" title="add a tag">＋</button>`;

    box.innerHTML = html;

    box.querySelectorAll('b[data-i]').forEach(x => {
      x.onmousedown = e => e.preventDefault();
      x.onclick = () => {
        this.committing = true;
        this.cur.splice(+x.dataset.i, 1);
        this.render();
        this.committing = false;
        this.touched();
      };
    });

    if (this.adding) {
      const inp = document.getElementById(inpId);
      const ok = document.getElementById(okId);
      const dropdown = document.getElementById(dropdownId);
      
      const showMatches = (q) => {
        const query = q.toLowerCase().trim();
        const shownSet = new Set(this.cur.map(t => t.toLowerCase()));
        const matches = (typeof tagList !== 'undefined' ? tagList : []).filter(v => {
          if (shownSet.has(v.toLowerCase())) return false;
          return v.toLowerCase().includes(query);
        });
        dropdown.innerHTML = '';
        if (!matches.length) {
          const empty = document.createElement('div');
          empty.className = 'f-dropdown-item empty';
          empty.textContent = 'No matches';
          dropdown.appendChild(empty);
        } else {
          matches.forEach(val => {
            const item = document.createElement('div');
            item.className = 'f-dropdown-item';
            item.textContent = val;
            item.onmousedown = (e) => {
              e.preventDefault();
              this.committing = true;
              this.commit(val);
              dropdown.style.display = 'none';
              this.render();
              this.adding = true;
              const ni = document.getElementById(inpId);
              if (ni) ni.focus();
              this.committing = false;
            };
            dropdown.appendChild(item);
          });
        }
        dropdown.style.display = 'flex';
        dropdown.style.left = '0';
        dropdown.style.right = 'auto';
        dropdown.style.top = '100%';
        dropdown.style.bottom = 'auto';
        dropdown.style.marginTop = '4px';
        dropdown.style.marginBottom = '0';
        const rect = dropdown.getBoundingClientRect();
        if (rect.right > window.innerWidth) {
          dropdown.style.left = 'auto';
          dropdown.style.right = '0';
        }
        if (rect.bottom > window.innerHeight) {
          dropdown.style.top = 'auto';
          dropdown.style.bottom = '100%';
          dropdown.style.marginTop = '0';
          dropdown.style.marginBottom = '4px';
        }
      };

      inp.addEventListener('focus', () => showMatches(inp.value));
      inp.addEventListener('input', () => showMatches(inp.value));
      
      const doCommit = () => {
        this.committing = true;
        this.commit(inp.value);
        inp.value = '';
        this.render();
        this.adding = true;
        const ni = document.getElementById(inpId);
        if (ni) ni.focus();
        this.committing = false;
      };

      ok.onmousedown = e => e.preventDefault();
      ok.onclick = doCommit;
      
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ',') {
          e.preventDefault();
          doCommit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          this.adding = false;
          this.render();
        } else if (e.key === 'Backspace' && !inp.value && this.cur.length) {
          this.committing = true;
          this.cur.pop();
          this.render();
          this.adding = true;
          const ni = document.getElementById(inpId);
          if (ni) ni.focus();
          this.committing = false;
          this.touched();
        }
      });

      inp.addEventListener('change', () => {
        if (inp.value.trim()) doCommit();
      });

      inp.addEventListener('blur', () => {
        if (!this.committing) {
          this.commit(inp.value);
          this.adding = false;
          this.render();
        }
      });

      inp.focus();
      showMatches(inp.value);
    } else {
      const p = document.getElementById(plusId);
      if (p) p.onclick = () => {
        this.adding = true;
        this.render();
      };
    }

    if (this.disabled) {
      box.querySelectorAll('button').forEach(b => b.disabled = true);
      box.style.pointerEvents = 'none';
    } else {
      box.style.pointerEvents = '';
    }
  }

  setDisabled(d) {
    this.disabled = !!d;
    const box = document.getElementById(this.containerId);
    if (box) {
      box.style.pointerEvents = d ? 'none' : '';
      box.querySelectorAll('button').forEach(b => b.disabled = d);
    }
  }

  add(s) {
    this.commit(s);
    this.render();
  }

  set(s, silent) {
    this.cur = this.uniq(this.norm(s));
    this.adding = false;
    this.render();
    if (!silent) this.touched();
  }

  value() {
    return this.cur.join('; ');
  }
}

window.TagsEditor = TagsEditor;
window.tagsEditor = new TagsEditor('s_tags', {
  onChange: () => {
    if (typeof refreshDirty === 'function') refreshDirty();
    if (typeof quickSave === 'function') quickSave('tags');
  }
});

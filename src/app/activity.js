// Activity feed: comment reactions + emoji config, activity panel expand/
// fullscreen/resize, inline comment edit/delete, and the comments + field-change
// history renderer. Phase-1 leaf module of the App.* refactor
// (REFACTORING_PLAN.md): IIFE publishing App.activity. Also carries the
// create-child work-item flow (createChild/recordCreateUndo/denyOnForbidden),
// which lives in this source region and calls into the shared undo/create infra.
//
// Private state (activeEmojiPicker, _actId, _actionsOrigParent/NextSibling) stays
// local. NOTE: reactionCache is a SHARED global declared in app.js (cleared on
// panel close at app.js:2944) — referenced bare here, NOT declared.
//
// Reads/writes bare globals at call time: $, App.state.cur, currentComments, currentHistory,
// activeCommentEditors, currentUser, api, App.state.store, refresh, setStatus, loadStart,
// loadEnd, htmlEsc, reactionCache, MarkdownEditor, personInitials, personColor,
// mdToHtml, descRenderOpts, hydratePreviewImages, colorMentions, customConfirm,
// pushAction, afterUndo, closePanel, updateCreateButtons, canCreateItem,
// recordCreateUndo, window.LayerManager, window.i18n. Loads before app.js.
(function (App) {
  'use strict';

  function getEmojiMap() {
    const defaults = {
      like: 'icons/reactions/like.png',
      dislike: 'icons/reactions/dislike.png',
      heart: 'icons/reactions/heart.png',
      hooray: 'icons/reactions/hooray.png',
      smile: 'icons/reactions/smile.png',
      confused: 'icons/reactions/confused.png'
    };
    try {
      const custom = JSON.parse(App.prefs.get('custom_emojis') || '{}');
      return { ...defaults, ...custom };
    } catch (e) {
      return defaults;
    }
  }

  // The result goes into innerHTML, so both branches must be escaped: the URL test only
  // checks the prefix, so a value like `icons/x" onerror="..." x="` passes it and would
  // otherwise break out of the src attribute.
  function renderEmojiMarkup(type, emojiVal) {
    const isUrl = /^(https?:\/\/|chrome-extension:\/\/|icons\/|data:image\/)/.test(emojiVal);
    if (isUrl) {
      return `<img class="emoji-img" src="${htmlEsc(emojiVal)}" alt="${htmlEsc(type)}">`;
    }
    return htmlEsc(emojiVal);
  }

  function showEmojisModal() {
    const m = $('morepanel');
    if (m) {
      m.style.display = 'none';
      $('morebtn').classList.remove('on');
    }
    const current = getEmojiMap();
    const defaults = {
      like: 'icons/reactions/like.png',
      dislike: 'icons/reactions/dislike.png',
      heart: 'icons/reactions/heart.png',
      hooray: 'icons/reactions/hooray.png',
      smile: 'icons/reactions/smile.png',
      confused: 'icons/reactions/confused.png'
    };
    for (const [type, val] of Object.entries(current)) {
      const input = $(`emoji_override_${type}`);
      if (input) {
        if (val === defaults[type]) {
          input.value = '';
        } else {
          input.value = val;
        }
        updateEmojiInputPreview(type);
      }
    }
    const overlay = $('emojis-overlay');
    overlay.classList.add('show');
    if (window.LayerManager) {
      window.LayerManager.open(overlay);
    }
  }

  function updateEmojiInputPreview(type) {
    const input = $(`emoji_override_${type}`);
    const previewDiv = $(`emoji_preview_${type}`);
    if (!input || !previewDiv) return;
    const val = input.value.trim();
    const defaults = {
      like: 'icons/reactions/like.png',
      dislike: 'icons/reactions/dislike.png',
      heart: 'icons/reactions/heart.png',
      hooray: 'icons/reactions/hooray.png',
      smile: 'icons/reactions/smile.png',
      confused: 'icons/reactions/confused.png'
    };
    const displayVal = val || defaults[type];
    previewDiv.innerHTML = renderEmojiMarkup(type, displayVal);
  }

  function showEmojiRowError(type, message) {
    const inputEl = $(`emoji_override_${type}`);
    if (!inputEl) return;
    const row = inputEl.closest('.emoji-config-row');
    if (!row) return;

    const existing = document.querySelector(`.emoji-row-error[data-row-type="${type}"]`);
    if (existing) {
      if (window.LayerManager) window.LayerManager.close(existing);
      existing.remove();
    }

    const err = document.createElement('div');
    err.className = 'emoji-row-error';
    err.dataset.rowType = type;
    err.textContent = message;

    const overlay = $('emojis-overlay');
    overlay.appendChild(err);

    const rRect = row.getBoundingClientRect();
    const oRect = overlay.getBoundingClientRect();

    const top = rRect.top - oRect.top - 32;
    const right = oRect.right - rRect.right + 10;

    err.style.top = `${top}px`;
    err.style.right = `${right}px`;

    if (window.LayerManager) {
      window.LayerManager.open(err, null, { isPopover: true });
    }

    setTimeout(() => {
      err.style.opacity = '0';
      setTimeout(() => {
        if (window.LayerManager) window.LayerManager.close(err);
        err.remove();
      }, 200);
    }, 4000);
  }

  function closeEmojisModal() {
    const overlay = $('emojis-overlay');
    overlay.classList.remove('show');
    if (window.LayerManager) {
      window.LayerManager.close(overlay);
    }
  }

  function resetEmojis() {
    App.prefs.remove('custom_emojis');
    closeEmojisModal();
    loadActivity();
  }

  function saveEmojis() {
    const custom = {};
    const types = ['like', 'dislike', 'heart', 'hooray', 'smile', 'confused'];
    for (const type of types) {
      const val = $(`emoji_override_${type}`).value.trim();
      if (val) {
        custom[type] = val;
      }
    }
    App.prefs.set('custom_emojis', JSON.stringify(custom));
    closeEmojisModal();
    loadActivity();
  }

  function updateCommentReactionsUI(commentId, reactions) {
    const card = document.querySelector(`.comment-card[data-cid="${commentId}"]`);
    if (!card) return;
    const reactionsDiv = card.querySelector('.comment-reactions');
    if (!reactionsDiv) return;

    const emojiMap = getEmojiMap();
    let reactHtml = '';
    Object.entries(emojiMap).forEach(([type, emojiVal]) => {
      const data = reactions[type];
      if (data && data.count > 0) {
        const active = data.me ? 'active' : '';
        reactHtml += `<span class="reaction-chip ${active}" data-cid="${commentId}" data-type="${type}"><span class="emoji-symbol">${renderEmojiMarkup(type, emojiVal)}</span> <span class="rc-count">${data.count}</span></span>`;
      }
    });
    reactionsDiv.innerHTML = reactHtml;
  }

  function toggleActivityExpand(forceState) {
    const actionsGroup = document.querySelector('.sgroup[data-sg="actions"]');
    const arrow = document.querySelector('#activity_toggle_btn .toggle-arrow');
    const content = $('activity-content');
    if (!actionsGroup || !content) return;

    const isFullscreen = actionsGroup.classList.contains('fullscreen');
    const isExpanded = forceState !== undefined ? forceState : content.classList.contains('hidden');
    if (isExpanded) {
      const alreadyExpanded = !content.classList.contains('hidden');
      content.classList.remove('hidden');
      if (arrow) {
        arrow.innerHTML = isFullscreen ? '<ui-icon name="refresh-cw"></ui-icon>' : '<ui-icon name="chevron-down"></ui-icon>';
        if (isFullscreen) arrow.title = 'Reload activity content';
        else arrow.title = '';
      }
      actionsGroup.classList.add('expanded');
      if (!alreadyExpanded) {
        loadActivity();
      }
    } else {
      content.classList.add('hidden');
      if (arrow) {
        arrow.innerHTML = isFullscreen ? '<ui-icon name="refresh-cw"></ui-icon>' : '<ui-icon name="chevron-right"></ui-icon>';
        if (isFullscreen) arrow.title = 'Reload activity content';
        else arrow.title = '';
      }
      actionsGroup.classList.remove('expanded');
    }
  }

  let _actionsOrigParent = null;
  let _actionsOrigNextSibling = null;
  function toggleActivityFullscreen(forceOn) {
    const actionsGroup = document.querySelector('.sgroup[data-sg="actions"]');
    const btn = $('s_act_full');
    if (!actionsGroup) return;

    const on = forceOn !== undefined ? forceOn : !actionsGroup.classList.contains('fullscreen');
    const arrow = document.querySelector('#activity_toggle_btn .toggle-arrow');
    const atb = $('activity_toggle_btn');

    if (on) {
      actionsGroup.classList.add('fullscreen');
      toggleActivityExpand(true);
      if (btn) btn.classList.add('on');
      if (arrow) {
        arrow.innerHTML = '<ui-icon name="refresh-cw"></ui-icon>';
        arrow.title = 'Reload activity content';
      }
      if (atb) {
        atb.title = 'Reload activity content';
      }
      let bd = $('act-backdrop');
      if (!bd) {
        bd = document.createElement('div');
        bd.id = 'act-backdrop';
        bd.className = 'modal-backdrop activity-backdrop';
        bd.onclick = () => toggleActivityFullscreen(false);
        const sideEl = $('side');
        if (sideEl) {
          sideEl.appendChild(bd);
        } else {
          document.body.appendChild(bd);
        }
      }

      // Move actionsGroup to document.body to break stacking context bugs
      if (!_actionsOrigParent) {
        _actionsOrigParent = actionsGroup.parentNode;
        _actionsOrigNextSibling = actionsGroup.nextSibling;
      }
      document.body.appendChild(actionsGroup);

      if (window.LayerManager) {
        window.LayerManager.open(actionsGroup, bd);
      }
    } else {
      if (window.LayerManager) {
        window.LayerManager.close(actionsGroup);
      }

      // Restore actionsGroup to original parent
      const sideEl = $('side');
      if (sideEl && _actionsOrigParent) {
        if (_actionsOrigNextSibling) {
          _actionsOrigParent.insertBefore(actionsGroup, _actionsOrigNextSibling);
        } else {
          _actionsOrigParent.appendChild(actionsGroup);
        }
        _actionsOrigParent = null;
        _actionsOrigNextSibling = null;
      }

      actionsGroup.classList.remove('fullscreen');
      if (btn) btn.classList.remove('on');
      if (arrow) {
        arrow.textContent = '▼'; // Since it's still expanded
        arrow.title = '';
      }
      if (atb) {
        atb.title = 'Click to collapse/expand activity';
      }
      const bd = $('act-backdrop');
      if (bd) bd.remove();
    }
  }

  function initActivityResizer() {
    const rz = $('activity-resizer');
    const act = $('s_activity');
    if (!rz || !act) return;
    let drag = false;
    let startY, startH;

    rz.onmousedown = e => {
      const content = $('activity-content');
      if (content && content.classList.contains('hidden')) {
        toggleActivityExpand(true);
        startH = 200;
      } else {
        startH = act.offsetHeight;
      }
      drag = true;
      startY = e.clientY;
      rz.classList.add('active');
      document.body.style.cursor = 'ns-resize';
      e.preventDefault();
    };

    document.addEventListener('mousemove', e => {
      if (!drag) return;
      const dy = startY - e.clientY;
      const h = Math.max(100, Math.min(600, startH + dy));
      act.style.maxHeight = h + 'px';
    });

    document.addEventListener('mouseup', () => {
      if (drag) {
        drag = false;
        rz.classList.remove('active');
        document.body.style.cursor = '';
        App.prefs.set('activityHeight', act.style.maxHeight);
      }
    });

    const savedH = App.prefs.get('activityHeight');
    if (savedH) act.style.maxHeight = savedH;
  }

  let activeEmojiPicker = null;
  function showEmojiPicker(btn, commentId) {
    const isAlreadyOpen = activeEmojiPicker && activeEmojiPicker.parentElement === btn.parentElement;
    closeEmojiPicker();
    if (isAlreadyOpen) {
      return;
    }

    const pop = document.createElement('div');
    pop.className = 'reactions-popover';
    const emojiMap = getEmojiMap();

    Object.entries(emojiMap).forEach(([type, emojiVal]) => {
      const emojiBtn = document.createElement('button');
      emojiBtn.className = 'reaction-emoji-btn';
      emojiBtn.type = 'button';
      emojiBtn.innerHTML = renderEmojiMarkup(type, emojiVal);
      emojiBtn.title = type;
      emojiBtn.onclick = (ev) => {
        ev.stopPropagation();
        toggleReaction(commentId, type);
        closeEmojiPicker();
      };
      pop.appendChild(emojiBtn);
    });

    btn.parentElement.appendChild(pop);
    activeEmojiPicker = pop;
    if (window.LayerManager) window.LayerManager.open(pop, null, { isPopover: true });

    document.addEventListener('click', closeEmojiPickerOutside);
  }
  function closeEmojiPicker() {
    if (activeEmojiPicker) {
      if (window.LayerManager) window.LayerManager.close(activeEmojiPicker);
      activeEmojiPicker.remove();
      activeEmojiPicker = null;
    }
    document.removeEventListener('click', closeEmojiPickerOutside);
  }
  function closeEmojiPickerOutside(e) {
    if (activeEmojiPicker && !activeEmojiPicker.contains(e.target)) {
      closeEmojiPicker();
    }
  }

  async function toggleReaction(commentId, type) {
    if (App.state.cur == null) return;
    const c = currentComments.find(x => x.id === commentId);
    if (!c) return;

    const cacheKey = `${commentId}_${type}`;
    reactionCache.delete(cacheKey);

    if (!c.reactions) c.reactions = {};
    if (!c.reactions[type]) c.reactions[type] = { count: 0, me: false };

    const wasMe = c.reactions[type].me;

    // Optimistic update
    if (wasMe) {
      c.reactions[type].me = false;
      c.reactions[type].count = Math.max(0, c.reactions[type].count - 1);
    } else {
      c.reactions[type].me = true;
      c.reactions[type].count++;
    }

    // Update specific comment reactions UI
    updateCommentReactionsUI(commentId, c.reactions);

    try {
      if (wasMe) {
        await api.removeCommentReaction(App.state.cur, commentId, type);
      } else {
        await api.addCommentReaction(App.state.cur, commentId, type);
      }
    } catch (err) {
      setStatus('ERROR: ' + err.message, true);
      // Revert optimistic update
      if (wasMe) {
        c.reactions[type].me = true;
        c.reactions[type].count++;
      } else {
        c.reactions[type].me = false;
        c.reactions[type].count = Math.max(0, c.reactions[type].count - 1);
      }
      updateCommentReactionsUI(commentId, c.reactions);
    }
  }

  function editCommentInline(commentId) {
    const card = document.querySelector(`.comment-card[data-cid="${commentId}"]`);
    if (!card) return;
    const bodyEl = card.querySelector('.atext');
    if (!bodyEl) return;

    if (card.classList.contains('editing-comment')) return;
    card.classList.add('editing-comment');

    const rawText = card.dataset.rawMarkdown || '';

    bodyEl.innerHTML = `
    <div class="inline-comment-edit-container" id="inline_comment_editor_${commentId}"></div>
  `;

    const editorContainer = document.getElementById(`inline_comment_editor_${commentId}`);
    const ed = new MarkdownEditor(editorContainer, {
      placeholder: 'Edit your comment...',
      allowAttachments: false,
      allowMentions: true
    });
    ed.value = rawText;
    activeCommentEditors.set(commentId, ed);

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'actions inline-comment-edit-actions';
    actionsDiv.style.marginTop = '8px';
    actionsDiv.innerHTML = `
      <button type="button" class="btn btn-sm save save-comment-edit-btn" data-cid="${commentId}">Save</button>
      <button type="button" class="btn btn-sm cancel-comment-edit-btn" data-cid="${commentId}">Cancel</button>
    `;
    editorContainer.appendChild(actionsDiv);
  }
  function cancelEditComment(e, commentId) {
    e.stopPropagation();
    activeCommentEditors.delete(commentId);
    loadActivity();
  }
  async function saveEditComment(e, commentId) {
    e.stopPropagation();
    const ed = activeCommentEditors.get(commentId);
    if (!ed) return;
    const text = ed.value.trim();
    if (!text) return;

    loadStart('saving…');
    try {
      await api.updateComment(App.state.cur, commentId, text);
      setStatus('Comment updated');
      activeCommentEditors.delete(commentId);
    } catch (err) {
      setStatus('ERROR: ' + err.message, true);
    }
    loadEnd();
    loadActivity();
  }

  async function deleteCommentAction(commentId) {
    if (!await customConfirm(window.i18n.t('comment.deleteConfirm'), window.i18n.t('comment.deleteTitle'))) return;
    loadStart('deleting…');
    try {
      await api.deleteComment(App.state.cur, commentId);
      setStatus('Comment deleted');
    } catch (err) {
      setStatus('ERROR: ' + err.message, true);
    }
    loadEnd();
    loadActivity();
  }

  /* ---------- activity: existing comments + field-change history ---------- */
  let _actId = null;
  async function loadActivity(){
    if(App.state.cur==null)return;
    const box=$('s_activity'),id=App.state.cur;_actId=id;
    const arrow = document.querySelector('#activity_toggle_btn .toggle-arrow');
    if (arrow && arrow.textContent === '↻') {
      arrow.classList.add('spinning');
    }
    box.innerHTML='<div class="asec">loading…</div>';
    let cs=[],hs=[];
    try{[cs,hs]=await Promise.all([api.comments(id),api.history(id)]);}catch(e){/* render whatever we got */}
    if (arrow) {
      arrow.classList.remove('spinning');
    }
    if(_actId!==id||App.state.cur!==id)return;                 // user switched items mid-load
    currentComments = cs;
    currentHistory = hs;
    renderActivity(cs,hs);
  }
  async function copyCommentLink(commentId, btn) {
    try {
      const base = await api.browserUrl(App.state.cur);
      const url = `${base}?_a=discussion&Anchor=comment-${commentId}`;
      await navigator.clipboard.writeText(url);
      setStatus('Comment link copied');
      if (btn) {
        const oldHtml = btn.innerHTML;
        btn.innerHTML = '<ui-icon name="check"></ui-icon>';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.innerHTML = oldHtml;
          btn.classList.remove('copied');
        }, 1000);
      }
    } catch(e) {
      setStatus('Failed to copy link: ' + e.message, true);
    }
  }
  function handleActivityClick(e) {
    const copylinkBtn = e.target.closest('.copylink-btn');
    if (copylinkBtn) {
      e.stopPropagation();
      const cid = parseInt(copylinkBtn.dataset.cid, 10);
      copyCommentLink(cid, copylinkBtn);
      return;
    }
    const chip = e.target.closest('.reaction-chip');
    if (chip) {
      e.stopPropagation();
      const cid = parseInt(chip.dataset.cid, 10);
      const type = chip.dataset.type;
      toggleReaction(cid, type);
      return;
    }
    const reactBtn = e.target.closest('.react-btn');
    if (reactBtn) {
      e.stopPropagation();
      const cid = parseInt(reactBtn.dataset.cid, 10);
      showEmojiPicker(reactBtn, cid);
      return;
    }
    const editBtn = e.target.closest('.edit-btn');
    if (editBtn) {
      e.stopPropagation();
      const cid = parseInt(editBtn.dataset.cid, 10);
      editCommentInline(cid);
      return;
    }
    const deleteBtn = e.target.closest('.delete-btn');
    if (deleteBtn) {
      e.stopPropagation();
      const cid = parseInt(deleteBtn.dataset.cid, 10);
      deleteCommentAction(cid);
      return;
    }
    const cancelBtn = e.target.closest('.cancel-comment-edit-btn');
    if (cancelBtn) {
      e.stopPropagation();
      const cid = parseInt(cancelBtn.dataset.cid, 10);
      cancelEditComment(e, cid);
      return;
    }
    const saveBtn = e.target.closest('.save-comment-edit-btn');
    if (saveBtn) {
      e.stopPropagation();
      const cid = parseInt(saveBtn.dataset.cid, 10);
      saveEditComment(e, cid);
      return;
    }
  }

  function handleActivityMouseOver(e) {
    const chip = e.target.closest('.reaction-chip');
    if (!chip) return;
    const cid = parseInt(chip.dataset.cid, 10);
    const type = chip.dataset.type;
    if (!cid || !type) return;

    const cacheKey = `${cid}_${type}`;
    if (reactionCache.has(cacheKey)) {
      const names = reactionCache.get(cacheKey);
      chip.title = names.length ? names.join(', ') : 'No reactions';
      return;
    }

    // Set temporary loading title
    chip.title = 'Loading...';

    // Mark as fetching to avoid duplicate requests
    if (chip.dataset.fetching) return;
    chip.dataset.fetching = 'true';

    api.commentReactionUsers(App.state.cur, cid, type)
      .then(users => {
        reactionCache.set(cacheKey, users);
        chip.title = users.length ? users.join(', ') : 'No reactions';
        delete chip.dataset.fetching;
      })
      .catch(err => {
        chip.title = 'Failed to load';
        delete chip.dataset.fetching;
      });
  }

  function renderActivity(cs,hs){
    const fd=s=>s?String(s).slice(0,16).replace('T',' '):'';

    const countBadge = $('s_activity_count');
    if (countBadge) {
      countBadge.textContent = cs.length;
      countBadge.style.display = cs.length > 0 ? 'inline-block' : 'none';
    }

    const commentsCollapsed = App.prefs.get('activityCommentsCollapsed') === 'true';
    const historyCollapsed = App.prefs.get('activityHistoryCollapsed') === 'true';

    let createdInfoHtml = '';
    if (App.state.openItem) {
      const createdBy = App.state.openItem.createdby || 'Unknown';
      const createdDate = App.state.openItem.createddate ? fd(App.state.openItem.createddate) : 'Unknown';
      createdInfoHtml = `
        <div class="activity-created-info" style="font-size: 0.846rem; color: var(--muted); margin-bottom: 0.769rem; padding: 0 0.308rem; display: flex; align-items: center; gap: 0.462rem;">
          <ui-icon name="info" style="font-size: 1rem;"></ui-icon>
          <span>Created by <strong style="color: var(--txt); font-weight: 500;">${htmlEsc(createdBy)}</strong> on ${createdDate}</span>
        </div>
      `;
    }

    let h = createdInfoHtml + `
    <div class="asec" id="activity_comments_header" style="cursor:pointer; user-select:none; display:flex; justify-content:space-between; align-items:center;">
      <span>Comments (${cs.length})</span>
      <span class="toggle-arrow" style="font-size:10px; color:var(--muted); transition:transform 0.1s ease">${commentsCollapsed ? '<ui-icon name="chevron-right"></ui-icon>' : '<ui-icon name="chevron-down"></ui-icon>'}</span>
    </div>
    <div id="activity_comments_list" class="${commentsCollapsed ? 'hidden' : ''}" style="display:${commentsCollapsed ? 'none' : 'flex'}; flex-direction:column; gap:8px;">
  `;
    if(!cs.length)h+='<div class="achg">no comments</div>';

    const emojiMap = getEmojiMap();

    cs.forEach(c => {
      const initials = personInitials(c.by);
      const avColor = personColor(c.by);
      const reacts = c.reactions || {};
      let reactHtml = '';
      Object.entries(emojiMap).forEach(([type, emoji]) => {
        const data = reacts[type];
        if (data && data.count > 0) {
          const active = data.me ? 'active' : '';
          reactHtml += `<span class="reaction-chip ${active}" data-cid="${c.id}" data-type="${type}" title="Show who reacted"><span class="emoji-symbol">${renderEmojiMarkup(type, emoji)}</span> <span class="rc-count">${data.count}</span></span>`;
        }
      });

      const isAuthor = currentUser && c.by && (c.by.trim().toLowerCase() === currentUser.trim().toLowerCase());
      const actionsHtml = isAuthor ? `
              <button type="button" class="c-action-btn edit-btn" title="Edit comment" data-cid="${c.id}"><ui-icon name="edit"></ui-icon></button>
              <button type="button" class="c-action-btn delete-btn" title="Delete comment" data-cid="${c.id}"><ui-icon name="trash"></ui-icon></button>
    ` : '';

      h += `
      <div class="comment-card" data-cid="${c.id}" data-raw-markdown="${htmlEsc(c.text)}">
        <div class="comment-avatar" style="background:${avColor}">${htmlEsc(initials)}</div>
        <div class="comment-main">
          <div class="comment-header">
            <span class="comment-author">${htmlEsc(c.by)}</span>
            <span class="comment-time">${fd(c.date)}</span>
            <div class="comment-actions">
              <button type="button" class="c-action-btn copylink-btn" title="Copy link to comment" data-cid="${c.id}"><ui-icon name="link"></ui-icon></button>
              <button type="button" class="c-action-btn react-btn" title="Add reaction" data-cid="${c.id}"><ui-icon name="smile"></ui-icon></button>
              ${actionsHtml}
            </div>
          </div>
          <div class="atext">${mdToHtml(c.text, descRenderOpts()).replace(
            /(<img\s[^>]*?)src="(https:\/\/[^"]+\/_apis\/wit\/attachments\/[^"]+)"/gi,
            '$1src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" data-src="$2"'
          )}</div>
          <div class="comment-reactions">${reactHtml}</div>
        </div>
      </div>
    `;
    });
    h += '</div>';

    h += `
    <div class="asec" id="activity_history_header" style="cursor:pointer; user-select:none; display:flex; justify-content:space-between; align-items:center; margin-top:8px;">
      <span>History (${hs.length})</span>
      <span class="toggle-arrow" style="font-size:10px; color:var(--muted); transition:transform 0.1s ease">${historyCollapsed ? '<ui-icon name="chevron-right"></ui-icon>' : '<ui-icon name="chevron-down"></ui-icon>'}</span>
    </div>
    <div id="activity_history_list" class="${historyCollapsed ? 'hidden' : ''}" style="display:${historyCollapsed ? 'none' : 'flex'}; flex-direction:column; gap:6px;">
  `;
    if(!hs.length)h+='<div class="achg">no recorded changes</div>';

    hs.forEach(u => {
      const chg = u.changes.map(c => `
      <div class="achg-row">
        <span class="achg-field">${htmlEsc(c.field)}:</span>
        <span class="achg-from">${htmlEsc(String(c.from)||'∅')}</span>
        <span class="achg-arrow">→</span>
        <span class="achg-to">${htmlEsc(String(c.to)||'∅')}</span>
      </div>
    `).join('');

      h += `
      <div class="history-item">
        <div class="history-avatar"><ui-icon name="tool"></ui-icon></div>
        <div class="history-main">
          <div class="history-header">
            <span class="history-author">${htmlEsc(u.by)}</span>
            <span class="history-time">${fd(u.date)}</span>
          </div>
          <div class="history-changes">${chg}</div>
        </div>
      </div>
    `;
    });
    h += '</div>';

    const box = $('s_activity');
    box.innerHTML=h;
    hydratePreviewImages(box);
    colorMentions(box);
    hydrateCodeBlocks(box);

    if (box && !box.dataset.wired) {
      box.dataset.wired = 'true';
      box.addEventListener('click', handleActivityClick);
      box.addEventListener('mouseover', handleActivityMouseOver);
    }

    const ach = $('activity_comments_header');
    if (ach) {
      ach.onclick = () => {
        const list = $('activity_comments_list');
        const arrow = ach.querySelector('.toggle-arrow');
        const collapsed = !list.classList.contains('hidden');
        list.classList.toggle('hidden', collapsed);
        list.style.display = collapsed ? 'none' : 'flex';
        arrow.innerHTML = collapsed ? '<ui-icon name="chevron-right"></ui-icon>' : '<ui-icon name="chevron-down"></ui-icon>';
        App.prefs.set('activityCommentsCollapsed', collapsed);
      };
    }
    const ahh = $('activity_history_header');
    if (ahh) {
      ahh.onclick = () => {
        const list = $('activity_history_list');
        const arrow = ahh.querySelector('.toggle-arrow');
        const collapsed = !list.classList.contains('hidden');
        list.classList.toggle('hidden', collapsed);
        list.style.display = collapsed ? 'none' : 'flex';
        arrow.innerHTML = collapsed ? '<ui-icon name="chevron-right"></ui-icon>' : '<ui-icon name="chevron-down"></ui-icon>';
        App.prefs.set('activityHistoryCollapsed', collapsed);
      };
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

  App.activity = {
    showEmojisModal, updateEmojiInputPreview, showEmojiRowError,
    closeEmojisModal, resetEmojis, saveEmojis,
    toggleActivityExpand, toggleActivityFullscreen, initActivityResizer,
    closeEmojiPicker, loadActivity, hydrateCodeBlocks,
  };
})(window.App);

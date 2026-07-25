// FollowManager: per-item "follow / watch" feature (the star button + revision
// tracking for notifications). NOTE: this is NOT billing/premium — the paid-tier
// entitlement logic lives in the (separate) EntitlementManager.
// Localized string helper (guarded: degrades to the English fallback if i18n not ready).
const FOLLOW_L = (k, fallback, p) => (typeof window !== 'undefined' && window.i18n) ? window.i18n.t(k, p) : fallback;

window.FollowManager = {
  openItemCallback: null,

  init(openItemCallback) {
    this.openItemCallback = openItemCallback;

    // Listen to messages from background
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener((msg) => {
        if (msg.action === 'openItem' && msg.id && this.openItemCallback) {
          this.openItemCallback(App.backend.gid(msg.id));
        }
      });
    }
  },

  async _getFollowed() {
    if (window.App && window.App.cache) {
      const res = await window.App.cache.get('followed_items');
      if (res) return res;
    }
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      try {
        const res = await chrome.storage.local.get("followedItems");
        return res.followedItems || {};
      } catch (_) {}
    }
    return {};
  },

  async _saveFollowed(items) {
    if (window.App && window.App.cache) {
      await window.App.cache.set('followed_items', items);
    }
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      try {
        await chrome.storage.local.set({ followedItems: items });
      } catch (_) {}
    }
  },

  async updateButtonState(itemId) {
    const btn = document.getElementById('s_follow');
    if (!btn) return;
    const followedItems = await this._getFollowed();
    const isFollowed = !!(followedItems && followedItems[itemId]);
    btn.classList.toggle('active', isFollowed);
    btn.innerHTML = isFollowed ? '<ui-icon name="star-filled"></ui-icon>' : '<ui-icon name="star"></ui-icon>';
    btn.title = isFollowed ? FOLLOW_L('follow.unfollow', 'Unfollow this item') : FOLLOW_L('follow.follow', 'Follow this item');
  },

  async toggleFollow(itemId, itemData) {
    const followedItems = await this._getFollowed();
    const isFollowed = !!followedItems[itemId];
    const btn = document.getElementById('s_follow');
    if (isFollowed) {
      delete followedItems[itemId];
      if (btn) {
        btn.classList.remove('active');
        btn.innerHTML = '<ui-icon name="star"></ui-icon>';
        btn.title = FOLLOW_L('follow.follow', 'Follow this item');
      }
    } else {
      const { org, project } = (window.api && window.api.getConfig) ? (await window.api.getConfig()) : { org: '', project: '' };
      followedItems[itemId] = {
        id: itemData.id,
        title: itemData.title,
        rev: itemData.rev,
        state: itemData.state,
        assigned: itemData.assigned,
        updatedTime: new Date().toISOString(),
        org,
        project
      };
      if (btn) {
        btn.classList.add('active');
        btn.innerHTML = '<ui-icon name="star-filled"></ui-icon>';
        btn.title = FOLLOW_L('follow.unfollow', 'Unfollow this item');
      }
    }
    await this._saveFollowed(followedItems);
  },

  async updateItemRev(itemId, newRev, state, title, assigned) {
    const followedItems = await this._getFollowed();
    if (followedItems && followedItems[itemId]) {
      followedItems[itemId].rev = newRev;
      if (state !== undefined) followedItems[itemId].state = state;
      if (title !== undefined) followedItems[itemId].title = title;
      if (assigned !== undefined) followedItems[itemId].assigned = assigned;
      followedItems[itemId].updatedTime = new Date().toISOString();
      await this._saveFollowed(followedItems);
    }
  }
};

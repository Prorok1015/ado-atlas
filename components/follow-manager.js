// FollowManager: per-item "follow / watch" feature (the star button + revision
// tracking for notifications). NOTE: this is NOT billing/premium — the paid-tier
// entitlement logic lives in the (separate) EntitlementManager.
window.FollowManager = {
  openItemCallback: null,

  init(openItemCallback) {
    this.openItemCallback = openItemCallback;

    // Listen to messages from background
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.action === 'openItem' && msg.id && this.openItemCallback) {
        this.openItemCallback(parseInt(msg.id, 10));
      }
    });
  },

  async updateButtonState(itemId) {
    const btn = document.getElementById('s_follow');
    if (!btn) return;
    const { followedItems } = await chrome.storage.local.get("followedItems");
    const isFollowed = !!(followedItems && followedItems[itemId]);
    btn.classList.toggle('active', isFollowed);
    btn.innerHTML = isFollowed ? '<ui-icon name="star-filled"></ui-icon>' : '<ui-icon name="star"></ui-icon>';
    btn.title = isFollowed ? 'Unfollow this item' : 'Follow this item';
  },

  async toggleFollow(itemId, itemData) {
    const { followedItems = {} } = await chrome.storage.local.get("followedItems");
    const isFollowed = !!followedItems[itemId];
    const btn = document.getElementById('s_follow');
    if (isFollowed) {
      delete followedItems[itemId];
      if (btn) {
        btn.classList.remove('active');
        btn.innerHTML = '<ui-icon name="star"></ui-icon>';
        btn.title = 'Follow this item';
      }
    } else {
      const { org, project } = await api.getConfig();
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
        btn.title = 'Unfollow this item';
      }
    }
    await chrome.storage.local.set({ followedItems });
  },

  async updateItemRev(itemId, newRev, state, title, assigned) {
    const { followedItems } = await chrome.storage.local.get("followedItems");
    if (followedItems && followedItems[itemId]) {
      followedItems[itemId].rev = newRev;
      if (state !== undefined) followedItems[itemId].state = state;
      if (title !== undefined) followedItems[itemId].title = title;
      if (assigned !== undefined) followedItems[itemId].assigned = assigned;
      followedItems[itemId].updatedTime = new Date().toISOString();
      await chrome.storage.local.set({ followedItems });
    }
  }
};

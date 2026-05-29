// Service worker. The only job is to open the full UI in a tab when the
// toolbar icon is clicked. We deliberately don't use chrome.action.default_popup
// because the tree / graph / board layouts need a full window.
chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL("index.html");
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((t) => t.url && t.url.startsWith(url));
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
});

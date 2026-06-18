importScripts('lib.js', 'api.js');

// On extension click, open/focus the UI
chrome.action.onClicked.addListener(async () => {
  await openAppWindow();
});

async function openAppWindow(itemId) {
  const baseUrl = chrome.runtime.getURL("index.html");
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((t) => t.url && t.url.startsWith(baseUrl));
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
    if (itemId) {
      // Send message to open the item immediately without reloading
      chrome.tabs.sendMessage(existing.id, { action: "openItem", id: itemId });
    }
  } else {
    const url = itemId ? `${baseUrl}?root=${itemId}` : baseUrl;
    await chrome.tabs.create({ url });
  }
}

// Alarms to check for updates
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("check-followed-items", { periodInMinutes: 5 });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "check-followed-items") {
    await checkFollowedItems();
  }
});

async function checkFollowedItems() {
  try {
    const { followedItems = {}, followNotify = "on" } = await chrome.storage.local.get(["followedItems", "followNotify"]);

    const config = await api.getConfig();
    if (!config || !config.org || !config.project) return;

    // 1. Fetch native followed item IDs from the ADO server
    let serverIds = [];
    try {
      const proj = await api.projUrl();
      const url = `${proj}/_apis/wit/wiql?api-version=7.1`;
      const query = {
        query: `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.Id] IN (@follows)`
      };
      const res = await api.req("POST", url, query);
      serverIds = (res.workItems || []).map(wi => wi.id);
    } catch (wiqlErr) {
      console.error("Failed to query @follows from server:", wiqlErr);
    }

    // 2. Identify new items followed on the server that are not in followedItems
    const newServerIds = serverIds.filter(id => !followedItems[id]);
    if (newServerIds.length > 0) {
      const newRawItems = await api.batchFetch(newServerIds, ["System.Rev"]);
      for (const raw of newRawItems) {
        followedItems[raw.id] = {
          id: raw.id,
          rev: raw.rev,
          updatedTime: new Date().toISOString(),
          org: config.org,
          project: config.project,
          followedOnServer: true
        };
      }
    }

    // 3. Filter followed items matching current org & project
    const activeFollowed = Object.values(followedItems).filter(
      (item) => item.org === config.org && item.project === config.project
    );
    if (activeFollowed.length === 0) {
      if (newServerIds.length > 0) {
        await chrome.storage.local.set({ followedItems });
      }
      return;
    }

    const ids = activeFollowed.map((item) => item.id);
    // Fetch only System.Rev field from ADO API
    const currentItems = await api.batchFetch(ids, ["System.Rev"]);

    // Find which items have newer revisions
    const changedItems = [];
    for (const raw of currentItems) {
      const stored = followedItems[raw.id];
      if (stored && raw.rev > stored.rev) {
        changedItems.push({ id: raw.id, oldRev: stored.rev, newRev: raw.rev });
      }
    }

    let updated = false;
    if (changedItems.length > 0) {
      // Fetch history details and item headers in parallel (max 6-wide concurrency)
      const results = await api.pool(changedItems.map(item => async () => {
        try {
          // 1. Fetch the updates history for the item
          const proj = await api.projUrl();
          const r = await api.req("GET", `${proj}/_apis/wit/workItems/${item.id}/updates?api-version=7.1`);
          const updates = r.value || [];

          // 2. Fetch the current item details (title etc.)
          const rawItems = await api.batchFetch([item.id], ["System.Title"]);
          const title = (rawItems[0] && rawItems[0].fields && rawItems[0].fields["System.Title"]) || `Work Item #${item.id}`;

          // Filter updates that occurred between oldRev and newRev
          const recentUpdates = updates.filter(u => u.rev > item.oldRev && u.rev <= item.newRev);

          // Aggregate changes
          const changeDescriptions = [];
          let author = "Someone";

          recentUpdates.forEach(u => {
            if (u.revisedBy && u.revisedBy.displayName) {
              author = u.revisedBy.displayName;
            }
            const fields = u.fields || {};
            for (const ref of Object.keys(fields)) {
              if (ref === "System.Rev" || ref === "System.ChangedDate" || ref === "System.ChangedBy") continue;
              const ov = fields[ref] || {};
              if (!("newValue" in ov) && !("oldValue" in ov)) continue;

              // Map common fields to clean names
              let fieldName = ref;
              if (ref === "System.State") fieldName = "State";
              else if (ref === "System.AssignedTo") fieldName = "Assigned";
              else if (ref === "System.Title") fieldName = "Title";
              else if (ref === "System.IterationPath") fieldName = "Sprint";
              else if (ref === "Microsoft.VSTS.Common.Priority") fieldName = "Priority";
              else if (ref === "System.Parent") fieldName = "Parent";
              else if (ref === "Microsoft.VSTS.Scheduling.TargetDate") fieldName = "Target Date";
              else if (ref === "Microsoft.VSTS.Scheduling.OriginalEstimate") fieldName = "Estimate";
              else if (ref === "System.Tags") fieldName = "Tags";
              else {
                // Shorten field name if it's long
                const parts = ref.split('.');
                fieldName = parts[parts.length - 1];
              }

              const fromVal = ov.oldValue ? (typeof ov.oldValue === "object" ? ov.oldValue.displayName || JSON.stringify(ov.oldValue) : String(ov.oldValue)) : "None";
              const toVal = ov.newValue ? (typeof ov.newValue === "object" ? ov.newValue.displayName || JSON.stringify(ov.newValue) : String(ov.newValue)) : "None";

              changeDescriptions.push(`${fieldName}: ${fromVal} ➔ ${toVal}`);
            }
          });

          return {
            id: item.id,
            newRev: item.newRev,
            title,
            author,
            changes: changeDescriptions
          };
        } catch (err) {
          console.error(`Error fetching updates for #${item.id}:`, err);
          return null;
        }
      }), 6);

      // Process results and trigger notifications
      for (const res of results) {
        if (!res) continue;
        const stored = followedItems[res.id];
        if (!stored) continue;

        // Send browser notification if enabled
        if (followNotify !== "off") {
          let message = res.changes.length > 0
            ? res.changes.join("\n")
            : `Revision changed to ${res.newRev}`;
          
          // Truncate message if it is too long (Chrome has limits on notification message height)
          if (res.changes.length > 5) {
            message = res.changes.slice(0, 5).join("\n") + `\n(+ ${res.changes.length - 5} more changes)`;
          }

          chrome.notifications.create(`follow-item-${res.id}`, {
            type: "basic",
            iconUrl: "icons/icon-128.png",
            title: `[#${res.id}] ${res.title}`,
            message: `${res.author} updated this item:\n${message}`,
            contextMessage: `ADO Atlas`,
            requireInteraction: true
          });
        }

        // Update stored cache
        followedItems[res.id] = {
          ...stored,
          rev: res.newRev,
          updatedTime: new Date().toISOString()
        };
        updated = true;
      }
    }

    // 4. Clean up items that were followed on server, but have been unfollowed on server
    for (const id in followedItems) {
      const stored = followedItems[id];
      if (stored.followedOnServer && stored.org === config.org && stored.project === config.project) {
        if (!serverIds.includes(Number(id))) {
          delete followedItems[id];
          updated = true;
        }
      }
    }

    if (updated || newServerIds.length > 0) {
      await chrome.storage.local.set({ followedItems });
    }
  } catch (err) {
    console.error("Error checking followed items:", err);
  }
}

// Handle notification clicks
chrome.notifications.onClicked.addListener((notificationId) => {
  if (notificationId.startsWith("follow-item-")) {
    const itemId = notificationId.replace("follow-item-", "");
    openAppWindow(itemId);
  }
});

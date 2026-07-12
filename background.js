importScripts(
  'src/core/lib.js',
  'src/core/api/core.js',
  'src/core/api/http-auth.js',
  'src/core/api/query.js',
  'src/core/api/endpoints.js',
  'src/core/api/graph.js',
  'src/core/api/items.js',
  'src/core/api/time.js',
  'src/core/api/facade.js',
  'src/core/analytics.js'
);

// ---- Dynamic notification i18n from JSON locale files (service worker has no window.i18n) ----
let activeLocaleDict = {};
let fallbackLocaleDict = {};

// Load JSON locale file from the extension's bundle dynamically.
async function loadLocaleDict(lang) {
  try {
    if (!fallbackLocaleDict["notify.openButton"]) {
      const fallbackUrl = chrome.runtime.getURL("src/locales/en.json");
      const res = await fetch(fallbackUrl);
      fallbackLocaleDict = await res.json();
    }
    if (lang === "en") {
      activeLocaleDict = fallbackLocaleDict;
    } else {
      const url = chrome.runtime.getURL(`src/locales/${lang}.json`);
      const res = await fetch(url);
      if (res.ok) {
        activeLocaleDict = await res.json();
      } else {
        activeLocaleDict = fallbackLocaleDict;
      }
    }
  } catch (e) {
    activeLocaleDict = fallbackLocaleDict;
  }
}

// Resolve a notification string using the preloaded locale dictionary and format tokens.
function nt(id, params) {
  const template = activeLocaleDict[`notify.${id}`] || fallbackLocaleDict[`notify.${id}`] || id;
  return globalThis.AdoLib.formatMessage(template, params || {});
}

// Read a synced preference (followNotify/mentionNotify/notifyAge/ado.lang) written by
// the app through App.prefs. Prefer the roamed chrome.storage.sync value; fall back to
// chrome.storage.local — App.prefs dual-writes both, so local covers the migration
// window (before the page first promotes to sync) and the case where Chrome Sync is off.
async function getSyncedPref(key, dflt) {
  try {
    const s = await chrome.storage.sync.get(key);
    if (s && s[key] !== undefined) return s[key];
  } catch (_) {}
  try {
    const l = await chrome.storage.local.get(key);
    if (l && l[key] !== undefined) return l[key];
  } catch (_) {}
  return dflt;
}

// Read the active language (roams via App.prefs under 'ado.lang').
async function getNotifyLang() {
  return await getSyncedPref("ado.lang", "en") || "en";
}

// On extension click, open/focus the UI
chrome.action.onClicked.addListener(async () => {
  await openAppWindow();
});

// Handle notification clicks
chrome.notifications.onClicked.addListener((notificationId) => {
  const match = notificationId.match(/^app-item-(\d+)/);
  if (match) {
    const itemId = match[1];
    openAppWindow(itemId);
  }
});

chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
  const match = notificationId.match(/^app-item-(\d+)/);
  if (match) {
    const itemId = match[1];
    openAppWindow(itemId);
  }
});

async function openAppWindow(itemId) {
  const baseUrl = chrome.runtime.getURL("index.html");
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((t) => {
    if (!t.url) return false;
    try {
      const tabUrlClean = t.url.split('?')[0].split('#')[0];
      const baseUrlClean = baseUrl.split('?')[0].split('#')[0];
      return tabUrlClean === baseUrlClean;
    } catch (_) {
      return t.url.startsWith(baseUrl);
    }
  });
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

// Ensure a stable per-install identifier exists (used for license device
// binding — see PREMIUM_IMPLEMENTATION_DESIGN.md). Generated once and persisted.
async function ensureInstallationId() {
  try {
    const { installation_id } = await chrome.storage.local.get("installation_id");
    if (!installation_id) {
      await chrome.storage.local.set({ installation_id: crypto.randomUUID() });
    }
  } catch (e) {
    console.error("ensureInstallationId failed:", e);
  }
}

// STUB (Stage 2): daily license validation against the Go backend.
// POST { license_key, installation_id } to /api/license/validate; on success
// persist { entitlement: { tier, status, expires_at, last_validated_at: Date.now() } }.
// On network error DO NOT downgrade — the frontend EntitlementManager applies a
// 7-day grace period based on last_validated_at.
async function validateLicenseBackground() {
  try {
    const { license_key } = await chrome.storage.local.get("license_key");
    if (!license_key) return; // Free user — nothing to validate.
    // TODO(Stage 2): implement backend call once the Go API is live.
  } catch (e) {
    console.error("validateLicenseBackground failed:", e);
  }
}

// Alarms to check for updates
chrome.runtime.onInstalled.addListener((details) => {
  chrome.alarms.create("check-notifications", { periodInMinutes: 5 });
  chrome.alarms.create("validate-license", { periodInMinutes: 1440 }); // daily
  ensureInstallationId();
  // Telemetry: distinguish first install from a version update (GA4 lifecycle).
  try {
    if (details.reason === "install") {
      globalThis.AdoAnalytics.collect("extension_install");
    } else if (details.reason === "update") {
      globalThis.AdoAnalytics.collect("extension_update", { previous_version: details.previousVersion });
    }
  } catch (_) {}
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "check-notifications") {
    await runAllNotificationChecks();
  } else if (alarm.name === "validate-license") {
    await validateLicenseBackground();
  }
});

// Run check on startup/service worker load
chrome.runtime.onStartup.addListener(async () => {
  await ensureInstallationId();
  await runAllNotificationChecks();
});

// Listen to trigger checks from the frontend page
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "checkMentionsAndFollows") {
    runAllNotificationChecks().then(() => {
      if (sendResponse) sendResponse({ success: true });
    }).catch(err => {
      console.error("Manual notification sync check failed:", err);
      if (sendResponse) sendResponse({ error: err.message });
    });
    return true; // Keep channel open for async response
  }
  if (msg.action === "fetchCloudAI") {
    const { url, method, headers, body } = msg;
    fetch(url, { method, headers, body })
      .then(async (res) => {
        const text = await res.text();
        if (sendResponse) sendResponse({ status: res.status, statusText: res.statusText, text });
      })
      .catch((err) => {
        if (sendResponse) sendResponse({ error: err.message });
      });
    return true; // Keep channel open for async response
  }
  if (msg.action === "ga") {
    // Telemetry event forwarded from a page via App.analytics.track(). Fire-and-forget:
    // ack immediately so the sender's sendMessage promise resolves and the channel closes.
    try { globalThis.AdoAnalytics.collect(msg.name, msg.params); } catch (_) {}
    if (sendResponse) sendResponse({ ok: true });
    return false; // synchronous ack; the GA POST runs detached
  }
  if (msg.action === "fetchHostedAI") {
    // STUB (Stage 2): forward { license_key, installation_id, prompt, context } to
    // the Go backend /api/ai/prompt, which injects the server-side LLM key and
    // enforces per-license rate limits. The backend is not live yet.
    if (sendResponse) sendResponse({ error: "Hosted AI proxy is not available yet." });
    return true; // Keep channel open for async response
  }
});

async function runAllNotificationChecks() {
  try {
    const notifyLang = await getNotifyLang();
    await loadLocaleDict(notifyLang);

    // User-data (followed/mentioned caches) stay in chrome.storage.local; the notify
    // preferences roam, so read them sync-first via getSyncedPref.
    const {
      followedItems = {}, mentionedItems = {}, assignedItems = {},
      mentionCacheInitialized = false, assignedCacheInitialized = false
    } = await chrome.storage.local.get([
      "followedItems", "mentionedItems", "assignedItems",
      "mentionCacheInitialized", "assignedCacheInitialized"
    ]);
    const followNotify = await getSyncedPref("followNotify", "on");
    const mentionNotify = await getSyncedPref("mentionNotify", "on");
    const notifyAge = await getSyncedPref("notifyAge", "172800");

    const maxAgeMs = parseInt(notifyAge, 10) * 1000;

    const config = await api.getConfig();
    if (!config || !config.org || !config.project) return;

    // 1. Get authenticated user display name for mentions
    const displayName = await api.me();
    const escapedName = displayName ? displayName.replace(/'/g, "''") : "";

    // 2. Fetch native followed item IDs
    let serverFollowedIds = [];
    try {
      const proj = await api.projUrl();
      const url = `${proj}/_apis/wit/wiql?api-version=7.1`;
      const query = {
        query: `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.Id] IN (@follows)`
      };
      const res = await api.req("POST", url, query);
      serverFollowedIds = (res.workItems || []).map(wi => wi.id);
    } catch (err) {
      console.error("Failed to query @follows:", err);
    }

    // Identify new followed items on the server
    const newServerFollowedIds = serverFollowedIds.filter(id => !followedItems[id]);
    if (newServerFollowedIds.length > 0) {
      const newRawItems = await api.batchFetch(newServerFollowedIds, ["System.Rev"]);
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

    // 3. Fetch native mentioned and assigned item IDs via WIQL if name resolved
    let serverMentionedIds = [];
    let serverAssignedIds = [];
    if (displayName) {
      try {
        const proj = await api.projUrl();
        const url = `${proj}/_apis/wit/wiql?api-version=7.1`;
        
        // Mentions query
        const mQuery = {
          query: `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.History] CONTAINS '@[${escapedName}]'`
        };
        const mRes = await api.req("POST", url, mQuery);
        serverMentionedIds = (mRes.workItems || []).map(wi => wi.id);

        // Assigned query (recent 14 days to keep cache manageable)
        const aQuery = {
          query: `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.AssignedTo] = @me AND [System.ChangedDate] >= @today - 14`
        };
        const aRes = await api.req("POST", url, aQuery);
        serverAssignedIds = (aRes.workItems || []).map(wi => wi.id);
      } catch (err) {
        console.error("Failed to query mentions/assigned:", err);
      }
    }

    // Check Stage 1 initialization for mentions and assignments
    let cachesUpdated = false;
    if (!mentionCacheInitialized && displayName) {
      const currentMentionItems = await api.batchFetch(serverMentionedIds, ["System.Rev"]);
      for (const raw of currentMentionItems) {
        mentionedItems[raw.id] = { id: raw.id, rev: raw.rev, org: config.org, project: config.project };
      }
      cachesUpdated = true;
    }
    if (!assignedCacheInitialized && displayName) {
      const currentAssignedItems = await api.batchFetch(serverAssignedIds, ["System.Rev"]);
      for (const raw of currentAssignedItems) {
        assignedItems[raw.id] = { id: raw.id, rev: raw.rev, org: config.org, project: config.project };
      }
      cachesUpdated = true;
    }

    if (cachesUpdated) {
      await chrome.storage.local.set({
        mentionedItems,
        assignedItems,
        mentionCacheInitialized: true,
        assignedCacheInitialized: true,
        followedItems
      });
      return;
    }

    // 4. Combine all IDs to inspect for changes (Union of followed + mentioned + assigned)
    const activeFollowed = Object.values(followedItems).filter(
      item => item.org === config.org && item.project === config.project
    );
    const activeMentioned = Object.values(mentionedItems).filter(
      item => item.org === config.org && item.project === config.project
    );
    const activeAssigned = Object.values(assignedItems).filter(
      item => item.org === config.org && item.project === config.project
    );

    const allMonitoredIds = Array.from(new Set([
      ...activeFollowed.map(item => item.id),
      ...serverMentionedIds,
      ...serverAssignedIds
    ]));

    if (allMonitoredIds.length === 0) {
      // Clean up server followed items if needed
      let cleanUpdated = false;
      for (const id in followedItems) {
        const stored = followedItems[id];
        if (stored.followedOnServer && stored.org === config.org && stored.project === config.project) {
          if (!serverFollowedIds.includes(Number(id))) {
            delete followedItems[id];
            cleanUpdated = true;
          }
        }
      }
      if (cleanUpdated) {
        await chrome.storage.local.set({ followedItems });
      }
      return;
    }

    // Fetch only System.Rev field for all IDs in bulk
    const currentRevs = await api.batchFetch(allMonitoredIds, ["System.Rev"]);

    // Determine tasks to check history for
    const itemsToCheck = [];
    for (const raw of currentRevs) {
      const storedFollow = followedItems[raw.id];
      const storedMention = mentionedItems[raw.id];
      const storedAssigned = assignedItems[raw.id];
      
      const isFollowChanged = storedFollow && raw.rev > storedFollow.rev;
      const isMentionChanged = storedMention && raw.rev > storedMention.rev;
      const isAssignedChanged = storedAssigned && raw.rev > storedAssigned.rev;
      
      const isNewMention = !storedMention && serverMentionedIds.includes(raw.id);
      const isNewAssigned = !storedAssigned && serverAssignedIds.includes(raw.id);

      if (isFollowChanged || isMentionChanged || isNewMention || isAssignedChanged || isNewAssigned) {
        itemsToCheck.push({
          id: raw.id,
          oldFollowRev: storedFollow ? storedFollow.rev : raw.rev,
          oldMentionRev: storedMention ? storedMention.rev : 0,
          oldAssignedRev: storedAssigned ? storedAssigned.rev : 0,
          newRev: raw.rev,
          isFollowChanged,
          isMentionChanged,
          isNewMention,
          isAssignedChanged,
          isNewAssigned
        });
      }
    }

    if (itemsToCheck.length === 0) {
      // Clean up server followed items if needed
      let cleanUpdated = false;
      for (const id in followedItems) {
        const stored = followedItems[id];
        if (stored.followedOnServer && stored.org === config.org && stored.project === config.project) {
          if (!serverFollowedIds.includes(Number(id))) {
            delete followedItems[id];
            cleanUpdated = true;
          }
        }
      }
      if (cleanUpdated) {
        await chrome.storage.local.set({ followedItems });
      }
      return;
    }

    // Concurrently fetch updates history and titles (max 6-wide concurrency)
    const results = await api.pool(itemsToCheck.map(item => async () => {
      try {
        const proj = await api.projUrl();
        const r = await api.req("GET", `${proj}/_apis/wit/workItems/${item.id}/updates?api-version=7.1`);
        const updates = r.value || [];

        const rawItems = await api.batchFetch([item.id], ["System.Title"]);
        const title = (rawItems[0] && rawItems[0].fields && rawItems[0].fields["System.Title"]) || `Work Item #${item.id}`;

        const minOldRev = Math.min(item.oldFollowRev, item.oldMentionRev === 0 ? item.newRev : item.oldMentionRev, item.oldAssignedRev === 0 ? item.newRev : item.oldAssignedRev);
        const recentUpdates = updates.filter(u => u.rev > minOldRev && u.rev <= item.newRev);

        let author = "Someone";
        const foundMentions = [];
        const foundAssignments = [];
        const changeDescriptions = [];

        recentUpdates.forEach(u => {
          if (u.revisedBy && u.revisedBy.displayName) {
            author = u.revisedBy.displayName;
          }
          
          // Check update timestamp to filter outdated events
          const updateDateStr = u.revisedDate || (u.fields && u.fields["System.ChangedDate"] && u.fields["System.ChangedDate"].newValue);
          const updateTime = updateDateStr ? new Date(updateDateStr).getTime() : 0;
          const isTooOld = updateTime > 0 && (Date.now() - updateTime) > maxAgeMs;

          const fields = u.fields || {};

          for (const ref of Object.keys(fields)) {
            if (ref === "System.Rev" || ref === "System.ChangedDate" || ref === "System.ChangedBy" || 
                ref === "System.Watermark" || ref === "System.AuthorizedDate" || ref === "System.RevisedDate" ||
                ref === "System.AuthorizedAs") continue;

            const ov = fields[ref] || {};
            const textVal = ov.newValue ? (typeof ov.newValue === "object" ? ov.newValue.displayName || JSON.stringify(ov.newValue) : String(ov.newValue)) : "";

            // 1. Map field name
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
            else if (ref === "System.History") fieldName = "Comment";
            else if (ref === "System.Description") fieldName = "Description";
            else if (ref === "Microsoft.VSTS.Common.AcceptanceCriteria") fieldName = "Acceptance Criteria";
            else {
              const parts = ref.split('.');
              fieldName = parts[parts.length - 1];
            }

            // 2. Check for mentions if revision is newer than the old mention revision
            const isMentionRev = u.rev > item.oldMentionRev;
            if (!isTooOld && isMentionRev && displayName && (textVal.includes(`@[${displayName}]`) || textVal.includes(`@${displayName}`))) {
              let cleanText = textVal.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
              if (cleanText.length > 120) {
                cleanText = cleanText.slice(0, 120) + "...";
              }
              foundMentions.push({ author, fieldName, text: cleanText });
            }

            // 3. Check for assignment
            const isAssignedRev = u.rev > item.oldAssignedRev;
            if (!isTooOld && isAssignedRev && ref === "System.AssignedTo") {
              const assignedToName = ov.newValue && typeof ov.newValue === "object" ? ov.newValue.displayName : String(ov.newValue || "");
              if (assignedToName === displayName) {
                foundAssignments.push({ author, fieldName });
              }
            }

            // 4. Collect general changes if revision is newer than old follow revision
            const isFollowRev = u.rev > item.oldFollowRev;
            if (!isTooOld && isFollowRev) {
              // Ignore comment count metadata changes, since they are redundant with actual comments
              if (ref === "System.CommentCount") continue;

              let fromVal = ov.oldValue ? (typeof ov.oldValue === "object" ? ov.oldValue.displayName || JSON.stringify(ov.oldValue) : String(ov.oldValue)) : "None";
              let toVal = ov.newValue ? (typeof ov.newValue === "object" ? ov.newValue.displayName || JSON.stringify(ov.newValue) : String(ov.newValue)) : "None";
              
              // Strip HTML tags for cleaner display in notification popup
              fromVal = fromVal.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
              toVal = toVal.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

              changeDescriptions.push(`${fieldName}: ${fromVal} → ${toVal}`);
            }
          }
        });

        return {
          id: item.id,
          newRev: item.newRev,
          title,
          author,
          foundMentions,
          foundAssignments,
          changes: changeDescriptions,
          isFollowed: !!followedItems[String(item.id)],
          isMentioned: serverMentionedIds.includes(Number(item.id)),
          isAssigned: serverAssignedIds.includes(Number(item.id))
        };
      } catch (err) {
        console.error(`Error processing updates for #${item.id}:`, err);
        return null;
      }
    }), 6);

    let followedItemsUpdated = false;
    let mentionedItemsUpdated = false;

    for (const res of results) {
      if (!res) continue;

      // Notify assignments
      if (res.foundAssignments && res.foundAssignments.length > 0 && mentionNotify !== "off") {
        res.foundAssignments.forEach(a => {
          chrome.notifications.create(`app-item-${res.id}-assigned`, {
            type: "basic",
            iconUrl: "icons/icon-128.png",
            title: nt("assignedTitle", { id: res.id, title: res.title }),
            message: nt("assignedMessage", { author: a.author }),
            contextMessage: nt("contextMessage"),
            buttons: [{ title: nt("openButton") }],
            priority: 2,
            requireInteraction: true
          }, (id) => {
            if (chrome.runtime.lastError) console.error("Assigned notification error:", chrome.runtime.lastError);
          });
        });
      }

      // Prioritize Mention notification over Followed notification if BOTH occurred
      if (res.foundMentions && res.foundMentions.length > 0 && mentionNotify !== "off") {
        // Group mentions
        const uniqueMentionsByAuthor = {};
        res.foundMentions.forEach(m => {
          const key = `${m.author}_${m.fieldName}`;
          if (!uniqueMentionsByAuthor[key]) uniqueMentionsByAuthor[key] = [];
          uniqueMentionsByAuthor[key].push(m.text);
        });

        Object.keys(uniqueMentionsByAuthor).forEach((key, idx) => {
          const [author, fieldName] = key.split('_');
          const texts = uniqueMentionsByAuthor[key];
          const combinedText = texts.join("\n...\n");

          chrome.notifications.create(`app-item-${res.id}-${idx}`, {
            type: "basic",
            iconUrl: "icons/icon-128.png",
            title: nt("mentionTitle", { id: res.id, title: res.title }),
            message: nt("mentionMessage", { author, fieldName, text: combinedText }),
            contextMessage: nt("contextMessage"),
            buttons: [{ title: nt("openButton") }],
            priority: 2,
            requireInteraction: true
          }, (id) => {
            if (chrome.runtime.lastError) {
              console.error("Mention notification error:", chrome.runtime.lastError);
            }
          });
        });
      } else if (res.changes.length > 0 && res.isFollowed && followNotify !== "off") {
        // Standard Follow notification
        let message = res.changes.join("\n");
        if (res.changes.length > 5) {
          message = res.changes.slice(0, 5).join("\n") + "\n" + nt("moreChanges", { count: res.changes.length - 5 });
        }

        chrome.notifications.create(`app-item-${res.id}-follow`, {
          type: "basic",
          iconUrl: "icons/icon-128.png",
          title: nt("followTitle", { id: res.id, title: res.title }),
          message: nt("followMessage", { author: res.author, changes: message }),
          contextMessage: nt("contextMessage"),
          buttons: [{ title: nt("openButton") }],
          priority: 2,
          requireInteraction: true
        }, (id) => {
          if (chrome.runtime.lastError) {
            console.error("Follow notification error:", chrome.runtime.lastError);
          }
        });
      }

      // Update Followed cache if it was monitored and changed
      if (followedItems[res.id]) {
        followedItems[res.id] = {
          ...followedItems[res.id],
          rev: res.newRev,
          updatedTime: new Date().toISOString()
        };
        followedItemsUpdated = true;
      }

      // Update Mentioned cache
      mentionedItems[res.id] = {
        id: res.id,
        rev: res.newRev,
        org: config.org,
        project: config.project
      };
      mentionedItemsUpdated = true;
    }

    // Clean up server followed items
    for (const id in followedItems) {
      const stored = followedItems[id];
      if (stored.followedOnServer && stored.org === config.org && stored.project === config.project) {
        if (!serverFollowedIds.includes(Number(id))) {
          delete followedItems[id];
          followedItemsUpdated = true;
        }
      }
    }

    if (followedItemsUpdated) {
      await chrome.storage.local.set({ followedItems });
    }
    if (mentionedItemsUpdated) {
      await chrome.storage.local.set({ mentionedItems });
    }

  } catch (err) {
    console.error("Error running notification checks:", err);
  }
}

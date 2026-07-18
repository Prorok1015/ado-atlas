// ADO REST client (split from core/api.js). Constants, AdoLib import, FIELD_REGISTRY, isCoreField, config storage, resolveField.
// Bare shared scope: loaded in order (core→…→facade) as classic <script> (index.html)
// AND via background.js importScripts. The api.* facade is assembled last in facade.js.
// ADO REST client + endpoint logic (port of ado_client.py + ado_web.py).
// Runs in the extension page context — talks to dev.azure.com directly.
// PAT is read from chrome.storage.local on every call (cheap, lets settings
// changes take effect without a reload).

const API_VERSION = "api-version=7.1";
const LIST_CAP = 2000;   // max work items a single list() query returns (guards unfiltered queries)
const MAX_RETRIES = 3;   // retries for throttling (429) / transient 5xx

// Pure, dependency-free helpers live in lib.js (loaded before api.js).
const AdoLib = (typeof globalThis !== "undefined" ? globalThis : window).AdoLib;
const { wiqlQuote, htmlEsc, htmlUnesc, htmlToText, htmlToMarkdown } = AdoLib;

const FIELD_REGISTRY = {
  id:          { ref: "System.Id", type: "integer", name: "ID" },
  type:        { ref: "System.WorkItemType", type: "string", name: "Type" },
  title:       { ref: "System.Title", type: "string", name: "Title" },
  state:       { ref: "System.State", type: "string", name: "State" },
  assigned:    { ref: "System.AssignedTo", type: "identity", name: "Assigned", aliases: ["assignedto"] },
  parent:      { ref: "System.Parent", type: "integer", name: "Parent ID" },
  priority:    { ref: "Microsoft.VSTS.Common.Priority", type: "integer", name: "Priority" },
  iteration:   { ref: "System.IterationPath", type: "treePath", name: "Sprint", aliases: ["iteration"] },
  area:        { ref: "System.AreaPath", type: "treePath", name: "Area Path", aliases: ["area"] },
  start:       { ref: "Microsoft.VSTS.Scheduling.StartDate", type: "dateTime", name: "Start Date" },
  target:      { ref: "Microsoft.VSTS.Scheduling.TargetDate", type: "dateTime", name: "Target Date" },
  finish:      { ref: "Microsoft.VSTS.Scheduling.FinishDate", type: "dateTime", name: "Finish Date" },
  due:         { ref: "Microsoft.VSTS.Scheduling.DueDate", type: "dateTime", name: "Due Date" },
  createddate: { ref: "System.CreatedDate", type: "dateTime", name: "Created Date", aliases: ["created_date", "created"] },
  changeddate: { ref: "System.ChangedDate", type: "dateTime", name: "Changed Date", aliases: ["changed_date", "changed"] },
  estimate:    { ref: "Microsoft.VSTS.Scheduling.OriginalEstimate", type: "double", name: "Original Estimate" },
  tags:        { ref: "System.Tags", type: "tags", name: "Tags" },
  desc:        { ref: "System.Description", type: "html", name: "Description", fallbackRefs: ["Microsoft.VSTS.TCM.ReproSteps"], aliases: ["description"] },
  ac:          { ref: "Microsoft.VSTS.Common.AcceptanceCriteria", type: "html", name: "Acceptance Criteria" },
  storypoints: { ref: "Microsoft.VSTS.Scheduling.StoryPoints", type: "double", name: "Story Points" },
  remaining:   { ref: "Microsoft.VSTS.Scheduling.RemainingWork", type: "double", name: "Remaining Work" },
  completed:   { ref: "Microsoft.VSTS.Scheduling.CompletedWork", type: "double", name: "Completed Work" },
  activity:    { ref: "Microsoft.VSTS.Common.Activity", type: "string", name: "Activity" },
  risk:        { ref: "Microsoft.VSTS.Common.Risk", type: "string", name: "Risk" },
  valuearea:   { ref: "Microsoft.VSTS.Common.ValueArea", type: "string", name: "Value Area" },
  createdby:   { ref: "System.CreatedBy", type: "identity", name: "Created By", aliases: ["created_by"] }
};

const CORE_FIELD_REFS = new Set();
for (const val of Object.values(FIELD_REGISTRY)) {
  if (val.ref) CORE_FIELD_REFS.add(val.ref.toLowerCase());
  if (val.fallbackRefs) {
    for (const fb of val.fallbackRefs) {
      CORE_FIELD_REFS.add(fb.toLowerCase());
    }
  }
}

function isCoreField(refName) {
  if (!refName) return false;
  const lower = refName.toLowerCase(); if (lower === "system.history") return true; return CORE_FIELD_REFS.has(lower);
}

const FIELD_ALIASES = {};
for (const [key, val] of Object.entries(FIELD_REGISTRY)) {
  FIELD_ALIASES[key] = val.ref;
  if (val.aliases) {
    for (const alias of val.aliases) {
      FIELD_ALIASES[alias] = val.ref;
    }
  }
}

const DEFAULT_FIELDS = [
  FIELD_REGISTRY.id.ref,
  FIELD_REGISTRY.type.ref,
  FIELD_REGISTRY.title.ref,
  FIELD_REGISTRY.state.ref,
  FIELD_REGISTRY.assigned.ref,
  FIELD_REGISTRY.parent.ref,
  FIELD_REGISTRY.priority.ref,
  FIELD_REGISTRY.iteration.ref,
  FIELD_REGISTRY.start.ref,
  FIELD_REGISTRY.target.ref,
  FIELD_REGISTRY.finish.ref,
  FIELD_REGISTRY.due.ref,
  FIELD_REGISTRY.estimate.ref,
  FIELD_REGISTRY.tags.ref,
  FIELD_REGISTRY.createddate.ref,
  FIELD_REGISTRY.createdby.ref,
  "System.Rev",
];

const AC_TYPES = new Set(["User Story", "Feature", "Epic", "Issue", "Product Backlog Item"]);

// Same filter registry the chip UI uses. Mirrors FILTER_FIELDS in the old
// Flask backend — change one place when you add a column.
const FILTER_FIELDS = {
  type:      { ref: FIELD_REGISTRY.type.ref },
  state:     { ref: FIELD_REGISTRY.state.ref },
  priority:  { ref: FIELD_REGISTRY.priority.ref, num: true },
  assigned:  { ref: FIELD_REGISTRY.assigned.ref, identity: true },
  iteration: { ref: FIELD_REGISTRY.iteration.ref },
  tags:      { ref: FIELD_REGISTRY.tags.ref, contains: true },   // semicolon-list field → CONTAINS, not IN
};

// ---------- storage (PAT + org/project) ----------
// Org and project are required and entered by the user in the setup modal —
// there are no built-in defaults, so the extension is not tied to any one
// Azure DevOps organization or project.
// patExpiry is an optional "YYYY-MM-DD" the user copies from the PAT creation
// page. ADO can't report a PAT's expiry to a PAT-authenticated request (the
// Token Lifecycle API needs an Entra token), so we store the date and count
// down from it locally.
// authMode is "pat" (Basic auth with a PAT) or "oauth" (Bearer token from a
// Microsoft Entra ID sign-in). The oauth* keys hold the configured app and the
// current token set.
const STORE_KEYS = ["pat", "org", "project", "patExpiry",
  "authMode", "oauthClientId", "oauthTenant", "oauthAccess", "oauthRefresh", "oauthExpiresAt"];

// Azure DevOps Entra resource id; ".default" requests the app's configured
// delegated permission (Azure DevOps user_impersonation); offline_access yields
// a refresh token for silent renewal.
const OAUTH_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";
const OAUTH_SCOPE = OAUTH_RESOURCE + "/.default offline_access";

async function getConfig() {
  const r = await chrome.storage.local.get(STORE_KEYS);
  return {
    pat: r.pat || "",
    org: r.org || "",
    project: r.project || "",
    patExpiry: r.patExpiry || "",
    authMode: r.authMode || "pat",
    oauthClientId: r.oauthClientId || "",
    oauthTenant: r.oauthTenant || "",
    oauthAccess: r.oauthAccess || "",
    oauthRefresh: r.oauthRefresh || "",
    oauthExpiresAt: r.oauthExpiresAt || 0,
  };
}
async function setConfig(patch) {
  teamRosterCache = null;
  globalFieldsCache = null;
  populatePromise = null;
  await chrome.storage.local.set(patch);
}
async function clearConfig() {
  teamRosterCache = null;
  globalFieldsCache = null;
  populatePromise = null;
  await chrome.storage.local.remove(STORE_KEYS);
  try { const all = await chrome.storage.local.get(null); const snaps = Object.keys(all).filter(k => k.startsWith("snap:")); if (snaps.length) await chrome.storage.local.remove(snaps); } catch (_) {}
}

// ---------- HTTP ----------
function resolveField(k, wtype) {
  if (k.toLowerCase() === "target") {
    if (wtype === "Product Backlog Item") return FIELD_REGISTRY.finish.ref;
    return FIELD_REGISTRY.target.ref;
  }
  if (k.toLowerCase() === "desc" || k.toLowerCase() === "description") {
    // If wtype is provided, resolve dynamically; otherwise fallback
    if (wtype) {
      // NOTE: We cannot easily run async getDescriptionFieldForType inside resolveField if resolveField is sync.
      // So we will resolve Description fields asynchronously/explicitly in the functions that call it,
      // or we can look up from a synchronous cache if we already loaded it, or default.
      // Let's check a synchronous cache that we populate, or let getDescriptionFieldForType handle it.
      // To keep resolveField synchronous, we will check a global memory map populated by our async calls.
      const cacheKey = typeof getConfig === "function" ? `${wtype}` : "";
      // Let's use a simpler approach: we can resolve it directly in the callers (item/updateItem) and not rely purely on resolveField(desc).
    }
  }
  return FIELD_ALIASES[k.toLowerCase()] || k;
}


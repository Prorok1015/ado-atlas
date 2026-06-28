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
  valuearea:   { ref: "Microsoft.VSTS.Common.ValueArea", type: "string", name: "Value Area" }
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
  return CORE_FIELD_REFS.has(refName.toLowerCase());
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
  "System.Rev",
];

let detectedTargetField = null;

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
    return detectedTargetField || FIELD_REGISTRY.target.ref;
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

// ---------- OAuth (Microsoft Entra ID, auth-code + PKCE) ----------
function oauthRedirectUri() { return chrome.identity.getRedirectURL(); }   // https://<extid>.chromiumapp.org/
function randB64Url(n) { const a = new Uint8Array(n); crypto.getRandomValues(a); return AdoLib.base64UrlEncode(a); }
async function pkceChallenge(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return AdoLib.base64UrlEncode(new Uint8Array(digest));
}

// Raw POST to the Microsoft token endpoint (NOT through req() — no PAT/Bearer and
// no ado-401 handling). Returns the parsed token response or throws.
async function oauthTokenRequest(tenant, body) {
  const url = `https://login.microsoftonline.com/${encodeURIComponent(tenant || "organizations")}/oauth2/v2.0/token`;
  const resp = await fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  const text = await resp.text();
  let data = {}; try { data = JSON.parse(text); } catch (_) { /* keep */ }
  if (!resp.ok) throw new Error("OAuth: " + (data.error_description || data.error || text.slice(0, 300)));
  return data;
}
async function storeTokens(tok) {
  const patch = { oauthAccess: tok.access_token || "", oauthExpiresAt: Date.now() + ((tok.expires_in || 3600) * 1000) };
  if (tok.refresh_token) patch.oauthRefresh = tok.refresh_token;   // refresh token rotates — keep the newest
  await setConfig(patch);
}

// Interactive sign-in: opens the Microsoft login, exchanges the code for tokens,
// persists authMode=oauth + the app config. Returns the signed-in display name.
async function oauthSignIn(clientId, tenant) {
  clientId = (clientId || "").trim();
  tenant = (tenant || "").trim() || "organizations";
  if (!clientId) throw new Error("Application (client) ID is required");
  const redirectUri = oauthRedirectUri();
  const verifier = randB64Url(32);
  const challenge = await pkceChallenge(verifier);
  const state = randB64Url(16);
  const url = AdoLib.oauthAuthorizeUrl({ tenant, clientId, redirectUri, scope: OAUTH_SCOPE, challenge, state });
  const redirect = await new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url, interactive: true }, r => {
      const err = chrome.runtime.lastError;
      if (err || !r) return reject(new Error(err && err.message ? err.message : "Sign-in was cancelled"));
      resolve(r);
    });
  });
  const p = AdoLib.parseRedirectParams(redirect);
  if (p.error) throw new Error("Sign-in: " + (p.error_description || p.error));
  if (!p.code || p.state !== state) throw new Error("Sign-in failed (state mismatch)");
  const tok = await oauthTokenRequest(tenant, AdoLib.oauthTokenBody({
    client_id: clientId, grant_type: "authorization_code", code: p.code,
    redirect_uri: redirectUri, code_verifier: verifier, scope: OAUTH_SCOPE,
  }));
  await setConfig({ authMode: "oauth", oauthClientId: clientId, oauthTenant: tenant });
  await storeTokens(tok);
  return await me();
}

// Silent refresh using the stored refresh token (no UI).
async function oauthRefresh() {
  const { oauthClientId, oauthTenant, oauthRefresh } = await getConfig();
  if (!oauthRefresh) throw new Error("Session expired — sign in again");
  const tok = await oauthTokenRequest(oauthTenant, AdoLib.oauthTokenBody({
    client_id: oauthClientId, grant_type: "refresh_token", refresh_token: oauthRefresh, scope: OAUTH_SCOPE,
  }));
  await storeTokens(tok);
}

// A valid access token, refreshed if it's missing or within 2 min of expiry.
async function getAccessToken() {
  let cfg = await getConfig();
  if (!cfg.oauthAccess && !cfg.oauthRefresh) throw new Error("Not signed in");
  if (!cfg.oauthAccess || !cfg.oauthExpiresAt || Date.now() > cfg.oauthExpiresAt - 120000) {
    await oauthRefresh();
    cfg = await getConfig();
  }
  return cfg.oauthAccess;
}

async function signOut() {
  await setConfig({ authMode: "pat", oauthAccess: "", oauthRefresh: "", oauthExpiresAt: 0 });
}

async function authHeader() {
  const cfg = await getConfig();
  if (cfg.authMode === "oauth") return "Bearer " + (await getAccessToken());
  if (!cfg.pat) throw new Error("No PAT configured");
  return "Basic " + btoa(":" + cfg.pat);
}

async function projUrl() {
  const { org, project } = await getConfig();
  return `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}`;
}

async function orgUrl() {
  const { org } = await getConfig();
  return `https://dev.azure.com/${encodeURIComponent(org)}`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function errorFrom(resp) {
  let detail = await resp.text();
  try { detail = JSON.parse(detail).message || detail; } catch (_) { /* keep raw */ }
  return new Error(`HTTP ${resp.status}: ${String(detail).slice(0, 500)}`);
}
function retryDelay(resp, attempt) {
  const ra = resp.headers && resp.headers.get && resp.headers.get("Retry-After");
  if (ra) { const s = parseFloat(ra); if (Number.isFinite(s)) return Math.min(s * 1000, 30000); }
  return Math.min(500 * Math.pow(2, attempt), 8000) + Math.floor(Math.random() * 250);   // exp backoff + jitter
}

// Binary bodies (ArrayBuffer / Blob / typed arrays) bypass the JSON encoder so
// req() can also POST raw bytes (attachment uploads).
function isBinaryBody(b) {
  return b instanceof ArrayBuffer || b instanceof Blob || (typeof b === "object" && b && ArrayBuffer.isView(b));
}
async function req(method, url, body, ctype, options) {
  const headers = { Authorization: await authHeader() };
  // Make ADO return a plain 401 instead of redirecting to its sign-in page —
  // the redirect is what makes the browser pop its native login dialog.
  headers["X-TFS-FedAuthRedirect"] = "Suppress";
  const binary = isBinaryBody(body);
  if (body !== undefined) headers["Content-Type"] = ctype || (binary ? "application/octet-stream" : "application/json");
  const payload = body === undefined ? undefined : (binary ? body : JSON.stringify(body));
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let resp;
    try {
      resp = await fetch(url, { method, headers, body: payload, signal: options && options.signal });
    } catch (err) {
      if (err.name === 'AbortError') throw err; // Don't retry user aborts
      if (attempt < MAX_RETRIES) {
        await sleep(Math.min(500 * Math.pow(2, attempt), 8000) + Math.floor(Math.random() * 250));
        continue;
      }
      throw err;
    }

    if (resp.ok) {
      const text = await resp.text();
      if (!text) return {};
      // ADO sometimes prefixes responses with a UTF-8 BOM; strip it before JSON.parse.
      return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    }
    // 401 mid-session = PAT expired/revoked: let the UI react, don't retry.
    if (resp.status === 401) {
      if (!(options && options.suppress401Event)) {
        if (typeof window !== "undefined") { try { window.dispatchEvent(new CustomEvent("ado-401")); } catch (_) { /* no window */ } }
      }
      throw await errorFrom(resp);
    }
    // Retry throttling (429) and transient server errors (5xx) with backoff.
    const retryable = resp.status === 429 || (resp.status >= 500 && resp.status < 600);
    if (retryable && attempt < MAX_RETRIES) { await sleep(retryDelay(resp, attempt)); continue; }
    throw await errorFrom(resp);
  }
}

function personName(v) {
  if (v && typeof v === "object") return v.displayName || v.uniqueName || "?";
  return v || "";
}

// Project-side work item entity adapter.
// NOTE: descField is optional and used for overriding the default description field.
// For batch queries (e.g. inside list() and batchFetch()), descField is not passed,
// meaning standard System.Description is always used, and type-specific description overrides 
// (like Microsoft.VSTS.TCM.ReproSteps) are not supported. This is an intentional design choice
// to match the original system behavior and avoid per-item database overhead.
function mapWorkItem(rawItem, descField) {
  if (!rawItem) return null;
  const f = rawItem.fields || {};
  
  if (FIELD_REGISTRY.finish.ref in f) {
    detectedTargetField = FIELD_REGISTRY.finish.ref;
  } else if (FIELD_REGISTRY.target.ref in f) {
    detectedTargetField = FIELD_REGISTRY.target.ref;
  }

  const mapped = {
    id: rawItem.id,
    rev: rawItem.rev ?? (f["System.Rev"] ?? ""),
  };

  // Map fields dynamically based on FIELD_REGISTRY
  for (const [key, val] of Object.entries(FIELD_REGISTRY)) {
    if (!val || !val.ref) continue;
    const refName = val.ref;
    
    // Default fallback value check
    let v = f[refName];
    if (key === 'desc' && descField && f[descField] !== undefined) {
      v = f[descField];
    } else if (v === undefined && val.fallbackRefs) {
      for (const fallback of val.fallbackRefs) {
        if (f[fallback] !== undefined) {
          v = f[fallback];
          break;
        }
      }
    }
    
    // Type specific processing
    if (key === 'assigned') {
      mapped[key] = personName(v);
    } else if (key === 'estimate') {
      mapped.est = v;
      mapped.estimate = v;
    } else if (key === 'target') {
      mapped.target = v || f[FIELD_REGISTRY.finish.ref] || f[FIELD_REGISTRY.target.ref] || f[FIELD_REGISTRY.due.ref] || "";
    } else if (key === 'desc' || key === 'ac' || val.type === 'html' || val.type === 'plaintext') {
      mapped[key] = htmlToMarkdown(v || "");
    } else {
      mapped[key] = v !== undefined ? v : (val.type === 'string' || val.type === 'html' || val.type === 'tags' ? "" : null);
    }
  }

  // Relations and extra properties
  const wtype = mapped.type;
  mapped.has_ac = AC_TYPES.has(wtype) || FIELD_REGISTRY.ac.ref in f;
  
  if (rawItem.relations) {
    mapped.relations = rawItem.relations;
    mapped.deps = depsFromRelations(rawItem.relations);
    mapped.attachments = attachmentsFromRelations(rawItem.relations);
  }
  mapped.fields = f;

  return mapped;
}

// ---------- WIQL filter builder ----------
// Pure logic lives in lib.js; bind it to this module's FIELD_REGISTRY.
function buildClauses(filters) {
  const res = AdoLib.buildClauses(FIELD_REGISTRY, filters);
  return res;
}

// ---------- core ADO reads ----------
async function wiqlIds(wiql, top, signal) {
  const proj = await projUrl();
  const url = `${proj}/_apis/wit/wiql?${API_VERSION}` + (top ? `&$top=${top|0}` : "");
  const res = await req("POST", url, { query: wiql }, null, { signal });
  return (res.workItems || []).map(w => w.id);
}

function chunk200(ids) { const out = []; for (let i = 0; i < ids.length; i += 200) out.push(ids.slice(i, i + 200)); return out; }

async function batchFetch(ids, fields, signal) {
  if (!ids.length) return [];
  fields = fields || DEFAULT_FIELDS;
  const proj = await projUrl();
  // Fetch the 200-id chunks concurrently (3-wide to avoid HTTP/2 protocol errors).
  const results = await pool(chunk200(ids).map(chunk => async () => {
    const url = `${proj}/_apis/wit/workitemsbatch?${API_VERSION}`;
    const payload = { ids: chunk, fields: fields, errorPolicy: "omit" };
    return (await req("POST", url, payload, undefined, { signal })).value || [];
  }), 3);
  const byId = {};
  for (const arr of results) for (const w of arr) byId[w.id] = w;
  // preserve caller's id order (which carries the WIQL ORDER BY)
  return ids.map(i => byId[i]).filter(Boolean);
}

// Generic list (mirrors AdoClient.list). Returns an array of nodeOf() shapes.
async function list({ wtype, parent, text, order, filters, signal } = {}) {
  const where = ["[System.TeamProject] = @project"];
  for (const c of buildClauses(filters || {})) where.push(c);
  if (filters && filters.followed && filters.followed.in && filters.followed.in.includes('yes')) {
    const { org, project } = await getConfig();
    const { followedItems } = await chrome.storage.local.get("followedItems");
    const activeIds = Object.values(followedItems || {})
      .filter(item => item.org === org && item.project === project)
      .map(item => item.id);
    if (activeIds.length > 0) {
      where.push(`[System.Id] IN (${activeIds.join(",")})`);
    } else {
      where.push(`[System.Id] = 0`);
    }
  }
  if (wtype) where.push(`[${FIELD_REGISTRY.type.ref}] = '${wiqlQuote(wtype)}'`);
  if (parent != null) where.push(`[${FIELD_REGISTRY.parent.ref}] = ${parent|0}`);
  if (text) where.push(`[${FIELD_REGISTRY.title.ref}] CONTAINS '${wiqlQuote(text)}'`);
  const orderBy = order === "priority"
    ? `[${FIELD_REGISTRY.priority.ref}], [${FIELD_REGISTRY.id.ref}]`
    : `[${FIELD_REGISTRY.id.ref}]`;
  const wiql = `SELECT [${FIELD_REGISTRY.id.ref}] FROM WorkItems WHERE ` + where.join(" AND ") + " ORDER BY " + orderBy;
  const ids = await wiqlIds(wiql, LIST_CAP, signal);
  const items = await batchFetch(ids, null, signal);
  const out = items.map(x => mapWorkItem(x)); // NOTE: descField is not passed here, falling back to System.Description
  // Flag (don't hide) when the LIST_CAP guard kicked in so the UI can warn the
  // user that they're not seeing everything.
  out.truncated = ids.length >= LIST_CAP;
  out.cap = LIST_CAP;
  return out;
}

// ---------- single-purpose endpoints ----------
async function me() {
  try {
    const o = await orgUrl();
    const res = await req("GET", `${o}/_apis/connectionData?api-version=7.1-preview`);
    const u = res.authenticatedUser || {};
    return u.customDisplayName || u.displayName || u.providerDisplayName || "";
  } catch (_) {
    return "";
  }
}

async function iterations() {
  const proj = await projUrl();
  let root;
  try {
    root = await req("GET", `${proj}/_apis/wit/classificationnodes/iterations?$depth=12&${API_VERSION}`);
  } catch (_) { return []; }
  const out = [];
  function walk(node, prefix) {
    const name = node.name || "";
    const path = prefix ? prefix + "\\" + name : name;
    const a = node.attributes || {};
    if (prefix) {
      out.push({ path, name, start: a.startDate || null, finish: a.finishDate || null });
    }
    for (const ch of (node.children || [])) walk(ch, path);
  }
  walk(root, "");
  out.sort((x, y) => (x.finish || x.start || "").localeCompare(y.finish || y.start || ""));
  return out;
}

async function areas() {
  const proj = await projUrl();
  let root;
  try {
    root = await req("GET", `${proj}/_apis/wit/classificationnodes/areas?$depth=12&${API_VERSION}`);
  } catch (_) { return []; }
  const out = [];
  function walk(node, prefix) {
    const name = node.name || "";
    const path = prefix ? prefix + "\\" + name : name;
    out.push({ path, name });
    for (const ch of (node.children || [])) walk(ch, path);
  }
  walk(root, "");
  out.sort((x, y) => x.path.localeCompare(y.path));
  return out;
}

async function states(wtype) {
  const proj = await projUrl();
  try {
    const r = await req("GET", `${proj}/_apis/wit/workitemtypes/${encodeURIComponent(wtype)}/states?${API_VERSION}`);
    return (r.value || []).map(s => s.name);
  } catch (_) {
    return ["New", "Active", "Resolved", "Closed", "Removed"];
  }
}

// The project's default team name (for assigning a freshly-created iteration so
// it shows up in ADO's native sprint planning too). Null if it can't be read.
async function defaultTeamName() {
  const o = await orgUrl();
  const { project } = await getConfig();
  try {
    const p = await req("GET", `${o}/_apis/projects/${encodeURIComponent(project)}?${API_VERSION}`);
    return (p.defaultTeam && (p.defaultTeam.name || p.defaultTeam.id)) || null;
  } catch (_) { return null; }
}

// Create a sprint = a dated iteration classification node under the project root
// (which is exactly what iterations() reads, so it appears on the board). Then,
// best-effort, add it to the default team's iterations so native ADO planning
// sees it too. A 403 here means the caller lacks "Create child nodes" rights.
async function createSprint({ name, start, finish }) {
  if (!name) throw new Error("sprint name required");
  const proj = await projUrl();
  const toIso = d => (d && d.length === 10) ? d + "T00:00:00Z" : (d || null);
  const attributes = {};
  if (start) attributes.startDate = toIso(start);
  if (finish) attributes.finishDate = toIso(finish);
  const node = await req("POST", `${proj}/_apis/wit/classificationnodes/iterations?${API_VERSION}`,
    { name, attributes }, "application/json");
  try {
    const team = await defaultTeamName(), ident = node && node.identifier;
    if (team && ident) {
      const o = await orgUrl();
      const { project } = await getConfig();
      await req("POST",
        `${o}/${encodeURIComponent(project)}/${encodeURIComponent(team)}/_apis/work/teamsettings/iterations?${API_VERSION}`,
        { id: ident }, "application/json");
    }
  } catch (_) { /* team assignment is optional — the node already exists */ }
  return node;
}

// Update an existing sprint's start/finish dates. `path` is the iteration path
// as iterations() reports it ("<project>\<...>\<sprint>"); the node API wants
// everything after the root (project) segment, slash-separated. A 403 means the
// caller lacks "Edit this node" rights on the iteration.
async function updateSprintDates(path, { start, finish }) {
  const proj = await projUrl();
  const toIso = d => (d && d.length === 10) ? d + "T00:00:00Z" : (d || null);
  const rel = String(path).split("\\").slice(1).map(encodeURIComponent).join("/");
  if (!rel) throw new Error("can't edit the project root iteration");
  const attributes = { startDate: start ? toIso(start) : null, finishDate: finish ? toIso(finish) : null };
  return await req("PATCH", `${proj}/_apis/wit/classificationnodes/iterations/${rel}?${API_VERSION}`,
    { attributes }, "application/json");
}

// The work-item types actually defined in this project's process, with their
// process colour — the single source of truth for the create dropdowns and the
// type-colour map (so nothing about types is hard-coded). Disabled types, and
// the "hidden" category (Code Review Request, Feedback Request/Response, Shared
// Steps, … — the ones ADO itself keeps out of the New Work Item menu) are
// dropped. The result keeps ADO's own ordering.
async function workItemTypes() {
  const proj = await projUrl();
  let hidden = new Set();
  try {
    const h = await req("GET", `${proj}/_apis/wit/workitemtypecategories/Microsoft.HiddenCategory?${API_VERSION}`);
    for (const t of (h.workItemTypes || [])) if (t && t.name) hidden.add(t.name);
  } catch (_) { /* no hidden category exposed — keep them all */ }
  const r = await req("GET", `${proj}/_apis/wit/workitemtypes?${API_VERSION}`);
  return (r.value || [])
    .filter(t => t && t.name && !t.isDisabled && !hidden.has(t.name))
    .map(t => {
      const c = String(t.color || "").replace(/^#/, "");
      return { name: t.name, color: /^[0-9a-fA-F]{6}$/.test(c) ? ("#" + c) : "" };
    });
}

// Caches fields of a specific work item type for a project.
let witFieldsCache = {};
let globalFieldsCache = null;

async function getFieldsMap() {
  if (globalFieldsCache) return globalFieldsCache;
  const { org, project } = await getConfig();
  if (!org || !project) return {};
  const cacheKey = `global_fields_map_v4:${org}:${project}`;
  
  try {
    const cached = await chrome.storage.local.get(cacheKey);
    if (cached && cached[cacheKey]) {
      globalFieldsCache = cached[cacheKey];
      return globalFieldsCache;
    }
  } catch (_) {}

  const proj = await projUrl();
  try {
    const r = await req("GET", `${proj}/_apis/wit/fields?${API_VERSION}`);
    const fieldsMap = {};
    (r.value || []).forEach(f => {
      fieldsMap[f.referenceName] = {
        type: f.type,
        readOnly: !!f.readOnly,
        isIdentity: !!f.isIdentity,
        name: f.name
      };
    });
    globalFieldsCache = fieldsMap;
    try {
      await chrome.storage.local.set({ [cacheKey]: fieldsMap });
    } catch (_) {}
    return fieldsMap;
  } catch (err) {
    console.error("Failed to load global fields map", err);
    return {};
  }
}

let populatePromise = null;

async function populateFieldRegistry() {
  if (populatePromise) return populatePromise;
  populatePromise = (async () => {
    try {
      const fieldsMap = await getFieldsMap();
      if (!fieldsMap || Object.keys(fieldsMap).length === 0) {
        throw new Error("Fields map is empty or failed to load");
      }
      
      // 1. Fetch active work item types and extract allowed values
      let types = [];
      try {
        types = await workItemTypes();
      } catch (e) {
        console.warn("Failed to load work item types for allowedValues extraction:", e);
      }

      const allowedValuesMap = {}; // referenceName (lowercased) -> Set of allowed values
      const FALLBACK_ALLOWED_VALUES = {
        'microsoft.vsts.common.priority': ['1', '2', '3', '4'],
        'microsoft.vsts.common.severity': ['1 - Critical', '2 - High', '3 - Medium', '4 - Low'],
        'microsoft.vsts.common.risk': ['1 - High', '2 - Medium', '3 - Low'],
        'microsoft.vsts.common.valuearea': ['Business', 'Architectural'],
        'microsoft.vsts.common.activity': ['Development', 'Testing', 'Requirements', 'Design', 'Documentation', 'Deployment'],
        'microsoft.vsts.common.resolvedreason': ['As Designed', 'Cannot Reproduce', 'Duplicate', 'Fixed', 'Obsolete'],
        'microsoft.vsts.common.discipline': ['Analysis', 'Development', 'Test', 'User Experience', 'User Education'],
        'microsoft.vsts.common.triage': ['Pending', 'More Info', 'Info Received', 'Triaged']
      };
      if (types && types.length) {
        try {
          const allTypesFields = await Promise.all(
            types.map(t => getWorkItemTypeFields(t.name).catch(() => []))
          );
          for (const fieldsList of allTypesFields) {
            for (const f of (fieldsList || [])) {
              if (f.allowedValues && f.allowedValues.length) {
                const refLower = f.referenceName.toLowerCase();
                if (!allowedValuesMap[refLower]) {
                  allowedValuesMap[refLower] = new Set();
                }
                for (const val of f.allowedValues) {
                  if (val != null && val !== "") {
                    allowedValuesMap[refLower].add(val);
                  }
                }
              }
            }
          }
        } catch (e) {
          console.warn("Failed to merge work item type allowedValues:", e);
        }
      }

      // Force populate work item types
      if (types && types.length) {
        if (!allowedValuesMap['system.workitemtype']) allowedValuesMap['system.workitemtype'] = new Set();
        types.forEach(t => allowedValuesMap['system.workitemtype'].add(t.name));
        
        // Force collect all states from all work item types
        if (!allowedValuesMap['system.state']) allowedValuesMap['system.state'] = new Set();
        try {
          const allStatesArrays = [];
          for (let i = 0; i < types.length; i += 4) {
            const chunk = types.slice(i, i + 4);
            const chunkPromises = chunk.map(t => states(t.name).catch(() => []));
            const chunkResults = await Promise.all(chunkPromises);
            allStatesArrays.push(...chunkResults);
          }
          allStatesArrays.flat().forEach(s => {
            const val = (s && typeof s === 'object') ? s.name : s;
            if (val) allowedValuesMap['system.state'].add(val);
          });
        } catch (e) {
          console.warn("Failed to fetch states for registry:", e);
        }
      }

      // Populate boolean fields with default values
      for (const [refName, fieldInfo] of Object.entries(fieldsMap)) {
        if (fieldInfo && fieldInfo.type && fieldInfo.type.toLowerCase() === 'boolean') {
          const refLower = refName.toLowerCase();
          if (!allowedValuesMap[refLower]) {
            allowedValuesMap[refLower] = new Set();
          }
          allowedValuesMap[refLower].add('True');
          allowedValuesMap[refLower].add('False');
        }
      }

      // Apply fallbacks for fields if ADO returned empty values
      for (const [refName, vals] of Object.entries(FALLBACK_ALLOWED_VALUES)) {
        const refLower = refName.toLowerCase();
        const hasField = fieldsMap[refName] || Object.keys(fieldsMap).some(k => k.toLowerCase() === refLower);
        if (hasField) {
          if (!allowedValuesMap[refLower] || allowedValuesMap[refLower].size === 0) {
            allowedValuesMap[refLower] = new Set(vals);
          }
        }
      }

      // 2. Create reverse lookup map for already registered fields
      const refToKey = {};
      for (const [key, val] of Object.entries(FIELD_REGISTRY)) {
        if (val && val.ref) {
          refToKey[val.ref.toLowerCase()] = key;
        }
      }

      // Helper to map ADO types to registry types
      const mapAdoTypeToRegistryType = (adoType) => {
        if (!adoType) return 'string';
        const t = adoType.toLowerCase();
        if (t === 'integer') return 'integer';
        if (t === 'double') return 'double';
        if (t === 'datetime') return 'dateTime';
        if (t === 'boolean') return 'boolean';
        if (t === 'html' || t === 'plaintext') return 'html';
        if (t === 'identity') return 'identity';
        if (t === 'tags') return 'tags';
        return 'string';
      };

      // 3. Add fields to FIELD_REGISTRY
      for (const [refName, fieldInfo] of Object.entries(fieldsMap)) {
        const refLower = refName.toLowerCase();
        
        // Update allowed values if present
        const allowedSet = allowedValuesMap[refLower];
        const allowedArr = allowedSet && allowedSet.size ? Array.from(allowedSet) : null;

        if (refToKey[refLower]) {
          // Already registered, just update name & allowedValues if present
          const key = refToKey[refLower];
          if (fieldInfo.name && !FIELD_REGISTRY[key].name) {
            FIELD_REGISTRY[key].name = fieldInfo.name;
          }
          if (allowedArr) {
            FIELD_REGISTRY[key].allowedValues = allowedArr;
          }
          continue;
        }

        // Generate abstract key
        const parts = refName.split('.');
        let base = parts[parts.length - 1];
        base = base.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (!base) continue;

        let key = base;
        if (FIELD_REGISTRY[key] && FIELD_REGISTRY[key].ref !== refName) {
          // Collision! Use namespace prefix
          const namespace = parts.slice(0, -1).join('_').toLowerCase().replace(/[^a-z0-9]/g, '');
          if (namespace) {
            key = `${namespace}_${key}`;
          }
          // If still collides, append a number
          let suffix = 2;
          let candidate = key;
          while (FIELD_REGISTRY[candidate] && FIELD_REGISTRY[candidate].ref !== refName) {
            candidate = `${key}_${suffix}`;
            suffix++;
          }
          key = candidate;
        }

        // Register in FIELD_REGISTRY
        FIELD_REGISTRY[key] = {
          ref: refName,
          type: mapAdoTypeToRegistryType(fieldInfo.type),
          name: fieldInfo.name || parts[parts.length - 1]
        };
        if (allowedArr) {
          FIELD_REGISTRY[key].allowedValues = allowedArr;
        }
        
        // Add to FIELD_ALIASES
        FIELD_ALIASES[key] = refName;
      }
    } catch (err) {
      populatePromise = null;
      throw err;
    }
  })();
  return populatePromise;
}

async function getWorkItemTypeFields(wtype) {
  const { org, project } = await getConfig();
  if (!org || !project || !wtype) return [];
  const cacheKey = `wit_fields_v7:${org}:${project}:${wtype}`;
  
  // Try memory cache first
  if (witFieldsCache[cacheKey]) return witFieldsCache[cacheKey];
  
  // Try local storage cache
  try {
    const cached = await chrome.storage.local.get(cacheKey);
    if (cached && cached[cacheKey]) {
      witFieldsCache[cacheKey] = cached[cacheKey];
      return cached[cacheKey];
    }
  } catch (_) {}

  const proj = await projUrl();
  const t = encodeURIComponent(wtype);
  try {
    const fieldsMap = await getFieldsMap();
    // Fetch work item type metadata containing xmlForm layout
    const typeMeta = await req("GET", `${proj}/_apis/wit/workitemtypes/${t}?${API_VERSION}`);
    
    // Parse xmlForm definition to extract fields placed on the form and their group labels
    const parser = new DOMParser();
    const doc = parser.parseFromString(typeMeta.xmlForm || "", "text/xml");
    const controls = doc.getElementsByTagName("Control");
    const formFieldGroups = new Map(); // referenceName → group label
    for (const control of controls) {
      const fn = control.getAttribute("FieldName");
      if (fn) {
        let groupLabel = null;
        let el = control.parentElement;
        while (el) {
          if (el.tagName === "Group") {
            groupLabel = el.getAttribute("Label") || null;
            break;
          }
          el = el.parentElement;
        }
        formFieldGroups.set(fn, groupLabel);
      }
    }

    const r = await req("GET", `${proj}/_apis/wit/workitemtypes/${t}/fields?${API_VERSION}`);
    const fields = (r.value || []).map(f => {
      const globalInfo = fieldsMap[f.referenceName] || {};
      return {
        name: f.name,
        referenceName: f.referenceName,
        type: globalInfo.type || (f.field ? f.field.type : f.type) || 'string',
        readOnly: globalInfo.readOnly !== undefined ? globalInfo.readOnly : (f.field ? f.field.readOnly : f.readOnly),
        isIdentity: !!globalInfo.isIdentity,
        allowedValues: f.allowedValues || [],
        isOnForm: formFieldGroups.has(f.referenceName),
        formGroup: formFieldGroups.get(f.referenceName) || null
      };
    });
    
    // Save to storage & memory
    witFieldsCache[cacheKey] = fields;
    try {
      await chrome.storage.local.set({ [cacheKey]: fields });
    } catch (_) {}
    
    return fields;
  } catch (err) {
    console.error("Failed to load work item type fields for type " + wtype, err);
    return [];
  }
}

async function getDescriptionFieldForType(wtype) {
  if (!wtype) return FIELD_REGISTRY.desc.ref;
  const fields = await getWorkItemTypeFields(wtype);
  const refNames = new Set(fields.map(f => f.referenceName));
  for (const fallback of FIELD_REGISTRY.desc.fallbackRefs) {
    if (refNames.has(fallback)) return fallback;
  }
  if (refNames.has(FIELD_REGISTRY.desc.ref)) {
    return FIELD_REGISTRY.desc.ref;
  }
  // Fallback / default
  return FIELD_REGISTRY.desc.ref;
}


let teamRosterCache = null;

async function getTeamRoster() {
  if (teamRosterCache) return teamRosterCache;
  const o = await orgUrl();
  const { project } = await getConfig();
  const p = encodeURIComponent(project);
  const roster = new Map();
  try {
    const teams = (await req("GET", `${o}/_apis/projects/${p}/teams?${API_VERSION}`, undefined, undefined, { suppress401Event: true })).value || [];
    for (const t of teams.slice(0, 10)) {
      const m = await req("GET", `${o}/_apis/projects/${p}/teams/${t.id}/members?${API_VERSION}`, undefined, undefined, { suppress401Event: true });
      for (const x of (m.value || [])) {
        const idObj = x.identity;
        if (idObj && idObj.displayName) {
          roster.set(idObj.displayName, {
            displayName: idObj.displayName,
            mail: idObj.uniqueName || idObj.mail || "",
            descriptor: idObj.descriptor || "",
            id: idObj.id || "",
            isGroup: (idObj.isContainer) || false
          });
        }
      }
    }
  } catch (_) { /* fall through */ }
  if (!roster.size) {
    try {
      const ids = await wiqlIds(
        "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project ORDER BY [System.ChangedDate] DESC",
        200,
      );
      const items = await batchFetch(ids, ["System.AssignedTo"]);
      for (const w of items) {
        const dn = personName((w.fields || {})["System.AssignedTo"]);
        if (dn && !roster.has(dn)) {
          roster.set(dn, { displayName: dn, mail: "", descriptor: "", id: "", isGroup: false });
        }
      }
    } catch (_) { /* leave empty */ }
  }
  teamRosterCache = [...roster.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
  return teamRosterCache;
}

// Members of all project teams (deduped). Falls back to AssignedTo distinct
// values from recent items if the team API isn't permitted by the PAT scope.
async function getAssignees() {
  const roster = await getTeamRoster();
  return roster.map(r => r.displayName);
}

// Identity typeahead for @mentions. The IdentityPicker endpoint accepts a free-
// text query and returns matching org users with their subjectDescriptor — the
// piece needed to render a real ADO mention anchor (data-vss-mention) that
// triggers a notification. Falls back to filtering the cached team roster when
// the endpoint is unavailable (PAT scope too narrow, or 404 on some tenants).
async function searchIdentities(q, limit) {
  q = (q || "").trim();
  limit = Math.min(Math.max(limit | 0 || 8, 1), 25);
  const roster = await getTeamRoster();
  
  if (!q) {
    return roster.slice(0, limit);
  }
  
  const lq = q.toLowerCase();
  const localMatches = roster.filter(r => 
    r.displayName.toLowerCase().includes(lq) || 
    (r.mail && r.mail.toLowerCase().includes(lq))
  );
  
  if (localMatches.length > 0) {
    return localMatches.slice(0, limit);
  }
  
  const o = await orgUrl();
  try {
    const body = {
      query: q,
      identityTypes: ["user", "group"],
      operationScopes: ["ims", "source"],
      options: { MinResults: 1, MaxResults: limit },
      properties: ["DisplayName", "Mail", "SubjectDescriptor", "Account"],
    };
    const r = await req("POST", `${o}/_apis/IdentityPicker/Identities?api-version=7.1-preview.1`, body, undefined, { suppress401Event: true });
    const out = [];
    for (const set of (r.results || [])) {
      for (const id of (set.identities || [])) {
        out.push({
          displayName: id.displayName || "",
          mail: id.mail || "",
          descriptor: id.subjectDescriptor || "",
          isGroup: (id.entityType || "").toLowerCase() === "group",
          id: id.entityId || id.localId || ""
        });
      }
    }
    if (out.length) return out.slice(0, limit);
  } catch (_) { /* fall through to local matches */ }
  
  return localMatches.slice(0, limit);
}

// Distinct tags seen on recent items (no dedicated tag endpoint exists for a
// PAT, so we sample the most-recently-changed items and split their Tags).
async function tags() {
  const names = new Set();
  try {
    const ids = await wiqlIds(
      "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project ORDER BY [System.ChangedDate] DESC",
      500,
    );
    const items = await batchFetch(ids, ["System.Tags"]);
    for (const w of items) {
      for (const part of String((w.fields || {})["System.Tags"] || "").split(";")) {
        const s = part.trim();
        if (s) names.add(s);
      }
    }
  } catch (_) { /* leave empty */ }
  return [...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

// ---------- account / project discovery (setup picker) ----------
// Used by the setup modal to let the user PICK an org/project after pasting a
// PAT instead of typing them. Both require the PAT to be persisted first
// (authHeader reads it from storage). Either may legitimately fail for a
// narrowly-scoped PAT — callers fall back to manual text entry.

// Organizations (accounts) the PAT owner can access, sorted by name.
async function orgs() {
  const prof = await req("GET", `https://app.vssps.visualstudio.com/_apis/profile/profiles/me?${API_VERSION}`);
  const memberId = prof.publicAlias || prof.id;
  if (!memberId) return [];
  const res = await req("GET", `https://app.vssps.visualstudio.com/_apis/accounts?memberId=${encodeURIComponent(memberId)}&${API_VERSION}`);
  return (res.value || [])
    .map(a => a.accountName)
    .filter(Boolean)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

// Project names within a given org, sorted. Takes the org explicitly so it
// works during setup before the org is saved to config.
async function projects(org) {
  org = (org || "").trim();
  if (!org) return [];
  const url = `https://dev.azure.com/${encodeURIComponent(org)}/_apis/projects?stateFilter=wellFormed&$top=1000&${API_VERSION}`;
  const res = await req("GET", url);
  return (res.value || [])
    .map(p => p.name)
    .filter(Boolean)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

// Dependency edges among the given ids (both endpoints in the set).
async function deps(ids) {
  ids = ids.map(Number).filter(Number.isFinite);
  if (!ids.length) return [];
  const proj = await projUrl();
  const idSet = new Set(ids);
  const edges = [];
  const seen = new Set();
  const chunks = await pool(chunk200(ids).map(chunk => async () => {   // fetch relation chunks concurrently
    const url = `${proj}/_apis/wit/workitems?ids=${chunk.join(",")}&$expand=relations&${API_VERSION}`;
    return (await req("GET", url)).value || [];
  }), 6);
  for (const arr of chunks) for (const w of arr) {
    const wid = w.id;
    for (const r of (w.relations || [])) {
      const tail = (r.url || "").replace(/\/+$/, "").split("/").pop();
      if (!/^\d+$/.test(tail)) continue;
      const tid = parseInt(tail, 10);
      let src, dst;
      if (r.rel === "System.LinkTypes.Dependency-Forward") { src = wid; dst = tid; }
      else if (r.rel === "System.LinkTypes.Dependency-Reverse") { src = tid; dst = wid; }
      else continue;
      const k = src + "_" + dst;
      if (idSet.has(src) && idSet.has(dst) && !seen.has(k)) {
        seen.add(k);
        edges.push({ source: src, target: dst });
      }
    }
  }
  return edges;
}

// Bulk parent lookup for skip-resolution (used when a node's direct parent
// is filtered out and we need to find the nearest visible ancestor).
async function parents(ids) {
  ids = ids.map(Number).filter(Number.isFinite).slice(0, 500);
  if (!ids.length) return {};
  const proj = await projUrl();
  const out = {};
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
     const url = `${proj}/_apis/wit/workitems?ids=${chunk.join(",")}&fields=${FIELD_REGISTRY.parent.ref}&${API_VERSION}`;
    try {
      const res = await req("GET", url);
      for (const w of (res.value || [])) out[w.id] = (w.fields || {})[FIELD_REGISTRY.parent.ref] || null;
    } catch (_) { /* skip the chunk on error */ }
  }
  return out;
}

// How many child work items each of `ids` has, WITHOUT fetching the children.
// One WorkItemLinks WIQL query per chunk (returns ids only) → count the
// Hierarchy-Forward edges leaving each source. Children outside the current
// filter still count, so this is a true total (a node may show "3" yet expand
// to fewer rows once the filter hides some). A chunk that errors leaves its ids
// ABSENT from the result, so the caller can tell "0 children" from "unknown".
async function childCounts(ids) {
  ids = ids.map(Number).filter(Number.isFinite);
  if (!ids.length) return {};
  const proj = await projUrl();
  const out = {};
  await pool(chunk200(ids).map(chunk => async () => {
    const wiql =
      "SELECT [System.Id] FROM WorkItemLinks WHERE " +
      "([Source].[System.Id] IN (" + chunk.join(",") + ")) AND " +
      "([System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward') " +
      "MODE(MustContain)";
    let rels;
    try {
      const res = await req("POST", `${proj}/_apis/wit/wiql?${API_VERSION}`, { query: wiql });
      rels = res.workItemRelations || [];
    } catch (_) { return; }                       // chunk failed → its ids stay "unknown"
    for (const id of chunk) if (!(id in out)) out[id] = 0;   // chunk succeeded → known counts (incl. real zeros)
    for (const r of rels) {                       // source-only entries have rel === null → skipped
      if (r && r.rel && r.source && r.target) out[r.source.id] = (out[r.source.id] || 0) + 1;
    }
  }), 6);
  return out;
}

// ---------- item GET/PATCH/comment/create ----------
async function browserUrl(wid) {
  const { org, project } = await getConfig();
  return `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_workitems/edit/${wid}`;
}

// Pure: split a relations array into {blocks, blockedBy}. Forward = this item
// blocks → those ids; Reverse = this item is blocked by → those ids.
function depsFromRelations(rels) {
  const blocks = [], blockedBy = [];
  for (const r of (rels || [])) {
    const tail = (r.url || "").replace(/\/+$/, "").split("/").pop();
    if (!/^\d+$/.test(tail)) continue;
    const tid = parseInt(tail, 10);
    if (r.rel === "System.LinkTypes.Dependency-Forward") blocks.push(tid);
    else if (r.rel === "System.LinkTypes.Dependency-Reverse") blockedBy.push(tid);
  }
  return { blocks, blockedBy };
}

async function item(wid, options) {
  const proj = await projUrl();
  let url = `${proj}/_apis/wit/workitems/${wid}?${API_VERSION}`;
  const hasFields = options && Array.isArray(options.fields) && options.fields.length > 0;
  
  // We first fetch the item metadata (or full if requested)
  // If we only need specific fields, we need to map System.Description to the dynamic field name.
  // But wait, when calling api.item initially we don't know the work item type yet!
  // However, during light fields loading, System.Description is NOT fetched.
  // In Phase 2, we fetch fields dynamically. We will resolve the description field before fetching or handle it here.
  let fieldsToFetch = hasFields ? [...options.fields] : null;
  
  // If we are asked to fetch System.Description, we will first fetch type info or let it pass through.
  // Let's make it robust: if fieldsToFetch contains System.Description or Microsoft.VSTS.TCM.ReproSteps,
  // we first need to know the type. Let's do a fast GET if we don't know it, or just request both fields,
  // or fetch the work item and then map.
  // Actually, requesting the work item without fields parameter returns ALL fields!
  // If options.fields is specified, we fetch only those. Let's inspect options.fields.
  // If options.fields contains System.Description, we can replace it with both System.Description and Microsoft.VSTS.TCM.ReproSteps to be safe,
  // or resolve it. Requesting both is extremely clean and requires no extra API roundtrips!
  if (fieldsToFetch) {
    const descIdx = fieldsToFetch.indexOf(FIELD_REGISTRY.desc.ref);
    if (descIdx !== -1) {
      // Replace with both so we get whichever is defined
      fieldsToFetch.splice(descIdx, 1, FIELD_REGISTRY.desc.ref, ...FIELD_REGISTRY.desc.fallbackRefs);
    }
    if (!fieldsToFetch.includes("System.Rev")) {
      fieldsToFetch.push("System.Rev");
    }
  }

  const expandRelations = (options && options.expandRelations !== undefined) ? !!options.expandRelations : (hasFields ? false : true);
  if (expandRelations) {
    url += `&$expand=relations`;
  } else if (fieldsToFetch) {
    url += `&fields=${fieldsToFetch.map(f => resolveField(f)).join(",")}`;
  }
  const d = await req("GET", url, undefined, undefined, options);
  const f = d.fields || {};
  const wtype = f["System.WorkItemType"];
  
  // Resolve which description field to use
  let descField = "System.Description";
  if (wtype) {
    descField = await getDescriptionFieldForType(wtype);
  }

  const mapped = mapWorkItem(d, descField);
  mapped.url = await browserUrl(d.id);
  return mapped;
}

// Standalone Dependency lookup for one item. Same shape as item().deps, used
// from the graph (no full editor open) and for cache invalidation.
async function dependencies(wid) {
  const proj = await projUrl();
  const d = await req("GET", `${proj}/_apis/wit/workitems/${wid}?${API_VERSION}&$expand=relations`);
  return depsFromRelations(d.relations);
}

// Add a dep link: System.LinkTypes.Dependency-Forward on fromId pointing at toId.
// Equivalent to a Reverse on toId — ADO renders it on both ends, and dependencies()
// reads it from whichever side the caller asks about.
async function addDependency(fromId, toId) {
  fromId = Number(fromId); toId = Number(toId);
  if (!Number.isFinite(fromId) || !Number.isFinite(toId)) throw new Error("invalid id");
  if (fromId === toId) throw new Error("a work item can't depend on itself");
  const proj = await projUrl();
  const d = await req("GET", `${proj}/_apis/wit/workitems/${fromId}?${API_VERSION}&$expand=relations`);
  for (const r of (d.relations || [])) {
    if (r.rel !== "System.LinkTypes.Dependency-Forward" && r.rel !== "System.LinkTypes.Dependency-Reverse") continue;
    const tail = (r.url || "").replace(/\/+$/, "").split("/").pop();
    if (tail === String(toId)) throw new Error("dependency already exists");
  }
  const ops = [
    { op: "test", path: "/rev", value: d.rev },
    { op: "add", path: "/relations/-",
      value: { rel: "System.LinkTypes.Dependency-Forward", url: `${proj}/_apis/wit/workitems/${toId}` } },
  ];
  const r = await req("PATCH", `${proj}/_apis/wit/workitems/${fromId}?${API_VERSION}`, ops, "application/json-patch+json");
  return { id: r.id, rev: r.rev };
}

// Remove the Dependency link between fromId and toId. The relation can physically
// live on either end (Forward on the source, or Reverse on the target — they are
// the same link); try fromId's side first, fall back to toId's.
async function removeDependency(fromId, toId) {
  fromId = Number(fromId); toId = Number(toId);
  if (!Number.isFinite(fromId) || !Number.isFinite(toId)) throw new Error("invalid id");
  const proj = await projUrl();
  async function tryRemoveFrom(host, peer) {
    const d = await req("GET", `${proj}/_apis/wit/workitems/${host}?${API_VERSION}&$expand=relations`);
    const rels = d.relations || [];
    const idx = rels.findIndex(r => {
      if (r.rel !== "System.LinkTypes.Dependency-Forward" && r.rel !== "System.LinkTypes.Dependency-Reverse") return false;
      const tail = (r.url || "").replace(/\/+$/, "").split("/").pop();
      return tail === String(peer);
    });
    if (idx < 0) return null;
    const ops = [
      { op: "test", path: "/rev", value: d.rev },
      { op: "remove", path: `/relations/${idx}` },
    ];
    return await req("PATCH", `${proj}/_apis/wit/workitems/${host}?${API_VERSION}`, ops, "application/json-patch+json");
  }
  const r1 = await tryRemoveFrom(fromId, toId);
  if (r1) return { id: r1.id, rev: r1.rev };
  const r2 = await tryRemoveFrom(toId, fromId);
  if (r2) return { id: r2.id, rev: r2.rev };
  throw new Error("dependency link not found");
}

// ---------- attachments ----------
// Pure: split relations into {attachments} (rel === "AttachedFile"). Each attachment
// is identified by its URL — that's the same URL the work item's HTML description
// references when an image is inlined, so the two views stay in sync.
function attachmentsFromRelations(rels) {
  const out = [];
  for (const r of (rels || [])) {
    if (r.rel !== "AttachedFile") continue;
    const a = r.attributes || {};
    out.push({
      url: r.url || "",
      name: a.name || a.comment || decodeURIComponent((r.url || "").split("?fileName=")[1] || "").split("&")[0] || "attachment",
      comment: a.comment || "",
      size: typeof a.resourceSize === "number" ? a.resourceSize : null,
      date: a.authorizedDate || a.resourceCreatedDate || "",
    });
  }
  return out;
}

// Upload a file's bytes to the project-scoped attachment endpoint. ADO returns
// `{id, url}` — the url is what you reference from the description (<img src=...>)
// and what addAttachmentLink() registers as a relation. Note: an uploaded file
// is garbage-collected within ~hours if it's never linked, so callers should
// link or use it immediately.
// Fetch attachment bytes authenticated (the URLs require an Authorization header
// that the browser doesn't send for plain <img src=...>, so the preview renderer
// downloads each image through this and swaps src to a blob: URL).
async function fetchAttachmentBlob(url, options) {
  if (!url) throw new Error("no url");
  const headers = { Authorization: await authHeader(), "X-TFS-FedAuthRedirect": "Suppress" };
  const resp = await fetch(url, { headers, signal: options?.signal });
  if (!resp.ok) throw await errorFrom(resp);
  return await resp.blob();
}

async function uploadAttachment(file) {
  if (!file) throw new Error("no file");
  const name = file.name || "upload.bin";
  const proj = await projUrl();
  const buf = file instanceof Blob ? await file.arrayBuffer() : file;
  const url = `${proj}/_apis/wit/attachments?fileName=${encodeURIComponent(name)}&${API_VERSION}`;
  // ADO's attachments endpoint accepts only application/octet-stream for the
  // raw-bytes upload — sending the file's real MIME (e.g. image/jpeg) is a 400.
  const res = await req("POST", url, buf, "application/octet-stream");
  return { id: res.id, url: res.url, name };
}

// Add an AttachedFile relation pointing at an already-uploaded attachment URL.
// `name` shows in the ADO Attachments tab; `comment` is the optional caption.
async function addAttachmentLink(wid, attUrl, name, comment) {
  if (!wid || !attUrl) throw new Error("wid and url required");
  const proj = await projUrl();
  const attrs = {};
  if (name) attrs.name = name;
  if (comment) attrs.comment = comment;
  const ops = [{
    op: "add", path: "/relations/-",
    value: { rel: "AttachedFile", url: attUrl, attributes: attrs },
  }];
  const r = await req("PATCH", `${proj}/_apis/wit/workitems/${wid}?${API_VERSION}&$expand=relations`,
    ops, "application/json-patch+json");
  return { id: r.id, rev: r.rev, attachments: attachmentsFromRelations(r.relations) };
}

// Remove an AttachedFile relation by its URL. Returns the post-PATCH attachments
// list so the UI can refresh without an extra round-trip.
async function removeAttachmentLink(wid, attUrl) {
  if (!wid || !attUrl) throw new Error("wid and url required");
  const proj = await projUrl();
  const d = await req("GET", `${proj}/_apis/wit/workitems/${wid}?${API_VERSION}&$expand=relations`);
  const rels = d.relations || [];
  const idx = rels.findIndex(r => r.rel === "AttachedFile" && r.url === attUrl);
  if (idx < 0) throw new Error("attachment not found");
  const ops = [
    { op: "test", path: "/rev", value: d.rev },
    { op: "remove", path: `/relations/${idx}` },
  ];
  const r = await req("PATCH", `${proj}/_apis/wit/workitems/${wid}?${API_VERSION}&$expand=relations`,
    ops, "application/json-patch+json");
  return { id: r.id, rev: r.rev, attachments: attachmentsFromRelations(r.relations) };
}

// Body shape mirrors the old /api/item PATCH endpoint: friendly aliases
// (title/state/assigned/iteration/desc/ac/priority/estimate/start/target/due).
async function updateItem(wid, body) {
  let wtype = null;
  if (("target" in body && !detectedTargetField) || "desc" in body) {
    try {
      const proj = await projUrl();
      const w = await req("GET", `${proj}/_apis/wit/workitems/${wid}?${API_VERSION}`);
      const f = w.fields || {};
      wtype = f[FIELD_REGISTRY.type.ref];
      if (FIELD_REGISTRY.finish.ref in f) {
        detectedTargetField = FIELD_REGISTRY.finish.ref;
      } else if (FIELD_REGISTRY.target.ref in f) {
        detectedTargetField = FIELD_REGISTRY.target.ref;
      } else {
        if (wtype === "Product Backlog Item") {
          detectedTargetField = FIELD_REGISTRY.finish.ref;
        }
      }
    } catch (_) {}
  }
  const fields = {};
  for (const k of ["title","state","assigned","iteration","start","target","due","tags","area","activity","risk","valuearea"]) {
    if (k in body) fields[k] = body[k];
  }
  // Copy custom fields directly
  const handled = new Set([
    "title", "state", "assigned", "iteration", "start", "target", "due", "tags",
    "area", "activity", "risk", "valuearea", "priority", "storypoints",
    "remaining", "completed", "estimate", "desc", "ac"
  ]);
  for (const [k, v] of Object.entries(body)) {
    if (!handled.has(k)) {
      const regField = Object.values(FIELD_REGISTRY).find(r => r.ref === k);
      if (regField && (regField.type === 'html' || regField.type === 'plaintext')) {
        fields[k] = AdoLib.mdToHtml(v || "", mdOpts);
      } else {
        fields[k] = v;
      }
    }
  }
  if (fields.assigned === "me") {
    const u = await me();
    if (u) fields.assigned = u;
  }
  if ("priority" in body) fields.priority = body.priority;
  if ("storypoints" in body) {
    const v = body.storypoints;
    if (v === "") fields.storypoints = "";
    else {
      const n = parseFloat(v);
      if (Number.isFinite(n)) fields.storypoints = n;
    }
  }
  if ("remaining" in body) {
    const v = body.remaining;
    if (v === "") fields.remaining = "";
    else {
      const n = parseFloat(v);
      if (Number.isFinite(n)) fields.remaining = n;
    }
  }
  if ("completed" in body) {
    const v = body.completed;
    if (v === "") fields.completed = "";
    else {
      const n = parseFloat(v);
      if (Number.isFinite(n)) fields.completed = n;
    }
  }
  if ("estimate" in body) {
    const v = body.estimate;
    if (v === "") fields.estimate = "";
    else {
      const n = parseFloat(v);
      if (Number.isFinite(n)) fields.estimate = n;
    }
  }
  // Render description / AC with #N autolinks pointing at THIS project's
  // work-item edit URL. Same opts on both fields so the saved HTML matches
  // what the editor's preview shows.
  let mdOpts = undefined;
  if ("desc" in body || "ac" in body) {
    const { org, project } = await getConfig();
    if (org && project) {
      mdOpts = { workItemBase: `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_workitems/edit` };
    }
  }
  if ("desc" in body) fields.desc = AdoLib.mdToHtml(body.desc, mdOpts);
  if ("ac" in body) fields.ac = AdoLib.mdToHtml(body.ac, mdOpts);
  if (!Object.keys(fields).length) throw new Error("no fields");

  // Determine actual description field to use for patch
  let descField = "System.Description";
  if ("desc" in body && wtype) {
    descField = await getDescriptionFieldForType(wtype);
  }

  // ADO REST quirks:
  // 1. op:"add" with an empty value is silently dropped on some fields (e.g.
  //    clearing dates) — use op:"remove" to clear.
  // 2. System.Tags is especially fiddly: op:"add" with the new (shorter) list
  //    is treated as APPEND on some tenants, so a deletion silently re-merges.
  //    The JSON-Patch-standard fix is op:"replace" with the new value, which
  //    cleanly replaces. ADO rejects two ops on the same field in one PATCH
  //    (VS403691), so we send exactly one op for tags.
  const ops = [];
  for (const [k, v] of Object.entries(fields)) {
    let resolved;
    if (k === "desc") {
      resolved = descField;
    } else {
      resolved = resolveField(k);
    }
    const path = `/fields/${resolved}`;
    if (v === "" || v == null) {
      ops.push({ op: "remove", path });
    } else if (k === "tags") {
      ops.push({ op: "replace", path, value: v });
    } else {
      ops.push({ op: "add", path, value: v });
    }
  }
  const proj = await projUrl();
  const d = await req("PATCH", `${proj}/_apis/wit/workitems/${wid}?${API_VERSION}`, ops, "application/json-patch+json");
  return { id: d.id, rev: d.rev };
}

async function comment(wid, text) {
  text = (text || "").trim();
  if (!text) throw new Error("empty");
  const proj = await projUrl();
  const { org, project } = await getConfig();
  const mdOpts = (org && project) ? { workItemBase: `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_workitems/edit` } : undefined;
  const htmlText = AdoLib.mdToHtml(text, mdOpts);
  await req("POST", `${proj}/_apis/wit/workItems/${wid}/comments?api-version=7.1-preview.3`, { text: htmlText });
  return { ok: true };
}

async function updateComment(wid, commentId, text) {
  text = (text || "").trim();
  if (!text) throw new Error("empty");
  const proj = await projUrl();
  const { org, project } = await getConfig();
  const mdOpts = (org && project) ? { workItemBase: `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_workitems/edit` } : undefined;
  const htmlText = AdoLib.mdToHtml(text, mdOpts);
  await req("PATCH", `${proj}/_apis/wit/workItems/${wid}/comments/${commentId}?api-version=7.1-preview.3`, { text: htmlText });
  return { ok: true };
}

async function deleteComment(wid, commentId) {
  const proj = await projUrl();
  await req("DELETE", `${proj}/_apis/wit/workItems/${wid}/comments/${commentId}?api-version=7.1-preview.3`);
  return { ok: true };
}

async function addCommentReaction(wid, commentId, reactionType) {
  const proj = await projUrl();
  await req("PUT", `${proj}/_apis/wit/workitems/${wid}/comments/${commentId}/reactions/${reactionType}?api-version=7.1-preview.1`);
  return { ok: true };
}

async function removeCommentReaction(wid, commentId, reactionType) {
  const proj = await projUrl();
  await req("DELETE", `${proj}/_apis/wit/workitems/${wid}/comments/${commentId}/reactions/${reactionType}?api-version=7.1-preview.1`);
  return { ok: true };
}

async function commentReactionUsers(wid, commentId, reactionType) {
  const proj = await projUrl();
  const r = await req("GET", `${proj}/_apis/wit/workitems/${wid}/comments/${commentId}/reactions/${reactionType}/users?api-version=7.1-preview.1`, undefined, undefined, { suppress401Event: true });
  return (r.value || []).map(u => personName(u.identity || u)).filter(Boolean);
}

// Existing comments on an item (newest first). Comment bodies are HTML → markdown.
async function comments(wid, options) {
  const proj = await projUrl();
  try {
    const r = await req("GET", `${proj}/_apis/wit/workitems/${wid}/comments?$expand=all&api-version=7.1-preview.3&$top=200`, undefined, undefined, options);
    return (r.comments || [])
      .map(c => {
        const reactions = {};
        if (c.reactions) {
          c.reactions.forEach(react => {
            const type = react.commentReactionType || react.type;
            if (type) {
              reactions[type] = {
                count: react.count,
                me: !!(react.isCurrentUserReacted || react.isCurrentUserEngaged)
              };
            }
          });
        }
        return {
          id: c.id,
          text: htmlToMarkdown(c.renderedText || c.text),
          by: ((c.createdBy || {}).displayName) || "",
          date: c.createdDate || c.modifiedDate || "",
          reactions: reactions
        };
      })
      .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  } catch (_) { return []; }
}

// Field-change history (newest first), derived from the revision updates we
// already fetch for time-in-state. Each entry: {by, date, changes:[{field,from,to}]}.
const HISTORY_FIELDS = {
  [FIELD_REGISTRY.state.ref]: "State",
  [FIELD_REGISTRY.assigned.ref]: "Assigned",
  [FIELD_REGISTRY.title.ref]: "Title",
  [FIELD_REGISTRY.iteration.ref]: "Sprint",
  [FIELD_REGISTRY.priority.ref]: "Priority",
  [FIELD_REGISTRY.parent.ref]: "Parent",
  [FIELD_REGISTRY.target.ref]: "Target",
  [FIELD_REGISTRY.estimate.ref]: "Estimate",
  [FIELD_REGISTRY.tags.ref]: "Tags",
};
async function history(wid) {
  const ups = await updatesFor(wid);
  const out = [];
  for (const u of ups) {
    const f = u.fields || {};
    const changes = [];
    for (const ref of Object.keys(HISTORY_FIELDS)) {
      if (!(ref in f)) continue;
      const ov = f[ref] || {};
      if (!("newValue" in ov) && !("oldValue" in ov)) continue;
      changes.push({ field: HISTORY_FIELDS[ref], from: personName(ov.oldValue), to: personName(ov.newValue) });
    }
    if (!changes.length) continue;
    const by = personName((u.revisedBy || {}).displayName || (u.revisedBy || {}));
    const date = ((f["System.ChangedDate"] || {}).newValue) || u.revisedDate || "";
    out.push({ by, date, changes });
  }
  return out.reverse();   // newest first
}

async function createItem({ type, title, parent, assigned, priority, iteration }) {
  if (!type || !title) throw new Error("type and title required");
  const fields = {};
  if (assigned) fields.assigned = (assigned === "me" ? (await me()) || assigned : assigned);
  if (priority) {
    const n = parseInt(priority, 10);
    if (Number.isFinite(n)) fields.priority = n;
  }
  if (iteration) fields.iteration = iteration;

  const ops = [{ op: "add", path: "/fields/System.Title", value: title }];
  for (const [k, v] of Object.entries(fields)) {
    ops.push({ op: "add", path: `/fields/${resolveField(k)}`, value: v });
  }
  if (parent != null) {
    const proj = await projUrl();
    ops.push({
      op: "add", path: "/relations/-",
      value: { rel: "System.LinkTypes.Hierarchy-Reverse", url: `${proj}/_apis/wit/workitems/${parent}` },
    });
  }
  const proj = await projUrl();
  const url = `${proj}/_apis/wit/workitems/${encodeURIComponent("$" + type)}?${API_VERSION}`;
  const d = await req("POST", url, ops, "application/json-patch+json");
  return mapWorkItem(d);
}

// Delete a work item (the inverse of createItem, for undo). ADO moves it to the
// project's Recycle Bin by default (destroy=false), so it stays recoverable.
async function deleteItem(wid) {
  const proj = await projUrl();
  await req("DELETE", `${proj}/_apis/wit/workitems/${wid}?${API_VERSION}`);
}

// Re-parent an item: remove its current Hierarchy-Reverse (parent) link and add
// a new one. Pass newParentId="" / null to detach (make it a root). Uses a /rev
// test op so a concurrent edit fails loudly instead of clobbering.
async function setParent(wid, newParentId) {
  const proj = await projUrl();
  const d = await req("GET", `${proj}/_apis/wit/workitems/${wid}?${API_VERSION}&$expand=relations`);
  const rels = d.relations || [];
  const idx = rels.findIndex(r => r.rel === "System.LinkTypes.Hierarchy-Reverse");
  const ops = [{ op: "test", path: "/rev", value: d.rev }];
  if (idx >= 0) ops.push({ op: "remove", path: `/relations/${idx}` });
  if (newParentId != null && String(newParentId) !== "") {
    ops.push({ op: "add", path: "/relations/-",
      value: { rel: "System.LinkTypes.Hierarchy-Reverse", url: `${proj}/_apis/wit/workitems/${newParentId | 0}` } });
  }
  if (ops.length === 1) throw new Error("no parent change");   // nothing to remove and nothing to add
  const r = await req("PATCH", `${proj}/_apis/wit/workitems/${wid}?${API_VERSION}`, ops, "application/json-patch+json");
  return { id: r.id, rev: r.rev, parent: (r.fields || {})[FIELD_REGISTRY.parent.ref] || null };
}

// ---------- updates / business-hours (active time per item) ----------
const ACTIVE_STATES = new Set(["Active", "Doing", "In Progress", "Committed"]);

// Configurable working window (local hours, Mon-Fri); the UI sets these.
let workStart = 9, workEnd = 17;
function setWorkHours(s, e) {
  s = parseInt(s, 10); e = parseInt(e, 10);
  const ns = (Number.isFinite(s) && s >= 0 && s <= 23) ? s : workStart;
  const ne = (Number.isFinite(e) && e >= 1 && e <= 24) ? e : workEnd;
  if (ne > ns) { workStart = ns; workEnd = ne; }   // only commit a valid (start < end) window
  return { start: workStart, end: workEnd };
}
function getWorkHours() { return { start: workStart, end: workEnd }; }

function parseTs(t) {
  if (!t) return null;
  const d = new Date(t);
  return Number.isFinite(d.valueOf()) ? d : null;
}

// Business-second overlap (pure math in lib.js, bound to the current window).
function businessSeconds(s, e, offset) { return AdoLib.businessSeconds(s, e, offset, workStart, workEnd); }

async function updatesFor(wid) {
  const proj = await projUrl();
  try {
    const r = await req("GET", `${proj}/_apis/wit/workItems/${wid}/updates?${API_VERSION}`);
    return r.value || [];
  } catch (_) { return []; }
}

// Promise pool: run `tasks` with at most `n` in flight.
async function pool(tasks, n) {
  const out = new Array(tasks.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(n, tasks.length) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= tasks.length) return;
      out[i] = await tasks[i]();
    }
  });
  await Promise.all(workers);
  return out;
}

// {id: seconds} of active wall-clock time per id; parallelized 8-wide and
// capped at 200 ids to match the old Flask version.
async function times(ids, offset) {
  ids = ids.map(Number).filter(Number.isFinite).slice(0, 200);
  if (!ids.length) return {};
  const now = new Date();
  const off = offset | 0;
  const results = await pool(ids.map(wid => async () => {
    const ups = await updatesFor(wid);
    const pts = [];
    for (const u of ups) {
      const f = u.fields || {};
      if ("System.State" in f) {
        const nv = (f["System.State"] || {}).newValue;
        const when = parseTs(((f["System.ChangedDate"] || {}).newValue) || u.revisedDate);
        if (nv && when) pts.push([nv, when]);
      }
    }
    let sec = 0;
    for (let i = 0; i < pts.length; i++) {
      const [st, at] = pts[i];
      const end = (i + 1 < pts.length) ? pts[i + 1][1] : now;
      if (ACTIVE_STATES.has(st)) sec += businessSeconds(at, end, off);
    }
    return [wid, sec];
  }), 3);
  const out = {};
  for (const [wid, sec] of results) out[wid] = sec;
  return out;
}

// Per-state wall-clock breakdown for one item (the editor's "⏱ time in state" row).
async function timeline(wid, offset) {
  const ups = await updatesFor(wid);
  const pts = [];
  for (const u of ups) {
    const f = u.fields || {};
    if ("System.State" in f) {
      const nv = (f["System.State"] || {}).newValue;
      const when = parseTs(((f["System.ChangedDate"] || {}).newValue) || u.revisedDate);
      if (nv && when) pts.push([nv, when]);
    }
  }
  const off = offset | 0, now = new Date(), durations = {};
  for (let i = 0; i < pts.length; i++) {
    const [st, at] = pts[i];
    const end = (i + 1 < pts.length) ? pts[i + 1][1] : now;
    durations[st] = (durations[st] || 0) + businessSeconds(at, end, off);
  }
  return {
    durations,
    current: pts.length ? pts[pts.length - 1][0] : null,
    since: pts.length ? pts[pts.length - 1][1].toISOString() : null,
  };
}

async function batchUpdate(operations) {
  if (!operations || !operations.length) return [];
  const org = await orgUrl();
  const url = `${org}/_apis/wit/$batch?${API_VERSION}`;
  return await req("POST", url, operations, "application/json");
}

function getFilterFields() {
  const fields = [];
  for (const [key, val] of Object.entries(FIELD_REGISTRY)) {
    if (!val) continue;
    const ref = val.ref || "";
    const refLower = ref.toLowerCase();
    
    // Determine neutral type
    let neutralType = 'string';
    let operators = [];
    
    const isTree = val.type === 'treePath' || val.type === 'tree';
    
    if (isTree) {
      neutralType = 'tree';
      operators = ['=', '<>', 'UNDER', 'NOT UNDER', 'IN', 'NOT IN'];
    } else if (val.type === 'boolean') {
      neutralType = 'boolean';
      operators = ['=', '<>'];
    } else if (val.type === 'integer' || val.type === 'double') {
      neutralType = 'number';
      operators = ['=', '<>', '>', '<', '>=', '<=', 'IN', 'NOT IN'];
    } else if (val.type === 'dateTime') {
      neutralType = 'date';
      operators = ['=', '<>', '>', '<', '>=', '<=', 'IN', 'NOT IN'];
    } else if (val.type === 'identity') {
      neutralType = 'user';
      operators = ['=', '<>', 'IN', 'NOT IN'];
    } else if (val.type === 'tags') {
      neutralType = 'tags';
      operators = ['CONTAINS', 'NOT CONTAINS'];
    } else if (key === 'title' || val.type === 'html') {
      neutralType = 'string';
      operators = ['CONTAINS', 'NOT CONTAINS'];
    } else {
      neutralType = 'string';
      operators = ['=', '<>', 'CONTAINS', 'NOT CONTAINS', 'IN', 'NOT IN'];
    }
    
    fields.push({
      id: key,
      displayName: val.name || key,
      type: neutralType,
      allowedValues: val.allowedValues || null,
      operators: operators
    });
  }
  return fields;
}

// ---------- exported facade (everything app.js needs) ----------
(typeof window !== "undefined" ? window : self).api = {
  batchUpdate,
  // config
  getConfig, setConfig, clearConfig,
  // auth (Microsoft Entra ID OAuth)
  oauthSignIn, signOut, oauthRedirectUri,
  // setup picker (org / project discovery)
  orgs, projects,
  // primitives
  // primitives
  me, iterations, areas, states, workItemTypes, getWorkItemTypeFields, getDescriptionFieldForType, createSprint, updateSprintDates, assignees: getAssignees, tags, browserUrl,
  // work-hours config (active-time window)
  setWorkHours, getWorkHours,
  // list / search / children / parents
  roots: ({ text, order, filters } = {}) => list({ text, order, filters }),
  search: ({ text, order, filters, signal } = {}) => list({ text, order, filters, signal }),
  children: (wid, order) => list({ parent: wid, order }),
  parents, childCounts,
  // graph
  deps,
  // dependency links (create / remove / per-item lookup)
  addDependency, removeDependency, dependencies,
  // item ops
  item, updateItem, comment, comments, updateComment, deleteComment, addCommentReaction, removeCommentReaction, commentReactionUsers, history, createItem, deleteItem, setParent,
  // attachments + identities (description editor: upload / link / delete / @-mention)
  uploadAttachment, addAttachmentLink, removeAttachmentLink, fetchAttachmentBlob, searchIdentities,
  // time
  times, timeline,
  // utils
  pool, chunk200, req, projUrl, batchFetch,
  // registry
  FIELD_REGISTRY,
  populateFieldRegistry,
  getFilterFields,
  mapWorkItem,
  isCoreField,
};

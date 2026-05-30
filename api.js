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

const FIELD_ALIASES = {
  title: "System.Title",
  state: "System.State",
  desc: "System.Description",
  description: "System.Description",
  ac: "Microsoft.VSTS.Common.AcceptanceCriteria",
  assigned: "System.AssignedTo",
  assignedto: "System.AssignedTo",
  tags: "System.Tags",
  iteration: "System.IterationPath",
  area: "System.AreaPath",
  priority: "Microsoft.VSTS.Common.Priority",
  effort: "Microsoft.VSTS.Scheduling.Effort",
  estimate: "Microsoft.VSTS.Scheduling.OriginalEstimate",
  start: "Microsoft.VSTS.Scheduling.StartDate",
  target: "Microsoft.VSTS.Scheduling.TargetDate",
  due: "Microsoft.VSTS.Scheduling.DueDate",
};

const DEFAULT_FIELDS = [
  "System.Id",
  "System.WorkItemType",
  "System.Title",
  "System.State",
  "System.AssignedTo",
  "System.Parent",
  "Microsoft.VSTS.Common.Priority",
  "System.IterationPath",
  "Microsoft.VSTS.Scheduling.StartDate",
  "Microsoft.VSTS.Scheduling.TargetDate",
  "Microsoft.VSTS.Scheduling.DueDate",
  "Microsoft.VSTS.Scheduling.OriginalEstimate",
  "System.Tags",
];

const AC_TYPES = new Set(["User Story", "Feature", "Epic", "Issue", "Product Backlog Item"]);

// Same filter registry the chip UI uses. Mirrors FILTER_FIELDS in the old
// Flask backend — change one place when you add a column.
const FILTER_FIELDS = {
  type:      { ref: "System.WorkItemType" },
  state:     { ref: "System.State" },
  priority:  { ref: "Microsoft.VSTS.Common.Priority", num: true },
  assigned:  { ref: "System.AssignedTo", identity: true },
  iteration: { ref: "System.IterationPath" },
  tags:      { ref: "System.Tags", contains: true },   // semicolon-list field → CONTAINS, not IN
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
  await chrome.storage.local.set(patch);
}
async function clearConfig() {
  await chrome.storage.local.remove(STORE_KEYS);
  try { const all = await chrome.storage.local.get(null); const snaps = Object.keys(all).filter(k => k.startsWith("snap:")); if (snaps.length) await chrome.storage.local.remove(snaps); } catch (_) {}
}

// ---------- HTTP ----------
function resolveField(k) { return FIELD_ALIASES[k.toLowerCase()] || k; }

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

async function req(method, url, body, ctype) {
  const headers = { Authorization: await authHeader() };
  // Make ADO return a plain 401 instead of redirecting to its sign-in page —
  // the redirect is what makes the browser pop its native login dialog.
  headers["X-TFS-FedAuthRedirect"] = "Suppress";
  if (body !== undefined) headers["Content-Type"] = ctype || "application/json";
  const payload = body === undefined ? undefined : JSON.stringify(body);
  for (let attempt = 0; ; attempt++) {
    const resp = await fetch(url, { method, headers, body: payload });
    if (resp.ok) {
      const text = await resp.text();
      if (!text) return {};
      // ADO sometimes prefixes responses with a UTF-8 BOM; strip it before JSON.parse.
      return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    }
    // 401 mid-session = PAT expired/revoked: let the UI react, don't retry.
    if (resp.status === 401) {
      if (typeof window !== "undefined") { try { window.dispatchEvent(new CustomEvent("ado-401")); } catch (_) { /* no window */ } }
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

// Project-side _node() helper (mirrors the Flask version).
function nodeOf(w) {
  const f = w.fields || {};
  return {
    id: w.id,
    type: f["System.WorkItemType"],
    title: f["System.Title"] || "",
    state: f["System.State"] || "",
    assigned: personName(f["System.AssignedTo"]),
    priority: f["Microsoft.VSTS.Common.Priority"],
    parent: f["System.Parent"],
    iteration: f["System.IterationPath"],
    start: f["Microsoft.VSTS.Scheduling.StartDate"],
    est: f["Microsoft.VSTS.Scheduling.OriginalEstimate"],
    target: f["Microsoft.VSTS.Scheduling.TargetDate"] || f["Microsoft.VSTS.Scheduling.DueDate"],
    tags: f["System.Tags"] || "",
  };
}

// ---------- WIQL filter builder ----------
// Pure logic lives in lib.js; bind it to this module's FILTER_FIELDS registry.
function buildClauses(filters) { return AdoLib.buildClauses(FILTER_FIELDS, filters); }

// ---------- core ADO reads ----------
async function wiqlIds(wiql, top) {
  const proj = await projUrl();
  const url = `${proj}/_apis/wit/wiql?${API_VERSION}` + (top ? `&$top=${top|0}` : "");
  const res = await req("POST", url, { query: wiql });
  return (res.workItems || []).map(w => w.id);
}

function chunk200(ids) { const out = []; for (let i = 0; i < ids.length; i += 200) out.push(ids.slice(i, i + 200)); return out; }

async function batchFetch(ids, fields) {
  if (!ids.length) return [];
  fields = fields || DEFAULT_FIELDS;
  const proj = await projUrl();
  // Fetch the 200-id chunks concurrently (6-wide) instead of one at a time.
  const results = await pool(chunk200(ids).map(chunk => async () => {
    const url = `${proj}/_apis/wit/workitems?ids=${chunk.join(",")}&fields=${fields.join(",")}&${API_VERSION}`;
    return (await req("GET", url)).value || [];
  }), 6);
  const byId = {};
  for (const arr of results) for (const w of arr) byId[w.id] = w;
  // preserve caller's id order (which carries the WIQL ORDER BY)
  return ids.map(i => byId[i]).filter(Boolean);
}

// Generic list (mirrors AdoClient.list). Returns an array of nodeOf() shapes.
async function list({ wtype, parent, text, order, filters } = {}) {
  const where = ["[System.TeamProject] = @project"];
  for (const c of buildClauses(filters || {})) where.push(c);
  if (wtype) where.push(`[System.WorkItemType] = '${wiqlQuote(wtype)}'`);
  if (parent != null) where.push(`[System.Parent] = ${parent|0}`);
  if (text) where.push(`[System.Title] CONTAINS '${wiqlQuote(text)}'`);
  const orderBy = order === "priority"
    ? "[Microsoft.VSTS.Common.Priority], [System.Id]"
    : "[System.Id]";
  const wiql = "SELECT [System.Id] FROM WorkItems WHERE " + where.join(" AND ") + " ORDER BY " + orderBy;
  const ids = await wiqlIds(wiql, LIST_CAP);
  const items = await batchFetch(ids);
  const out = items.map(nodeOf);
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
    if (a.startDate || a.finishDate) {
      out.push({ path, name, start: a.startDate || null, finish: a.finishDate || null });
    }
    for (const ch of (node.children || [])) walk(ch, path);
  }
  walk(root, "");
  out.sort((x, y) => (x.finish || x.start || "").localeCompare(y.finish || y.start || ""));
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

// Members of all project teams (deduped). Falls back to AssignedTo distinct
// values from recent items if the team API isn't permitted by the PAT scope.
async function getAssignees() {
  const o = await orgUrl();
  const { project } = await getConfig();
  const p = encodeURIComponent(project);
  const names = new Set();
  try {
    const teams = (await req("GET", `${o}/_apis/projects/${p}/teams?${API_VERSION}`)).value || [];
    for (const t of teams.slice(0, 10)) {
      const m = await req("GET", `${o}/_apis/projects/${p}/teams/${t.id}/members?${API_VERSION}`);
      for (const x of (m.value || [])) {
        const dn = (x.identity || {}).displayName;
        if (dn) names.add(dn);
      }
    }
  } catch (_) { /* fall through */ }
  if (!names.size) {
    try {
      const ids = await wiqlIds(
        "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project ORDER BY [System.ChangedDate] DESC",
        200,
      );
      const items = await batchFetch(ids, ["System.AssignedTo"]);
      for (const w of items) {
        const dn = personName((w.fields || {})["System.AssignedTo"]);
        if (dn) names.add(dn);
      }
    } catch (_) { /* leave empty */ }
  }
  return [...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
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
    const url = `${proj}/_apis/wit/workitems?ids=${chunk.join(",")}&fields=System.Parent&${API_VERSION}`;
    try {
      const res = await req("GET", url);
      for (const w of (res.value || [])) out[w.id] = (w.fields || {})["System.Parent"] || null;
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

async function item(wid) {
  const proj = await projUrl();
  const d = await req("GET", `${proj}/_apis/wit/workitems/${wid}?${API_VERSION}&$expand=relations`);
  const f = d.fields || {};
  const wtype = f["System.WorkItemType"];
  const a = f["System.AssignedTo"];
  return {
    id: d.id, rev: d.rev, type: wtype,
    title: f["System.Title"] || "",
    state: f["System.State"] || "",
    assigned: (a && typeof a === "object") ? (a.displayName || "") : (a || ""),
    priority: f["Microsoft.VSTS.Common.Priority"],
    desc: htmlToMarkdown(f["System.Description"]),
    ac: htmlToMarkdown(f["Microsoft.VSTS.Common.AcceptanceCriteria"]),
    has_ac: AC_TYPES.has(wtype) || "Microsoft.VSTS.Common.AcceptanceCriteria" in f,
    parent: f["System.Parent"],
    iteration: f["System.IterationPath"],
    start: f["Microsoft.VSTS.Scheduling.StartDate"],
    est: f["Microsoft.VSTS.Scheduling.OriginalEstimate"],
    target: f["Microsoft.VSTS.Scheduling.TargetDate"],
    due: f["Microsoft.VSTS.Scheduling.DueDate"],
    tags: f["System.Tags"] || "",
    deps: depsFromRelations(d.relations),
    url: await browserUrl(d.id),
  };
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

// Body shape mirrors the old /api/item PATCH endpoint: friendly aliases
// (title/state/assigned/iteration/desc/ac/priority/estimate/start/target/due).
async function updateItem(wid, body) {
  const fields = {};
  for (const k of ["title","state","assigned","iteration","start","target","due","tags"]) {
    if (k in body) fields[k] = body[k];
  }
  if (fields.assigned === "me") {
    const u = await me();
    if (u) fields.assigned = u;
  }
  if ("priority" in body) fields.priority = body.priority;
  if ("estimate" in body) {
    const v = body.estimate;
    if (v === "") fields.estimate = "";
    else {
      const n = parseFloat(v);
      if (Number.isFinite(n)) fields.estimate = n;
    }
  }
  if ("desc" in body) fields.desc = AdoLib.mdToHtml(body.desc);
  if ("ac" in body) fields.ac = AdoLib.mdToHtml(body.ac);
  if (!Object.keys(fields).length) throw new Error("no fields");
  // ADO REST quirks:
  // 1. op:"add" with an empty value is silently dropped on some fields (e.g.
  //    clearing dates) — use op:"remove" to clear.
  // 2. System.Tags is especially buggy: op:"add" with the new (shorter) list
  //    may MERGE with the existing tags instead of replacing them, so a
  //    deletion appears to succeed but the tag comes back on reopen. The
  //    robust pattern is to remove the field first, then add the new value:
  //    each op is applied sequentially, so the second op writes onto a clean
  //    slate. Same trick handles "clear all" (just the remove).
  const ops = [];
  for (const [k, v] of Object.entries(fields)) {
    const path = `/fields/${resolveField(k)}`;
    if (k === "tags") {
      ops.push({ op: "remove", path });
      if (v !== "" && v != null) ops.push({ op: "add", path, value: v });
    } else if (v === "" || v == null) {
      ops.push({ op: "remove", path });
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
  await req("POST", `${proj}/_apis/wit/workItems/${wid}/comments?api-version=7.1-preview.3`, { text });
  return { ok: true };
}

// Existing comments on an item (newest first). Comment bodies are HTML → text.
async function comments(wid) {
  const proj = await projUrl();
  try {
    const r = await req("GET", `${proj}/_apis/wit/workItems/${wid}/comments?api-version=7.1-preview.3&$top=200`);
    return (r.comments || [])
      .map(c => ({ text: htmlToText(c.text), by: ((c.createdBy || {}).displayName) || "", date: c.createdDate || c.modifiedDate || "" }))
      .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  } catch (_) { return []; }
}

// Field-change history (newest first), derived from the revision updates we
// already fetch for time-in-state. Each entry: {by, date, changes:[{field,from,to}]}.
const HISTORY_FIELDS = {
  "System.State": "State", "System.AssignedTo": "Assigned", "System.Title": "Title",
  "System.IterationPath": "Sprint", "Microsoft.VSTS.Common.Priority": "Priority",
  "System.Parent": "Parent", "Microsoft.VSTS.Scheduling.TargetDate": "Target",
  "Microsoft.VSTS.Scheduling.OriginalEstimate": "Estimate", "System.Tags": "Tags",
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
  return nodeOf(d);
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
  return { id: r.id, rev: r.rev, parent: (r.fields || {})["System.Parent"] || null };
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
  }), 8);
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

// ---------- exported facade (everything app.js needs) ----------
window.api = {
  // config
  getConfig, setConfig, clearConfig,
  // auth (Microsoft Entra ID OAuth)
  oauthSignIn, signOut, oauthRedirectUri,
  // setup picker (org / project discovery)
  orgs, projects,
  // primitives
  me, iterations, states, workItemTypes, createSprint, updateSprintDates, assignees: getAssignees, tags, browserUrl,
  // work-hours config (active-time window)
  setWorkHours, getWorkHours,
  // list / search / children / parents
  roots: ({ text, order, filters } = {}) => list({ text, order, filters }),
  search: ({ text, order, filters } = {}) => list({ text, order, filters }),
  children: (wid, order) => list({ parent: wid, order }),
  parents, childCounts,
  // graph
  deps,
  // dependency links (create / remove / per-item lookup)
  addDependency, removeDependency, dependencies,
  // item ops
  item, updateItem, comment, comments, history, createItem, deleteItem, setParent,
  // time
  times, timeline,
  // utils
  pool, chunk200,
};

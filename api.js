// ADO REST client + endpoint logic (port of ado_client.py + ado_web.py).
// Runs in the extension page context — talks to dev.azure.com directly.
// PAT is read from chrome.storage.local on every call (cheap, lets settings
// changes take effect without a reload).

const API_VERSION = "api-version=7.1";
const LIST_CAP = 2000;   // max work items a single list() query returns (guards unfiltered queries)

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
const STORE_KEYS = ["pat", "org", "project", "patExpiry"];

async function getConfig() {
  const r = await chrome.storage.local.get(STORE_KEYS);
  return {
    pat: r.pat || "",
    org: r.org || "",
    project: r.project || "",
    patExpiry: r.patExpiry || "",
  };
}
async function setConfig(patch) {
  await chrome.storage.local.set(patch);
}
async function clearConfig() {
  await chrome.storage.local.remove(STORE_KEYS);
}

// ---------- HTTP ----------
function wiqlQuote(v) { return String(v).replace(/'/g, "''"); }
function resolveField(k) { return FIELD_ALIASES[k.toLowerCase()] || k; }

async function authHeader() {
  const { pat } = await getConfig();
  if (!pat) throw new Error("No PAT configured");
  return "Basic " + btoa(":" + pat);
}

async function projUrl() {
  const { org, project } = await getConfig();
  return `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}`;
}

async function orgUrl() {
  const { org } = await getConfig();
  return `https://dev.azure.com/${encodeURIComponent(org)}`;
}

async function req(method, url, body, ctype) {
  const headers = { Authorization: await authHeader() };
  if (body !== undefined) headers["Content-Type"] = ctype || "application/json";
  const resp = await fetch(url, {
    method, headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!resp.ok) {
    // A 401 mid-session means the PAT expired or was revoked. Let the UI react
    // (reopen setup) instead of just spraying errors into the status bar.
    if (resp.status === 401 && typeof window !== "undefined") {
      try { window.dispatchEvent(new CustomEvent("ado-401")); } catch (_) { /* no window */ }
    }
    let detail = await resp.text();
    try { detail = JSON.parse(detail).message || detail; } catch (_) { /* keep raw */ }
    throw new Error(`HTTP ${resp.status}: ${detail.slice(0, 500)}`);
  }
  const text = await resp.text();
  if (!text) return {};
  // ADO sometimes prefixes responses with a UTF-8 BOM; strip it before JSON.parse.
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

// ---------- markdown-lite <-> HTML (mirror of ado_client.py) ----------
function htmlEsc(s) { return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c])); }
function htmlUnesc(s) {
  return String(s)
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"").replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}
function htmlToText(s) {
  if (!s) return "";
  let out = String(s)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/(p|div|ul|ol|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  out = htmlUnesc(out);
  out = out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  return out.trim();
}
function textToHtml(text) {
  if (text == null) return "";
  const lines = String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const stripped = lines[i].replace(/^\s+/, "");
    const bullet = stripped.slice(0, 2);
    if (bullet === "- " || bullet === "* ") {
      const items = [];
      while (i < lines.length) {
        const s = lines[i].replace(/^\s+/, "");
        if (s.slice(0, 2) !== "- " && s.slice(0, 2) !== "* ") break;
        items.push("<li>" + htmlEsc(s.slice(2)) + "</li>");
        i++;
      }
      out.push("<ul>" + items.join("") + "</ul>");
      continue;
    }
    if (lines[i].trim() === "") out.push("<br>");
    else out.push("<div>" + htmlEsc(lines[i]) + "</div>");
    i++;
  }
  return out.join("");
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

// ---------- WIQL filter builder (mirrors _build_clauses in ado_web.py) ----------
function buildClauses(filters) {
  filters = filters || {};
  const clauses = [];
  for (const key of Object.keys(FILTER_FIELDS)) {
    const spec = FILTER_FIELDS[key];
    const f = filters[key] || {};
    const inc = f.in || [], exc = f.not || [];
    const { ref, identity, num, contains } = spec;
    const lit = v => {
      if (num) {
        const n = parseInt(v, 10);
        return Number.isFinite(n) ? String(n) : null;
      }
      return "'" + wiqlQuote(v) + "'";
    };
    // Semicolon-list fields (e.g. System.Tags) can't use IN — each value is a
    // separate CONTAINS, OR-ed for include and AND-ed (NOT CONTAINS) for exclude.
    if (contains) {
      if (inc.length) clauses.push("(" + inc.map(v => `[${ref}] CONTAINS '${wiqlQuote(v)}'`).join(" OR ") + ")");
      if (exc.length) clauses.push("(" + exc.map(v => `[${ref}] NOT CONTAINS '${wiqlQuote(v)}'`).join(" AND ") + ")");
      continue;
    }
    if (inc.length) {
      const parts = [];
      const names = inc.filter(v => !(identity && v === "me"));
      if (identity && inc.includes("me")) parts.push(`[${ref}] = @me`);
      const vals = names.map(lit).filter(x => x !== null);
      if (vals.length) parts.push(`[${ref}] IN (${vals.join(",")})`);
      if (parts.length) clauses.push("(" + parts.join(" OR ") + ")");
    }
    if (exc.length) {
      const parts = [];
      const names = exc.filter(v => !(identity && v === "me"));
      if (identity && exc.includes("me")) parts.push(`[${ref}] <> @me`);
      const vals = names.map(lit).filter(x => x !== null);
      if (vals.length) parts.push(`[${ref}] NOT IN (${vals.join(",")})`);
      if (parts.length) clauses.push("(" + parts.join(" AND ") + ")");
    }
  }
  return clauses;
}

// ---------- core ADO reads ----------
async function wiqlIds(wiql, top) {
  const proj = await projUrl();
  const url = `${proj}/_apis/wit/wiql?${API_VERSION}` + (top ? `&$top=${top|0}` : "");
  const res = await req("POST", url, { query: wiql });
  return (res.workItems || []).map(w => w.id);
}

async function batchFetch(ids, fields) {
  if (!ids.length) return [];
  fields = fields || DEFAULT_FIELDS;
  const byId = {};
  const proj = await projUrl();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const url = `${proj}/_apis/wit/workitems?ids=${chunk.join(",")}&fields=${fields.join(",")}&${API_VERSION}`;
    const res = await req("GET", url);
    for (const w of (res.value || [])) byId[w.id] = w;
  }
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

// Members of all project teams (deduped). Falls back to AssignedTo distinct
// values from recent items if the team API isn't permitted by the PAT scope.
async function assignees() {
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
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const url = `${proj}/_apis/wit/workitems?ids=${chunk.join(",")}&$expand=relations&${API_VERSION}`;
    const res = await req("GET", url);
    for (const w of (res.value || [])) {
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

// ---------- item GET/PATCH/comment/create ----------
async function browserUrl(wid) {
  const { org, project } = await getConfig();
  return `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_workitems/edit/${wid}`;
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
    desc: htmlToText(f["System.Description"]),
    ac: htmlToText(f["Microsoft.VSTS.Common.AcceptanceCriteria"]),
    has_ac: AC_TYPES.has(wtype) || "Microsoft.VSTS.Common.AcceptanceCriteria" in f,
    parent: f["System.Parent"],
    iteration: f["System.IterationPath"],
    start: f["Microsoft.VSTS.Scheduling.StartDate"],
    est: f["Microsoft.VSTS.Scheduling.OriginalEstimate"],
    target: f["Microsoft.VSTS.Scheduling.TargetDate"],
    due: f["Microsoft.VSTS.Scheduling.DueDate"],
    url: await browserUrl(d.id),
  };
}

// Body shape mirrors the old /api/item PATCH endpoint: friendly aliases
// (title/state/assigned/iteration/desc/ac/priority/estimate/start/target/due).
async function updateItem(wid, body) {
  const fields = {};
  for (const k of ["title","state","assigned","iteration","start","target","due"]) {
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
  if ("desc" in body) fields.desc = textToHtml(body.desc);
  if ("ac" in body) fields.ac = textToHtml(body.ac);
  if (!Object.keys(fields).length) throw new Error("no fields");
  const ops = Object.entries(fields).map(([k, v]) => ({
    op: "add", path: `/fields/${resolveField(k)}`, value: v,
  }));
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
const WORK_START = 9, WORK_END = 17;

function parseTs(t) {
  if (!t) return null;
  const d = new Date(t);
  return Number.isFinite(d.valueOf()) ? d : null;
}

// Business-second overlap of [s, e] with Mon-Fri WORK_START..WORK_END after
// shifting both endpoints by `offset` hours (so the team's local-time window
// is applied to a UTC timestamp pair).
function businessSeconds(s, e, offset) {
  if (!s || !e || e <= s) return 0;
  const ms = (offset || 0) * 3600 * 1000;
  const start = new Date(s.getTime() + ms);
  const end = new Date(e.getTime() + ms);
  let total = 0;
  let cur = new Date(start);
  while (cur < end) {
    const day0 = new Date(cur);
    day0.setUTCHours(0, 0, 0, 0);
    if (cur.getUTCDay() !== 0 && cur.getUTCDay() !== 6) {   // Mon-Fri (UTC after shift)
      const a = new Date(Math.max(cur.getTime(), day0.getTime() + WORK_START * 3600 * 1000));
      const b = new Date(Math.min(end.getTime(), day0.getTime() + WORK_END * 3600 * 1000));
      if (b > a) total += (b - a) / 1000;
    }
    cur = new Date(day0.getTime() + 24 * 3600 * 1000);
  }
  return total;
}

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
  // setup picker (org / project discovery)
  orgs, projects,
  // primitives
  me, iterations, states, assignees, tags, browserUrl,
  // list / search / children / parents
  roots: ({ text, order, filters } = {}) => list({ text, order, filters }),
  search: ({ text, order, filters } = {}) => list({ text, order, filters }),
  children: (wid, order) => list({ parent: wid, order }),
  parents,
  // graph
  deps,
  // item ops
  item, updateItem, comment, comments, history, createItem, setParent,
  // time
  times, timeline,
};

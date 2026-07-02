// ADO REST client (split from core/api.js). orgs/projects discovery, deps/parents/childCounts.
// Bare shared scope: loaded in order (core→…→facade) as classic <script> (index.html)
// AND via background.js importScripts. The api.* facade is assembled last in facade.js.
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


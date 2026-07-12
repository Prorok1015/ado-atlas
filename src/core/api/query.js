// ADO REST client (split from core/api.js). WIQL filter builder, batchFetch, list().
// Bare shared scope: loaded in order (core→…→facade) as classic <script> (index.html)
// AND via background.js importScripts. The api.* facade is assembled last in facade.js.
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
  let orderBy = `[${FIELD_REGISTRY.id.ref}]`;
  if (order === "priority") {
    orderBy = `[${FIELD_REGISTRY.priority.ref}], [${FIELD_REGISTRY.id.ref}]`;
  } else if (order === "priority_desc") {
    orderBy = `[${FIELD_REGISTRY.priority.ref}] DESC, [${FIELD_REGISTRY.id.ref}]`;
  } else if (order === "id_desc") {
    orderBy = `[${FIELD_REGISTRY.id.ref}] DESC`;
  } else if (order === "changeddate_desc") {
    orderBy = `[${FIELD_REGISTRY.changeddate.ref}] DESC, [${FIELD_REGISTRY.id.ref}]`;
  } else if (order === "createddate_desc") {
    orderBy = `[${FIELD_REGISTRY.createddate.ref}] DESC, [${FIELD_REGISTRY.id.ref}]`;
  }
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


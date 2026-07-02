// ADO REST client (split from core/api.js). work-hours config, updatesFor/times/timeline, pool, batchUpdate.
// Bare shared scope: loaded in order (core→…→facade) as classic <script> (index.html)
// AND via background.js importScripts. The api.* facade is assembled last in facade.js.
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

// Per-state wall-clock breakdown for one item (the editor's "time in state" row).
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


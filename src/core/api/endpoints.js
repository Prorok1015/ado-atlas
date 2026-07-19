// ADO REST client (split from core/api.js). me/iterations/areas/states/sprints/workItemTypes/field-registry/assignees/identities/tags.
// Bare shared scope: loaded in order (core→…→facade) as classic <script> (index.html)
// AND via background.js importScripts. The api.* facade is assembled last in facade.js.
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
    (r.mail && r.mail.toLowerCase().includes(lq)) ||
    (r.id && r.id.toLowerCase() === lq)
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


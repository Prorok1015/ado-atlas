// ADO REST client (split from core/api.js). browserUrl/item/dependencies + attachments + updateItem/comments/history/create/delete/setParent.
// Bare shared scope: loaded in order (core→…→facade) as classic <script> (index.html)
// AND via background.js importScripts. The api.* facade is assembled last in facade.js.
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
    if (r.rel === "System.LinkTypes.Dependency-Forward") blocks.push(AdoLib.gidMake('ado', tid));
    else if (r.rel === "System.LinkTypes.Dependency-Reverse") blockedBy.push(AdoLib.gidMake('ado', tid));
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
  const pnat = parent != null ? AdoLib.gidNative(parent) : null;
  if (pnat != null) {
    const proj = await projUrl();
    ops.push({
      op: "add", path: "/relations/-",
      value: { rel: "System.LinkTypes.Hierarchy-Reverse", url: `${proj}/_apis/wit/workitems/${pnat}` },
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


// ADO REST client (split from core/api.js). Exported facade: (window||self).api = {…}. MUST load last.
// Bare shared scope: loaded in order (core→…→facade) as classic <script> (index.html)
// AND via background.js importScripts. The api.* facade is assembled last in facade.js.
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

(function () {
  const A = (typeof window !== "undefined" ? window : self).api;
  if (!A || typeof AdoLib === "undefined") return;
  const nid = AdoLib.gidNative;
  const ID_POS = {   // arg positions that are work-item ids
    item:[0], dependencies:[0], updateItem:[0], deleteItem:[0], history:[0],
    comment:[0], comments:[0], updateComment:[0], deleteComment:[0],
    addCommentReaction:[0], removeCommentReaction:[0], commentReactionUsers:[0],
    addAttachmentLink:[0], removeAttachmentLink:[0], browserUrl:[0], timeline:[0],
    children:[0], setParent:[0,1], addDependency:[0,1], removeDependency:[0,1],
  };
  for (const name in ID_POS) { const orig = A[name], pos = ID_POS[name]; if (typeof orig!=="function") continue;
    A[name] = function (...a){ for (const p of pos) if (a[p]!=null) a[p]=nid(a[p]); return orig.apply(this,a); }; }
  for (const name of ["deps","parents","childCounts","times"]) { const orig=A[name]; if (typeof orig!=="function") continue;
    A[name] = function (ids,...r){ return orig.call(this, Array.isArray(ids)?ids.map(nid):ids, ...r); }; }
})();

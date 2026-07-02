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

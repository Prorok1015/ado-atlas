// ADO REST client (split from core/api.js). OAuth (Entra ID PKCE), auth headers, projUrl/orgUrl, req() HTTP wrapper, mapWorkItem.
// Bare shared scope: loaded in order (core→…→facade) as classic <script> (index.html)
// AND via background.js importScripts. The api.* facade is assembled last in facade.js.
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

let inFlightRefreshPromise = null;

// Silent refresh using the stored refresh token (no UI).
function oauthRefresh() {
  if (inFlightRefreshPromise) {
    return inFlightRefreshPromise;
  }
  inFlightRefreshPromise = (async () => {
    try {
      const { oauthClientId, oauthTenant, oauthRefresh } = await getConfig();
      if (!oauthRefresh) throw new Error("Session expired — sign in again");
      const tok = await oauthTokenRequest(oauthTenant, AdoLib.oauthTokenBody({
        client_id: oauthClientId, grant_type: "refresh_token", refresh_token: oauthRefresh, scope: OAUTH_SCOPE,
      }));
      await storeTokens(tok);
    } finally {
      inFlightRefreshPromise = null;
    }
  })();
  return inFlightRefreshPromise;
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

function isRetryableRequest(method, body) {
  const m = (method || "").toUpperCase();
  if (m === "GET" || m === "PUT" || m === "DELETE" || m === "HEAD") {
    return true;
  }
  if (m === "PATCH") {
    if (Array.isArray(body)) {
      return body.some(op => op && op.op === "test" && op.path === "/rev");
    }
    if (typeof body === "string") {
      try {
        const parsed = JSON.parse(body);
        if (Array.isArray(parsed)) {
          return parsed.some(op => op && op.op === "test" && op.path === "/rev");
        }
      } catch (_) {
        return body.includes('"op":"test"') && body.includes('"path":"/rev"');
      }
    }
  }
  return false;
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
      if (attempt < MAX_RETRIES && isRetryableRequest(method, body)) {
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
    if (retryable && attempt < MAX_RETRIES && isRetryableRequest(method, body)) {
      await sleep(retryDelay(resp, attempt));
      continue;
    }
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
  
  let targetField = FIELD_REGISTRY.target.ref;
  if (FIELD_REGISTRY.finish.ref in f) {
    targetField = FIELD_REGISTRY.finish.ref;
  } else if (FIELD_REGISTRY.target.ref in f) {
    targetField = FIELD_REGISTRY.target.ref;
  } else {
    const wtype = f[FIELD_REGISTRY.type.ref];
    if (wtype === "Product Backlog Item") {
      targetField = FIELD_REGISTRY.finish.ref;
    }
  }

  const mapped = {
    id: AdoLib.gidMake('ado', rawItem.id),
    rev: rawItem.rev ?? (f["System.Rev"] ?? ""),
    targetField: targetField
  };

  // Map fields dynamically based on FIELD_REGISTRY
  for (const [key, val] of Object.entries(FIELD_REGISTRY)) {
    if (!val || !val.ref) continue;
    if (key === 'id') continue;
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
      mapped.target = f[targetField] || v || f[FIELD_REGISTRY.due.ref] || "";
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

  if (mapped.parent) {
    const parentId = Number(mapped.parent);
    if (Number.isInteger(parentId) && parentId > 0) {
      mapped.parent = AdoLib.gidMake('ado', parentId);
    } else if (typeof mapped.parent === 'string' && mapped.parent.includes(':')) {
      mapped.parent = mapped.parent;
    } else {
      mapped.parent = null;
    }
  } else {
    mapped.parent = null;
  }
  return mapped;
}

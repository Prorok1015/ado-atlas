// App.cache — centralized, project-scoped data and schema cache manager.
//
// Replaces scattered direct chrome.storage.local calls for data/schema caches
// (snapshot, stateCategories, history, etc.) with a single registry-driven manager.
//
// Contract:
//   get(key, options)        Read cached item from memory or chrome.storage.local. Supports { ttlMs }.
//   set(key, val, options)   Save item to memory and chrome.storage.local with automatic v1:${org}/${project}:${key} scoping.
//   remove(key)              Delete a specific key from active project scope.
//   clearProject()           Purge all cache keys under current org/project scope.
//   clearAll()               Purge all application cache keys across all projects.
//
// Loaded after app/prefs.js and before feature modules.
(function (global) {
  'use strict';
  const g = (typeof window !== 'undefined') ? window : globalThis;
  g.App = g.App || {};

  const memoryCache = new Map();

  async function getScopedKey(key) {
    let org = 'default', project = 'default';
    try {
      const activeProvider = (g.App && g.App.backend) ? g.App.backend.active : null;
      const api = activeProvider || g.api;
      if (api && typeof api.getConfig === 'function') {
        const cfg = await api.getConfig();
        if (cfg) {
          if (cfg.owner && cfg.repo) {
            org = cfg.owner;
            project = cfg.repo;
          } else if (cfg.teamId) {
            org = 'linear';
            project = cfg.teamId;
          } else {
            org = cfg.org || 'default';
            project = cfg.project || 'default';
          }
        }
      }
    } catch (_) {}
    return `v1:${org}/${project}:${key}`;
  }

  const CacheManager = {
    async getScopedKey(key) {
      return getScopedKey(key);
    },

    async get(key, options = {}) {
      if (!key) return null;
      const fullKey = await getScopedKey(key);

      // Check memory cache first
      if (memoryCache.has(fullKey)) {
        const memEntry = memoryCache.get(fullKey);
        if (options.ttlMs && memEntry.ts && (Date.now() - memEntry.ts) > options.ttlMs) {
          memoryCache.delete(fullKey);
        } else {
          return memEntry.val;
        }
      }

      // Read from chrome.storage.local
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        try {
          const res = await chrome.storage.local.get([fullKey]);
          const entry = res[fullKey];
          if (entry && typeof entry === 'object' && 'val' in entry) {
            if (options.ttlMs && entry.ts && (Date.now() - entry.ts) > options.ttlMs) {
              await this.remove(key);
              return null;
            }
            memoryCache.set(fullKey, entry);
            return entry.val;
          }
        } catch (_) {}
      }
      return null;
    },

    async set(key, val, options = {}) {
      if (!key) return;
      const fullKey = await getScopedKey(key);
      const entry = { val, ts: Date.now() };

      memoryCache.set(fullKey, entry);

      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        try {
          await chrome.storage.local.set({ [fullKey]: entry });
        } catch (_) {}
      }
    },

    async remove(key) {
      if (!key) return;
      const fullKey = await getScopedKey(key);
      memoryCache.delete(fullKey);

      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        try {
          await chrome.storage.local.remove([fullKey]);
        } catch (_) {}
      }
    },

    async clearProject() {
      memoryCache.clear();
      let prefix = 'v1:';
      try {
        const api = g.api;
        if (api && typeof api.getConfig === 'function') {
          const cfg = await api.getConfig();
          if (cfg && cfg.org && cfg.project) {
            prefix = `v1:${cfg.org}/${cfg.project}:`;
          }
        }
      } catch (_) {}

      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        try {
          const all = await chrome.storage.local.get(null);
          const keysToRemove = Object.keys(all || {}).filter(k => k.startsWith(prefix) || k.startsWith('snap:') || k.startsWith('state_cat:'));
          if (keysToRemove.length > 0) {
            await chrome.storage.local.remove(keysToRemove);
          }
        } catch (_) {}
      }
    },

    async clearAll() {
      memoryCache.clear();
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        try {
          const all = await chrome.storage.local.get(null);
          const keysToRemove = Object.keys(all || {}).filter(k => k.startsWith('v1:') || k.startsWith('snap:') || k.startsWith('state_cat:') || k.startsWith('ado_hist'));
          if (keysToRemove.length > 0) {
            await chrome.storage.local.remove(keysToRemove);
          }
        } catch (_) {}
      }
    }
  };

  g.App.cache = CacheManager;
})(typeof window !== 'undefined' ? window : globalThis);

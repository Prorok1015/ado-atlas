// Centralized OAuth Configuration Registry for ADO Atlas (#64, #69).
// Store public Application Client IDs here for 1-click OAuth authentication.
// Secrets (PATs, Client Secrets) must NEVER be committed to this public file!

(function (global) {
  'use strict';

  const App = global.App = global.App || {};

  App.OAUTH_CONFIG = {
    github: {
      // Register OAuth App in GitHub → Settings → Developer settings → OAuth Apps
      // Redirect URI: chrome.identity.getRedirectURL()
      clientId: 'YOUR_GITHUB_CLIENT_ID',
    },
    linear: {
      // Register OAuth App in Linear → Settings → API → OAuth Applications
      // Redirect URI: chrome.identity.getRedirectURL()
      clientId: 'YOUR_LINEAR_CLIENT_ID',
    },
    ado: {
      // Register App in Azure Portal → Entra ID → App registrations
      // Redirect URI: chrome.identity.getRedirectURL()
      clientId: 'YOUR_ADO_CLIENT_ID',
      tenant: 'common',
    },
  };
})(typeof window !== 'undefined' ? window : global);

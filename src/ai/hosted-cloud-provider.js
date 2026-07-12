(function (global) {
  'use strict';

  // HostedCloudProvider: the "ADO Atlas Cloud AI" (Pro) provider. Unlike
  // CustomCloudProvider it holds NO API key — requests are routed through the
  // background service worker to the Go backend (/api/ai/prompt), which injects
  // the server-side LLM key and enforces per-license rate limits.
  //
  // STUB (Stage 2): the backend is not live yet, so availability is forced to
  // 'unsupported' (it never becomes the active provider) and the prompt methods
  // throw a friendly "coming soon". Flip BACKEND_LIVE once the Go API ships.

  const BACKEND_LIVE = false;

  class HostedCloudProvider extends global.AIProvider {
    constructor() {
      super('ado-atlas-cloud', 'ADO Atlas Cloud AI (Pro)');
    }

    isSupported() { return true; }

    async getAvailability() {
      if (!BACKEND_LIVE) return 'unsupported';
      const ent = global.EntitlementManager;
      return (ent && ent.isPro && ent.isPro()) ? 'available' : 'unsupported';
    }

    async ensureReady() {
      const ent = global.EntitlementManager;
      if (!ent || !ent.isPro || !ent.isPro()) {
        throw new Error('ADO Atlas Cloud AI requires an active Pro subscription.');
      }
      if (!BACKEND_LIVE) {
        throw new Error('ADO Atlas Cloud AI is coming soon.');
      }
      // Stage 2: no-op — the backend manages the model + key.
    }

    async prompt(systemPrompt, userMessage, options) {
      await this.ensureReady();
      // STUB (Stage 2): route via background `fetchHostedAI` →  Go /api/ai/prompt
      // with { license_key, installation_id, prompt, context }.
      throw new Error('ADO Atlas Cloud AI is coming soon.');
    }

    async promptJSON(systemPrompt, userMessage, schema, options) {
      await this.ensureReady();
      throw new Error('ADO Atlas Cloud AI is coming soon.');
    }
  }

  if (global.aiProviderRegistry) {
    global.aiProviderRegistry.register(new HostedCloudProvider());
  }
  global.HostedCloudProvider = HostedCloudProvider;

})(typeof globalThis !== 'undefined' ? globalThis : window);

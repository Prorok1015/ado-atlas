(function(global) {
  'use strict';

  /**
   * Abstract AIProvider interface / class.
   * Defines the interface that any AI provider (e.g. Chrome Built-in AI, Cloud BYOK) must implement.
   */
  class AIProvider {
    constructor(id, displayName) {
      this.id = id;
      this.displayName = displayName;
      this.maxAllowedValuesLimit = 10; // Default limit for allowed values (e.g. Gemini Nano)
    }

    /**
     * Synchronous check to see if the API is supported in the current environment.
     * @returns {boolean}
     */
    isSupported() {
      return false;
    }

    /**
     * Returns the current readiness / availability state of the model.
     * @returns {Promise<'unsupported'|'downloadable'|'downloading'|'available'>}
     */
    async getAvailability() {
      return 'unsupported';
    }

    /**
     * Prepares the model for execution (e.g. triggers download or does warm-up).
     * For already available models, this is a no-op.
     * @param {function(number): void} [onProgress] - Optional callback returning progress from 0.0 to 1.0.
     * @returns {Promise<void>}
     */
    async ensureReady(onProgress) {
      // Abstract
    }

    /**
     * Submits a plain prompt to the model and returns its string response.
     * @param {string} systemPrompt - System prompt configuration instructions.
     * @param {string} userMessage - User search query or instruction.
     * @param {object} [options] - Options like temperature, signal (for abort).
     * @returns {Promise<string>}
     */
    async prompt(systemPrompt, userMessage, options) {
      throw new Error("AIProvider.prompt() is not implemented");
    }

    /**
     * Submits a prompt and returns structured JSON parsed into an object.
     * @param {string} systemPrompt
     * @param {string} userMessage
     * @param {object} schema - JSON schema target.
     * @param {object} [options]
     * @returns {Promise<any>}
     */
    async promptJSON(systemPrompt, userMessage, schema, options) {
      throw new Error("AIProvider.promptJSON() is not implemented");
    }

    /**
     * Creates a stateful, multi-turn AI session.
     * @param {string} [systemPrompt] - Optional initial system prompt.
     * @param {object} [options] - Initial session options.
     * @returns {Promise<AISession>}
     */
    async createSession(systemPrompt, options) {
      throw new Error("AIProvider.createSession() is not implemented");
    }

    /**
     * Disposes of any active sessions and releases memory.
     */
    dispose() {
      // Abstract
    }
  }

  /**
   * Abstract AISession interface / class for stateful multi-turn conversation.
   */
  class AISession {
    /**
     * Sends a follow-up prompt in the active session.
     * @param {string} userMessage - User search query or instructions.
     * @param {object} [options] - Prompt-specific options (e.g. signal).
     * @returns {Promise<string>}
     */
    async prompt(userMessage, options) {
      throw new Error("AISession.prompt() is not implemented");
    }

    /**
     * Closes the session and frees resources.
     */
    destroy() {
      // Abstract
    }
  }

  global.AISession = AISession;


  /**
   * Registry to manage available AI Providers.
   */
  class AIProviderRegistry {
    constructor() {
      this.providers = [];
      this.listeners = [];
      this.initializedPromise = null;
    }

    /**
     * Register a provider instance.
     * @param {AIProvider} provider 
     */
    register(provider) {
      if (this.providers.some(p => p.id === provider.id)) {
        return; // Already registered
      }
      this.providers.push(provider);
    }

    /**
     * Get all registered providers.
     * @returns {AIProvider[]}
     */
    getAll() {
      return this.providers;
    }

    /**
     * Ensures registry has loaded all custom providers from storage.
     */
    async ensureInitialized() {
      if (this.initializedPromise) return this.initializedPromise;
      this.initializedPromise = this._init();
      return this.initializedPromise;
    }

    async _init() {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        // Filter out legacy custom-cloud provider registered by script tag
        this.providers = this.providers.filter(p => p.id !== 'custom-cloud');

        const data = await chrome.storage.local.get(['ai_custom_providers']);
        let configs = data.ai_custom_providers || [];

        if (configs.length === 0) {
          // Perform legacy config migration
          const legacyData = await chrome.storage.local.get(['ai_custom_config', 'ai_custom_config_gemini', 'ai_custom_config_openai']);
          
          let geminiKey = '';
          let geminiEndpoint = '';
          let geminiModel = 'gemini-3.1-flash-lite';
          
          let openaiKey = '';
          let openaiEndpoint = '';
          let openaiModel = 'gpt-4o-mini';
          
          if (legacyData.ai_custom_config_gemini) {
            geminiKey = legacyData.ai_custom_config_gemini.apiKey || '';
            geminiEndpoint = legacyData.ai_custom_config_gemini.endpoint || '';
            geminiModel = legacyData.ai_custom_config_gemini.modelName || 'gemini-3.1-flash-lite';
          }
          if (legacyData.ai_custom_config_openai) {
            openaiKey = legacyData.ai_custom_config_openai.apiKey || '';
            openaiEndpoint = legacyData.ai_custom_config_openai.endpoint || '';
            openaiModel = legacyData.ai_custom_config_openai.modelName || 'gpt-4o-mini';
          }
          if (legacyData.ai_custom_config) {
            const lc = legacyData.ai_custom_config;
            if (lc.providerType === 'gemini') {
              geminiKey = lc.apiKey || geminiKey;
              geminiEndpoint = lc.endpoint || geminiEndpoint;
              geminiModel = lc.modelName || geminiModel;
            } else if (lc.providerType === 'openai') {
              openaiKey = lc.apiKey || openaiKey;
              openaiEndpoint = lc.endpoint || openaiEndpoint;
              openaiModel = lc.modelName || openaiModel;
            }
          }
          
          configs = [
            {
              id: 'custom-cloud-gemini',
              displayName: 'Gemini Cloud',
              providerType: 'gemini',
              apiKey: geminiKey,
              endpoint: geminiEndpoint,
              modelName: geminiModel,
              isEnabled: true
            },
            {
              id: 'custom-cloud-openai',
              displayName: 'OpenAI GPT',
              providerType: 'openai',
              apiKey: openaiKey,
              endpoint: openaiEndpoint,
              modelName: openaiModel,
              isEnabled: true
            }
          ];
          await chrome.storage.local.set({ ai_custom_providers: configs });
        }

        // Register each custom provider from storage
        for (const config of configs) {
          if (global.CustomCloudProvider) {
            const provider = new global.CustomCloudProvider(config.id, config.displayName, config);
            this.register(provider);
          }
        }
      }
    }

    /**
     * Reload custom providers from storage (e.g. after config changes).
     */
    async reloadCustomProviders() {
      // Keep only built-in Chrome API
      this.providers = this.providers.filter(p => p.id === 'chrome-prompt-api');
      this.initializedPromise = null;
      await this.ensureInitialized();
    }

    /**
     * Returns the active provider (the first supported one with status != 'unsupported').
     * @returns {Promise<AIProvider|null>}
     */
    async getActive() {
      await this.ensureInitialized();
      let preferredId = 'chrome-prompt-api';
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        const data = await chrome.storage.local.get(['ai_selected_provider']);
        if (data.ai_selected_provider) {
          preferredId = data.ai_selected_provider;
        }
      }

      const preferred = this.providers.find(p => p.id === preferredId);
      if (preferred && preferred.isSupported()) {
        const avail = await preferred.getAvailability();
        if (avail !== 'unsupported') {
          return preferred;
        }
      }

      for (const provider of this.providers) {
        if (provider.isSupported()) {
          const avail = await provider.getAvailability();
          if (avail !== 'unsupported') {
            return provider;
          }
        }
      }
      return null;
    }

    /**
     * Gets the best available status across all registered and supported providers.
     * @returns {Promise<'unsupported'|'downloadable'|'downloading'|'available'>}
     */
    async getBestAvailability() {
      await this.ensureInitialized();
      const active = await this.getActive();
      if (active) {
        return await active.getAvailability();
      }
      return 'unsupported';
    }

    /**
     * Subscribes to changes in availability.
     * @param {function(string): void} callback 
     */
    onAvailabilityChange(callback) {
      this.listeners.push(callback);
    }

    /**
     * Fires availability notifications to all subscribers.
     * @param {'unsupported'|'downloadable'|'downloading'|'available'} availability 
     */
    notifyAvailabilityChange(availability) {
      this.listeners.forEach(cb => {
        try {
          cb(availability);
        } catch (e) {
          console.error("Error in availability change listener:", e);
        }
      });
    }

    /**
     * Disposes of all registered providers.
     */
    disposeAll() {
      this.providers.forEach(p => {
        try {
          p.dispose();
        } catch (e) {
          console.error(`Error disposing provider ${p.id}:`, e);
        }
      });
    }
  }

  // Export
  global.AIProvider = AIProvider;
  global.aiProviderRegistry = new AIProviderRegistry();

})(typeof globalThis !== 'undefined' ? globalThis : window);

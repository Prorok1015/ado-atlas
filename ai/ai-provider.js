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
     * Returns the active provider (the first supported one with status != 'unsupported').
     * @returns {Promise<AIProvider|null>}
     */
    async getActive() {
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
      let best = 'unsupported';
      for (const provider of this.providers) {
        if (provider.isSupported()) {
          const avail = await provider.getAvailability();
          if (avail === 'available') {
            return 'available';
          }
          if (avail === 'downloading') {
            best = 'downloading';
          } else if (avail === 'downloadable' && best !== 'downloading') {
            best = 'downloadable';
          }
        }
      }
      return best;
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

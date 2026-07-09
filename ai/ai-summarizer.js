(function(global) {
  'use strict';

  class AISummarizer {
    constructor(registry) {
      this.registry = registry || global.aiProviderRegistry;
    }

    async summarize(description, options = {}) {
      const provider = await this.registry.getActive();
      if (!provider) {
        throw new Error("AI is not available. No active provider found.");
      }

      const systemPrompt = global.SUMMARIZE_SYSTEM_PROMPT || 'Summarize the following work item description in 2-3 concise sentences.';
      return provider.prompt(systemPrompt, description, options);
    }
  }

  global.AISummarizer = AISummarizer;
  global.aiSummarizer = new AISummarizer();

})(typeof globalThis !== 'undefined' ? globalThis : window);

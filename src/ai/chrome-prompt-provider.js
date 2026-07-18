(function(global) {
  'use strict';

  class ChromePromptApiProvider extends global.AIProvider {
    constructor() {
      super('chrome-prompt-api', 'Chrome Built-in AI');
      this.session = null;
    }

    _getLanguageModelAPI() {
      if (globalThis.ai && globalThis.ai.languageModel) {
        return globalThis.ai.languageModel;
      }
      if (globalThis.chrome && globalThis.chrome.aiOriginTrial && globalThis.chrome.aiOriginTrial.languageModel) {
        return globalThis.chrome.aiOriginTrial.languageModel;
      }
      if (globalThis.LanguageModel) {
        return globalThis.LanguageModel;
      }
      return null;
    }

    isSupported() {
      return this._getLanguageModelAPI() !== null;
    }

    async getAvailability() {
      const api = this._getLanguageModelAPI();
      if (!api) return 'unsupported';

      try {
        if (typeof api.capabilities === 'function') {
          const cap = await api.capabilities();
          const avail = cap.available;
          if (avail === 'readily' || avail === 'yes') return 'available';
          if (avail === 'after-download' || avail === 'downloadable') return 'downloadable';
          if (avail === 'downloading') return 'downloading';
          return 'unsupported';
        }
        
        if (typeof api.availability === 'function') {
          const avail = await api.availability();
          if (avail === 'available' || avail === 'readily') return 'available';
          if (avail === 'downloadable' || avail === 'after-download') return 'downloadable';
          if (avail === 'downloading') return 'downloading';
          return 'unsupported';
        }
      } catch (e) {
        console.warn("Failed checking AI availability:", e);
      }
      return 'unsupported';
    }

    async ensureReady(onProgress) {
      if (this.session) return;
      const api = this._getLanguageModelAPI();
      if (!api) throw new Error("Chrome LanguageModel API is not supported in this environment");

      const avail = await this.getAvailability();
      if (avail === 'unsupported') {
        throw new Error("Chrome LanguageModel is unsupported on this device");
      }

      const options = {};
      if (avail === 'downloadable' || avail === 'downloading') {
        if (global.aiProviderRegistry) {
          global.aiProviderRegistry.notifyAvailabilityChange('downloading');
        }
        options.monitor = (m) => {
          m.addEventListener('downloadprogress', (e) => {
            const progress = e.total > 0 ? e.loaded / e.total : 0;
            if (onProgress) onProgress(progress);
          });
        };
      }

      try {
        this.session = await api.create(options);
        if (global.aiProviderRegistry) {
          global.aiProviderRegistry.notifyAvailabilityChange('available');
        }
      } catch (e) {
        if (global.aiProviderRegistry) {
          global.aiProviderRegistry.notifyAvailabilityChange(avail);
        }
        console.error("Failed to create Chrome LanguageModel session:", e);
        throw e;
      }
    }

    async createSession(systemPrompt, options = {}) {
      const api = this._getLanguageModelAPI();
      if (!api) throw new Error("AI provider unsupported");

      try {
        const createOptions = {};
        if (options.signal) {
          createOptions.signal = options.signal;
        }
        const temp = options.temperature !== undefined ? options.temperature : 0.2;
        const topK = options.topK !== undefined ? options.topK : 3;
        createOptions.temperature = temp;
        createOptions.topK = topK;
        
        if (systemPrompt) {
          createOptions.systemPrompt = systemPrompt;
        }

        const session = await api.create(createOptions);

        class ChromeSession extends global.AISession {
          async prompt(userMessage, promptOptions = {}) {
            const opts = {};
            if (promptOptions.signal) {
              opts.signal = promptOptions.signal;
            }
            return await session.prompt(userMessage, opts);
          }

          destroy() {
            if (typeof session.destroy === 'function') {
              session.destroy();
            } else if (typeof session.close === 'function') {
              session.close();
            }
          }
        }

        return new ChromeSession();
      } catch (e) {
        console.error("Failed to create stateful Chrome LanguageModel session:", e);
        throw e;
      }
    }

    async prompt(systemPrompt, userMessage, options = {}) {
      const api = this._getLanguageModelAPI();

      if (!api) throw new Error("AI provider unsupported");

      // For Chrome 131+ Prompt API, passing systemPrompt to create() is the proper way.
      // We create a fresh session for each search query with its custom prompt.
      try {

        const createOptions = {};
        if (options.signal) {
          createOptions.signal = options.signal;
        }
        const temp = options.temperature !== undefined ? options.temperature : 0.2;
        const topK = options.topK !== undefined ? options.topK : 3;
        if (temp !== undefined && topK !== undefined) {
          createOptions.temperature = temp;
          createOptions.topK = topK;
        }
        
        const sessionToUse = await api.create(createOptions);
        
        const promptOptions = {};
        if (options.signal) {
          promptOptions.signal = options.signal;
        }
        if (options.responseConstraint) {
          promptOptions.responseConstraint = options.responseConstraint;
        }
        const isJson = systemPrompt && (systemPrompt.toLowerCase().includes("json") || systemPrompt.toLowerCase().includes("classifier") || systemPrompt.toLowerCase().includes("comma-separated") || systemPrompt.toLowerCase().includes("output only"));
        const fullUserMessage = isJson
          ? `System Instructions:\n${systemPrompt}\n\nUser Query: "${userMessage}"\n\nJSON Filter Response:`
          : `System Instructions:\n${systemPrompt}\n\nUser Query:\n${userMessage}`;
        const result = await sessionToUse.prompt(fullUserMessage, promptOptions);
        
        // Clean up session immediately to avoid memory leaks
        if (typeof sessionToUse.destroy === 'function') {
          sessionToUse.destroy();
        } else if (typeof sessionToUse.close === 'function') {
          sessionToUse.close();
        }

        return result;
      } catch (e) {
        console.error("AI prompt execution failed:", e);
        throw e;
      }
    }

    async promptJSON(systemPrompt, userMessage, schema, options = {}) {
      const augmentedPrompt = systemPrompt + "\n\nRespond ONLY with valid JSON matching this schema:\n" + JSON.stringify(schema);
      const raw = await this.prompt(augmentedPrompt, userMessage, options);
      
      try {
        const extracted = this.extractJSON(raw);
        return JSON.parse(extracted);
      } catch (e) {
        console.warn("Model returned invalid JSON:", e.message);
        console.warn("Raw response from model was:", raw);
        console.warn("Attempting auto-repair...");
        
        const repairPrompt = `You returned invalid JSON. Please correct it to be valid JSON matching the schema. Do not output any conversational text, only valid JSON.\nSchema: ${JSON.stringify(schema)}\nInvalid JSON: ${raw}`;
        
        let repairedRaw = "";
        try {
          repairedRaw = await this.prompt(systemPrompt, repairPrompt, options);
          const repairedExtracted = this.extractJSON(repairedRaw);
          return JSON.parse(repairedExtracted);
        } catch (repairError) {
          console.error("Auto-repair failed. Raw repaired response was:", repairedRaw);
          throw repairError;
        }
      }
    }

    extractJSON(text) {
      if (!text) return "";
      let json = text.trim();
      
      // 1. Try extracting from markdown code block first
      const codeBlockRegex = /```(?:json)?\s*([\s\S]*?)\s*```/i;
      const match = json.match(codeBlockRegex);
      if (match) {
        json = match[1];
      }
      
      json = json.trim();

      // 2. Find first '{' and last '}' to strip any surrounding conversational text
      const firstBrace = json.indexOf('{');
      const lastBrace = json.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        json = json.substring(firstBrace, lastBrace + 1);
      }
      
      json = json.trim();

      // 3. Auto-escape invalid single backslashes in double-quoted string values (e.g. "Project\Sprint 1")
      let repaired = "";
      let inQuote = false;
      for (let i = 0; i < json.length; i++) {
        const char = json[i];
        if (char === '"' && (i === 0 || json[i - 1] !== '\\')) {
          inQuote = !inQuote;
          repaired += char;
          continue;
        }
        if (inQuote && char === '\\') {
          const next = json[i + 1] || "";
          const isEscapedBackslash = next === '\\';
          const isStandardEscape = '"/bfnrt'.includes(next);
          const isUnicodeEscape = next === 'u' && /^[0-9a-fA-F]{4}$/.test(json.substring(i + 2, i + 6));
          
          if (isEscapedBackslash) {
            repaired += '\\\\';
            i++;
          } else if (isStandardEscape || isUnicodeEscape) {
            repaired += '\\';
          } else {
            repaired += '\\\\';
          }
        } else {
          repaired += char;
        }
      }
      
      return repaired;
    }

    dispose() {
      if (this.session) {
        try {
          if (typeof this.session.destroy === 'function') {
            this.session.destroy();
          } else if (typeof this.session.close === 'function') {
            this.session.close();
          }
        } catch (e) {}
        this.session = null;
      }
    }
  }

  // Register in global registry
  if (global.aiProviderRegistry) {
    global.aiProviderRegistry.register(new ChromePromptApiProvider());
  }
  global.ChromePromptApiProvider = ChromePromptApiProvider;
})(typeof globalThis !== 'undefined' ? globalThis : window);

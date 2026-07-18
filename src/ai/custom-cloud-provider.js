(function(global) {
  'use strict';

  class CustomCloudProvider extends global.AIProvider {
    constructor(id = 'custom-cloud', displayName = 'Custom Cloud AI', config = null) {
      super(id, displayName);
      if (config) {
        this.config = {
          providerType: config.providerType || 'gemini', // 'gemini' or 'openai'
          apiKey: config.apiKey || '',
          endpoint: config.endpoint || '',
          modelName: config.modelName || (config.providerType === 'openai' ? 'gpt-4o-mini' : 'gemini-3.1-flash-lite'),
          isEnabled: config.isEnabled !== undefined ? config.isEnabled : false
        };
      } else {
        this.config = {
          providerType: 'gemini', // 'gemini' or 'openai'
          apiKey: '',
          endpoint: '',
          modelName: 'gemini-3.1-flash-lite',
          isEnabled: false
        };
        this.loadConfig();
      }
    }

    async loadConfig() {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        if (this.id === 'custom-cloud') {
          const data = await chrome.storage.local.get(['ai_custom_config']);
          if (data.ai_custom_config) {
            this.config = { ...this.config, ...data.ai_custom_config };
          }
        } else {
          const data = await chrome.storage.local.get(['ai_custom_providers']);
          const providers = data.ai_custom_providers || [];
          const item = providers.find(p => p.id === this.id);
          if (item) {
            this.config = {
              providerType: item.providerType || 'gemini',
              apiKey: item.apiKey || '',
              endpoint: item.endpoint || '',
              modelName: item.modelName || (item.providerType === 'openai' ? 'gpt-4o-mini' : 'gemini-3.1-flash-lite'),
              isEnabled: item.isEnabled !== undefined ? item.isEnabled : false
            };
          }
        }
      }
    }

    async saveConfig(newConfig) {
      this.config = { ...this.config, ...newConfig };
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        // If this provider is part of the custom providers list, update the list
        const data = await chrome.storage.local.get(['ai_custom_providers']);
        const providers = data.ai_custom_providers || [];
        const index = providers.findIndex(p => p.id === this.id);
        if (index !== -1) {
          providers[index] = {
            ...providers[index],
            displayName: this.displayName,
            providerType: this.config.providerType,
            apiKey: this.config.apiKey,
            endpoint: this.config.endpoint,
            modelName: this.config.modelName,
            isEnabled: this.config.isEnabled
          };
          await chrome.storage.local.set({ ai_custom_providers: providers });
        } else {
          // Fallback legacy setting
          await chrome.storage.local.set({ ai_custom_config: this.config });
        }
      }
      if (global.aiProviderRegistry) {
        global.aiProviderRegistry.notifyAvailabilityChange(await this.getAvailability());
      }
    }

    isSupported() {
      return true; // Always supported since it's a web API
    }

    async getAvailability() {
      await this.loadConfig();
      if (this.config.isEnabled && this.config.apiKey) {
        return 'available';
      }
      return 'downloadable'; // We can use 'downloadable' to mean 'needs configuration'
    }

    async ensureReady() {
      await this.loadConfig();
      if (!this.config.apiKey) {
        throw new Error("API key is not configured for Custom Cloud AI provider.");
      }
    }

    async prompt(systemPrompt, userMessage, options = {}) {
      await this.ensureReady();
      const messages = [{ role: 'user', content: userMessage }];
      return await this._callAPI(systemPrompt, messages, options);
    }

    async promptJSON(systemPrompt, userMessage, schema, options = {}) {
      const augmentedPrompt = systemPrompt + "\n\nRespond ONLY with valid JSON matching this schema:\n" + JSON.stringify(schema);
      const raw = await this.prompt(augmentedPrompt, userMessage, options);
      try {
        const extracted = this.extractJSON(raw);
        return JSON.parse(extracted);
      } catch (e) {
        console.warn("Custom Cloud AI returned invalid JSON:", e.message);
        // Fallback or repair
        return JSON.parse(this.extractJSON(raw));
      }
    }

    extractJSON(text) {
      if (!text) return "";
      let json = text.trim();
      const codeBlockRegex = /```(?:json)?\s*([\s\S]*?)\s*```/i;
      const match = json.match(codeBlockRegex);
      if (match) {
        json = match[1];
      }
      json = json.trim();
      const firstBrace = json.indexOf('{');
      const lastBrace = json.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        json = json.substring(firstBrace, lastBrace + 1);
      }
      return json.trim();
    }

    async createSession(systemPrompt, options = {}) {
      await this.ensureReady();
      const provider = this;
      class CustomCloudSession extends global.AISession {
        constructor() {
          super();
          this.messages = [];
        }
        async prompt(userMessage, promptOptions = {}) {
          this.messages.push({ role: 'user', content: userMessage });
          const res = await provider._callAPI(systemPrompt, this.messages, { ...options, ...promptOptions });
          this.messages.push({ role: 'assistant', content: res });
          return res;
        }
        destroy() {
          this.messages = [];
        }
      }
      return new CustomCloudSession();
    }

    async _fetch(url, options) {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        return new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({
            action: 'fetchCloudAI',
            url,
            method: options.method,
            headers: options.headers,
            body: options.body
          }, (response) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            if (!response) {
              reject(new Error("No response received from background script"));
              return;
            }
            if (response.error) {
              reject(new Error(response.error));
              return;
            }
            resolve({
              ok: response.status >= 200 && response.status < 300,
              status: response.status,
              statusText: response.statusText,
              text: async () => response.text,
              json: async () => JSON.parse(response.text)
            });
          });
        });
      } else {
        return fetch(url, options);
      }
    }

    async _callAPI(systemPrompt, messages, options = {}) {
      const type = this.config.providerType;
      const apiKey = this.config.apiKey;
      const model = this.config.modelName;
      const temp = options.temperature !== undefined ? options.temperature : 0.2;

      if (type === 'openai') {
        const url = this.config.endpoint || 'https://api.openai.com/v1/chat/completions';
        const body = {
          model: model,
          messages: [
            { role: 'system', content: systemPrompt },
            ...messages
          ],
          temperature: temp
        };
        const response = await this._fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify(body),
          signal: options.signal
        });
        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`OpenAI API returned status ${response.status}: ${errText}`);
        }
        const resJson = await response.json();
        return resJson.choices[0].message.content;
      } else {
        // gemini
        let baseUrl = this.config.endpoint || 'https://generativelanguage.googleapis.com';
        if (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);
        const url = `${baseUrl}/v1/models/${model}:generateContent`;
        
        const contents = [];
        if (systemPrompt) {
          contents.push({
            role: 'user',
            parts: [{ text: `SYSTEM INSTRUCTIONS:\n${systemPrompt}` }]
          });
          contents.push({
            role: 'model',
            parts: [{ text: "Understood. I will strictly follow these system instructions and format my filters accordingly." }]
          });
        }

        contents.push(...messages.map(m => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }]
        })));

        const body = {
          contents: contents,
          generationConfig: {
            temperature: temp
          }
        };

        const response = await this._fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey
          },
          body: JSON.stringify(body),
          signal: options.signal
        });
        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Gemini API returned status ${response.status}: ${errText}`);
        }
        const resJson = await response.json();
        if (!resJson.candidates || !resJson.candidates[0] || !resJson.candidates[0].content) {
          throw new Error("Gemini API returned empty response candidates. Check API key/model permissions.");
        }
        return resJson.candidates[0].content.parts[0].text;
      }
    }
  }

  if (global.aiProviderRegistry) {
    global.aiProviderRegistry.register(new CustomCloudProvider());
  }
  global.CustomCloudProvider = CustomCloudProvider;

})(typeof globalThis !== 'undefined' ? globalThis : window);

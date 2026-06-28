(function(global) {
  'use strict';

  class AIUnavailableError extends Error {
    constructor(message = "Built-in AI is not available. Please make sure you are using Chrome 131+ and have enabled on-device AI flags.") {
      super(message);
      this.name = "AIUnavailableError";
    }
  }

  class AISearchService {
    constructor(registry) {
      this.registry = registry || global.aiProviderRegistry;
    }

    /**
     * Converts a natural language query into a validated FilterIR structure.
     * @param {string} userQuery
     * @param {object} [options]
     * @returns {Promise<{ ir: object, warnings: string[] }>}
     */
    async search(userQuery, options = {}) {
      const provider = await this.registry.getActive();
      if (!provider) {
        throw new AIUnavailableError();
      }

      // 1. Fetch current dynamic fields and team assignees
      let filterFields = [];
      if (window.api && typeof window.api.getFilterFields === 'function') {
        filterFields = window.api.getFilterFields();
      }

      let assignees = [];
      try {
        if (window.api && typeof window.api.assignees === 'function') {
          assignees = await window.api.assignees();
        }
      } catch (e) {
        console.warn("Could not load assignees list for AI prompt:", e);
      }

      // Fetch dynamic iterations, areas and tags to enrich prompt schema
      let iterPaths = [];
      let areaPaths = [];
      let activeTags = [];
      try {
        if (window.api && typeof window.api.iterations === 'function') {
          const iters = await window.api.iterations();
          
          // Determine current iteration based on start/finish dates
          const now = new Date();
          const todayStr = now.toISOString().split('T')[0];
          
          let currentIdx = -1;
          const activeIters = iters.filter(i => i.start && i.finish && i.start <= todayStr && todayStr <= i.finish);
          if (activeIters.length > 0) {
            // Prefer the shortest duration (e.g. Sprint of 2 weeks vs Milestone of 3 months)
            activeIters.sort((a, b) => {
              const durA = new Date(a.finish) - new Date(a.start);
              const durB = new Date(b.finish) - new Date(b.start);
              return durA - durB;
            });
            currentIdx = iters.indexOf(activeIters[0]);
          }
          
          if (currentIdx === -1) {
            currentIdx = iters.findIndex(i => i.start && i.start > todayStr);
            if (currentIdx > 0) currentIdx = currentIdx - 1;
          }

          iterPaths = iters.map((i, idx) => {
            let label = "";
            if (idx === currentIdx) {
              label = "current";
            } else if (idx < currentIdx) {
              label = `current-${currentIdx - idx}`;
            } else if (currentIdx !== -1) {
              label = `current+${idx - currentIdx}`;
            } else {
              label = "future";
            }
            return `${i.path} (${label})`;
          });
        }
        if (window.api && typeof window.api.areas === 'function') {
          const ars = await window.api.areas();
          areaPaths = ars.map(a => a.path);
        }
        if (window.api && typeof window.api.tags === 'function') {
          activeTags = await window.api.tags();
        }
      } catch (e) {
        console.warn("Could not load iteration/area paths or tags for AI prompt:", e);
      }

      // Inject values into fields
      for (const field of filterFields) {
        if (field.id === 'iteration' && iterPaths.length > 0) {
          field.allowedValues = iterPaths;
        } else if (field.id === 'area' && areaPaths.length > 0) {
          field.allowedValues = areaPaths;
        } else if (field.id === 'tags' && activeTags.length > 0) {
          // Keep top 50 active tags for semantic matching in the pipeline
          field.allowedValues = activeTags.slice(0, 50);
        }
      }

      // 2. Select reasoning level dynamically if set to 'auto'
      const selectLevel = options.reasoningLevel || 'auto';
      const targetLevel = selectLevel === 'auto' ? this.determineReasoningLevel(userQuery) : selectLevel;

      let rawIR;
      const warnings = [];

      // Response schema target definition for promptJSON / compilation
      const responseSchema = {
        type: "object",
        properties: {
          where: {
            type: "object",
            properties: {
              logic: { type: "string", enum: ["AND", "OR"] },
              rules: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    field: { type: "string" },
                    op: { type: "string" },
                    value: {}
                  },
                  required: ["field", "op", "value"]
                }
              }
            },
            required: ["logic", "rules"]
          }
        },
        required: ["where"]
      };

      if (targetLevel === 'fast') {
        rawIR = await this.executeFastPipeline(provider, userQuery, filterFields, assignees, responseSchema, options);
      } else if (targetLevel === 'balanced') {
        rawIR = await this.executeBalancedPipeline(provider, userQuery, filterFields, assignees, responseSchema, options);
      } else {
        rawIR = await this.executeThoroughPipeline(provider, userQuery, filterFields, assignees, responseSchema, warnings, options);
      }

      console.log("[AI Search] Raw AI response:", JSON.stringify(rawIR));

      // 5. Enrich and normalize
      const enrichedIR = await this.enrichIR(rawIR, filterFields, warnings);

      console.log("[AI Search] Enriched IR:", JSON.stringify(enrichedIR));

      return {
        ir: { where: enrichedIR },
        warnings
      };
    }

    /**
     * Instantly analyzes the user query to select the optimal reasoning level.
     * Runs in 0ms in JavaScript.
     * @param {string} query 
     * @returns {'fast'|'balanced'|'thorough'}
     */
    determineReasoningLevel(query) {
      const q = query.toLowerCase().trim();
      const wordCount = q.split(/\s+/).length;

      // 1. Detect logical/negation keywords across common developer languages
      // EN: or/not/except, RU: или/не/кроме/либо, ES: o/no/excepto/menos, FR: ou/ne/pas/sauf, DE: oder/nicht/ohne/ausser
      const hasLogicKeywords = /(?<![a-z0-9а-яё])(or|not|except|или|не|кроме|либо|o|no|excepto|menos|ou|pas|sauf|oder|nicht|ohne|ausser)(?![a-z0-9а-яё])/i.test(q) || /[()|&!]/i.test(q);
      if (hasLogicKeywords) return 'thorough';

      // 2. Verify if it is simple English
      const isEnglishASCII = /^[a-z0-9\s.,?!#@_-]+$/i.test(q);
      if (isEnglishASCII) {
        const words = q.replace(/[.,?!#@_-]/g, ' ').split(/\s+/).filter(Boolean);
        const isAllSimpleEnglish = words.every(word => 
          /^[0-9]+$/.test(word) || 
          /^(my|active|closed|assigned|to|me|bug|bugs|task|tasks|feature|features|story|stories|issue|issues|work|item|items|id|ids|tags?|priorit(y|ies)|states?|status|created|changed|by|for)$/i.test(word)
        );

        if (isAllSimpleEnglish) {
          const hasEnglishDateOrSprint = /\b(week|month|year|day|sprint|iteration|today|yesterday)\b/i.test(q);
          if (hasEnglishDateOrSprint) return 'balanced';
          if (wordCount <= 3) return 'fast';
          return 'balanced';
        }
      }

      // 3. Fallback for other languages (Russian, Spanish, German, French, etc.)
      return 'balanced';
    }

    /**
     * Executes the search pipeline in a single stateless AI prompt (Fast mode).
     */
    async executeFastPipeline(provider, query, filterFields, assignees, responseSchema, options) {
      const onProgress = options.onProgress || (() => {});
      onProgress("Analyzing query and generating filters...", 0.2);

      // For the fast 1-pass pipeline, we do a quick textual pre-filtering of tags
      const tagsField = filterFields.find(f => f.id === 'tags');
      if (tagsField && tagsField.allowedValues) {
        const queryLower = query.toLowerCase();
        tagsField.allowedValues = tagsField.allowedValues.filter(tag => {
          const tagLower = tag.toLowerCase();
          if (queryLower.includes(tagLower)) return true;
          if (tagLower === 'backend' && (queryLower.includes('бэкенд') || queryLower.includes('бекэнд'))) return true;
          if (tagLower === 'frontend' && (queryLower.includes('фронтенд') || queryLower.includes('фронтэнд'))) return true;
          if (tagLower === 'database' && (queryLower.includes('база') || queryLower.includes('бд'))) return true;
          return false;
        });
      }

      const maxVals = provider.maxAllowedValuesLimit || 10;
      const schemaStr = filterFields.map(f => {
        let line = `- ${f.id} (type: ${f.type}, name: ${f.displayName}`;
        if (f.allowedValues && f.allowedValues.length > 0) {
          const vals = f.allowedValues.slice(0, maxVals).join(', ');
          line += `, values: ${vals}`;
        }
        line += `)`;
        return line;
      }).join('\n');

      let assigneesContext = "";
      if (assignees && assignees.length > 0) {
        assigneesContext = "\n\nTeam members available for assignment (use these exact names if the user references them):\n" + 
          assignees.map(a => `- ${a}`).join('\n');
      }

      const systemPrompt = global.SEARCH_SYSTEM_PROMPT_TEMPLATE.replace('${fieldsSchema}', schemaStr) + assigneesContext;
      const result = await provider.promptJSON(systemPrompt, query, responseSchema, options);
      onProgress("Applying filters...", 1.0);
      return result;
    }

    /**
     * Executes the search pipeline in 2 stages (Field Selection -> JSON Generation) in a single session.
     */
    async executeBalancedPipeline(provider, query, filterFields, assignees, responseSchema, options) {
      const onProgress = options.onProgress || (() => {});
      
      onProgress("Selecting relevant fields...", 0.1);
      const selectSession = typeof provider.createSession === 'function'
        ? await provider.createSession("You are a field classifier. Output only comma-separated field IDs.", { ...options, temperature: 0.2 })
        : null;

      const promptSession = async (promptText) => {
        if (selectSession) {
          return await selectSession.prompt(promptText, options);
        } else {
          return await provider.prompt("You are a field classifier. Output only comma-separated field IDs.", promptText, options);
        }
      };

      try {
        // Turn 1: Select fields
        const compactFields = filterFields.map(f => `${f.id}: ${f.displayName}`).join(', ');
        const selectPrompt = global.SEARCH_SELECT_FIELDS_PROMPT.replace('${fields_list}', compactFields) + `\n\nQuery: "${query}"\nOutput:`;
        
        const fieldsCSV = await promptSession(selectPrompt);
        
        onProgress("Generating JSON filter...", 0.6);
        // Turn 2: Generate JSON directly from matched schema
        const selectedIds = fieldsCSV.split(',').map(s => s.trim().toLowerCase());
        
        // Semantic tag matching step
        const tagsField = filterFields.find(f => f.id === 'tags');
        if (selectedIds.includes('tags') && tagsField) {
          onProgress("Matching project tags semantically...", 0.35);
          await this._matchTagsSemantically(provider, query, tagsField, options);
        }

        const coreFields = ['type', 'state', 'tags', 'title', 'desc'];
        const matchedFields = filterFields.filter(f => selectedIds.includes(f.id.toLowerCase()) || coreFields.includes(f.id.toLowerCase()));

        const maxVals = provider.maxAllowedValuesLimit || 10;
        const selectedSchemaStr = matchedFields.map(f => {
          let line = `- ${f.id} (type: ${f.type}, name: ${f.displayName}`;
          if (f.allowedValues && f.allowedValues.length > 0) {
            const vals = f.allowedValues.slice(0, maxVals).join(', ');
            line += `, values: ${vals}`;
          }
          line += `)`;
          return line;
        }).join('\n');

        let assigneesContext = "";
        if (assignees && assignees.length > 0) {
          assigneesContext = "\n\nTeam members available for assignment:\n" + 
            assignees.map(a => `- ${a}`).join('\n');
        }

        const directJSONPrompt = global.SEARCH_DIRECT_JSON_PROMPT.replace('${selectedFieldsSchema}', selectedSchemaStr) + assigneesContext + `\n\nUser Query: "${query}"\n\nJSON Filter Response:`;
        const rawJSON = await promptSession(directJSONPrompt);

        const extracted = this.extractJSON(rawJSON);
        const parsed = JSON.parse(extracted);
        onProgress("Applying filters...", 1.0);
        return parsed;
      } finally {
        if (selectSession) selectSession.destroy();
      }
    }

    /**
     * Executes the search pipeline in 3 stages (Field Selection -> Semantic Enrichment -> JSON Compilation)
     * using separate clean AI sessions for each stage to maximize generation accuracy.
     */
    async executeThoroughPipeline(provider, query, filterFields, assignees, responseSchema, warnings, options) {
      const onProgress = options.onProgress || (() => {});

      // 1. Stage 1: Field Selection
      onProgress("Selecting relevant fields...", 0.1);
      const compactFields = filterFields.map(f => `${f.id}: ${f.displayName}`).join(', ');
      const selectPrompt = global.SEARCH_SELECT_FIELDS_PROMPT.replace('${fields_list}', compactFields) + `\n\nQuery: "${query}"\nOutput:`;
      
      const session1 = typeof provider.createSession === 'function'
        ? await provider.createSession("You are a field classifier. Output only comma-separated field IDs.", { temperature: 0.1 })
        : null;

      let fieldsCSV = "";
      try {
        if (session1) {
          fieldsCSV = await session1.prompt(selectPrompt);
        } else {
          fieldsCSV = await provider.prompt("You are a field classifier. Output only comma-separated field IDs.", selectPrompt, options);
        }
      } finally {
        if (session1) session1.destroy();
      }

      const selectedIds = fieldsCSV.split(',').map(s => s.trim().toLowerCase());

      // Semantic tag matching step
      const tagsField = filterFields.find(f => f.id === 'tags');
      if (selectedIds.includes('tags') && tagsField) {
        onProgress("Matching project tags semantically...", 0.25);
        await this._matchTagsSemantically(provider, query, tagsField, options);
      }

      // 2. Stage 2: Intent & Value Enrichment
      onProgress("Enriching query intent & synonyms...", 0.4);
      const coreFields = ['type', 'state', 'tags', 'title', 'desc'];
      const matchedFields = filterFields.filter(f => selectedIds.includes(f.id.toLowerCase()) || coreFields.includes(f.id.toLowerCase()));

      const maxVals = provider.maxAllowedValuesLimit || 10;
      const selectedSchemaStr = matchedFields.map(f => {
        let line = `- ${f.id} (type: ${f.type}, name: ${f.displayName}`;
        if (f.allowedValues && f.allowedValues.length > 0) {
          const vals = f.allowedValues.slice(0, maxVals).join(', ');
          line += `, values: ${vals}`;
        }
        line += `)`;
        return line;
      }).join('\n');

      const enrichPrompt = global.SEARCH_ENRICH_INTENT_PROMPT.replace('${selectedFieldsSchema}', selectedSchemaStr) + `\n\nUser Query: "${query}"\nOutput:`;
      
      const session2 = typeof provider.createSession === 'function'
        ? await provider.createSession("You are a search query enricher. Translate constraints and generate synonyms.", { temperature: 0.4 })
        : null;

      let enrichedIntent = "";
      try {
        if (session2) {
          enrichedIntent = await session2.prompt(enrichPrompt);
        } else {
          enrichedIntent = await provider.prompt("You are a search query enricher. Translate constraints and generate synonyms.", enrichPrompt, options);
        }
      } finally {
        if (session2) session2.destroy();
      }

      // 3. Stage 3: JSON Compilation
      onProgress("Compiling intent to JSON filter...", 0.7);
      const schemaJSON = JSON.stringify(responseSchema);
      const compilePrompt = global.SEARCH_COMPILE_JSON_PROMPT.replace('${schema}', schemaJSON) + `\n\nEnriched Intent:\n${enrichedIntent}\n\nJSON Filter Response:`;
      
      const session3 = typeof provider.createSession === 'function'
        ? await provider.createSession("You are a JSON compiler. Output only valid raw JSON.", { temperature: 0.1 })
        : null;

      let rawJSON = "";
      try {
        if (session3) {
          rawJSON = await session3.prompt(compilePrompt);
        } else {
          rawJSON = await provider.prompt("You are a JSON compiler. Output only valid raw JSON.", compilePrompt, options);
        }
      } finally {
        if (session3) session3.destroy();
      }

      let parsed = null;
      try {
        const extracted = this.extractJSON(rawJSON);
        parsed = JSON.parse(extracted);
      } catch (err) {
        console.warn("Failed to parse thorough JSON compiler output. Raw compiler output:", rawJSON);
        console.warn("Parsing error details:", err.message);
        console.warn("Triggering Turn 4 self-correction...");
        
        onProgress("Self-correcting invalid JSON...", 0.85);
        const session4 = typeof provider.createSession === 'function'
          ? await provider.createSession("You are a JSON repair assistant. Output only valid raw JSON.", { temperature: 0.1 })
          : null;

        try {
          // Turn 4: Self-Correction
          const repairPrompt = `The JSON returned in the previous step is invalid JSON. Please fix it. Output ONLY valid raw JSON.\nError: ${err.message}\nInvalid output:\n${rawJSON}`;
          let repairedJSON = "";
          if (session4) {
            repairedJSON = await session4.prompt(repairPrompt);
          } else {
            repairedJSON = await provider.prompt("You are a JSON repair assistant. Output only valid raw JSON.", repairPrompt, options);
          }
          const extractedRepaired = this.extractJSON(repairedJSON);
          parsed = JSON.parse(extractedRepaired);
        } catch (repairErr) {
          console.error("Thorough pipeline Turn 4 self-correction failed. Raw repaired response:", rawJSON);
          throw repairErr;
        } finally {
          if (session4) session4.destroy();
        }
      }

      onProgress("Applying filters...", 1.0);
      return parsed;
    }

    /**
     * Extracts JSON content from text (strips conversational wrapping and markdown code blocks).
     */
    extractJSON(text) {
      if (!text) return "";
      let json = text.trim();
      
      // 1. Try extracting from markdown code block first
      const codeBlockRegex = /```(?:json)?\s*([\s\S]*?)\s*```/i;
      const match = json.match(codeBlockRegex);
      if (match) {
        json = match[1].trim();
      }

      // 2. Find first '{'
      const firstBrace = json.indexOf('{');
      if (firstBrace === -1) return "";
      
      // Parse from firstBrace onwards, balancing brackets and stopping if stack becomes empty
      let parsedJson = "";
      let stack = [];
      let inQuote = false;
      let quoteChar = "";
      
      for (let i = firstBrace; i < json.length; i++) {
        const char = json[i];
        parsedJson += char;
        
        if (char === '"' || char === "'") {
          if (!inQuote) {
            inQuote = true;
            quoteChar = char;
          } else if (char === quoteChar && json[i - 1] !== '\\') {
            inQuote = false;
          }
          continue;
        }
        
        if (!inQuote) {
          if (char === '{' || char === '[') {
            stack.push(char === '{' ? '}' : ']');
          } else if (char === '}' || char === ']') {
            if (stack.length > 0 && stack[stack.length - 1] === char) {
              stack.pop();
            } else {
              const idx = stack.lastIndexOf(char);
              if (idx !== -1) {
                stack = stack.slice(0, idx);
              }
            }
            
            // If the root '{' has been closed, we are done! Stop parsing to ignore any suffix.
            if (stack.length === 0) {
              break;
            }
          }
        }
      }

      // If the loop finished but the stack isn't empty, it was truncated. Append missing closes.
      while (stack.length > 0) {
        parsedJson += stack.pop();
      }
      
      json = parsedJson;

      // 3. Strip comments (quote-aware)
      let noComments = "";
      let inStr = false;
      quoteChar = "";
      for (let i = 0; i < json.length; i++) {
        const char = json[i];
        if (char === '"' || char === "'") {
          if (!inStr) {
            inStr = true;
            quoteChar = char;
          } else if (char === quoteChar && json[i - 1] !== '\\') {
            inStr = false;
          }
          noComments += char;
          continue;
        }
        if (!inStr) {
          if (char === '/' && json[i + 1] === '/') {
            while (i < json.length && json[i] !== '\n' && json[i] !== '\r') i++;
            continue;
          }
          if (char === '/' && json[i + 1] === '*') {
            i += 2;
            while (i < json.length && !(json[i] === '*' && json[i + 1] === '/')) i++;
            i++;
            continue;
          }
        }
        noComments += char;
      }
      json = noComments;

      // 4. Normalize single quotes to double quotes
      let normalizedQuotes = "";
      let inDoubleQuote = false;
      let inSingleQuote = false;
      for (let i = 0; i < json.length; i++) {
        const char = json[i];
        if (char === '"' && !inSingleQuote) {
          inDoubleQuote = !inDoubleQuote;
          normalizedQuotes += char;
        } else if (char === "'" && !inDoubleQuote) {
          inSingleQuote = !inSingleQuote;
          normalizedQuotes += '"';
        } else if (inSingleQuote && char === '"') {
          normalizedQuotes += '\\"';
        } else {
          normalizedQuotes += char;
        }
      }
      json = normalizedQuotes;

      // 5. Auto-escape invalid single backslashes in double-quoted string values (e.g. "Project\Sprint 1")
      let repairedBackslashes = "";
      inQuote = false;
      for (let i = 0; i < json.length; i++) {
        const char = json[i];
        if (char === '"' && (i === 0 || json[i - 1] !== '\\')) {
          inQuote = !inQuote;
          repairedBackslashes += char;
          continue;
        }
        if (inQuote && char === '\\') {
          const next = json[i + 1] || "";
          const isEscapedBackslash = next === '\\';
          const isStandardEscape = '"/bfnrt'.includes(next);
          const isUnicodeEscape = next === 'u' && /^[0-9a-fA-F]{4}$/.test(json.substring(i + 2, i + 6));
          
          if (isEscapedBackslash) {
            repairedBackslashes += '\\\\';
            i++;
          } else if (isStandardEscape || isUnicodeEscape) {
            repairedBackslashes += '\\';
          } else {
            repairedBackslashes += '\\\\';
          }
        } else {
          repairedBackslashes += char;
        }
      }
      json = repairedBackslashes;

      // 6. Remove trailing commas
      let noTrailingCommas = "";
      inQuote = false;
      for (let i = 0; i < json.length; i++) {
        const char = json[i];
        if (char === '"' && json[i - 1] !== '\\') {
          inQuote = !inQuote;
        }
        if (!inQuote && char === ',') {
          let nextIdx = i + 1;
          while (nextIdx < json.length && /\s/.test(json[nextIdx])) {
            nextIdx++;
          }
          if (json[nextIdx] === '}' || json[nextIdx] === ']') {
            continue;
          }
        }
        noTrailingCommas += char;
      }
      json = noTrailingCommas;

      return json.trim();
    }


    /**
     * Enriches and normalizes the parsed FilterIR.
     * Maps field aliases, validates operators, fuzzy-resolves identity names,
     * and sets required fields like 'kind' and 'id'.
     */
    async enrichIR(rawIR, filterFields, warnings) {
      if (!rawIR || typeof rawIR !== 'object') {
        rawIR = {};
      }

      // Normalize root structure
      let rootGroup = rawIR.where;
      if (!rootGroup || typeof rootGroup !== 'object') {
        rootGroup = { logic: 'AND', rules: [] };
      }

      // Ensure where has kind: 'group'
      rootGroup.kind = 'group';
      rootGroup.id = rootGroup.id || this.generateId();
      rootGroup.logic = (rootGroup.logic || 'AND').toUpperCase();
      if (rootGroup.logic !== 'AND' && rootGroup.logic !== 'OR') {
        rootGroup.logic = 'AND';
      }

      const normalizedRules = [];

      // Helper to generate a unique card ID
      const generateId = () => this.generateId();

      // Process rule list
      const rules = Array.isArray(rootGroup.rules) ? rootGroup.rules : [];

      // We need to format rules into cards (nesting depth 2: Root (OR) -> Card (AND) -> Conditions)
      // Standard Filter Builder structure:
      // where: { kind: 'group', logic: 'OR', rules: [ { kind: 'group', logic: 'AND', rules: [conditions] } ] }
      
      const processCondition = async (cond) => {
        if (!cond || typeof cond !== 'object' || !cond.field) return null;

        const fieldLower = String(cond.field).toLowerCase().trim();
        
        // Match field
        let matchedField = filterFields.find(f => 
          f.id.toLowerCase() === fieldLower || 
          f.displayName.toLowerCase() === fieldLower
        );

        if (!matchedField) {
          // Manual alias lookup
          if (fieldLower === 'status' || fieldLower === 'state' || fieldLower === 'состояние') {
            matchedField = filterFields.find(f => f.id === 'state');
          } else if (fieldLower === 'assignee' || fieldLower === 'assignedto' || fieldLower === 'assigned' || fieldLower === 'исполнитель') {
            matchedField = filterFields.find(f => f.id === 'assigned');
          } else if (fieldLower === 'sprint' || fieldLower === 'iteration' || fieldLower === 'спринт') {
            matchedField = filterFields.find(f => f.id === 'iteration');
          } else if (fieldLower === 'area' || fieldLower === 'area path' || fieldLower === 'область') {
            matchedField = filterFields.find(f => f.id === 'area');
          } else if (fieldLower === 'parent' || fieldLower === 'parentid' || fieldLower === 'родитель') {
            matchedField = filterFields.find(f => f.id === 'parent');
          } else if (fieldLower === 'title' || fieldLower === 'name' || fieldLower === 'название') {
            matchedField = filterFields.find(f => f.id === 'title');
          } else if (fieldLower === 'description' || fieldLower === 'desc' || fieldLower === 'описание') {
            matchedField = filterFields.find(f => f.id === 'desc');
          } else if (fieldLower === 'storypoints' || fieldLower === 'story points' || fieldLower === 'очки') {
            matchedField = filterFields.find(f => f.id === 'storypoints');
          }
        }

        if (!matchedField) {
          warnings.push(`Field "${cond.field}" is not recognized and was skipped.`);
          return null;
        }

        // Validate and normalize value
        let val = cond.value;
        if (val === undefined || val === null) {
          val = "";
        }

        // Normalize date macros (e.g. @currentDate-3m -> @today-90, or object range to string)
        val = this.normalizeValueDateMacros(val);

        // Validate operator
        let op = String(cond.op || '=').toUpperCase().trim();
        // Convert minor operator syntax variants
        if (op === '!=') op = '<>';
        if (op === '==') op = '=';

        // Force RANGE operator if the value is a range string (start...end)
        if (typeof val === 'string' && val.includes('...')) {
          op = 'RANGE';
        }

        if (matchedField.operators && matchedField.operators.length > 0) {
          const isDateField = matchedField.type === 'date' || matchedField.type === 'dateTime';
          if (op === 'RANGE' && isDateField) {
            // Virtual RANGE operator is allowed for dates
          } else if (!matchedField.operators.includes(op)) {
            // Default to first valid operator if the given one is invalid
            op = matchedField.operators[0];
          }
        }

        // Clean relative offset annotations (e.g. "Sprint 1 (current-1)") from tree path fields
        const cleanAnnotation = (v) => {
          if (typeof v === 'string') {
            return v.replace(/\s*\((current|past|future|current[+-]\d+)\)$/i, '').trim();
          }
          if (Array.isArray(v)) {
            return v.map(cleanAnnotation);
          }
          return v;
        };

        if (matchedField.id === 'iteration' || matchedField.id === 'area') {
          val = cleanAnnotation(val);
        }

        // Fuzzy resolve identities
        if (matchedField.type === 'user' || matchedField.id === 'assigned') {
          if (Array.isArray(val)) {
            val = await Promise.all(val.map(v => this.resolveIdentity(v)));
          } else {
            val = await this.resolveIdentity(val);
          }
        }

        // Return standard FilterCondition structure
        return {
          id: cond.id || generateId(),
          kind: 'condition',
          field: matchedField.id,
          op: op,
          value: val
        };
      };

      // Transform raw input rules into standard groups (cards)
      if (rootGroup.logic === 'AND') {
        // Flatten simple AND queries into a single group card under a root OR.
        // If there is a nested OR group, distribute it to multiple AND cards to fit the UI's 2-level nesting limit.
        const conditions = [];
        const nestedOrGroups = [];
        
        for (const rule of rules) {
          if (rule && rule.field) {
            const cond = await processCondition(rule);
            if (cond) conditions.push(cond);
          } else if (rule && rule.rules) {
            if (rule.logic === 'OR') {
              const subConds = [];
              for (const subRule of rule.rules) {
                const cond = await processCondition(subRule);
                if (cond) subConds.push(cond);
              }
              if (subConds.length > 0) {
                nestedOrGroups.push(subConds);
              }
            } else {
              // Nested AND - flatten
              for (const subRule of rule.rules) {
                const cond = await processCondition(subRule);
                if (cond) conditions.push(cond);
              }
            }
          }
        }

        if (nestedOrGroups.length > 0) {
          const cards = [];
          // Distribute the first nested OR group across the base conditions
          const orGroup = nestedOrGroups[0];
          for (const orCond of orGroup) {
            const cardConditions = [
              ...conditions.map(c => ({ ...c, id: generateId() })),
              { ...orCond, id: generateId() }
            ];
            cards.push({
              id: generateId(),
              kind: 'group',
              logic: 'AND',
              rules: cardConditions
            });
          }
          return {
            id: generateId(),
            kind: 'group',
            logic: 'OR',
            rules: cards
          };
        }

        const rootOR = {
          id: generateId(),
          kind: 'group',
          logic: 'OR',
          rules: [
            {
              id: generateId(),
              kind: 'group',
              logic: 'AND',
              rules: conditions
            }
          ]
        };
        return rootOR;
      } else {
        // Root is OR - process as separate AND cards
        const cards = [];
        for (const rule of rules) {
          if (rule && rule.logic && Array.isArray(rule.rules)) {
            const cardConditions = [];
            for (const subRule of rule.rules) {
              const cond = await processCondition(subRule);
              if (cond) cardConditions.push(cond);
            }
            cards.push({
              id: rule.id || generateId(),
              kind: 'group',
              logic: (rule.logic || 'AND').toUpperCase(),
              rules: cardConditions
            });
          } else if (rule && rule.field) {
            // Individual rule directly under OR root - wrap in its own AND card
            const cond = await processCondition(rule);
            if (cond) {
              cards.push({
                id: generateId(),
                kind: 'group',
                logic: 'AND',
                rules: [cond]
              });
            }
          }
        }

        if (cards.length === 0) {
          cards.push({
            id: generateId(),
            kind: 'group',
            logic: 'AND',
            rules: []
          });
        }

        return {
          id: rootGroup.id || generateId(),
          kind: 'group',
          logic: 'OR',
          rules: cards
        };
      }
    }

    /**
     * Resolves the user identity string against the roster.
     */
    async resolveIdentity(value) {
      if (!value || typeof value !== 'string') return value;
      
      const cleanVal = value.trim();
      if (cleanVal.toLowerCase() === 'me' || cleanVal === '@me') {
        return '@me';
      }

      try {
        const assignees = (window.api && typeof window.api.assignees === 'function')
          ? await window.api.assignees()
          : [];
        
        if (assignees && assignees.length > 0) {
          const lval = cleanVal.toLowerCase();
          // 1. Exact match
          let matched = assignees.find(u => u.toLowerCase() === lval);
          if (matched) return matched;
          
          // 2. Starts with / includes
          matched = assignees.find(u => u.toLowerCase().includes(lval));
          if (matched) return matched;
        }
      } catch (e) {
        console.warn("Error fuzzy matching assignee roster:", e);
      }
      return cleanVal;
    }
    async _matchTagsSemantically(provider, query, tagsField, options) {
      if (!tagsField || !tagsField.allowedValues || tagsField.allowedValues.length === 0) {
        return;
      }
      const tagSession = typeof provider.createSession === 'function'
        ? await provider.createSession("You are a tag selection assistant. Select up to 8 relevant tags.", { temperature: 0.1 })
        : null;
      let matchedTagsText = "";
      try {
        const matchPrompt = global.SEARCH_MATCH_TAGS_PROMPT
          .replace(/\${tagsList}/g, tagsField.allowedValues.join(', '))
          .replace(/\${query}/g, query);
        if (tagSession) {
          matchedTagsText = await tagSession.prompt(matchPrompt);
        } else {
          matchedTagsText = await provider.prompt("You are a tag selection assistant. Select up to 8 relevant tags.", matchPrompt, options);
        }
      } catch (e) {
        console.warn("Semantic tag matching failed:", e);
      } finally {
        if (tagSession) tagSession.destroy();
      }
      
      let semanticMatchedTags = [];
      if (matchedTagsText && !matchedTagsText.toLowerCase().includes('none')) {
        const names = matchedTagsText.split(',').map(s => s.trim().toLowerCase());
        semanticMatchedTags = tagsField.allowedValues.filter(tag => names.includes(tag.toLowerCase()));
      }
      console.log("[AI Search] Semantic matched tags:", semanticMatchedTags);
      tagsField.allowedValues = semanticMatchedTags;
    }

    normalizeValueDateMacros(val) {
      if (typeof val === 'string') {
        let s = val.trim();
        if (s.endsWith('...')) {
          s = s + '@today';
        } else if (s.startsWith('...')) {
          s = '@today-365' + s;
        }
        if (s.includes('...')) {
          const parts = s.split('...');
          return parts.map(p => this.normalizeDateMacro(p)).join('...');
        }
        return this.normalizeDateMacro(s);
      }
      if (Array.isArray(val)) {
        return val.map(v => this.normalizeValueDateMacros(v));
      }
      if (val && typeof val === 'object') {
        const min = val.min || val.start;
        const max = val.max || val.end;
        if (min && max) {
          if (typeof min === 'string' && min.includes('...')) {
            return this.normalizeValueDateMacros(min);
          }
          return `${this.normalizeValueDateMacros(min)}...${this.normalizeValueDateMacros(max)}`;
        }
        if (min) return this.normalizeValueDateMacros(min);
        if (max) return this.normalizeValueDateMacros(max);
      }
      return val;
    }

    normalizeDateMacro(value) {
      if (typeof value !== 'string') return value;
      let val = value.trim();

      const match = val.match(/^@(today|currentdate|date)([-+])(\d+)([a-z]*)$/i);
      if (match) {
        const base = match[1].toLowerCase();
        const sign = match[2];
        const num = parseInt(match[3], 10);
        const unit = match[4].toLowerCase();

        let days = num;
        if (unit.startsWith('m')) { // months
          days = num * 30;
        } else if (unit.startsWith('w')) { // weeks
          days = num * 7;
        } else if (unit.startsWith('y')) { // years
          days = num * 365;
        }
        
        return `@today${sign}${days}`;
      }
      return val;
    }

    generateId() {
      return Math.random().toString(36).substring(2, 9);
    }
  }

  // Export
  global.AISearchService = AISearchService;
  global.aiSearchService = new AISearchService();

})(typeof globalThis !== 'undefined' ? globalThis : window);

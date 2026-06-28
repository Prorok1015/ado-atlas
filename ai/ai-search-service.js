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

      let pipelineResult;
      if (targetLevel === 'fast') {
        const raw = await this.executeFastPipeline(provider, userQuery, filterFields, assignees, responseSchema, options);
        pipelineResult = { rawIR: raw, matchedAssignees: [], matchedDates: {} };
      } else if (targetLevel === 'balanced') {
        pipelineResult = await this.executeBalancedPipeline(provider, userQuery, filterFields, assignees, responseSchema, options);
      } else {
        pipelineResult = await this.executeThoroughPipeline(provider, userQuery, filterFields, assignees, responseSchema, warnings, options);
      }

      // 5. Enrich and normalize
      const enrichedIR = await this.enrichIR(pipelineResult.rawIR, filterFields, warnings, {
        matchedAssignees: pipelineResult.matchedAssignees,
        matchedDates: pipelineResult.matchedDates
      });

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
          return queryLower.includes(tagLower);
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
        const selectedIds = fieldsCSV.split(',').map(s => s.trim().toLowerCase());
        
        // Resolving entities (tags/names/dates) in parallel
        onProgress("Resolving entities (tags/names/dates)...", 0.35);

        const parallelTasks = [];
        const tagsField = filterFields.find(f => f.id === 'tags');
        
        if (selectedIds.includes('tags') && tagsField) {
          parallelTasks.push(this._matchTagsSemantically(provider, query, tagsField, options));
        }

        let matchedAssignees = [];
        const identityFields = ['assigned', 'createdby', 'resolvedby', 'closedby'];
        const needsAssignees = selectedIds.some(id => identityFields.includes(id));
        if (needsAssignees && assignees && assignees.length > 0) {
          parallelTasks.push(
            this._matchAssigneesSemantically(provider, query, assignees, options)
              .then(res => matchedAssignees = res)
          );
        }

        let matchedDates = {};
        const dateFields = filterFields.filter(f => f.type === 'date' || f.type === 'dateTime').map(f => f.id);
        if (dateFields.length > 0) {
          parallelTasks.push(
            this._matchDatesSemantically(provider, query, dateFields, options)
              .then(res => matchedDates = res)
          );
        }

        // Run matching tasks simultaneously to save time
        if (parallelTasks.length > 0) {
          await Promise.all(parallelTasks);
        }

        // Add any dynamically resolved date fields to selectedIds
        for (const key of Object.keys(matchedDates)) {
          if (!selectedIds.includes(key)) {
            selectedIds.push(key);
          }
        }

        onProgress("Generating JSON filter...", 0.6);

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

        // Provide resolved context to JSON builder
        let assigneesContext = "";
        const matchedAssigneesList = Object.values(matchedAssignees);
        if (matchedAssigneesList.length > 0) {
          assigneesContext = `\n\nResolved Assignees Context: The user's query references these exact team members: ${JSON.stringify(matchedAssigneesList)}. Use exactly these values in the JSON.`;
        }

        let datesContext = "";
        if (Object.keys(matchedDates).length > 0) {
          datesContext = `\n\nResolved Dates Context: The user's query references these exact date ranges: ${JSON.stringify(matchedDates)}. Use exactly these values in the JSON.`;
        }

        const directJSONPrompt = global.SEARCH_DIRECT_JSON_PROMPT.replace('${selectedFieldsSchema}', selectedSchemaStr) + assigneesContext + datesContext + `\n\nUser Query: "${query}"\n\nJSON Filter Response:`;
        const rawJSON = await promptSession(directJSONPrompt);

        const extracted = this.extractJSON(rawJSON);
        const parsed = JSON.parse(extracted);
        onProgress("Applying filters...", 1.0);
        return { rawIR: parsed, matchedAssignees, matchedDates };
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

      // Resolving entities (tags/names/dates) in parallel
      onProgress("Resolving entities (tags/names/dates)...", 0.25);

      const parallelTasks = [];
      const tagsField = filterFields.find(f => f.id === 'tags');
      
      if (selectedIds.includes('tags') && tagsField) {
        parallelTasks.push(this._matchTagsSemantically(provider, query, tagsField, options));
      }

      let matchedAssignees = [];
      const identityFields = ['assigned', 'createdby', 'resolvedby', 'closedby'];
      const needsAssignees = selectedIds.some(id => identityFields.includes(id));
      if (needsAssignees && assignees && assignees.length > 0) {
        parallelTasks.push(
          this._matchAssigneesSemantically(provider, query, assignees, options)
            .then(res => matchedAssignees = res)
        );
      }

      let matchedDates = {};
      const dateFields = filterFields.filter(f => f.type === 'date' || f.type === 'dateTime').map(f => f.id);
      if (dateFields.length > 0) {
        parallelTasks.push(
          this._matchDatesSemantically(provider, query, dateFields, options)
            .then(res => matchedDates = res)
        );
      }

      // Run matching tasks simultaneously to save time
      if (parallelTasks.length > 0) {
        await Promise.all(parallelTasks);
      }

      // Add any dynamically resolved date fields to selectedIds
      for (const key of Object.keys(matchedDates)) {
        if (!selectedIds.includes(key)) {
          selectedIds.push(key);
        }
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

      // Provide resolved context to JSON builder
      let assigneesContext = "";
      const matchedAssigneesList = Object.values(matchedAssignees);
      if (matchedAssigneesList.length > 0) {
        assigneesContext = `\n\nResolved Assignees Context: The user's query references these exact team members: ${JSON.stringify(matchedAssigneesList)}. Use exactly these values in the JSON.`;
      }

      let datesContext = "";
      if (Object.keys(matchedDates).length > 0) {
        datesContext = `\n\nResolved Dates Context: The user's query references these exact date ranges: ${JSON.stringify(matchedDates)}. Use exactly these values in the JSON.`;
      }

      const enrichPrompt = global.SEARCH_ENRICH_INTENT_PROMPT.replace('${selectedFieldsSchema}', selectedSchemaStr) + assigneesContext + datesContext + `\n\nUser Query: "${query}"\nOutput:`;
      
      const session2 = typeof provider.createSession === 'function'
        ? await provider.createSession("You are a search query enricher. Translate constraints and generate synonyms." + assigneesContext, { temperature: 0.4 })
        : null;

      let enrichedIntent = "";
      try {
        if (session2) {
          enrichedIntent = await session2.prompt(enrichPrompt);
        } else {
          enrichedIntent = await provider.prompt("You are a search query enricher. Translate constraints and generate synonyms." + assigneesContext, enrichPrompt, options);
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
      return { rawIR: parsed, matchedAssignees, matchedDates };
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

      // 2. Find first '{' or '['
      const firstBrace = json.indexOf('{');
      const firstBracket = json.indexOf('[');
      let startIndex = -1;
      
      if (firstBrace !== -1 && firstBracket !== -1) {
          startIndex = Math.min(firstBrace, firstBracket);
      } else if (firstBrace !== -1) {
          startIndex = firstBrace;
      } else if (firstBracket !== -1) {
          startIndex = firstBracket;
      }

      if (startIndex === -1) {
          // Fallback: If no brackets exist, return the sanitized string safely.
          return json; 
      }
      
      // 3. Parse from startIndex onwards, balancing brackets and closing truncated strings
      let parsedJson = "";
      let stack = [];
      let inQuote = false;
      let quoteChar = "";
      let isEscaped = false;
      
      for (let i = startIndex; i < json.length; i++) {
        const char = json[i];
        parsedJson += char;
        
        if (isEscaped) {
            isEscaped = false;
            continue;
        }
        
        if (char === '\\') {
            isEscaped = true;
            continue;
        }
        
        if (char === '"' || char === "'") {
          if (!inQuote) {
            inQuote = true;
            quoteChar = char;
          } else if (char === quoteChar) {
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
            
            // If the root '{' or '[' has been closed, we are done!
            if (stack.length === 0) {
              break;
            }
          }
        }
      }

      // [FIX]: If AI truncated the response while inside a string, close the quote first!
      if (inQuote) {
        parsedJson += quoteChar;
      }

      // If the loop finished but the stack isn't empty, it was truncated. Append missing closes.
      while (stack.length > 0) {
        parsedJson += stack.pop();
      }
      
      json = parsedJson;

      // 4. Strip comments (quote-aware)
      let noComments = "";
      let inStr = false;
      quoteChar = "";
      isEscaped = false;
      for (let i = 0; i < json.length; i++) {
        const char = json[i];
        
        if (isEscaped) {
            noComments += char;
            isEscaped = false;
            continue;
        }
        if (char === '\\') {
            noComments += char;
            isEscaped = true;
            continue;
        }

        if (char === '"' || char === "'") {
          if (!inStr) {
            inStr = true;
            quoteChar = char;
          } else if (char === quoteChar) {
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

      // 5. Normalize single quotes to double quotes
      let normalizedQuotes = "";
      let inDoubleQuote = false;
      let inSingleQuote = false;
      isEscaped = false;
      for (let i = 0; i < json.length; i++) {
        const char = json[i];
        
        if (isEscaped) {
            normalizedQuotes += char;
            isEscaped = false;
            continue;
        }
        if (char === '\\') {
            normalizedQuotes += char;
            isEscaped = true;
            continue;
        }

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

      // 6. Remove trailing commas
      let noTrailingCommas = "";
      inQuote = false;
      isEscaped = false;
      for (let i = 0; i < json.length; i++) {
        const char = json[i];
        
        if (isEscaped) {
            noTrailingCommas += char;
            isEscaped = false;
            continue;
        }
        if (char === '\\') {
            noTrailingCommas += char;
            isEscaped = true;
            continue;
        }

        if (char === '"') {
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
    async enrichIR(rawIR, filterFields, warnings, options = {}) {
      if (!rawIR || typeof rawIR !== 'object') {
        rawIR = {};
      }

      // Normalize root structure
      let rootGroup = rawIR.where;
      if (!rootGroup && Array.isArray(rawIR.filters)) {
        // Fallback for hallucinated "filters" array format from SLMs (like Gemini Nano)
        rootGroup = {
          logic: 'AND',
          rules: rawIR.filters.map(f => {
            if (!f || typeof f !== 'object') return null;
            const keys = Object.keys(f);
            const fieldKey = keys.find(k => k !== 'operator' && k !== 'op' && k !== 'value');
            if (fieldKey) {
              const valObj = f[fieldKey];
              if (valObj && typeof valObj === 'object' && !Array.isArray(valObj)) {
                return {
                  field: fieldKey,
                  op: valObj.operator || valObj.op || '=',
                  value: valObj.value
                };
              }
              return {
                field: fieldKey,
                op: f.operator || f.op || '=',
                value: f.value !== undefined ? f.value : f[fieldKey]
              };
            }
            return null;
          }).filter(Boolean)
        };
      }
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

      const matchedAssignees = options.matchedAssignees || [];
      const matchedDates = options.matchedDates || {};
      let rules = Array.isArray(rootGroup.rules) ? rootGroup.rules : [];

      // Apply matched dates from context if available (forces 100% accurate date values and RANGE operator)
      if (matchedDates && Object.keys(matchedDates).length > 0) {
        for (const key of Object.keys(matchedDates)) {
          const dateVal = matchedDates[key];
          const dateRules = rules.filter(r => r.field && r.field.toLowerCase() === key.toLowerCase());
          if (dateRules.length > 0) {
            const firstRule = dateRules[0];
            firstRule.op = dateVal.includes('...') ? 'RANGE' : '=';
            firstRule.value = dateVal;
            for (let i = 1; i < dateRules.length; i++) {
              dateRules[i]._remove = true;
            }
          } else {
            rules.push({
              field: key,
              op: dateVal.includes('...') ? 'RANGE' : '=',
              value: dateVal
            });
          }
        }
        rules = rules.filter(r => !r._remove);
        rootGroup.rules = rules;
      }

      const normalizedRules = [];

      // Helper to generate a unique card ID
      const generateId = () => this.generateId();

      // Process rule list

      const processCondition = async (cond) => {
        if (!cond || typeof cond !== 'object' || !cond.field) return null;

        const fieldLower = String(cond.field).toLowerCase().trim();
        
        // Match field
        let matchedField = filterFields.find(f => 
          (f.id && f.id.toLowerCase() === fieldLower) || 
          (f.displayName && f.displayName.toLowerCase() === fieldLower)
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

        // Force IN operator if value is an array, prevent syntax errors in UI
        if (Array.isArray(val) && op !== 'IN' && op !== 'NOT IN' && op !== 'CONTAINS' && op !== 'NOT CONTAINS') {
            op = 'IN'; 
        }

        // Enforce array format for IN / NOT IN operators
        if ((op === 'IN' || op === 'NOT IN') && !Array.isArray(val)) {
            val = [val];
        }

        // Simplify single-item array in IN to EQUAL operator
        if (Array.isArray(val) && val.length === 1 && op === 'IN') {
            op = '=';
            val = val[0];
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

        const resolveFullPath = (shortVal, fullPaths) => {
          if (typeof shortVal !== 'string' || !fullPaths || fullPaths.length === 0) return shortVal;
          const valLower = shortVal.toLowerCase().trim();
          if (valLower.includes('\\')) return shortVal;
          
          const matched = fullPaths.find(p => p.toLowerCase().endsWith('\\' + valLower) || p.toLowerCase() === valLower);
          return matched ? matched : shortVal;
        };

        const resolveAllowedValue = (v, allowed) => {
          if (typeof v !== 'string' || !allowed || allowed.length === 0) return v;
          const cleanVal = v.toLowerCase().trim();
          
          let matched = allowed.find(a => a.toLowerCase() === cleanVal);
          if (matched) return matched;
          
          matched = allowed.find(a => a.toLowerCase().includes(cleanVal) || cleanVal.includes(a.toLowerCase()));
          if (matched) return matched;
          
          return v;
        };

        if (matchedField.id === 'iteration') {
          val = cleanAnnotation(val);
          if (matchedField.allowedValues) {
            if (Array.isArray(val)) {
              val = val.map(v => resolveFullPath(v, matchedField.allowedValues));
            } else {
              val = resolveFullPath(val, matchedField.allowedValues);
            }
          }
        } else if (matchedField.id === 'area') {
          val = cleanAnnotation(val);
          if (matchedField.allowedValues) {
            if (Array.isArray(val)) {
              val = val.map(v => resolveFullPath(v, matchedField.allowedValues));
            } else {
              val = resolveFullPath(val, matchedField.allowedValues);
            }
          }
        }

        // Fuzzy resolve values for closed lists (e.g. type, state)
        if (matchedField.allowedValues && matchedField.allowedValues.length > 0 && 
            matchedField.id !== 'iteration' && matchedField.id !== 'area' && 
            matchedField.id !== 'tags' && matchedField.id !== 'assigned') {
          if (Array.isArray(val)) {
            val = val.map(v => resolveAllowedValue(v, matchedField.allowedValues));
          } else {
            val = resolveAllowedValue(val, matchedField.allowedValues);
          }
        }

        // Fuzzy resolve identities
        if (matchedField.type === 'user' || matchedField.id === 'assigned') {
          const valArray = Array.isArray(val) ? val : [val];
          
          let resolvedArray = (await Promise.all(valArray.map(v => this.resolveIdentity(v, matchedAssignees)))).flat();
          
          // Identify unresolved items (i.e. those that are not @me and not in matchedAssignees list)
          const matchedAssigneesList = Object.values(matchedAssignees).flat();
          const unresolvedIdxs = [];
          for (let i = 0; i < resolvedArray.length; i++) {
            const item = resolvedArray[i];
            if (item !== '@me' && !matchedAssigneesList.includes(item)) {
              unresolvedIdxs.push(i);
            }
          }
          
          // Find matchedAssignees that were NOT matched by any of the resolved items
          const unmatchedAssignees = matchedAssigneesList.filter(u => !resolvedArray.includes(u));
          
          // Map unresolved values to unmatched assignees by relative order of appearance (index-based)
          for (let k = 0; k < Math.min(unresolvedIdxs.length, unmatchedAssignees.length); k++) {
            resolvedArray[unresolvedIdxs[k]] = unmatchedAssignees[k];
          }
          
           const finalResolved = resolvedArray.filter(Boolean);
          if (finalResolved.length > 1) {
            val = finalResolved;
            op = 'IN';
          } else if (finalResolved.length === 1) {
            val = finalResolved[0];
            if (op === 'IN') {
              op = '='; // Simplify back to equals if only one matched
            }
          } else {
            val = cond.value;
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
    async resolveIdentity(value, matchedAssignees = {}) {
      if (!value || typeof value !== 'string') return value;
      
      const cleanVal = value.trim();
      const lval = cleanVal.toLowerCase();
      if (lval === 'me' || lval === '@me') {
        return '@me';
      }

      // 1. Try matching against matchedAssignees keys (case-insensitive)
      if (matchedAssignees && typeof matchedAssignees === 'object') {
        const matchedKey = Object.keys(matchedAssignees).find(k => 
          k.toLowerCase() === lval || 
          lval.includes(k.toLowerCase()) || 
          k.toLowerCase().includes(lval)
        );
        if (matchedKey) {
          return matchedAssignees[matchedKey];
        }
      }

      try {
        const assignees = (window.api && typeof window.api.assignees === 'function')
          ? await window.api.assignees()
          : [];
        
        if (assignees && assignees.length > 0) {
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

    /**
     * Extracts exact matching tags from the query using AI.
     */
    async _matchTagsSemantically(provider, query, tagsField, options) {
      if (!tagsField || !tagsField.allowedValues || tagsField.allowedValues.length === 0) {
        return;
      }
      const tagSession = typeof provider.createSession === 'function'
        ? await provider.createSession("You are a tag selection assistant. Select up to 15 relevant tags and output JSON array.", { temperature: 0.1 })
        : null;
      let matchedTagsText = "";
      try {
        const matchPrompt = global.SEARCH_MATCH_TAGS_PROMPT
          .replace(/\${tagsList}/g, tagsField.allowedValues.join(', '))
          .replace(/\${query}/g, query);
        if (tagSession) {
          matchedTagsText = await tagSession.prompt(matchPrompt);
        } else {
          matchedTagsText = await provider.prompt("You are a tag selection assistant. Select up to 15 relevant tags and output JSON array.", matchPrompt, options);
        }
      } catch (e) {
        console.warn("Semantic tag matching failed:", e);
      } finally {
        if (tagSession) tagSession.destroy();
      }
      
      let semanticMatchedTags = [];
      if (matchedTagsText) {
          try {
              // Re-use robust extractJSON method to get the array
              const jsonStr = this.extractJSON(matchedTagsText);
              const names = JSON.parse(jsonStr);
              if (Array.isArray(names)) {
                 const lowerNames = names.map(s => String(s).trim().toLowerCase());
                 semanticMatchedTags = tagsField.allowedValues.filter(tag => lowerNames.includes(tag.toLowerCase()));
              }
          } catch(err) {
              console.warn("Failed to parse tags JSON, falling back to string matching", err);
              // Fallback to old comma logic if model failed to output JSON
              const names = matchedTagsText.split(',').map(s => s.trim().toLowerCase());
              semanticMatchedTags = tagsField.allowedValues.filter(tag => names.includes(tag.toLowerCase()));
          }
      }
      if (semanticMatchedTags.length > 0) {
        tagsField.allowedValues = semanticMatchedTags;
      }
    }

    /**
     * Extracts exact matching assignee names from the query using AI.
     */
    async _matchAssigneesSemantically(provider, query, assignees, options) {
      if (!assignees || assignees.length === 0) {
        return {};
      }
      
      const session = typeof provider.createSession === 'function'
        ? await provider.createSession("You are an entity resolution assistant. Output ONLY a valid JSON object mapping query references to roster names.", { temperature: 0.1 })
        : null;
        
      let matchedText = "";
      try {
        const matchPrompt = global.SEARCH_MATCH_ASSIGNEES_PROMPT
          .replace(/\${assigneesList}/g, assignees.join(', '))
          .replace(/\${query}/g, query);
        
        if (session) {
          matchedText = await session.prompt(matchPrompt);
        } else {
          matchedText = await provider.prompt("You are an entity resolution assistant. Output ONLY a valid JSON object mapping query references to roster names.", matchPrompt, options);
        }
      } catch (e) {
        console.warn("Semantic assignees matching failed:", e);
      } finally {
        if (session) session.destroy();
      }
      
      let matchedAssigneesMap = {};
      if (matchedText) {
        try {
          const jsonStr = this.extractJSON(matchedText);
          const parsed = JSON.parse(jsonStr);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const lowerRoster = assignees.map(a => a.toLowerCase());
            for (const key of Object.keys(parsed)) {
              const val = parsed[key];
              if (val === '@me' || lowerRoster.includes(String(val).toLowerCase().trim())) {
                const exact = val === '@me' ? val : assignees.find(a => a.toLowerCase() === String(val).toLowerCase().trim());
                matchedAssigneesMap[key] = exact || val;
              }
            }
          }
        } catch (err) {
          console.warn("Failed to parse assignees JSON object", err);
        }
      }
      return matchedAssigneesMap;
    }

    /**
     * Extracts exact matching date ranges from the query using AI.
     */
    async _matchDatesSemantically(provider, query, dateFields, options) {
      if (!dateFields || dateFields.length === 0) {
        return {};
      }
      
      const session = typeof provider.createSession === 'function'
        ? await provider.createSession("You are a date extraction assistant. Output ONLY a valid JSON object.", { temperature: 0.1 })
        : null;
        
      let matchedText = "";
      try {
        const matchPrompt = global.SEARCH_MATCH_DATES_PROMPT
          .replace(/\${dateFields}/g, dateFields.join(', '))
          .replace(/\${query}/g, query);
        
        if (session) {
          matchedText = await session.prompt(matchPrompt);
        } else {
          matchedText = await provider.prompt("You are a date extraction assistant. Output ONLY a valid JSON object.", matchPrompt, options);
        }
      } catch (e) {
        console.warn("Semantic dates matching failed:", e);
      } finally {
        if (session) session.destroy();
      }
      
      let matchedDates = {};
      if (matchedText) {
        try {
          const jsonStr = this.extractJSON(matchedText);
          const parsed = JSON.parse(jsonStr);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
             const dateFieldsLower = dateFields.map(f => f.toLowerCase());
             for (const key of Object.keys(parsed)) {
               if (dateFieldsLower.includes(key.toLowerCase())) {
                 matchedDates[key.toLowerCase()] = parsed[key];
               }
             }
          }
        } catch (err) {
          console.warn("Failed to parse dates JSON", err);
        }
      }
      return matchedDates;
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

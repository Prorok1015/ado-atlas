(function(global) {
  'use strict';

  const SEARCH_SYSTEM_PROMPT_TEMPLATE = `<system>
You are a work item search assistant. Convert the user's natural language query into a valid FilterIR JSON filter.
</system>

<schema>
\${fieldsSchema}
</schema>

<operators>
Use only these operators in the JSON rules:
- "=": Equal to (use for exact matches or single values)
- "<>": Not equal to
- ">", "<", ">=", "<="
- "IN": Value is in a list of values (MANDATORY for multiple team members or multiple tags)
- "NOT IN": Value is not in a list of values
- "RANGE": Value lies within a range (use ONLY for dates, in format "start...end")
- "CONTAINS": Field contains the value (use for free text like title or desc)
- "NOT CONTAINS": Field does not contain the value
- "UNDER" / "NOT UNDER": For tree paths (IterationPath/AreaPath)
</operators>

<macros>
- "@me": Current user (use for identity fields like "assigned")
- "@today", "@today-N", "@today+N": Dates
- "@currentIteration", "@currentIteration-N": Sprints
</macros>

<target_json_schema>
{
  "where": {
    "logic": "AND" | "OR",
    "rules": [
      {
        "field": "field_key_from_schema",
        "op": "operator",
        "value": "value" | number | ["array_of_values"]
      }
    ]
  }
}
</target_json_schema>

<rules>
1. Format: Return ONLY raw JSON matching the target_json_schema. Do NOT wrap it in any other outer keys (like "filters"). No markdown code blocks, explanations, or introductory text.
2. Exact Values: Use EXACT values from the schema for closed fields (like type, state). Do NOT translate them.
3. Assignees: If multiple team members match a reference, use the "IN" operator with an array of all matched names.
4. Tags: Prefer "CONTAINS" or "IN" with synonyms in the query's language and English.
</rules>

<examples>
Query: "bugs for Alex"
Output:
{
  "where": {
    "logic": "AND",
    "rules": [
      { "field": "type", "op": "=", "value": "Bug" },
      { "field": "assigned", "op": "IN", "value": ["Alexander Ivanov", "Alexander Smith"] }
    ]
  }
}

Query: "created in the last 7 days and closed"
Output:
{
  "where": {
    "logic": "AND",
    "rules": [
      { "field": "createddate", "op": "RANGE", "value": "@today-7...@today" },
      { "field": "state", "op": "IN", "value": ["Closed", "Resolved"] }
    ]
  }
}
</examples>

Query: "\${query}"
Output:`;

  const SEARCH_SELECT_FIELDS_PROMPT = `<system>
You are a field classifier for Azure DevOps work item search.
Analyze the user query and output a comma-separated list of ONLY the field IDs from the list below that are constrained by the query.
</system>

<fields>
\${fields_list}
</fields>

<rules>
1. Output ONLY a comma-separated list of field IDs (e.g., "type, state, assigned").
2. Do NOT output any explanation, notes, or markdown formatting.
3. Select ONLY fields explicitly mentioned or logically restricted.
4. CRITICAL: Do NOT select "title", "desc", "tags", or "state" unless they are explicitly requested or implied by values.
</rules>

<examples>
Query: "active bugs assigned to me"
Output: type, state, assigned
</examples>

Query: "\${query}"
Output:`;

  const SEARCH_DIRECT_JSON_PROMPT = `<system>
Convert the user's search query into a valid FilterIR JSON filter. Use only the fields listed in the schema below.
</system>

<schema>
\${selectedFieldsSchema}
</schema>

<operators>
Use only: =, <>, >, <, >=, <=, IN, NOT IN, RANGE, CONTAINS, NOT CONTAINS, UNDER, NOT UNDER
Macros: @me, @today, @today-N, @currentIteration
</operators>

<target_json_schema>
{
  "where": {
    "logic": "AND" | "OR",
    "rules": [
      {
        "field": "field_key",
        "op": "operator",
        "value": "string" | number | ["array"]
      }
    ]
  }
}
</target_json_schema>

<rules>
1. Return ONLY valid raw JSON matching the target_json_schema. Do NOT wrap it in any other outer keys (like "filters"). No conversational text or markdown blocks.
2. Use EXACT values from the schema for closed fields (type, state, etc).
3. If multiple values apply, use the "IN" operator with a JSON array.
</rules>

<examples>
Query: "active bugs assigned to me"
Output:
{
  "where": {
    "logic": "AND",
    "rules": [
      { "field": "type", "op": "=", "value": "Bug" },
      { "field": "state", "op": "=", "value": "Active" },
      { "field": "assigned", "op": "=", "value": "@me" }
    ]
  }
}

Query: "created in the last 7 days and closed"
Output:
{
  "where": {
    "logic": "AND",
    "rules": [
      { "field": "createddate", "op": "RANGE", "value": "@today-7...@today" },
      { "field": "state", "op": "IN", "value": ["Closed", "Resolved"] }
    ]
  }
}
</examples>

Query: "\${query}"
Output:`;

  const SEARCH_ENRICH_INTENT_PROMPT = `<system>
You are a search query enricher. Translate user query constraints for selected fields to English, expand synonyms, and map dates/sprints to relative macros.
</system>

<rules>
1. Output a plain-text list of resolved constraints, one per line (format: "field: value").
2. Translate non-English values to English (e.g. "ошибка" -> "Bug").
3. For assignees, use exact matched names.
4. For tags and titles, write all semantic synonyms separated by commas.
5. Map relative dates/sprints to macros (@today-7, @currentIteration, @currentIteration-1).
6. Do NOT write intro text. Write only the list.
</rules>

<schema>
\${selectedFieldsSchema}
</schema>

<examples>
Query: "ошибки по бэкенду от Саши за прошлую неделю"
Output:
type: Bug
assigned: Alexander Ivanov
tags: backend, api
title: backend, api
created: @today-7...@today
iteration: @currentIteration-1

Query: "active tasks in current sprint"
Output:
type: Task
state: Active
iteration: @currentIteration
</examples>

Query: "\${query}"
Output:`;

  const SEARCH_COMPILE_JSON_PROMPT = `<system>
Convert the structured query intent list into a valid JSON filter matching the FilterIR schema.
</system>

<schema>
\${schema}
</schema>

<rules>
1. Output ONLY valid raw JSON matching the schema. No markdown blocks.
2. For multiple values in assignees or tags, ALWAYS use the "IN" operator with a JSON array.
3. For text searches (title/desc), use "CONTAINS" or "IN".
</rules>

<examples>
Intent:
assigned: Alexander Ivanov, Alexander Smith
tags: backend, api
Output:
{
  "where": {
    "logic": "AND",
    "rules": [
      { "field": "assigned", "op": "IN", "value": ["Alexander Ivanov", "Alexander Smith"] },
      { "field": "tags", "op": "IN", "value": ["backend", "api"] }
    ]
  }
}
</examples>

Intent:
\${intent}
Output:`;

  const SEARCH_MATCH_TAGS_PROMPT = `<system>
You are a tag matching assistant. Select up to 15 tags from the available tags list that are semantically related, synonymous, or relevant to the user query.
</system>

<rules>
1. Output ONLY a valid JSON array of strings containing exact tag names (e.g., ["tag1", "tag2"]).
2. Do NOT include markdown code blocks (like \`\`\`json) or conversational text.
3. STRICTLY select only tags that exist in the "Available Tags" list. Do not invent new tags.
4. If no tags are relevant, output: []
</rules>

<available_tags>
\${tagsList}
</available_tags>

<examples>
Query: "need to fix backend api database bugs"
Available Tags: backend, frontend, database, ui, release
Output: ["backend", "database"]

Query: "show my active tasks"
Available Tags: backend, frontend, bug
Output: []
</examples>

Query: "\${query}"
Output:`;

  const SEARCH_MATCH_ASSIGNEES_PROMPT = `<system>
You are an entity resolution assistant. Map names, nicknames, pronouns, or grammatical declensions mentioned in the user query to the official full names from the list.
</system>

<rules>
1. Output ONLY a valid JSON object mapping the reference substring in the query to the exact matched full name from the team list (e.g., {"Alex": "Alexander Ivanov", "me": "@me"}).
2. If the user uses self-referential pronouns (like "my", "me", "assigned to me", "мои", "меня", "мне"), map them to "@me".
3. If no names or pronouns are mentioned, output an empty object: {}
4. Do NOT output any explanation, notes, or markdown formatting.
</rules>

<team>
\${assigneesList}
</team>

<examples>
Query: "bugs for Alex and me" (with team including "Alexander Ivanov")
Output:
{"Alex": "Alexander Ivanov", "me": "@me"}

Query: "баги на Сашу и Леху" (with team including "Aleksei Bezruk", "Alexander Ivanov")
Output:
{"Сашу": "Alexander Ivanov", "Леху": "Aleksei Bezruk"}

Query: "show closed issues"
Output:
{}
</examples>

Query: "\${query}"
Output:`;

  const SEARCH_MATCH_DATES_PROMPT = `<system>
You are a date extraction assistant for Azure DevOps search.
Analyze the user query and extract any date constraints or ranges for the specified date fields.
Map relative time frames to standardized macros:
- "today" -> "@today"
- "yesterday" -> "@today-1"
- "last week" / "past week" -> "@today-7...@today"
- "last 2 weeks" / "past 14 days" -> "@today-14...@today"
- "this month" -> "@today-30...@today"
- "last month" -> "@today-60...@today-30"
- "this year" -> "@today-365...@today"
- "since X" (e.g. "since yesterday") -> "@today-1..." (use "..." for open-ended start range)
- "before X" (e.g. "before 3 days ago") -> "...@today-3" (use "..." for open-ended end range)
- Specific ISO dates (e.g., "2026-06-25") -> "2026-06-25"
</system>

<rules>
1. Output ONLY a valid JSON object mapping date fields to their resolved macros or ranges (e.g., {"created": "@today-7...@today"}).
2. Do NOT output any markdown blocks (like \`\`\`json) or conversational text.
3. If no date constraints are found, output: {}
</rules>

<date_fields>
\${dateFields}
</date_fields>

<examples>
Query: "bugs created last week"
Output: {"created": "@today-7...@today"}

Query: "tasks changed since yesterday"
Output: {"changed": "@today-1..."}

Query: "resolved before 3 days ago"
Output: {"resolved": "...@today-3"}

Query: "items created in 2026-05-10"
Output: {"created": "2026-05-10"}

Query: "show active bugs"
Output: {}
</examples>

Query: "\${query}"
Output:`;

  global.SEARCH_SYSTEM_PROMPT_TEMPLATE = SEARCH_SYSTEM_PROMPT_TEMPLATE;
  global.SEARCH_SELECT_FIELDS_PROMPT = SEARCH_SELECT_FIELDS_PROMPT;
  global.SEARCH_DIRECT_JSON_PROMPT = SEARCH_DIRECT_JSON_PROMPT;
  global.SEARCH_ENRICH_INTENT_PROMPT = SEARCH_ENRICH_INTENT_PROMPT;
  global.SEARCH_COMPILE_JSON_PROMPT = SEARCH_COMPILE_JSON_PROMPT;
  global.SEARCH_MATCH_TAGS_PROMPT = SEARCH_MATCH_TAGS_PROMPT;
  global.SEARCH_MATCH_ASSIGNEES_PROMPT = SEARCH_MATCH_ASSIGNEES_PROMPT;
  global.SEARCH_MATCH_DATES_PROMPT = SEARCH_MATCH_DATES_PROMPT;
})(typeof globalThis !== 'undefined' ? globalThis : window);
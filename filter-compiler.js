(function(global) {

  // --- Utility: deep clone AST node ---
  function cloneAST(node) {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(cloneAST);
    const result = {};
    for (const key in node) {
      if (Object.prototype.hasOwnProperty.call(node, key)) {
        result[key] = cloneAST(node[key]);
      }
    }
    return result;
  }


  // --- Frontend/Validation Utility ---
  // Exposed for UI components to pre-validate input
  function validateToken(token, field, filterFields) {
    if (!token || typeof token !== 'string') return false;
    
    // Macro validation
    if (token.startsWith('@')) {
      const macros = getSupportedMacros(field, filterFields);
      const match = macros.find(m => token.toLowerCase().startsWith(m));
      return !!match;
    }

    return true; // Non-macro strings are structurally valid (further domain validation may happen)
  }

  // --- Middle-end: Optimization Passes ---
  
  // Pass 1: Macro Normalization
  // Standardizes macros like "me", "@me", "@empty", "\"\"" into explicit AST tokens
  function MacroNormalizationPass(ast, fields) {
    function walk(node) {
      if (!node) return node;
      if (node.kind === 'group') {
        node.rules = (node.rules || []).map(walk);
        return node;
      }
      if (node.kind === 'condition') {
        const spec = (fields && fields[node.field]) || {};
        const isIdentity = spec.identity || spec.type === 'identity' || spec.type === 'user';
        
        let values = Array.isArray(node.value) ? node.value : [node.value];
        values = values.map(v => {
          if (v === '""' || v === "''" || v === '@empty') return { type: 'macro', name: 'EMPTY' };
          if (isIdentity && (v === 'me' || v === '@me')) return { type: 'macro', name: 'ME' };
          
          if (typeof v === 'string' && v.startsWith('@')) {
             const m = v.toLowerCase();
             if (m.startsWith('@today')) return { type: 'macro', name: 'TODAY', raw: v };
             if (m.startsWith('@currentiteration')) return { type: 'macro', name: 'CURRENTITERATION', raw: v };
             if (m.startsWith('@project')) return { type: 'macro', name: 'PROJECT', raw: v };
          }
          return { type: 'literal', value: v };
        });
        
        // Single values are unboxed for convenience
        node.values = values;
        return node;
      }
      return node;
    }
    return walk(cloneAST(ast));
  }

  // Pass 2: Empty Value Normalization
  // Transforms queries with empty values to avoid ADO 400 errors (e.g., UNDER '' -> = '')
  function EmptyValuePass(ast, fields) {
    function walk(node) {
      if (!node) return node;
      if (node.kind === 'group') {
        node.rules = (node.rules || []).map(walk);
        return node;
      }
      if (node.kind === 'condition') {
        const spec = (fields && fields[node.field]) || {};
        const isTree = spec.type === 'tree' || spec.type === 'treePath';
        const isLongText = spec.type === 'html' || spec.type === 'plaintext';
        let op = (node.op || '=').toUpperCase();
        
        const emptyIdx = node.values.findIndex(v => v.type === 'macro' && v.name === 'EMPTY');
        if (emptyIdx !== -1) {
          if (isTree) {
            node.values[emptyIdx] = { type: 'macro', name: 'PROJECT', raw: '@project' };
            if (op === 'UNDER') node.op = '=';
            if (op === 'NOT UNDER') node.op = '<>';
          } else if (isLongText) {
            node.op = ['<>', '!=', 'NOT IN', 'NOT CONTAINS', 'NOT UNDER'].includes(op) ? 'ISNOTEMPTY' : 'ISEMPTY';
            node.values.splice(emptyIdx, 1);
          } else {
            node.values[emptyIdx] = { type: 'literal', value: '', isExplicitEmpty: true };
            if (node.values.length === 1) {
              if (op === 'CONTAINS' || op === 'UNDER' || op === 'IN') node.op = '=';
              if (op === 'NOT CONTAINS' || op === 'NOT UNDER' || op === 'NOT IN') node.op = '<>';
            }
          }
        }
        return node;
      }
      return node;
    }
    // Need to clone the AST since we are modifying it, but our parser creates fresh ASTs anyway.
    return walk(ast);
  }

  // Pass 3: Validation Pass
  // Ensures semantic correctness of the AST
  function ValidationPass(ast, fields) {
    function walk(node) {
      if (!node) return null;
      if (node.kind === 'group') {
        node.rules = node.rules.map(walk).filter(Boolean);
        if (node.rules.length === 0) return null;
        return node;
      }
      if (node.kind === 'condition') {
        // Prune invalid macros or implicit empty strings
        node.values = node.values.filter(v => {
          if (v.type === 'macro' && v.name !== 'EMPTY' && v.name !== 'ME') {
             if (!validateToken(v.raw, node.field, fields)) {
                console.warn(`FilterCompiler: Invalid macro ${v.raw} for field ${node.field}`);
                return false;
             }
          }
          if (v.type === 'literal') {
             const val = v.value;
             if ((val === "" || val === null || val === undefined) && !v.isExplicitEmpty) {
               return false; // Drop completely empty strings unless explicitly intended
             }
          }
          return true;
        });

        // If condition has no values left, drop the condition entirely
        if (node.values.length === 0 && node.op !== 'ISEMPTY' && node.op !== 'ISNOTEMPTY') {
          return null;
        }
        return node;
      }
      return node;
    }
    return walk(ast);
  }

  // --- Backend: WIQL Generator ---
  
  const WiqlBackend = {
    generate(ast, fields) {
      if (!ast) return [];
      const compiled = this._compileRule(ast, fields);
      return compiled ? [compiled] : [];
    },

    _compileRule(rule, fields) {
      if (!rule) return "";
      if (rule.kind === 'group') {
        const logic = rule.logic || 'AND';
        const groupedByField = {};
        const standardChildren = [];
        
        (rule.rules || []).forEach(r => {
          if (r.kind === 'condition') {
            if (!groupedByField[r.field]) groupedByField[r.field] = [];
            groupedByField[r.field].push(r);
          } else {
            standardChildren.push(this._compileRule(r, fields));
          }
        });

        const fieldGroups = Object.values(groupedByField).map(conds => {
          if (conds.length === 1) return this._compileCondition(conds[0], fields);
          
          const positiveOps = ['=', 'IN', 'CONTAINS', 'UNDER', 'RANGE', '>', '<', '>=', '<='];
          const negativeOps = ['<>', 'NOT IN', 'NOT CONTAINS', 'NOT UNDER'];
          
          const posCompiled = conds.filter(c => positiveOps.includes(c.op)).map(c => this._compileCondition(c, fields)).filter(Boolean);
          const negCompiled = conds.filter(c => negativeOps.includes(c.op)).map(c => this._compileCondition(c, fields)).filter(Boolean);
          const otherCompiled = conds.filter(c => !positiveOps.includes(c.op) && !negativeOps.includes(c.op)).map(c => this._compileCondition(c, fields)).filter(Boolean);
          
          const parts = [];
          if (posCompiled.length > 0) parts.push(posCompiled.length > 1 ? `(${posCompiled.join(' OR ')})` : posCompiled[0]);
          if (negCompiled.length > 0) parts.push(negCompiled.length > 1 ? `(${negCompiled.join(' AND ')})` : negCompiled[0]);
          if (otherCompiled.length > 0) parts.push(...otherCompiled);
          
          if (parts.length === 0) return "";
          if (parts.length === 1) return parts[0];
          return "(" + parts.join(' AND ') + ")";
        }).filter(Boolean);

        const allChildren = [...fieldGroups, ...standardChildren].filter(Boolean);
        if (allChildren.length === 0) return "";
        if (allChildren.length === 1) return allChildren[0];
        return "(" + allChildren.join(` ${logic} `) + ")";
      }
      
      if (rule.kind === 'condition') {
        return this._compileCondition(rule, fields);
      }
      return "";
    },

    _compileCondition(cond, fields) {
      const field = cond.field;
      const spec = (fields && fields[field]) || { ref: field };
      const ref = spec.ref || field;
      const num = spec.num || spec.type === 'integer' || spec.type === 'double';
      const op = (cond.op || '=').toUpperCase();
      
      // Helper to format a single AST value node
      const lit = (vNode) => {
        if (vNode.type === 'macro') {
          if (vNode.name === 'ME') return "@me";
          return vNode.raw; // e.g. @today - 1, @project
        }
        
        // Literal
        const v = vNode.value;
        
        if (num) {
          if (v === '' && vNode.isExplicitEmpty) return "''";
          const n = Number(v);
          return Number.isFinite(n) ? String(n) : "null";
        }
        
        // Use AdoLib wiqlQuote if available, fallback to simple replace
        const root = (typeof window !== 'undefined') ? window : (typeof globalThis !== 'undefined' ? globalThis : this);
        const escapeFn = (root.AdoLib && root.AdoLib.wiqlQuote) ? root.AdoLib.wiqlQuote : (s => String(s).replace(/'/g, "''"));
        return "'" + escapeFn(v) + "'";
      };

      const values = cond.values;
      if (op === 'ISEMPTY') return `[${ref}] IS EMPTY`;
      if (op === 'ISNOTEMPTY') return `[${ref}] IS NOT EMPTY`;
      
      if (!values || values.length === 0) return "";

      const validVals = values.map(lit).filter(x => x !== null);
      if (validVals.length === 0 && op !== 'ISEMPTY' && op !== 'ISNOTEMPTY') return "";

      if (op === 'IN' || op === 'NOT IN') {
        const hasMe = values.some(v => v.type === 'macro' && v.name === 'ME');
        const hasEmpty = values.some(v => v.type === 'literal' && v.isExplicitEmpty);
        
        const splitEmpty = hasEmpty && num;
        
        const filteredVals = values.filter(v => {
          if (v.type === 'macro' && v.name === 'ME') return false;
          if (splitEmpty && v.type === 'literal' && v.isExplicitEmpty) return false;
          return true;
        });
        
        const normalVals = filteredVals.map(lit).filter(x => x !== null);
        
        const parts = [];
        if (hasMe) parts.push(`[${ref}] ${op === 'NOT IN' ? '<>' : '='} @me`);
        if (splitEmpty) parts.push(`[${ref}] ${op === 'NOT IN' ? '<>' : '='} ''`);
        if (normalVals.length) parts.push(`[${ref}] ${op} (${normalVals.join(",")})`);
        
        if (parts.length === 0) return "";
        if (parts.length === 1) return parts[0];
        return "(" + parts.join(op === 'NOT IN' ? ' AND ' : ' OR ') + ")";
      }

      if (op === 'CONTAINS' || op === 'NOT CONTAINS') {
        const clauses = values.map(v => {
          const formatted = lit(v);
          if (!formatted) return null;
          return op === 'NOT CONTAINS' ? `NOT [${ref}] CONTAINS ${formatted}` : `[${ref}] CONTAINS ${formatted}`;
        }).filter(Boolean);
        
        if (clauses.length === 0) return "";
        if (clauses.length === 1) return clauses[0];
        return "(" + clauses.join(op === 'NOT CONTAINS' ? ' AND ' : ' OR ') + ")";
      }

      if (op === 'UNDER' || op === 'NOT UNDER') {
        const clauses = values.map(v => {
          const formatted = lit(v);
          if (!formatted) return null;
          if (op === 'NOT UNDER') {
            return `([${ref}] <> ${formatted} AND [${ref}] NOT UNDER ${formatted})`;
          }
          return `([${ref}] = ${formatted} OR [${ref}] UNDER ${formatted})`;
        }).filter(Boolean);
        
        if (clauses.length === 0) return "";
        if (clauses.length === 1) return clauses[0];
        return clauses.length > 1 ? `(${clauses.join(op === 'NOT UNDER' ? ' AND ' : ' OR ')})` : clauses[0];
      }

      if (op === 'RANGE') {
        // Range expects exactly 2 literals in a single string, e.g. "A...B"
        // In the AST it should be a single literal
        if (values.length === 1 && values[0].type === 'literal') {
          const parts = String(values[0].value).split('...');
          if (parts.length === 2) {
            return `([${ref}] >= ${lit({type: 'literal', value: parts[0]})} AND [${ref}] <= ${lit({type: 'literal', value: parts[1]})})`;
          }
        }
        return `[${ref}] = ${validVals[0]}`;
      }

      // Default (e.g. =, <>, >, <)
      if (values.length === 1) {
        return `[${ref}] ${op} ${validVals[0]}`;
      }

      // Fallback for multiple values with singular operator
      const formatted = validVals.join(', ');
      return `[${ref}] ${op} ${formatted}`;
    }
  };

  // --- Main Compiler Interface ---
  
  // --- Tooltip API ---
  function getSupportedOperators(field, filterFields) {
    const spec = (filterFields && filterFields[field]) || {};
    const type = spec.type;
    
    // Core operators supported by almost everyone
    let ops = ['=', '<>', 'IN', 'NOT IN'];
    
    if (type === 'string' || type === 'html' || type === 'plaintext') {
      ops.push('CONTAINS', 'NOT CONTAINS');
    }
    
    const isTree = type === 'tree' || type === 'treePath';
    
    if (isTree) {
      ops.push('UNDER', 'NOT UNDER');
    }
    
    if (type === 'integer' || type === 'double' || type === 'numeric' || type === 'datetime' || type === 'dateTime') {
      ops.push('>', '<', '>=', '<=');
    }
    
    return ops;
  }

  function getSupportedMacros(field, filterFields) {
    const spec = (filterFields && filterFields[field]) || {};
    const type = spec.type;
    const identity = spec.identity || type === 'identity' || type === 'user';
    const isTree = type === 'tree' || type === 'treePath';
    const isIteration = isTree && spec.ref && spec.ref.toLowerCase().endsWith('iterationpath');
    
    const macros = ['@empty']; // We now support @empty universally (sugar for tree, IsEmpty for html, '' for standard)
    
    if (type === 'datetime' || type === 'dateTime') macros.push('@today');
    if (identity || field === 'assigned') macros.push('@me');
    if (isIteration) macros.push('@currentiteration');
    if (isTree) macros.push('@project');
    
    return macros;
  }

  // --- Exports ---

  const FilterCompiler = {
    validateToken,
    getSupportedOperators,
    getSupportedMacros,
    compile(ast, fields, backendType = 'WIQL') {
      if (!ast || !ast.where) return [];
      
      // Middle-end Passes
      let ir = MacroNormalizationPass(ast.where, fields);
      ir = EmptyValuePass(ir, fields);
      ir = ValidationPass(ir, fields);
      
      // Backend Generation
      if (backendType === 'WIQL') {
        return WiqlBackend.generate(ir, fields);
      }
      
      throw new Error(`FilterCompiler: Unsupported backend type '${backendType}'`);
    }
  };

  // Export
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = FilterCompiler;
  } else {
    global.FilterCompiler = FilterCompiler;
  }

})(typeof window !== 'undefined' ? window : global);

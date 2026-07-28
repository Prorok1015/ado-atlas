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
        const spec = (fields && fields[String(node.field).toLowerCase()]) || {};
        const isIdentity = spec.identity || spec.type === 'identity' || spec.type === 'user';
        
        // Resolve iteration macros and offsets using allowedValues annotations
        if (spec.id === 'iteration' && spec.allowedValues && spec.allowedValues.length > 0) {
          const allowed = spec.allowedValues;
          const resolveMacro = (v) => {
            if (typeof v !== 'string') return v;
            const cleanMacro = v.trim().toLowerCase();
            if (cleanMacro.startsWith('@currentiteration')) {
              const currentIdx = allowed.findIndex(val => val.toLowerCase().includes('(current)'));
              if (currentIdx === -1) return v;
              
              let targetIdx = currentIdx;
              if (cleanMacro !== '@currentiteration') {
                const match = cleanMacro.match(/^@currentiteration\s*([+-])\s*(\d+)$/);
                if (match) {
                  const op = match[1];
                  const offset = parseInt(match[2], 10);
                  targetIdx = op === '+' ? currentIdx + offset : currentIdx - offset;
                }
              }
              
              if (targetIdx >= 0 && targetIdx < allowed.length) {
                return allowed[targetIdx].replace(/\s*\((current|past|future|current[+-]\d+)\)$/i, '').trim();
              }
            }
            return v;
          };

          if (node.op === 'RANGE' && typeof node.value === 'string') {
            const parts = node.value.split('...');
            if (parts.length === 2) {
              const startVal = resolveMacro(parts[0]);
              const endVal = resolveMacro(parts[1]);
              const getCleanPath = (valWithLabel) => valWithLabel.replace(/\s*\((current|past|future|current[+-]\d+)\)$/i, '').trim();
              const allowedClean = allowed.map(getCleanPath);
              const startIdx = allowedClean.indexOf(getCleanPath(startVal));
              const endIdx = allowedClean.indexOf(getCleanPath(endVal));
              
              if (startIdx !== -1 && endIdx !== -1) {
                const min = Math.min(startIdx, endIdx);
                const max = Math.max(startIdx, endIdx);
                const paths = [];
                for (let i = min; i <= max; i++) {
                  paths.push(allowedClean[i]);
                }
                if (paths.length > 0) {
                  node.op = 'IN';
                  node.value = paths;
                }
              }
            }
          } else {
            if (Array.isArray(node.value)) {
              node.value = node.value.map(resolveMacro);
            } else {
              node.value = resolveMacro(node.value);
            }
          }
        }

        // Clean any residual annotations from iteration/area values
        const getClean = (v) => {
          if (typeof v === 'string') {
            return v.replace(/\s*\((current|past|future|current[+-]\d+)\)$/i, '').trim();
          }
          if (Array.isArray(v)) {
            return v.map(getClean);
          }
          return v;
        };
        if (spec.id === 'iteration' || spec.id === 'area') {
          node.value = getClean(node.value);
        }
        
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
        const spec = (fields && fields[String(node.field).toLowerCase()]) || {};
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

  // --- Main Compiler Interface ---
  
  // --- Tooltip API ---
  function getSupportedOperators(field, filterFields) {
    const spec = (filterFields && filterFields[String(field).toLowerCase()]) || {};
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
    const spec = (filterFields && filterFields[String(field).toLowerCase()]) || {};
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

    // Converts AST -> normalized vendor-neutral FilterIR
    toIR(ast, fields) {
      if (!ast || !ast.where) return { ir: null, fieldsMap: {} };

      const fieldsMap = {};
      const registerField = (key, f) => {
        if (!key || !f) return;
        const normalized = { ...f, id: key };
        fieldsMap[key.toLowerCase()] = normalized;
        if (f.ref) fieldsMap[f.ref.toLowerCase()] = normalized;
        if (f.aliases) {
          f.aliases.forEach(a => { fieldsMap[a.toLowerCase()] = normalized; });
        }
      };

      if (Array.isArray(fields)) {
        fields.forEach(f => { registerField(f.id, f); });
      } else if (fields && typeof fields === 'object') {
        for (const [key, val] of Object.entries(fields)) {
          registerField(key, val);
        }
      }

      let ir = MacroNormalizationPass(ast.where, fieldsMap);
      ir = EmptyValuePass(ir, fieldsMap);
      ir = ValidationPass(ir, fieldsMap);
      return { ir, fieldsMap };
    },

    // Pure polymorphic compilation: delegates to provider.compileFilter(ir, fieldsMap)
    compile(ast, fields, target) {
      if (!ast || !ast.where) return [];
      const { ir, fieldsMap } = this.toIR(ast, fields);

      let provider = null;
      if (typeof target === 'object' && target) {
        provider = target;
      } else if (typeof target === 'string' && target) {
        const bg = typeof global !== 'undefined' && global.App && global.App.backend ? global.App.backend : (typeof window !== 'undefined' && window.App && window.App.backend ? window.App.backend : null);
        if (bg) provider = bg.get(target);
      }

      if (!provider) {
        const bg = typeof global !== 'undefined' && global.App && global.App.backend ? global.App.backend : (typeof window !== 'undefined' && window.App && window.App.backend ? window.App.backend : null);
        if (bg) provider = bg.active;
      }

      if (provider && typeof provider.compileFilter === 'function') {
        return provider.compileFilter(ir, fieldsMap);
      }

      throw new Error(`Unsupported or unregistered backend provider for filter compilation: ${typeof target === 'string' ? target : (provider ? provider.meta?.id : 'none')}`);
    }
  };

  // Export
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = FilterCompiler;
  } else {
    global.FilterCompiler = FilterCompiler;
  }

})(typeof window !== 'undefined' ? window : global);

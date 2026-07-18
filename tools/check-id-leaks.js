const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const srcDir = path.join(rootDir, 'src');

function getJsFiles(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach(file => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat && stat.isDirectory()) {
      results = results.concat(getJsFiles(filePath));
    } else if (file.endsWith('.js') && !file.includes('.test.') && !file.includes('.spec.')) {
      // Exclude low-level API files which naturally deal with raw native IDs
      if (!filePath.includes(path.join('src', 'core', 'api'))) {
        results.push(filePath);
      }
    }
  });
  return results;
}

const files = getJsFiles(srcDir);
let hasWarnings = false;

console.log('Running global ID leak checks...');

files.forEach(file => {
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');
  const relativePath = path.relative(rootDir, file).replace(/\\/g, '/');

  lines.forEach((line, index) => {
    // 1. Template literal interpolation: e.g. ${id} or ${n.id}
    const templateMatch = line.match(/\$\{([^}]+)\}/g);
    if (templateMatch) {
      templateMatch.forEach(match => {
        const inner = match.slice(2, -1).trim();
        const isIdVar = /\b(id|cur|wid)\b/i.test(inner);
        const isWrapped = /\b(nid|rawNid|gidNative|displayId)\b/.test(inner);
        const isExcluded = /\b(identity|widget|guid|rev|valid|provider|client|slider|grid|idx)\b/i.test(inner);
        
        if (isIdVar && !isWrapped && !isExcluded) {
          console.warn(`[LEAK WARNING] ${relativePath}:${index + 1}: Interpolated ID variable "\${${inner}}" is not wrapped in nid()`);
          console.warn(`  Line: ${line.trim()}`);
          hasWarnings = true;
        }
      });
    }

    // 2. String concatenation: e.g. + id, + n.id, id + '...'
    const concatMatch = line.match(/(?:\+\s*|\b(?:id|n\.id|node\.id|item\.id|cur|wid)\s*\+\s*['"`])/i);
    if (concatMatch && !/\b(nid|rawNid|gidNative|displayId|guid|identity|rev)\b/.test(line)) {
      const hasIdConcat = /\b(id|cur|wid|n\.id|node\.id|item\.id)\b/i.test(line) && (line.includes('+') || line.includes('`'));
      if (hasIdConcat && !line.includes('//') && !line.includes('console.')) {
        console.warn(`[LEAK WARNING] ${relativePath}:${index + 1}: Potential ID concatenation without nid()`);
        console.warn(`  Line: ${line.trim()}`);
        hasWarnings = true;
      }
    }
  });
});

if (hasWarnings) {
  console.log('\nID leak check warning: Warnings were found. Review them to ensure no global IDs leak to the UI.');
} else {
  console.log('ID leak check OK: No global ID leaks detected in UI code.');
}

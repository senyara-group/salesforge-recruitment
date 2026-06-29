const fs = require('fs');
const path = require('path');
const vm = require('vm');

const frontendRoot = path.resolve(__dirname, '..', '..', 'frontend');
const htmlFiles = [];

function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) walk(full);
    else if (full.endsWith('.html')) htmlFiles.push(full);
  }
}

function localTarget(file, rawUrl) {
  let url = rawUrl.split('#')[0].split('?')[0];
  if (!url || /^(https?:|mailto:|tel:|javascript:|data:|#)/i.test(url)) return null;
  if (url.startsWith('/')) url = url.slice(1);
  const target = path.resolve(path.dirname(file), url);
  return target.startsWith(frontendRoot) ? target : null;
}

walk(frontendRoot);

const failures = [];
for (const file of htmlFiles) {
  const html = fs.readFileSync(file, 'utf8');
  const scriptPattern = /<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  const attrPattern = /\b(?:href|src)=['"]([^'"]+)['"]/gi;
  let match;
  let index = 0;

  while ((match = scriptPattern.exec(html))) {
    index += 1;
    try {
      new vm.Script(match[1], { filename: `${path.relative(frontendRoot, file)}#script${index}` });
    } catch (error) {
      failures.push(`${path.relative(frontendRoot, file)} script ${index}: ${error.message}`);
    }
  }

  while ((match = attrPattern.exec(html))) {
    const target = localTarget(file, match[1]);
    if (target && !fs.existsSync(target)) {
      failures.push(`${path.relative(frontendRoot, file)} -> ${match[1]}`);
    }
  }
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log(`OK HTML statique (${htmlFiles.length} fichiers)`);

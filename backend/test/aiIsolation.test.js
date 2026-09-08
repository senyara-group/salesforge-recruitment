const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const protectedModules = ['aiUsage', 'aiAccess', 'cvAnalysis', 'coachContext', 'coachReply', 'aiSafety'];
const productAreas = ['swipes.js', 'candidatures.js', 'recruteurs.js', 'offres.js', 'matchs.js'];

test('matching, swipe, candidature et recruteur ne dépendent pas des modules IA candidat', () => {
  for (const filename of productAreas) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'routes', filename), 'utf8');
    for (const moduleName of protectedModules) assert.doesNotMatch(source, new RegExp(`utils[/\\\\]${moduleName}|ai_cv_analyses|ai_conversations|ai_usage_`), filename);
  }
});

test('résultats IA ne sont servis que par les routes candidat dédiées', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /\/api\/assistant/);
  assert.doesNotMatch(server, /\/api\/(?:recruteurs|swipes|matchs)[^\n]+assistant/);
});

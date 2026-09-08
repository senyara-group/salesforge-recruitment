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

test('assistant est le Coach canonique et la route coaching ne génère plus de réponse', () => {
  const candidate = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', '_spaces', 'candidat.html'), 'utf8');
  const legacy = fs.readFileSync(path.join(__dirname, '..', 'routes', 'coaching.js'), 'utf8');
  assert.match(candidate, /\/assistant\/conversations/);
  assert.doesNotMatch(candidate, /\/coaching\/(?:chat|modules)/);
  assert.match(legacy, /COACH_ROUTE_DEPRECATED/);
  assert.doesNotMatch(legacy, /askClaude|callAi|COACHING_BASE_PROMPT|checkAndConsumeUsage/);
});

test('interface #221 consomme le contrat CV V2 et conserve les fallbacks historiques', () => {
  const candidate = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', '_spaces', 'candidat.html'), 'utf8');
  for (const token of [
    'experience_years', 'sector', 'scoreContract.global', 'readability', 'quantified_impact',
    'ats_compatibility', 'commercial_relevance', 'result.title?.current', 'result.title?.suggested',
    'result.title?.reason', 'result.summary', 'result.rewrites', 'result.missing_metrics',
    'result.keywords', 'result.alerts', 'result.priorities',
  ]) assert.match(candidate, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), token);
  for (const fallback of ['result.strengths', 'result.clarifications', 'result.questions', 'result.score_global', 'result.current_title']) {
    assert.match(candidate, new RegExp(fallback.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), fallback);
  }
});

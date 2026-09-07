const test = require('node:test');
const assert = require('node:assert/strict');
const { callAi } = require('../utils/aiProvider');
const { CV_MAX_TOKENS, cvAnalysisPrompt, normalizeCvAnalysis } = require('../utils/cvAnalysis');

test('le prompt CV borne toutes les sections et la longueur de la version améliorée', () => {
  const prompt = cvAnalysisPrompt(6000);
  assert.match(prompt, /au maximum 4 constats/);
  assert.match(prompt, /au maximum 4 éléments/);
  assert.match(prompt, /au maximum 5 actions/);
  assert.match(prompt, /au maximum 6 objets/);
  assert.match(prompt, /au maximum 4 questions/);
  assert.match(prompt, /ne dépassant pas 6600 caractères/);
  assert.equal(CV_MAX_TOKENS, 3200);
});

test('une réponse JSON valide proche du plafond reste analysable', async () => {
  const improved = 'C'.repeat(9000);
  const json = JSON.stringify({ strengths: ['Clair'], clarifications: [], priorities: [], rewrites: [], questions: [], improved_cv: improved });
  const result = await callAi({
    json: true,
    maxTokens: CV_MAX_TOKENS,
    messages: [{ role: 'user', content: 'CV fictif' }],
    providerCall: async () => ({ text: json, meta: { stop_reason: 'end_turn', output_tokens: 3180, response_chars: json.length } }),
  });
  assert.equal(result.improved_cv.length, 9000);
});

test('la normalisation défensive existante reste inchangée', () => {
  const values = Array.from({ length: 12 }, (_, index) => `élément-${index}`);
  const normalized = normalizeCvAnalysis({
    strengths: values, clarifications: values, priorities: values, questions: values,
    rewrites: values.map((value) => ({ original: value, suggestion: value, reason: value })),
    improved_cv: 'CV fictif normalisé',
  }, 'fallback');
  assert.equal(normalized.strengths.length, 8);
  assert.equal(normalized.clarifications.length, 8);
  assert.equal(normalized.priorities.length, 8);
  assert.equal(normalized.questions.length, 8);
  assert.equal(normalized.rewrites.length, 10);
  assert.equal(normalized.improved_cv, 'CV fictif normalisé');
});

test('une troncature max_tokens conserve les diagnostics sans contenu', async () => {
  await assert.rejects(() => callAi({
    json: true,
    maxTokens: CV_MAX_TOKENS,
    messages: [],
    providerCall: async () => ({
      text: '{"strengths":["fictif"],"improved_cv":"tronque',
      meta: { stop_reason: 'max_tokens', input_tokens: 1321, output_tokens: CV_MAX_TOKENS, response_chars: 48 },
    }),
  }), (error) => error.code === 'AI_INVALID_RESPONSE'
    && error.diagnostics.stage === 'json_parse'
    && error.diagnostics.stop_reason === 'max_tokens'
    && error.diagnostics.output_tokens === CV_MAX_TOKENS
    && !JSON.stringify(error.diagnostics).includes('tronque'));
});

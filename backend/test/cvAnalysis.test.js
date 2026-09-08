const test = require('node:test');
const assert = require('node:assert/strict');
const { callAi } = require('../utils/aiProvider');
const { CV_MAX_TOKENS, CV_MIN_SOURCE_CHARS, CV_LIMITS, cvAnalysisPrompt, normalizeCvAnalysis } = require('../utils/cvAnalysis');

function completeAnalysis(overrides = {}) {
  return {
    score: { global: 99, readability: 80, quantified_impact: 60, ats_compatibility: 70, commercial_relevance: 90, diagnostic: 'Phrase une. Phrase deux. Phrase trois.' },
    title: { current: 'Commercial', suggested: 'Account Executive', reason: 'Plus précis' },
    summary: 'Accroche factuelle', rewrites: [], missing_metrics: [], keywords: [], alerts: [], priorities: [], improved_cv: 'CV source 2024', ...overrides,
  };
}

test('contrat CV V2 reste complet, explicable et strictement borné', () => {
  const prompt = cvAnalysisPrompt(6000);
  assert.match(prompt, /score global est la moyenne arrondie/i);
  assert.match(prompt, /ne recommande aucune offre/i);
  assert.match(prompt, /n'invente jamais chiffre/i);
  assert.match(prompt, /rewrites <= 6/);
  assert.match(prompt, /priorities <= 3/);
  assert.match(prompt, /ne dépasse pas 6300 caractères/);
  assert.match(prompt, /diagnostic fait 3 à 4 phrases courtes et <= 500 caractères/i);
  assert.match(prompt, /suggestion <= 260/);
  assert.equal(CV_MAX_TOKENS, 5000);
  assert.equal(CV_MIN_SOURCE_CHARS, 200);
});

test('normalisation produit des scores 0-100 et recalcule le global', () => {
  const result = normalizeCvAnalysis(completeAnalysis({ score: { readability: 120, quantified_impact: -5, ats_compatibility: 70, commercial_relevance: 90, diagnostic: 'Un. Deux. Trois. Quatre. Cinq. Six.' } }), 'CV source 2024');
  assert.deepEqual({ global: result.score.global, readability: result.score.readability, quantified_impact: result.score.quantified_impact, ats_compatibility: result.score.ats_compatibility, commercial_relevance: result.score.commercial_relevance }, { global: 65, readability: 100, quantified_impact: 0, ats_compatibility: 70, commercial_relevance: 90 });
  assert.equal(result.score.diagnostic.split('.').filter(Boolean).length, 5);
});

test('listes CV sont strictement bornées et mots-clés absents restent à vérifier', () => {
  const many = Array.from({ length: 20 }, (_, index) => ({ original: `o${index}`, suggestion: `s${index}`, method: 'action', reason: 'utile' }));
  const result = normalizeCvAnalysis(completeAnalysis({ rewrites: many, missing_metrics: many.map((_, i) => ({ location:`l${i}` })), keywords: many.map((_, i) => ({ keyword:`k${i}`, status:'invalid' })), alerts: many.map((_, i) => ({ detail:`a${i}` })), priorities: many.map((_, i) => `p${i}`) }), 'CV source 2024');
  assert.equal(result.rewrites.length, CV_LIMITS.rewrites);
  assert.equal(result.missing_metrics.length, CV_LIMITS.missingMetrics);
  assert.equal(result.keywords.length, CV_LIMITS.keywords);
  assert.equal(result.alerts.length, CV_LIMITS.alerts);
  assert.equal(result.priorities.length, CV_LIMITS.priorities);
  assert.ok(result.keywords.every((item) => item.status === 'verify_before_adding'));
});

test('un chiffre absent du CV est remplacé sans invention', () => {
  const result = normalizeCvAnalysis(completeAnalysis({ summary: '118 % de l’objectif en 2025', improved_cv: 'Résultat 118 % en 2025' }), 'CV source 2024 avec 95 % de l’objectif');
  assert.doesNotMatch(`${result.summary} ${result.improved_cv}`, /118|2025/);
  assert.match(result.summary, /À COMPLÉTER/);
  assert.match(result.improved_cv, /À COMPLÉTER/);
});

test('les exemples chiffrés Yannis ne deviennent ni few-shot ni faits candidat', () => {
  const prompt = cvAnalysisPrompt(4000);
  assert.doesNotMatch(prompt, /118\s*%|40 comptes/i);
  assert.match(prompt, /utilise \[À COMPLÉTER\] lorsqu'une donnée manque/i);
  const result = normalizeCvAnalysis(completeAnalysis({
    rewrites: [{ original:'Portefeuille', suggestion:'Gestion de 40 comptes à 118 % de l’objectif', method:'preuve', reason:'Quantifier' }],
    missing_metrics: [{ location:'Expérience', metric_type:'40 comptes', expected_format:'118 %' }],
  }), 'Gestion d’un portefeuille commercial sans métrique renseignée');
  assert.doesNotMatch(JSON.stringify(result), /118|40 comptes/);
  assert.match(JSON.stringify(result), /À COMPLÉTER/);
});

test('ancien historique reste normalisable', () => {
  const result = normalizeCvAnalysis({ strengths:['Clair.'], priorities:['Clarifier le titre'], rewrites:[{ original:'A', suggestion:'B', reason:'C' }], improved_cv:'CV historique' }, 'fallback');
  assert.equal(result.schema_version, 2);
  assert.match(result.score.diagnostic, /Clair/);
  assert.equal(result.rewrites.length, 1);
  assert.equal(result.improved_cv, 'CV historique');
});

test('une réponse JSON valide plus longue que l’ancien plafond reste analysable', async () => {
  const json = JSON.stringify(completeAnalysis({ improved_cv: 'C'.repeat(12000) }));
  const result = await callAi({ json:true, maxTokens:CV_MAX_TOKENS, messages:[], providerCall:async()=>({ text:json, meta:{ stop_reason:'end_turn', output_tokens:4400, response_chars:json.length } }) });
  assert.equal(result.improved_cv.length, 12000);
});

test('régression production : JSON tronqué à 3200 tokens reste rejeté avec diagnostics', async () => {
  const truncated = '{"score":{"global":50},"rewrites":[' + '{"original":"A","suggestion":"B"},'.repeat(280);
  await assert.rejects(() => callAi({ json:true, maxTokens:3200, messages:[], providerCall:async()=>({ text:truncated, meta:{ stop_reason:'max_tokens', input_tokens:1787, output_tokens:3200, response_chars:truncated.length } }) }), (error) => error.code === 'AI_INVALID_RESPONSE' && error.diagnostics.stage === 'json_parse' && error.diagnostics.stop_reason === 'max_tokens' && error.diagnostics.output_tokens === 3200 && !JSON.stringify(error.diagnostics).includes('suggestion'));
});

test('stop_reason max_tokens refuse aussi un JSON syntaxiquement fermé potentiellement partiel', async () => {
  const json = JSON.stringify(completeAnalysis());
  await assert.rejects(() => callAi({ json:true, maxTokens:CV_MAX_TOKENS, messages:[], providerCall:async()=>({ text:json, meta:{ stop_reason:'max_tokens', input_tokens:1787, output_tokens:CV_MAX_TOKENS, response_chars:json.length } }) }), (error) => error.code === 'AI_INVALID_RESPONSE' && error.diagnostics.stage === 'json_parse' && error.diagnostics.stop_reason === 'max_tokens' && error.diagnostics.output_tokens === CV_MAX_TOKENS);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  normalizeCandidateProfileStructuredFields,
  MAX_YEARS,
  MAX_MULTI,
} = require('../utils/candidateProfileWrite');

test('profil structuré : update champs valides', () => {
  const out = normalizeCandidateProfileStructuredFields({
    target_job_types: ['SDR', 'Account Executive'],
    sales_style: 'hunter',
    years_experience: 5,
    desired_contracts: ['CDI', 'Freelance'],
    sectors: ['SaaS / Tech'],
    customer_types: ['PME'],
    tools: ['HubSpot'],
    methodologies: ['MEDDIC'],
    availability: 'immediate',
  });
  assert.deepEqual(out.target_job_types, ['SDR', 'Account Executive']);
  assert.equal(out.sales_style, 'hunter');
  assert.equal(out.years_experience, 5);
  assert.deepEqual(out.desired_contracts, ['CDI', 'Freelance']);
  assert.deepEqual(out.sectors, ['SaaS / Tech']);
  assert.deepEqual(out.tools, ['HubSpot']);
  assert.equal(out.availability, 'immediate');
});

test('profil structuré : invalides / arrays trop longs', () => {
  assert.throws(() => normalizeCandidateProfileStructuredFields({ years_experience: MAX_YEARS + 1 }), /years_experience invalide/);
  assert.throws(() => normalizeCandidateProfileStructuredFields({ desired_contracts: ['Stage'] }), /desired_contracts invalide/);
  assert.throws(
    () => normalizeCandidateProfileStructuredFields({ sectors: Array.from({ length: MAX_MULTI + 1 }, (_, i) => `S${i}`) }),
    /trop de valeurs/
  );
  assert.throws(() => normalizeCandidateProfileStructuredFields({ tools: 'HubSpot' }), /doit être un tableau/);
});

test('profil structuré : clés absentes non écrasées', () => {
  const out = normalizeCandidateProfileStructuredFields({ sales_style: 'farmer' });
  assert.equal(out.sales_style, 'farmer');
  assert.equal(Object.prototype.hasOwnProperty.call(out, 'target_job_types'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(out, 'years_experience'), false);
});

test('PUT profil : isolation user_id, pas de deep ADN / CV IA, score préservé', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'candidats.js'), 'utf8');
  const start = source.indexOf("router.put('/profil'");
  const end = source.indexOf("router.get('/stats'", start);
  const block = source.slice(start, end);
  assert.match(block, /normalizeCandidateProfileStructuredFields/);
  assert.match(block, /req\.body\?\.user_id/);
  assert.match(block, /\.eq\('user_id', req\.user\.id\)/);
  assert.doesNotMatch(block, /score_adn\s*:/);
  assert.doesNotMatch(block, /deep_adn|bilans_carriere|ai_cv_analyses|getCandidatePlan/);
  assert.doesNotMatch(block, /from\('deep_adn/);
  assert.match(block, /\.\.\.\(current\.axes \|\| \{\}\)/);
});

test('candidateProfileWrite ne lit pas deep ADN / CV IA', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'utils', 'candidateProfileWrite.js'), 'utf8');
  assert.doesNotMatch(source, /from\(['"]deep_adn|bilans_carriere|ai_cv_analyses|coaching\//i);
  assert.doesNotMatch(source, /require\(['"].*deepAdn|require\(['"].*bilan/i);
});

test('UI candidat expose préférences professionnelles', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', '_spaces', 'candidat.html'), 'utf8');
  assert.match(html, /Préférences professionnelles/);
  assert.match(html, /target_job_types/);
  assert.match(html, /desired_contracts/);
  assert.match(html, /years_experience/);
  assert.match(html, /sales_style/);
  assert.doesNotMatch(html, /deep_adn_assessments/);
});

test('UI recruteur filtres : draft/apply, snapshot, pas de fetch avant Appliquer', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', '_spaces', 'recruteur.html'), 'utf8');
  assert.match(html, /APPLIED_CAND_FILTERS|emptyCandFilters/);
  assert.match(html, /applyCandFiltersFromPanel/);
  assert.match(html, /score_adn_min/);
  assert.match(html, /desired_contracts/);
  assert.match(html, /CAND_DECK_LOAD_GEN/);
  assert.match(html, /AbortController/);
  assert.match(html, /buildCandidateDeckParams/);
  assert.match(html, /filtersSnapshot|cloneCandFilters/);
  assert.match(html, /cand-filters-count|filtre[s]? actif/i);
  assert.match(html, /toggleDraftSkill/);
  assert.doesNotMatch(html, /SELECTED_COMP_FILTER/);
  // Draft skills n'appliquent pas immédiatement le deck
  assert.doesNotMatch(html, /function toggleDraftSkill[\s\S]{0,200}loadCandidates/);
  assert.doesNotMatch(html, /function toggleCandFilterChip[\s\S]{0,120}loadCandidates/);
});

test('buildCandidateDeckParams côté UI : CSV sans vides', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', '_spaces', 'recruteur.html'), 'utf8');
  assert.match(html, /setCsv\('target_job_types'/);
  assert.match(html, /setCsv\('competences'/);
  assert.match(html, /new Set/);
  assert.doesNotMatch(html, /params\.set\('plan'/);
  assert.doesNotMatch(html, /params\.set\('user_id'/);
  assert.doesNotMatch(html, /deep_adn|compatibilityScore/);
});

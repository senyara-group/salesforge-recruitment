const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const candidateHtml = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', '_spaces', 'candidat.html'), 'utf8');
const recruiterHtml = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', '_spaces', 'recruteur.html'), 'utf8');

function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `signature introuvable: ${signature}`);
  let depth = 0;
  let end = -1;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  assert.ok(end > start);
  return source.slice(start, end);
}

function loadDeckFilterHelpers() {
  const sandbox = {
    URLSearchParams,
    Date,
    DECK_FILTERS: {
      contract_type: [],
      remote_mode: [],
      salary_fixed_min: null,
      tags: [],
      job_type: '',
      sector: '',
      published_preset: '',
    },
  };
  const code = [
    extractFunction(candidateHtml, 'function publishedSinceFromPreset(preset, now = new Date())'),
    extractFunction(candidateHtml, 'function countActiveDeckFilters(filters = DECK_FILTERS)'),
    extractFunction(candidateHtml, 'function buildDeckQueryParams(filters, options)'),
    'this.publishedSinceFromPreset = publishedSinceFromPreset;',
    'this.countActiveDeckFilters = countActiveDeckFilters;',
    'this.buildDeckQueryParams = buildDeckQueryParams;',
  ].join('\n');
  vm.runInNewContext(code, sandbox);
  return sandbox;
}

test('construction query params filtre deck via URLSearchParams', () => {
  const helpers = loadDeckFilterHelpers();
  const params = helpers.buildDeckQueryParams({
    contract_type: ['CDI', 'Freelance'],
    remote_mode: ['hybrid', 'remote'],
    salary_fixed_min: 35000,
    tags: ['SaaS', 'Closing'],
    job_type: 'Account Executive',
    sector: 'Fintech',
    published_preset: '7d',
  }, { limit: 20, cursor: 'abc' });
  assert.equal(params.get('limit'), '20');
  assert.equal(params.get('cursor'), 'abc');
  assert.equal(params.get('contract_type'), 'CDI,Freelance');
  assert.equal(params.get('remote_mode'), 'hybrid,remote');
  assert.equal(params.get('salary_fixed_min'), '35000');
  assert.equal(params.get('tags'), 'SaaS,Closing');
  assert.equal(params.get('job_type'), 'Account Executive');
  assert.equal(params.get('sector'), 'Fintech');
  assert.match(params.get('published_since') || '', /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(params.toString().includes('Account+Executive') || params.toString().includes('Account%20Executive'), true);
});

test('compteur filtres actifs et reset logique', () => {
  const helpers = loadDeckFilterHelpers();
  assert.equal(helpers.countActiveDeckFilters(helpers.DECK_FILTERS), 0);
  assert.equal(helpers.countActiveDeckFilters({
    contract_type: ['CDI', 'Mission'],
    remote_mode: ['remote'],
    salary_fixed_min: 40000,
    tags: ['SaaS'],
    job_type: 'AE',
    sector: '',
    published_preset: '24h',
  }), 7);
});

test('published_since presets 24h / 7d / 30d', () => {
  const helpers = loadDeckFilterHelpers();
  const now = new Date(Date.UTC(2026, 8, 10));
  assert.equal(helpers.publishedSinceFromPreset('24h', now), '2026-09-09');
  assert.equal(helpers.publishedSinceFromPreset('7d', now), '2026-09-03');
  assert.equal(helpers.publishedSinceFromPreset('30d', now), '2026-08-11');
  assert.equal(helpers.publishedSinceFromPreset('', now), null);
});

test('changement filtre reset cursor + race DECK_LOAD_GEN / AbortController', () => {
  assert.match(candidateHtml, /DECK_CURSOR = null/);
  assert.match(candidateHtml, /DECK_HAS_MORE = false/);
  assert.match(candidateHtml, /DECK_LOAD_GEN/);
  assert.match(candidateHtml, /AbortController/);
  assert.match(candidateHtml, /if \(gen !== DECK_LOAD_GEN\) return/);
  assert.match(candidateHtml, /loadOffres\(\{ preserveFilters: true \}\)/);
  assert.match(candidateHtml, /OFFRES = \[\]/);
});

test('pagination suivante conserve les filtres (snapshot + buildDeckQueryParams)', () => {
  assert.match(candidateHtml, /filtersSnapshot/);
  assert.match(candidateHtml, /fetchDeckPage\(DECK_CURSOR, \{ filters: filtersSnapshot \}\)/);
  assert.match(candidateHtml, /buildDeckQueryParams\(filters/);
});

test('état vide filtré distinct + CTA reset', () => {
  assert.match(candidateHtml, /Aucune offre ne correspond à vos filtres/);
  assert.match(candidateHtml, /Réinitialiser les filtres/);
  assert.match(candidateHtml, /filteredEmpty/);
  assert.match(candidateHtml, /function resetDeckFilters\(/);
});

test('aucune injection des 7 tags côté offre / deck', () => {
  assert.match(candidateHtml, /DECK_TAG_VOCAB/);
  assert.doesNotMatch(candidateHtml, /OF_TAGS\s*=\s*\[[^\]]*(Closing)[^\]]*(Cold Calling)/);
  assert.match(recruiterHtml, /tags: OF_TAGS/);
  assert.doesNotMatch(recruiterHtml, /OF_TAGS\s*=\s*\[[^\]]*Closing[^\]]*SaaS/);
  assert.match(recruiterHtml, /contract_type: OF_TYPE/);
  assert.match(recruiterHtml, /remote_mode: OF_REMOTE/);
  assert.match(recruiterHtml, /salary_fixed_min/);
  assert.match(recruiterHtml, /job_type/);
  assert.match(recruiterHtml, /of-sector/);
});

test('UI filtres compacte : quick chips + panneau + compteur', () => {
  assert.match(candidateHtml, /id="filters-ov"/);
  assert.match(candidateHtml, /openDeckFilters/);
  assert.match(candidateHtml, /filters-count/);
  assert.match(candidateHtml, /data-quick-filter/);
  assert.doesNotMatch(candidateHtml, /onclick="setFilt\(/);
});

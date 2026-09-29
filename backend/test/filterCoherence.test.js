// Lot 6 — matrice de cohérence des filtres (tests O–S, V, W).
// Chemin réel testé de bout en bout :
//   valeur d'UI (lue dans le HTML) → vraie fonction de construction des paramètres
//   (extraite de la page en VM) → vrais parseurs → requête (faux PostgREST) →
//   vrais handlers /offres/deck et /candidats/deck → résultat.
// Les données sont écrites par les vrais chemins d'écriture (offerWrite,
// candidateProfileWrite). PostgREST reste simulé (pas de base réelle).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createDeckHarness } = require('./helpers/deckHarness');
const { normalizeOfferStructuredFields } = require('../utils/offerWrite');
const { normalizeCandidateProfileStructuredFields } = require('../utils/candidateProfileWrite');
const { compatibilityScore } = require('../utils/recruiterMatching');

const { db, queryLog, get } = createDeckHarness();
const ROOT = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');
const candidateHtml = read('frontend/_spaces/candidat.html');
const recruiterHtml = read('frontend/_spaces/recruteur.html');

function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `signature introuvable: ${signature}`);
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('fin introuvable');
}
/** Valeurs réellement proposées par un groupe de chips du panneau de filtres. */
function chipValues(html, id) {
  const start = html.indexOf(`id="${id}"`);
  assert.ok(start >= 0, `groupe de filtres introuvable: ${id}`);
  const segment = html.slice(start, html.indexOf('</div>', start));
  return [...segment.matchAll(/data-(?:filter-)?value="([^"]*)"/g)]
    .map((m) => m[1].replace(/&#39;/g, "'").replace(/&amp;/g, '&'))
    .filter(Boolean);
}

// Vraies fonctions de construction des paramètres (UI → query string).
const candidateSandbox = { URLSearchParams, Date, DECK_FILTERS: {} };
vm.runInNewContext([
  'const LOCATION_FILTER_MAX_LENGTH = 80;',
  extractFunction(candidateHtml, 'function normalizeLocationInput(value)'),
  extractFunction(candidateHtml, 'function publishedSinceFromPreset(preset, now = new Date())'),
  extractFunction(candidateHtml, 'function emptyDeckFilters()'),
  extractFunction(candidateHtml, 'function buildDeckQueryParams(filters, options)'),
  'this.h = { emptyDeckFilters, buildDeckQueryParams };',
].join('\n'), candidateSandbox);
// Critères par défaut réels de la page recruteur.
const MATCHING = vm.runInNewContext(`(${recruiterHtml.match(/let MATCHING = (\{[^}]*\});/)[1]})`);
const recruiterSandbox = { URLSearchParams, MATCHING, APPLIED_CAND_FILTERS: {} };
vm.runInNewContext([
  extractFunction(recruiterHtml, 'function normalizeLocationInput(value)'),
  extractFunction(recruiterHtml, 'function buildCandidateDeckParams(cursor, filters)'),
  'this.h = { buildCandidateDeckParams };',
].join('\n'), recruiterSandbox);

function offerQuery(patch, options = { limit: 50 }) {
  const filters = { ...candidateSandbox.h.emptyDeckFilters(), ...patch };
  return `/offres/deck?${candidateSandbox.h.buildDeckQueryParams(filters, options).toString()}`;
}
const EMPTY_CAND_FILTERS = Object.freeze({
  score_adn_min: null, years_experience_min: null, target_job_types: [], sales_style: [], desired_contracts: [],
  sectors: [], skills: [], tools: [], methodologies: [], availability: [], customer_types: [], location: '',
});
function candidateQuery(patch, { cursor = null, limit = '50' } = {}) {
  const params = recruiterSandbox.h.buildCandidateDeckParams(cursor, { ...EMPTY_CAND_FILTERS, ...patch });
  params.set('limit', limit); // seule dérogation : la page UI est fixée à 20
  return `/candidats/deck?${params.toString()}`;
}

// ------------------------------------------------------------------ données
const DAY = 24 * 3600 * 1000;
let seq = 0;
/** Offre écrite comme le formulaire recruteur (normalizeOfferStructuredFields). */
function offerFromForm(label, form, { lieu = null, ageDays = 1, statut = 'active' } = {}) {
  seq += 1;
  return {
    id: `o-${String(seq).padStart(3, '0')}`, titre: label, statut, lieu, recruteurs: null,
    created_at: new Date(Date.now() - ageDays * DAY - seq * 1000).toISOString(),
    ...normalizeOfferStructuredFields(form),
  };
}
/** Candidat écrit comme le formulaire de profil (normalizeCandidateProfileStructuredFields). */
function candidateFromProfile(label, profile, { ville, score = 60, anonyme } = {}) {
  seq += 1;
  const meta = {};
  if (ville !== undefined) meta.ville = ville;
  if (anonyme !== undefined) meta.anonyme = anonyme;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`, user_id: `u-${label}`, prenom: label, nom: 'X', titre: 'Commercial',
    score_adn: score, target_job_types: [],
    axes: { resultat: { closing: 40 + seq, drive: 90 - seq }, meta },
    ...normalizeCandidateProfileStructuredFields(profile),
  };
}

function seedOffers() {
  seq = 0;
  db.offres = [
    offerFromForm('AE Lyon', { contract_type: 'CDI', remote_mode: 'hybrid', salary_fixed_min: 45000, salary_fixed_max: 55000, tags: ['Closing', 'SaaS'], job_type: 'Account Executive', sector: 'SaaS et Tech' }, { lieu: 'Lyon' }),
    offerFromForm('SDR Paris', { contract_type: 'Alternance', remote_mode: 'onsite', salary_fixed_min: 25000, tags: ['Cold Calling', 'Outbound'], job_type: 'SDR / BDR', sector: 'Services B2B' }, { lieu: 'Paris', ageDays: 20 }),
    offerFromForm('Freelance remote', { contract_type: 'Freelance', remote_mode: 'remote', tags: ['Négociation'], job_type: 'Business Developer', sector: 'Retail' }, { lieu: 'Remote / Télétravail', ageDays: 3 }),
    offerFromForm('Mission St-Étienne', { contract_type: 'Mission', remote_mode: 'onsite', salary_fixed_min: 38000, tags: ['HubSpot', 'Salesforce'], job_type: 'Commercial terrain', sector: 'Industrie' }, { lieu: 'Saint-Étienne', ageDays: 45 }),
    // Historiques : champs structurés absents (NULL), texte libre ancien.
    offerFromForm('Historique libre', { type: 'CDI', job_type: 'Business Dev', sector: 'SaaS B2B' }, { lieu: 'Lyon (69)', ageDays: 100 }),
    offerFromForm('Sans rien', {}, { lieu: null, ageDays: 2 }),
    offerFromForm('Fermée', { contract_type: 'CDI', job_type: 'Account Executive' }, { lieu: 'Lyon', statut: 'closed' }),
  ];
  db.candidats = [{ id: 'c-self', user_id: 'user-cand', score_adn: 50, axes: {}, swipes_meta: { swiped_offer_ids: [] } }];
}

function seedCandidates() {
  seq = 0;
  db.candidats = [
    candidateFromProfile('ae', { target_job_types: ['Account Executive'], sales_style: 'hunter', years_experience: 6, desired_contracts: ['CDI'], sectors: ['SaaS et Tech'], skills: ['Closing', 'Négociation'], tools: ['HubSpot'], methodologies: ['MEDDIC'], availability: 'immediate', customer_types: ['PME', 'ETI'] }, { ville: 'Lyon', score: 88 }),
    candidateFromProfile('sdr', { target_job_types: ['SDR / BDR'], sales_style: 'farmer', years_experience: 1, desired_contracts: ['Alternance'], sectors: ['Retail'], skills: ['Cold calling'], tools: ['Lemlist', 'Apollo'], methodologies: ['SPIN'], availability: '1_month', customer_types: ['Particuliers'] }, { ville: 'Saint-Étienne', score: 72 }),
    candidateFromProfile('kam', { target_job_types: ['Key Account Manager'], sales_style: 'full', years_experience: 12, desired_contracts: ['CDI', 'Freelance'], sectors: ['Industrie'], skills: ['Gestion de portefeuille'], tools: ['Salesforce'], methodologies: ['Challenger'], availability: '3_months', customer_types: ['Grands comptes'] }, { ville: "Villeneuve-d'Ascq", score: 55 }),
    // Historiques : aucun champ structuré, ville libre ou absente, score nul.
    candidateFromProfile('legacy', {}, { ville: 'lyon (69)', score: null }),
    candidateFromProfile('noville', { target_job_types: ['Account Executive'] }, { score: 90 }),
    candidateFromProfile('anon', { target_job_types: ['Account Executive'] }, { ville: 'Lyon', score: 95, anonyme: true }),
  ];
}
const titles = (body) => body.offers.map((o) => o.titre).sort();
const users = (body) => body.candidates.map((c) => c.user_id.replace(/^u-/, '')).sort();

// ------------------------------------------------------------------ Opportunités
test('O/W. Opportunités : chaque filtre visible a un chemin backend fonctionnel (match + non-match)', async () => {
  seedOffers();
  const all = await get(offerQuery({}), 'user-cand');
  assert.equal(all.status, 200);
  assert.equal(all.body.offers.length, 6); // offre fermée toujours exclue

  // Chaque valeur de chip proposée par l'UI est acceptée par le parseur (jamais de 400).
  for (const [id, key] of [['filt-contract', 'contract_type'], ['filt-remote', 'remote_mode'], ['filt-tags', 'tags']]) {
    for (const value of chipValues(candidateHtml, id)) {
      const response = await get(offerQuery({ [key]: [value] }), 'user-cand');
      assert.equal(response.status, 200, `${id}=${value}`);
    }
  }
  for (const preset of chipValues(candidateHtml, 'filt-published')) {
    assert.equal((await get(offerQuery({ published_preset: preset }), 'user-cand')).status, 200, preset);
  }

  const cases = [
    [{ contract_type: ['CDI'] }, ['AE Lyon', 'Historique libre']], // contrat historique dérivé de `type`
    [{ contract_type: ['Alternance', 'Mission'] }, ['Mission St-Étienne', 'SDR Paris']],
    [{ contract_type: ['Freelance'] }, ['Freelance remote']],
    [{ remote_mode: ['remote'] }, ['Freelance remote']],
    [{ remote_mode: ['onsite', 'hybrid'] }, ['AE Lyon', 'Mission St-Étienne', 'SDR Paris']],
    [{ tags: ['Négociation'] }, ['Freelance remote']],
    [{ tags: ['Cold Calling', 'HubSpot'] }, ['Mission St-Étienne', 'SDR Paris']],
    [{ salary_fixed_min: 40000 }, ['AE Lyon']],
    [{ salary_fixed_min: 30000 }, ['AE Lyon', 'Mission St-Étienne']],
    [{ salary_fixed_min: 40000, include_unspecified_salary: true }, ['AE Lyon', 'Freelance remote', 'Historique libre', 'Sans rien']],
    [{ job_type: 'Account Executive' }, ['AE Lyon']],
    [{ job_type: 'Business Developer' }, ['Freelance remote']],
    [{ job_type: 'Business Dev' }, ['Historique libre']], // texte libre historique retrouvé tel quel
    [{ sector: 'SaaS et Tech' }, ['AE Lyon']],
    [{ sector: 'saas et tech' }, ['AE Lyon']], // canonicalisé
    [{ sector: 'SaaS' }, ['AE Lyon']], // Lot 7 : alias explicite validé par le produit.
    [{ published_preset: '7d' }, ['AE Lyon', 'Freelance remote', 'Sans rien']],
    [{ published_preset: '30d' }, ['AE Lyon', 'Freelance remote', 'SDR Paris', 'Sans rien']],
    [{ location: 'lyon' }, ['AE Lyon', 'Historique libre']],
    [{ location: 'Saint Etienne' }, ['Mission St-Étienne']],
    [{ location: 'Remote / Télétravail' }, ['Freelance remote']],
    [{ location: 'Tombouctou' }, []],
  ];
  for (const [patch, expected] of cases) {
    const response = await get(offerQuery(patch), 'user-cand');
    assert.equal(response.status, 200, JSON.stringify(patch));
    assert.deepEqual(titles(response.body), expected, JSON.stringify(patch));
  }
});

test('P/Q/S. Opportunités : combinaisons, NULL / valeurs absentes, filtre appliqué en SQL', async () => {
  seedOffers();
  const combos = [
    [{ contract_type: ['CDI'], location: 'Lyon' }, ['AE Lyon', 'Historique libre']],
    [{ contract_type: ['CDI'], location: 'Lyon', salary_fixed_min: 40000 }, ['AE Lyon']],
    [{ contract_type: ['CDI'], location: 'Lyon', salary_fixed_min: 40000, include_unspecified_salary: true }, ['AE Lyon', 'Historique libre']],
    [{ remote_mode: ['hybrid'], tags: ['SaaS'], job_type: 'Account Executive', sector: 'SaaS et Tech', published_preset: '7d', location: 'lyon' }, ['AE Lyon']],
    [{ remote_mode: ['remote'], location: 'Lyon' }, []],
  ];
  for (const [patch, expected] of combos) {
    assert.deepEqual(titles((await get(offerQuery(patch), 'user-cand')).body), expected, JSON.stringify(patch));
  }
  // S : une offre sans champ structuré n'apparaît que lorsque le filtre correspondant est inactif.
  const bare = 'Sans rien';
  for (const patch of [{ contract_type: ['CDI'] }, { remote_mode: ['onsite'] }, { tags: ['SaaS'] }, { salary_fixed_min: 1000 }, { job_type: 'Account Executive' }, { sector: 'Retail' }, { location: 'Lyon' }]) {
    assert.equal(titles((await get(offerQuery(patch), 'user-cand')).body).includes(bare), false, JSON.stringify(patch));
  }
  // Le filtrage a lieu dans la requête (avant limit/curseur), pas après coup.
  queryLog.length = 0;
  await get(offerQuery({ contract_type: ['CDI'], tags: ['SaaS'], location: 'Lyon', salary_fixed_min: 40000 }), 'user-cand');
  assert.ok(queryLog.some((c) => c[0] === 'in' && c[1] === 'contract_type'));
  assert.ok(queryLog.some((c) => c[0] === 'overlaps' && c[1] === 'tags'));
  assert.ok(queryLog.some((c) => c[0] === 'filter' && c[1] === 'lieu'));
  assert.ok(queryLog.some((c) => c[0] === 'or' && c[1].startsWith('salary_fixed_max.gte.40000')));
  // Les lignes ne sont jamais modifiées par un filtre (lecture seule).
  const snapshot = JSON.stringify(db.offres);
  await get(offerQuery({ location: 'Lyon', include_unspecified_salary: true, salary_fixed_min: 5 }), 'user-cand');
  assert.equal(JSON.stringify(db.offres), snapshot);
  // Case cochée sans salaire saisi : aucun paramètre parasite.
  assert.equal(new URLSearchParams(offerQuery({ include_unspecified_salary: true }).split('?')[1]).has('include_unspecified_salary'), false);
});

test('R. Opportunités : pagination par curseur stable avec filtres actifs', async () => {
  seedOffers();
  const patch = { contract_type: ['CDI', 'Alternance', 'Mission', 'Freelance'] };
  const seen = [];
  let cursor = null;
  for (let page = 0; page < 10; page += 1) {
    const response = await get(offerQuery(patch, { limit: 1, cursor }), 'user-cand');
    assert.equal(response.status, 200);
    seen.push(...response.body.offers.map((o) => o.titre));
    if (!response.body.has_more) break;
    cursor = response.body.next_cursor;
  }
  assert.deepEqual([...seen].sort(), ['AE Lyon', 'Freelance remote', 'Historique libre', 'Mission St-Étienne', 'SDR Paris']);
  assert.equal(new Set(seen).size, seen.length);
});

// ------------------------------------------------------------------ Sourcing
test('O/W. Sourcing : chaque chip visible a un chemin backend fonctionnel (match + non-match)', async () => {
  seedCandidates();
  const all = await get(candidateQuery({}), 'user-rec');
  assert.equal(all.status, 200);
  assert.equal(all.body.candidates.length, 6);

  const groups = {
    'filt-job-types': 'target_job_types', 'filt-sales-style': 'sales_style', 'filt-contracts': 'desired_contracts',
    'filt-sectors': 'sectors', 'filt-skills': 'skills', 'filt-tools': 'tools', 'filt-methodologies': 'methodologies',
    'filt-availability': 'availability', 'filt-customer-types': 'customer_types',
  };
  // W : toute valeur proposée par l'UI est acceptée par le parseur et retrouve un
  // profil qui l'a enregistrée via le vrai chemin d'écriture du profil.
  for (const [id, key] of Object.entries(groups)) {
    const values = chipValues(recruiterHtml, id);
    assert.ok(values.length >= 3, id);
    for (const value of values) {
      const single = key === 'sales_style' || key === 'availability';
      db.candidats.push(candidateFromProfile(`probe-${key}`, { [key]: single ? value : [value] }, { ville: 'Probe', score: 1 }));
      const response = await get(candidateQuery({ [key]: [value], location: 'Probe' }), 'user-rec');
      db.candidats.pop();
      assert.equal(response.status, 200, `${id}=${value}`);
      assert.ok(users(response.body).includes(`probe-${key}`), `${id}=${value} : valeur UI écrite puis non retrouvée`);
    }
  }
  for (const score of chipValues(recruiterHtml, 'filt-score-adn')) {
    assert.equal((await get(candidateQuery({ score_adn_min: Number(score) }), 'user-rec')).status, 200, score);
  }

  const cases = [
    [{ score_adn_min: 85 }, ['ae', 'anon', 'noville']], // l'anonyme reste visible : seul le filtre lieu l'exclut
    [{ target_job_types: ['Account Executive'] }, ['ae', 'anon', 'noville']],
    [{ sales_style: ['farmer', 'full'] }, ['kam', 'sdr']],
    [{ years_experience_min: 5 }, ['ae', 'kam']],
    [{ desired_contracts: ['Freelance'] }, ['kam']],
    [{ sectors: ['Retail'] }, ['sdr']],
    [{ skills: ['Cold calling'] }, ['sdr']],
    [{ tools: ['Salesforce', 'HubSpot'] }, ['ae', 'kam']],
    [{ methodologies: ['SPIN'] }, ['sdr']],
    [{ availability: ['immediate'] }, ['ae']],
    [{ customer_types: ['Grands comptes'] }, ['kam']],
    [{ location: 'lyon' }, ['ae', 'legacy']], // anonyme exclu, historique « lyon (69) » retrouvé
    [{ location: 'Saint Etienne' }, ['sdr']],
    [{ location: "Villeneuve-d'Ascq" }, ['kam']],
    [{ location: 'Tombouctou' }, []],
  ];
  for (const [patch, expected] of cases) {
    const response = await get(candidateQuery(patch), 'user-rec');
    assert.equal(response.status, 200, JSON.stringify(patch));
    assert.deepEqual(users(response.body), expected, JSON.stringify(patch));
  }
});

test('P/Q/S/V. Sourcing : combinaisons, NULL, pagination, score inchangé par les filtres', async () => {
  seedCandidates();
  const combos = [
    [{ target_job_types: ['Account Executive'], location: 'Lyon' }, ['ae']],
    [{ target_job_types: ['Account Executive'], score_adn_min: 85, years_experience_min: 5 }, ['ae']],
    [{ desired_contracts: ['CDI'], sectors: ['Industrie'], location: 'Lyon' }, []],
  ];
  for (const [patch, expected] of combos) {
    assert.deepEqual(users((await get(candidateQuery(patch), 'user-rec')).body), expected, JSON.stringify(patch));
  }
  // S : profil historique sans champ structuré exclu dès qu'un filtre structuré est actif.
  for (const patch of [{ score_adn_min: 50 }, { target_job_types: ['SDR / BDR'] }, { sales_style: ['hunter'] }, { years_experience_min: 0 }, { tools: ['HubSpot'] }, { availability: ['immediate'] }]) {
    assert.equal(users((await get(candidateQuery(patch), 'user-rec')).body).includes('legacy'), false, JSON.stringify(patch));
  }
  // R : pagination par curseur avec filtre actif, sans doublon ni perte.
  const seen = [];
  let cursor = null;
  for (let page = 0; page < 10; page += 1) {
    const response = await get(candidateQuery({ target_job_types: ['Account Executive', 'SDR / BDR', 'Key Account Manager'] }, { cursor, limit: '1' }), 'user-rec');
    assert.equal(response.status, 200);
    seen.push(...users(response.body));
    if (!response.body.has_more) break;
    cursor = response.body.next_cursor;
  }
  assert.deepEqual([...seen].sort(), ['ae', 'anon', 'kam', 'noville', 'sdr']);
  // V : le score de compatibilité affiché est identique avec et sans filtre.
  const without = await get(candidateQuery({}), 'user-rec');
  const withFilters = await get(candidateQuery({ location: 'lyon', target_job_types: ['Account Executive'], score_adn_min: 50 }), 'user-rec');
  assert.equal(withFilters.body.candidates.length, 1);
  for (const card of withFilters.body.candidates) {
    const reference = without.body.candidates.find((c) => c.id === card.id);
    assert.equal(card.m, reference.m);
    assert.equal(card.m, compatibilityScore(db.candidats.find((c) => c.id === card.id).axes, MATCHING));
  }
  const snapshot = JSON.stringify(db.candidats);
  await get(candidateQuery({ location: 'lyon', skills: ['Closing'] }), 'user-rec');
  assert.equal(JSON.stringify(db.candidats), snapshot);
});

test('W. aucun filtre d’UI orphelin : chaque paramètre émis est lu par le parseur backend', () => {
  const offerParams = candidateSandbox.h.buildDeckQueryParams({
    ...candidateSandbox.h.emptyDeckFilters(), contract_type: ['CDI'], remote_mode: ['remote'], tags: ['SaaS'],
    salary_fixed_min: 1, include_unspecified_salary: true, job_type: 'x', sector: 'y', published_preset: '7d', location: 'Lyon',
  }, { limit: 20 });
  const offerParser = fs.readFileSync(path.join(__dirname, '../utils/offerDeckQuery.js'), 'utf8');
  for (const key of offerParams.keys()) assert.match(offerParser, new RegExp(`query\\.${key}\\b`), `offres: ${key}`);
  const candParams = recruiterSandbox.h.buildCandidateDeckParams(null, {
    score_adn_min: 1, years_experience_min: 1, target_job_types: ['a'], sales_style: ['a'], desired_contracts: ['a'], sectors: ['a'],
    skills: ['a'], tools: ['a'], methodologies: ['a'], availability: ['a'], customer_types: ['a'], location: 'Lyon',
  });
  const candParser = fs.readFileSync(path.join(__dirname, '../utils/candidateDeckQuery.js'), 'utf8');
  for (const key of candParams.keys()) {
    if (key === 'matching') continue; // lu par la route pour le score, pas un filtre
    assert.match(candParser, new RegExp(`query\\.${key}\\b`), `candidats: ${key}`);
  }
});

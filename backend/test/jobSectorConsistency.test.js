// Lot 7 — cohérence métiers / secteurs : READ OLD / WRITE CLEAN.
// Vrais parsers, vrais helpers, vraies routes Express (harnais PostgREST), vraies
// fonctions de l'UI extraites des pages.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createDeckHarness } = require('./helpers/deckHarness');

const { db, get, request, queryLog } = createDeckHarness();
const { normalizeOfferStructuredFields } = require('../utils/offerWrite');
const { normalizeCandidateProfileStructuredFields } = require('../utils/candidateProfileWrite');
const { JOB_TYPES, SECTORS, LEGACY_SECTOR_ALIASES, canonicalizeSector } = require('../utils/yannisTaxonomies');
const { parseOfferDeckQuery, offerMatchesDeckFilters, applySupabaseDeckFilters } = require('../utils/offerDeckQuery');
const { parseCandidateDeckQuery, candidateMatchesDeckFilters, compareCandidatesByScore } = require('../utils/candidateDeckQuery');
const jobSector = require('../utils/jobSectorFilter');
const { compatibilityScore } = require('../utils/recruiterMatching');

const ROOT = path.resolve(__dirname, '../..');
const candidateHtml = fs.readFileSync(path.join(ROOT, 'frontend/_spaces/candidat.html'), 'utf8');
const recruiterHtml = fs.readFileSync(path.join(ROOT, 'frontend/_spaces/recruteur.html'), 'utf8');

function extract(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, signature);
  let depth = 0;
  // Comptage après la signature : un paramètre par défaut (`p = {}`) n'ouvre pas le corps.
  for (let i = start + signature.length; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(signature);
}
function extractUntil(source, signature, terminator) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, signature);
  const end = source.indexOf(terminator, start);
  assert.ok(end > start, terminator);
  return source.slice(start, end + terminator.length);
}

// Paramètres de requête construits par les vraies fonctions des pages.
const ui = { URLSearchParams, Date, MATCHING: { closing: 80 }, DECK_FILTERS: {} };
vm.runInNewContext([
  extract(candidateHtml, 'function normalizeLocationInput(value)'),
  extract(candidateHtml, 'function publishedSinceFromPreset(preset, now = new Date())'),
  extract(candidateHtml, 'function emptyDeckFilters()'),
  extract(candidateHtml, 'function buildDeckQueryParams(filters, options)'),
  extract(recruiterHtml, 'function buildCandidateDeckParams(cursor, filters)'),
].join('\n'), ui);

const offerUrl = (patch, cursor) => `/offres/deck?${ui.buildDeckQueryParams({ ...ui.emptyDeckFilters(), ...patch }, { limit: 50, cursor })}`;
function candidateUrl(patch, cursor = null, limit = 50) {
  const params = ui.buildCandidateDeckParams(cursor, patch);
  params.set('limit', String(limit));
  return `/candidats/deck?${params}`;
}
const uuid = (i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const SELF = { id: 'self', user_id: 'user-cand', axes: {} };

function seedOffers(values) {
  db.offres = values.map((row, i) => ({ id: `offer-${i}`, statut: 'active', created_at: '2026-01-01', ...row }));
  db.candidats = [SELF];
}
function seedCandidates(rows) {
  db.candidats = rows.map((row, i) => ({ id: uuid(i), user_id: `person-${i}`, axes: { closing: 75, meta: {} }, score_adn: 75, ...row }));
  db.candidats.push(SELF);
}
async function offerIds(patch) {
  const response = await get(offerUrl(patch), 'user-cand');
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.offers.map((row) => row.id).sort();
}
async function candidateIds(patch) {
  const response = await get(candidateUrl(patch), 'user-rec');
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.candidates.map((row) => row.user_id).sort();
}

// ---------------------------------------------------------------------------
// WRITE CLEAN
// ---------------------------------------------------------------------------

test('Lot 7 alias secteur : seul « SaaS » est ajouté, aucune autre équivalence', () => {
  assert.deepEqual(Object.keys(LEGACY_SECTOR_ALIASES).sort(), [
    'assurance / banque', 'assurance et banque', 'saas', 'saas / tech', 'saas et tech',
  ]);
  assert.equal(canonicalizeSector('SaaS'), 'SaaS et Tech');
  assert.equal(canonicalizeSector(' saas '), 'SaaS et Tech');
  assert.equal(canonicalizeSector('SaaS / Tech'), 'SaaS et Tech'); // alias préexistant
  for (const free of ['Tech', 'Logiciel', 'Informatique', 'Industrie / Manufacturing', 'SaaS B2B', 'Saas-Tech']) {
    assert.equal(canonicalizeSector(free), null, free);
  }
  assert.deepEqual([...SECTORS], ['SaaS et Tech', 'Industrie', 'BTP', 'Immobilier', 'Assurance et Banque',
    'Retail', 'Services B2B', 'Télécom', 'Santé', 'Automobile']);
});

test('Lot 7 écritures : alias connu → canonique, canonique conservé, inconnu conservé tel quel', () => {
  const profile = normalizeCandidateProfileStructuredFields({
    target_job_types: ['BDR', 'SDR / BDR', 'Growth Hacker Sales', 'ae'],
    sectors: ['SaaS', 'SaaS / Tech', 'SaaS et Tech', 'Tech', 'Logiciel', 'Informatique', 'Industrie / Manufacturing'],
  });
  // « ae » est un ID ADN, pas un alias déclaré : jamais converti (contrat jobTaxonomy).
  assert.deepEqual(profile.target_job_types, ['SDR / BDR', 'Growth Hacker Sales', 'ae']);
  assert.deepEqual(profile.sectors, ['SaaS et Tech', 'Tech', 'Logiciel', 'Informatique', 'Industrie / Manufacturing']);
  assert.deepEqual(normalizeCandidateProfileStructuredFields({ target_job_types: ['SDR / BDR'] }).target_job_types, ['SDR / BDR']);

  const offer = (job_type, sector) => normalizeOfferStructuredFields({ type: 'CDI', job_type, sector });
  assert.equal(offer('BDR', 'SaaS').job_type, 'SDR / BDR');
  assert.equal(offer('BDR', 'SaaS').sector, 'SaaS et Tech');
  assert.equal(offer('SDR / BDR', 'SaaS et Tech').job_type, 'SDR / BDR');
  assert.equal(offer('Growth Hacker Sales', 'Tech').job_type, 'Growth Hacker Sales');
  assert.equal(offer('Growth Hacker Sales', 'Tech').sector, 'Tech');
  assert.equal(offer('Solutions Engineer', 'Logiciel').job_type, 'Avant-vente / Sales Engineer'); // alias déclaré
  assert.equal(offer('ae', 'Informatique').job_type, 'ae');
});

test('Lot 7 écritures : PUT /candidats/profil (vraie route) écrit les valeurs canoniques', async () => {
  db.candidats = [{ id: 'cand-put', user_id: 'user-cand', target_job_types: [], sectors: [], axes: { meta: { ville: 'Lyon' } } }];
  const response = await request('PUT', '/candidats/profil', 'user-cand', {
    target_job_types: ['BDR', 'Growth Hacker Sales'], sectors: ['SaaS', 'Logiciel'],
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(db.candidats[0].target_job_types, ['SDR / BDR', 'Growth Hacker Sales']);
  assert.deepEqual(db.candidats[0].sectors, ['SaaS et Tech', 'Logiciel']);
});

// ---------------------------------------------------------------------------
// READ OLD — métiers
// ---------------------------------------------------------------------------

test('Lot 7 métier : BDR historique ↔ SDR / BDR, alias sans élargissement, inconnu exact (offres + sourcing)', async () => {
  const jobs = ['BDR', 'SDR / BDR', 'sdr', 'Growth Hacker Sales', 'SDR / BDR Senior', null];
  seedOffers(jobs.map((job_type) => ({ job_type })));
  const chip = recruiterHtml.match(/data-filter-value="(SDR \/ BDR)"/)[1];
  // Canonique → famille déclarée (historique + canonique), jamais une sous-chaîne.
  assert.deepEqual(await offerIds({ job_type: chip }), ['offer-0', 'offer-1', 'offer-2']);
  // Alias → canonique + cet alias (casse/espaces de bord ignorés), pas l'alias frère « SDR ».
  assert.deepEqual(await offerIds({ job_type: 'BDR' }), ['offer-0', 'offer-1']);
  assert.deepEqual(await offerIds({ job_type: ' bDr ' }), ['offer-0', 'offer-1']);
  assert.deepEqual(await offerIds({ job_type: 'Growth Hacker Sales' }), ['offer-3']);
  assert.deepEqual(await offerIds({ job_type: 'growth hacker sales' }), ['offer-3']);
  assert.deepEqual(await offerIds({ job_type: 'Growth' }), []);

  seedCandidates(jobs.map((job) => ({ target_job_types: job == null ? null : [job] })));
  assert.deepEqual(await candidateIds({ target_job_types: [chip] }), ['person-0', 'person-1', 'person-2']);
  assert.deepEqual(await candidateIds({ target_job_types: ['BDR'] }), ['person-0', 'person-1']);
  assert.deepEqual(await candidateIds({ target_job_types: ['Growth Hacker Sales'] }), ['person-3']);
  assert.deepEqual(await candidateIds({ target_job_types: [chip, 'Growth Hacker Sales'] }), ['person-0', 'person-1', 'person-2', 'person-3']);
});

test('Lot 7 métier : Sales Engineer ne retrouve pas Solutions Engineer (et inversement)', async () => {
  const jobs = ['Sales Engineer', 'Solutions Engineer', 'Avant-vente / Sales Engineer', 'Sales Engineer IT'];
  seedOffers(jobs.map((job_type) => ({ job_type })));
  seedCandidates(jobs.map((job) => ({ target_job_types: [job] })));
  assert.deepEqual(await offerIds({ job_type: 'Sales Engineer' }), ['offer-0', 'offer-2']);
  assert.deepEqual(await offerIds({ job_type: 'Solutions Engineer' }), ['offer-1', 'offer-2']);
  assert.deepEqual(await offerIds({ job_type: 'Avant-vente / Sales Engineer' }), ['offer-0', 'offer-1', 'offer-2', 'offer-3']);
  assert.deepEqual(await candidateIds({ target_job_types: ['Sales Engineer'] }), ['person-0', 'person-2']);
  assert.deepEqual(await candidateIds({ target_job_types: ['Solutions Engineer'] }), ['person-1', 'person-2']);
  assert.deepEqual(await candidateIds({ target_job_types: ['Avant-vente / Sales Engineer'] }), ['person-0', 'person-1', 'person-2', 'person-3']);
});

test('Lot 7 métier : règle déterministe (jetons exacts), ni ID ADN, ni accents repliés, ni proximité', () => {
  assert.deepEqual(jobSector.filterTokens(['BDR'], 'job'), ['SDR / BDR', 'BDR']);
  assert.deepEqual(jobSector.filterTokens(['SDR / BDR'], 'job'), ['SDR / BDR', ...JOB_TYPES.find((j) => j.id === 'sdr').aliases]);
  // Représentation du parser d'offres pour une saisie d'alias : [libellé, alias] → même règle.
  assert.deepEqual(parseOfferDeckQuery({ job_type: 'BDR' }).job_types, ['SDR / BDR', 'BDR']);
  assert.deepEqual(jobSector.filterTokens(parseOfferDeckQuery({ job_type: 'BDR' }).job_types, 'job'), ['SDR / BDR', 'BDR']);
  assert.deepEqual(jobSector.filterTokens(['ae'], 'job'), ['ae']); // ID ADN = texte inconnu
  assert.equal(jobSector.matches('Account Executive', ['ae'], 'job'), false);
  assert.equal(jobSector.matches("Charge d'affaires", ["Chargé d'affaires"], 'job'), false);
  assert.equal(jobSector.matches('KAM', ['Key Account Manager'], 'job'), false);
  assert.equal(jobSector.matches(' key account manager (kam) ', ['Key Account Manager'], 'job'), true);
});

// ---------------------------------------------------------------------------
// READ OLD — secteurs
// ---------------------------------------------------------------------------

test('Lot 7 secteur : SaaS ↔ SaaS et Tech ↔ SaaS / Tech, libres distincts, aucun substring (offres + sourcing)', async () => {
  const sectors = ['SaaS', 'SaaS et Tech', 'SaaS / Tech', ' saas ', 'Tech', 'Logiciel', 'Informatique',
    'Industrie / Manufacturing', 'Industrie', 'Smart Building', 'Santé', null, ''];
  seedOffers(sectors.map((sector) => ({ sector })));
  const saas = ['offer-0', 'offer-1', 'offer-2', 'offer-3'];
  for (const sector of ['SaaS', 'SaaS et Tech', 'saas et tech', 'SaaS / Tech']) {
    assert.deepEqual(await offerIds({ sector }), saas, sector);
  }
  for (const [sector, index] of [['Tech', 4], ['Logiciel', 5], ['Informatique', 6], ['Industrie / Manufacturing', 7], ['Industrie', 8], ['santé', 10]]) {
    assert.deepEqual(await offerIds({ sector }), [`offer-${index}`], sector);
  }
  assert.deepEqual(await offerIds({ sector: 'Art' }), []);
  assert.deepEqual(await offerIds({ sector: 'sante' }), []); // pas de repli d'accents (règle taxonomie)
  assert.equal((await offerIds({})).length, sectors.length);

  seedCandidates(sectors.map((sector) => ({ sectors: sector == null ? null : [sector] })));
  const saasPeople = ['person-0', 'person-1', 'person-2', 'person-3'];
  for (const sector of ['SaaS', 'SaaS et Tech', 'SaaS / Tech']) {
    assert.deepEqual(await candidateIds({ sectors: [sector] }), saasPeople, sector);
  }
  for (const [sector, index] of [['Tech', 4], ['Logiciel', 5], ['Informatique', 6], ['Industrie / Manufacturing', 7], ['Industrie', 8]]) {
    assert.deepEqual(await candidateIds({ sectors: [sector] }), [`person-${index}`], sector);
  }
  assert.deepEqual(await candidateIds({ sectors: ['Art'] }), []);
  assert.deepEqual(await candidateIds({ sectors: ['Industrie', 'Tech'] }), ['person-4', 'person-8']);
});

// ---------------------------------------------------------------------------
// Motif SQL (PostgREST imatch) : littéral, ancré, parité JS, taille bornée
// ---------------------------------------------------------------------------

test('Lot 7 SQL offres : imatch ancré et littéral, parité avec le prédicat JS, URL bornée', () => {
  for (const [key, value] of [['sector', 'SaaS'], ['sector', 'Art'], ['sector', 'A.B'], ['sector', 'x|y'],
    ['sector', '(test)'], ['sector', '[abc]'], ['sector', 'x*'], ['sector', 'x$'], ['sector', 'a\\b'],
    ['sector', 'Télécom'], ['job_type', 'BDR'], ['job_type', 'SDR / BDR'], ['job_type', "Chargé d'affaires"]]) {
    const filters = parseOfferDeckQuery({ [key]: value });
    const calls = [];
    const q = { filter(column, op, pattern) { calls.push({ column, op, pattern }); return this; } };
    for (const method of ['eq', 'neq', 'in', 'is', 'gte', 'lte', 'lt', 'or', 'not', 'overlaps']) q[method] = function () { return this; };
    applySupabaseDeckFilters(q, filters);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].op, 'imatch');
    const regex = new RegExp(calls[0].pattern, 'i');
    const column = key === 'sector' ? 'sector' : 'job_type';
    for (const stored of [value, value.toUpperCase(), ` ${value} `, `prefix ${value}`, `${value} suffix`,
      'Smart Building', 'SaaS et Tech', 'BDR', 'SDR', 'TÉLÉCOM']) {
      assert.equal(regex.test(stored), offerMatchesDeckFilters({ [column]: stored }, filters), `${value} / ${stored}`);
    }
    assert.equal(regex.test(`prefix ${value}`), false);
    assert.equal(regex.test(`${value} suffix`), false);
  }
  // Taille d'URL bornée (le motif à classes accents/casse initial faisait jusqu'à ~12 Ko
  // encodés pour UN métier et ~94 Ko pour tous) : une famille < 2 Ko, toutes < 16 Ko.
  const encoded = (values, kind) => encodeURIComponent(jobSector.exactPattern(values, kind)).length;
  for (const job of JOB_TYPES) assert.ok(encoded([job.label], 'job') < 2000, `${job.label}: ${encoded([job.label], 'job')}`);
  assert.ok(encoded(JOB_TYPES.map((job) => job.label), 'job') < 16000);
  assert.ok(encoded([...SECTORS], 'sector') < 1000);
});

// ---------------------------------------------------------------------------
// Privacy / anonymat
// ---------------------------------------------------------------------------

test('Lot 7 privacy : contrat d\'anonymat inchangé, la ville d\'un anonyme reste non sondable', async () => {
  seedCandidates([
    { target_job_types: ['BDR'], sectors: ['SaaS'], axes: { closing: 75, meta: { ville: 'Lyon', anonyme: true } }, nom: 'Secret', prenom: 'Anne' },
    { target_job_types: ['BDR'], sectors: ['SaaS'], axes: { closing: 75, meta: { ville: 'Lyon' } }, nom: 'Public', prenom: 'Paul' },
  ]);
  // Métiers / secteurs : préférences de matching jamais affichées sur une carte (anonyme
  // ou non) ; filtrables pour tous comme avant le Lot 7 (seule la ville est protégée).
  for (const patch of [{ target_job_types: ['SDR / BDR'] }, { sectors: ['SaaS et Tech'] }, { target_job_types: ['BDR'], sectors: ['SaaS'] }]) {
    assert.deepEqual(await candidateIds(patch), ['person-0', 'person-1']);
  }
  const response = await get(candidateUrl({ target_job_types: ['SDR / BDR'] }), 'user-rec');
  for (const card of response.body.candidates) {
    assert.equal(Object.hasOwn(card, 'target_job_types'), false);
    assert.equal(Object.hasOwn(card, 'sectors'), false);
  }
  const anonCard = response.body.candidates.find((card) => card.user_id === 'person-0');
  assert.equal(anonCard.anon, true);
  assert.equal(anonCard.name, 'Candidat anonyme');
  assert.equal(anonCard.location, '');
  assert.ok(!JSON.stringify(anonCard).includes('Lyon'));
  assert.ok(!JSON.stringify(anonCard).includes('Secret'));
  // Essais successifs ville × métier × secteur : l'anonyme n'apparaît jamais sous un filtre
  // lieu, donc aucune combinaison ne révèle sa ville.
  for (const location of ['Lyon', 'Paris', 'lyon']) {
    for (const extra of [{}, { target_job_types: ['SDR / BDR'] }, { sectors: ['SaaS'] }, { target_job_types: ['BDR'], sectors: ['SaaS et Tech'] }]) {
      const ids = await candidateIds({ location, ...extra });
      assert.equal(ids.includes('person-0'), false, `${location} ${JSON.stringify(extra)}`);
      assert.deepEqual(ids, location.toLowerCase() === 'lyon' ? ['person-1'] : []);
    }
  }
});

// ---------------------------------------------------------------------------
// Pagination / scan borné
// ---------------------------------------------------------------------------

async function paginate(patch, limit) {
  const seen = [];
  const cursors = new Set();
  let cursor = null;
  let pages = 0;
  for (;;) {
    const response = await get(candidateUrl(patch, cursor, limit), 'user-rec');
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.ok(response.body.candidates.length <= limit);
    seen.push(...response.body.candidates.map((row) => row.user_id));
    pages += 1;
    assert.ok(pages < 200, 'pagination sans fin');
    if (!response.body.has_more) { assert.equal(response.body.next_cursor, null); break; }
    assert.ok(response.body.next_cursor && !cursors.has(response.body.next_cursor), 'curseur figé');
    cursors.add(response.body.next_cursor);
    cursor = response.body.next_cursor;
  }
  return { seen, pages };
}
function expectedOrder(patch) {
  const params = Object.fromEntries(ui.buildCandidateDeckParams(null, patch));
  const filters = parseCandidateDeckQuery(params);
  return db.candidats.filter((row) => row.user_id !== 'user-cand' && candidateMatchesDeckFilters(row, filters))
    .sort(compareCandidatesByScore).map((row) => row.user_id);
}

test('Lot 7 pagination : scan borné creux, historique + canonique, pages multiples, sans perte ni doublon', async () => {
  const jobAt = { 3: ['BDR'], 97: ['SDR / BDR'], 180: ['sdr', 'Other'], 181: ['Growth Hacker Sales'], 340: ['BDR'], 399: ['SDR / BDR'] };
  const sectorAt = { 3: ['SaaS'], 97: ['Tech'], 180: ['SaaS et Tech'], 340: ['SaaS / Tech'], 399: ['SaaS'] };
  seedCandidates(Array.from({ length: 400 }, (_, i) => ({
    target_job_types: jobAt[i] || ['Other'],
    sectors: sectorAt[i] || ['Retail'],
    // Scores avec égalités et NULL (phase de curseur « n ») : ordre stable score DESC, id DESC.
    score_adn: i % 11 === 0 ? null : 40 + (i % 9),
    axes: { closing: 75, meta: { ville: i === 340 ? 'Lyon' : i === 399 ? 'Paris' : '' } },
  })));
  const cases = [
    [{ target_job_types: ['SDR / BDR'] }, 5],
    [{ target_job_types: ['BDR'] }, 4],
    [{ target_job_types: ['SDR / BDR'], sectors: ['SaaS et Tech'] }, 4],
    [{ target_job_types: ['SDR / BDR'], sectors: ['SaaS'], location: 'Lyon' }, 1],
    [{ target_job_types: ['SDR / BDR'], score_adn_min: 45 }, null],
    [{ target_job_types: ['Inexistant'] }, 0],
    [{ sectors: ['Art'] }, 0],
  ];
  for (const [patch, count] of cases) {
    const expected = expectedOrder(patch);
    if (count != null) assert.equal(expected.length, count, JSON.stringify(patch));
    for (const limit of [1, 2, 3, 20]) {
      const { seen } = await paginate(patch, limit);
      assert.deepEqual(seen, expected, `${JSON.stringify(patch)} limit=${limit}`);
      assert.equal(new Set(seen).size, seen.length, 'doublon');
    }
  }
  // Aucun overlap SQL exact sur target_job_types / sectors (sinon l'historique serait perdu).
  queryLog.length = 0;
  await get(candidateUrl({ target_job_types: ['SDR / BDR'], sectors: ['SaaS'] }), 'user-rec');
  assert.equal(queryLog.some((call) => call[0] === 'overlaps' && ['target_job_types', 'sectors'].includes(call[1])), false);
});

test('Lot 7 pagination : page dense remplie exactement, curseur de reprise sur la dernière ligne inspectée', async () => {
  seedCandidates(Array.from({ length: 30 }, (_, i) => ({
    target_job_types: [i % 2 ? 'BDR' : 'SDR / BDR'], sectors: ['SaaS'], score_adn: 90 - i,
  })));
  const first = await get(candidateUrl({ target_job_types: ['SDR / BDR'] }, null, 4), 'user-rec');
  assert.deepEqual(first.body.candidates.map((c) => c.user_id), ['person-0', 'person-1', 'person-2', 'person-3']);
  assert.equal(first.body.has_more, true);
  const second = await get(candidateUrl({ target_job_types: ['SDR / BDR'] }, first.body.next_cursor, 4), 'user-rec');
  assert.deepEqual(second.body.candidates.map((c) => c.user_id), ['person-4', 'person-5', 'person-6', 'person-7']);
});

// ---------------------------------------------------------------------------
// Profil : valeur inconnue affichée, conservée, retirable (vraie UI + vraies routes)
// ---------------------------------------------------------------------------

function loadProfileEditor() {
  const elements = {};
  const makeEl = (id) => ({
    id, value: '', innerHTML: '', textContent: '', style: {}, disabled: false,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  });
  const toasts = [];
  const ctx = {
    console,
    document: {
      getElementById: (id) => (elements[id] ||= makeEl(id)),
      querySelector: () => null,
    },
    localStorage: { setItem() {}, getItem() { return null; } },
    toast: (message) => toasts.push(message),
    profileDisplayName: () => '', profileInitials: () => '', renderProfileAvatar() {},
    renderProfileCompetences() {}, renderProfilePrefs() {},
    api: async (method, url, body) => {
      const response = await request(method, url, 'user-cand', body);
      if (response.status >= 400) throw new Error(JSON.stringify(response.body));
      return response.body;
    },
  };
  vm.runInNewContext([
    'var PROFILE_SAVE_IN_FLIGHT = false, SOFT_COMPETENCES_DIRTY = false, EDIT_COMPETENCES = {}, USER = null,',
    '  PROFILE_AVATAR_URL = "", PROFILE_COMPETENCES_BASE = {}, MY_SKILLS_FLAT = null;',
    extract(candidateHtml, "function esc(text = '')"),
    extractUntil(candidateHtml, 'const YANNIS_SKILLS = Object.freeze([', ']);'),
    extractUntil(candidateHtml, 'const PROFILE_PREF_SUGGESTIONS = Object.freeze({', '\n});'),
    extractUntil(candidateHtml, 'let EDIT_PREFS = {', '\n};'),
    extract(candidateHtml, 'function emptyEditPrefs()'),
    extract(candidateHtml, 'function togglePrefMulti(key, value, el)'),
    extract(candidateHtml, 'function setPrefSingle(key, value, el)'),
    extract(candidateHtml, 'function buildPrefChipHtml(key, options, selected, mode)'),
    extract(candidateHtml, 'function buildPrefsEditor(p = {})'),
    extract(candidateHtml, 'async function saveProfileEdit()'),
    'globalThis.editPrefs = () => EDIT_PREFS;',
  ].join('\n'), ctx);
  const decode = (text) => text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  function chips(id) {
    return [...elements[id].innerHTML.matchAll(/<button type="button" class="form-chip( on)?"( title="[^"]*")? onclick="([^"]*)">([^<]*)<\/button>/g)]
      .map(([, on, title, onclick, label]) => ({ on: Boolean(on), extra: Boolean(title), onclick: decode(onclick), label: decode(label) }));
  }
  function click(id, label) {
    const chip = chips(id).find((c) => c.label === label);
    assert.ok(chip, `chip absente : ${label}`);
    ctx.__el = makeEl('chip');
    vm.runInContext(`(function () { ${chip.onclick} }).call(__el)`, ctx);
  }
  return { ctx, elements, chips, click, toasts };
}

test('Lot 7 profil : valeur inconnue affichée, conservée au chargement/sauvegarde, puis retirée explicitement', async () => {
  db.candidats = [{
    id: 'cand-ui', user_id: 'user-cand', prenom: 'Ada', nom: 'L', axes: { meta: { ville: 'Lyon' } },
    target_job_types: ['BDR', 'Growth Hacker Sales'], sectors: ['SaaS', 'Secteur Legacy'],
  }];
  // Chargement : lecture seule, aucune écriture ; connu affiché canonique, inconnu tel quel.
  const loaded = await get('/candidats/profil', 'user-cand');
  assert.equal(loaded.status, 200);
  assert.deepEqual(loaded.body.target_job_types, ['SDR / BDR', 'Growth Hacker Sales']);
  assert.deepEqual(loaded.body.sectors, ['SaaS et Tech', 'Secteur Legacy']);
  assert.deepEqual(db.candidats[0].target_job_types, ['BDR', 'Growth Hacker Sales']);

  const editor = loadProfileEditor();
  editor.ctx.buildPrefsEditor(loaded.body);
  const jobChips = editor.chips('edit-target-job-types');
  assert.deepEqual(jobChips.filter((c) => c.on).map((c) => c.label), ['SDR / BDR', 'Growth Hacker Sales']);
  assert.deepEqual(jobChips.filter((c) => c.extra).map((c) => c.label), ['Growth Hacker Sales']);
  assert.equal(jobChips.length, JOB_TYPES.filter((job) => job.active).length + 1);
  assert.deepEqual(editor.chips('edit-sectors').filter((c) => c.extra && c.on).map((c) => c.label), ['Secteur Legacy']);

  // Sauvegarde sans toucher : l'inconnu n'est jamais supprimé silencieusement.
  const field = (id, value) => { editor.ctx.document.getElementById(id).value = value; };
  field('edit-prenom', 'Ada');
  field('edit-nom', 'L');
  field('edit-ville', 'Lyon');
  await editor.ctx.saveProfileEdit();
  assert.deepEqual(editor.toasts, ['Profil mis à jour']);
  assert.deepEqual(db.candidats[0].target_job_types, ['SDR / BDR', 'Growth Hacker Sales']);
  assert.deepEqual(db.candidats[0].sectors, ['SaaS et Tech', 'Secteur Legacy']);

  // Retrait explicite (vrai onclick de la chip) puis sauvegarde.
  editor.click('edit-target-job-types', 'Growth Hacker Sales');
  editor.click('edit-sectors', 'Secteur Legacy');
  assert.deepEqual([...editor.ctx.editPrefs().target_job_types], ['SDR / BDR']);
  await editor.ctx.saveProfileEdit();
  assert.deepEqual(db.candidats[0].target_job_types, ['SDR / BDR']);
  assert.deepEqual(db.candidats[0].sectors, ['SaaS et Tech']);
  const reloaded = await get('/candidats/profil', 'user-cand');
  assert.deepEqual(reloaded.body.target_job_types, ['SDR / BDR']);
  assert.deepEqual(reloaded.body.sectors, ['SaaS et Tech']);
});

test('Lot 7 profil : valeur inconnue hostile échappée (pas d\'injection via la chip)', () => {
  const editor = loadProfileEditor();
  const hostile = 'Growth " onmouseover="alert(1)';
  editor.ctx.buildPrefsEditor({ target_job_types: [hostile], sectors: ["Secteur ' </button><img>"] });
  const html = editor.elements['edit-target-job-types'].innerHTML;
  assert.ok(!html.includes(' onmouseover="'));
  assert.ok(!editor.elements['edit-sectors'].innerHTML.includes('<img>'));
  const chip = editor.chips('edit-target-job-types').find((c) => c.extra);
  assert.equal(chip.label, hostile);
  editor.click('edit-target-job-types', hostile);
  assert.deepEqual([...editor.ctx.editPrefs().target_job_types], []);
});

// ---------------------------------------------------------------------------
// Matching / UI
// ---------------------------------------------------------------------------

test('Lot 7 matching : filtres et écritures canoniques ne changent ni axes ni score', async () => {
  seedCandidates([{ target_job_types: ['BDR'], sectors: ['SaaS'], axes: { closing: 75, resilience: 80, meta: {} } }]);
  const before = await get(candidateUrl({}), 'user-rec');
  const snapshot = JSON.stringify(db.candidats[0]);
  const filtered = await get(candidateUrl({ target_job_types: ['SDR / BDR'], sectors: ['SaaS et Tech'] }), 'user-rec');
  assert.equal(filtered.body.candidates[0].m, before.body.candidates[0].m);
  assert.equal(JSON.stringify(db.candidats[0]), snapshot); // lecture/filtre : aucune écriture
  const score = compatibilityScore(db.candidats[0].axes, { closing: 80 });
  Object.assign(db.candidats[0], normalizeCandidateProfileStructuredFields(db.candidats[0]));
  assert.equal(compatibilityScore(db.candidats[0].axes, { closing: 80 }), score);
});

test('Lot 7 UI : suggestions métier/secteur issues des zones générées depuis la taxonomie', () => {
  assert.match(candidateHtml, /id="filt-job-type" list="filter-job-suggestions"/);
  assert.match(candidateHtml, /id="filt-sector" list="filter-sector-suggestions"/);
  assert.match(candidateHtml, /\['filter-job-suggestions', PROFILE_PREF_SUGGESTIONS\.target_job_types\]/);
  assert.match(candidateHtml, /\['filter-sector-suggestions', PROFILE_PREF_SUGGESTIONS\.sectors\]/);
  assert.match(recruiterHtml, /id="of-job-type" list="offer-job-suggestions"/);
  assert.match(recruiterHtml, /id="of-sector" list="offer-sector-suggestions"/);
  assert.match(recruiterHtml, /\['offer-job-suggestions', 'filt-job-types'\], \['offer-sector-suggestions', 'filt-sectors'\]/);
  for (const html of [candidateHtml, recruiterHtml]) {
    assert.match(html, /JOB_TAXONOMY:(CANDIDATE_SECTOR_SUGGESTIONS|RECRUITER_SECTOR_CHIPS):START/);
  }
  const chips = [...recruiterHtml.match(/id="filt-sectors">([\s\S]*?)<\/div>/)[1].matchAll(/data-filter-value="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(chips, [...SECTORS]);
});

// Lot 7.1 : représentation historique du drapeau d'anonymat. true et "true" sont
// anonymes ; false, "false", null et l'absence ne le sont pas. Une seule lecture
// (isAnonymousCandidate) : le nom ne peut plus fuiter quand seule la ville est masquée.
test('Lot 7.1 anonymat : true et "true" protègent nom, initiales, avatar, ville et documents ; les autres valeurs non', async () => {
  const flags = [true, 'true', false, 'false', null, undefined];
  seedCandidates(flags.map((flag, i) => ({
    target_job_types: ['BDR'], sectors: ['SaaS'],
    nom: `Secretnom${i}`, prenom: `Secretprenom${i}`,
    avatar_url: `https://cdn.invalid/avatar-${i}.png`, cv_url: `https://cdn.invalid/cv-${i}.pdf`, motivation_url: `https://cdn.invalid/lm-${i}.pdf`,
    axes: { closing: 75, meta: { ville: 'Lyon', cv_file_name: `cv-${i}.pdf`, motivation_file_name: `lm-${i}.pdf`, ...(flag === undefined ? {} : { anonyme: flag }) } },
  })));
  const response = await get(candidateUrl({}), 'user-rec');
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const byUser = new Map(response.body.candidates.map((card) => [card.user_id, card]));
  flags.forEach((flag, i) => {
    const card = byUser.get(`person-${i}`);
    const label = JSON.stringify(flag);
    assert.ok(card, label);
    const anonymous = flag === true || flag === 'true';
    assert.equal(card.anon, anonymous, label);
    const serialized = JSON.stringify(card);
    if (anonymous) {
      assert.equal(card.name, 'Candidat anonyme', label);
      assert.equal(card.initiales, '?', label);
      for (const field of ['location', 'avatar_url', 'cv_url', 'cv_file_name', 'motivation_url', 'motivation_file_name']) assert.equal(card[field], '', `${label} ${field}`);
      for (const secret of [`Secretnom${i}`, `Secretprenom${i}`, 'Lyon', `avatar-${i}`, `cv-${i}`, `lm-${i}`]) assert.ok(!serialized.includes(secret), `${label} ${secret}`);
    } else {
      assert.equal(card.name, `Secretprenom${i} S.`, label);
      assert.equal(card.location, 'Lyon', label);
      assert.equal(card.avatar_url, `https://cdn.invalid/avatar-${i}.png`, label);
    }
  });
  // Le filtre lieu exclut exactement les mêmes profils (aucune ville anonyme sondable).
  assert.deepEqual(await candidateIds({ location: 'Lyon' }), ['person-2', 'person-3', 'person-4', 'person-5']);
});

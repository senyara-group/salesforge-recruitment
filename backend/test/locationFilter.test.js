// Lot 2 — localisation : helper, parseurs deck, handlers réels /offres/deck et
// /candidats/deck (faux PostgREST qui évalue réellement les filtres), frontend VM.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');

process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'test-service-key';

const {
  parseLocationQuery,
  locationTextMatches,
  readLocationText,
  buildLocationPattern,
  LOCATION_QUERY_MAX_LENGTH,
} = require('../utils/locationFilter');
const { parseOfferDeckQuery, offerMatchesDeckFilters, applySupabaseDeckFilters } = require('../utils/offerDeckQuery');
const {
  parseCandidateDeckQuery,
  candidateMatchesDeckFilters,
  applySupabaseCandidateDeckFilters,
} = require('../utils/candidateDeckQuery');
const { compatibilityScore } = require('../utils/recruiterMatching');

const ROOT = path.resolve(__dirname, '../..');
const candidateHtml = fs.readFileSync(path.join(ROOT, 'frontend/_spaces/candidat.html'), 'utf8');
const recruiterHtml = fs.readFileSync(path.join(ROOT, 'frontend/_spaces/recruteur.html'), 'utf8');

// ------------------------------------------------------------------
// Faux PostgREST : évalue eq/neq/is/in/not in/gte/lt/overlaps/or/match
// sur des lignes en mémoire, avec la sémantique NULL de PostgreSQL.
// ------------------------------------------------------------------
function readPath(row, column) {
  const parts = column.split(/->>|->/);
  let value = row[parts[0]];
  for (const key of parts.slice(1)) value = value == null || typeof value !== 'object' ? undefined : value[key];
  if (value === undefined) return null;
  if (column.includes('->>') && value !== null) return typeof value === 'object' ? JSON.stringify(value) : String(value);
  return value;
}
function compare(op, actual, raw) {
  if (op === 'is') return raw === 'null' ? actual == null : String(actual) === raw;
  if (actual == null) return false; // NULL op x -> NULL -> exclu
  if (op === 'eq') return String(actual) === raw;
  if (op === 'neq') return String(actual) !== raw;
  if (op === 'lt') return actual < raw;
  if (op === 'gte') return actual >= raw;
  throw new Error(`op non supporté: ${op}`);
}
function splitTopLevel(text) {
  const out = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) { out.push(current); current = ''; } else current += char;
  }
  out.push(current);
  return out;
}
function orCondition(expression) {
  if (expression.startsWith('and(')) {
    const inner = splitTopLevel(expression.slice(4, -1)).map(orCondition);
    return (row) => inner.every((fn) => fn(row));
  }
  const [column, op, ...rest] = expression.split('.');
  const raw = rest.join('.');
  return (row) => compare(op, readPath(row, column), raw);
}
function makeQuery(rows, log) {
  const predicates = [];
  let limit = Infinity;
  const order = [];
  const api = {
    select() { return api; },
    eq(column, value) { predicates.push((row) => compare('eq', readPath(row, column), String(value))); return api; },
    neq(column, value) { predicates.push((row) => compare('neq', readPath(row, column), String(value))); return api; },
    is(column, value) { predicates.push((row) => readPath(row, column) == null && value === null); return api; },
    in(column, values) { predicates.push((row) => values.map(String).includes(String(readPath(row, column)))); return api; },
    gte(column, value) { predicates.push((row) => compare('gte', readPath(row, column), value)); return api; },
    lt(column, value) { predicates.push((row) => compare('lt', readPath(row, column), value)); return api; },
    not(column, op, list) {
      assert.equal(op, 'in');
      const values = list.slice(1, -1).split(',');
      predicates.push((row) => { const v = readPath(row, column); return v != null && !values.includes(String(v)); });
      return api;
    },
    overlaps(column, values) {
      predicates.push((row) => { const v = readPath(row, column); return Array.isArray(v) && v.some((x) => values.includes(x)); });
      return api;
    },
    or(expression) {
      log.push(['or', expression]);
      const branches = splitTopLevel(expression).map(orCondition);
      predicates.push((row) => branches.some((fn) => fn(row)));
      return api;
    },
    filter(column, op, pattern) {
      log.push(['filter', column, op, pattern]);
      assert.equal(op, 'match');
      // Même moteur que PostgreSQL ARE pour ce motif (classes explicites, pas de backslash).
      const regex = new RegExp(pattern);
      predicates.push((row) => { const v = readPath(row, column); return typeof v === 'string' && regex.test(v); });
      return api;
    },
    order(column, { ascending }) { order.push([column, ascending]); return api; },
    limit(n) { limit = n; return api; },
    maybeSingle() { return api.then((result) => ({ data: result.data[0] || null, error: null })); },
    then(resolve, reject) {
      let out = rows.filter((row) => predicates.every((fn) => fn(row)));
      for (const [column, ascending] of [...order].reverse()) {
        out = [...out].sort((a, b) => {
          const av = a[column]; const bv = b[column];
          if (av == null && bv == null) return 0;
          if (av == null) return 1;
          if (bv == null) return -1;
          return (av < bv ? -1 : av > bv ? 1 : 0) * (ascending ? 1 : -1);
        });
      }
      return Promise.resolve({ data: out.slice(0, limit), error: null }).then(resolve, reject);
    },
  };
  return api;
}

const db = {
  users: [{ id: 'user-rec', role: 'recruteur' }, { id: 'user-cand', role: 'candidat' }],
  recruteurs: [{ id: 'rec-1', user_id: 'user-rec', matching: {} }],
  candidatures: [],
  matchs: [],
  offres: [],
  candidats: [],
};
const queryLog = [];
const fakeSupabase = {
  from(table) { return makeQuery(db[table] || [], queryLog); },
  storage: { from() { return { createSignedUrl: async () => ({ data: null, error: { message: 'none' } }) }; } },
};

function mockModule(request, exports) {
  const filename = require.resolve(request);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
mockModule('../supabase', fakeSupabase);
mockModule('../middleware/auth', (req, _res, next) => { req.user = { id: req.headers['x-test-user'] || 'user-cand' }; next(); });
mockModule('../middleware/requireCandidatePlan', () => (_req, _res, next) => next());
mockModule('../middleware/requireRecruiterPlan', (_req, _res, next) => next());
mockModule('../utils/anthropic', { askClaude: async () => '' });
mockModule('../utils/cvReplacement', { finalizeCvReplacement: async () => ({}) });
mockModule('../utils/ebookAccess', { accessibleEbooks: () => [] });
mockModule('../utils/brevoEvents', { trackBrevoEvent: async () => {}, upsertBrevoContact: async () => {} });
mockModule('../utils/profiles', {
  ensureCandidateProfile: async (userId) => {
    const row = db.candidats.find((c) => c.user_id === userId);
    if (!row) { const e = new Error('Acces reserve aux profils candidats'); e.status = 403; throw e; }
    return row;
  },
  ensureRecruiterProfile: async (userId) => {
    const row = db.recruteurs.find((r) => r.user_id === userId);
    if (!row) { const e = new Error('Acces reserve aux profils recruteurs'); e.status = 403; throw e; }
    return row;
  },
  getCandidatePlan: async () => 'freemium',
  checkAndConsumeUsage: async () => ({ allowed: true }),
  getUserEmail: async () => '',
});

const app = express();
app.use(express.json());
app.use('/offres', require('../routes/offres'));
app.use('/candidats', require('../routes/candidats'));

async function get(url, user) {
  const server = app.listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${url}`, { headers: { 'x-test-user': user } });
    return { status: response.status, body: await response.json() };
  } finally {
    server.close();
  }
}

let seq = 0;
function offer(lieu, extra = {}) {
  seq += 1;
  return { id: `o-${String(seq).padStart(3, '0')}`, titre: `Offre ${seq}`, statut: 'active', created_at: `2026-09-${String(seq).padStart(2, '0')}T10:00:00.000Z`, lieu, job_type: null, remote_mode: null, recruteurs: null, ...extra };
}
function candidate(ville, extra = {}) {
  seq += 1;
  const { meta = {}, ...rest } = extra;
  return {
    id: `c-${String(seq).padStart(3, '0')}`, user_id: `u-${seq}`, prenom: `P${seq}`, nom: `N${seq}`, titre: 'Commercial',
    score_adn: 100 - seq, target_job_types: [],
    axes: { resultat: { closing: 70 }, meta: ville === undefined ? { ...meta } : { ville, ...meta } },
    ...rest,
  };
}
function resetDb() {
  seq = 0;
  queryLog.length = 0;
  db.offres = [
    offer('Lyon'),
    offer('Lyon (69)', { job_type: 'Account Executive', remote_mode: 'hybrid' }),
    offer('Saint-Étienne', { job_type: 'Account Executive' }),
    offer('Villeneuve-d’Ascq'),
    offer('Lyonnais'),
    offer(null),
    offer(''),
    offer('France entière'),
    offer('Remote / Télétravail', { remote_mode: 'remote' }),
    offer('Paris   15e', { job_type: 'SDR / BDR' }),
    offer('Lyon', { statut: 'closed' }),
  ];
  db.candidats = [
    candidate('Lyon', { user_id: 'user-cand', target_job_types: ['Account Executive'] }),
    candidate('lyon ', { target_job_types: ['SDR / BDR'] }),
    candidate('Saint Etienne'),
    candidate(undefined),
    candidate(''),
    candidate(null),
    candidate(42),
    candidate({ nom: 'Lyon' }),
    candidate('Lyon', { meta: { anonyme: true } }),
    candidate('Lyon', { meta: { anonyme: 'true' } }),
    candidate('Lyon', { meta: { anonyme: false }, target_job_types: ['Account Executive'] }),
    candidate('Lyon', { user_id: 'user-rec' }),
  ];
}

// ------------------------------------------------------------------
// Helper
// ------------------------------------------------------------------
test('H. normalisation prudente : casse, accents, tirets, apostrophes, espaces multiples', () => {
  const matches = (query, stored) => locationTextMatches(stored, parseLocationQuery(query));
  assert.equal(matches('lyon', 'Lyon'), true);
  assert.equal(matches('LYON', 'lyon 3e'), true);
  assert.equal(matches('  saint   etienne ', 'Saint-Étienne'), true);
  assert.equal(matches('SAINT-ÉTIENNE', 'Saint Étienne (42)'), true);
  assert.equal(matches("villeneuve d'ascq", 'Villeneuve-d’Ascq'), true);
  assert.equal(matches('évry', 'EVRY'), true);
  assert.equal(matches('paris 15', 'Paris   15e'), false); // mots entiers : 15 ≠ 15e
  assert.equal(matches('paris 15e', 'Paris   15e'), true);
  assert.equal(matches('69', 'Lyon (69)'), true);
  // Mots entiers : pas de correspondance partielle trompeuse.
  assert.equal(matches('lyon', 'Lyonnais'), false);
  assert.equal(matches('paris', 'Cormeilles-en-Parisis'), false);
  assert.equal(matches('nice', 'Venice'), false);
  // Aucune équivalence géographique inventée.
  assert.equal(matches('ile de france', 'Paris'), false);
  assert.equal(matches('nord', 'Valenciennes'), false);
  assert.equal(matches('59', 'Lille'), false);
});

test('I. valeurs invalides : 400 explicite, jamais de coercition ni d’exception brute', () => {
  for (const raw of [['Lyon'], { v: 'Lyon' }, 42, true, 'a*b', 'x%', 'Lyon,Paris', '<script>', 'лион', '_', 'x'.repeat(LOCATION_QUERY_MAX_LENGTH + 1), '---', 'a b c d e f g']) {
    assert.throws(() => parseLocationQuery(raw), { code: 'LOCATION_FILTER_INVALID', status: 400 }, JSON.stringify(raw));
  }
  for (const empty of [undefined, null, '', '   ']) assert.equal(parseLocationQuery(empty), null);
  // Non-chaînes stockées : pas de match, pas d'exception.
  const lyon = parseLocationQuery('Lyon');
  for (const stored of [null, undefined, 42, {}, ['Lyon'], { toString() { throw new Error('coercion'); } }]) {
    assert.equal(locationTextMatches(stored, lyon), false);
    assert.equal(readLocationText(stored), '');
  }
  assert.equal(readLocationText('  Saint   Étienne  '), 'Saint Étienne');
});

test('motif : uniquement des classes explicites, sans backslash ni caractère de la saisie brute', () => {
  const pattern = parseLocationQuery("L'Haÿ-les-Roses").pattern;
  assert.equal(pattern.includes(String.fromCharCode(92)), false);
  assert.doesNotMatch(pattern, /[*%,]/);
  assert.equal(buildLocationPattern(['lyon']), parseLocationQuery('Lyon').pattern);
  assert.equal(new RegExp(pattern).test('L’Haÿ-les-Roses'), true);
});

// ------------------------------------------------------------------
// Parseurs deck (sans régression des autres filtres)
// ------------------------------------------------------------------
test('J. parseurs : location optionnelle, autres filtres inchangés', () => {
  const base = parseOfferDeckQuery({ contract_type: 'CDI', remote_mode: 'hybrid', job_type: 'account executive' });
  assert.equal(base.location, null);
  assert.deepEqual(base.contract_types, ['CDI']);
  assert.deepEqual(base.job_types, ['Account Executive']);
  const withLocation = parseOfferDeckQuery({ contract_type: 'CDI', location: ' Lyon ' });
  assert.equal(withLocation.location.value, 'Lyon');
  assert.deepEqual(withLocation.contract_types, ['CDI']);
  assert.throws(() => parseOfferDeckQuery({ location: ['a', 'b'] }), { code: 'LOCATION_FILTER_INVALID' });
  const candidates = parseCandidateDeckQuery({ target_job_types: 'Account Executive', location: 'lyon' });
  assert.deepEqual(candidates.target_job_types, ['Account Executive']);
  assert.equal(candidates.location.value, 'lyon');
  assert.equal(parseCandidateDeckQuery({}).location, null);

  // Sans filtre localisation : aucune requête supplémentaire.
  const calls = [];
  const fake = new Proxy({}, { get: (_t, name) => (...args) => { calls.push([name, ...args]); return fake; } });
  applySupabaseDeckFilters(fake, parseOfferDeckQuery({}));
  applySupabaseCandidateDeckFilters(fake, parseCandidateDeckQuery({}));
  assert.equal(calls.some((c) => c[0] === 'filter'), false);
  calls.length = 0;
  applySupabaseDeckFilters(fake, withLocation);
  assert.ok(calls.some((c) => c[0] === 'filter' && c[1] === 'lieu' && c[2] === 'match'));
});

test('C/D/M. offres et candidats historiques sans localisation : exclus seulement si le filtre est actif', () => {
  const none = parseOfferDeckQuery({});
  const lyon = parseOfferDeckQuery({ location: 'Lyon' });
  for (const lieu of [null, undefined, '', 42, { city: 'Lyon' }, ['Lyon']]) {
    assert.equal(offerMatchesDeckFilters({ lieu }, none), true);
    assert.equal(offerMatchesDeckFilters({ lieu }, lyon), false);
  }
  const noneC = parseCandidateDeckQuery({});
  const lyonC = parseCandidateDeckQuery({ location: 'Lyon' });
  for (const axes of [null, {}, { meta: null }, { meta: {} }, { meta: { ville: 12 } }, { meta: { ville: ['Lyon'] } }]) {
    assert.equal(candidateMatchesDeckFilters({ axes }, noneC), true);
    assert.equal(candidateMatchesDeckFilters({ axes }, lyonC), false);
  }
  assert.equal(candidateMatchesDeckFilters({ axes: { meta: { ville: 'Lyon', anonyme: true } } }, lyonC), false);
  assert.equal(candidateMatchesDeckFilters({ axes: { meta: { ville: 'Lyon', anonyme: true } } }, noneC), true);
});

// ------------------------------------------------------------------
// Handlers réels
// ------------------------------------------------------------------
test('B/E/G. GET /offres/deck : filtre localisation SQL, combinaison métier, pagination et offres fermées', async () => {
  resetDb();
  db.candidats[0].swipes_meta = { swiped_offer_ids: [] };
  const all = await get('/offres/deck?limit=50', 'user-cand');
  assert.equal(all.status, 200);
  assert.equal(all.body.offers.length, 10); // l'offre fermée reste exclue
  assert.ok(all.body.offers.every((o) => 'lieu' in o));

  const lyon = await get('/offres/deck?limit=50&location=lyon', 'user-cand');
  assert.equal(lyon.status, 200);
  assert.deepEqual(lyon.body.offers.map((o) => o.lieu).sort(), ['Lyon', 'Lyon (69)']);
  assert.ok(queryLog.some((c) => c[0] === 'filter' && c[1] === 'lieu'));

  const combo = await get(`/offres/deck?limit=50&location=${encodeURIComponent('LYON')}&job_type=${encodeURIComponent('Account Executive')}`, 'user-cand');
  assert.deepEqual(combo.body.offers.map((o) => o.lieu), ['Lyon (69)']);

  const accents = await get(`/offres/deck?limit=50&location=${encodeURIComponent('saint etienne')}`, 'user-cand');
  assert.deepEqual(accents.body.offers.map((o) => o.lieu), ['Saint-Étienne']);

  const apostrophe = await get(`/offres/deck?limit=50&location=${encodeURIComponent("villeneuve d'ascq")}`, 'user-cand');
  assert.deepEqual(apostrophe.body.offers.map((o) => o.lieu), ['Villeneuve-d’Ascq']);

  // Pagination par curseur conservée avec le filtre.
  const page1 = await get('/offres/deck?limit=1&location=lyon', 'user-cand');
  assert.equal(page1.body.offers.length, 1);
  assert.equal(page1.body.has_more, true);
  const page2 = await get(`/offres/deck?limit=1&location=lyon&cursor=${page1.body.next_cursor}`, 'user-cand');
  assert.equal(page2.body.offers.length, 1);
  assert.notEqual(page2.body.offers[0].id, page1.body.offers[0].id);
  assert.equal(page2.body.has_more, false);

  const unknown = await get('/offres/deck?limit=50&location=Tombouctou', 'user-cand');
  assert.equal(unknown.status, 200);
  assert.deepEqual(unknown.body.offers, []);

  for (const bad of ['location=a%2Ab', 'location=Lyon&location=Paris', `location=${'x'.repeat(81)}`]) {
    const response = await get(`/offres/deck?${bad}`, 'user-cand');
    assert.equal(response.status, 400, bad);
    assert.equal(response.body.error, 'LOCATION_FILTER_INVALID');
  }
});

test('A/F/G/N. GET /candidats/deck : ville lisible, filtre, anonymes protégés, self exclu, score inchangé', async () => {
  resetDb();
  const all = await get('/candidats/deck?limit=50', 'user-rec');
  assert.equal(all.status, 200);
  const byId = Object.fromEntries(all.body.candidates.map((c) => [c.id, c]));
  const lyonCard = all.body.candidates.find((c) => c.user_id === 'user-cand');
  assert.equal(lyonCard.location, 'Lyon');
  // Historiques : aucune erreur, localisation vide pour absent / vide / non-texte.
  for (const index of [3, 4, 5, 6, 7]) assert.equal(byId[db.candidats[index].id].location, '');
  // Anonyme : jamais de ville exposée.
  assert.equal(byId[db.candidats[8].id].location, '');
  assert.equal(byId[db.candidats[8].id].anon, true);
  // Le recruteur ne se voit pas lui-même (inchangé).
  assert.equal(all.body.candidates.some((c) => c.user_id === 'user-rec'), false);

  const lyon = await get('/candidats/deck?limit=50&location=LYON', 'user-rec');
  assert.equal(lyon.status, 200);
  const ids = lyon.body.candidates.map((c) => c.id).sort();
  assert.deepEqual(ids, [db.candidats[0].id, db.candidats[1].id, db.candidats[10].id].sort());
  assert.ok(queryLog.some((c) => c[0] === 'filter' && c[1] === 'axes->meta->>ville'));
  assert.ok(queryLog.some((c) => c[0] === 'or' && c[1].includes('anonyme')));

  const combo = await get(`/candidats/deck?limit=50&location=lyon&target_job_types=${encodeURIComponent('Account Executive')}`, 'user-rec');
  assert.deepEqual(combo.body.candidates.map((c) => c.id).sort(), [db.candidats[0].id, db.candidats[10].id].sort());

  // PostgreSQL convertit un nombre/objet JSON en texte via ->> : le post-filtre
  // garantit qu'une ville historique non textuelle ne matche jamais.
  const numeric = await get('/candidats/deck?limit=50&location=42', 'user-rec');
  assert.deepEqual(numeric.body.candidates, []);
  const objectLike = await get('/candidats/deck?limit=50&location=nom%20lyon', 'user-rec');
  assert.deepEqual(objectLike.body.candidates, []);

  const accent = await get(`/candidats/deck?limit=50&location=${encodeURIComponent('Saint-Étienne')}`, 'user-rec');
  assert.deepEqual(accent.body.candidates.map((c) => c.id), [db.candidats[2].id]);

  // K. Le score affiché ne dépend pas de la localisation.
  const matching = encodeURIComponent(JSON.stringify({ closing: 80 }));
  const withoutFilter = await get(`/candidats/deck?limit=50&matching=${matching}`, 'user-rec');
  const withFilter = await get(`/candidats/deck?limit=50&matching=${matching}&location=lyon`, 'user-rec');
  for (const card of withFilter.body.candidates) {
    assert.equal(card.m, withoutFilter.body.candidates.find((c) => c.id === card.id).m);
  }
  assert.equal(compatibilityScore({ closing: 70 }, { closing: 80 }), withFilter.body.candidates[0].m);

  // N. Un candidat ne peut pas utiliser le sourcing (scope recruteur inchangé).
  const asCandidate = await get('/candidats/deck?location=lyon', 'user-cand');
  assert.equal(asCandidate.status, 403);
  const invalid = await get('/candidats/deck?location=%25', 'user-rec');
  assert.equal(invalid.status, 400);
  // Convention existante de routes/candidats.js : message (pas de code) dans `error`.
  assert.match(invalid.body.error, /^location invalide/);
});

test('K. scoring et matching : aucune dépendance à la localisation', () => {
  for (const file of ['utils/recruiterMatching.js', 'routes/swipes.js', 'routes/matchs.js', 'routes/ai.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.doesNotMatch(source, /locationFilter|parseLocationQuery/, file);
  }
});

// ------------------------------------------------------------------
// Frontend (VM, pas de navigateur réel)
// ------------------------------------------------------------------
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

test('L. candidat : filtre localisation dans les paramètres, compteur, validation identique au backend', () => {
  const sandbox = { URLSearchParams, Date, DECK_FILTERS: {} };
  vm.runInNewContext([
    'const LOCATION_FILTER_MAX_LENGTH = 80;',
    extractFunction(candidateHtml, 'function normalizeLocationInput(value)'),
    extractFunction(candidateHtml, 'function locationFilterInputError(value)'),
    extractFunction(candidateHtml, 'function publishedSinceFromPreset(preset, now = new Date())'),
    extractFunction(candidateHtml, 'function countActiveDeckFilters(filters = DECK_FILTERS)'),
    extractFunction(candidateHtml, 'function buildDeckQueryParams(filters, options)'),
    'this.h = { normalizeLocationInput, locationFilterInputError, countActiveDeckFilters, buildDeckQueryParams };',
  ].join('\n'), sandbox);
  const { h } = sandbox;
  const filters = { contract_type: ['CDI'], remote_mode: [], tags: [], salary_fixed_min: null, job_type: 'Account Executive', sector: '', published_preset: '', location: '  Saint   Étienne ' };
  const params = h.buildDeckQueryParams(filters, { limit: 20 });
  assert.equal(params.get('location'), 'Saint Étienne');
  assert.equal(params.get('job_type'), 'Account Executive');
  assert.equal(params.get('contract_type'), 'CDI');
  assert.equal(h.countActiveDeckFilters(filters), 3);
  assert.equal(h.buildDeckQueryParams({ ...filters, location: '' }, { limit: 20 }).has('location'), false);
  assert.equal(h.buildDeckQueryParams({ ...filters, location: null }, { limit: 20 }).has('location'), false);
  assert.equal(h.buildDeckQueryParams({ ...filters, location: { x: 1 } }, { limit: 20 }).has('location'), false);
  // Validation front = validation back.
  for (const value of ['Lyon', "Villeneuve-d'Ascq", 'Saint-Étienne (42)', 'a*b', 'Lyon,Paris', '<b>', 'лион', 'x'.repeat(81), '---']) {
    let backend = '';
    try { parseLocationQuery(value); } catch (error) { backend = error.code; }
    assert.equal(Boolean(h.locationFilterInputError(value)), Boolean(backend), value);
  }
});

test('L. recruteur : paramètre location, compteur, libellé résumé, même validation', () => {
  const sandbox = { URLSearchParams, MATCHING: {}, APPLIED_CAND_FILTERS: {} };
  vm.runInNewContext([
    'const LOCATION_FILTER_MAX_LENGTH = 80;',
    extractFunction(recruiterHtml, 'function normalizeLocationInput(value)'),
    extractFunction(recruiterHtml, 'function locationFilterInputError(value)'),
    extractFunction(recruiterHtml, 'function countActiveCandFilters(filters = APPLIED_CAND_FILTERS)'),
    extractFunction(recruiterHtml, 'function activeCandFilterLabels(filters = APPLIED_CAND_FILTERS)'),
    extractFunction(recruiterHtml, 'function buildCandidateDeckParams(cursor, filters)'),
    'this.h = { locationFilterInputError, countActiveCandFilters, activeCandFilterLabels, buildCandidateDeckParams };',
  ].join('\n'), sandbox);
  const { h } = sandbox;
  const filters = { score_adn_min: null, years_experience_min: null, target_job_types: ['Account Executive'], sales_style: [], desired_contracts: [], sectors: [], skills: [], tools: [], methodologies: [], availability: [], customer_types: [], location: ' lyon ' };
  const params = h.buildCandidateDeckParams(null, filters);
  assert.equal(params.get('location'), 'lyon');
  assert.equal(params.get('target_job_types'), 'Account Executive');
  assert.equal(h.countActiveCandFilters(filters), 2);
  assert.ok(h.activeCandFilterLabels(filters).includes('Lieu : lyon'));
  assert.equal(h.buildCandidateDeckParams(null, { ...filters, location: '' }).has('location'), false);
  assert.equal(h.locationFilterInputError('Saint-Étienne'), '');
  assert.notEqual(h.locationFilterInputError('a%b'), '');
});

test('L. affichage : lieu complet échappé, absence explicite, pas de troncature au premier mot', () => {
  assert.doesNotMatch(candidateHtml, /o\.lieu\.split\('·'\)\[0\]\.trim\(\)\.split\(' '\)\[0\]/);
  assert.match(candidateHtml, /ovLieu\.textContent = o\.lieuDisplay \|\| 'Non précisé'/);
  const sandbox = {
    initials: () => 'AC', asAxesList: () => [], computeCompat: () => ({ score: 0, matched: new Set() }),
    WORK_MODE_LABELS: { onsite: 'Sur site', hybrid: 'Hybride', remote: 'Télétravail' },
  };
  vm.runInNewContext([
    extractFunction(candidateHtml, 'function normalizeLocationInput(value)'),
    extractFunction(candidateHtml, 'function normOffre(o, mySkills = [])'),
    'this.normOffre = normOffre;',
  ].join('\n'), sandbox);
  const withPlace = sandbox.normOffre({ id: '1', lieu: '  Saint   Denis ', remote_mode: 'hybrid' });
  assert.equal(withPlace.lieuDisplay, 'Saint Denis');
  assert.equal(withPlace.workMode, 'Hybride');
  for (const lieu of [null, undefined, '', 42, { toString() { throw new Error('coercion'); } }]) {
    const legacy = sandbox.normOffre({ id: '2', lieu });
    assert.equal(legacy.lieuDisplay, '');
    assert.equal(legacy.lieu, 'Lieu non précisé');
    assert.equal(legacy.workMode, '');
  }
  // Carte recruteur : ville échappée, masquée si absente.
  assert.match(recruiterHtml, /typeof c\.location === 'string' && c\.location\.trim\(\) \? `<span class="cand-fact cand-fact-location" title="\$\{esc\(c\.location\)\}">/);
});

test('L. mobile : champs pleine largeur, pas de débordement horizontal, labels associés', () => {
  for (const [html, id] of [[candidateHtml, 'filt-location'], [recruiterHtml, 'filt-cand-location']]) {
    assert.match(html, new RegExp(`<label class="filt-label" for="${id}">`));
    assert.match(html, new RegExp(`<input class="form-field" id="${id}" type="search" maxlength="80"`));
    assert.match(html, new RegExp(`aria-describedby="${id}-help"`));
    assert.match(html, /\.form-field\{[^}]*width:100%/);
    assert.match(html, /\.filters-sheet \.filt-help\{/);
  }
  assert.match(candidateHtml, /\.mstat-v\.is-text\{[^}]*text-overflow:ellipsis/);
  assert.match(recruiterHtml, /\.cand-fact-location span\{[^}]*text-overflow:ellipsis/);
});

test('privacy : aucune localisation ajoutée aux logs, pas de coordonnées exposées par la carte sourcing', () => {
  for (const file of ['utils/locationFilter.js', 'utils/offerDeckQuery.js', 'utils/candidateDeckQuery.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), /console\.(log|info|warn|error)/, file);
  }
  const source = fs.readFileSync(path.join(__dirname, '../routes/candidats.js'), 'utf8');
  const card = extractFunction(source, 'function mapCandidateDeckCard(profile, matching)');
  assert.doesNotMatch(card, /latitude|longitude|city_code|mobility_km/);
});

// Lot 3 — ADN multi-postes : vraie route POST /ai/score-adn, benchmark et historique
// (faux Supabase en mémoire), logique réelle de candidat.html exécutée en VM.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');

process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'test-service-key';

const { JOB_TYPE_DESCRIPTORS, jobTypeById } = require('../utils/yannisTaxonomies');
const { createJobTaxonomy } = require('../utils/jobTaxonomy');
const { ADN_PROFILE_QUESTION_MODULES: MODULES } = require('../utils/adnProfileQuestions');
const {
  LEGACY_PREFS_POSTE_BY_JOB,
  parseAdnJobProfile,
  buildLegacyScoringPayload,
} = require('../utils/adnJobProfile');
const { compatibilityScore } = require('../utils/recruiterMatching');

const ROOT = path.resolve(__dirname, '../..');
const candidateHtml = fs.readFileSync(path.join(ROOT, 'frontend/_spaces/candidat.html'), 'utf8');
const JOB_IDS = JOB_TYPE_DESCRIPTORS.map((job) => job.id);

// ------------------------------------------------------------------
// Oracle : COPIE VERBATIM du calcul de routes/ai.js à la base d6c2abd
// (avant ce lot). Sert de référence « avant » pour la non-régression.
// ------------------------------------------------------------------
function resultBeforeLot(reponses) {
  const filledAnswers = JSON.stringify(reponses).length;
  const score = Math.max(55, Math.min(95, Math.round(65 + filledAnswers / 80)));
  return {
    score,
    rank: 'Profil synchronisé avec les recruteurs',
    type: score >= 85 ? 'Closer Strategique · Profil Elite' : 'Commercial B2B',
    desc: 'Score calcule depuis les reponses du test ADN et enregistre dans Supabase.',
    axes: [
      { l: 'Resilience', v: Math.min(96, score + 4) },
      { l: 'Closing', v: score },
      { l: 'Drive', v: Math.min(96, score + 2) },
      { l: 'SalesTech', v: Math.max(55, score - 8) },
      { l: 'Ecoute', v: Math.max(55, score - 4) },
    ],
    tags: ['Swip Sales', 'ADN', 'B2B'],
  };
}

// ------------------------------------------------------------------
// Faux Supabase en mémoire + montage des vraies routes
// ------------------------------------------------------------------
const db = { consentements: [], evaluations_adn: [], candidats: [] };
const writes = [];
function makeQuery(table) {
  const filters = [];
  let limit = Infinity;
  let order = null;
  const q = {
    select() { return q; },
    eq(column, value) { filters.push((row) => row[column] === value); return q; },
    not(column, op, value) {
      assert.equal(op, 'is'); assert.equal(value, null);
      filters.push((row) => row[column] != null);
      return q;
    },
    order(column, { ascending }) { order = { column, ascending }; return q; },
    limit(n) { limit = n; return q; },
    maybeSingle() { return q.then(({ data }) => ({ data: data[0] || null, error: null })); },
    then(resolve, reject) {
      let rows = db[table].filter((row) => filters.every((fn) => fn(row)));
      if (order) {
        rows = [...rows].sort((a, b) => (a[order.column] < b[order.column] ? -1 : 1) * (order.ascending ? 1 : -1));
      }
      return Promise.resolve({ data: rows.slice(0, limit), error: null }).then(resolve, reject);
    },
    update(patch) {
      return {
        eq: (column, value) => {
          writes.push({ table, op: 'update', patch, where: [column, value] });
          const row = db[table].find((r) => r[column] === value);
          if (row) Object.assign(row, patch);
          return Promise.resolve({ error: null });
        },
      };
    },
    insert(row) {
      writes.push({ table, op: 'insert', row });
      db[table].push({ ...row, created_at: new Date().toISOString() });
      return Promise.resolve({ error: null });
    },
  };
  return q;
}
const fakeSupabase = {
  from: (table) => makeQuery(table),
  storage: { from() { return { createSignedUrl: async () => ({ data: null, error: { message: 'none' } }) }; } },
};
const plans = {};
function mockModule(request, exports) {
  const filename = require.resolve(request);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
mockModule('../supabase', fakeSupabase);
mockModule('../middleware/auth', (req, _res, next) => { req.user = { id: req.headers['x-test-user'] }; next(); });
mockModule('../middleware/requireCandidatePlan', () => (_req, _res, next) => next());
mockModule('../middleware/requireRecruiterPlan', (_req, _res, next) => next());
mockModule('../utils/anthropic', { askClaude: async () => '' });
mockModule('../utils/cvReplacement', { finalizeCvReplacement: async () => ({}) });
mockModule('../utils/ebookAccess', { accessibleEbooks: () => [] });
mockModule('../utils/brevoEvents', { trackBrevoEvent: async () => {}, upsertBrevoContact: async () => {} });
mockModule('../utils/profiles', {
  ensureCandidateProfile: async (userId) => db.candidats.find((row) => row.user_id === userId),
  ensureRecruiterProfile: async () => ({ id: 'rec' }),
  getCandidatePlan: async (userId) => plans[userId] || 'freemium',
  getUserEmail: async () => '',
  checkAndConsumeUsage: async () => ({ allowed: true }),
});
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/ai', require('../routes/ai'));
app.use('/candidats', require('../routes/candidats'));

async function call(method, url, user, body) {
  const server = app.listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-test-user': user },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  } finally {
    server.close();
  }
}
let userSeq = 0;
function newCandidate(extra = {}) {
  userSeq += 1;
  const userId = `user-${userSeq}`;
  db.consentements.push({ user_id: userId, type: 'test_adn', accepte: true, created_at: '2026-01-01T00:00:00.000Z' });
  db.candidats.push({ id: `cand-${userSeq}`, user_id: userId, score_adn: null, type_poste: null, axes: { meta: {} }, ...extra });
  return userId;
}
const submit = (user, reponses) => call('POST', '/ai/score-adn', user, { reponses });

// ------------------------------------------------------------------
// Fixtures représentatives : ancien parcours (mono-poste + anciens boutons)
// et nouveau parcours (postes + poste principal).
// ------------------------------------------------------------------
const FIXTURES = [
  { name: 'SDR story vide', primary: 'sdr', style: 'hunter', q: [0, 1], story: '', s: ['closer', 'advisor', 'farmer'], mcq: [1, 0, 2, 3, 1], p: [1, 0], prefs: { contrat: ['cdi'], mode: [], secteur: [], remun: '', taille: [] } },
  { name: 'AE story moyenne', primary: 'ae', style: 'full', q: [2, 3], story: 'Contexte : grand compte SaaS. Action : cartographie des décideurs. Résultat : 120 K€ signés.', s: ['hunter', 'closer', 'advisor'], mcq: [0, 2, 1, 0, 3], p: [2, 1], prefs: { contrat: ['cdi', 'freelance'], mode: ['hybride'], secteur: ['saas'], remun: '60_90', taille: ['scaleup'] } },
  { name: 'Business Developer story longue', primary: 'bizdev', style: 'hunter', q: [3, 0], story: 'x'.repeat(600), s: ['farmer', 'farmer', 'closer'], mcq: [2, 2, 2, 2, 2], p: [0, 2], prefs: { contrat: [], mode: ['remote'], secteur: ['fintech', 'cyber'], remun: 'gt90', taille: [] } },
  { name: 'Commercial terrain', primary: 'terrain', style: 'farmer', q: [1, 2], story: 'Tournée régionale, 18 visites par semaine, +22 % de CA.', s: ['advisor', 'hunter', 'farmer'], mcq: [3, 1, 0, 1, 0], p: [1, 1], prefs: { contrat: ['cdi'], mode: ['presentiel'], secteur: ['industrie'], remun: '40_60', taille: ['eti', 'gc'] } },
  { name: 'Key Account Manager accents/apostrophes', primary: 'kam', style: 'farmer', q: [2, 1], story: "Client mécontent : j'ai rétabli la relation, renouvellement à 3 ans « sécurisé ».", s: ['closer', 'closer', 'closer'], mcq: [1, 1, 1, 1, 1], p: [0, 0], prefs: { contrat: ['mission_l'], mode: [], secteur: [], remun: 'lt40', taille: [] } },
  { name: 'Manager commercial', primary: 'manager', style: 'full', q: [3, 2], story: 'Équipe de 8, plan de redressement, objectif atteint à 112 %.', s: ['advisor', 'advisor', 'hunter'], mcq: [0, 0, 0, 0, 0], p: [2, 2], prefs: { contrat: ['cdi', 'portage'], mode: ['hybride', 'remote'], secteur: ['hrtech'], remun: '60_90', taille: ['startup'] } },
];
function baseAnswers(f) {
  return {
    scenarios: { s1: f.s[0], s2: f.s[1], s3: f.s[2] },
    sliders: { resilience: 7, objections: 6, cycle: 1, salestech: 5, emotional: 8, drive: 9, coldcall: 7, social: 6 },
    mcq: { q1: f.mcq[0], q2: f.mcq[1], q3: f.mcq[2], q4: f.mcq[3], q5: f.mcq[4] },
    pitches: { p1: f.p[0], p2: f.p[1] },
    story: f.story,
  };
}
function jobAnswers(f) {
  return { q1: MODULES[f.primary].q1.options[f.q[0]], q2: MODULES[f.primary].q2.options[f.q[1]] };
}
/** Ancien frontend : prefs.poste (anciens boutons) + job_profile mono-poste. */
function oldPayload(f, legacyPoste) {
  return {
    ...baseAnswers(f),
    prefs: { poste: legacyPoste, ...f.prefs },
    job_profile: { poste: f.primary, poste_label: jobTypeById(f.primary).label, style: f.style, reponses: jobAnswers(f) },
  };
}
/** Ancien scénario ÉQUIVALENT : bouton au libellé identique au poste principal s'il existait. */
function equivalentOldPayload(f) {
  const chip = LEGACY_PREFS_POSTE_BY_JOB[f.primary];
  return oldPayload(f, chip ? [chip] : []);
}
/** Nouveau frontend : pas de prefs.poste, job_profile.postes. */
function newPayload(f, postes) {
  return {
    ...baseAnswers(f),
    prefs: { ...f.prefs },
    job_profile: { poste: f.primary, poste_label: jobTypeById(f.primary).label, style: f.style, reponses: jobAnswers(f), postes },
  };
}
/**
 * Fixture « frontière d'arrondi » : longueur de référence ≡ 39 (mod 80), donc
 * 65 + L/80 a une partie décimale de 0,4875 : UN caractère de plus dans le calcul
 * ferait passer le score au point supérieur. Rend les tests sensibles au moindre écart.
 */
function boundaryFixture(primary, style) {
  const f = { ...FIXTURES[0], name: `frontière ${primary}`, primary, style, story: '' };
  const length = JSON.stringify(equivalentOldPayload(f)).length;
  return { ...f, story: 'b'.repeat(((39 - (length % 80)) + 80) % 80) };
}
FIXTURES.push(boundaryFixture('sdr', 'hunter'), boundaryFixture('kam', 'full'), boundaryFixture('ae', 'farmer'));

function secondariesFor(primary, count) {
  return JOB_IDS.filter((id) => id !== primary).slice(0, count);
}
function canonical(ids) {
  return JOB_IDS.filter((id) => ids.includes(id));
}

// ------------------------------------------------------------------
// Score : non-régression et invariance
// ------------------------------------------------------------------
test('10. mono-poste : ancien scénario équivalent → score et résultat strictement identiques (9 fixtures)', async () => {
  const boundary = FIXTURES.filter((f) => f.name.startsWith('frontière'));
  assert.equal(boundary.length, 3);
  for (const f of boundary) {
    const length = JSON.stringify(equivalentOldPayload(f)).length;
    assert.equal(length % 80, 39, f.name);
    // Sensibilité : scorer le payload brut (avec `postes`, sans prefs.poste) donnerait un autre score.
    const raw = newPayload(f, canonical([f.primary, secondariesFor(f.primary, 1)[0]]));
    assert.notEqual(resultBeforeLot(raw).score, resultBeforeLot(equivalentOldPayload(f)).score, f.name);
  }
  for (const f of FIXTURES) {
    const expected = resultBeforeLot(equivalentOldPayload(f));
    const user = newCandidate();
    const response = await submit(user, newPayload(f, [f.primary]));
    assert.equal(response.status, 200, f.name);
    assert.deepEqual(response.body, expected, f.name);
    // Longueurs identiques octet pour octet, pas seulement après arrondi.
    const parsed = parseAdnJobProfile(newPayload(f, [f.primary]));
    assert.equal(JSON.stringify(buildLegacyScoringPayload(newPayload(f, [f.primary]), parsed)).length,
      JSON.stringify(equivalentOldPayload(f)).length, f.name);
  }
});

test('score invariant : même poste principal et mêmes réponses avec 1, 2, 3 ou 6 postes', async () => {
  for (const f of FIXTURES) {
    const results = [];
    for (const count of [0, 1, 2, 5]) {
      const postes = canonical([f.primary, ...secondariesFor(f.primary, count)]);
      const user = newCandidate();
      const response = await submit(user, newPayload(f, postes));
      assert.equal(response.status, 200, `${f.name} ${postes}`);
      results.push({ postes, result: response.body, row: db.candidats.find((row) => row.user_id === user) });
    }
    assert.deepEqual(results.map((r) => r.postes.length), [1, 2, 3, 6]);
    for (const { result, row } of results) {
      assert.deepEqual(result, results[0].result, f.name); // score, dimensions (axes), type, rank
      assert.equal(row.score_adn, results[0].result.score);
      assert.equal(row.type_poste, f.primary); // groupe benchmark = poste principal
      // Matching recruteur : mêmes axes ⇒ même compatibilité.
      assert.equal(compatibilityScore(row.axes.resultat.axes, { closing: 80 }), compatibilityScore(results[0].row.axes.resultat.axes, { closing: 80 }));
    }
  }
});

test('1. payload historique mono-poste accepté et scoré exactement comme avant (anciens boutons quelconques)', async () => {
  for (const f of FIXTURES) {
    for (const chips of [[], ['closer', 'sales'], ['closer', 'sales', 'sdr', 'ae', 'head', 'se']]) {
      const legacy = oldPayload(f, chips);
      const user = newCandidate();
      const response = await submit(user, legacy);
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, resultBeforeLot(legacy));
      const row = db.candidats.find((r) => r.user_id === user);
      assert.equal(row.type_poste, f.primary);
      assert.deepEqual(row.axes.questionnaire, legacy); // stocké tel quel
    }
  }
});

// ------------------------------------------------------------------
// Contrat du nouveau payload
// ------------------------------------------------------------------
test('2/3/8/9. nouveaux payloads mono/multi : stockage canonique, poste principal = type_poste, historique', async () => {
  const f = FIXTURES[1];
  const user = newCandidate();
  const scrambled = ['manager', 'ae', 'sdr'];
  const response = await submit(user, newPayload(f, scrambled));
  assert.equal(response.status, 200);
  const row = db.candidats.find((r) => r.user_id === user);
  assert.equal(row.type_poste, 'ae');
  assert.deepEqual(row.axes.questionnaire.job_profile.postes, ['sdr', 'ae', 'manager']); // ordre taxonomie
  assert.equal(Object.prototype.hasOwnProperty.call(row.axes.questionnaire.prefs, 'poste'), false);
  const evaluation = db.evaluations_adn.filter((e) => e.user_id === user).pop();
  assert.deepEqual(evaluation.reponses, row.axes.questionnaire);
  assert.deepEqual(evaluation.resultat, response.body);
  assert.equal(evaluation.score, response.body.score);
});

test('4/5/8. refus propres : tableau vide, non-texte, doublon, principal hors sélection — aucune écriture', async () => {
  const f = FIXTURES[0];
  const invalid = {
    'tableau vide': newPayload(f, []),
    'postes non tableau': newPayload(f, 'sdr'),
    'id non textuel': newPayload(f, ['sdr', 42]),
    'objet': newPayload(f, [{ id: 'sdr' }]),
    'doublon': newPayload(f, ['sdr', 'sdr']),
    'doublon casse différente': newPayload(f, ['sdr', 'SDR']),
    'principal hors sélection': { ...newPayload(f, ['ae']), job_profile: { ...newPayload(f, ['ae']).job_profile, poste: 'sdr' } },
    'principal absent': { ...newPayload(f, ['sdr']), job_profile: { ...newPayload(f, ['sdr']).job_profile, poste: null } },
    'poste historique non textuel': oldPayload({ ...f, primary: 'sdr' }, []),
  };
  invalid['poste historique non textuel'].job_profile.poste = { id: 'sdr' };
  for (const [name, payload] of Object.entries(invalid)) {
    const user = newCandidate();
    const before = writes.length;
    const response = await submit(user, payload);
    assert.equal(response.status, 400, name);
    assert.equal(response.body.error, 'ADN_JOB_PROFILE_INVALID', name);
    assert.equal(writes.length, before, `${name}: aucune écriture`);
    assert.equal(db.candidats.find((r) => r.user_id === user).score_adn, null, name);
  }
});

test('6/7. ID inconnu et métier inactif : refusés en nouvelle écriture, tolérés en lecture historique', async () => {
  const f = FIXTURES[0];
  for (const unknown of ['closer', 'chef_de_rayon', 'SDR / BDR']) {
    const response = await submit(newCandidate(), newPayload(f, ['sdr', unknown]));
    assert.equal(response.status, 400, unknown);
  }
  // Contrat historique inchangé : une ancienne valeur inconnue reste acceptée telle quelle.
  const legacyUser = newCandidate();
  const legacy = oldPayload(f, ['closer']);
  legacy.job_profile.poste = 'closer';
  const legacyResponse = await submit(legacyUser, legacy);
  assert.equal(legacyResponse.status, 200);
  assert.deepEqual(legacyResponse.body, resultBeforeLot(legacy));
  assert.equal(db.candidats.find((r) => r.user_id === legacyUser).type_poste, 'closer');
  // Sans job_profile (toléré historiquement) : type_poste null, score identique.
  const noJobUser = newCandidate();
  const { job_profile: _omit, ...noJob } = oldPayload(f, []);
  const noJobResponse = await submit(noJobUser, noJob);
  assert.equal(noJobResponse.status, 200);
  assert.deepEqual(noJobResponse.body, resultBeforeLot(noJob));
  assert.equal(db.candidats.find((r) => r.user_id === noJobUser).type_poste, null);

  // Métier inactif (fixture de taxonomie, jamais le registre réel).
  const taxonomyPath = require.resolve('../utils/yannisTaxonomies');
  const modulePath = require.resolve('../utils/adnJobProfile');
  const savedTaxonomy = require.cache[taxonomyPath];
  const savedModule = require.cache[modulePath];
  try {
    const fixture = createJobTaxonomy([...JOB_TYPE_DESCRIPTORS, { id: 'fixture_retired', label: 'Fixture retired', active: false }]);
    require.cache[taxonomyPath] = { id: taxonomyPath, filename: taxonomyPath, loaded: true, exports: { ...savedTaxonomy.exports, ...fixture } };
    delete require.cache[modulePath];
    const fresh = require('../utils/adnJobProfile');
    assert.throws(() => fresh.parseAdnJobProfile({ job_profile: { poste: 'fixture_retired', postes: ['fixture_retired'] } }), { code: 'ADN_JOB_PROFILE_INVALID' });
    assert.throws(() => fresh.parseAdnJobProfile({ job_profile: { poste: 'sdr', postes: ['sdr', 'fixture_retired'] } }), { code: 'ADN_JOB_PROFILE_INVALID' });
    assert.deepEqual(fresh.parseAdnJobProfile({ job_profile: { poste: 'fixture_retired' } }), { format: 'legacy', primary: 'fixture_retired', postes: ['fixture_retired'] });
  } finally {
    require.cache[taxonomyPath] = savedTaxonomy;
    require.cache[modulePath] = savedModule;
  }
  assert.deepEqual(JOB_TYPE_DESCRIPTORS.map((job) => job.id), JOB_IDS); // registre réel intact
});

test('11. cooldown et plan inchangés : priorité sur la validation du profil métier, aucune écriture', async () => {
  const f = FIXTURES[2];
  const recent = newCandidate({ score_adn: 80 });
  plans[recent] = 'carriere_coaching';
  db.evaluations_adn.push({ user_id: recent, score: 80, created_at: new Date(Date.now() - 24 * 3600 * 1000).toISOString() });
  const before = writes.length;
  for (const payload of [newPayload(f, [f.primary, 'sdr']), newPayload(f, [])]) {
    const response = await submit(recent, payload);
    assert.equal(response.status, 403);
    assert.equal(response.body.error, 'RETAKE_TOO_SOON');
  }
  const noPlan = newCandidate({ score_adn: 70 });
  const planResponse = await submit(noPlan, newPayload(f, [f.primary]));
  assert.equal(planResponse.status, 403);
  assert.equal(planResponse.body.error, 'PLAN_REQUIRED');
  assert.equal(writes.length, before);
  // Délai écoulé : repassage accepté, score non biaisé.
  const old = newCandidate({ score_adn: 60 });
  plans[old] = 'carriere_coaching';
  db.evaluations_adn.push({ user_id: old, score: 60, created_at: '2025-01-01T00:00:00.000Z' });
  const retake = await submit(old, newPayload(f, JOB_IDS));
  assert.equal(retake.status, 200);
  assert.deepEqual(retake.body, resultBeforeLot(equivalentOldPayload(f)));
});

test('12/16. benchmark et historique : groupe du poste principal, anciens ADN lisibles', async () => {
  for (const [i, score] of [60, 70, 80, 90].entries()) {
    newCandidate({ type_poste: 'ae', score_adn: score, id: `bench-ae-${i}` });
    newCandidate({ type_poste: 'sdr', score_adn: score, id: `bench-sdr-${i}` });
  }
  const f = FIXTURES[1]; // poste principal AE, secondaire SDR
  const user = newCandidate();
  plans[user] = 'carriere_coaching';
  assert.equal((await submit(user, newPayload(f, ['sdr', 'ae']))).status, 200);
  const bench = await call('GET', '/candidats/benchmark', user);
  assert.equal(bench.status, 200);
  assert.equal(bench.body.type_poste, 'ae');
  assert.equal(bench.body.assez_de_donnees, true);
  assert.equal(bench.body.echantillon, db.candidats.filter((c) => c.type_poste === 'ae' && c.score_adn != null).length);

  // Ancien ADN sans type_poste : même réponse qu'avant ce lot (message explicite).
  const legacyNoType = newCandidate({ score_adn: 75 });
  plans[legacyNoType] = 'carriere_coaching';
  const noType = await call('GET', '/candidats/benchmark', legacyNoType);
  assert.equal(noType.status, 400);
  assert.match(noType.body.error, /Passez le test ADN/);

  // Historique : anciens résultats (prefs.poste, valeur inconnue) et nouveaux restent listés.
  db.evaluations_adn.push(
    { user_id: user, score: 72, resultat: resultBeforeLot(oldPayload(f, ['closer'])), reponses: oldPayload(f, ['closer']), created_at: '2024-01-01T00:00:00.000Z' },
    { user_id: user, score: 70, resultat: { score: 70 }, reponses: { job_profile: { poste: 'poste_disparu' } }, created_at: '2024-06-01T00:00:00.000Z' },
  );
  const history = await call('GET', '/candidats/evaluations', user);
  assert.equal(history.status, 200);
  assert.equal(history.body.evaluations.length, 3);
  assert.ok(history.body.evaluations.every((e) => Number.isFinite(e.score)));
});

// ------------------------------------------------------------------
// Frontend réel (VM + DOM minimal, pas de navigateur)
// ------------------------------------------------------------------
function makeElement(id, attrs = {}) {
  const classes = new Set();
  return {
    id,
    style: { display: attrs.display ?? '' },
    textContent: '',
    disabled: Boolean(attrs.disabled),
    hidden: false,
    innerHTML: '',
    attrs: { ...(attrs.attrs || {}) },
    setAttribute(name, value) { this.attrs[name] = String(value); },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null; },
    classList: {
      toggle(name, on) { if (on === undefined ? !classes.has(name) : on) classes.add(name); else classes.delete(name); },
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); },
    },
  };
}
function extract(start, end) {
  const a = candidateHtml.indexOf(start);
  const b = candidateHtml.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `extraction ${start}`);
  return candidateHtml.slice(a, b);
}
function buildFrontend() {
  const stepIds = ['ts-jobs', 'ts-primary', 'ts1', 'ts2', 'ts3', 'ts4', 'ts5', 'ts6', 'ts7', 'ts8', 'ts9', 'ts10', 'ts-huntfarm', 'ts-profileq1', 'ts-profileq2'];
  const elements = {};
  for (const id of stepIds) {
    const hiddenByDefault = new RegExp(`<div id="${id}" style="display:none">`).test(candidateHtml);
    elements[id] = makeElement(id, { display: hiddenByDefault ? 'none' : '' });
  }
  for (const id of ['test-sl', 'test-st', 'test-pf', 'job-sel-count', 'primary-job-opts', 'profileq1-text', 'profileq2-text', 'profileq1-opts', 'profileq2-opts']) elements[id] = makeElement(id);
  for (const id of ['bn-job', 'bn-primary', 'bn-profileq1', 'bn-profileq2', 'bn-huntfarm']) elements[id] = makeElement(id, { disabled: true });
  const zone = candidateHtml.slice(candidateHtml.indexOf('JOB_TAXONOMY:CANDIDATE_ADN_JOB_BUTTONS:START'), candidateHtml.indexOf('JOB_TAXONOMY:CANDIDATE_ADN_JOB_BUTTONS:END'));
  const jobButtons = [...zone.matchAll(/aria-pressed="(\w+)" data-job-id="([^"]+)"/g)]
    .map((m) => makeElement(`job-${m[2]}`, { attrs: { 'aria-pressed': m[1], 'data-job-id': m[2] } }));
  const primaryCache = new Map();
  const primaryButtons = () => {
    const html = elements['primary-job-opts'].innerHTML;
    if (!primaryCache.has(html)) {
      primaryCache.set(html, [...html.matchAll(/aria-pressed="(\w+)" data-job-id="([^"]+)"[^>]*><span class="ot">([^<]*)</g)]
        .map((m) => Object.assign(makeElement(`primary-${m[2]}`, { attrs: { 'aria-pressed': m[1], 'data-job-id': m[2] } }), { label: m[3] })));
    }
    return primaryCache.get(html);
  };
  const toasts = [];
  const apiCalls = [];
  const sandbox = {
    document: {
      getElementById: (id) => elements[id] || null,
      querySelectorAll: (selector) => {
        if (selector === '#job-type-opts [data-job-id]') return jobButtons;
        if (selector === '#primary-job-opts [data-job-id]') return primaryButtons();
        return [];
      },
    },
    window: { scrollTo() {} },
    toast: (message) => toasts.push(message),
    esc: (text = '') => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    runAnalysis() {},
    submitADN() {},
    renderResult() {},
    api: async (method, route, body) => { apiCalls.push({ method, route, body }); return {}; },
    ADN: { scenarios: {}, mcq: {}, pitches: {}, story: '', prefs: { contrat: [], mode: [], secteur: [], remun: '', taille: [] } },
  };
  const stepsLine = candidateHtml.match(/const STEPS = \{[^\n]*\};/)[0];
  vm.runInNewContext([
    stepsLine,
    extract('const CUSTOM_TEST_STEPS', 'function po('),
    extract('async function submitToAPI()', 'function resultAxisColor('),
    `this.fn = { toggleTargetJob, continueFromTargetJobs, selectPrimaryJob, continueFromPrimaryJob, backFromFirstQuestion,
      showTestStep, ns, ns_custom, goToProfileSteps, currentTestStepId, refreshTestProgress, adnStepSequence,
      renderProfileQuestion, selectProfileAnswer, submitToAPI };
     this.state = () => ({ jobs: [...TEST_TARGET_JOBS], primary: TEST_JOB_TYPE, answers: { ...TEST_PROFILE_ANSWERS }, explicit: TEST_PRIMARY_EXPLICIT });
     this.setHuntFarm = (value) => { TEST_HUNT_FARM = value; };`,
  ].join('\n'), sandbox);
  const pressed = (buttons) => buttons.filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.getAttribute('data-job-id'));
  // Copie JSON : les objets du contexte VM ont un autre prototype (comparaisons strictes).
  const state = () => JSON.parse(JSON.stringify(sandbox.state()));
  return { sandbox, elements, jobButtons, primaryButtons, toasts, apiCalls, pressed, fn: sandbox.fn, state };
}

test('frontend : sélection au début, zéro/1/plusieurs postes, poste principal explicite, aria-pressed, progression', () => {
  const ui = buildFrontend();
  const { fn, state, elements } = ui;
  // Au chargement : première étape = postes visés, seule étape visible.
  assert.equal(fn.currentTestStepId(), 'ts-jobs');
  assert.deepEqual(Object.keys(elements).filter((id) => /^ts/.test(id) && elements[id].style.display !== 'none'), ['ts-jobs']);
  fn.refreshTestProgress();
  assert.equal(elements['test-sl'].textContent, 'Étape 1 sur 13');
  assert.equal(elements['test-st'].textContent, 'Postes visés');

  // Zéro poste : impossible de continuer.
  fn.continueFromTargetJobs();
  assert.equal(fn.currentTestStepId(), 'ts-jobs');
  assert.deepEqual(ui.toasts, ['Sélectionnez au moins un poste']);

  // Un poste : principal d'office, pas d'étape supplémentaire.
  fn.toggleTargetJob('ae');
  assert.deepEqual(ui.pressed(ui.jobButtons), ['ae']);
  assert.equal(elements['bn-job'].disabled, false);
  assert.equal(elements['job-sel-count'].textContent, '1 poste sélectionné');
  assert.equal(state().primary, 'ae');
  fn.continueFromTargetJobs();
  assert.equal(fn.currentTestStepId(), 'ts1');
  assert.equal(elements['test-sl'].textContent, 'Étape 2 sur 13');
  fn.backFromFirstQuestion();
  assert.equal(fn.currentTestStepId(), 'ts-jobs');

  // Désélection puis sélection multiple : ordre taxonomie, jamais de principal automatique.
  fn.toggleTargetJob('ae');
  assert.deepEqual(state().jobs, []);
  assert.equal(elements['bn-job'].disabled, true);
  fn.toggleTargetJob('manager');
  fn.toggleTargetJob('sdr');
  fn.toggleTargetJob('closer'); // hors taxonomie : ignoré
  assert.deepEqual(state().jobs, ['sdr', 'manager']);
  assert.equal(state().primary, null);
  assert.equal(elements['job-sel-count'].textContent, '2 postes sélectionnés');
  fn.continueFromTargetJobs();
  assert.equal(fn.currentTestStepId(), 'ts-primary');
  assert.equal(elements['test-sl'].textContent, 'Étape 2 sur 14');
  assert.deepEqual(ui.primaryButtons().map((b) => b.getAttribute('data-job-id')), ['sdr', 'manager']);
  assert.deepEqual(ui.pressed(ui.primaryButtons()), []);
  assert.equal(elements['bn-primary'].disabled, true);
  fn.continueFromPrimaryJob();
  assert.equal(fn.currentTestStepId(), 'ts-primary');
  assert.equal(ui.toasts.pop(), 'Choisissez votre poste principal');

  fn.selectPrimaryJob('manager');
  assert.deepEqual(ui.pressed(ui.primaryButtons()), ['manager']);
  assert.equal(elements['bn-primary'].disabled, false);
  fn.selectPrimaryJob('kam'); // non sélectionné : ignoré
  assert.equal(state().primary, 'manager');
  fn.continueFromPrimaryJob();
  assert.equal(fn.currentTestStepId(), 'ts1');
  assert.equal(elements['test-sl'].textContent, 'Étape 3 sur 14');

  // Retour : revient au choix du principal (plusieurs postes), choix conservé.
  fn.backFromFirstQuestion();
  assert.equal(fn.currentTestStepId(), 'ts-primary');
  fn.showTestStep('ts-jobs');
  fn.toggleTargetJob('kam'); // ajout d'un 3e poste : principal explicite conservé
  assert.equal(state().primary, 'manager');
  fn.toggleTargetJob('manager'); // retrait du principal : nouveau choix requis
  assert.equal(state().primary, null);
  fn.toggleTargetJob('kam'); // un seul poste restant : principal d'office
  assert.deepEqual(state().jobs, ['sdr']);
  assert.equal(state().primary, 'sdr');
});

test('frontend : q1/q2 du seul poste principal, réinitialisées si le principal change ; étape 9 sans « Type de poste »', () => {
  const ui = buildFrontend();
  const { fn, state, elements, sandbox } = ui;
  fn.toggleTargetJob('sdr');
  fn.toggleTargetJob('terrain');
  fn.continueFromTargetJobs();
  fn.selectPrimaryJob('terrain');
  fn.renderProfileQuestion(1);
  assert.equal(elements['profileq1-text'].textContent, MODULES.terrain.q1.text);
  assert.equal(fn.currentTestStepId(), 'ts-profileq1');
  assert.equal(elements['test-sl'].textContent, 'Étape 13 sur 14');
  const option = { querySelector: () => ({ textContent: MODULES.terrain.q1.options[1] }), parentElement: { querySelectorAll: () => [] }, classList: { add() {} } };
  fn.selectProfileAnswer(1, option);
  assert.equal(state().answers.q1, MODULES.terrain.q1.options[1]);
  fn.selectPrimaryJob('sdr');
  assert.deepEqual(state().answers, { q1: null, q2: null });

  // Étape 9 : les préférences restantes suffisent, l'ancien poste n'est plus requis ni proposé.
  fn.showTestStep('ts9');
  fn.goToProfileSteps();
  assert.equal(fn.currentTestStepId(), 'ts9'); // aucune préférence
  sandbox.ADN.prefs.contrat = ['cdi'];
  fn.goToProfileSteps();
  assert.equal(fn.currentTestStepId(), 'ts-huntfarm');
  // Retour arrière depuis le profil de chasse : exécute le vrai onclick du HTML,
  // sans validation (même si une réponse antérieure manquait).
  const huntfarmBack = candidateHtml.match(/<div id="ts-huntfarm"[\s\S]*?<button class="btn bo" onclick="([^"]+)">Retour<\/button>/)[1];
  vm.runInContext(huntfarmBack, sandbox);
  assert.equal(fn.currentTestStepId(), 'ts9');
  assert.doesNotMatch(candidateHtml, /tg\(this,'poste'/);
  assert.doesNotMatch(candidateHtml, /Quel type de poste recherchez-vous/);
  assert.doesNotMatch(candidateHtml, /selectJobType|goToJobStep|'ts-job'/);
});

test('bout en bout : payload produit par le frontend → même score que l’ancien parcours équivalent', async () => {
  for (const f of FIXTURES) {
    for (const extra of [[], secondariesFor(f.primary, 5)]) {
      const ui = buildFrontend();
      const { fn, sandbox } = ui;
      Object.assign(sandbox.ADN, baseAnswers(f), { prefs: { ...f.prefs } });
      for (const id of [f.primary, ...extra]) fn.toggleTargetJob(id);
      fn.continueFromTargetJobs();
      if (extra.length) fn.selectPrimaryJob(f.primary);
      ui.sandbox.setHuntFarm(f.style);
      for (const n of [1, 2]) {
        const text = MODULES[f.primary][`q${n}`].options[f.q[n - 1]];
        fn.selectProfileAnswer(n, { querySelector: () => ({ textContent: text }), parentElement: { querySelectorAll: () => [] }, classList: { add() {} } });
      }
      await fn.submitToAPI();
      const sent = JSON.parse(JSON.stringify(ui.apiCalls.pop().body.reponses));
      assert.deepEqual(sent.job_profile.postes, canonical([f.primary, ...extra]));
      assert.equal(sent.job_profile.poste, f.primary);
      assert.equal('poste' in sent.prefs, false);
      const response = await submit(newCandidate(), sent);
      assert.equal(response.status, 200, f.name);
      assert.deepEqual(response.body, resultBeforeLot(equivalentOldPayload(f)), `${f.name} +${extra.length}`);
    }
  }
});

test('Lot 4 : nouveau métier principal, mélange ancien + nouveau, stockage/relecture, score invariant', async () => {
  const NEW_IDS = ['sedentaire', 'technico_commercial', 'charge_affaires', 'avant_vente', 'account_manager',
    'customer_success', 'partenariats', 'conseiller_vente', 'direction_commerciale'];
  assert.ok(NEW_IDS.every((id) => JOB_IDS.includes(id)));
  for (const primary of NEW_IDS) {
    const f = { ...FIXTURES[1], name: `principal ${primary}`, primary, style: 'full', q: [1, 2] };
    const expected = resultBeforeLot(equivalentOldPayload(f)); // pas d'ancien bouton : prefs.poste = []
    for (const postes of [[primary], ['sdr', primary], ['ae', 'kam', primary, 'manager'], JOB_IDS]) {
      const user = newCandidate();
      const response = await submit(user, newPayload(f, canonical(postes)));
      assert.equal(response.status, 200, `${primary} ${postes}`);
      assert.deepEqual(response.body, expected, `${primary} avec ${postes.length} postes`);
      const row = db.candidats.find((r) => r.user_id === user);
      assert.equal(row.type_poste, primary); // chaîne ID, groupe benchmark
      assert.equal(jobTypeById(row.type_poste).label, JOB_TYPE_DESCRIPTORS.find((job) => job.id === primary).label);
      assert.deepEqual(row.axes.questionnaire.job_profile.postes, canonical(postes));
      assert.equal('poste' in row.axes.questionnaire.prefs, false);
      assert.equal(row.axes.questionnaire.job_profile.reponses.q1, MODULES[primary].q1.options[1]);
    }
  }
  // Ancien métier principal + nouveaux secondaires : strictement le score historique.
  const legacyPrimary = FIXTURES[0];
  const response = await submit(newCandidate(), newPayload(legacyPrimary, canonical(['sdr', 'charge_affaires', 'avant_vente', 'direction_commerciale'])));
  assert.deepEqual(response.body, resultBeforeLot(equivalentOldPayload(legacyPrimary)));
});

test('Lot 4 frontend : nouveaux métiers sélectionnables, principal explicite, q1/q2 du nouveau principal', () => {
  const ui = buildFrontend();
  const { fn, state, elements } = ui;
  assert.deepEqual(ui.jobButtons.map((b) => b.getAttribute('data-job-id')), JOB_IDS);
  fn.toggleTargetJob('direction_commerciale');
  fn.toggleTargetJob('sdr');
  fn.toggleTargetJob('charge_affaires');
  assert.deepEqual(state().jobs, ['sdr', 'charge_affaires', 'direction_commerciale']); // ordre taxonomie
  assert.equal(state().primary, null);
  fn.continueFromTargetJobs();
  assert.equal(fn.currentTestStepId(), 'ts-primary');
  assert.deepEqual(ui.primaryButtons().map((b) => [b.getAttribute('data-job-id'), b.label]),
    [['sdr', 'SDR / BDR'], ['charge_affaires', 'Chargé d&#39;affaires / Ingénieur d&#39;affaires'], ['direction_commerciale', 'Directeur commercial / Head of Sales']]);
  fn.selectPrimaryJob('charge_affaires');
  fn.continueFromPrimaryJob();
  fn.renderProfileQuestion(2);
  assert.equal(elements['profileq2-text'].textContent, MODULES.charge_affaires.q2.text);
});

test('accessibilité et mobile (statique) : boutons natifs, aria-pressed, indicateur non coloré, libellés longs', () => {
  const zone = candidateHtml.slice(candidateHtml.indexOf('JOB_TAXONOMY:CANDIDATE_ADN_JOB_BUTTONS:START'), candidateHtml.indexOf('JOB_TAXONOMY:CANDIDATE_ADN_JOB_BUTTONS:END'));
  const buttons = zone.match(/<button[^>]*>/g);
  assert.equal(buttons.length, JOB_IDS.length);
  assert.ok(buttons.every((b) => b.includes('type="button"') && b.includes('aria-pressed="false"')));
  assert.match(candidateHtml, /id="ts-jobs">\s*<div class="qt sf" id="ts-jobs-title">Quels postes visez-vous \?<\/div>/);
  assert.match(candidateHtml, /role="group" aria-labelledby="ts-jobs-title" aria-describedby="ts-jobs-help" id="job-type-opts"/);
  assert.match(candidateHtml, /role="group" aria-labelledby="ts-primary-title" aria-describedby="ts-primary-help" id="primary-job-opts"/);
  assert.match(candidateHtml, /id="job-sel-count" role="status" aria-live="polite"/);
  // Sélection signalée par une coche (pas seulement la couleur), focus visible, texte qui revient à la ligne.
  assert.match(candidateHtml, /\.job-pick \.opt\[aria-pressed="true"\] \.ot::before\{content:'✓'/);
  assert.match(candidateHtml, /\.job-pick \.opt:focus-visible\{outline:2px solid/);
  assert.match(candidateHtml, /\.job-pick \.opt \.ot\{[^}]*overflow-wrap:anywhere/);
  assert.match(candidateHtml, /^\.opt\{[^}]*width:100%/m);
  // L'étape postes visés précède la première question du test ; bandeau par défaut cohérent.
  assert.ok(candidateHtml.indexOf('id="ts-jobs"') < candidateHtml.indexOf('id="ts1"'));
  assert.match(candidateHtml, /id="test-sl">Étape 1 sur 13<\/div>\s*<div class="test-st sf" id="test-st">Postes visés<\/div>/);
});

test('privacy : aucun nouveau log, aucune réponse ADN dans les erreurs', () => {
  const route = fs.readFileSync(path.join(__dirname, '../routes/ai.js'), 'utf8');
  assert.equal((route.match(/console\./g) || []).length, 1); // console.warn historique (evaluations_adn)
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '../utils/adnJobProfile.js'), 'utf8'), /console\./);
  assert.throws(() => parseAdnJobProfile({ story: 'secret', job_profile: { poste: 'sdr', postes: ['x'.repeat(200)] } }), (error) => error.message.length < 80 && !error.message.includes('secret'));
});

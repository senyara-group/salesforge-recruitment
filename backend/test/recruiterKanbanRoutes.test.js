// Real Express routes, auth/plan middleware and profile ownership checks.
// Only external GoTrue/PostgREST/Brevo are replaced with deterministic fixtures.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
process.env.SUPABASE_URL = 'https://test.invalid';
process.env.SUPABASE_ANON_KEY = 'test';
function mock(request, exports) {
  const id = require.resolve(request); require.cache[id] = { id, filename: id, loaded: true, exports };
}
let rows, beforeUpdate, writes;
const value = (row, key) => key.split('.').reduce((v, part) => v?.[part], row);
class Query {
  constructor(table) { this.table = table; this.filters = []; this.max = 1000; this.sorts = []; }
  select(fields, options) { this.fields = fields; this.options = options; return this; }
  eq(key, expected) { this.filters.push(row => value(row, key) === expected); return this; }
  is(key, expected) { this.filters.push(row => expected === null ? value(row, key) == null : value(row, key) === expected); return this; }
  in(key, expected) { this.filters.push(row => expected.includes(value(row, key))); return this; }
  gte(key, expected) { this.filters.push(row => value(row, key) >= expected); return this; }
  or(expression) {
    const conditions = expression.split(',').map(part => {
      const [key, op, ...tail] = part.split('.'); const expected = tail.join('.');
      return row => op === 'is' ? value(row, key) == null : op === 'neq'
        ? value(row, key) != null && String(value(row, key)) !== expected : String(value(row, key)) === expected;
    });
    this.filters.push(row => conditions.some(fn => fn(row))); return this;
  }
  order(key, options) { this.sorts.push([key, options]); return this; }
  limit(n) { this.max = n; return this; }
  update(patch) { this.patch = patch; return this; }
  async run(single = false) {
    if (this.patch && beforeUpdate) { const hook = beforeUpdate; beforeUpdate = null; hook(); }
    let result = (rows[this.table] || []).filter(row => this.filters.every(fn => fn(row)));
    const count = result.length;
    if (this.patch) { writes.push({ table: this.table, count, patch: this.patch }); result.forEach(row => Object.assign(row, this.patch)); }
    for (const [key, options] of [...this.sorts].reverse()) result.sort((a, b) => String(value(a, key)).localeCompare(String(value(b, key))) * (options?.ascending ? 1 : -1));
    result = result.slice(0, this.max);
    return { data: this.options?.head ? null : structuredClone(single ? result[0] || null : result), error: null, count: this.options?.count === 'exact' ? count : undefined };
  }
  maybeSingle() { return this.run(true); }
  single() { return this.run(true); }
  then(resolve, reject) { return this.run().then(resolve, reject); }
}
const db = { from: table => new Query(table), storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: 'https://test.invalid/cv' } }) }) } };
mock('../supabase', db);
mock('@supabase/supabase-js', { createClient: () => ({ auth: { getUser: async token =>
  ['owner', 'other', 'candidate', 'inactive'].includes(token)
    ? { data: { user: { id: token } } } : { error: { status: 401 } } } }) });
mock('../utils/brevoEvents', { trackBrevoEvent: async () => {} });
mock('../utils/engagementTracking', { recordProfileView: async () => {}, countRecentProfileViews: async () => 1 });
const app = express(); app.use(express.json());
app.use('/candidatures', require('../routes/candidatures'));
app.use('/recruteurs', require('../routes/recruteurs'));
let server, base;
test.before(async () => { server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
test.beforeEach(() => {
  beforeUpdate = null; writes = [];
  const offer = { id: 'offer', titre: 'AE', recruteur_id: 'rec-owner', statut: 'active' };
  rows = {
    users: ['owner', 'other', 'inactive', 'candidate'].map(id => ({ id, role: id === 'candidate' ? 'candidat' : 'recruteur' })),
    recruteurs: ['owner', 'other', 'inactive'].map(id => ({ id: 'rec-' + id, user_id: id })),
    candidats: [{ id: 'candidate-id', user_id: 'candidate' }],
    abonnements: ['owner', 'other', 'inactive', 'candidate'].map(id => ({ user_id: id, plan: 'pro', statut: id === 'inactive' ? 'inactif' : 'actif' })),
    offres: [offer],
    candidatures: [{ id: 'application', candidat_id: 'candidate-id', offre_id: 'offer', offres: offer, statut: 'envoyee', lettre_type: 'candidate_like', created_at: new Date().toISOString(), candidats: {}, snapshot: {} }],
    matchs: [], messages: [],
  };
});
async function call(method, route, token = 'owner', body) {
  const response = await fetch(base + route, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, data: await response.json() };
}
const move = (statut, token = 'owner', extra = {}) => call('PUT', '/candidatures/application/status', token, { statut, ...extra });

test('K/R/X — appel direct à la route existante persiste, puis GET pipeline restitue le statut', async () => {
  const result = await move('contacte', 'owner', { expected_statut: 'envoyee' });
  assert.equal(result.status, 200); assert.equal(rows.candidatures[0].statut, 'contacte');
  assert.deepEqual(result.data.moves.map(m => m.statut), ['repondu', 'entretien', 'refusee']);
  const pipeline = await call('GET', '/recruteurs/pipeline');
  assert.equal(pipeline.status, 200); assert.equal(pipeline.data.contacte[0].statut, 'contacte');
  assert.equal(pipeline.data.nouveau.length, 0);
  const stats = await call('GET', '/recruteurs/stats');
  assert.equal(stats.status, 200); assert.equal(stats.data.stages.contacte, 1); assert.equal(stats.data.stages.nouveau, 0);
});
test('U — un autre recruteur ne peut pas modifier une candidature possédée', async () => {
  assert.equal((await move('contacte', 'other')).status, 403);
  assert.equal(rows.candidatures[0].statut, 'envoyee'); assert.equal(writes.length, 0);
});
test('V — id falsifié (id candidat ou candidature inexistante) refusé sans écriture', async () => {
  for (const id of ['candidate-id', 'missing']) assert.equal((await call('PUT', `/candidatures/${id}/status`, 'owner', { statut: 'contacte' })).status, 404);
  assert.equal(writes.length, 0);
});
test('W — statut falsifié, saut illégal, objet et valeur vide refusés', async () => {
  for (const status of ['qualifie', 'archive', 'embauche', '', { statut: 'contacte' }]) assert.equal((await move(status)).status, 409);
  assert.equal(writes.length, 0);
});
test('X — auth absente/falsifiée et abonnement inactif : accès refusé', async () => {
  assert.equal((await move('contacte', null)).status, 401);
  assert.equal((await move('contacte', 'forged')).status, 401);
  assert.equal((await move('contacte', 'inactive')).status, 403);
  assert.equal(writes.length, 0);
});
test('U/X — même muni d’un plan recruteur, un compte candidat ne peut pas changer le statut', async () => {
  assert.equal((await move('contacte', 'candidate')).status, 403); assert.equal(writes.length, 0);
});
test('P/Q — état attendu obsolète : conflit avant toute écriture', async () => {
  rows.candidatures[0].statut = 'vu';
  assert.equal((await move('contacte', 'owner', { expected_statut: 'envoyee' })).status, 409);
  assert.equal(writes.length, 0);
});
test('P/Q — concurrent entre SELECT et UPDATE : compare-and-swap protège le statut', async () => {
  beforeUpdate = () => { rows.candidatures[0].statut = 'retiree'; };
  assert.equal((await move('contacte')).status, 409);
  assert.equal(rows.candidatures[0].statut, 'retiree'); assert.equal(writes[0].count, 0);
});
test('historique NULL : traité comme envoyé, protégé par IS NULL', async () => {
  rows.candidatures[0].statut = null;
  assert.equal((await move('vu', 'owner', { expected_statut: 'envoyee' })).status, 200);
  assert.equal(rows.candidatures[0].statut, 'vu');
});
test('course inverse : un retrait candidat ne peut pas écraser une prise de contact concurrente', async () => {
  beforeUpdate = () => { rows.candidatures[0].statut = 'contacte'; };
  const response = await call('DELETE', '/candidatures/application', 'candidate');
  assert.equal(response.status, 409); assert.equal(rows.candidatures[0].statut, 'contacte');
  assert.equal(writes[0].count, 0);
});
test('ouverture de fiche : passage automatique à vu renvoyé au front avec ses transitions', async () => {
  const response = await call('POST', '/recruteurs/candidat-vu', 'owner', { candidat_id: 'candidate-id', candidature_id: 'application' });
  assert.equal(response.status, 200); assert.equal(response.data.statut, 'vu'); assert.equal(response.data.stage, 'vu');
  assert.deepEqual(response.data.moves.map(m => m.statut), ['contacte', 'refusee']);
});
test('C/D — agrégats zéro et périmètre recruteur, likes exclus, aucune donnée candidat renvoyée', async () => {
  const other = await call('GET', '/recruteurs/stats', 'other');
  assert.equal(other.status, 200); assert.equal(other.data.pipeline, 0);
  rows.candidatures[0].lettre_type = 'recruteur_like';
  const own = await call('GET', '/recruteurs/stats');
  assert.equal(own.data.pipeline, 0); assert.equal(own.data.offres, 1);
  assert.equal(Object.values(own.data.stages).reduce((a, b) => a + b, 0), 0);
  assert.doesNotMatch(JSON.stringify(own.data), /candidate-id|snapshot|application/);
});
test('C/E — 2503 candidatures au-delà du plafond 1000, répartition exacte incluant NULL et historique inconnu', async () => {
  const statuses = ['envoyee', 'vu', 'contacte', 'repondu', 'entretien', 'offre', 'embauche', 'refusee', 'retiree', null, 'legacy'];
  const original = rows.candidatures[0];
  rows.candidatures = Array.from({ length: 2503 }, (_, i) => ({ ...original, id: 'app-' + i, statut: statuses[i % statuses.length] }));
  const result = await call('GET', '/recruteurs/stats');
  assert.equal(result.status, 200); assert.equal(result.data.pipeline, 2503); assert.equal(result.data.recues_new, 2503);
  const { stageForStatut } = require('../utils/pipelineQuery');
  for (const [stage, count] of Object.entries(result.data.stages)) assert.equal(count, rows.candidatures.filter(c => stageForStatut(c.statut) === stage).length);
  assert.equal(writes.length, 0);
});

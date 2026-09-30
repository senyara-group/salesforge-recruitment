// Lot 7.2 — anonymat et minimisation côté recruteur (contrat : ANONYMITY.md).
// Vraies routes Express (candidatures, recruteurs, messages, swipes, candidats) et vrai
// middleware de plan recruteur ; faux PostgREST en mémoire avec jointures pré-calculées.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'test-service-key';

function mockModule(request, exports) {
  const filename = require.resolve(request);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

// Valeurs secrètes : aucune ne doit apparaître là où l'identité n'est pas révélée.
const SECRET = {
  prenom: 'Zephyrine', nom: 'Quillondrake', ville: 'Villesecrete', email: 'zephyrine.secret@mail.invalid',
  telephone: '+33 6 99 88 77 66', lettre: 'Je suis Zephyrine Quillondrake, lettre secrete.', cvPath: 'user-anon/applications/secret-cv.pdf',
};
const { buildCandidateSnapshot } = require('../utils/applicationWorkflow');

function anonCandidate(flag) {
  return {
    id: 'cand-anon', user_id: 'user-anon', prenom: SECRET.prenom, nom: SECRET.nom, titre: 'Account Executive',
    email: SECRET.email, telephone: SECRET.telephone, score_adn: 100, avatar_url: 'https://cdn.invalid/secret-avatar.png',
    cv_url: 'https://cdn.invalid/secret-cv.pdf',
    axes: { closing: 80, resultat: { type: 'Chasseur' }, meta: { anonyme: flag, ville: SECRET.ville, motivation: SECRET.lettre, certificat_public: true } },
  };
}
const PUBLIC_CANDIDATE = { id: 'cand-public', user_id: 'user-public', prenom: 'Paulin', nom: 'Public', titre: 'SDR', score_adn: 100, axes: { meta: { ville: 'Lyon', certificat_public: true } } };

let ROWS;
function seed(flag = true) {
  const anon = anonCandidate(flag);
  const offreA = { id: 'offre-a', titre: 'AE SaaS', statut: 'active', recruteur_id: 'rec-a', recruteurs: { id: 'rec-a', user_id: 'user-rec-a', entreprise: 'Alpha', matching: {}, questions: [] } };
  const offreB = { id: 'offre-b', titre: 'SDR Fintech', statut: 'active', recruteur_id: 'rec-b', recruteurs: { id: 'rec-b', user_id: 'user-rec-b', entreprise: 'Beta', matching: {}, questions: [] } };
  ROWS = {
    users: [{ id: 'user-rec-a', role: 'recruteur' }, { id: 'user-rec-b', role: 'recruteur' }, { id: 'user-anon', role: 'candidat' }],
    abonnements: [{ user_id: 'user-rec-a', plan: 'pro', statut: 'actif', created_at: '2026-01-01' }, { user_id: 'user-rec-b', plan: 'pro', statut: 'actif', created_at: '2026-01-01' }],
    recruteurs: [offreA.recruteurs, offreB.recruteurs],
    offres: [offreA, offreB, { ...offreA, id: 'offre-a2', titre: 'AE Grands comptes' }],
    candidats: [anon, PUBLIC_CANDIDATE],
    candidatures: [
      // Candidature volontaire du candidat anonyme sur l'offre du recruteur A.
      { id: 'app-a', candidat_id: 'cand-anon', offre_id: 'offre-a', statut: 'envoyee', lettre_type: 'candidate_like', created_at: '2026-09-10T10:00:00Z',
        snapshot: { ...buildCandidateSnapshot(anon, { cv_snapshot_path: SECRET.cvPath, cv_file_name: 'secret-cv.pdf' }), submitted_at: '2026-09-10T10:00:00Z' }, offres: offreA, candidats: anon },
      // Ligne historique créée par un « like » du recruteur B : aucune action du candidat.
      { id: 'app-legacy-b', candidat_id: 'cand-anon', offre_id: 'offre-b', statut: 'nouveau', lettre_type: 'recruteur_like', created_at: '2026-09-11T10:00:00Z', snapshot: null, offres: offreB, candidats: anon },
    ],
    matchs: [{ id: 'match-a', candidat_id: 'cand-anon', offre_id: 'offre-a', created_at: '2026-09-12T10:00:00Z', candidats: anon, offres: offreA }],
    messages: [],
    profile_views: [], candidate_likes: [],
  };
}

function clause(expression) {
  const [column, op, ...rest] = expression.split('.');
  const value = rest.join('.');
  return (row) => {
    const actual = row[column];
    if (op === 'is') return value === 'null' ? actual == null : String(actual) === value;
    if (op === 'eq') return actual != null && String(actual) === value;
    if (op === 'neq') return actual != null && String(actual) !== value;
    throw new Error('op ' + op);
  };
}
const writes = [];
class Query {
  constructor(table) { this.table = table; this.filters = []; this.op = 'select'; this.max = Infinity; }
  select() { return this; }
  order() { return this; }
  limit(n) { this.max = n; return this; }
  eq(c, v) { this.filters.push((row) => String(row[c]) === String(v)); return this; }
  in(c, values) { const set = values.map(String); this.filters.push((row) => set.includes(String(row[c]))); return this; }
  or(expression) { const parts = expression.split(',').map(clause); this.filters.push((row) => parts.some((fn) => fn(row))); return this; }
  update(payload) { this.op = 'update'; this.payload = payload; return this; }
  insert(payload) { this.op = 'insert'; this.payload = payload; return this; }
  upsert(payload) { this.op = 'upsert'; this.payload = payload; return this; }
  run() {
    const rows = ROWS[this.table] || (ROWS[this.table] = []);
    if (this.op === 'insert' || this.op === 'upsert') {
      writes.push([this.op, this.table, this.payload]);
      const row = { id: `${this.table}-new-${writes.length}`, created_at: '2026-09-30T10:00:00Z', ...this.payload };
      rows.push(row); return [row];
    }
    const matching = rows.filter((row) => this.filters.every((fn) => fn(row)));
    if (this.op === 'update') { writes.push(['update', this.table, this.payload]); matching.forEach((row) => Object.assign(row, this.payload)); }
    return matching.slice(0, this.max);
  }
  async maybeSingle() { return { data: this.run()[0] || null, error: null }; }
  async single() { return { data: this.run()[0] || null, error: null }; }
  then(resolve, reject) { return Promise.resolve({ data: this.run(), error: null }).then(resolve, reject); }
}
mockModule('../supabase', {
  from: (table) => new Query(table),
  rpc: async () => ({ data: null, error: null }),
  storage: { from: () => ({ createSignedUrl: async (p) => ({ data: { signedUrl: 'https://signed.invalid/' + p }, error: null }), copy: async () => ({ error: null }) }) },
});
mockModule('../middleware/auth', (req, res, next) => {
  const id = req.headers['x-test-user'];
  if (!id) return res.status(401).json({ error: 'auth' });
  req.user = { id }; next();
});
const brevo = [];
mockModule('../utils/brevoEvents', { trackBrevoEvent: async (email, event, data) => { brevo.push({ email, event, data }); }, upsertBrevoContact: async () => {} });
mockModule('../utils/engagementTracking', { recordCandidateLike: async () => {}, recordProfileView: async () => {}, countRecentLikes: async () => 1, countRecentProfileViews: async () => 1 });
mockModule('../utils/profiles', {
  ensureRecruiterProfile: async (userId) => {
    const row = ROWS.recruteurs.find((r) => r.user_id === userId);
    if (!row) throw Object.assign(new Error('recruteur requis'), { status: 403 });
    return row;
  },
  ensureCandidateProfile: async (userId) => {
    const row = ROWS.candidats.find((c) => c.user_id === userId);
    if (!row) throw Object.assign(new Error('candidat requis'), { status: 403 });
    return row;
  },
  getUserEmail: async (userId) => `${userId}@mail.invalid`,
  getCandidatePlan: async () => 'carriere_coaching',
  checkAndConsumeUsage: async () => ({ allowed: true }),
});
mockModule('../utils/anthropic', { askClaude: async () => '' });
mockModule('../utils/cvReplacement', { finalizeCvReplacement: async () => ({}) });

const app = express();
app.use(express.json());
app.use('/candidatures', require('../routes/candidatures'));
app.use('/recruteurs', require('../routes/recruteurs'));
app.use('/messages', require('../routes/messages'));
app.use('/swipes', require('../routes/swipes'));
app.use('/candidats', require('../routes/candidats'));
const server = app.listen(0);
test.after(() => server.close());
const base = `http://127.0.0.1:${server.address().port}`;
async function call(method, path, user, body) {
  const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: await response.json() };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

for (const flag of [true, 'true']) {
  const label = JSON.stringify(flag);

  test(`L/P ${label} — /candidatures/recues : pas de snapshot brut, ni nom complet, ville, chemin CV ou coordonnées`, async () => {
    seed(flag);
    const asA = await call('GET', '/candidatures/recues', 'user-rec-a');
    assert.equal(asA.status, 200, JSON.stringify(asA.body));
    assert.equal(asA.body.length, 1);
    const [row] = asA.body;
    assert.equal(Object.hasOwn(row, 'snapshot'), false);
    assert.equal(Object.hasOwn(row, 'candidat_id'), false);
    const serialized = JSON.stringify(asA.body);
    for (const secret of [SECRET.nom, SECRET.ville, SECRET.email, SECRET.telephone, SECRET.cvPath, 'secret-cv.pdf', SECRET.lettre]) {
      assert.ok(!serialized.includes(secret), `${label} fuite : ${secret}`);
    }
    // Candidature volontaire : identité révélée au recruteur de l'offre (comportement historique).
    assert.equal(row.name, `${SECRET.prenom} Q.`);
    assert.equal(row.av, 'ZQ');
    // Champs consommés par renderRecues : toujours présents.
    for (const key of ['id', 'hot', 'bg', 'av', 'name', 'badge', 'badgeBg', 'badgeColor', 'titre', 'tags', 'score']) assert.ok(Object.hasOwn(row, key), key);
    // Un autre recruteur n'obtient rien de ce candidat (la ligne historique recruteur_like est exclue).
    const asB = await call('GET', '/candidatures/recues', 'user-rec-b');
    assert.deepEqual(asB.body, []);
  });

  test(`L ${label} — pipeline : révélation au seul recruteur de l'offre, rien pour un autre`, async () => {
    seed(flag);
    const asA = await call('GET', '/recruteurs/pipeline', 'user-rec-a');
    assert.equal(asA.status, 200, JSON.stringify(asA.body));
    const cardsA = Object.values(asA.body).filter(Array.isArray).flat();
    assert.equal(cardsA.length, 1);
    assert.equal(cardsA[0].name, `${SECRET.prenom} Q.`);
    const asB = await call('GET', '/recruteurs/pipeline', 'user-rec-b');
    const serializedB = JSON.stringify(asB.body);
    for (const secret of [SECRET.prenom, SECRET.nom, SECRET.ville, SECRET.cvPath]) assert.ok(!serializedB.includes(secret), `${label} ${secret}`);
    const contact = await call('POST', '/recruteurs/pipeline/contact', 'user-rec-b', { candidature_id: 'app-a' });
    assert.equal(contact.status, 403);
    assert.ok(!JSON.stringify(contact.body).includes(SECRET.prenom));
  });

  test(`M ${label} — messages : fil visible du seul recruteur du match (candidature volontaire)`, async () => {
    seed(flag);
    const asA = await call('GET', '/messages/threads', 'user-rec-a');
    assert.equal(asA.status, 200, JSON.stringify(asA.body));
    assert.equal(asA.body.length, 1);
    assert.equal(asA.body[0].nom, `${SECRET.prenom} Q.`);
    const asB = await call('GET', '/messages/threads', 'user-rec-b');
    assert.equal(asB.status, 200);
    assert.ok(!JSON.stringify(asB.body).includes(SECRET.prenom));
  });

  test(`N ${label} — swipe recruteur : un like sur une ligne historique recruteur_like ne crée aucun match`, async () => {
    seed(flag); writes.length = 0; brevo.length = 0;
    const liked = await call('POST', '/recruteurs/swipe', 'user-rec-b', { candidat_id: 'cand-anon', action: 'like' });
    assert.equal(liked.status, 200, JSON.stringify(liked.body));
    assert.equal(liked.body.match, false);
    assert.equal(writes.some(([op, table]) => table === 'matchs' && op !== 'update'), false, 'aucun match créé sans candidature volontaire');
    await settle();
    assert.ok(!JSON.stringify(liked.body).includes(SECRET.prenom));
    assert.ok(!brevo.some((event) => event.email === 'user-rec-b@mail.invalid' && JSON.stringify(event.data).includes(SECRET.prenom)));
    const threads = await call('GET', '/messages/threads', 'user-rec-b');
    assert.ok(!JSON.stringify(threads.body).includes(SECRET.prenom));
    // Recruteur A (candidature volontaire existante) : match inchangé, comme historiquement.
    const likedA = await call('POST', '/recruteurs/swipe', 'user-rec-a', { candidat_id: 'cand-anon', action: 'like' });
    assert.equal(likedA.body.match, true);
  });

  test(`N ${label} — swipe candidat : la notification de candidature ne part qu'au recruteur de l'offre`, async () => {
    seed(flag); brevo.length = 0;
    const swipe = await call('POST', '/swipes', 'user-anon', { offre_id: 'offre-a2', action: 'like' });
    assert.ok([200, 201].includes(swipe.status), JSON.stringify(swipe.body));
    await settle();
    const received = brevo.filter((event) => event.event === 'candidature_recue');
    assert.equal(received.length, 1);
    assert.equal(received[0].email, 'user-rec-a@mail.invalid');
    const others = brevo.filter((event) => event.email === 'user-rec-b@mail.invalid');
    assert.ok(!JSON.stringify(others).includes(SECRET.prenom));
  });

  test(`O ${label} — certificat public : l'id visible dans le deck ne ré-identifie pas un anonyme`, async () => {
    seed(flag);
    const anonymous = await call('GET', '/candidats/cand-anon/certificat-public');
    assert.equal(anonymous.status, 200);
    assert.equal(anonymous.body.prenom, 'Un commercial');
    assert.ok(!JSON.stringify(anonymous.body).includes(SECRET.prenom));
  });
}

test('K — non anonyme : comportement historique conservé (certificat, candidatures)', async () => {
  seed(false);
  const certificate = await call('GET', '/candidats/cand-public/certificat-public');
  assert.equal(certificate.body.prenom, 'Paulin');
  const own = await call('GET', '/candidats/cand-anon/certificat-public');
  assert.equal(own.body.prenom, SECRET.prenom);
  const asA = await call('GET', '/candidatures/recues', 'user-rec-a');
  assert.equal(asA.body[0].name, `${SECRET.prenom} Q.`);
  assert.equal(Object.hasOwn(asA.body[0], 'snapshot'), false);
});

test('J — true et "true" produisent exactement la même exposition sur toutes ces routes', async () => {
  const exposure = async (flag) => {
    seed(flag);
    return JSON.stringify([
      (await call('GET', '/candidatures/recues', 'user-rec-a')).body,
      (await call('GET', '/candidatures/recues', 'user-rec-b')).body,
      (await call('GET', '/messages/threads', 'user-rec-b')).body,
      (await call('GET', '/candidats/cand-anon/certificat-public')).body,
    ]);
  };
  assert.equal(await exposure('true'), await exposure(true));
});

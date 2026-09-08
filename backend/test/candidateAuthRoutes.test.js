const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'test-service-key';

function mockModule(request, exports) {
  const filename = require.resolve(request);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

// ------------------------------------------------------------
// Donnees : deux candidats distincts, pour verifier qu'aucune route ne laisse
// fuiter le contenu de l'un vers l'autre.
// ------------------------------------------------------------
const CV_TEXT_A = `Antoine Alpha - Account Executive SaaS. ${'Prospection grands comptes, closing, negociation annuelle. '.repeat(6)}`;
const CV_TEXT_B = `Beatrice Beta - Sales Development Representative. ${'Cold call, sequences sortantes, qualification. '.repeat(6)}`;
const CV_TEXT_SHORT = 'CV scanne illisible.';

const CANDIDATS = [
  {
    id: 'candidat-a',
    user_id: 'user-a',
    axes: { meta: { cv_path: 'user-a/cv.pdf', cv_bucket: 'candidate-cvs', cv_file_name: 'cv-antoine.pdf' } },
  },
  {
    id: 'candidat-b',
    user_id: 'user-b',
    axes: { meta: { cv_path: 'user-b/cv.pdf', cv_bucket: 'candidate-cvs', cv_file_name: 'cv-beatrice.pdf' } },
  },
  // Aucun cv_path : etat metier "pas de CV", pas une erreur d'auth.
  { id: 'candidat-c', user_id: 'user-c', axes: { meta: {} } },
  // CV present mais trop peu de texte exploitable (document scanne).
  {
    id: 'candidat-d',
    user_id: 'user-d',
    axes: { meta: { cv_path: 'user-d/cv.pdf', cv_bucket: 'candidate-cvs', cv_file_name: 'scan.pdf' } },
  },
  // CV reference en base mais illisible dans le stockage.
  {
    id: 'candidat-e',
    user_id: 'user-e',
    axes: { meta: { cv_path: 'user-e/missing.pdf', cv_bucket: 'candidate-cvs', cv_file_name: 'perdu.pdf' } },
  },
];

const STORAGE = {
  'candidate-cvs/user-a/cv.pdf': CV_TEXT_A,
  'candidate-cvs/user-b/cv.pdf': CV_TEXT_B,
  'candidate-cvs/user-d/cv.pdf': CV_TEXT_SHORT,
};

const ROWS = {
  users: [
    { id: 'user-a', role: 'candidat' },
    { id: 'user-b', role: 'candidat' },
    { id: 'user-c', role: 'candidat' },
  ],
  matchs: [
    {
      id: 'match-a1',
      candidat_id: 'candidat-a',
      created_at: '2026-09-01T10:00:00.000Z',
      offres: { titre: 'AE SaaS', recruteurs: { user_id: 'user-rec-1', entreprise: 'Alpha Corp' } },
    },
    {
      id: 'match-b1',
      candidat_id: 'candidat-b',
      created_at: '2026-09-02T10:00:00.000Z',
      offres: { titre: 'SDR Fintech', recruteurs: { user_id: 'user-rec-2', entreprise: 'Beta Bank' } },
    },
  ],
  messages: [
    {
      id: 'msg-a1',
      match_id: 'match-a1',
      sender_id: 'user-rec-1',
      receiver_id: 'user-a',
      contenu: 'Message prive destine a Antoine',
      lu: false,
      created_at: '2026-09-03T10:00:00.000Z',
    },
    {
      id: 'msg-b1',
      match_id: 'match-b1',
      sender_id: 'user-rec-2',
      receiver_id: 'user-b',
      contenu: 'Message prive destine a Beatrice',
      lu: false,
      created_at: '2026-09-04T10:00:00.000Z',
    },
  ],
};

// ------------------------------------------------------------
// Faux client Supabase : uniquement ce que les deux routes utilisent.
// ------------------------------------------------------------
let storageFailure = null;

class Query {
  constructor(table) {
    this.table = table;
    this.rows = [...(ROWS[table] || [])];
  }

  select() { return this; }
  order() { return this; }
  limit() { return this; }

  eq(column, value) {
    this.rows = this.rows.filter((row) => String(row[column]) === String(value));
    return this;
  }

  in(column, values) {
    const wanted = values.map(String);
    this.rows = this.rows.filter((row) => wanted.includes(String(row[column])));
    return this;
  }

  // `or('sender_id.eq.X,receiver_id.eq.Y')`
  or(expression) {
    const clauses = expression.split(',').map((clause) => clause.split('.'));
    this.rows = this.rows.filter((row) => clauses.some(([column, , value]) => String(row[column]) === value));
    return this;
  }

  async maybeSingle() { return { data: this.rows[0] || null, error: null }; }
  async single() { return { data: this.rows[0] || null, error: null }; }
  then(resolve, reject) {
    return Promise.resolve({ data: this.rows, error: null }).then(resolve, reject);
  }
}

const fakeSupabase = {
  from(table) { return new Query(table); },
  storage: {
    from(bucket) {
      return {
        async download(path) {
          if (storageFailure) return { data: null, error: new Error(storageFailure) };
          const content = STORAGE[`${bucket}/${path}`];
          if (content === undefined) return { data: null, error: new Error('Object not found') };
          return {
            data: { arrayBuffer: async () => Buffer.from(content, 'utf8') },
            error: null,
          };
        },
        async createSignedUrl() { return { data: null, error: new Error('non utilise') }; },
      };
    },
    async getBucket() { return { error: null }; },
  },
};

mockModule('../supabase', fakeSupabase);

// Stand-in fidele au contrat du vrai middleware : pas de header -> 401,
// jeton inconnu -> 401, sinon l'utilisateur vient du jeton (jamais du client).
const USERS_BY_TOKEN = {
  'token-a': { id: 'user-a', email: 'a@example.com' },
  'token-b': { id: 'user-b', email: 'b@example.com' },
  'token-c': { id: 'user-c', email: 'c@example.com' },
  'token-d': { id: 'user-d', email: 'd@example.com' },
  'token-e': { id: 'user-e', email: 'e@example.com' },
};

mockModule('../middleware/auth', (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Non autorise', code: 'TOKEN_MISSING' });
  const user = USERS_BY_TOKEN[token];
  if (!user) return res.status(401).json({ error: 'Token invalide', code: 'TOKEN_INVALID' });
  req.user = user;
  return next();
});

mockModule('../utils/profiles', {
  ensureCandidateProfile: async (userId) => {
    const profile = CANDIDATS.find((candidat) => candidat.user_id === userId);
    if (!profile) {
      const error = new Error('Profil candidat introuvable');
      error.status = 404;
      throw error;
    }
    return profile;
  },
  ensureRecruiterProfile: async () => {
    const error = new Error('Acces reserve aux profils recruteurs');
    error.status = 403;
    throw error;
  },
  getCandidatePlan: async () => 'carriere_coaching',
  checkAndConsumeUsage: async () => ({ allowed: true, count: 1, limit: 10 }),
  getUserEmail: async () => 'test@example.com',
});

mockModule('../utils/brevoEvents', { trackBrevoEvent: async () => {}, upsertBrevoContact: async () => {} });
mockModule('../utils/anthropic', { askClaude: async () => 'non utilise' });
mockModule('../utils/cvReplacement', { finalizeCvReplacement: async () => ({}) });

const app = express();
app.use(express.json());
app.use('/api/candidats', require('../routes/candidats'));
app.use('/api/messages', require('../routes/messages'));

const server = app.listen(0);
const baseUrl = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

async function get(path, token) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (error) { body = text; }
  return { status: response.status, body };
}

// ============================================================
// GET /api/candidats/cv-text
// ============================================================

// CAS 1 : authentifie + texte de CV existant -> 200, et uniquement son CV.
test('CAS 1 — candidat authentifie avec CV : 200 et son propre texte', async () => {
  const response = await get('/api/candidats/cv-text', 'token-a');

  assert.equal(response.status, 200);
  assert.equal(response.body.readable, true);
  assert.equal(response.body.filename, 'cv-antoine.pdf');
  assert.match(response.body.text, /Antoine Alpha/);
  assert.equal(response.body.text.includes('Beatrice Beta'), false);
});

// CAS 2 : authentifie sans CV -> etat metier, surtout pas 401.
test('CAS 2 — candidat authentifie sans CV : etat metier explicite, pas 401', async () => {
  const response = await get('/api/candidats/cv-text', 'token-c');

  assert.notEqual(response.status, 401, 'une session valide ne doit jamais donner un 401');
  assert.equal(response.status, 404);
  assert.equal(response.body.code, 'NO_CV_STORED');
  assert.match(response.body.error, /Aucun CV/i);
});

test('CAS 2 bis — CV present mais illisible : 200 avec un etat metier, pas une erreur d’auth', async () => {
  const response = await get('/api/candidats/cv-text', 'token-d');

  assert.equal(response.status, 200);
  assert.equal(response.body.readable, false);
  assert.match(response.body.message, /scanne|corrompu|lisible/i);
});

// CAS 3 : anonyme -> 401.
test('CAS 3 — cv-text anonyme : 401', async () => {
  const anonymous = await get('/api/candidats/cv-text', null);
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.body.code, 'TOKEN_MISSING');

  const forged = await get('/api/candidats/cv-text', 'token-inconnu');
  assert.equal(forged.status, 401);
  assert.equal(forged.body.code, 'TOKEN_INVALID');
});

// CAS 4 : cloisonnement entre utilisateurs.
test('CAS 4 — l’utilisateur A ne peut pas lire le CV de l’utilisateur B', async () => {
  const asA = await get('/api/candidats/cv-text', 'token-a');
  const asB = await get('/api/candidats/cv-text', 'token-b');

  assert.match(asA.body.text, /Antoine Alpha/);
  assert.match(asB.body.text, /Beatrice Beta/);
  assert.equal(asA.body.text.includes('Beatrice'), false);
  assert.equal(asB.body.text.includes('Antoine'), false);

  // Le proprietaire vient du JWT : aucun parametre client ne doit le deplacer.
  const spoofed = await get('/api/candidats/cv-text?user_id=user-b&candidat_id=candidat-b', 'token-a');
  assert.equal(spoofed.status, 200);
  assert.match(spoofed.body.text, /Antoine Alpha/);
  assert.equal(spoofed.body.text.includes('Beatrice'), false);
});

// CAS 8 : une panne Supabase non liee a l'auth ne devient pas un 401.
test('CAS 8 — echec de lecture du stockage : statut de panne, jamais 401', async () => {
  const response = await get('/api/candidats/cv-text', 'token-e');

  assert.notEqual(response.status, 401);
  assert.equal(response.status, 502);
  // Pas de fuite du detail interne Supabase dans la reponse publique.
  assert.equal(JSON.stringify(response.body).includes('Object not found'), false);
});

test('CAS 8 bis — erreur Supabase inattendue : statut de panne, jamais 401', async () => {
  storageFailure = 'connection reset by peer';
  try {
    const response = await get('/api/candidats/cv-text', 'token-a');
    assert.notEqual(response.status, 401);
    assert.equal(response.status, 502);
    assert.equal(JSON.stringify(response.body).includes('connection reset'), false);
  } finally {
    storageFailure = null;
  }
});

// ============================================================
// GET /api/messages/threads
// ============================================================

// CAS 5 : aucun thread -> 200 [].
test('CAS 5 — candidat authentifie sans conversation : 200 et liste vide', async () => {
  const response = await get('/api/messages/threads', 'token-c');

  assert.notEqual(response.status, 401);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, []);
});

// CAS 6 : uniquement ses threads.
test('CAS 6 — candidat authentifie avec conversations : uniquement les siennes', async () => {
  const asA = await get('/api/messages/threads', 'token-a');

  assert.equal(asA.status, 200);
  assert.equal(asA.body.length, 1);
  assert.equal(asA.body[0].match_id, 'match-a1');
  assert.equal(asA.body[0].nom, 'Alpha Corp');
  assert.match(asA.body[0].prev, /Antoine/);

  const asB = await get('/api/messages/threads', 'token-b');
  assert.equal(asB.body.length, 1);
  assert.equal(asB.body[0].match_id, 'match-b1');

  const serializedA = JSON.stringify(asA.body);
  assert.equal(serializedA.includes('match-b1'), false);
  assert.equal(serializedA.includes('Beatrice'), false);
  assert.equal(serializedA.includes('Beta Bank'), false);
});

// CAS 7 : anonyme -> 401.
test('CAS 7 — threads anonyme : 401', async () => {
  const anonymous = await get('/api/messages/threads', null);
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.body.code, 'TOKEN_MISSING');

  const forged = await get('/api/messages/threads', 'token-inconnu');
  assert.equal(forged.status, 401);
});

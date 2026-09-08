const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';
process.env.SUPABASE_SERVICE_KEY ||= 'test-service-key';

function mockModule(request, exports) {
  const filename = require.resolve(request);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const USER_ROW = { id: 'user-a', email: 'a@example.com', role: 'candidat' };

let refreshSession = async () => ({ data: null, error: new Error('non configure') });
let signInWithPassword = async () => ({ data: null, error: new Error('non configure') });
const createClientOptions = [];

mockModule('@supabase/supabase-js', {
  createClient: (_url, _key, options) => {
    createClientOptions.push(options);
    return {
      auth: {
        refreshSession: (...args) => refreshSession(...args),
        signInWithPassword: (...args) => signInWithPassword(...args),
        signInWithOAuth: async () => ({ data: null, error: new Error('non utilise') }),
        signUp: async () => ({ data: null, error: new Error('non utilise') }),
        exchangeCodeForSession: async () => ({ data: null, error: new Error('non utilise') }),
        getUser: async () => ({ data: { user: null }, error: new Error('non utilise') }),
        resend: async () => ({ error: null }),
        resetPasswordForEmail: async () => ({ error: null }),
        signOut: async () => ({ error: null }),
      },
    };
  },
});

mockModule('../supabase', {
  from() {
    const query = {
      select: () => query,
      eq: () => query,
      limit: () => query,
      then: (resolve, reject) => Promise.resolve({ data: [USER_ROW], error: null }).then(resolve, reject),
    };
    return query;
  },
  auth: { admin: { updateUserById: async () => ({ error: null }) } },
});

mockModule('../middleware/auth', (_req, _res, next) => next());
mockModule('../utils/profiles', { ensureRoleProfile: async () => ({ id: 'candidat-a', user_id: 'user-a' }) });
mockModule('../utils/brevoEvents', { upsertBrevoContact: async () => {}, trackBrevoEvent: async () => {} });
mockModule('../utils/engagementTracking', { touchLastLogin: async () => {} });

const app = express();
app.use(express.json());
app.use('/api/auth', require('../routes/auth'));

const server = app.listen(0);
const baseUrl = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

async function post(path, body) {
  const logs = [];
  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = (...args) => logs.push(args.join(' '));
  console.warn = (...args) => logs.push(args.join(' '));
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch (error) { parsed = text; }
    return { status: response.status, body: parsed, logs };
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
  }
}

// Cause racine : le client ne recevait que l'access_token, donc aucun moyen de
// prolonger la session. Une fois le JWT expire, toutes les routes protegees
// repondaient 401 — y compris candidats/cv-text et messages/threads.
test('la connexion renvoie de quoi prolonger la session', async () => {
  signInWithPassword = async () => ({
    data: {
      user: { id: 'user-a', email: 'a@example.com' },
      session: { access_token: 'access-1', refresh_token: 'refresh-1', expires_at: 1790000000 },
    },
    error: null,
  });

  const response = await post('/api/auth/login', { email: 'a@example.com', password: 'motdepasse' });

  assert.equal(response.status, 200);
  assert.equal(response.body.token, 'access-1');
  assert.equal(response.body.refresh_token, 'refresh-1', 'sans refresh_token la session ne peut pas etre prolongee');
  assert.equal(response.body.expires_at, 1790000000);
});

test('refresh sans jeton : 400, et aucun appel a Supabase', async () => {
  let called = false;
  refreshSession = async () => { called = true; return { data: null, error: null }; };

  const response = await post('/api/auth/refresh', {});

  assert.equal(response.status, 400);
  assert.equal(response.body.code, 'REFRESH_TOKEN_MISSING');
  assert.equal(called, false);
});

test('refresh valide : nouvelle paire de jetons', async () => {
  let received = null;
  refreshSession = async (payload) => {
    received = payload;
    return {
      data: { session: { access_token: 'access-2', refresh_token: 'refresh-2', expires_at: 1790003600 } },
      error: null,
    };
  };

  const response = await post('/api/auth/refresh', { refresh_token: 'refresh-1' });

  assert.equal(response.status, 200);
  assert.deepEqual(received, { refresh_token: 'refresh-1' });
  assert.equal(response.body.token, 'access-2');
  // Les refresh_token Supabase tournent : le client doit recevoir le nouveau.
  assert.equal(response.body.refresh_token, 'refresh-2');
});

test('refresh refuse : 401 explicite, sans detail Supabase', async () => {
  refreshSession = async () => ({ data: null, error: new Error('Invalid Refresh Token: Already Used') });

  const response = await post('/api/auth/refresh', { refresh_token: 'refresh-perime' });

  assert.equal(response.status, 401);
  assert.equal(response.body.code, 'REFRESH_REJECTED');
  assert.equal(JSON.stringify(response.body).includes('Already Used'), false);
});

test('refresh sans session renvoyee : 401, jamais un succes vide', async () => {
  refreshSession = async () => ({ data: { session: null }, error: null });

  const response = await post('/api/auth/refresh', { refresh_token: 'refresh-1' });

  assert.equal(response.status, 401);
  assert.equal(response.body.code, 'REFRESH_REJECTED');
});

// Meme regle que pour le middleware : une panne n'est pas une session invalide.
test('panne du service de refresh : 503, pas 401', async () => {
  refreshSession = async () => { throw new Error('socket hang up'); };

  const response = await post('/api/auth/refresh', { refresh_token: 'refresh-1' });

  assert.notEqual(response.status, 401);
  assert.equal(response.status, 503);
  assert.equal(response.body.code, 'AUTH_UNAVAILABLE');
  assert.equal(JSON.stringify(response.body).includes('socket hang up'), false);
});

test('le client de refresh ne conserve aucune session entre les requetes', async () => {
  const stateless = createClientOptions.filter(
    (options) => options?.auth?.persistSession === false,
  );
  assert.ok(
    stateless.length >= 1,
    'un client partage par toutes les requetes ne doit pas stocker la session de l’appelant',
  );
});

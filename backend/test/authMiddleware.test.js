const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';

function mockModule(request, exports) {
  const filename = require.resolve(request);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

// Erreurs telles que @supabase/auth-js les produit reellement (lib/fetch.js) :
//  - echec de fetch           -> AuthRetryableFetchError, status 0
//  - 502/503/504/520-530      -> AuthRetryableFetchError, status HTTP
//  - tout le reste (429, 500) -> AuthApiError
function authError(name, status, code) {
  const error = new Error(`${name} ${status}`);
  error.name = name;
  error.status = status;
  if (code) error.code = code;
  return error;
}

let getUser = async () => ({ data: { user: null }, error: null });
let getUserCalls = [];
let createClientCalls = 0;

mockModule('@supabase/supabase-js', {
  createClient: () => {
    createClientCalls += 1;
    return {
      auth: {
        getUser: (token) => {
          getUserCalls.push(token);
          return getUser(token);
        },
      },
    };
  },
});

const authMiddleware = require('../middleware/auth');

const VALID_USER = { id: 'user-a', email: 'a@example.com' };

async function call(headers = {}) {
  const req = { headers };
  const result = { status: null, body: null, nextCalled: false };
  const res = {
    status(code) { result.status = code; return this; },
    json(payload) { result.body = payload; return this; },
  };

  const logs = [];
  const originalError = console.error;
  console.error = (...args) => logs.push(args.map((a) => JSON.stringify(a)).join(' '));
  try {
    await authMiddleware(req, res, () => { result.nextCalled = true; });
  } finally {
    console.error = originalError;
  }

  return { ...result, req, logs };
}

test.beforeEach(() => {
  getUserCalls = [];
  getUser = async () => ({ data: { user: null }, error: null });
});

// CAS 3 / CAS 7 : anonyme sur candidats/cv-text comme sur messages/threads.
test('aucun token : 401 sans meme interroger Supabase', async () => {
  const withoutHeader = await call({});
  assert.equal(withoutHeader.status, 401);
  assert.equal(withoutHeader.body.code, 'TOKEN_MISSING');
  assert.equal(withoutHeader.nextCalled, false);

  // Un header present mais sans jeton ne doit pas non plus passer.
  const emptyBearer = await call({ authorization: 'Bearer' });
  assert.equal(emptyBearer.status, 401);
  assert.equal(emptyBearer.nextCalled, false);

  assert.deepEqual(getUserCalls, [], 'aucun appel reseau pour une requete anonyme');
});

test('token valide : la requete passe avec l’utilisateur du JWT', async () => {
  getUser = async () => ({ data: { user: VALID_USER }, error: null });

  const result = await call({ authorization: 'Bearer good-token' });

  assert.equal(result.nextCalled, true);
  assert.equal(result.status, null);
  assert.equal(result.req.user.id, 'user-a');
  assert.deepEqual(getUserCalls, ['good-token']);
});

test('token refuse par GoTrue (invalide ou expire) : 401', async () => {
  for (const status of [400, 401, 403, 404, 422]) {
    getUser = async () => ({ data: { user: null }, error: authError('AuthApiError', status, 'bad_jwt') });
    const result = await call({ authorization: 'Bearer expired-token' });
    assert.equal(result.status, 401, `status GoTrue ${status} doit rester un 401 public`);
    assert.equal(result.body.code, 'TOKEN_INVALID');
    assert.equal(result.nextCalled, false);
  }
});

// CAS 8 : une panne Supabase non liee a l'authentification ne doit jamais etre
// maquillee en 401. C'est ce qui rendait le diagnostic production impossible :
// une session expiree et un GoTrue rate-limite renvoyaient exactement la meme
// reponse.
test('panne de verification : 503, jamais 401', async () => {
  const failures = [
    ['fetch echoue (reseau/DNS)', authError('AuthRetryableFetchError', 0)],
    ['rate limit GoTrue', authError('AuthApiError', 429, 'over_request_rate_limit')],
    ['erreur interne GoTrue', authError('AuthApiError', 500, 'unexpected_failure')],
    ['infrastructure indisponible', authError('AuthRetryableFetchError', 503)],
    ['timeout passerelle', authError('AuthRetryableFetchError', 504)],
    ['status inconnu', authError('AuthUnknownError', undefined)],
  ];

  for (const [label, error] of failures) {
    getUser = async () => ({ data: { user: null }, error });
    const result = await call({ authorization: 'Bearer good-token' });

    assert.notEqual(result.status, 401, `${label} ne doit pas etre un 401`);
    assert.equal(result.status, 503, label);
    assert.equal(result.body.code, 'AUTH_UNAVAILABLE');
    assert.equal(result.nextCalled, false);
  }
});

test('une exception de getUser devient 503, pas un 500 non gere ni un 401', async () => {
  getUser = async () => { throw new Error('socket hang up'); };

  const result = await call({ authorization: 'Bearer good-token' });

  assert.equal(result.status, 503);
  assert.equal(result.body.code, 'AUTH_UNAVAILABLE');
  assert.equal(result.nextCalled, false);
});

test('un incident transitoire est retente une fois avant de conclure', async () => {
  let attempts = 0;
  getUser = async () => {
    attempts += 1;
    if (attempts === 1) return { data: { user: null }, error: authError('AuthRetryableFetchError', 0) };
    return { data: { user: VALID_USER }, error: null };
  };

  const result = await call({ authorization: 'Bearer good-token' });

  assert.equal(attempts, 2);
  assert.equal(result.nextCalled, true);
  assert.equal(result.req.user.id, 'user-a');
});

test('un token refuse n’est pas retente', async () => {
  let attempts = 0;
  getUser = async () => {
    attempts += 1;
    return { data: { user: null }, error: authError('AuthApiError', 401, 'bad_jwt') };
  };

  const result = await call({ authorization: 'Bearer expired-token' });

  assert.equal(attempts, 1, 'inutile de repayer un aller-retour pour un token deja refuse');
  assert.equal(result.status, 401);
});

test('GoTrue repond sans erreur mais sans utilisateur : refus, jamais un acces par defaut', async () => {
  getUser = async () => ({ data: { user: null }, error: null });

  const result = await call({ authorization: 'Bearer odd-token' });

  assert.equal(result.nextCalled, false);
  assert.equal(result.status, 401);
});

test('la reponse publique ne divulgue ni le token ni le detail technique', async () => {
  getUser = async () => ({
    data: { user: null },
    error: authError('AuthApiError', 500, 'unexpected_failure'),
  });

  const result = await call({ authorization: 'Bearer super-secret-token' });

  const serialized = JSON.stringify(result.body);
  assert.equal(serialized.includes('super-secret-token'), false);
  assert.equal(serialized.includes('unexpected_failure'), false);
  assert.equal(serialized.includes('AuthApiError'), false);

  // Le detail reste cote serveur, pour pouvoir diagnostiquer sans exposer le token.
  const logged = result.logs.join(' ');
  assert.equal(logged.includes('unexpected_failure'), true);
  assert.equal(logged.includes('super-secret-token'), false);
});

test('le client Supabase est partage entre les requetes', async () => {
  getUser = async () => ({ data: { user: VALID_USER }, error: null });
  const before = createClientCalls;

  await call({ authorization: 'Bearer good-token' });
  await call({ authorization: 'Bearer good-token' });
  await call({ authorization: 'Bearer good-token' });

  assert.equal(createClientCalls, before, 'aucun nouveau client par requete authentifiee');
});

const test = require('node:test');
const assert = require('node:assert/strict');

const apiErrorHandler = require('../middleware/apiErrorHandler');

function fakeRes() {
  const res = {
    statusCode: null,
    body: undefined,
    headersSent: false,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
}

// Repro : express.json() (ou tout autre middleware) rejette une requete /api/*
// avant qu'une route ne soit atteinte (body JSON malforme, payload trop
// volumineux...). Sans ce gestionnaire, Express renverrait sa page HTML par
// defaut, que le frontend ne sait pas parser (JSON.parse echoue), d'ou le
// message generique "Erreur serveur" sans aucune information exploitable.
test('erreur /api/* sans statut connu -> JSON 500 exploitable', () => {
  const req = { path: '/api/assistant/cv-analyses', method: 'POST' };
  const res = fakeRes();
  let nextCalled = false;
  const originalError = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args);
  try {
    apiErrorHandler(new Error('body JSON malforme'), req, res, () => { nextCalled = true; });
  } finally {
    console.error = originalError;
  }
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 500);
  assert.equal(typeof res.body.error, 'string');
  assert.ok(res.body.error.length > 0);
  assert.equal(res.body.code, 'SERVER_ERROR');
  // La reponse JSON reste toujours parsable : c'est le point precis que ce
  // gestionnaire corrige (avant, une erreur ici produisait du HTML).
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(res.body)));
  assert.match(JSON.stringify(logs), /body JSON malforme/);
});

test('payload trop volumineux (413, express.json PayloadTooLargeError) -> message dedie', () => {
  const req = { path: '/api/assistant/cv-analyses', method: 'POST' };
  const res = fakeRes();
  const err = Object.assign(new Error('request entity too large'), { status: 413, type: 'entity.too.large' });
  const originalError = console.error;
  console.error = () => {};
  try {
    apiErrorHandler(err, req, res, () => {});
  } finally {
    console.error = originalError;
  }
  assert.equal(res.statusCode, 413);
  assert.match(res.body.error, /volumineux/i);
});

test('routes non /api/* : laisse Express gerer (comportement statique inchange)', () => {
  const req = { path: '/swipsales_landing.html', method: 'GET' };
  const res = fakeRes();
  let forwarded = null;
  const err = new Error('boom');
  apiErrorHandler(err, req, res, (passed) => { forwarded = passed; });
  assert.equal(forwarded, err);
  assert.equal(res.statusCode, null);
});

test('reponse deja envoyee : ne tente pas de renvoyer un second res.json', () => {
  const req = { path: '/api/candidats/deck', method: 'GET' };
  const res = fakeRes();
  res.headersSent = true;
  let forwarded = null;
  const err = new Error('boom apres envoi');
  apiErrorHandler(err, req, res, (passed) => { forwarded = passed; });
  assert.equal(forwarded, err);
  assert.equal(res.body, undefined);
});

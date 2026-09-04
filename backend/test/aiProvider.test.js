const test = require('node:test');
const assert = require('node:assert/strict');
const { safeText, parseJsonResponse, callAi, isAiConfigured } = require('../utils/aiProvider');

test('safeText refuse les contenus trop longs', () => {
  assert.throws(() => safeText('abcdef', 3), /trop long/);
  assert.equal(safeText('  CV valide  ', 20), 'CV valide');
});

test('parseJsonResponse accepte un objet JSON clôturé par markdown', () => {
  assert.deepEqual(parseJsonResponse('```json\n{"strengths":["Clair"]}\n```'), { strengths: ['Clair'] });
});

test('callAi échoue explicitement sans configuration', async () => {
  const previousKey = process.env.AI_API_KEY;
  const previousModel = process.env.AI_MODEL;
  delete process.env.AI_API_KEY;
  delete process.env.AI_MODEL;
  assert.equal(isAiConfigured(), false);
  await assert.rejects(() => callAi({ messages: [] }), (error) => error.status === 503 && error.code === 'AI_NOT_CONFIGURED');
  if (previousKey === undefined) delete process.env.AI_API_KEY; else process.env.AI_API_KEY = previousKey;
  if (previousModel === undefined) delete process.env.AI_MODEL; else process.env.AI_MODEL = previousModel;
});

test('callAi traite une réponse fournisseur simulée sans exposer la clé', async () => {
  const originalFetch = global.fetch;
  const previous = { key: process.env.AI_API_KEY, model: process.env.AI_MODEL, url: process.env.AI_API_URL };
  process.env.AI_API_KEY = 'test-secret-never-log';
  process.env.AI_MODEL = 'test-model';
  process.env.AI_API_URL = 'https://provider.invalid/v1/chat/completions';
  let request;
  global.fetch = async (_url, options) => {
    request = options;
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"ok":true}' } }] }) };
  };
  try {
    assert.deepEqual(await callAi({ messages: [{ role: 'user', content: 'test' }], json: true }), { ok: true });
    assert.equal(request.headers.Authorization, 'Bearer test-secret-never-log');
    assert.equal(JSON.parse(request.body).model, 'test-model');
  } finally {
    global.fetch = originalFetch;
    for (const [name, value] of Object.entries({ AI_API_KEY: previous.key, AI_MODEL: previous.model, AI_API_URL: previous.url })) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

test('callAi classe une réponse JSON fournisseur invalide comme erreur amont', async () => {
  const originalFetch = global.fetch;
  const previous = { key: process.env.AI_API_KEY, model: process.env.AI_MODEL, url: process.env.AI_API_URL };
  process.env.AI_API_KEY = 'test-key'; process.env.AI_MODEL = 'test-model'; process.env.AI_API_URL = 'https://provider.invalid/v1/chat/completions';
  global.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'pas du json' } }] }) });
  try {
    await assert.rejects(() => callAi({ messages: [], json: true }), (error) => error.status === 502 && error.code === 'AI_INVALID_RESPONSE');
  } finally {
    global.fetch = originalFetch;
    for (const [name, value] of Object.entries({ AI_API_KEY: previous.key, AI_MODEL: previous.model, AI_API_URL: previous.url })) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

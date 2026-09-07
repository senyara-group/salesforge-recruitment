const test = require('node:test');
const assert = require('node:assert/strict');
const { APIConnectionTimeoutError } = require('@anthropic-ai/sdk');
const { safeText, parseJsonResponse, anthropicMessages, callAi, isAiConfigured, isAiTimeoutError } = require('../utils/aiProvider');

test('safeText refuse les contenus trop longs', () => {
  assert.throws(() => safeText('abcdef', 3), /trop long/);
  assert.equal(safeText('  CV valide  ', 20), 'CV valide');
});

test('parseJsonResponse accepte un objet JSON clôturé par markdown', () => {
  assert.deepEqual(parseJsonResponse('```json\n{"strengths":["Clair"]}\n```'), { strengths: ['Clair'] });
});

test('callAi échoue explicitement sans configuration Anthropic', async () => {
  const previousKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal(isAiConfigured(), false);
  await assert.rejects(() => callAi({ messages: [] }), (error) => error.status === 503 && error.code === 'AI_NOT_CONFIGURED');
  if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = previousKey;
});

test('les messages système sont adaptés au format Anthropic', () => {
  const result = anthropicMessages([
    { role: 'system', content: 'Instructions' },
    { role: 'user', content: 'Question' },
    { role: 'assistant', content: 'Réponse' },
  ]);
  assert.equal(result.system, 'Instructions');
  assert.deepEqual(result.messages, [
    { role: 'user', content: 'Question' },
    { role: 'assistant', content: 'Réponse' },
  ]);
});

test('callAi traite une réponse Anthropic simulée sans clé réelle', async () => {
  let request;
  const providerCall = async (options) => { request = options; return '{"ok":true}'; };
  const result = await callAi({
    messages: [{ role: 'system', content: 'Reste factuel' }, { role: 'user', content: 'test' }],
    json: true,
    providerCall,
  });
  assert.deepEqual(result, { ok: true });
  assert.match(request.system, /objet JSON valide/);
  assert.deepEqual(request.messages, [{ role: 'user', content: 'test' }]);
});

test('callAi classe une réponse JSON fournisseur invalide comme erreur amont', async () => {
  await assert.rejects(
    () => callAi({ messages: [], json: true, providerCall: async () => 'pas du json' }),
    (error) => error.status === 502 && error.code === 'AI_INVALID_RESPONSE',
  );
});

test('isAiTimeoutError détecte le timeout SDK malgré name=Error', () => {
  const timeout = new APIConnectionTimeoutError();
  assert.equal(timeout.name, 'Error');
  assert.equal(isAiTimeoutError(timeout), true);
  assert.equal(isAiTimeoutError(new Error('Request timed out.')), true);
  assert.equal(isAiTimeoutError(new Error('Service down')), false);
});

test('callAi mappe un timeout fournisseur vers AI_TIMEOUT', async () => {
  await assert.rejects(
    () => callAi({
      messages: [{ role: 'user', content: 'test' }],
      providerCall: async () => { throw new APIConnectionTimeoutError(); },
    }),
    (error) => error.status === 504 && error.code === 'AI_TIMEOUT',
  );
});

test('callAi transmet timeoutMs et maxRetries au provider', async () => {
  let request;
  await callAi({
    messages: [{ role: 'user', content: 'ping' }],
    timeoutMs: 55000,
    maxRetries: 0,
    providerCall: async (options) => { request = options; return 'ok'; },
  });
  assert.equal(request.timeoutMs, 55000);
  assert.equal(request.maxRetries, 0);
});

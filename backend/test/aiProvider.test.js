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

test('parseJsonResponse accepte du texte avant/après si un objet JSON est extractible', () => {
  assert.deepEqual(
    parseJsonResponse('Voici le résultat:\n{"ok":true}\nFin.'),
    { ok: true },
  );
});

test('parseJsonResponse échoue sur un JSON tronqué sans accolade fermante', () => {
  assert.throws(
    () => parseJsonResponse('{"strengths":["A"],"improved_cv":"Début sans fin'),
    (error) => error.message === 'Reponse IA invalide' && error.diagnostics?.stage === 'json_parse'
      && error.diagnostics.has_open_brace === true && error.diagnostics.has_close_brace === false,
  );
});

test('callAi conserve les diagnostics de parse sans exposer le contenu', async () => {
  await assert.rejects(
    () => callAi({
      messages: [],
      json: true,
      providerCall: async () => ({
        text: '{"strengths":["A"],"improved_cv":"coupe',
        meta: { stop_reason: 'max_tokens', input_tokens: 100, output_tokens: 2500, response_chars: 40, has_open_brace: true, has_close_brace: false, has_markdown_fence: false },
      }),
    }),
    (error) => error.code === 'AI_INVALID_RESPONSE'
      && error.diagnostics?.stage === 'json_parse'
      && error.diagnostics?.stop_reason === 'max_tokens'
      && error.diagnostics?.output_tokens === 2500
      && error.diagnostics?.has_close_brace === false
      && !JSON.stringify(error.diagnostics).includes('coupe'),
  );
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

const test = require('node:test');
const assert = require('node:assert/strict');
const { safeText, parseJsonResponse, anthropicMessages, callAi, isAiConfigured } = require('../utils/aiProvider');

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

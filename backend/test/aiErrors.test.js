const test = require('node:test');
const assert = require('node:assert/strict');
const { publicAiError } = require('../utils/aiErrors');

test('une table IA absente ne divulgue pas le détail Supabase', () => {
  const technical = "Could not find the table 'public.ai_conversations' in the schema cache";
  const result = publicAiError({ code: 'PGRST205', message: technical });
  assert.equal(result.status, 503);
  assert.equal(result.code, 'AI_STORAGE_UNAVAILABLE');
  assert.doesNotMatch(result.message, /ai_conversations|schema cache/i);
});

test('une configuration fournisseur absente produit un message public stable', () => {
  const result = publicAiError({ code: 'AI_NOT_CONFIGURED', message: 'ANTHROPIC_API_KEY missing', status: 503 });
  assert.deepEqual(result, {
    status: 503,
    code: 'AI_NOT_CONFIGURED',
    message: 'L’assistant est momentanément indisponible.',
  });
});

test('les erreurs fournisseur et réponses invalides restent réessayables', () => {
  for (const code of ['AI_PROVIDER_ERROR', 'AI_INVALID_RESPONSE', 'AI_TIMEOUT']) {
    const result = publicAiError({ code, message: 'technical provider payload', status: 502 });
    assert.match(result.message, /réessayer/i);
    assert.doesNotMatch(result.message, /technical|provider payload/i);
  }
});

test('le quota atteint possède un code et un message dédiés', () => {
  const result = publicAiError({ code: 'AI_QUOTA_REACHED' });
  assert.equal(result.status, 429);
  assert.match(result.message, /quota mensuel/i);
});

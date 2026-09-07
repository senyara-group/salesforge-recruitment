const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'test-service-key';

const rows = {
  ai_cv_analyses: [{ id: 'analysis-b', user_id: 'user-b', improved_text: 'original-b' }],
  ai_conversations: [{ id: 'conversation-b', user_id: 'user-b', mode: 'pitch', title: 'Privée B', context_data: {} }],
  ai_conversation_messages: [{ id: 'message-b', conversation_id: 'conversation-b', user_id: 'user-b', role: 'assistant', content: 'secret-b' }],
};
const operations = [];

class Query {
  constructor(table) { this.table = table; this.filters = []; this.operation = 'select'; this.payload = null; }
  select() { return this; }
  update(payload) { this.operation = 'update'; this.payload = payload; return this; }
  insert(payload) { this.operation = 'insert'; this.payload = payload; return this; }
  delete() { this.operation = 'delete'; return this; }
  eq(column, value) { this.filters.push([column, value]); return this; }
  order() { return this; }
  limit() { return this; }
  async single() { return this.execute(true); }
  async maybeSingle() { return this.execute(true); }
  then(resolve, reject) { return Promise.resolve(this.execute(false)).then(resolve, reject); }
  execute(single) {
    operations.push({ table: this.table, operation: this.operation, filters: [...this.filters], payload: this.payload });
    const matching = (rows[this.table] || []).filter((row) => this.filters.every(([key, value]) => row[key] === value));
    if (this.operation === 'insert') {
      const value = { id: `${this.table}-new`, ...(Array.isArray(this.payload) ? this.payload[0] : this.payload) };
      rows[this.table].push(value); return { data: single ? value : [value], error: null };
    }
    if (this.operation === 'update') matching.forEach((row) => Object.assign(row, this.payload));
    if (this.operation === 'delete') matching.forEach((row) => rows[this.table].splice(rows[this.table].indexOf(row), 1));
    return { data: single ? (matching[0] || null) : matching, error: null };
  }
}

const fakeSupabase = { from(table) { return new Query(table); } };
function mockModule(relativePath, exports) {
  const filename = require.resolve(relativePath);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

mockModule('../supabase', fakeSupabase);
mockModule('../middleware/auth', (_req, _res, next) => next());
mockModule('../middleware/aiRateLimit', () => (_req, _res, next) => next());
mockModule('../utils/profiles', { ensureCandidateProfile: async (id) => ({ id, titre: 'Profil fictif' }) });
mockModule('../utils/aiAccess', { assertAiAccess: async () => {}, configuredPlans: () => new Set(['all']) });
mockModule('../utils/aiProvider', {
  callAi: async () => { throw new Error('Un appel Anthropic ne doit pas avoir lieu dans ces tests'); },
  isAiConfigured: () => true,
  safeText: (value, max = 40000) => String(value || '').slice(0, max),
});

delete require.cache[require.resolve('../routes/assistant')];
const router = require('../routes/assistant');

function handler(method, routePath) {
  const layer = router.stack.find((item) => item.route?.path === routePath && item.route.methods[method]);
  assert.ok(layer, `route ${method.toUpperCase()} ${routePath} absente`);
  return layer.route.stack.at(-1).handle;
}

async function invoke(method, routePath, { userId = 'user-a', params = {}, body = {} } = {}) {
  const response = { statusCode: 200, payload: undefined };
  const res = {
    status(code) { response.statusCode = code; return this; },
    json(payload) { response.payload = payload; return this; },
  };
  await handler(method, routePath)({ user: { id: userId }, params, body }, res);
  return response;
}

test('GET conversation refuse à A la conversation de B sans lire ses messages', async () => {
  operations.length = 0;
  const response = await invoke('get', '/conversations/:id', { params: { id: 'conversation-b' } });
  assert.equal(response.statusCode, 404);
  assert.deepEqual(operations[0].filters, [['id', 'conversation-b'], ['user_id', 'user-a']]);
  assert.equal(operations.some((op) => op.table === 'ai_conversation_messages'), false);
  assert.doesNotMatch(JSON.stringify(response.payload), /secret-b/);
});

test('PUT analyse refuse à A la modification de l’analyse de B', async () => {
  operations.length = 0;
  const response = await invoke('put', '/cv-analyses/:id', { params: { id: 'analysis-b' }, body: { improved_text: 'attaque-a' } });
  assert.equal(response.statusCode, 404);
  assert.deepEqual(operations[0].filters, [['id', 'analysis-b'], ['user_id', 'user-a']]);
  assert.equal(rows.ai_cv_analyses[0].improved_text, 'original-b');
});

test('DELETE conversation refuse à A la suppression de la conversation de B', async () => {
  operations.length = 0;
  const response = await invoke('delete', '/conversations/:id', { params: { id: 'conversation-b' } });
  assert.equal(response.statusCode, 404);
  assert.deepEqual(operations[0].filters, [['id', 'conversation-b'], ['user_id', 'user-a']]);
  assert.equal(operations.some((op) => op.operation === 'delete'), false);
  assert.equal(rows.ai_conversations.some((row) => row.id === 'conversation-b'), true);
});

test('POST conversation ignore le user_id arbitraire du body au profit du JWT', async () => {
  operations.length = 0;
  const response = await invoke('post', '/conversations', { body: { mode: 'pitch', user_id: 'user-b' } });
  assert.equal(response.statusCode, 201);
  const insert = operations.find((op) => op.table === 'ai_conversations' && op.operation === 'insert');
  assert.equal(insert.payload.user_id, 'user-a');
});

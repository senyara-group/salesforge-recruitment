const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'test-service-key';

const rows = {
  ai_conversations: [],
  ai_conversation_messages: [],
};
const operations = [];
const logged = [];

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
      const value = { id: `${this.table}-${rows[this.table].length + 1}`, ...(Array.isArray(this.payload) ? this.payload[0] : this.payload) };
      rows[this.table].push(value);
      return { data: single ? value : [value], error: null };
    }
    if (this.operation === 'update') matching.forEach((row) => Object.assign(row, this.payload));
    if (this.operation === 'delete') {
      for (let i = rows[this.table].length - 1; i >= 0; i -= 1) {
        if (this.filters.every(([key, value]) => rows[this.table][i][key] === value)) rows[this.table].splice(i, 1);
      }
    }
    return { data: single ? (matching[0] || null) : matching, error: null };
  }
}

function mockModule(relativePath, exports) {
  const filename = require.resolve(relativePath);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

mockModule('../supabase', { from(table) { return new Query(table); } });
mockModule('../middleware/auth', (req, _res, next) => { req.user = { id: req.headers?.['x-user'] || 'user-a' }; next(); });
mockModule('../middleware/aiRateLimit', () => (_req, _res, next) => next());
mockModule('../utils/profiles', { ensureCandidateProfile: async (id) => ({ id, titre: 'AE SaaS', axes: { meta: { ville: 'Lyon' } } }) });
mockModule('../utils/aiAccess', {
  assertAiAccess: async () => ({ plan: 'carriere_coaching' }),
  configuredPlans: () => new Set(['carriere_coaching']),
  getAiPlan: async () => 'carriere_coaching',
});
mockModule('../utils/aiProvider', {
  callAi: async () => ({ value: { feedback: { works: '', missing: '', rewrite: '' }, next: { type: 'objection', content: 'C’est trop cher.' } }, meta: {} }),
  isAiConfigured: () => true,
  safeText: (value, max = 40000) => String(value == null ? '' : value).slice(0, max),
});
mockModule('../utils/aiUsage', {
  usageFor: async () => ({ coach: { quota: 100, used: 0, remaining: 100 } }),
  reserveUsage: async () => ({ id: 'r1', feature: 'coach' }),
  releaseUsage: async () => {},
  finalizeUsage: async () => {},
});

const originalError = console.error;
console.error = (...args) => { logged.push(args); };

delete require.cache[require.resolve('../routes/assistant')];
const router = require('../routes/assistant');

function handler(method, routePath) {
  const layer = router.stack.find((item) => item.route?.path === routePath && item.route.methods[method]);
  assert.ok(layer, `${method} ${routePath}`);
  return layer.route.stack.at(-1).handle;
}

async function invoke(method, routePath, { body = {}, params = {}, userId = 'user-a' } = {}) {
  const response = { statusCode: 200, payload: undefined };
  const res = {
    status(code) { response.statusCode = code; return this; },
    json(payload) { response.payload = payload; return this; },
  };
  await handler(method, routePath)({ user: { id: userId }, body, params, headers: { 'x-user': userId } }, res);
  return response;
}

test('A. absent simulation_type → 201 recruitment', async () => {
  rows.ai_conversations.length = 0;
  const res = await invoke('post', '/conversations', { body: { mode: 'simulation' } });
  assert.equal(res.statusCode, 201);
  assert.equal(res.payload.simulation_type, 'recruitment');
  assert.equal(rows.ai_conversations[0].context_data.simulation_type, 'recruitment');
});

test('B/C. recruitment et commercial exacts → 201', async () => {
  for (const type of ['recruitment', 'commercial']) {
    const res = await invoke('post', '/conversations', { body: { mode: 'simulation', simulation_type: type } });
    assert.equal(res.statusCode, 201);
    assert.equal(res.payload.simulation_type, type);
  }
});

test('D–I. valeurs présentes invalides → 4xx, jamais 500, sans log de la valeur brute', async () => {
  const malicious = { toString() { return 'commercial'; } };
  const cases = [
    null, '', ' ', ['commercial'], ['recruitment'], {}, malicious, true, false, 1, 'COMMERCIAL', 'sales',
  ];
  logged.length = 0;
  for (const value of cases) {
    const res = await invoke('post', '/conversations', { body: { mode: 'simulation', simulation_type: value } });
    assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(value)}`);
    assert.notEqual(res.statusCode, 500);
    assert.match(res.payload.error || '', /invalide|recruitment|commercial/i);
  }
  const dump = JSON.stringify(logged);
  assert.doesNotMatch(dump, /toString|COMMERCIAL|"sales"/);
});

test('J. commercial créé → GET détail commercial', async () => {
  rows.ai_conversations.length = 0;
  rows.ai_conversation_messages.length = 0;
  const created = await invoke('post', '/conversations', { body: { mode: 'simulation', simulation_type: 'commercial' } });
  const detail = await invoke('get', '/conversations/:id', { params: { id: created.payload.id } });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.payload.simulation_type, 'commercial');
  assert.equal(Object.hasOwn(detail.payload, 'context_data'), false);
});

test('K. legacy sans subtype en base → GET recruitment', async () => {
  rows.ai_conversations.push({
    id: 'legacy-1', user_id: 'user-a', mode: 'simulation', title: 'Objections',
    context_data: { use_profile: false }, created_at: '2026-01-01', updated_at: '2026-01-01',
  });
  const detail = await invoke('get', '/conversations/:id', { params: { id: 'legacy-1' } });
  assert.equal(detail.payload.simulation_type, 'recruitment');
});

test('L. commercial + historique → PATCH interview refusé, historique et subtype inchangés', async () => {
  rows.ai_conversations.length = 0;
  rows.ai_conversation_messages.length = 0;
  const created = await invoke('post', '/conversations', { body: { mode: 'simulation', simulation_type: 'commercial' } });
  const id = created.payload.id;
  rows.ai_conversation_messages.push({
    id: 'm1', conversation_id: id, user_id: 'user-a', role: 'user', content: 'Ma réponse', created_at: '2026-01-02',
  });
  const before = rows.ai_conversation_messages.length;
  const patched = await invoke('patch', '/conversations/:id', { params: { id }, body: { mode: 'interview' } });
  assert.equal(patched.statusCode, 409);
  assert.equal(patched.payload.code, 'CONVERSATION_MODE_IMMUTABLE');
  assert.equal(rows.ai_conversations.find((row) => row.id === id).mode, 'simulation');
  assert.equal(rows.ai_conversations.find((row) => row.id === id).context_data.simulation_type, 'commercial');
  assert.equal(rows.ai_conversation_messages.length, before);
});

test('M. recruitment + historique → tentative commercial refusée', async () => {
  const created = await invoke('post', '/conversations', { body: { mode: 'simulation', simulation_type: 'recruitment' } });
  const id = created.payload.id;
  rows.ai_conversation_messages.push({
    id: 'm2', conversation_id: id, user_id: 'user-a', role: 'assistant', content: 'Objection', created_at: '2026-01-03',
  });
  const patched = await invoke('patch', '/conversations/:id', {
    params: { id },
    body: { mode: 'simulation', simulation_type: 'commercial' },
  });
  assert.equal(patched.statusCode, 409);
  assert.equal(patched.payload.code, 'CONVERSATION_CONTEXT_IMMUTABLE');
  assert.equal(rows.ai_conversations.find((row) => row.id === id).context_data.simulation_type, 'recruitment');
});

test('N. changement voulu = nouvelle conversation, pas de réinterprétation', async () => {
  const first = await invoke('post', '/conversations', { body: { mode: 'simulation', simulation_type: 'commercial' } });
  const second = await invoke('post', '/conversations', { body: { mode: 'simulation', simulation_type: 'recruitment' } });
  assert.notEqual(first.payload.id, second.payload.id);
  assert.equal(first.payload.simulation_type, 'commercial');
  assert.equal(second.payload.simulation_type, 'recruitment');
});

test('premier tour formatte sans sections feedback', () => {
  const { formatCoachReply, normalizeCoachReply, coachSystemPrompt } = require('../utils/coachReply');
  const opening = formatCoachReply(normalizeCoachReply({
    feedback: { works: '', missing: '', rewrite: '' },
    next: { type: 'objection', content: 'Votre concurrent est 20 % moins cher.' },
  }, 'simulation'), { opening: true });
  assert.equal(opening, 'Votre concurrent est 20 % moins cher.');
  assert.doesNotMatch(opening, /Ce qui fonctionne|Ce qui manque|Reformulation/);
  const later = formatCoachReply(normalizeCoachReply({
    feedback: { works: 'Bonne écoute', missing: 'Posez une question de budget', rewrite: 'Quel budget ciblez-vous ?' },
    next: { type: 'objection', content: 'Je dois en parler à mon directeur.' },
  }, 'simulation'), { opening: false });
  assert.match(later, /Ce qui fonctionne/);
  assert.match(later, /Objection suivante/);
  const prompt = coachSystemPrompt('simulation', '{}', 'commercial');
  assert.match(prompt, /PREMIER TOUR/i);
  assert.match(prompt, /1 ou 2 améliorations/i);
});

console.error = originalError;

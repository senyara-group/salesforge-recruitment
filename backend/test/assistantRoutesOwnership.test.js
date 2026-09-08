const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'test-service-key';

const rows = {
  ai_cv_analyses: [{ id: 'analysis-b', user_id: 'user-b', improved_text: 'original-b' }],
  ai_conversations: [{ id: 'conversation-a', user_id: 'user-a', mode: 'pitch', title: 'Privée A', context_data: {} }, { id: 'conversation-b', user_id: 'user-b', mode: 'pitch', title: 'Privée B', context_data: {} }],
  ai_conversation_messages: [{ id: 'message-b', conversation_id: 'conversation-b', user_id: 'user-b', role: 'assistant', content: 'secret-b' }],
};
const operations = [];
let failCvInsert = false;

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
    if (this.table === 'ai_cv_analyses' && this.operation === 'insert' && failCvInsert) {
      return { data: null, error: new Error('persistence failed') };
    }
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
mockModule('../utils/aiAccess', { assertAiAccess: async () => ({ plan:'carriere_coaching' }), configuredPlans: (feature) => new Set(feature === 'cv' ? ['carriere', 'carriere_coaching'] : ['carriere_coaching']), getAiPlan: async () => 'carriere_coaching' });
let providerCalls = 0;
let providerRequest = null;
let providerValue = { strengths: [], clarifications: [], priorities: [], rewrites: [], questions: [], improved_cv: 'CV fictif amélioré' };
let providerError = null;
let quotaMode = 'exhausted';
let releaseCalls = 0;
let finalizeCalls = 0;
let failFinalize = false;
mockModule('../utils/aiProvider', {
  callAi: async (request) => {
    providerCalls += 1;
    providerRequest = request;
    if (providerError) throw providerError;
    return {
      value: providerValue,
      meta: { input_tokens: 100, output_tokens: 50 },
    };
  },
  isAiConfigured: () => true,
  safeText: (value, max = 40000) => String(value || '').slice(0, max),
});
mockModule('../utils/aiUsage', {
  usageFor: async () => ({ cv:{quota:50,used:50,remaining:0,extra_credits:0}, coach:{quota:100,used:100,remaining:0,extra_credits:0}, reset_at:'2026-10-01', period_end:'2026-10-01' }),
  reserveUsage: async (_userId, _plan, feature) => {
    if (quotaMode === 'exhausted') {
      const error = new Error('quota'); error.code = 'AI_QUOTA_EXCEEDED'; error.status = 429; error.details = { feature }; throw error;
    }
    return { id: `reservation-${feature}`, feature };
  },
  releaseUsage: async (reservation) => { if (reservation) releaseCalls += 1; },
  finalizeUsage: async () => { finalizeCalls += 1; if (failFinalize) throw new Error('finalize failed'); },
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

test('GET config expose un contrat quota stable', async () => {
  const response = await invoke('get', '/config');
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.plan, 'carriere_coaching');
  assert.deepEqual(response.payload.access, { cv: true, coach: true });
  for (const feature of ['cv', 'coach']) {
    assert.deepEqual(Object.keys(response.payload.usage[feature]).sort(), ['extra_credits', 'quota', 'remaining', 'used']);
  }
  assert.equal(response.payload.usage.reset_at, '2026-10-01');
  assert.equal(response.payload.usage.period_end, '2026-10-01');
});

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

test('quota CV épuisé bloque la route avant tout appel provider', async () => {
  providerCalls = 0;
  const response = await invoke('post', '/cv-analyses', { body:{ source_text:'CV candidat entièrement fictif. '.repeat(8) } });
  assert.equal(response.statusCode,429); assert.equal(response.payload.code,'AI_QUOTA_EXCEEDED'); assert.equal(providerCalls,0);
});

test('extraction CV sous 200 caractères bloque avant quota et provider', async () => {
  quotaMode = 'available'; providerCalls = 0; finalizeCalls = 0;
  const response = await invoke('post', '/cv-analyses', { body:{ source_text:'CV fictif trop court pour permettre une analyse métier fiable.' } });
  assert.equal(response.statusCode, 400);
  assert.match(response.payload.error, /200 caractères/i);
  assert.equal(providerCalls, 0); assert.equal(finalizeCalls, 0);
  quotaMode = 'exhausted';
});

test('JSON CV tronqué à 3200 tokens ne persiste rien, ne finalise pas et libère la réservation', async () => {
  quotaMode = 'available'; providerCalls = 0; releaseCalls = 0; finalizeCalls = 0; operations.length = 0;
  providerError = Object.assign(new Error('invalid response'), {
    code: 'AI_INVALID_RESPONSE', status: 502,
    diagnostics: { stage:'json_parse', stop_reason:'max_tokens', input_tokens:1787, output_tokens:3200, response_chars:9974 },
  });
  const before = rows.ai_cv_analyses.length;
  const response = await invoke('post', '/cv-analyses', { body:{ source_text:'CV candidat entièrement fictif. '.repeat(8) } });
  assert.equal(response.statusCode, 502);
  assert.equal(response.payload.code, 'AI_INVALID_RESPONSE');
  assert.equal(providerCalls, 1);
  assert.equal(rows.ai_cv_analyses.length, before);
  assert.equal(operations.some((operation) => operation.table === 'ai_cv_analyses' && operation.operation === 'insert'), false);
  assert.equal(finalizeCalls, 0);
  assert.equal(releaseCalls, 1);
  providerError = null; quotaMode = 'exhausted';
});

test('quota Coach épuisé bloque la route avant tout appel provider', async () => {
  providerCalls = 0;
  const response = await invoke('post', '/conversations/:id/messages', { params:{id:'conversation-a'}, body:{content:'Message fictif'} });
  assert.equal(response.statusCode,429); assert.equal(response.payload.code,'AI_QUOTA_EXCEEDED'); assert.equal(providerCalls,0);
});

test('provider success then persistence failure releases without finalizing', async () => {
  quotaMode = 'available'; failCvInsert = true; failFinalize = false;
  providerCalls = 0; releaseCalls = 0; finalizeCalls = 0;
  const response = await invoke('post', '/cv-analyses', { body:{ source_text:'Entirely fictional candidate CV. '.repeat(8) } });
  assert.equal(response.statusCode, 500);
  assert.equal(providerCalls, 1);
  assert.equal(finalizeCalls, 0);
  assert.equal(releaseCalls, 1);
  failCvInsert = false; quotaMode = 'exhausted';
});

test('successful persistence finalizes exactly once', async () => {
  quotaMode = 'available'; failCvInsert = false; failFinalize = false;
  providerCalls = 0; releaseCalls = 0; finalizeCalls = 0;
  const response = await invoke('post', '/cv-analyses', { body:{ source_text:'Entirely fictional candidate CV. '.repeat(8) } });
  assert.equal(response.statusCode, 201);
  assert.equal(providerCalls, 1);
  assert.equal(finalizeCalls, 1);
  assert.equal(releaseCalls, 0);
  quotaMode = 'exhausted';
});

test('route CV sépare source, déclarations A2 et facts déterministes dans un seul appel', async () => {
  quotaMode = 'available'; failCvInsert = false; failFinalize = false;
  providerCalls = 0; providerRequest = null;
  const sourceText = 'EXPÉRIENCES PROFESSIONNELLES\n2019-2024 Développeur React Native. '.repeat(4);
  const response = await invoke('post', '/cv-analyses', { body: { source_text: sourceText, experience_years: 5, target_role: 'Développeur mobile', sector: 'SaaS' } });
  assert.equal(response.statusCode, 201);
  assert.equal(providerCalls, 1);
  const context = JSON.parse(providerRequest.messages.at(-1).content);
  assert.equal(context.SOURCE_CV, sourceText);
  assert.equal(context.DONNEES_UTILISATEUR.annees_experience, 5);
  assert.equal(context.FACTS_CALCULES.declared.experience_years.status, 'DECLARED');
  assert.equal(context.FACTS_CALCULES.confirmed.technologies.find((item) => item.name === 'React Native').evidence, 'experience');
  quotaMode = 'exhausted';
});

test('finalization failure fails closed without double finalization', async () => {
  quotaMode = 'available'; failCvInsert = false; failFinalize = true;
  releaseCalls = 0; finalizeCalls = 0;
  const response = await invoke('post', '/cv-analyses', { body:{ source_text:'Entirely fictional candidate CV. '.repeat(8) } });
  assert.equal(response.statusCode, 500);
  assert.equal(finalizeCalls, 1);
  assert.equal(releaseCalls, 1);
  failFinalize = false; quotaMode = 'exhausted';
});

test('route Coach structure la réponse et finalise après persistance', async () => {
  quotaMode = 'available'; failFinalize = false; finalizeCalls = 0;
  providerValue = { feedback:{ works:'Réponse claire', missing:'Un fait précis', rewrite:'Réponse factuelle' }, next:{ type:'question', content:'Quel résultat pouvez-vous prouver ?' } };
  const response = await invoke('post', '/conversations/:id/messages', { params:{ id:'conversation-a' }, body:{ content:'Réponse candidat fictive' } });
  assert.equal(response.statusCode, 201);
  assert.match(response.payload.content, /Ce qui fonctionne/);
  assert.match(response.payload.content, /Question suivante/);
  assert.equal(finalizeCalls, 1);
  quotaMode = 'exhausted';
});

test('route Coach remplace une sortie interdite sans logger son contenu', async () => {
  quotaMode = 'available'; finalizeCalls = 0;
  const forbidden = 'Je vous recommande cette offre confidentielle.';
  providerValue = { feedback:{ works:forbidden, missing:'', rewrite:'' }, next:{ type:'question', content:'Suite' } };
  const warnings = []; const originalWarn = console.warn; console.warn = (...args) => warnings.push(args);
  try {
    const response = await invoke('post', '/conversations/:id/messages', { params:{ id:'conversation-a' }, body:{ content:'Autre réponse fictive' } });
    assert.equal(response.statusCode, 201);
    assert.match(response.payload.content, /outil d’entraînement et d’optimisation/);
    assert.doesNotMatch(response.payload.content, /confidentielle/);
    assert.doesNotMatch(JSON.stringify(warnings), /confidentielle/);
    assert.equal(finalizeCalls, 1);
  } finally { console.warn = originalWarn; quotaMode = 'exhausted'; }
});

test('changement de mode Coach reste scoped à id et user_id', async () => {
  operations.length = 0;
  const response = await invoke('patch', '/conversations/:id', { params:{ id:'conversation-b' }, body:{ mode:'objections', user_id:'user-b' } });
  assert.equal(response.statusCode, 404);
  assert.deepEqual(operations[0].filters, [['id','conversation-b'],['user_id','user-a']]);
  assert.equal(rows.ai_conversations.find((row) => row.id === 'conversation-b').mode, 'pitch');
});

test('réinitialisation Coach ne supprime jamais les messages d’un autre propriétaire', async () => {
  operations.length = 0;
  const response = await invoke('post', '/conversations/:id/reset', { params:{ id:'conversation-b' }, body:{ user_id:'user-b' } });
  assert.equal(response.statusCode, 404);
  assert.equal(operations.some((operation) => operation.operation === 'delete'), false);
  assert.equal(rows.ai_conversation_messages.some((row) => row.id === 'message-b'), true);
});

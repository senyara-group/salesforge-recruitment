const test = require('node:test');
const assert = require('node:assert/strict');
const realCallAi = require('../utils/aiProvider').callAi;

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

test('CV history recovery is owned, fingerprints normalized inputs and omits raw source fields', async () => {
  const source = { source_text: ' private source ', offer_text: ' private offer ', target_role: 'Sales', experience_years: 3, sector: 'Tech' };
  const row = { id: 'recovery-test', user_id: 'user-a', ...source, analysis: {} };
  rows.ai_cv_analyses.push(row);
  try {
    const before = providerCalls;
    const response = await invoke('get', '/cv-analyses');
    const found = response.payload.find(item => item.id === row.id);
    assert.equal(found.request_fingerprint, require('../utils/cvRequestFingerprint').cvRequestFingerprint(source));
    assert.equal(response.payload.some(item => item.id === 'analysis-b'), false);
    assert.equal('source_text' in found, false); assert.equal('offer_text' in found, false);
    assert.equal(providerCalls, before);
  } finally { rows.ai_cv_analyses.splice(rows.ai_cv_analyses.indexOf(row), 1); }
});

test('real compressed PDF extraction is the exact validated source sent to AI', async () => {
  const { pdf, CV_TEXT } = require('./fixtures/cvDocuments');
  const { extractCvText } = require('../routes/candidats')._test;
  const source = await extractCvText({ filename: 'cv.pdf', buffer: await pdf({ embeddedFont: true }) });
  assert.equal(source.replace(/\s+/g, ' '), CV_TEXT);
  quotaMode = 'available'; providerCalls = 0;
  try {
    const result = await invoke('post', '/cv-analyses', { body: { source_text: source } });
    assert.equal(result.statusCode, 201);
    assert.equal(providerCalls, 1);
    const sent = JSON.parse(providerRequest.messages.find(message => message.role === 'user').content);
    assert.equal(sent.SOURCE_CV, source);
    assert.doesNotMatch(sent.SOURCE_CV, /%PDF|FlateDecode|endobj|xref/);
  } finally { quotaMode = 'exhausted'; }
});

test('true CV >30k and offer >20k are rejected without truncation or provider calls', async () => {
  quotaMode = 'available'; providerCalls = 0;
  try {
    for (const body of [{ source_text: 'x'.repeat(30001) }, { source_text: 'x'.repeat(200), offer_text: 'x'.repeat(20001) }]) {
      const result = await invoke('post', '/cv-analyses', { body });
      assert.equal(result.statusCode, 400);
      assert.match(result.payload.error, /30001|20001/);
      assert.match(result.payload.error, /Modifiez|concis/);
      assert.equal(providerCalls, 0);
    }
  } finally { quotaMode = 'exhausted'; }
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
  assert.equal(response.statusCode, 503);
  assert.equal(response.payload.code, 'AI_STORAGE_UNAVAILABLE');
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
  assert.equal(response.statusCode, 503);
  assert.equal(response.payload.code, 'AI_STORAGE_UNAVAILABLE');
  assert.equal(finalizeCalls, 1);
  assert.equal(releaseCalls, 1);
  failFinalize = false; quotaMode = 'exhausted';
});

test('route Coach structure la réponse et finalise après persistance', async () => {
  quotaMode = 'available'; failFinalize = false; finalizeCalls = 0;
  rows.ai_conversation_messages.push({
    id: 'prior-a', conversation_id: 'conversation-a', user_id: 'user-a', role: 'assistant',
    content: 'Première question', created_at: '2026-01-01T00:00:00.000Z',
  });
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

// --- Hotfix mobile pré-démo : Optimiseur CV, champs facultatifs vides ---------
// Repro exact remontée en recette (Safari mobile) : poste visé + années
// d'expérience renseignés, secteur et offre ciblée laissés vides. Un payload de
// ce type ne doit jamais échouer à cause des champs facultatifs eux-mêmes.
test('CV : secteur et offre ciblée vides (repro recette mobile) n’empêchent pas l’analyse', async () => {
  quotaMode = 'available'; failCvInsert = false; failFinalize = false; providerError = null;
  providerCalls = 0; providerRequest = null;
  // Remet une valeur au format CV : les tests Coach précédents ont laissé
  // providerValue au format {feedback,next}, sans rapport avec ce endpoint.
  providerValue = {
    score: { readability: 70, quantified_impact: 60, ats_compatibility: 65, commercial_relevance: 55, diagnostic: 'Diagnostic fictif.' },
    title: { current: '', suggested: '', reason: '' },
    summary: '', rewrites: [], missing_metrics: [], keywords: [], alerts: [], priorities: [], improved_cv: 'CV fictif amélioré',
  };
  const sourceText = 'EXPÉRIENCES PROFESSIONNELLES\n2021-2024 Business Developer, prospection et closing. '.repeat(4);
  const response = await invoke('post', '/cv-analyses', {
    body: {
      source_text: sourceText,
      // Valeurs telles qu'envoyées par le formulaire (value d'un <input>, donc
      // une chaîne même pour "années d'expérience") : experience_years '3',
      // secteur et offre ciblée laissés vides par le candidat.
      target_role: 'Business developer',
      experience_years: '3',
      sector: '',
      offer_text: '',
    },
  });
  assert.equal(response.statusCode, 201);
  assert.equal(providerCalls, 1);
  const context = JSON.parse(providerRequest.messages.at(-1).content);
  assert.equal(context.DONNEES_UTILISATEUR.annees_experience, 3);
  assert.equal(context.DONNEES_UTILISATEUR.secteur, null);
  assert.equal(context.DONNEES_UTILISATEUR.offre_cible, null);
  quotaMode = 'exhausted';
});

// Une erreur qui n'a pas déjà été normalisée avec un .code (ex. un bug inattendu
// dans le provider IA, indépendant de aiProvider.js qui est mocké ici) doit
// quand même produire une réponse JSON propre côté client, et un log serveur
// exploitable (route_stage + elapsed_ms) sans jamais contenir le texte du CV.
test('CV : une erreur provider non normalisée reste diagnosticable sans fuite de contenu', async () => {
  quotaMode = 'available'; providerCalls = 0;
  const secretSourceText = 'CV avec un secret-de-test-a-ne-jamais-logger. '.repeat(8);
  providerError = new Error('panne inattendue du provider');
  const errors = []; const originalError = console.error; console.error = (...args) => errors.push(args);
  try {
    const response = await invoke('post', '/cv-analyses', { body: { source_text: secretSourceText } });
    assert.equal(response.statusCode, 500);
    assert.equal(typeof response.payload.error, 'string');
    assert.ok(response.payload.error.length > 0);
    assert.doesNotMatch(JSON.stringify(response.payload), /secret-de-test/);
    const logged = JSON.stringify(errors);
    assert.doesNotMatch(logged, /secret-de-test/);
    assert.match(logged, /"route_stage":"ai_call"/);
    assert.match(logged, /"elapsed_ms":\d+/);
  } finally {
    console.error = originalError;
    providerError = null;
    quotaMode = 'exhausted';
  }
});

test('secret marker in invalid AI JSON, exception fields and diagnostics never reaches any assistant log', async () => {
  const marker = 'PRIVATE_CV_OFFER_AUTH_COOKIE_MARKER';
  const captured = [];
  const methods = ['log', 'warn', 'error', 'info', 'debug'];
  const originals = Object.fromEntries(methods.map(method => [method, console[method]]));
  for (const method of methods) console[method] = (...args) => captured.push(args);
  quotaMode = 'available';
  try {
    for (const raw of [marker + ' not JSON', `{"cv":${marker}}`]) {
      try { await realCallAi({ messages: [], json: true, providerCall: async () => raw }); }
      catch (error) { providerError = error; }
      const response = await invoke('post', '/cv-analyses', { body: { source_text: marker.repeat(10) } });
      assert.equal(response.statusCode, 502);
      assert.doesNotMatch(JSON.stringify(providerError.diagnostics), new RegExp(marker));
    }
    providerError = Object.assign(new Error(marker), { code: marker, diagnostics: { stage: marker, parse_error: marker, response_chars: marker, stop_reason: marker, schema_stage: marker } });
    await invoke('post', '/cv-analyses', { body: { source_text: marker.repeat(10) } });
    assert.ok(captured.length >= 3);
    assert.doesNotMatch(JSON.stringify(captured), new RegExp(marker));
    assert.match(JSON.stringify(captured), /INVALID_JSON/);
  } finally {
    Object.assign(console, originals); providerError = null; quotaMode = 'exhausted';
  }
});

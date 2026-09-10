const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'test-service-key';

const { QUESTIONS, createPresentation } = require('../utils/deepAdnQuestionnaire');
const deepAdnRouter = require('../routes/deepAdn');

class Query {
  constructor(fake, table) { this.fake = fake; this.table = table; this.filters = []; this.operation = 'select'; this.payload = null; }
  select() { return this; }
  insert(payload) { this.operation = 'insert'; this.payload = payload; return this; }
  update(payload) { this.operation = 'update'; this.payload = payload; return this; }
  upsert(payload) { this.operation = 'upsert'; this.payload = payload; return this; }
  eq(key, value) { this.filters.push([key, value]); return this; }
  order() { return this; }
  limit() { return this; }
  single() { return this.run(true); }
  maybeSingle() { return this.run(true); }
  then(resolve, reject) { return Promise.resolve(this.run(false)).then(resolve, reject); }
  run(single) {
    const operation = { table: this.table, operation: this.operation, payload: this.payload, filters: [...this.filters], single };
    this.fake.operations.push(operation);
    return this.fake.resolve(operation);
  }
}

function fakeClient(resolve) {
  return { operations: [], resolve, from(table) { return new Query(this, table); } };
}

function handler(router, method, routePath) {
  const layer = router.stack.find((item) => item.route?.path === routePath && item.route.methods[method]);
  assert.ok(layer, `${method} ${routePath} absente`);
  return layer.route.stack.at(-1).handle;
}

async function invoke(router, method, routePath, { userId = 'user-a', params = {}, body = {} } = {}) {
  const response = { statusCode: 200, payload: undefined };
  const res = { status(code) { response.statusCode = code; return this; }, json(payload) { response.payload = payload; return this; } };
  await handler(router, method, routePath)({ user: { id: userId }, candidatePlan: 'carriere_coaching', params, body }, res);
  return response;
}

test('une tentative appartenant à B est inaccessible à A', async () => {
  const client = fakeClient(() => ({ data: null, error: null }));
  const router = deepAdnRouter._test.createRouter({ client });
  const response = await invoke(router, 'put', '/:id/progress', { params: { id: 'assessment-b' }, body: { question_id: 'B1_S01', option_id: 'B1_S01_O1' } });
  assert.equal(response.statusCode, 404);
  assert.deepEqual(client.operations[0].filters, [['id', 'assessment-b'], ['user_id', 'user-a']]);
});

test('progression ignore user_id client et persiste le propriétaire JWT', async () => {
  const presentation = createPresentation(() => 0);
  const client = fakeClient((operation) => {
    if (operation.table === 'deep_adn_assessments') return { data: { id: 'assessment-a', user_id: 'user-a', status: 'in_progress', presentation }, error: null };
    if (operation.operation === 'upsert') return { data: null, error: null };
    return { data: null, error: null, count: 1 };
  });
  const router = deepAdnRouter._test.createRouter({ client });
  const optionId = presentation[0].option_ids[0];
  const response = await invoke(router, 'put', '/:id/progress', { params: { id: 'assessment-a' }, body: { question_id: 'B1_S01', option_id: optionId, user_id: 'user-b' } });
  assert.equal(response.statusCode, 200);
  const write = client.operations.find((operation) => operation.operation === 'upsert');
  assert.equal(write.payload.user_id, 'user-a');
  assert.equal(write.payload.assessment_id, 'assessment-a');
});

test('finalisation incomplète refuse toute écriture de résultat', async () => {
  const presentation = createPresentation(() => 0);
  const partial = QUESTIONS.slice(0, 47).map((question) => ({ question_id: question.id, option_id: question.options[0].id }));
  const client = fakeClient((operation) => operation.table === 'deep_adn_assessments'
    ? { data: { id: 'assessment-a', user_id: 'user-a', status: 'in_progress', presentation }, error: null }
    : { data: partial, error: null });
  const router = deepAdnRouter._test.createRouter({ client });
  const response = await invoke(router, 'post', '/:id/finalize', { params: { id: 'assessment-a' } });
  assert.equal(response.statusCode, 400);
  assert.equal(response.payload.error, 'INCOMPLETE_ASSESSMENT');
  assert.equal(client.operations.some((operation) => operation.operation === 'update'), false);
});

test('finalisation déjà complète est idempotente', async () => {
  const stored = { id: 'assessment-a', user_id: 'user-a', status: 'completed', questionnaire_version: 'yannis-48-v1', scoring_version: 'blocks-linear-v1', result: { blocks: [] }, completed_at: '2026-09-10T10:00:00Z' };
  const client = fakeClient(() => ({ data: stored, error: null }));
  const router = deepAdnRouter._test.createRouter({ client });
  const first = await invoke(router, 'post', '/:id/finalize', { params: { id: 'assessment-a' } });
  const second = await invoke(router, 'post', '/:id/finalize', { params: { id: 'assessment-a' } });
  assert.deepEqual(first.payload, second.payload);
  assert.equal(client.operations.some((operation) => operation.operation === 'update'), false);
});

test('finalisation complète persiste une seule restitution versionnée', async () => {
  const presentation = createPresentation(() => 0);
  const answers = QUESTIONS.map((question) => ({ question_id: question.id, option_id: question.options[1].id }));
  const assessment = { id: 'assessment-a', user_id: 'user-a', status: 'in_progress', questionnaire_version: 'yannis-48-v1', scoring_version: 'blocks-linear-v1', presentation, started_at: '2026-09-10T09:00:00Z' };
  const client = fakeClient((operation) => {
    if (operation.table === 'deep_adn_answers') return { data: answers, error: null };
    if (operation.operation === 'update') return { data: { ...assessment, ...operation.payload }, error: null };
    return { data: assessment, error: null };
  });
  const router = deepAdnRouter._test.createRouter({ client });
  const response = await invoke(router, 'post', '/:id/finalize', { params: { id: 'assessment-a' } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.questionnaire_version, 'yannis-48-v1');
  assert.equal(response.payload.scoring_version, 'blocks-linear-v1');
  assert.equal(response.payload.result.blocks.length, 6);
  assert.equal(client.operations.filter((operation) => operation.operation === 'update').length, 1);
  assert.equal(client.operations.some((operation) => operation.table === 'candidats'), false);
});

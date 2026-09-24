const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');
const express = require('express');

process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'test-service-key';

function mockModule(request, exports) {
  const filename = require.resolve(request);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const COOLDOWN_MS = 6 * 30 * 24 * 60 * 60 * 1000;
const recentAt = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
const olderAt = new Date(Date.now() - COOLDOWN_MS - 24 * 60 * 60 * 1000).toISOString();

const HISTORY = {
  'user-free': [],
  'user-free-scored': [
    { score: 78, resultat: { type: 'Closer', secret: 'freemium-resultat' }, created_at: recentAt },
  ],
  'user-downgraded': [
    { score: 70, resultat: { type: 'Hunter', secret: 'old-1' }, created_at: olderAt },
    { score: 88, resultat: { type: 'Closer', secret: 'old-2' }, created_at: recentAt },
  ],
  'user-coaching': [
    { score: 82, resultat: { type: 'Advisor', secret: 'coach-only' }, created_at: olderAt },
    { score: 91, resultat: { type: 'Closer', secret: 'coach-latest' }, created_at: recentAt },
  ],
  'user-other': [
    { score: 99, resultat: { type: 'Leak', secret: 'other-user' }, created_at: recentAt },
  ],
};

const planByUser = {
  'user-free': 'freemium',
  'user-free-scored': 'freemium',
  'user-downgraded': 'freemium',
  'user-coaching': 'carriere_coaching',
  'user-other': 'carriere_coaching',
};

const queryLog = [];

function fakeFrom(table) {
  assert.equal(table, 'evaluations_adn');
  const state = { userId: null, rows: null };
  const api = {
    select() { return api; },
    eq(col, value) {
      assert.equal(col, 'user_id');
      state.userId = value;
      queryLog.push(value);
      state.rows = HISTORY[value] || [];
      return api;
    },
    order() { return api; },
    then(resolve, reject) {
      return Promise.resolve({ data: state.rows, error: null }).then(resolve, reject);
    },
  };
  return api;
}

mockModule('../supabase', { from: fakeFrom });
mockModule('../middleware/auth', (req, res, next) => {
  const id = req.headers['x-test-user'];
  if (!id) return res.status(401).json({ error: 'Unauthorized' });
  req.user = { id };
  next();
});
mockModule('../middleware/requireCandidatePlan', () => (_req, _res, next) => next());
mockModule('../middleware/requireRecruiterPlan', () => (_req, _res, next) => next());
mockModule('../utils/anthropic', { askClaude: async () => '' });
mockModule('../utils/cvReplacement', { finalizeCvReplacement: async () => ({}) });
mockModule('../utils/ebookAccess', { accessibleEbooks: () => [] });
mockModule('../utils/brevoEvents', { trackBrevoEvent: async () => {}, upsertBrevoContact: async () => {} });
mockModule('../utils/profiles', {
  ensureCandidateProfile: async (id) => ({ user_id: id }),
  ensureRecruiterProfile: async () => ({}),
  getCandidatePlan: async (userId) => planByUser[userId] || 'freemium',
  checkAndConsumeUsage: async () => ({ allowed: true }),
});

delete require.cache[require.resolve('../routes/candidats')];
const candidatsRouter = require('../routes/candidats');
const app = express();
app.use(express.json());
app.use('/candidats', candidatsRouter);

async function getEvaluations(userId) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const headers = {};
    if (userId) headers['x-test-user'] = userId;
    const response = await fetch(`http://127.0.0.1:${server.address().port}/candidats/evaluations`, { headers });
    const json = await response.json();
    return { status: response.status, json };
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('1. freemium sans évaluation → peut_repasser=true, historique non exposé', async () => {
  const { status, json } = await getEvaluations('user-free');
  assert.equal(status, 200);
  assert.equal(json.peut_repasser, true);
  assert.equal(json.next_eligible_at, null);
  assert.deepEqual(json.evaluations, []);
});

test('2. freemium avec évaluation → cooldown correct, resultat non exposé', async () => {
  const { status, json } = await getEvaluations('user-free-scored');
  assert.equal(status, 200);
  assert.equal(json.peut_repasser, false);
  assert.equal(json.next_eligible_at, new Date(new Date(recentAt).getTime() + COOLDOWN_MS).toISOString());
  assert.deepEqual(json.evaluations, []);
  assert.equal(JSON.stringify(json).includes('freemium-resultat'), false);
});

test('3. ex-Coaching downgradé → cooldown depuis vraies données, historique masqué', async () => {
  const { status, json } = await getEvaluations('user-downgraded');
  assert.equal(status, 200);
  assert.equal(json.peut_repasser, false);
  assert.equal(json.next_eligible_at, new Date(new Date(recentAt).getTime() + COOLDOWN_MS).toISOString());
  assert.deepEqual(json.evaluations, []);
  assert.equal(JSON.stringify(json).includes('old-2'), false);
});

test('4. Coaching autorisé → historique/resultat préservés', async () => {
  const { status, json } = await getEvaluations('user-coaching');
  assert.equal(status, 200);
  assert.equal(json.peut_repasser, false);
  assert.equal(json.evaluations.length, 2);
  assert.equal(json.evaluations[1].resultat.secret, 'coach-latest');
  assert.equal(json.evaluations[0].score, 82);
});

test('5. cross-user impossible : filtre JWT, pas de fuite', async () => {
  queryLog.length = 0;
  const { status, json } = await getEvaluations('user-coaching');
  assert.equal(status, 200);
  assert.deepEqual(queryLog, ['user-coaching']);
  assert.equal(JSON.stringify(json).includes('other-user'), false);
  assert.equal(JSON.stringify(json).includes('Leak'), false);

  const other = await getEvaluations('user-other');
  assert.equal(other.status, 200);
  assert.equal(other.json.evaluations[0].resultat.secret, 'other-user');
  assert.equal(JSON.stringify(other.json).includes('coach-latest'), false);
});

test('GET /evaluations refuse sans auth', async () => {
  const { status } = await getEvaluations(null);
  assert.equal(status, 401);
});

test('7. POST /ai/score-adn inchangé (plan + cooldown autoritaires)', () => {
  const ai = fs.readFileSync(path.join(__dirname, '../routes/ai.js'), 'utf8');
  assert.match(ai, /router\.post\('\/score-adn'/);
  assert.match(ai, /PLAN_REQUIRED/);
  assert.match(ai, /RETAKE_TOO_SOON/);
  assert.match(ai, /carriere_coaching/);
  assert.match(ai, /RETAKE_COOLDOWN_MS/);
});

test('route evaluations calcule avant de masquer, via getCandidatePlan', () => {
  const source = fs.readFileSync(path.join(__dirname, '../routes/candidats.js'), 'utf8');
  const block = source.slice(source.indexOf("router.get('/evaluations'"), source.indexOf("router.get('/export-pdf'"));
  assert.match(block, /getCandidatePlan/);
  assert.match(block, /carriere_coaching/);
  assert.match(block, /historyAllowed \? data : \[\]/);
  const calcIdx = block.indexOf('peutRepasser');
  const planIdx = block.indexOf('getCandidatePlan');
  const maskIdx = block.indexOf('historyAllowed ? data : []');
  assert.ok(calcIdx > 0 && planIdx > calcIdx && maskIdx > planIdx);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { runWorker, retryDelay } = require('../utils/brevoWorker');
const { templateFor } = require('../utils/automationDelivery');
const now = () => new Date('2026-10-08T12:00:00Z');
function fixture(row = {}) {
  const records = [{ id: 'event1', lease_token: 'lease1', email: 'a@example.test', event_name: 'message_received',
    created_at: '2026-10-08T11:00:00Z', attempts: 1, properties: { conversation_id: 'm1' }, ...row }];
  const writes = [];
  const db = { rpc: async () => ({ data: records }), from: (table) => ({ update: (patch) => {
    const filters = [];
    const query = { eq: (key, value) => { filters.push([key, value]); return query; },
      select: () => query, maybeSingle: async () => { writes.push({ table, patch, filters }); return { data: { id: 'event1' }, error: null }; },
      then: (resolve) => { writes.push({ table, patch, filters }); resolve({ error: null }); } };
    return query;
  } }) };
  return { db, writes };
}
const prepare = async (_, row) => ({ allowed: true, contact: {}, properties: row.properties });

test('worker checkpoints accepted event separately, retries email failure and preserves lease guards', async () => {
  process.env.BREVO_API_KEY = 'test-only'; process.env.FRONTEND_URL = 'https://example.test';
  process.env.BREVO_TRANSACTIONAL_TEMPLATES = '{"message_received":55}';
  const first = fixture(); let events = 0;
  await runWorker({ db: first.db, now, prepare, deliver: async () => { events++; return true; }, request: async (path) => path !== '/smtp/email' });
  assert.equal(events, 1);
  assert.ok(first.writes.some((w) => w.patch.event_delivered_at));
  assert.ok(first.writes.some((w) => w.patch.available_at === '2026-10-08T12:00:30.000Z'));
  assert.ok(!first.writes.some((w) => w.patch.delivered_at));
  assert.ok(first.writes.every((w) => w.filters.some(([key, value]) => key === 'lease_token' && value === 'lease1')));
  const second = fixture({ event_delivered_at: now().toISOString(), attempts: 2 });
  const sent = [];
  await runWorker({ db: second.db, now, prepare, deliver: async () => { throw new Error('must not resend event'); },
    request: async (path, method, body) => { sent.push({ path, body }); return true; } });
  assert.equal(sent.find((r) => r.path === '/smtp/email').body.headers['Idempotency-Key'], 'event1');
  assert.equal(sent.find((r) => r.path === '/smtp/email').body.params.lien, 'https://example.test/swipsales_app.html');
  assert.ok(second.writes.some((w) => w.patch.delivered_at));
  delete process.env.BREVO_TRANSACTIONAL_TEMPLATES;
});
test('suppressed reminders are discarded without contacting Brevo', async () => {
  process.env.BREVO_API_KEY = 'test-only'; process.env.FRONTEND_URL = 'https://example.test';
  const f = fixture();
  await runWorker({ db: f.db, now, prepare: async () => ({ allowed: false, reason: 'already applied' }),
    request: async () => { throw new Error('must not contact Brevo'); } });
  assert.ok(f.writes.some((w) => w.patch.discarded_at));
});
test('no key means no claim, and invalid template IDs never become sends', async () => {
  delete process.env.BREVO_API_KEY;
  await assert.rejects(runWorker({ db: { rpc: () => { throw new Error('claimed'); } } }), /missing/);
  process.env.BREVO_TRANSACTIONAL_TEMPLATES = '{"message_received":0}';
  assert.throws(() => templateFor('message_received'), /Invalid/);
  process.env.BREVO_TRANSACTIONAL_TEMPLATES = '{"weekly_recommendations":12}';
  assert.throws(() => templateFor('weekly_recommendations'), /Invalid/);
  delete process.env.BREVO_TRANSACTIONAL_TEMPLATES;
  assert.equal(templateFor('message_received'), null);
  assert.equal(retryDelay(2), 60);
  assert.ok(retryDelay(100) <= 86400);
});

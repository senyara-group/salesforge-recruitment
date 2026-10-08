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
test('Brevo events receive scalar properties only; templates keep the lists', async () => {
  const { eventScalars } = require('../utils/brevoWorker');
  const flat = eventScalars({ nb: 2, offres: [{ offre_id: 'o1', poste: 'Sales', score: 91 }, { offre_id: 'o2', poste: 'AE', score: 80 }],
    candidats: [{ candidat_id: 'c1', score: 88 }], date_fin: null, nested: { a: 1 } });
  assert.deepEqual(flat, { nb: 2, offre_1_id: 'o1', offre_1_poste: 'Sales', offre_1_score: 91, offre_2_id: 'o2', offre_2_poste: 'AE',
    offre_2_score: 80, candidat_1_id: 'c1', candidat_1_score: 88 });
  process.env.BREVO_API_KEY = 'test-only'; process.env.FRONTEND_URL = 'https://example.test';
  process.env.BREVO_TRANSACTIONAL_TEMPLATES = '{"message_received":55}';
  const f = fixture({ properties: { conversation_id: 'm1', offres: [{ offre_id: 'o1' }] } });
  let delivered; const sent = [];
  await runWorker({ db: f.db, now, prepare, deliver: async (_email, _name, props) => { delivered = props; return true; },
    request: async (path, _method, body) => { sent.push({ path, body }); return true; } });
  assert.ok(Object.values(delivered).every((value) => typeof value !== 'object'));
  const email = sent.find((r) => r.path === '/smtp/email').body;
  assert.deepEqual(email.params.offres, [{ offre_id: 'o1' }]);
  assert.equal(email.headers['X-Mailin-custom'], 'event_id:event1');
  assert.deepEqual(email.tags, ['message_received']);
  delete process.env.BREVO_TRANSACTIONAL_TEMPLATES;
});
test('a permanently failing event is discarded after the last attempt instead of retrying forever', async () => {
  const { MAX_ATTEMPTS } = require('../utils/brevoWorker');
  process.env.BREVO_API_KEY = 'test-only'; process.env.FRONTEND_URL = 'https://example.test';
  const f = fixture({ attempts: MAX_ATTEMPTS });
  await runWorker({ db: f.db, now, prepare, request: async () => false });
  const final = f.writes.find((w) => w.patch.last_error);
  assert.ok(final.patch.discarded_at);
  assert.match(final.patch.last_error, /^max attempts: contact update rejected/);
  assert.equal(final.patch.available_at, undefined);
});

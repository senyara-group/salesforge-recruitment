const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const path = require('node:path');
const backend = path.resolve(__dirname, '..');

// Subscription bookkeeping must behave the same with or without the Brevo outbox, and a
// failing outbox must never prevent a paid subscription from being activated.
const upserts = [];
const legacyEvents = [];
let outboxError = null;
const fakeDb = {
  from(table) {
    if (table === 'brevo_outbox') return { upsert: async () => ({ error: outboxError }) };
    const query = {
      select: () => query, eq: () => query,
      maybeSingle: async () => ({ data: { resiliation_programmee: false, plan: 'freemium' }, error: null }),
      upsert: async (row) => { upserts.push({ table, row }); return { error: null }; },
    };
    return query;
  },
};
function mock(file, exports) {
  const filename = require.resolve(file, { paths: [backend] });
  require.cache[filename] = { filename, id: filename, loaded: true, exports };
}
mock('stripe', () => ({ webhooks: { constructEvent: (body, signature) => {
  if (signature !== 'valid') throw new Error('bad signature');
  return JSON.parse(body.toString());
} } }));
mock('./supabase', fakeDb);
mock('./middleware/auth', (req, res, next) => next());
mock('./utils/profiles', { getUserEmail: async () => 'owner@example.test', getUserRole: async () => 'candidat' });
mock('./utils/brevoEvents', { trackBrevoEvent: async (email, name) => { legacyEvents.push(name); return true; } });
const app = express();
app.use('/stripe/webhook', express.raw({ type: 'application/json' }));
app.use('/stripe', require('../routes/stripe'));

const paidCheckout = { id: 'evt_checkout', type: 'checkout.session.completed', data: { object: {
  payment_status: 'paid', customer: 'cus_1', amount_total: 1900, currency: 'eur',
  metadata: { userId: 'owner', plan: 'carriere', period: 'month' } } } };

async function post(server, event, signature = 'valid') {
  return fetch(`http://127.0.0.1:${server.address().port}/stripe/webhook`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': signature }, body: JSON.stringify(event) });
}

test('flag off: paid checkout activates the subscription exactly as before, legacy Brevo event kept', async () => {
  const server = app.listen(0);
  try {
    delete process.env.BREVO_OUTBOX_ENABLED; upserts.length = 0; legacyEvents.length = 0;
    const response = await post(server, paidCheckout);
    assert.equal(response.status, 200);
    assert.deepEqual(upserts.map((u) => [u.table, u.row.plan, u.row.statut]), [['abonnements', 'carriere', 'actif']]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(legacyEvents, ['abonnement_active']);
    assert.equal((await post(server, paidCheckout, 'forged')).status, 400);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('flag on: an outbox failure still activates the subscription and asks Stripe to retry', async () => {
  const server = app.listen(0);
  try {
    process.env.BREVO_OUTBOX_ENABLED = 'true'; upserts.length = 0; outboxError = new Error('relation "brevo_outbox" does not exist');
    const response = await post(server, paidCheckout);
    assert.equal(response.status, 500, 'Stripe retries the automation capture');
    assert.deepEqual(upserts.map((u) => [u.table, u.row.statut]), [['abonnements', 'actif']], 'subscription activated anyway');
    outboxError = null; upserts.length = 0;
    assert.equal((await post(server, paidCheckout)).status, 200);
    assert.equal(upserts.length, 1, 'the retry is an idempotent upsert of the same values');
    upserts.length = 0;
    const unpaid = { ...paidCheckout, data: { object: { ...paidCheckout.data.object, payment_status: 'unpaid' } } };
    assert.equal((await post(server, unpaid)).status, 200);
    assert.equal(upserts.length, 0, 'an unpaid checkout never activates a subscription');
  } finally {
    delete process.env.BREVO_OUTBOX_ENABLED; outboxError = null;
    await new Promise((resolve) => server.close(resolve));
  }
});

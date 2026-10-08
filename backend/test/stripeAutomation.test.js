const test = require('node:test');
const assert = require('node:assert/strict');
const { captureStripeAutomation } = require('../utils/stripeAutomation');
test('signed invoice routes use subscription metadata and dedupe Stripe event IDs', async () => {
  process.env.BREVO_OUTBOX_ENABLED = 'true';
  const writes = [];
  const db = { from: () => ({ upsert: async (row, options) => { writes.push({ row, options }); return {}; } }) };
  const stripe = { subscriptions: { retrieve: async (id) => {
    assert.equal(id, 'sub_1'); return { metadata: { userId: 'owner', plan: 'carriere', period: 'month' } };
  } } };
  const event = { id: 'evt_1', type: 'invoice.payment_failed', data: { object: {
    parent: { subscription_details: { subscription: 'sub_1' } }, amount_due: 1900, currency: 'eur', id: 'in_1', number: 'INV-1',
    hosted_invoice_url: 'https://invoice.stripe.com/test', customer_email: 'wrong@example.test',
  } } };
  await captureStripeAutomation(db, stripe, event);
  await captureStripeAutomation(db, stripe, event);
  assert.equal(writes[0].row.user_id, 'owner');
  assert.equal(writes[0].row.properties.montant, '19.00');
  assert.equal(writes[0].row.properties.facturation, 'MENSUEL');
  assert.equal(writes[0].row.dedupe_key, writes[1].row.dedupe_key);
  assert.equal(writes[0].options.ignoreDuplicates, true);
  const failing = { from: () => ({ upsert: async () => ({ error: new Error('database offline') }) }) };
  await assert.rejects(captureStripeAutomation(failing, stripe, event), /database offline/);
  delete process.env.BREVO_OUTBOX_ENABLED;
});
test('unpaid checkout and unrelated invoices never become confirmed subscriptions', async () => {
  process.env.BREVO_OUTBOX_ENABLED = 'true';
  const db = { from: () => { throw new Error('unexpected write'); } };
  await captureStripeAutomation(db, {}, { type: 'checkout.session.completed', data: { object: { metadata: { userId: 'owner' }, payment_status: 'unpaid' } } });
  await captureStripeAutomation(db, {}, { type: 'invoice.payment_succeeded', data: { object: { customer_email: 'owner@example.test' } } });
  delete process.env.BREVO_OUTBOX_ENABLED;
});
function capture(previous, event) {
  const writes = [];
  const db = { from: (table) => table === 'abonnements'
    ? { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: previous }) }) }) }
    : { upsert: async (row) => { writes.push(row); return {}; } } };
  return captureStripeAutomation(db, {}, event).then(() => writes);
}
const updated = (object, previousAttributes) => ({ id: 'evt_u', type: 'customer.subscription.updated',
  data: { object: { metadata: { userId: 'owner', plan: 'carriere', period: 'month' }, ...object }, previous_attributes: previousAttributes } });
test('subscription updates use Stripe previous_attributes and never call a first subscription a plan change', async () => {
  process.env.BREVO_OUTBOX_ENABLED = 'true';
  let rows = await capture({ plan: 'freemium', resiliation_programmee: false }, updated({}, { items: {} }));
  assert.equal(rows[0].event_name, 'subscription_updated');
  rows = await capture({ plan: 'carriere', resiliation_programmee: true }, updated({ cancel_at_period_end: true }, { cancel_at_period_end: false }));
  assert.equal(rows[0].event_name, 'subscription_cancel_scheduled', 'the event itself, not a stale row, decides');
  rows = await capture({ plan: 'carriere', resiliation_programmee: false }, updated({ cancel_at_period_end: false }, { cancel_at_period_end: true }));
  assert.equal(rows[0].event_name, 'subscription_reactivated');
  rows = await capture({ plan: 'carriere' }, updated({ metadata: { userId: 'owner', plan: 'carriere_coaching' } }, { metadata: { plan: 'carriere' } }));
  assert.deepEqual([rows[0].event_name, rows[0].properties.ancien_plan, rows[0].properties.nouveau_plan], ['plan_changed', 'carriere', 'carriere_coaching']);
  assert.equal(rows[0].dedupe_key, 'stripe:evt_u');
  delete process.env.BREVO_OUTBOX_ENABLED;
});
test('invoice events expose billing_reason so renewals are distinguishable from the first payment', async () => {
  process.env.BREVO_OUTBOX_ENABLED = 'true';
  const writes = [];
  const db = { from: () => ({ upsert: async (row) => { writes.push(row); return {}; } }) };
  const stripe = { subscriptions: { retrieve: async () => ({ metadata: { userId: 'owner', plan: 'pro', period: 'year' } }) } };
  await captureStripeAutomation(db, stripe, { id: 'evt_p', type: 'invoice.payment_succeeded', data: { object: {
    subscription: 'sub_1', amount_paid: 49000, currency: 'eur', id: 'in_2', number: 'INV-2', billing_reason: 'subscription_cycle' } } });
  assert.deepEqual([writes[0].event_name, writes[0].properties.billing_reason, writes[0].properties.montant, writes[0].properties.facturation],
    ['payment_succeeded', 'subscription_cycle', '490.00', 'ANNUEL']);
  delete process.env.BREVO_OUTBOX_ENABLED;
});

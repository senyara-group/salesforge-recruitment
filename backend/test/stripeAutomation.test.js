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

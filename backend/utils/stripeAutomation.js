function stripeObjectId(value) { return typeof value === 'string' ? value : value?.id; }

async function captureStripeAutomation(db, stripe, event) {
  if (process.env.BREVO_OUTBOX_ENABLED !== 'true') return;
  const object = event.data.object;
  let subscription = object;
  const isInvoice = ['invoice.payment_succeeded', 'invoice.payment_failed'].includes(event.type);
  if (isInvoice) {
    const subscriptionId = stripeObjectId(object.parent?.subscription_details?.subscription || object.subscription);
    // A one-off invoice is not a SwipSales subscription payment.
    if (!subscriptionId) return;
    subscription = await stripe.subscriptions.retrieve(subscriptionId);
  }
  const userId = subscription.metadata?.userId;
  if (!userId) return; // Never guess a user from a customer email.
  const plan = subscription.metadata?.plan || '';
  const facturation = (subscription.metadata?.period || 'month') === 'year' ? 'ANNUEL' : 'MENSUEL';
  const properties = { plan, facturation, stripe_event_id: event.id };
  let name;
  if (isInvoice) {
    name = event.type === 'invoice.payment_succeeded' ? 'payment_succeeded' : 'payment_failed';
    const amount = name === 'payment_succeeded' ? object.amount_paid : object.amount_due;
    properties.amount_minor = amount;
    properties.currency = object.currency;
    // Current SwipSales checkout is exclusively EUR. Preserve raw amount for other currencies.
    properties.montant = object.currency === 'eur' ? (amount / 100).toFixed(2) : '';
    properties.numero_paiement = object.number || object.id;
    properties.invoice_id = object.id;
    properties.payment_url = object.hosted_invoice_url || '';
    // subscription_create = first payment (already covered by subscription_started),
    // subscription_cycle = renewal, subscription_update = proration after a change.
    properties.billing_reason = object.billing_reason || '';
  } else if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
    if (!['paid', 'no_payment_required'].includes(object.payment_status)) return;
    name = 'subscription_started';
    properties.montant = object.currency === 'eur' ? (object.amount_total / 100).toFixed(2) : '';
  } else if (event.type === 'customer.subscription.deleted') {
    name = 'subscription_ended';
  } else if (event.type === 'customer.subscription.updated') {
    name = 'subscription_updated';
    // Stripe's previous_attributes says what this event changed; the stored row is only
    // a fallback (webhooks can arrive out of order or be retried after the row moved).
    const changed = event.data.previous_attributes || {};
    const result = await db.from('abonnements').select('plan,statut,resiliation_programmee').eq('user_id', userId).maybeSingle();
    if (result.error) throw result.error;
    const previous = result.data;
    const wasCancelling = 'cancel_at_period_end' in changed ? Boolean(changed.cancel_at_period_end) : Boolean(previous?.resiliation_programmee);
    const previousPlan = changed.metadata?.plan || previous?.plan;
    if (object.cancel_at_period_end && !wasCancelling) name = 'subscription_cancel_scheduled';
    else if (!object.cancel_at_period_end && wasCancelling) name = 'subscription_reactivated';
    // A paid-to-paid change only: freemium -> paid is subscription_started, not plan_changed.
    else if (plan && previousPlan && previousPlan !== 'freemium' && plan !== previousPlan
      && (changed.metadata?.plan || changed.items)) {
      name = 'plan_changed'; properties.ancien_plan = previousPlan; properties.nouveau_plan = plan;
    }
    const periodEnd = object.current_period_end || object.items?.data?.[0]?.current_period_end;
    properties.date_fin = periodEnd ? new Date(periodEnd * 1000).toISOString() : '';
  }
  if (!name) return;
  const { error } = await db.from('brevo_outbox').upsert({
    user_id: userId, event_name: name, properties, dedupe_key: `stripe:${event.id}`,
  }, { onConflict: 'dedupe_key', ignoreDuplicates: true });
  // One automation event per Stripe event: a retried webhook can never add a second row,
  // even if the stored subscription moved between attempts.
  if (error) throw error; // Stripe retries the webhook if persistence failed.
}
module.exports = { captureStripeAutomation, stripeObjectId };

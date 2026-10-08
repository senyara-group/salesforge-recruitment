const { brevoRequest, deliverBrevoEvent } = require('./brevoEvents');
const { prepareDelivery, templateFor } = require('./automationDelivery');

// ~17 hours of cumulative backoff (11 waits); afterwards the row is discarded and kept for inspection.
const MAX_ATTEMPTS = 12;
// Triggers record facts as soon as the migration is installed, even while the worker is
// off: a notification never accepted by Brevo within this window is dropped as stale
// instead of arriving days late (contact updates are always applied: they re-read
// current data). Override with BREVO_MAX_EVENT_AGE_HOURS.
const DEFAULT_MAX_EVENT_AGE_HOURS = 72;

function maxEventAgeMs() {
  const hours = Number(process.env.BREVO_MAX_EVENT_AGE_HOURS);
  return (Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_MAX_EVENT_AGE_HOURS) * 3600000;
}

function retryDelay(attempts) {
  return Math.min(24 * 3600, 30 * 2 ** Math.min(attempts - 1, 12));
}

// Brevo event_properties only accept string, number, boolean and date values:
// lists become numbered scalars (offre_1_poste, candidat_1_score...), nulls are dropped.
// Transactional template params keep the original nested lists.
function eventScalars(properties) {
  const flat = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      const prefix = key.replace(/s$/, '');
      value.forEach((item, index) => {
        if (item && typeof item === 'object') {
          for (const [field, inner] of Object.entries(item)) {
            if (inner != null && typeof inner !== 'object') flat[`${prefix}_${index + 1}_${field.replace(/^(offre|candidat)_/, '')}`] = inner;
          }
        } else if (item != null) flat[`${prefix}_${index + 1}`] = item;
      });
    } else if (typeof value !== 'object') flat[key] = value;
  }
  return flat;
}

function eventProperties(row, baseUrl) {
  const properties = { ...row.properties, event_id: row.id, occurred_at: row.created_at };
  // The destination is the authenticated application, which applies ownership.
  properties.lien = `${baseUrl.replace(/\/$/, '')}/swipsales_app.html`;
  properties.lien_preferences = `${properties.lien}?preferences=1`;
  if (row.event_name === 'payment_failed' && properties.payment_url) properties.lien = properties.payment_url;
  // Data minimisation: candidate identifiers are used server-side (score, snapshot lookup)
  // but no email needs them, so they never leave SwipSales.
  delete properties.candidat_id;
  if (Array.isArray(properties.candidats)) properties.candidats = properties.candidats.map(({ score }) => ({ score }));
  return properties;
}

async function runWorker({ db, request = brevoRequest, deliver = deliverBrevoEvent, prepare = prepareDelivery, now = () => new Date() }) {
  if (!process.env.BREVO_API_KEY) throw new Error('BREVO_API_KEY missing; no events claimed');
  const baseUrl = process.env.FRONTEND_URL;
  if (!baseUrl || !/^https:\/\//.test(baseUrl)) throw new Error('HTTPS FRONTEND_URL required');
  templateFor('__validate_configuration');
  // Renew and verify ownership before each row, including rows waiting in a batch.
  const { data: rows, error } = await db.rpc('claim_brevo_events', { batch_size: 5 });
  if (error) throw error;
  let delivered = 0;
  for (const row of rows || []) {
    try {
      const lease = await db.from('brevo_outbox').update({ leased_until: new Date(now().getTime() + 15 * 60000).toISOString() })
        .eq('id', row.id).eq('lease_token', row.lease_token).select('id').maybeSingle();
      if (lease.error) throw lease.error;
      if (!lease.data) continue;
      if (row.event_name !== '__contact_update' && !row.event_delivered_at
        && now().getTime() - Date.parse(row.created_at) > maxEventAgeMs()) {
        const stale = await db.from('brevo_outbox').update({ discarded_at: now().toISOString(),
          leased_until: null, lease_token: null, last_error: 'stale: older than max event age' }).eq('id', row.id).eq('lease_token', row.lease_token);
        if (stale.error) throw stale.error;
        continue;
      }
      const prepared = await prepare(db, row, now().getTime());
      if (!prepared.allowed) {
        const discarded = await db.from('brevo_outbox').update({ discarded_at: now().toISOString(),
          leased_until: null, lease_token: null, last_error: prepared.reason }).eq('id', row.id).eq('lease_token', row.lease_token);
        if (discarded.error) throw discarded.error;
        continue;
      }
      let email = row.email;
      if (!email) {
        const recipient = await db.from('users').select('email').eq('id', row.user_id).maybeSingle();
        if (recipient.error) throw recipient.error;
        email = recipient.data?.email;
      }
      if (!email) throw new Error('recipient unavailable');
      const contact = await request('/contacts', 'POST', {
        email, attributes: prepared.contact, updateEnabled: true,
      });
      if (!contact) throw new Error('contact update rejected');
      const properties = eventProperties({ ...row, properties: prepared.properties }, baseUrl);
      // Validate configuration before sending an event that cannot be rolled back.
      const templateId = templateFor(row.event_name, properties);
      if (row.event_name !== '__contact_update' && !row.event_delivered_at) {
        const success = await deliver(email, row.event_name, eventScalars(properties), prepared.contact);
        if (!success) throw new Error('event rejected');
        const checkpoint = await db.from('brevo_outbox').update({ event_delivered_at: now().toISOString() })
          .eq('id', row.id).eq('lease_token', row.lease_token);
        if (checkpoint.error) throw checkpoint.error;
      }
      if (templateId && !row.email_delivered_at) {
        // Brevo documents no deduplication for these headers: the email_delivered_at
        // checkpoint is the real guard, X-Mailin-custom makes the event_id visible in logs.
        const sent = await request('/smtp/email', 'POST', {
          to: [{ email }], templateId, params: properties, tags: [row.event_name],
          headers: { 'Idempotency-Key': row.id, 'X-Mailin-custom': `event_id:${row.id}` },
        });
        if (!sent) throw new Error('transactional email rejected');
        const checkpoint = await db.from('brevo_outbox').update({ email_delivered_at: now().toISOString() })
          .eq('id', row.id).eq('lease_token', row.lease_token);
        if (checkpoint.error) throw checkpoint.error;
      }
      const result = await db.from('brevo_outbox').update({
        delivered_at: now().toISOString(), leased_until: null, lease_token: null, last_error: null,
      }).eq('id', row.id).eq('lease_token', row.lease_token);
      if (result.error) throw result.error;
      delivered += 1;
    } catch (failure) {
      // Do not persist provider responses containing personal data or credentials.
      const reason = String(failure.code || failure.message || 'delivery failed').slice(0, 160);
      const exhausted = row.attempts >= MAX_ATTEMPTS;
      const result = await db.from('brevo_outbox').update({
        ...(exhausted ? { discarded_at: now().toISOString() }
          : { available_at: new Date(now().getTime() + retryDelay(row.attempts) * 1000).toISOString() }),
        leased_until: null, lease_token: null, last_error: exhausted ? `max attempts: ${reason}`.slice(0, 160) : reason,
      }).eq('id', row.id).eq('lease_token', row.lease_token);
      if (result.error) throw result.error;
    }
  }
  return { claimed: rows?.length || 0, delivered };
}

module.exports = { runWorker, retryDelay, eventProperties, eventScalars, MAX_ATTEMPTS, DEFAULT_MAX_EVENT_AGE_HOURS };

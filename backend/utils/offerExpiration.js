function expirationPatch(body, now = Date.now()) {
  if (body.expires_at === undefined) return {};
  if (process.env.BREVO_OUTBOX_ENABLED !== 'true') {
    const error = new Error('Expiration des offres non activee'); error.status = 503; throw error;
  }
  if (body.expires_at === null || body.expires_at === '') return { expires_at: null };
  const date = typeof body.expires_at === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(body.expires_at) ? Date.parse(body.expires_at) : NaN;
  if (!Number.isFinite(date) || date <= now) {
    const error = new Error('La date d’expiration doit etre une date future'); error.status = 400; throw error;
  }
  return { expires_at: new Date(date).toISOString() };
}
function excludeExpired(query) {
  return process.env.BREVO_OUTBOX_ENABLED === 'true' ? query.or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`) : query;
}
module.exports = { expirationPatch, excludeExpired };

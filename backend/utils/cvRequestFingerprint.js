const { createHash } = require('node:crypto');

// Same normalization as the CV route and browser; never log this fingerprint.
function cvRequestFingerprint(value) {
  const text = key => String(value[key] || '').replace(/\u0000/g, '').trim();
  return createHash('sha256').update(JSON.stringify([
    text('source_text'), text('target_role'), text('offer_text'),
    value.experience_years === '' || value.experience_years == null ? null : Number(value.experience_years),
    text('sector'),
  ])).digest('hex');
}
module.exports = { cvRequestFingerprint };

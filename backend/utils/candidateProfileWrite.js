/**
 * Normalisation des champs structurés du profil candidat (PR E).
 * Pas de backfill deep ADN / CV IA / Coach.
 */

const { CONTRACT_TYPES, normalizeToken, assertAllowedList } = require('./filterTaxonomies');

const MIN_YEARS = 0;
const MAX_YEARS = 80;
const MAX_MULTI = 12;
const MAX_TEXT = 80;
const MAX_MOBILITY_KM = 500;

function httpError(message, code = 'CANDIDATE_PROFILE_INVALID', status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function parseOptionalInt(raw, { label, min, max, code }) {
  if (raw == null || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    throw httpError(`${label} invalide`, code);
  }
  return n;
}

function parseOptionalText(raw, { label, maxLen = MAX_TEXT }) {
  if (raw == null) return null;
  const token = normalizeToken(raw);
  if (!token) return null;
  if (token.length > maxLen) {
    throw httpError(`${label} trop long (${maxLen} caractères max)`, 'CANDIDATE_PROFILE_TEXT_TOO_LONG');
  }
  return token;
}

function parseOptionalStringList(raw, { label, max = MAX_MULTI, maxLen = MAX_TEXT, allowed = null }) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw httpError(`${label} doit être un tableau`, 'CANDIDATE_PROFILE_ARRAY_INVALID');
  }
  if (raw.length > max) {
    throw httpError(`${label}: trop de valeurs (max ${max})`, 'CANDIDATE_PROFILE_MULTI_MAX');
  }
  const values = raw.map((item) => normalizeToken(item)).filter(Boolean);
  for (const value of values) {
    if (value.length > maxLen) {
      throw httpError(`${label}: valeur trop longue`, 'CANDIDATE_PROFILE_VALUE_TOO_LONG');
    }
  }
  if (allowed) return assertAllowedList(values, allowed, label);
  return [...new Set(values)];
}

/**
 * Ne normalise que les clés présentes dans body (PATCH ciblé).
 * Clés absentes → non renvoyées (pas d’écrasement).
 */
function normalizeCandidateProfileStructuredFields(body = {}) {
  const out = {};

  if (Object.prototype.hasOwnProperty.call(body, 'target_job_types')) {
    out.target_job_types = parseOptionalStringList(body.target_job_types, { label: 'target_job_types' });
  }
  if (Object.prototype.hasOwnProperty.call(body, 'sales_style')) {
    out.sales_style = parseOptionalText(body.sales_style, { label: 'sales_style' });
  }
  if (Object.prototype.hasOwnProperty.call(body, 'years_experience')) {
    out.years_experience = parseOptionalInt(body.years_experience, {
      label: 'years_experience', min: MIN_YEARS, max: MAX_YEARS, code: 'CANDIDATE_PROFILE_YEARS_INVALID',
    });
  }
  if (Object.prototype.hasOwnProperty.call(body, 'desired_contracts')) {
    out.desired_contracts = parseOptionalStringList(body.desired_contracts, {
      label: 'desired_contracts',
      allowed: [...CONTRACT_TYPES],
    });
  }
  if (Object.prototype.hasOwnProperty.call(body, 'sectors')) {
    out.sectors = parseOptionalStringList(body.sectors, { label: 'sectors' });
  }
  if (Object.prototype.hasOwnProperty.call(body, 'customer_types')) {
    out.customer_types = parseOptionalStringList(body.customer_types, { label: 'customer_types' });
  }
  if (Object.prototype.hasOwnProperty.call(body, 'tools')) {
    out.tools = parseOptionalStringList(body.tools, { label: 'tools' });
  }
  if (Object.prototype.hasOwnProperty.call(body, 'methodologies')) {
    out.methodologies = parseOptionalStringList(body.methodologies, { label: 'methodologies' });
  }
  if (Object.prototype.hasOwnProperty.call(body, 'availability')) {
    out.availability = parseOptionalText(body.availability, { label: 'availability' });
  }
  if (Object.prototype.hasOwnProperty.call(body, 'mobility_km')) {
    out.mobility_km = parseOptionalInt(body.mobility_km, {
      label: 'mobility_km', min: 0, max: MAX_MOBILITY_KM, code: 'CANDIDATE_PROFILE_MOBILITY_INVALID',
    });
  }
  if (Object.prototype.hasOwnProperty.call(body, 'city_code')) {
    out.city_code = parseOptionalText(body.city_code, { label: 'city_code', maxLen: 32 });
  }

  return out;
}

module.exports = {
  MIN_YEARS,
  MAX_YEARS,
  MAX_MULTI,
  MAX_TEXT,
  MAX_MOBILITY_KM,
  CONTRACT_TYPES,
  normalizeCandidateProfileStructuredFields,
};

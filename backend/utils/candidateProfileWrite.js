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

const AXES_META_PATCH_KEYS = Object.freeze([
  'motivation',
  'anonyme',
  'avatar_label',
  'ville',
  'competences',
]);

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

/**
 * Ordre : array → trim → vides → dédup → MAX_MULTI → longueur.
 * 13× "SaaS" → ["SaaS"] (accepté).
 */
function parseOptionalStringList(raw, { label, max = MAX_MULTI, maxLen = MAX_TEXT, allowed = null }) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw httpError(`${label} doit être un tableau`, 'CANDIDATE_PROFILE_ARRAY_INVALID');
  }
  const values = [...new Set(raw.map((item) => normalizeToken(item)).filter(Boolean))];
  if (values.length > max) {
    throw httpError(`${label}: trop de valeurs (max ${max})`, 'CANDIDATE_PROFILE_MULTI_MAX');
  }
  for (const value of values) {
    if (value.length > maxLen) {
      throw httpError(`${label}: valeur trop longue`, 'CANDIDATE_PROFILE_VALUE_TOO_LONG');
    }
  }
  if (allowed) return assertAllowedList(values, allowed, label);
  return values;
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

/** Patch ciblé axes.meta — uniquement les clés présentes dans body. */
function buildAxesMetaPatch(body = {}) {
  const patch = {};
  for (const key of AXES_META_PATCH_KEYS) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      patch[key] = body[key];
    }
  }
  return patch;
}

/**
 * Sémantique PostgreSQL merge_candidat_axes_meta (miroir unit-testable).
 * JSON null / JS null → {} ; array|scalar → throw avant « UPDATE ».
 */
function resolveMergeCandidatAxesMeta(axes, metaPatch) {
  if (metaPatch == null || typeof metaPatch !== 'object' || Array.isArray(metaPatch)) {
    const got = metaPatch == null ? 'sql-null' : (Array.isArray(metaPatch) ? 'array' : typeof metaPatch);
    const error = new Error(`meta_patch must be a jsonb object (got ${got})`);
    error.code = 'AXES_META_PATCH_INVALID';
    error.status = 400;
    throw error;
  }

  let baseAxes;
  if (axes == null) {
    baseAxes = {};
  } else if (typeof axes === 'object' && !Array.isArray(axes)) {
    baseAxes = { ...axes };
  } else {
    const got = Array.isArray(axes) ? 'array' : typeof axes;
    const error = new Error(`axes must be a jsonb object (got ${got})`);
    error.code = 'AXES_TYPE_INVALID';
    error.status = 400;
    throw error;
  }

  let baseMeta;
  if (!Object.prototype.hasOwnProperty.call(baseAxes, 'meta') || baseAxes.meta == null) {
    baseMeta = {};
  } else if (typeof baseAxes.meta === 'object' && !Array.isArray(baseAxes.meta)) {
    baseMeta = { ...baseAxes.meta };
  } else {
    const got = Array.isArray(baseAxes.meta) ? 'array' : typeof baseAxes.meta;
    const error = new Error(`axes.meta must be a jsonb object (got ${got})`);
    error.code = 'AXES_META_TYPE_INVALID';
    error.status = 400;
    throw error;
  }

  return { ...baseAxes, meta: { ...baseMeta, ...metaPatch } };
}

/** @deprecated alias — utilise resolveMergeCandidatAxesMeta (contrat RPC). */
function applyAxesMetaMerge(axes, metaPatch) {
  return resolveMergeCandidatAxesMeta(axes, metaPatch);
}

module.exports = {
  MIN_YEARS,
  MAX_YEARS,
  MAX_MULTI,
  MAX_TEXT,
  MAX_MOBILITY_KM,
  CONTRACT_TYPES,
  AXES_META_PATCH_KEYS,
  normalizeCandidateProfileStructuredFields,
  parseOptionalStringList,
  buildAxesMetaPatch,
  applyAxesMetaMerge,
  resolveMergeCandidatAxesMeta,
};

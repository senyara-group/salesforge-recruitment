/**
 * Normalisation / validation des champs structurés à l’écriture d’offre.
 * Ne parse jamais les champs legacy texte (salaire, lieu, description).
 */

const {
  CONTRACT_TYPES,
  REMOTE_MODES,
  OFFER_TAG_VOCABULARY,
  VARIABLE_SHARES,
  normalizeToken,
  assertAllowedValue,
  assertAllowedList,
  canonicalizeContractType,
} = require('./filterTaxonomies');
const {
  OFFER_SKILLS,
  CUSTOMER_TYPES,
  resolveCanonicalSkill,
  canonicalizeVariableShare,
  canonicalizeSalesStyle,
  canonicalizeCustomerType,
  canonicalizeSector,
  canonicalizeTargetJobType,
} = require('./yannisTaxonomies');

const MIN_SALARY = 0;
const MAX_SALARY = 500_000;
const MAX_JOB_TYPE = 80;
const MAX_SECTOR = 80;
const MIN_EXPERIENCE = 0;
const MAX_EXPERIENCE = 40;
const MAX_MULTI = 12;

function httpError(message, code = 'OFFER_WRITE_INVALID', status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function parseOptionalSalary(raw, label) {
  if (raw == null || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < MIN_SALARY || n > MAX_SALARY) {
    throw httpError(`${label} invalide`, 'OFFER_SALARY_INVALID');
  }
  return n;
}

function parseOptionalInt(raw, { label, min, max }) {
  if (raw == null || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    throw httpError(`${label} invalide`, 'OFFER_EXPERIENCE_INVALID');
  }
  return n;
}

function parseOptionalText(raw, { label, maxLen }) {
  if (raw == null) return null;
  const token = normalizeToken(raw);
  if (!token) return null;
  if (token.length > maxLen) {
    throw httpError(`${label} trop long (${maxLen} caractères max)`, 'OFFER_TEXT_TOO_LONG');
  }
  return token;
}

function parseOptionalStringList(raw, {
  label,
  allowed = null,
  canonicalize = null,
  max = MAX_MULTI,
  unknown = 'reject',
}) {
  if (raw == null || raw === '') return [];
  if (!Array.isArray(raw)) {
    throw httpError(`${label} doit être un tableau`, 'OFFER_ARRAY_INVALID');
  }
  const values = [];
  for (const item of raw) {
    const token = normalizeToken(item);
    if (!token) continue;
    let next = token;
    if (canonicalize) {
      const canonical = canonicalize(token);
      if (!canonical) {
        if (unknown === 'drop') continue;
        throw httpError(`${label} invalide: ${token}`, 'FILTER_TAXONOMY_INVALID');
      }
      next = canonical;
    } else if (allowed && !allowed.includes(token)) {
      throw httpError(`${label} invalide: ${token}`, 'FILTER_TAXONOMY_INVALID');
    }
    if (!values.includes(next)) values.push(next);
  }
  if (values.length > max) {
    throw httpError(`${label}: trop de valeurs (max ${max})`, 'OFFER_MULTI_MAX');
  }
  if (allowed && unknown !== 'drop') {
    return assertAllowedList(values, allowed, label);
  }
  return values;
}

/**
 * Valide et normalise les champs structurés du body.
 * Valeurs vides → null / [].
 */
function normalizeOfferStructuredFields(body = {}) {
  let contract_type = null;
  if (normalizeToken(body.contract_type)) {
    contract_type = assertAllowedValue(body.contract_type, [...CONTRACT_TYPES], 'contract_type');
  } else {
    contract_type = canonicalizeContractType(body.type);
  }

  let remote_mode = null;
  if (normalizeToken(body.remote_mode)) {
    remote_mode = assertAllowedValue(body.remote_mode, [...REMOTE_MODES], 'remote_mode');
  }

  const salary_fixed_min = parseOptionalSalary(body.salary_fixed_min, 'salary_fixed_min');
  const salary_fixed_max = parseOptionalSalary(body.salary_fixed_max, 'salary_fixed_max');
  if (salary_fixed_min != null && salary_fixed_max != null && salary_fixed_max < salary_fixed_min) {
    throw httpError('salary_fixed_max doit être ≥ salary_fixed_min', 'OFFER_SALARY_RANGE');
  }

  let job_type = parseOptionalText(body.job_type, { label: 'job_type', maxLen: MAX_JOB_TYPE });
  if (job_type) {
    job_type = canonicalizeTargetJobType(job_type) || job_type;
  }

  let sector = parseOptionalText(body.sector, { label: 'sector', maxLen: MAX_SECTOR });
  if (sector) {
    sector = canonicalizeSector(sector) || sector;
  }

  let tags = [];
  if (body.tags != null && body.tags !== '') {
    if (!Array.isArray(body.tags)) {
      throw httpError('tags doit être un tableau', 'OFFER_TAGS_INVALID');
    }
    tags = assertAllowedList(body.tags, [...OFFER_TAG_VOCABULARY], 'tags');
    tags = [...new Set(tags)];
  }

  let variable_share = null;
  if (normalizeToken(body.variable_share)) {
    variable_share = canonicalizeVariableShare(body.variable_share);
    if (!variable_share) {
      throw httpError('variable_share invalide', 'FILTER_TAXONOMY_INVALID');
    }
  }

  const sales_styles = parseOptionalStringList(body.sales_styles, {
    label: 'sales_styles',
    canonicalize: canonicalizeSalesStyle,
    allowed: ['hunter', 'farmer', 'full'],
  });

  const customer_types = parseOptionalStringList(body.customer_types, {
    label: 'customer_types',
    canonicalize: canonicalizeCustomerType,
    allowed: [...CUSTOMER_TYPES],
  });

  const skills = parseOptionalStringList(body.skills, {
    label: 'skills',
    canonicalize: resolveCanonicalSkill,
    allowed: [...OFFER_SKILLS],
    unknown: 'drop',
  });

  const experience_min = parseOptionalInt(body.experience_min, {
    label: 'experience_min', min: MIN_EXPERIENCE, max: MAX_EXPERIENCE,
  });
  const experience_max = parseOptionalInt(body.experience_max, {
    label: 'experience_max', min: MIN_EXPERIENCE, max: MAX_EXPERIENCE,
  });
  if (experience_min != null && experience_max != null && experience_max < experience_min) {
    throw httpError('experience_max doit être ≥ experience_min', 'OFFER_EXPERIENCE_RANGE');
  }

  // Compat legacy : variable_share renseigné ⇒ has_variable true ; sinon conserver body si booléen.
  let has_variable = null;
  if (Object.prototype.hasOwnProperty.call(body, 'has_variable')) {
    if (body.has_variable === null || body.has_variable === '') has_variable = null;
    else has_variable = Boolean(body.has_variable);
  }
  if (variable_share != null) {
    has_variable = true;
  }

  let variable_note = null;
  if (Object.prototype.hasOwnProperty.call(body, 'variable_note')) {
    variable_note = parseOptionalText(body.variable_note, { label: 'variable_note', maxLen: 200 });
  }

  return {
    contract_type,
    remote_mode,
    salary_fixed_min,
    salary_fixed_max,
    job_type,
    sector,
    tags,
    variable_share,
    has_variable,
    variable_note,
    sales_styles,
    customer_types,
    skills,
    experience_min,
    experience_max,
  };
}

module.exports = {
  MIN_SALARY,
  MAX_SALARY,
  MAX_JOB_TYPE,
  MAX_SECTOR,
  MIN_EXPERIENCE,
  MAX_EXPERIENCE,
  normalizeOfferStructuredFields,
  CONTRACT_TYPES,
  REMOTE_MODES,
  OFFER_TAG_VOCABULARY,
  VARIABLE_SHARES,
  OFFER_SKILLS,
};

/**
 * Normalisation / validation des champs structurés à l’écriture d’offre (PR C).
 * Ne parse jamais les champs legacy texte (salaire, lieu, description).
 */

const {
  CONTRACT_TYPES,
  REMOTE_MODES,
  OFFER_TAG_VOCABULARY,
  normalizeToken,
  assertAllowedValue,
  assertAllowedList,
  canonicalizeContractType,
} = require('./filterTaxonomies');

const MIN_SALARY = 0;
const MAX_SALARY = 500_000;
const MAX_JOB_TYPE = 80;
const MAX_SECTOR = 80;

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

function parseOptionalText(raw, { label, maxLen }) {
  if (raw == null) return null;
  const token = normalizeToken(raw);
  if (!token) return null;
  if (token.length > maxLen) {
    throw httpError(`${label} trop long (${maxLen} caractères max)`, 'OFFER_TEXT_TOO_LONG');
  }
  return token;
}

/**
 * Valide et normalise les champs structurés du body.
 * Valeurs vides → null / [].
 * contract_type : whitelist si fourni ; sinon tentative de canonicalisation depuis type.
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

  const job_type = parseOptionalText(body.job_type, { label: 'job_type', maxLen: MAX_JOB_TYPE });
  const sector = parseOptionalText(body.sector, { label: 'sector', maxLen: MAX_SECTOR });

  let tags = [];
  if (body.tags != null && body.tags !== '') {
    if (!Array.isArray(body.tags)) {
      throw httpError('tags doit être un tableau', 'OFFER_TAGS_INVALID');
    }
    tags = assertAllowedList(body.tags, [...OFFER_TAG_VOCABULARY], 'tags');
    tags = [...new Set(tags)];
  }

  return {
    contract_type,
    remote_mode,
    salary_fixed_min,
    salary_fixed_max,
    job_type,
    sector,
    tags,
  };
}

module.exports = {
  MIN_SALARY,
  MAX_SALARY,
  MAX_JOB_TYPE,
  MAX_SECTOR,
  normalizeOfferStructuredFields,
  CONTRACT_TYPES,
  REMOTE_MODES,
  OFFER_TAG_VOCABULARY,
};

/**
 * Job taxonomy factory: validates a descriptor list once, then exposes
 * collision-free, read-only helpers. See JOB_TAXONOMY.md for the contracts.
 */

const JOB_TYPE_ID_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
const JOB_TYPE_LABEL_MAX_LENGTH = 80;
// C0/C1 controls (CR/LF/TAB included) and JS line terminators U+2028/U+2029.
const UNSAFE_TEXT_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const DESCRIPTOR_KEYS = new Set(['id', 'label', 'active', 'aliases']);

class JobTaxonomyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'JobTaxonomyError';
  }
}

// The single comparison rule used for labels, aliases and collision checks.
function normalizeJobTypeToken(value) {
  return value.trim().toLowerCase();
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Shared text contract (labels, aliases, ADN question text/options). */
function assertSafeText(value, where, maxLength) {
  if (typeof value !== 'string') throw new JobTaxonomyError(`${where}: must be a string`);
  if (!value.trim()) throw new JobTaxonomyError(`${where}: must not be empty`);
  if (value !== value.trim()) throw new JobTaxonomyError(`${where}: leading/trailing whitespace is not allowed`);
  if (UNSAFE_TEXT_CHARS.test(value)) throw new JobTaxonomyError(`${where}: control characters and line breaks (CR/LF) are not allowed`);
  if (value.length > maxLength) throw new JobTaxonomyError(`${where}: longer than ${maxLength} characters`);
}

function validateDescriptor(raw, index) {
  const where = `JOB_TYPES[${index}]`;
  if (!isPlainObject(raw)) throw new JobTaxonomyError(`${where}: descriptor must be a plain object`);
  for (const key of Object.keys(raw)) {
    if (!DESCRIPTOR_KEYS.has(key)) throw new JobTaxonomyError(`${where}: unknown key "${key}"`);
  }
  if (typeof raw.id !== 'string' || !JOB_TYPE_ID_PATTERN.test(raw.id)) {
    throw new JobTaxonomyError(`${where}: id must match ${JOB_TYPE_ID_PATTERN}`);
  }
  assertSafeText(raw.label, `${where} (${raw.id}).label`, JOB_TYPE_LABEL_MAX_LENGTH);
  if (raw.active !== undefined && typeof raw.active !== 'boolean') {
    throw new JobTaxonomyError(`${where} (${raw.id}).active must be a boolean when present`);
  }
  if (raw.aliases !== undefined && !Array.isArray(raw.aliases)) {
    throw new JobTaxonomyError(`${where} (${raw.id}).aliases must be an array when present`);
  }
  const aliases = raw.aliases || [];
  aliases.forEach((alias, i) => assertSafeText(alias, `${where} (${raw.id}).aliases[${i}]`, JOB_TYPE_LABEL_MAX_LENGTH));
  return { id: raw.id, label: raw.label, active: raw.active ?? true, aliases };
}

/**
 * Global validation: every token (ID, normalized label, normalized alias) must
 * resolve to at most one job. No "first match wins" is ever relied upon.
 */
function validateJobTypeDescriptors(rawList) {
  if (!Array.isArray(rawList) || rawList.length === 0) throw new JobTaxonomyError('JOB_TYPES must be a non-empty array');
  const jobs = rawList.map(validateDescriptor);
  const ids = new Map();
  for (const job of jobs) {
    if (ids.has(job.id)) throw new JobTaxonomyError(`duplicate job id "${job.id}"`);
    ids.set(job.id, job);
  }
  const tokens = new Map(); // normalized label/alias -> { id, kind }
  const claim = (job, text, kind) => {
    const token = normalizeJobTypeToken(text);
    const owner = tokens.get(token);
    if (owner) {
      throw new JobTaxonomyError(owner.id === job.id
        ? `${kind} "${text}" of "${job.id}" duplicates its own ${owner.kind} after normalization`
        : `${kind} "${text}" of "${job.id}" collides with ${owner.kind} of "${owner.id}" after normalization`);
    }
    // resolveStoredJobType() reads exact IDs first: a label/alias equal to another
    // job's ID (compared under the same normalization) would be ambiguous.
    const idOwner = [...ids.keys()].find(id => id !== job.id && normalizeJobTypeToken(id) === token);
    if (idOwner) throw new JobTaxonomyError(`${kind} "${text}" of "${job.id}" collides with the id of "${idOwner}"`);
    tokens.set(token, { id: job.id, kind });
  };
  for (const job of jobs) claim(job, job.label, 'label');
  for (const job of jobs) for (const alias of job.aliases) claim(job, alias, 'alias');
  if (!jobs.some(job => job.active)) throw new JobTaxonomyError('JOB_TYPES must contain at least one active job');
  return jobs;
}

function createJobTaxonomy(rawList) {
  const JOB_TYPES = Object.freeze(validateJobTypeDescriptors(rawList).map((job, order) => Object.freeze({
    id: job.id, label: job.label, aliases: Object.freeze([...job.aliases]), active: job.active, order,
  })));
  const byId = new Map(JOB_TYPES.map(job => [job.id, job]));
  const byToken = new Map();
  for (const job of JOB_TYPES) {
    for (const text of [job.label, ...job.aliases]) byToken.set(normalizeJobTypeToken(text), job);
  }

  function activeJobTypes() { return JOB_TYPES.filter(job => job.active); }
  // Reads: inactive jobs stay resolvable so historical stored values remain readable.
  function jobTypeById(value) { return typeof value === 'string' ? byId.get(value) || null : null; }
  function isJobTypeId(value) { return jobTypeById(value) !== null; }
  function resolveJobTypeLabel(value) {
    return typeof value === 'string' ? byToken.get(normalizeJobTypeToken(value)) || null : null;
  }
  function resolveStoredJobType(value) { return jobTypeById(value) || resolveJobTypeLabel(value); }
  function jobTypeLabel(value) { return resolveStoredJobType(value)?.label || null; }
  // New writes: only active jobs are canonicalized. An inactive label is not
  // resolved here, so writers keep it verbatim (never remapped, never dropped).
  function canonicalizeTargetJobType(value) {
    const job = resolveJobTypeLabel(value);
    return job && job.active ? job.label : null;
  }

  return Object.freeze({
    JOB_TYPES,
    TARGET_JOB_TYPES: Object.freeze(activeJobTypes().map(job => job.label)),
    activeJobTypes,
    jobTypeById,
    isJobTypeId,
    resolveJobTypeLabel,
    resolveStoredJobType,
    jobTypeLabel,
    canonicalizeTargetJobType,
  });
}

module.exports = {
  JOB_TYPE_ID_PATTERN,
  JOB_TYPE_LABEL_MAX_LENGTH,
  UNSAFE_TEXT_CHARS,
  JobTaxonomyError,
  normalizeJobTypeToken,
  isPlainObject,
  assertSafeText,
  validateJobTypeDescriptors,
  createJobTaxonomy,
};

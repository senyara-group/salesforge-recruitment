/**
 * Parsing / validation / règles du deck candidat /offres/deck.
 * Filtrage métier serveur ; pagination cursor ; pas de parsing legacy texte.
 * Hors géo (ville/rayon/lat/lon/mobility) — chantier ultérieur.
 */

const {
  CONTRACT_TYPES,
  REMOTE_MODES,
  OFFER_TAG_VOCABULARY,
  normalizeToken,
  assertAllowedList,
  VARIABLE_SHARES,
} = require('./filterTaxonomies');
const {
  OFFER_SKILLS,
  CUSTOMER_TYPES,
  SECTORS,
  TARGET_JOB_TYPES,
  resolveCanonicalSkill,
  canonicalizeVariableShare,
  canonicalizeSalesStyle,
  canonicalizeCustomerType,
  canonicalizeSector,
  canonicalizeTargetJobType,
} = require('./yannisTaxonomies');

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_MULTI = 12;
const MAX_SALARY = 500_000;
const MIN_SALARY = 0;
const MIN_EXPERIENCE = 0;
const MAX_EXPERIENCE = 10;

function httpError(message, code, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function splitCsv(raw) {
  if (raw == null || raw === '') return [];
  return String(raw)
    .split(',')
    .map((part) => normalizeToken(part))
    .filter(Boolean);
}

function parseLimit(raw) {
  if (raw == null || raw === '') return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw httpError('limit invalide', 'OFFER_DECK_LIMIT_INVALID');
  }
  if (n > MAX_LIMIT) {
    throw httpError(`limit max ${MAX_LIMIT}`, 'OFFER_DECK_LIMIT_MAX');
  }
  return n;
}

function parseSalaryMin(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < MIN_SALARY || n > MAX_SALARY) {
    throw httpError('salary_fixed_min invalide', 'OFFER_DECK_SALARY_INVALID');
  }
  return n;
}

function parseBoolFlag(raw) {
  if (raw == null || raw === '') return false;
  const token = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'oui'].includes(token)) return true;
  if (['0', 'false', 'no', 'non'].includes(token)) return false;
  throw httpError('include_unspecified_salary invalide', 'OFFER_DECK_BOOL_INVALID');
}

function parsePublishedSince(raw) {
  if (raw == null || raw === '') return null;
  const token = normalizeToken(raw);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(token)) {
    throw httpError('published_since doit être YYYY-MM-DD', 'OFFER_DECK_DATE_INVALID');
  }
  const date = new Date(`${token}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== token) {
    throw httpError('published_since invalide', 'OFFER_DECK_DATE_INVALID');
  }
  return date.toISOString();
}

function parseExperienceBound(raw, label) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < MIN_EXPERIENCE || n > MAX_EXPERIENCE) {
    throw httpError(`${label} invalide (0–${MAX_EXPERIENCE})`, 'OFFER_DECK_EXPERIENCE_INVALID');
  }
  return n;
}

function parseBoundedList(raw, { label, allowed = null, max = MAX_MULTI, maxLen = 80 }) {
  const values = splitCsv(raw);
  if (values.length > max) {
    throw httpError(`${label}: trop de valeurs (max ${max})`, 'OFFER_DECK_MULTI_MAX');
  }
  for (const value of values) {
    if (value.length > maxLen) {
      throw httpError(`${label}: valeur trop longue`, 'OFFER_DECK_VALUE_TOO_LONG');
    }
  }
  if (allowed) return assertAllowedList(values, allowed, label);
  return values;
}

/**
 * Liste CSV : canonicalize si connu ; sinon conserve le token (job_type/sector legacy).
 * Pour listes fermées strictes, passer rejectUnknown=true.
 */
function parseCanonicalList(raw, { label, canonicalize, allowed, rejectUnknown = true }) {
  const values = splitCsv(raw);
  if (!values.length) return [];
  if (values.length > MAX_MULTI) {
    throw httpError(`${label}: trop de valeurs (max ${MAX_MULTI})`, 'OFFER_DECK_MULTI_MAX');
  }
  const out = [];
  for (const value of values) {
    const canonical = canonicalize(value);
    if (canonical) {
      if (allowed && !allowed.includes(canonical)) {
        throw httpError(`${label} invalide: ${value}`, 'FILTER_TAXONOMY_INVALID');
      }
      if (!out.includes(canonical)) out.push(canonical);
      continue;
    }
    if (rejectUnknown) {
      throw httpError(`${label} invalide: ${value}`, 'FILTER_TAXONOMY_INVALID');
    }
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

function parseTags(raw) {
  const values = parseBoundedList(raw, { label: 'tags', allowed: null, max: MAX_MULTI, maxLen: 40 });
  return assertAllowedList(values, [...OFFER_TAG_VOCABULARY], 'tags');
}

function encodeCursor(row) {
  if (!row?.id) return null;
  const dated = row.created_at != null && row.created_at !== '';
  return Buffer.from(JSON.stringify({
    p: dated ? 'd' : 'n',
    c: dated ? String(row.created_at) : null,
    i: String(row.id),
  }), 'utf8').toString('base64url');
}

function decodeCursor(raw) {
  if (raw == null || raw === '') return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || !parsed.i) {
      throw new Error('missing id');
    }
    const dated = parsed.p === 'd' || (parsed.p == null && parsed.c != null);
    return {
      phase: dated ? 'd' : 'n',
      created_at: dated ? String(parsed.c) : null,
      id: String(parsed.i),
    };
  } catch {
    throw httpError('cursor invalide', 'OFFER_DECK_CURSOR_INVALID');
  }
}

function parseOfferDeckQuery(query = {}) {
  const experience_min = parseExperienceBound(query.experience_min, 'experience_min');
  const experience_max = parseExperienceBound(query.experience_max, 'experience_max');
  if (experience_min != null && experience_max != null && experience_max < experience_min) {
    throw httpError('experience_max doit être ≥ experience_min', 'OFFER_DECK_EXPERIENCE_RANGE');
  }

  const salesRaw = query.sales_styles != null && query.sales_styles !== ''
    ? query.sales_styles
    : query.sales_style;

  return {
    limit: parseLimit(query.limit),
    cursor: decodeCursor(query.cursor),
    contract_types: parseBoundedList(query.contract_type, {
      label: 'contract_type',
      allowed: [...CONTRACT_TYPES],
    }),
    remote_modes: parseBoundedList(query.remote_mode, {
      label: 'remote_mode',
      allowed: [...REMOTE_MODES],
    }),
    tags: query.tags == null || query.tags === '' ? [] : parseTags(query.tags),
    salary_fixed_min: parseSalaryMin(query.salary_fixed_min),
    include_unspecified_salary: parseBoolFlag(query.include_unspecified_salary),
    published_since: parsePublishedSince(query.published_since),
    job_types: parseCanonicalList(query.job_type, {
      label: 'job_type',
      canonicalize: canonicalizeTargetJobType,
      allowed: [...TARGET_JOB_TYPES],
      rejectUnknown: false,
    }),
    sectors: parseCanonicalList(query.sector, {
      label: 'sector',
      canonicalize: canonicalizeSector,
      allowed: [...SECTORS],
      rejectUnknown: false,
    }),
    variable_shares: parseCanonicalList(query.variable_share, {
      label: 'variable_share',
      canonicalize: canonicalizeVariableShare,
      allowed: [...VARIABLE_SHARES],
    }),
    sales_styles: parseCanonicalList(salesRaw, {
      label: 'sales_style',
      canonicalize: canonicalizeSalesStyle,
      allowed: ['hunter', 'farmer', 'full'],
    }),
    customer_types: parseCanonicalList(query.customer_types, {
      label: 'customer_types',
      canonicalize: canonicalizeCustomerType,
      allowed: [...CUSTOMER_TYPES],
    }),
    skills: parseCanonicalList(query.skills, {
      label: 'skills',
      canonicalize: resolveCanonicalSkill,
      allowed: [...OFFER_SKILLS],
    }),
    experience_min,
    experience_max,
  };
}

/**
 * Salaire fixe minimum X :
 * - salary_fixed_max >= X si max renseigné
 * - sinon salary_fixed_min >= X
 * - sinon NULL/NULL : match seulement si include_unspecified_salary
 */
function offerMatchesSalaryMin(offer, salaryMin, includeUnspecified = false) {
  if (salaryMin == null) return true;
  if (offer.salary_fixed_max != null) return Number(offer.salary_fixed_max) >= salaryMin;
  if (offer.salary_fixed_min != null) return Number(offer.salary_fixed_min) >= salaryMin;
  if (includeUnspecified && offer.salary_fixed_min == null && offer.salary_fixed_max == null) {
    return true;
  }
  return false;
}

/**
 * Tranche expérience demandée (0–10, 10 = 10+).
 * Filtre explicite : NULL/NULL legacy ne matche pas.
 * Chevauchement [offer_lo, offer_hi] ∩ [filter_lo, filter_hi].
 */
function offerMatchesExperience(offer, filterMin, filterMax) {
  if (filterMin == null && filterMax == null) return true;
  const oMin = offer.experience_min;
  const oMax = offer.experience_max;
  if (oMin == null && oMax == null) return false;
  const lo = oMin != null ? Number(oMin) : 0;
  const hi = oMax != null ? Number(oMax) : 99;
  const fLo = filterMin != null ? filterMin : 0;
  const fHi = filterMax != null ? filterMax : 99;
  return lo <= fHi && hi >= fLo;
}

function arrayOverlaps(candidateValues, selected) {
  if (!selected?.length) return true;
  if (!Array.isArray(candidateValues) || !candidateValues.length) return false;
  const pool = new Set(candidateValues.map(String));
  return selected.some((value) => pool.has(String(value)));
}

function offerMatchesDeckFilters(offer, filters) {
  if (filters.contract_types.length) {
    if (offer.contract_type == null) return false;
    if (!filters.contract_types.includes(offer.contract_type)) return false;
  }
  if (filters.remote_modes.length) {
    if (offer.remote_mode == null) return false;
    if (!filters.remote_modes.includes(offer.remote_mode)) return false;
  }
  if (filters.tags.length) {
    const tags = Array.isArray(offer.tags) ? offer.tags.map(String) : [];
    if (!filters.tags.some((tag) => tags.includes(tag))) return false;
  }
  if (!offerMatchesSalaryMin(offer, filters.salary_fixed_min, filters.include_unspecified_salary)) {
    return false;
  }
  if (filters.published_since) {
    if (!offer.created_at) return false;
    if (new Date(offer.created_at).getTime() < new Date(filters.published_since).getTime()) return false;
  }
  if (filters.job_types.length) {
    if (offer.job_type == null) return false;
    if (!filters.job_types.includes(offer.job_type)) return false;
  }
  if (filters.sectors.length) {
    if (offer.sector == null) return false;
    if (!filters.sectors.includes(offer.sector)) return false;
  }
  if (filters.variable_shares.length) {
    if (offer.variable_share == null || offer.variable_share === '') return false;
    if (!filters.variable_shares.includes(String(offer.variable_share))) return false;
  }
  if (filters.sales_styles.length && !arrayOverlaps(offer.sales_styles, filters.sales_styles)) {
    return false;
  }
  if (filters.customer_types.length && !arrayOverlaps(offer.customer_types, filters.customer_types)) {
    return false;
  }
  if (filters.skills.length && !arrayOverlaps(offer.skills, filters.skills)) {
    return false;
  }
  if (!offerMatchesExperience(offer, filters.experience_min, filters.experience_max)) {
    return false;
  }
  return true;
}

function compareOffersNewestFirst(a, b) {
  const ac = a.created_at ? new Date(a.created_at).getTime() : null;
  const bc = b.created_at ? new Date(b.created_at).getTime() : null;
  if (ac != null && bc != null && ac !== bc) return bc - ac;
  if (ac != null && bc == null) return -1;
  if (ac == null && bc != null) return 1;
  return String(b.id).localeCompare(String(a.id));
}

function isAfterCursor(row, cursor) {
  if (!cursor) return true;
  const rowTime = row.created_at != null && row.created_at !== ''
    ? new Date(row.created_at).getTime()
    : null;
  if (cursor.phase === 'd' || (cursor.phase == null && cursor.created_at != null)) {
    const cursorTime = new Date(cursor.created_at).getTime();
    if (rowTime != null) {
      if (rowTime < cursorTime) return true;
      if (rowTime > cursorTime) return false;
      return String(row.id) < String(cursor.id);
    }
    return true;
  }
  if (rowTime != null) return false;
  return String(row.id) < String(cursor.id);
}

function paginateOfferDeck(rows, filters, { seenIds = [] } = {}) {
  const seen = new Set(seenIds.map(String));
  const filtered = rows
    .filter((row) => {
      const statut = row.statut == null ? 'active' : String(row.statut);
      if (statut !== 'active') return false;
      if (seen.has(String(row.id))) return false;
      return offerMatchesDeckFilters(row, filters);
    })
    .sort(compareOffersNewestFirst)
    .filter((row) => isAfterCursor(row, filters.cursor));

  const page = filtered.slice(0, filters.limit);
  const hasMore = filtered.length > filters.limit;
  const last = page[page.length - 1];
  return {
    offers: page,
    next_cursor: hasMore && last ? encodeCursor(last) : null,
    has_more: hasMore,
  };
}

function applySupabaseDeckFilters(query, filters) {
  let q = query.or('statut.eq.active,statut.is.null');

  if (filters.contract_types.length) {
    q = q.in('contract_type', filters.contract_types);
  }
  if (filters.remote_modes.length) {
    q = q.in('remote_mode', filters.remote_modes);
  }
  if (filters.tags.length) {
    q = q.overlaps('tags', filters.tags);
  }
  if (filters.published_since) {
    q = q.gte('created_at', filters.published_since);
  }
  if (filters.job_types.length) {
    q = q.in('job_type', filters.job_types);
  }
  if (filters.sectors.length) {
    q = q.in('sector', filters.sectors);
  }
  if (filters.variable_shares.length) {
    q = q.in('variable_share', filters.variable_shares);
  }
  if (filters.sales_styles.length) {
    q = q.overlaps('sales_styles', filters.sales_styles);
  }
  if (filters.customer_types.length) {
    q = q.overlaps('customer_types', filters.customer_types);
  }
  if (filters.skills.length) {
    q = q.overlaps('skills', filters.skills);
  }
  if (filters.salary_fixed_min != null) {
    const x = filters.salary_fixed_min;
    if (filters.include_unspecified_salary) {
      q = q.or(
        `salary_fixed_max.gte.${x},and(salary_fixed_max.is.null,salary_fixed_min.gte.${x}),and(salary_fixed_min.is.null,salary_fixed_max.is.null)`,
      );
    } else {
      q = q.or(`salary_fixed_max.gte.${x},and(salary_fixed_max.is.null,salary_fixed_min.gte.${x})`);
    }
  }
  if (filters.experience_min != null || filters.experience_max != null) {
    const fLo = filters.experience_min != null ? filters.experience_min : 0;
    const fHi = filters.experience_max != null ? filters.experience_max : 99;
    q = q.or(
      `and(experience_min.lte.${fHi},experience_max.gte.${fLo}),and(experience_min.lte.${fHi},experience_max.is.null),and(experience_min.is.null,experience_max.gte.${fLo})`,
    );
  }
  return q;
}

function applySupabaseCursor(query, cursor) {
  if (!cursor) return query;
  if (cursor.phase === 'n' || cursor.created_at == null) {
    return query.is('created_at', null).lt('id', cursor.id);
  }
  const ts = cursor.created_at;
  const id = cursor.id;
  return query.or(
    `created_at.lt.${ts},and(created_at.eq.${ts},id.lt.${id}),created_at.is.null`,
  );
}

module.exports = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MIN_EXPERIENCE,
  MAX_EXPERIENCE,
  parseOfferDeckQuery,
  encodeCursor,
  decodeCursor,
  offerMatchesSalaryMin,
  offerMatchesExperience,
  offerMatchesDeckFilters,
  compareOffersNewestFirst,
  isAfterCursor,
  paginateOfferDeck,
  applySupabaseDeckFilters,
  applySupabaseCursor,
};

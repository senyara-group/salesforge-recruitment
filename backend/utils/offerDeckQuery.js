/**
 * Parsing / validation / règles du deck candidat /offres/deck (PR B).
 * Filtrage métier serveur ; pagination cursor ; pas de parsing legacy texte.
 */

const {
  CONTRACT_TYPES,
  REMOTE_MODES,
  OFFER_TAG_VOCABULARY,
  normalizeToken,
  assertAllowedList,
} = require('./filterTaxonomies');

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_MULTI = 12;
const MAX_SALARY = 500_000;
const MIN_SALARY = 0;

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

function parseTags(raw) {
  const values = parseBoundedList(raw, { label: 'tags', allowed: null, max: MAX_MULTI, maxLen: 40 });
  // Accepte le vocabulaire connu ; refuse les tags hors liste pour éviter le bruit.
  return assertAllowedList(values, [...OFFER_TAG_VOCABULARY], 'tags');
}

/**
 * Cursor opaque base64url.
 * Format : { p: 'd'|'n', c: created_at|null, i: id }
 *   p='d' → phase dated (created_at non NULL)
 *   p='n' → phase null (created_at IS NULL), suite uniquement via id DESC
 * Tri serveur : created_at DESC NULLS LAST, id DESC.
 */
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
    published_since: parsePublishedSince(query.published_since),
    job_types: parseBoundedList(query.job_type, { label: 'job_type', allowed: null }),
    sectors: parseBoundedList(query.sector, { label: 'sector', allowed: null }),
  };
}

/**
 * Règle salaire candidat "fixe minimum" X :
 * - salary_fixed_max >= X si max renseigné
 * - sinon salary_fixed_min >= X
 * - sinon (tout NULL) : ne matche pas
 * Jamais de parsing de offres.salaire texte.
 */
function offerMatchesSalaryMin(offer, salaryMin) {
  if (salaryMin == null) return true;
  if (offer.salary_fixed_max != null) return Number(offer.salary_fixed_max) >= salaryMin;
  if (offer.salary_fixed_min != null) return Number(offer.salary_fixed_min) >= salaryMin;
  return false;
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
  if (!offerMatchesSalaryMin(offer, filters.salary_fixed_min)) return false;
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
  return true;
}

/** Comparaison tri : created_at DESC NULLS LAST, id DESC. */
function compareOffersNewestFirst(a, b) {
  const ac = a.created_at ? new Date(a.created_at).getTime() : null;
  const bc = b.created_at ? new Date(b.created_at).getTime() : null;
  if (ac != null && bc != null && ac !== bc) return bc - ac;
  if (ac != null && bc == null) return -1;
  if (ac == null && bc != null) return 1;
  return String(b.id).localeCompare(String(a.id));
}

/** true si `row` est strictement après le curseur dans l’ordre newest-first. */
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
    // Phase B : toutes les lignes created_at NULL viennent après la phase dated.
    return true;
  }
  // Cursor déjà en phase NULL : uniquement NULL avec id < cursor.id (jamais created_at < NULL).
  if (rowTime != null) return false;
  return String(row.id) < String(cursor.id);
}

/**
 * Applique filtres + exclusions + tri + cursor + limit en mémoire sur un jeu déjà
 * restreint (tests / fallback). La route préfère pousser ce qui est possible en SQL.
 */
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

/**
 * Construit les filtres Supabase supportés nativement.
 * Exclusions id + salary (OR sur max/min) appliquées ensuite / via .or.
 */
function applySupabaseDeckFilters(query, filters) {
  let q = query.or('statut.eq.active,statut.is.null');

  if (filters.contract_types.length) {
    q = q.in('contract_type', filters.contract_types);
  }
  if (filters.remote_modes.length) {
    q = q.in('remote_mode', filters.remote_modes);
  }
  if (filters.tags.length) {
    // OR dans la famille tags : overlap array
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
  if (filters.salary_fixed_min != null) {
    const x = filters.salary_fixed_min;
    q = q.or(`salary_fixed_max.gte.${x},and(salary_fixed_max.is.null,salary_fixed_min.gte.${x})`);
  }
  return q;
}

/**
 * Keyset PostgREST — deux phases explicites (pas de created_at < NULL).
 * Phase dated : created_at < c OR (created_at = c AND id < i) OR created_at IS NULL
 * Phase null  : created_at IS NULL AND id < i
 */
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
  parseOfferDeckQuery,
  encodeCursor,
  decodeCursor,
  offerMatchesSalaryMin,
  offerMatchesDeckFilters,
  compareOffersNewestFirst,
  isAfterCursor,
  paginateOfferDeck,
  applySupabaseDeckFilters,
  applySupabaseCursor,
};

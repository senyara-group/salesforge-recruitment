/**
 * Parsing / validation / pagination du deck recruteur GET /candidats/deck (PR D).
 * Filtrage métier serveur ; keyset score_adn ; hors scope deep_adn_* / bilans / IA CV.
 */

const { CONTRACT_TYPES, normalizeToken } = require('./filterTaxonomies');

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_MULTI = 12;
const MAX_TEXT = 80;
const MIN_SCORE = 0;
const MAX_SCORE = 100;
const MIN_YEARS = 0;
const MAX_YEARS = 80;
const SKILLS_FILL_BATCH_FACTOR = 3;
const SKILLS_FILL_MAX_ROUNDS = 6;
const MAX_CURSOR_LENGTH = 256;
const MAX_MATCHING_LENGTH = 2048;
const MAX_MATCHING_KEYS = 7;
const MATCHING_KEYS = Object.freeze(['closing', 'cycle', 'saas', 'resilience', 'salestech', 'outbound', 'drive']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function httpError(message, code, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function splitCsv(raw) {
  if (raw == null || raw === '') return [];
  return [...new Set(String(raw)
    .split(',')
    .map((part) => normalizeToken(part))
    .filter(Boolean))];
}

function parseLimit(raw) {
  if (raw == null || raw === '') return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw httpError('limit invalide', 'CANDIDATE_DECK_LIMIT_INVALID');
  }
  if (n > MAX_LIMIT) {
    throw httpError(`limit max ${MAX_LIMIT}`, 'CANDIDATE_DECK_LIMIT_MAX');
  }
  return n;
}

function parseIntBound(raw, { label, min, max, code }) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    throw httpError(`${label} invalide`, code);
  }
  return n;
}

function parseBoundedList(raw, { label, max = MAX_MULTI, maxLen = MAX_TEXT, allowed = null }) {
  const values = splitCsv(raw);
  if (values.length > max) {
    throw httpError(`${label}: trop de valeurs (max ${max})`, 'CANDIDATE_DECK_MULTI_MAX');
  }
  for (const value of values) {
    if (value.length > maxLen) {
      throw httpError(`${label}: valeur trop longue`, 'CANDIDATE_DECK_VALUE_TOO_LONG');
    }
    if (allowed && !allowed.includes(value)) {
      throw httpError(`${label} invalide: ${value}`, 'CANDIDATE_DECK_VALUE_INVALID');
    }
  }
  return values;
}

/**
 * Cursor opaque base64url.
 * Format : { p: 's'|'n', s: score_adn|null, i: id }
 * Tri : score_adn DESC NULLS LAST, id DESC.
 */
function encodeCursor(row) {
  if (!row?.id) return null;
  const scored = row.score_adn != null && row.score_adn !== '';
  return Buffer.from(JSON.stringify({
    p: scored ? 's' : 'n',
    s: scored ? Number(row.score_adn) : null,
    i: String(row.id),
  }), 'utf8').toString('base64url');
}

function decodeCursor(raw) {
  if (raw == null || raw === '') return null;
  try {
    if (typeof raw !== 'string' || raw.length > MAX_CURSOR_LENGTH) throw new Error('invalid length');
    const parsed = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || !['s', 'n'].includes(parsed.p)) throw new Error('invalid phase');
    if (typeof parsed.i !== 'string' || !UUID_PATTERN.test(parsed.i)) throw new Error('invalid id');
    if (parsed.p === 's' && (!Number.isFinite(parsed.s) || parsed.s < MIN_SCORE || parsed.s > MAX_SCORE)) {
      throw new Error('invalid score');
    }
    if (parsed.p === 'n' && parsed.s !== null) throw new Error('invalid null phase');
    return {
      phase: parsed.p,
      score_adn: parsed.p === 's' ? Number(parsed.s) : null,
      id: String(parsed.i),
    };
  } catch {
    throw httpError('cursor invalide', 'CANDIDATE_DECK_CURSOR_INVALID');
  }
}

/**
 * matching : JSON opaque pour compatibilityScore (display-only).
 * skills = param moderne ; competences = alias historique (OR exact flat).
 */
function parseCandidateDeckQuery(query = {}) {
  let matching = {};
  if (query.matching != null && query.matching !== '') {
    try {
      if (typeof query.matching === 'string' && query.matching.length > MAX_MATCHING_LENGTH) throw new Error('too large');
      matching = typeof query.matching === 'string' ? JSON.parse(query.matching) : query.matching;
      if (!matching || typeof matching !== 'object' || Array.isArray(matching)) {
        throw new Error('invalid');
      }
      const entries = Object.entries(matching);
      if (entries.length > MAX_MATCHING_KEYS) throw new Error('too many keys');
      for (const [key, value] of entries) {
        if (!MATCHING_KEYS.includes(key) || !Number.isFinite(value) || value < 0 || value > 100) {
          throw new Error('invalid matching criterion');
        }
      }
    } catch {
      throw httpError('matching invalide', 'CANDIDATE_DECK_MATCHING_INVALID');
    }
  }

  const skillsRaw = query.skills != null && query.skills !== ''
    ? query.skills
    : query.competences;
  const skills = parseBoundedList(skillsRaw, { label: 'skills', maxLen: 60 });

  return {
    limit: parseLimit(query.limit),
    cursor: decodeCursor(query.cursor),
    matching,
    score_adn_min: parseIntBound(query.score_adn_min, {
      label: 'score_adn_min', min: MIN_SCORE, max: MAX_SCORE, code: 'CANDIDATE_DECK_SCORE_INVALID',
    }),
    target_job_types: parseBoundedList(query.target_job_types, { label: 'target_job_types' }),
    sales_styles: parseBoundedList(query.sales_style, { label: 'sales_style', max: 6 }),
    years_experience_min: parseIntBound(query.years_experience_min, {
      label: 'years_experience_min', min: MIN_YEARS, max: MAX_YEARS, code: 'CANDIDATE_DECK_YEARS_INVALID',
    }),
    desired_contracts: parseBoundedList(query.desired_contracts, {
      label: 'desired_contracts',
      allowed: [...CONTRACT_TYPES],
    }),
    sectors: parseBoundedList(query.sectors, { label: 'sectors' }),
    skills,
    tools: parseBoundedList(query.tools, { label: 'tools' }),
    methodologies: parseBoundedList(query.methodologies, { label: 'methodologies' }),
    availabilities: parseBoundedList(query.availability, { label: 'availability', max: 6 }),
    customer_types: parseBoundedList(query.customer_types, { label: 'customer_types' }),
  };
}

/** Flat exact OR — comportement historique. */
function flattenCompetences(metaCompetences) {
  if (!metaCompetences || typeof metaCompetences !== 'object') return [];
  return Object.values(metaCompetences).flat().map(String);
}

function candidateMatchesSkills(candidate, skills) {
  if (!skills?.length) return true;
  const flat = flattenCompetences(candidate.axes?.meta?.competences);
  return skills.some((skill) => flat.includes(skill));
}

function arrayOverlaps(candidateValues, selected) {
  if (!selected?.length) return true;
  if (!Array.isArray(candidateValues) || !candidateValues.length) return false;
  const pool = new Set(candidateValues.map(String));
  return selected.some((value) => pool.has(String(value)));
}

function candidateMatchesDeckFilters(candidate, filters) {
  if (filters.score_adn_min != null) {
    if (candidate.score_adn == null) return false;
    if (Number(candidate.score_adn) < filters.score_adn_min) return false;
  }
  if (filters.target_job_types.length && !arrayOverlaps(candidate.target_job_types, filters.target_job_types)) {
    return false;
  }
  if (filters.sales_styles.length) {
    if (candidate.sales_style == null || candidate.sales_style === '') return false;
    if (!filters.sales_styles.includes(String(candidate.sales_style))) return false;
  }
  if (filters.years_experience_min != null) {
    if (candidate.years_experience == null) return false;
    if (Number(candidate.years_experience) < filters.years_experience_min) return false;
  }
  if (filters.desired_contracts.length && !arrayOverlaps(candidate.desired_contracts, filters.desired_contracts)) {
    return false;
  }
  if (filters.sectors.length && !arrayOverlaps(candidate.sectors, filters.sectors)) {
    return false;
  }
  if (!candidateMatchesSkills(candidate, filters.skills)) return false;
  if (filters.tools.length && !arrayOverlaps(candidate.tools, filters.tools)) return false;
  if (filters.methodologies.length && !arrayOverlaps(candidate.methodologies, filters.methodologies)) {
    return false;
  }
  if (filters.availabilities.length) {
    if (candidate.availability == null || candidate.availability === '') return false;
    if (!filters.availabilities.includes(String(candidate.availability))) return false;
  }
  if (filters.customer_types.length && !arrayOverlaps(candidate.customer_types, filters.customer_types)) {
    return false;
  }
  return true;
}

function compareCandidatesByScore(a, b) {
  const as = a.score_adn != null && a.score_adn !== '' ? Number(a.score_adn) : null;
  const bs = b.score_adn != null && b.score_adn !== '' ? Number(b.score_adn) : null;
  if (as != null && bs != null && as !== bs) return bs - as;
  if (as != null && bs == null) return -1;
  if (as == null && bs != null) return 1;
  return String(b.id).localeCompare(String(a.id));
}

function isAfterScoreCursor(row, cursor) {
  if (!cursor) return true;
  const rowScore = row.score_adn != null && row.score_adn !== '' ? Number(row.score_adn) : null;
  if (cursor.phase === 's' || (cursor.phase == null && cursor.score_adn != null)) {
    if (rowScore != null) {
      if (rowScore < cursor.score_adn) return true;
      if (rowScore > cursor.score_adn) return false;
      return String(row.id) < String(cursor.id);
    }
    return true;
  }
  if (rowScore != null) return false;
  return String(row.id) < String(cursor.id);
}

function paginateCandidateDeck(rows, filters, { seenIds = [], excludeUserId = null } = {}) {
  const seen = new Set(seenIds.map(String));
  const filtered = rows
    .filter((row) => {
      if (excludeUserId && String(row.user_id) === String(excludeUserId)) return false;
      if (seen.has(String(row.id)) || seen.has(String(row.user_id))) return false;
      return candidateMatchesDeckFilters(row, filters);
    })
    .sort(compareCandidatesByScore)
    .filter((row) => isAfterScoreCursor(row, filters.cursor));

  const page = filtered.slice(0, filters.limit);
  const hasMore = filtered.length > filters.limit;
  const last = page[page.length - 1];
  return {
    candidates: page,
    next_cursor: hasMore && last ? encodeCursor(last) : null,
    has_more: hasMore,
  };
}

function applySupabaseCandidateDeckFilters(query, filters) {
  let q = query;
  if (filters.score_adn_min != null) {
    q = q.gte('score_adn', filters.score_adn_min);
  }
  if (filters.target_job_types.length) {
    q = q.overlaps('target_job_types', filters.target_job_types);
  }
  if (filters.sales_styles.length) {
    q = q.in('sales_style', filters.sales_styles);
  }
  if (filters.years_experience_min != null) {
    q = q.gte('years_experience', filters.years_experience_min);
  }
  if (filters.desired_contracts.length) {
    q = q.overlaps('desired_contracts', filters.desired_contracts);
  }
  if (filters.sectors.length) {
    q = q.overlaps('sectors', filters.sectors);
  }
  if (filters.tools.length) {
    q = q.overlaps('tools', filters.tools);
  }
  if (filters.methodologies.length) {
    q = q.overlaps('methodologies', filters.methodologies);
  }
  if (filters.availabilities.length) {
    q = q.in('availability', filters.availabilities);
  }
  if (filters.customer_types.length) {
    q = q.overlaps('customer_types', filters.customer_types);
  }
  return q;
}

function applySupabaseScoreCursor(query, cursor) {
  if (!cursor) return query;
  if (cursor.phase === 'n' || cursor.score_adn == null) {
    return query.is('score_adn', null).lt('id', cursor.id);
  }
  const score = cursor.score_adn;
  const id = cursor.id;
  return query.or(
    `score_adn.lt.${score},and(score_adn.eq.${score},id.lt.${id}),score_adn.is.null`,
  );
}

function cursorFromRow(row) {
  return {
    phase: row.score_adn != null && row.score_adn !== '' ? 's' : 'n',
    score_adn: row.score_adn != null && row.score_adn !== '' ? Number(row.score_adn) : null,
    id: String(row.id),
  };
}

/**
 * Scan borné d'une page skills. Le curseur pointe toujours vers la dernière
 * ligne réellement inspectée. Le scan s'arrête au `limit`e match : aucune ligne
 * non inspectée (et donc aucun match non retourné) ne peut être sautée.
 */
async function fetchCandidateDeckRows(filters, {
  fetchBatch,
  seenIds = [],
  excludeUserId = null,
} = {}) {
  if (typeof fetchBatch !== 'function') throw new TypeError('fetchBatch requis');
  const collected = [];
  const seen = new Set(seenIds.map(String));
  const pageUserIds = new Set();
  const skillsActive = filters.skills.length > 0;
  const maxRounds = skillsActive ? SKILLS_FILL_MAX_ROUNDS : 1;
  let scanCursor = filters.cursor;
  let exhausted = false;
  let rounds = 0;

  while (collected.length < filters.limit && rounds < maxRounds && !exhausted) {
    rounds += 1;
    const remaining = filters.limit - collected.length;
    const batchSize = skillsActive
      ? Math.min(MAX_LIMIT, Math.max(remaining + 1, (remaining + 1) * SKILLS_FILL_BATCH_FACTOR))
      : remaining + 1;
    const rows = await fetchBatch(scanCursor, batchSize) || [];
    if (!rows.length) {
      exhausted = true;
      break;
    }

    let pageFilled = false;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      scanCursor = cursorFromRow(row);
      const duplicateUser = row.user_id && pageUserIds.has(String(row.user_id));
      const excluded = (excludeUserId && String(row.user_id) === String(excludeUserId))
        || seen.has(String(row.id))
        || seen.has(String(row.user_id));
      if (!excluded && !duplicateUser && candidateMatchesSkills(row, filters.skills)) {
        collected.push(row);
        if (row.user_id) pageUserIds.add(String(row.user_id));
      }
      if (collected.length >= filters.limit) {
        pageFilled = true;
        if (index === rows.length - 1 && rows.length < batchSize) exhausted = true;
        break;
      }
    }

    if (pageFilled) break;
    if (rows.length < batchSize) exhausted = true;
  }

  const hasMore = !exhausted && Boolean(scanCursor);
  return {
    page: collected,
    next_cursor: hasMore ? encodeCursor({ id: scanCursor.id, score_adn: scanCursor.score_adn }) : null,
    has_more: hasMore,
  };
}

module.exports = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  SKILLS_FILL_BATCH_FACTOR,
  SKILLS_FILL_MAX_ROUNDS,
  parseCandidateDeckQuery,
  encodeCursor,
  decodeCursor,
  flattenCompetences,
  candidateMatchesSkills,
  candidateMatchesDeckFilters,
  compareCandidatesByScore,
  isAfterScoreCursor,
  paginateCandidateDeck,
  applySupabaseCandidateDeckFilters,
  applySupabaseScoreCursor,
  fetchCandidateDeckRows,
  MATCHING_KEYS,
};

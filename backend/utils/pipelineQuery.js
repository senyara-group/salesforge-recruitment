/**
 * Pagination keyset du pipeline recruteur GET /recruteurs/pipeline.
 * Ordre : created_at DESC NULLS LAST, id DESC — stable, compatible affichage kanban.
 */

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_CURSOR_LENGTH = 256;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PIPELINE_STAGES = Object.freeze(['nouveau', 'vu', 'contacte', 'entretien', 'offre', 'termine']);

function httpError(message, code = 'PIPELINE_INVALID', status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function emptyPipelineStages() {
  return Object.fromEntries(PIPELINE_STAGES.map((key) => [key, []]));
}

function parseLimit(raw) {
  if (raw == null || raw === '') return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw httpError('limit invalide', 'PIPELINE_LIMIT_INVALID');
  if (n > MAX_LIMIT) throw httpError(`limit max ${MAX_LIMIT}`, 'PIPELINE_LIMIT_MAX');
  return n;
}

function encodeCursor(row) {
  if (!row?.id) return null;
  const createdAt = row.created_at || null;
  return Buffer.from(JSON.stringify({ c: createdAt, i: String(row.id) }), 'utf8').toString('base64url');
}

function decodeCursor(raw) {
  if (raw == null || raw === '') return null;
  const token = String(raw);
  if (token.length > MAX_CURSOR_LENGTH) throw httpError('cursor invalide', 'PIPELINE_CURSOR_INVALID');
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw httpError('cursor invalide', 'PIPELINE_CURSOR_INVALID');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw httpError('cursor invalide', 'PIPELINE_CURSOR_INVALID');
  }
  const id = String(parsed.i || '');
  if (!UUID_PATTERN.test(id)) throw httpError('cursor invalide', 'PIPELINE_CURSOR_INVALID');
  const createdAt = parsed.c == null || parsed.c === '' ? null : String(parsed.c);
  if (createdAt != null && Number.isNaN(Date.parse(createdAt))) {
    throw httpError('cursor invalide', 'PIPELINE_CURSOR_INVALID');
  }
  return { created_at: createdAt, id };
}

function parsePipelineQuery(query = {}) {
  return {
    limit: parseLimit(query.limit),
    cursor: decodeCursor(query.cursor),
  };
}

function isAfterPipelineCursor(row, cursor) {
  if (!cursor) return true;
  const rowTime = row.created_at != null && row.created_at !== ''
    ? new Date(row.created_at).getTime()
    : null;
  const cursorTime = cursor.created_at != null
    ? new Date(cursor.created_at).getTime()
    : null;

  if (cursorTime != null) {
    if (rowTime != null) {
      if (rowTime < cursorTime) return true;
      if (rowTime > cursorTime) return false;
      return String(row.id) < String(cursor.id);
    }
    return true; // NULL created_at après les datés
  }
  if (rowTime != null) return false;
  return String(row.id) < String(cursor.id);
}

function comparePipelineNewestFirst(a, b) {
  const aTime = a.created_at != null ? new Date(a.created_at).getTime() : null;
  const bTime = b.created_at != null ? new Date(b.created_at).getTime() : null;
  if (aTime != null && bTime != null && aTime !== bTime) return bTime - aTime;
  if (aTime != null && bTime == null) return -1;
  if (aTime == null && bTime != null) return 1;
  return String(b.id).localeCompare(String(a.id));
}

function stageForStatut(status) {
  const value = status || 'envoyee';
  if (['envoyee', 'nouveau'].includes(value)) return 'nouveau';
  if (value === 'vu') return 'vu';
  if (['contacte', 'repondu'].includes(value)) return 'contacte';
  if (value === 'entretien') return 'entretien';
  if (value === 'offre') return 'offre';
  return 'termine';
}

/**
 * Applique keyset PostgREST : created_at < c OR (created_at = c AND id < i) OR created_at IS NULL
 * lorsque le cursor a une date ; sinon uniquement NULL avec id < i.
 */
function applySupabasePipelineCursor(query, cursor) {
  if (!cursor) return query;
  const id = cursor.id;
  if (cursor.created_at) {
    const c = cursor.created_at;
    return query.or(
      `created_at.lt.${c},and(created_at.eq.${c},id.lt.${id}),created_at.is.null`
    );
  }
  return query.is('created_at', null).lt('id', id);
}

/**
 * Déduplique les signed URLs CV par bucket:path.
 * mutateRows: callback (row, signedUrl) => void
 */
async function attachDedupedCvSignedUrls(rows, createSignedUrl) {
  const groups = new Map();
  for (const row of rows || []) {
    const cv = row?.snapshot?.cv;
    if (!cv?.path) continue;
    const bucket = cv.bucket || 'candidate-cvs';
    const key = `${bucket}\0${cv.path}`;
    if (!groups.has(key)) groups.set(key, { bucket, path: cv.path, rows: [] });
    groups.get(key).rows.push(row);
  }
  await Promise.all([...groups.values()].map(async (group) => {
    const signedUrl = await createSignedUrl(group.bucket, group.path);
    if (!signedUrl) return;
    group.rows.forEach((row) => {
      if (row.snapshot?.cv) row.snapshot.cv.url = signedUrl;
    });
  }));
  return groups.size;
}

module.exports = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  PIPELINE_STAGES,
  emptyPipelineStages,
  parsePipelineQuery,
  encodeCursor,
  decodeCursor,
  isAfterPipelineCursor,
  comparePipelineNewestFirst,
  stageForStatut,
  applySupabasePipelineCursor,
  attachDedupedCvSignedUrls,
};

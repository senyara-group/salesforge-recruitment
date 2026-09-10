const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  parsePipelineQuery,
  encodeCursor,
  decodeCursor,
  isAfterPipelineCursor,
  comparePipelineNewestFirst,
  stageForStatut,
  emptyPipelineStages,
  attachDedupedCvSignedUrls,
  DEFAULT_LIMIT,
  MAX_LIMIT,
} = require('../utils/pipelineQuery');

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('pipeline parse limit / cursor', () => {
  assert.equal(parsePipelineQuery({}).limit, DEFAULT_LIMIT);
  assert.equal(parsePipelineQuery({ limit: '10' }).limit, 10);
  assert.throws(() => parsePipelineQuery({ limit: '0' }), /limit invalide/);
  assert.throws(() => parsePipelineQuery({ limit: String(MAX_LIMIT + 1) }), /limit max/);
  assert.throws(() => decodeCursor('%%%'), /cursor invalide/);
  const row = { id: uuid(1), created_at: '2026-09-01T10:00:00.000Z' };
  const token = encodeCursor(row);
  assert.deepEqual(decodeCursor(token), { created_at: row.created_at, id: row.id });
});

test('pipeline keyset : ordre created_at DESC puis id, pages suivantes', () => {
  const rows = [
    { id: uuid(3), created_at: '2026-09-03T00:00:00.000Z', statut: 'envoyee' },
    { id: uuid(2), created_at: '2026-09-02T00:00:00.000Z', statut: 'vu' },
    { id: uuid(1), created_at: '2026-09-01T00:00:00.000Z', statut: 'entretien' },
  ].sort(comparePipelineNewestFirst);

  assert.deepEqual(rows.map((r) => r.id), [uuid(3), uuid(2), uuid(1)]);
  const cursor = { created_at: rows[0].created_at, id: rows[0].id };
  const page2 = rows.filter((row) => isAfterPipelineCursor(row, cursor));
  assert.deepEqual(page2.map((r) => r.id), [uuid(2), uuid(1)]);
});

test('pipeline stages mapping legacy préservé', () => {
  assert.equal(stageForStatut('envoyee'), 'nouveau');
  assert.equal(stageForStatut('nouveau'), 'nouveau');
  assert.equal(stageForStatut('vu'), 'vu');
  assert.equal(stageForStatut('contacte'), 'contacte');
  assert.equal(stageForStatut('repondu'), 'contacte');
  assert.equal(stageForStatut('entretien'), 'entretien');
  assert.equal(stageForStatut('offre'), 'offre');
  assert.equal(stageForStatut('refusee'), 'termine');
  assert.deepEqual(emptyPipelineStages().nouveau, []);
});

test('signed URL CV dédupliquées par bucket:path', async () => {
  const calls = [];
  const rows = [
    { snapshot: { cv: { path: 'a/cv.pdf', bucket: 'candidate-cvs' } } },
    { snapshot: { cv: { path: 'a/cv.pdf', bucket: 'candidate-cvs' } } },
    { snapshot: { cv: { path: 'b/cv.pdf', bucket: 'candidate-cvs' } } },
    { snapshot: { cv: null } },
  ];
  const unique = await attachDedupedCvSignedUrls(rows, async (bucket, storagePath) => {
    calls.push(`${bucket}:${storagePath}`);
    return `https://signed/${storagePath}`;
  });
  assert.equal(unique, 2);
  assert.deepEqual(calls.sort(), ['candidate-cvs:a/cv.pdf', 'candidate-cvs:b/cv.pdf'].sort());
  assert.equal(rows[0].snapshot.cv.url, 'https://signed/a/cv.pdf');
  assert.equal(rows[1].snapshot.cv.url, 'https://signed/a/cv.pdf');
  assert.equal(rows[2].snapshot.cv.url, 'https://signed/b/cv.pdf');
});

test('route pipeline : pagination + signed URL dedup + pas de Promise.all front fatal', () => {
  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'recruteurs.js'), 'utf8');
  const start = route.indexOf("router.get('/pipeline'");
  const end = route.indexOf("router.post('/pipeline/contact'", start);
  const block = route.slice(start, end);
  assert.match(block, /parsePipelineQuery/);
  assert.match(block, /applySupabasePipelineCursor/);
  assert.match(block, /attachDedupedCvSignedUrls/);
  assert.match(block, /next_cursor/);
  assert.match(block, /has_more/);
  assert.match(block, /limit \+ 1/);
  assert.doesNotMatch(block, /Promise\.all\(\(data \|\| \[\]\)\.map\(async \(candidature\)/);

  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', '_spaces', 'recruteur.html'), 'utf8');
  assert.match(html, /loadMorePipeline/);
  assert.match(html, /PIPELINE_HAS_MORE/);
  assert.match(html, /fetchPipelinePage/);
  assert.match(html, /Impossible de charger le pipeline/);
  assert.match(html, /Impossible de charger vos offres/);
  assert.match(html, /po-card/);
  assert.match(html, /pipe-state/);
  assert.match(html, /pipeline-end/);
  assert.match(html, /function renderPipelineOffers/);
  // Plus de Promise.all qui couple pipeline + offres
  const loadStart = html.indexOf('async function loadPipeline');
  const loadEnd = html.indexOf('async function loadMorePipeline', loadStart);
  const loadBlock = html.slice(loadStart, loadEnd);
  assert.doesNotMatch(loadBlock, /Promise\.all\(\[\s*api\('GET', '\/recruteurs\/pipeline'/);
  assert.match(loadBlock, /offersError/);
  assert.match(loadBlock, /pipelineError/);
});

test('migration tracking : RLS + revoke anon/authenticated, pas de grant public', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'marketing_automation_tracking_migration.sql'), 'utf8');
  assert.match(sql, /create table if not exists public\.candidat_likes/);
  assert.match(sql, /unique \(candidat_id, recruteur_id\)/);
  assert.match(sql, /create table if not exists public\.candidat_profile_views/);
  assert.match(sql, /last_login_at/);
  assert.match(sql, /alter table public\.candidat_likes enable row level security/);
  assert.match(sql, /alter table public\.candidat_profile_views enable row level security/);
  assert.match(sql, /revoke all on table public\.candidat_likes from anon,\s*authenticated/i);
  assert.match(sql, /revoke all on table public\.candidat_profile_views from anon,\s*authenticated/i);
  assert.doesNotMatch(sql, /grant\s+(select|insert|update|delete|all)\b[^;]*\bon\s+(table\s+)?public\.candidat_likes\b[^;]*\b(to\s+)?(anon|authenticated)/i);
  assert.doesNotMatch(sql, /grant\s+(select|insert|update|delete|all)\b[^;]*\bon\s+(table\s+)?public\.candidat_profile_views\b[^;]*\b(to\s+)?(anon|authenticated)/i);
  assert.doesNotMatch(sql, /create policy/i);
  assert.doesNotMatch(sql, /revoke\s+all\b[^;]*\bfrom\s+service_role/i);
  assert.doesNotMatch(sql, /drop table|delete from/i);
  assert.doesNotMatch(sql, /drop column/i);

  const tracking = fs.readFileSync(path.join(__dirname, '..', 'utils', 'engagementTracking.js'), 'utf8');
  assert.match(tracking, /onConflict: 'candidat_id,recruteur_id'/);
  assert.match(tracking, /marketing_automation_tracking_migration\.sql/);
  assert.match(tracking, /require\('\.\.\/supabase'\)/);
  const supabaseClient = fs.readFileSync(path.join(__dirname, '..', 'supabase.js'), 'utf8');
  assert.match(supabaseClient, /SUPABASE_SERVICE_KEY/);
});

test('pipeline race : loadMore stale ignoré après refresh (gen + AbortController)', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', '_spaces', 'recruteur.html'), 'utf8');
  assert.match(html, /let PIPELINE_LOAD_GEN = 0/);
  assert.match(html, /let PIPELINE_ABORT = null/);
  assert.match(html, /AbortController/);

  const loadStart = html.indexOf('async function loadPipeline');
  const moreStart = html.indexOf('async function loadMorePipeline', loadStart);
  const moreEnd = html.indexOf('\nfunction renderPipeline', moreStart);
  const loadBlock = html.slice(loadStart, moreStart);
  const moreBlock = html.slice(moreStart, moreEnd);

  assert.match(loadBlock, /const gen = \+\+PIPELINE_LOAD_GEN/);
  assert.match(loadBlock, /PIPELINE_ABORT\.abort\(\)/);
  assert.match(loadBlock, /new AbortController/);
  assert.match(loadBlock, /if \(gen !== PIPELINE_LOAD_GEN\) return/);
  assert.match(loadBlock, /e\.name === 'AbortError'/);
  assert.match(loadBlock, /fetchPipelinePage\(null, \{ signal \}\)/);
  assert.doesNotMatch(loadBlock, /toast\([^\)]*AbortError/);

  assert.match(moreBlock, /const gen = PIPELINE_LOAD_GEN/);
  assert.match(moreBlock, /const cursor = PIPELINE_CURSOR/);
  assert.match(moreBlock, /await fetchPipelinePage\(cursor/);
  assert.match(moreBlock, /if \(gen !== PIPELINE_LOAD_GEN\) return/);
  assert.match(moreBlock, /e\.name === 'AbortError'/);
  assert.match(moreBlock, /if \(gen === PIPELINE_LOAD_GEN\) \{\s*PIPELINE_LOADING = false/s);
  const genGuardAt = moreBlock.search(/if \(gen !== PIPELINE_LOAD_GEN\) return/);
  const mergeAt = moreBlock.indexOf('mergePipelinePage(page)');
  assert.ok(genGuardAt >= 0 && mergeAt > genGuardAt, 'mergePipelinePage après garde génération');

  // Comportement A/B/C : loadMore en vol → refresh → réponse stale ignorée
  const stages = ['nouveau', 'vu', 'contacte', 'entretien', 'offre', 'termine'];
  const empty = () => Object.fromEntries(stages.map((k) => [k, []]));
  let PIPELINE = empty();
  let PIPELINE_CURSOR = 'cursor-old';
  let PIPELINE_HAS_MORE = true;
  let PIPELINE_LOADING = false;
  let PIPELINE_LOAD_GEN = 0;
  let uiFingerprint = 'initial';
  const merge = (page) => {
    const next = empty();
    stages.forEach((key) => {
      const prev = PIPELINE[key] || [];
      const incoming = (page && page[key]) || [];
      const seen = new Set(prev.map((c) => String(c.id)));
      next[key] = prev.concat(incoming.filter((c) => !seen.has(String(c.id))));
    });
    PIPELINE = next;
    PIPELINE_CURSOR = page?.next_cursor || null;
    PIPELINE_HAS_MORE = Boolean(page?.has_more && page?.next_cursor);
    uiFingerprint = 'merged:' + (PIPELINE.nouveau || []).map((c) => c.id).join(',');
  };

  PIPELINE.nouveau = [{ id: 'already' }];
  // A. loadMore démarre
  const moreGen = PIPELINE_LOAD_GEN;
  const moreCursor = PIPELINE_CURSOR;
  PIPELINE_LOADING = true;
  let moreResolve;
  const moreFetch = new Promise((resolve) => { moreResolve = resolve; });

  // B. refresh loadPipeline avant réponse
  const refreshGen = ++PIPELINE_LOAD_GEN;
  PIPELINE = empty();
  PIPELINE.nouveau = [{ id: 'fresh' }];
  PIPELINE_CURSOR = 'cursor-new';
  PIPELINE_HAS_MORE = true;
  PIPELINE_LOADING = true;
  uiFingerprint = 'refresh';

  // C. ancienne réponse revient
  const stalePage = {
    nouveau: [{ id: 'stale-from-old-page' }],
    next_cursor: 'cursor-stale',
    has_more: false,
  };
  moreResolve(stalePage);
  const page = await moreFetch;
  assert.equal(moreCursor, 'cursor-old');
  if (moreGen !== PIPELINE_LOAD_GEN) {
    // ignore completely
  } else {
    merge(page);
    PIPELINE_LOADING = false;
  }
  if (moreGen === PIPELINE_LOAD_GEN) {
    PIPELINE_LOADING = false;
  }

  assert.equal(refreshGen, 1);
  assert.equal(PIPELINE_LOAD_GEN, 1);
  assert.deepEqual((PIPELINE.nouveau || []).map((c) => c.id), ['fresh']);
  assert.equal(PIPELINE_CURSOR, 'cursor-new');
  assert.equal(PIPELINE_HAS_MORE, true);
  assert.equal(PIPELINE_LOADING, true);
  assert.equal(uiFingerprint, 'refresh');
  assert.equal(String(PIPELINE.nouveau.map((c) => c.id)).includes('stale'), false);
});

test('pipeline AbortError volontaire : silencieux, sans toast', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', '_spaces', 'recruteur.html'), 'utf8');
  const moreStart = html.indexOf('async function loadMorePipeline');
  const moreEnd = html.indexOf('\nfunction renderPipeline', moreStart);
  const moreBlock = html.slice(moreStart, moreEnd);
  const catchStart = moreBlock.indexOf('} catch (e)');
  const catchBlock = moreBlock.slice(catchStart, moreBlock.indexOf('} finally', catchStart));
  assert.match(catchBlock, /AbortError/);
  assert.match(catchBlock, /return/);
  assert.ok(catchBlock.indexOf('AbortError') < catchBlock.indexOf('toast'));
});

test('migration matchs unique : garde-fou doublons + diagnostic read-only', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'matchs_candidat_offre_unique_migration.sql'), 'utf8');
  assert.match(sql, /create unique index if not exists matchs_candidat_offre_unique/);
  assert.match(sql, /having count\(\*\) > 1/);
  assert.match(sql, /raise exception/);
  assert.doesNotMatch(sql, /delete from public\.matchs/i);

  const diag = fs.readFileSync(path.join(__dirname, '..', 'matchs_unique_diagnostic.sql'), 'utf8');
  assert.match(diag, /READ-ONLY|read-only|Diagnostic/i);
  assert.match(diag, /duplicate_groups/);
  assert.doesNotMatch(diag, /^\s*delete\s+from/im);
  assert.doesNotMatch(diag, /^\s*update\s+/im);

  const swipe = fs.readFileSync(path.join(__dirname, '..', 'routes', 'swipes.js'), 'utf8');
  const rec = fs.readFileSync(path.join(__dirname, '..', 'routes', 'recruteurs.js'), 'utf8');
  assert.match(swipe, /onConflict: 'candidat_id,offre_id'/);
  assert.match(rec, /onConflict: 'candidat_id,offre_id'/);
});

test('legacy pipeline : états vides et filtres lettre_type conservés', () => {
  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'recruteurs.js'), 'utf8');
  const start = route.indexOf("router.get('/pipeline'");
  const end = route.indexOf("router.post('/pipeline/contact'", start);
  const block = route.slice(start, end);
  assert.match(block, /lettre_type\.is\.null,lettre_type\.neq\.recruteur_like/);
  assert.match(block, /emptyPipelineStages/);
  assert.match(block, /if \(!offreIds\.length\) return res\.json\(empty\)/);
});

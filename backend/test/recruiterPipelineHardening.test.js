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

test('migration candidat_likes : contrat upsert engagement', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'marketing_automation_tracking_migration.sql'), 'utf8');
  assert.match(sql, /create table if not exists public\.candidat_likes/);
  assert.match(sql, /unique \(candidat_id, recruteur_id\)/);
  assert.match(sql, /create table if not exists public\.candidat_profile_views/);
  assert.match(sql, /last_login_at/);
  assert.doesNotMatch(sql, /drop table|delete from/i);

  const tracking = fs.readFileSync(path.join(__dirname, '..', 'utils', 'engagementTracking.js'), 'utf8');
  assert.match(tracking, /onConflict: 'candidat_id,recruteur_id'/);
  assert.match(tracking, /marketing_automation_tracking_migration\.sql/);
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

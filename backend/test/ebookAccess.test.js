const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EBOOK_ACCESS_LIMITS, ebookAccessForPlan, accessibleEbooks } = require('../utils/ebookAccess');

process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'test-service-key';

const catalog = Array.from({ length: 15 }, (_, index) => ({
  file: `ebook-${index + 1}.pdf`,
  titre: `Ebook ${index + 1}`,
  desc: `Description ${index + 1}`,
  categorie: 'Test',
}));

async function accessFor(plan) {
  const signed = [];
  const result = await accessibleEbooks(catalog, plan, async (file) => {
    signed.push(file);
    return { data: { signedUrl: `https://signed.invalid/${file}` } };
  });
  return { ...result, signed };
}

test('la matrice backend est exactement 3 / 8 / 15', () => {
  assert.deepEqual(EBOOK_ACCESS_LIMITS, { freemium: 3, carriere: 8, carriere_coaching: 15 });
  assert.equal(ebookAccessForPlan('freemium', 15).availableCount, 3);
  assert.equal(ebookAccessForPlan('carriere', 15).availableCount, 8);
  assert.equal(ebookAccessForPlan('carriere_coaching', 15).availableCount, 15);
});

test('un plan absent ou inconnu reçoit les droits Freemium', () => {
  assert.equal(ebookAccessForPlan(undefined, 15).plan, 'freemium');
  assert.equal(ebookAccessForPlan('premium_inconnu', 15).availableCount, 3);
});

test('le catalogue conserve son ordre et signe uniquement les ebooks autorisés', async () => {
  for (const [plan, expected] of Object.entries(EBOOK_ACCESS_LIMITS)) {
    const result = await accessFor(plan);
    assert.equal(result.ressources.length, expected);
    assert.deepEqual(result.ressources.map((ebook) => ebook.id), Array.from({ length: expected }, (_, index) => index));
    assert.deepEqual(result.signed, catalog.slice(0, expected).map((ebook) => ebook.file));
  }
});

test('un ID ou paramètre client ne peut pas élargir le catalogue autorisé', async () => {
  const result = await accessibleEbooks(catalog, 'freemium', async (file) => ({ data: { signedUrl: file } }), {
    ebook_id: 14, limit: 15,
  });
  assert.equal(result.ressources.length, 3);
  assert.ok(result.ressources.every((ebook) => ebook.id < 3));
});

test('une erreur de signature ne signe ni ne révèle les ebooks hors droits', async () => {
  const attempted = [];
  await assert.rejects(() => accessibleEbooks(catalog, 'freemium', async (file) => {
    attempted.push(file);
    throw new Error('signature indisponible');
  }), /signature indisponible/);
  assert.ok(attempted.length <= 3);
  assert.ok(attempted.every((file) => catalog.slice(0, 3).some((ebook) => ebook.file === file)));
});

test('la route reste authentifiée et ne propose aucun accès par ID', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'candidats.js'), 'utf8');
  assert.match(source, /router\.get\('\/ressources', authMiddleware,/);
  assert.doesNotMatch(source, /router\.(?:get|post)\('\/ressources\/:/);
  assert.match(source, /const plan = await getCandidatePlan\(req\.user\.id\)/);
});

test('un appel anonyme à la route ressources est refusé en 401', async () => {
  const router = require('../routes/candidats');
  const layer = router.stack.find((item) => item.route?.path === '/ressources' && item.route.methods.get);
  assert.ok(layer);
  const auth = layer.route.stack[0].handle;
  let statusCode;
  let payload;
  let nextCalled = false;
  await auth({ headers: {} }, {
    status(code) { statusCode = code; return this; },
    json(body) { payload = body; return this; },
  }, () => { nextCalled = true; });
  assert.equal(statusCode, 401);
  assert.equal(nextCalled, false);
  assert.equal(payload.code, 'TOKEN_MISSING');
});

test('le frontend consomme les compteurs backend et reste compatible avec 3 / 8 / 15', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', '_spaces', 'candidat.html'), 'utf8');
  assert.match(source, /result\.available_count/);
  assert.match(source, /result\.total_count/);
  assert.match(source, /3 ebooks commerciaux/);
  assert.match(source, /8 ebooks commerciaux/);
  assert.match(source, /Bibliothèque complète : 15 ebooks/);
});

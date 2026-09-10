const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  CONTRIBUTING_MATCHING_KEYS,
  LEGACY_IGNORED_MATCHING_KEYS,
  hasContributingMatching,
  compatibilityScore,
  sanitizeMatchingWeight,
  clampAxisValue,
} = require('../utils/recruiterMatching');

test('matching fantôme : cycle, saas et outbound n’influencent jamais le score', () => {
  const axes = { closing: 82, resilience: 64, salestech: 71, drive: 90, ecoute: 76 };
  const baseline = compatibilityScore(axes, { closing: 70 });
  for (const key of LEGACY_IGNORED_MATCHING_KEYS) {
    assert.equal(compatibilityScore(axes, { closing: 70, [key]: 100 }), baseline);
    assert.equal(compatibilityScore(axes, { [key]: 100 }), 82);
  }
});

test('matching réel : chaque axe court contribue au score', () => {
  for (const key of CONTRIBUTING_MATCHING_KEYS) {
    assert.equal(compatibilityScore({ [key]: 91 }, { [key]: 100 }), 91, key);
  }
  assert.equal(compatibilityScore({ 'Écoute': 88 }, { ecoute: 100 }), 88);
});

test('matching ignore un axe réel absent au lieu d’inventer une constante 50', () => {
  assert.equal(compatibilityScore({ closing: 90 }, { closing: 50, resilience: 100 }), 90);
  assert.notEqual(
    compatibilityScore({ closing: 90 }, { closing: 50, cycle: 100, saas: 100, outbound: 100 }),
    55
  );
});

test('matching vide ou legacy seul ne devient pas un filtre d’exclusion', () => {
  assert.equal(hasContributingMatching({}), false);
  assert.equal(hasContributingMatching({ cycle: 100, saas: 50, outbound: 75 }), false);
  assert.equal(hasContributingMatching({ closing: 0, drive: 0 }), false);
  assert.equal(hasContributingMatching({ ecoute: 1 }), true);
  assert.equal(hasContributingMatching({ closing: Number.POSITIVE_INFINITY }), false);
  assert.equal(hasContributingMatching({ closing: Number.NaN }), false);
  assert.equal(hasContributingMatching({ closing: 1e309 }), false);
  assert.equal(hasContributingMatching({ closing: -1 }), false);
  assert.equal(hasContributingMatching({ closing: 101 }), false);
});

test('matching : clamp axes et ignore poids invalides ; score toujours fini 0–100', () => {
  assert.equal(clampAxisValue(-20), 0);
  assert.equal(clampAxisValue(200), 100);
  assert.equal(sanitizeMatchingWeight(-1), null);
  assert.equal(sanitizeMatchingWeight(101), null);
  assert.equal(sanitizeMatchingWeight(Number.POSITIVE_INFINITY), null);
  assert.equal(sanitizeMatchingWeight(Number.NaN), null);
  assert.equal(sanitizeMatchingWeight(1e309), null);

  // Axe négatif → contribution comme 0
  assert.equal(compatibilityScore({ closing: -20 }, { closing: 100 }), 0);
  // Axe >100 → contribution comme 100
  assert.equal(compatibilityScore({ closing: 200 }, { closing: 100 }), 100);

  // Poids invalides ignorés → même résultat que sans eux
  const realOnly = compatibilityScore({ closing: 80, drive: 60 }, { closing: 50 });
  assert.equal(
    compatibilityScore({ closing: 80, drive: 60 }, {
      closing: 50,
      drive: -1,
      resilience: 101,
      salestech: Number.POSITIVE_INFINITY,
      ecoute: Number.NaN,
      cycle: 1e309,
    }),
    realOnly
  );

  // Fantômes seuls inertes vs réel + fantôme
  const withGhosts = compatibilityScore(
    { closing: 80 },
    { closing: 40, cycle: 100, saas: 100, outbound: 100, drive: 1e309 }
  );
  assert.equal(withGhosts, compatibilityScore({ closing: 80 }, { closing: 40 }));

  const samples = [
    compatibilityScore({ closing: -20 }, { closing: 100 }),
    compatibilityScore({ closing: 200 }, { closing: 100 }),
    compatibilityScore({}, { closing: 1e309, cycle: 50 }),
    compatibilityScore({ closing: 50 }, { closing: Number.NaN, drive: Number.POSITIVE_INFINITY }),
  ];
  for (const score of samples) {
    assert.equal(Number.isFinite(score), true);
    assert.ok(score >= 0 && score <= 100);
  }
});

test('matching recruteur reste isolé du deep ADN', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'utils', 'recruiterMatching.js'), 'utf8');
  assert.doesNotMatch(source, /deep[_ -]?adn|bilan|assessment/i);
});

test('parité deck / matching-count : même module compatibilityScore', () => {
  const deck = fs.readFileSync(path.join(__dirname, '..', 'routes', 'candidats.js'), 'utf8');
  const rec = fs.readFileSync(path.join(__dirname, '..', 'routes', 'recruteurs.js'), 'utf8');
  assert.match(deck, /require\('\.\.\/utils\/recruiterMatching'\)/);
  assert.match(rec, /require\('\.\.\/utils\/recruiterMatching'\)/);
  assert.match(rec, /compatibilityScore\(axes, matching\)/);
  assert.match(deck, /compatibilityScore\(/);
});

const recruiterHtml = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', '_spaces', 'recruteur.html'), 'utf8');

function loadDoSwipe(overrides = {}) {
  const start = recruiterHtml.indexOf('async function doSwipe');
  const end = recruiterHtml.indexOf('function swipe(', start);
  const context = {
    SWIPE_IN_FLIGHT: new Set(),
    rememberSeenCandidate() {},
    api: async () => ({}),
    showMatch() {},
    toast() {},
    console: { error() {}, warn() {} },
    ...overrides,
  };
  vm.runInNewContext(`${recruiterHtml.slice(start, end)}\nglobalThis.doSwipeUnderTest = doSwipe;`, context);
  return context;
}

test('swipe succès API : seen après succès uniquement', async () => {
  const events = [];
  const context = loadDoSwipe({
    api: async () => { events.push('api'); return { match: false }; },
    rememberSeenCandidate: () => events.push('seen'),
  });
  assert.equal(await context.doSwipeUnderTest('pass', { id: 'cand-1' }), true);
  assert.deepEqual(events, ['api', 'seen']);
});

test('swipe échec API : pas seen et feedback utilisateur', async () => {
  let seen = 0;
  const messages = [];
  const context = loadDoSwipe({
    api: async () => { throw new Error('network'); },
    rememberSeenCandidate: () => { seen += 1; },
    toast: (message) => messages.push(message),
  });
  assert.equal(await context.doSwipeUnderTest('like', { id: 'cand-2' }), false);
  assert.equal(seen, 0);
  assert.deepEqual(messages, ['Action non enregistrée. Réessayez.']);
  assert.equal(context.SWIPE_IN_FLIGHT.size, 0);
});

test('swipe double clic : une seule requête en cours et aucun doublon seen', async () => {
  let release;
  let calls = 0;
  let seen = 0;
  const pending = new Promise((resolve) => { release = resolve; });
  const context = loadDoSwipe({
    api: async () => { calls += 1; await pending; return { match: false }; },
    rememberSeenCandidate: () => { seen += 1; },
  });
  const first = context.doSwipeUnderTest('like', { id: 'cand-3' });
  const second = context.doSwipeUnderTest('like', { id: 'cand-3' });
  assert.equal(await second, false);
  assert.equal(calls, 1);
  release();
  assert.equal(await first, true);
  assert.equal(seen, 1);
});

test('A: API succès + localStorage throw → succès métier, une seule API', async () => {
  let calls = 0;
  const warns = [];
  const context = loadDoSwipe({
    api: async () => { calls += 1; return { match: false }; },
    rememberSeenCandidate: () => { throw new Error('QuotaExceededError'); },
    console: { error() {}, warn: (err) => warns.push(String(err && err.message || err)) },
  });
  assert.equal(await context.doSwipeUnderTest('pass', { id: 'cand-ls' }), true);
  assert.equal(calls, 1);
  assert.ok(warns.some((message) => /QuotaExceededError/.test(message)));
});

test('B: API succès + toast throw → succès métier conservé', async () => {
  let calls = 0;
  const context = loadDoSwipe({
    api: async () => { calls += 1; return { match: false, interest_recorded: true }; },
    toast: () => { throw new Error('toast boom'); },
    console: { error() {}, warn() {} },
  });
  assert.equal(await context.doSwipeUnderTest('like', { id: 'cand-toast' }), true);
  assert.equal(calls, 1);
});

test('C: API succès + showMatch throw → succès métier conservé', async () => {
  let calls = 0;
  const context = loadDoSwipe({
    api: async () => { calls += 1; return { match: true }; },
    showMatch: () => { throw new Error('dom boom'); },
    console: { error() {}, warn() {} },
  });
  assert.equal(await context.doSwipeUnderTest('like', { id: 'cand-match' }), true);
  assert.equal(calls, 1);
});

test('D: premier API échoue puis retry → seen seulement après succès', async () => {
  let calls = 0;
  let seen = 0;
  const context = loadDoSwipe({
    api: async () => {
      calls += 1;
      if (calls === 1) throw new Error('temp');
      return { match: false };
    },
    rememberSeenCandidate: () => { seen += 1; },
    toast() {},
  });
  assert.equal(await context.doSwipeUnderTest('pass', { id: 'cand-retry' }), false);
  assert.equal(seen, 0);
  assert.equal(await context.doSwipeUnderTest('pass', { id: 'cand-retry' }), true);
  assert.equal(calls, 2);
  assert.equal(seen, 1);
});

test('E: deck reload pendant promesse → ancienne action n’avance pas le nouveau deck', () => {
  const html = recruiterHtml;
  const flyStart = html.indexOf('async function fly(');
  const flyEnd = html.indexOf('function restoreSwipeCard', flyStart);
  const fly = html.slice(flyStart, flyEnd);
  assert.match(fly, /const generation = CAND_DECK_LOAD_GEN/);
  assert.match(fly, /if \(generation !== CAND_DECK_LOAD_GEN\) return/);
  assert.match(fly, /if \(!await doSwipe\(/);
});

test('swipe frontend : échec restaure la carte ; succès API hors catch UI', () => {
  const html = recruiterHtml;
  const start = html.indexOf('async function doSwipe');
  const end = html.indexOf('function swipe(', start);
  const block = html.slice(start, end);
  assert.ok(block.indexOf("await api('POST', '/recruteurs/swipe'") < block.indexOf('rememberSeenCandidate(cand)'));
  assert.match(block, /SWIPE_IN_FLIGHT\.has\(key\)/);
  assert.match(block, /SWIPE_IN_FLIGHT\.add\(key\)/);
  assert.match(block, /finally[\s\S]*SWIPE_IN_FLIGHT\.delete\(key\)/);
  assert.match(block, /toast\('Action non enregistrée\. Réessayez\.'\)/);
  assert.match(block, /console\.warn/);
  // rememberSeenCandidate / showMatch après le catch API, pas dedans
  const apiCatchEnd = block.indexOf('return false;');
  const seenAt = block.indexOf('rememberSeenCandidate(cand)');
  assert.ok(seenAt > apiCatchEnd);
  assert.match(html, /if \(!await doSwipe\('like',cand\)\) return restoreSwipeCard\(card\)/);
  assert.match(html, /function restoreSwipeCard[\s\S]*classList\.remove\('swiping'\)[\s\S]*style\.transform=''/);
});

test('UI matching n’expose que les cinq axes ADN courts réels', () => {
  const html = recruiterHtml;
  const start = html.indexOf('const MATCHING_CRITERIA');
  const end = html.indexOf('function renderMatching', start);
  const block = html.slice(start, end);
  for (const key of CONTRIBUTING_MATCHING_KEYS) assert.match(block, new RegExp(`key:'${key}'`));
  for (const key of LEGACY_IGNORED_MATCHING_KEYS) assert.doesNotMatch(block, new RegExp(`key:'${key}'`));
});

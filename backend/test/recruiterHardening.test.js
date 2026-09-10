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
});

test('matching recruteur reste isolé du deep ADN', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'utils', 'recruiterMatching.js'), 'utf8');
  assert.doesNotMatch(source, /deep[_ -]?adn|bilan|assessment/i);
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
    console: { error() {} },
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

test('swipe frontend : échec restaure la carte sans avancer le deck', () => {
  const html = recruiterHtml;
  const start = html.indexOf('async function doSwipe');
  const end = html.indexOf('function swipe(', start);
  const block = html.slice(start, end);
  assert.ok(block.indexOf("await api('POST', '/recruteurs/swipe'") < block.indexOf('rememberSeenCandidate(cand)'));
  assert.match(block, /SWIPE_IN_FLIGHT\.has\(key\)/);
  assert.match(block, /SWIPE_IN_FLIGHT\.add\(key\)/);
  assert.match(block, /finally[\s\S]*SWIPE_IN_FLIGHT\.delete\(key\)/);
  assert.match(block, /toast\('Action non enregistrée\. Réessayez\.'\)/);
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

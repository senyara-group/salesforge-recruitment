const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  parseCandidateDeckQuery,
  encodeCursor,
  decodeCursor,
  candidateMatchesDeckFilters,
  candidateMatchesSkills,
  paginateCandidateDeck,
  applySupabaseCandidateDeckFilters,
  applySupabaseScoreCursor,
  DEFAULT_LIMIT,
  MAX_LIMIT,
} = require('../utils/candidateDeckQuery');

function fakeQuery() {
  const calls = [];
  const api = {
    calls,
    gte(col, val) { calls.push(['gte', col, val]); return api; },
    in(col, val) { calls.push(['in', col, val]); return api; },
    overlaps(col, val) { calls.push(['overlaps', col, val]); return api; },
    is(col, val) { calls.push(['is', col, val]); return api; },
    lt(col, val) { calls.push(['lt', col, val]); return api; },
    or(expr) { calls.push(['or', expr]); return api; },
  };
  return api;
}

test('limit par défaut 20 / max 50', () => {
  assert.equal(parseCandidateDeckQuery({}).limit, DEFAULT_LIMIT);
  assert.equal(parseCandidateDeckQuery({ limit: '50' }).limit, MAX_LIMIT);
  assert.throws(() => parseCandidateDeckQuery({ limit: '51' }), /limit max/);
  assert.throws(() => parseCandidateDeckQuery({ limit: '0' }), /limit invalide/);
});

test('score_adn_min / years_experience_min bornés', () => {
  assert.equal(parseCandidateDeckQuery({ score_adn_min: '70' }).score_adn_min, 70);
  assert.throws(() => parseCandidateDeckQuery({ score_adn_min: '101' }), /score_adn_min invalide/);
  assert.equal(parseCandidateDeckQuery({ years_experience_min: '3' }).years_experience_min, 3);
  assert.throws(() => parseCandidateDeckQuery({ years_experience_min: '81' }), /years_experience_min invalide/);
});

test('desired_contracts whitelist ; sales_style / availability structuraux', () => {
  assert.deepEqual(parseCandidateDeckQuery({ desired_contracts: 'CDI,Freelance' }).desired_contracts, ['CDI', 'Freelance']);
  assert.throws(() => parseCandidateDeckQuery({ desired_contracts: 'Stage' }), /desired_contracts invalide/);
  assert.deepEqual(parseCandidateDeckQuery({ sales_style: 'hunter' }).sales_styles, ['hunter']);
  assert.deepEqual(parseCandidateDeckQuery({ availability: 'immediate' }).availabilities, ['immediate']);
});

test('skills alias competences conserve OR exact flat', () => {
  const fromLegacy = parseCandidateDeckQuery({ competences: 'Closing,HubSpot' });
  const fromSkills = parseCandidateDeckQuery({ skills: 'Closing,HubSpot' });
  assert.deepEqual(fromLegacy.skills, ['Closing', 'HubSpot']);
  assert.deepEqual(fromSkills.skills, ['Closing', 'HubSpot']);
  const row = { axes: { meta: { competences: { Vente: ['Closing'], 'Outils CRM': ['Salesforce'] } } } };
  assert.equal(candidateMatchesSkills(row, ['HubSpot']), false);
  assert.equal(candidateMatchesSkills(row, ['Closing', 'HubSpot']), true);
});

test('NULL legacy ne matche pas un filtre explicite', () => {
  const filters = parseCandidateDeckQuery({
    score_adn_min: '70',
    sales_style: 'hunter',
    availability: 'immediate',
    sectors: 'SaaS',
    tools: 'HubSpot',
  });
  assert.equal(candidateMatchesDeckFilters({ score_adn: null }, filters), false);
  assert.equal(candidateMatchesDeckFilters({
    score_adn: 80,
    sales_style: null,
    availability: null,
    sectors: null,
    tools: null,
  }, filters), false);
  assert.equal(candidateMatchesDeckFilters({
    score_adn: 80,
    sales_style: 'hunter',
    availability: 'immediate',
    sectors: ['SaaS'],
    tools: ['HubSpot'],
  }, filters), true);
});

test('AND entre familles et OR intra-famille', () => {
  const filters = parseCandidateDeckQuery({
    score_adn_min: '70',
    target_job_types: 'SDR,Account Executive',
    desired_contracts: 'CDI,Freelance',
    sectors: 'SaaS,Industrie',
  });
  assert.equal(candidateMatchesDeckFilters({
    score_adn: 75,
    target_job_types: ['SDR'],
    desired_contracts: ['Freelance'],
    sectors: ['Industrie'],
  }, filters), true);
  assert.equal(candidateMatchesDeckFilters({
    score_adn: 75,
    target_job_types: ['CSM'],
    desired_contracts: ['CDI'],
    sectors: ['SaaS'],
  }, filters), false);
});

test('cursor score_adn : phases scored/null, tie-break id, pas de doublon', () => {
  const rows = [
    { id: 'a3', score_adn: 90, user_id: 'u3' },
    { id: 'a2', score_adn: 90, user_id: 'u2' },
    { id: 'a1', score_adn: 80, user_id: 'u1' },
    { id: 'n2', score_adn: null, user_id: 'un2' },
    { id: 'n1', score_adn: null, user_id: 'un1' },
  ];
  const page1 = paginateCandidateDeck(rows, parseCandidateDeckQuery({ limit: '2' }));
  assert.deepEqual(page1.candidates.map((r) => r.id), ['a3', 'a2']);
  assert.equal(page1.has_more, true);
  const page2 = paginateCandidateDeck(rows, {
    ...parseCandidateDeckQuery({ limit: '2' }),
    cursor: decodeCursor(page1.next_cursor),
  });
  assert.deepEqual(page2.candidates.map((r) => r.id), ['a1', 'n2']);
  const page3 = paginateCandidateDeck(rows, {
    ...parseCandidateDeckQuery({ limit: '2' }),
    cursor: decodeCursor(page2.next_cursor),
  });
  assert.deepEqual(page3.candidates.map((r) => r.id), ['n1']);
  assert.equal(page3.has_more, false);
  assert.equal(page3.next_cursor, null);
  const all = [...page1.candidates, ...page2.candidates, ...page3.candidates].map((r) => r.id);
  assert.equal(new Set(all).size, all.length);
  assert.deepEqual(all.sort(), ['a1', 'a2', 'a3', 'n1', 'n2'].sort());
});

test('encode/decode cursor round-trip scored et null', () => {
  const scored = decodeCursor(encodeCursor({ id: 'x', score_adn: 72 }));
  assert.equal(scored.phase, 's');
  assert.equal(scored.score_adn, 72);
  const nulled = decodeCursor(encodeCursor({ id: 'y', score_adn: null }));
  assert.equal(nulled.phase, 'n');
  assert.equal(nulled.score_adn, null);
});

test('applySupabaseScoreCursor phase null n’utilise jamais score_adn < NULL', () => {
  const q = fakeQuery();
  applySupabaseScoreCursor(q, { phase: 'n', score_adn: null, id: 'abc' });
  assert.deepEqual(q.calls[0], ['is', 'score_adn', null]);
  assert.deepEqual(q.calls[1], ['lt', 'id', 'abc']);
  assert.equal(q.calls.some((c) => String(c[1] || '').includes('score_adn.lt.null')), false);
});

test('applySupabaseCandidateDeckFilters pousse overlaps / gte / in', () => {
  const q = fakeQuery();
  applySupabaseCandidateDeckFilters(q, parseCandidateDeckQuery({
    score_adn_min: '60',
    target_job_types: 'SDR',
    sales_style: 'farmer',
    years_experience_min: '2',
    desired_contracts: 'CDI',
    sectors: 'SaaS',
    tools: 'HubSpot',
    methodologies: 'MEDDIC',
    availability: 'immediate',
    customer_types: 'PME',
  }));
  const ops = q.calls.map((c) => c[0] + ':' + c[1]);
  assert.ok(ops.includes('gte:score_adn'));
  assert.ok(ops.includes('overlaps:target_job_types'));
  assert.ok(ops.includes('in:sales_style'));
  assert.ok(ops.includes('gte:years_experience'));
  assert.ok(ops.includes('overlaps:desired_contracts'));
  assert.ok(ops.includes('overlaps:sectors'));
  assert.ok(ops.includes('overlaps:tools'));
  assert.ok(ops.includes('overlaps:methodologies'));
  assert.ok(ops.includes('in:availability'));
  assert.ok(ops.includes('overlaps:customer_types'));
});

test('smoke 120 candidats paginés sans doublon ni omission hors exclusions', () => {
  const rows = Array.from({ length: 120 }, (_, i) => ({
    id: `c${String(i).padStart(3, '0')}`,
    user_id: `u${i}`,
    score_adn: i < 100 ? 100 - Math.floor(i / 2) : null,
  }));
  const seen = [];
  let cursor = null;
  const collected = [];
  for (let page = 0; page < 20; page += 1) {
    const result = paginateCandidateDeck(rows, {
      ...parseCandidateDeckQuery({ limit: '20' }),
      cursor,
    }, { seenIds: ['c000'], excludeUserId: 'u1' });
    collected.push(...result.candidates.map((r) => r.id));
    if (!result.has_more) break;
    cursor = decodeCursor(result.next_cursor);
  }
  assert.equal(collected.includes('c000'), false);
  assert.equal(collected.includes('c001'), false); // user_id u1 excluded
  assert.equal(new Set(collected).size, collected.length);
  assert.ok(collected.length >= 100);
});

test('route deck : pagination avant enrichissement, isolation ADN / CV IA / plan', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'candidats.js'), 'utf8');
  const deckStart = source.indexOf("router.get('/deck'");
  const deckEnd = source.indexOf('// RGPD', deckStart);
  const deck = source.slice(deckStart, deckEnd);
  assert.match(deck, /parseCandidateDeckQuery/);
  assert.match(deck, /fetchCandidateDeckRows/);
  assert.match(deck, /withFreshCvUrl/);
  assert.match(deck, /mapCandidateDeckCard/);
  assert.ok(deck.indexOf('fetchCandidateDeckRows') < deck.indexOf('withFreshCvUrl'));
  assert.match(source, /function mapCandidateDeckCard[\s\S]*certifie: false/);
  assert.doesNotMatch(deck, /deep_adn_assessments|deep_adn_answers|bilans_carriere|getCandidatePlan|ai_cv_analyses/);
  assert.doesNotMatch(deck, /from\('deep_adn/);
});

test('candidateDeckQuery ne référence jamais deep ADN / CV IA', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'utils', 'candidateDeckQuery.js'), 'utf8');
  assert.doesNotMatch(source, /deep_adn_assessments|deep_adn_answers|bilans_carriere|ai_cv_analyses|from\('assistant/);
});

test('frontend recruteur consomme candidates + cursor + race', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', '_spaces', 'recruteur.html'), 'utf8');
  assert.match(html, /page\.candidates/);
  assert.match(html, /CAND_DECK_CURSOR/);
  assert.match(html, /CAND_DECK_LOAD_GEN/);
  assert.match(html, /AbortController/);
  assert.match(html, /maybePrefetchCandidates/);
  assert.match(html, /competences/);
});

test('params invalides matching / cursor', () => {
  assert.throws(() => parseCandidateDeckQuery({ matching: '{' }), /matching invalide/);
  assert.throws(() => parseCandidateDeckQuery({ cursor: '%%%' }), /cursor invalide/);
});

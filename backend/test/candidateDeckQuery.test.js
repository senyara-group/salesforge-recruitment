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
  fetchCandidateDeckRows,
  compareCandidatesByScore,
  isAfterScoreCursor,
  DEFAULT_LIMIT,
  MAX_LIMIT,
} = require('../utils/candidateDeckQuery');

function uuid(value) {
  return `00000000-0000-4000-8000-${Number(value).toString(16).padStart(12, '0')}`;
}

function candidateAt(position, total, { skill = false, score = 80, userId } = {}) {
  return {
    id: uuid(total - position + 1),
    user_id: userId || uuid(total + position),
    score_adn: score,
    axes: { meta: { competences: skill ? { Vente: ['RareSkill'] } : {} } },
    sectors: ['SaaS'],
  };
}

function inMemoryBatchFetcher(rows, filters) {
  const dbFilters = { ...filters, skills: [] };
  return async (cursor, limit) => rows
    .filter((row) => candidateMatchesDeckFilters(row, dbFilters))
    .sort(compareCandidatesByScore)
    .filter((row) => isAfterScoreCursor(row, cursor))
    .slice(0, limit);
}

async function collectFlow(rows, rawQuery, options = {}, maxPages = 100) {
  const base = parseCandidateDeckQuery(rawQuery);
  const all = [];
  const pages = [];
  let cursor = base.cursor;
  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const filters = { ...base, cursor };
    const result = await fetchCandidateDeckRows(filters, {
      ...options,
      fetchBatch: inMemoryBatchFetcher(rows, filters),
    });
    pages.push(result);
    all.push(...result.page);
    if (!result.has_more) return { all, pages };
    assert.ok(result.next_cursor, 'une continuation doit fournir un cursor');
    cursor = decodeCursor(result.next_cursor);
  }
  throw new Error('pagination non terminée');
}

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
  const ids = { a3: uuid(5), a2: uuid(4), a1: uuid(3), n2: uuid(2), n1: uuid(1) };
  const rows = [
    { id: ids.a3, score_adn: 90, user_id: uuid(15) },
    { id: ids.a2, score_adn: 90, user_id: uuid(14) },
    { id: ids.a1, score_adn: 80, user_id: uuid(13) },
    { id: ids.n2, score_adn: null, user_id: uuid(12) },
    { id: ids.n1, score_adn: null, user_id: uuid(11) },
  ];
  const page1 = paginateCandidateDeck(rows, parseCandidateDeckQuery({ limit: '2' }));
  assert.deepEqual(page1.candidates.map((r) => r.id), [ids.a3, ids.a2]);
  assert.equal(page1.has_more, true);
  const page2 = paginateCandidateDeck(rows, {
    ...parseCandidateDeckQuery({ limit: '2' }),
    cursor: decodeCursor(page1.next_cursor),
  });
  assert.deepEqual(page2.candidates.map((r) => r.id), [ids.a1, ids.n2]);
  const page3 = paginateCandidateDeck(rows, {
    ...parseCandidateDeckQuery({ limit: '2' }),
    cursor: decodeCursor(page2.next_cursor),
  });
  assert.deepEqual(page3.candidates.map((r) => r.id), [ids.n1]);
  assert.equal(page3.has_more, false);
  assert.equal(page3.next_cursor, null);
  const all = [...page1.candidates, ...page2.candidates, ...page3.candidates].map((r) => r.id);
  assert.equal(new Set(all).size, all.length);
  assert.deepEqual(all.sort(), Object.values(ids).sort());
});

test('encode/decode cursor round-trip scored et null', () => {
  const scored = decodeCursor(encodeCursor({ id: uuid(20), score_adn: 72 }));
  assert.equal(scored.phase, 's');
  assert.equal(scored.score_adn, 72);
  const nulled = decodeCursor(encodeCursor({ id: uuid(21), score_adn: null }));
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
    id: uuid(1000 - i),
    user_id: uuid(2000 + i),
    score_adn: i < 100 ? 100 - Math.floor(i / 2) : null,
  }));
  const seen = [];
  let cursor = null;
  const collected = [];
  for (let page = 0; page < 20; page += 1) {
    const result = paginateCandidateDeck(rows, {
      ...parseCandidateDeckQuery({ limit: '20' }),
      cursor,
    }, { seenIds: [rows[0].id], excludeUserId: rows[1].user_id });
    collected.push(...result.candidates.map((r) => r.id));
    if (!result.has_more) break;
    cursor = decodeCursor(result.next_cursor);
  }
  assert.equal(collected.includes(rows[0].id), false);
  assert.equal(collected.includes(rows[1].id), false);
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

test('matching est borné aux critères courts et legacy tolérés, avec poids finis 0-100', () => {
  assert.deepEqual(parseCandidateDeckQuery({ matching: JSON.stringify({ closing: 70, drive: 0 }) }).matching, { closing: 70, drive: 0 });
  assert.deepEqual(parseCandidateDeckQuery({ matching: JSON.stringify({ ecoute: 60 }) }).matching, { ecoute: 60 });
  assert.throws(() => parseCandidateDeckQuery({ matching: JSON.stringify({ inconnu: 50 }) }), /matching invalide/);
  assert.throws(() => parseCandidateDeckQuery({ matching: JSON.stringify({ closing: 101 }) }), /matching invalide/);
  assert.throws(() => parseCandidateDeckQuery({ matching: JSON.stringify({ closing: '70' }) }), /matching invalide/);
  assert.throws(() => parseCandidateDeckQuery({ matching: '{"closing":1e309}' }), /matching invalide/);
  assert.throws(() => parseCandidateDeckQuery({ matching: `{\"closing\":50,\"pad\":\"${'x'.repeat(2100)}\"}` }), /matching invalide/);
});

test('CSV multi-select déduplique avant contrôle de limite', () => {
  assert.deepEqual(parseCandidateDeckQuery({ skills: 'HubSpot,HubSpot,Salesforce' }).skills, ['HubSpot', 'Salesforce']);
  assert.doesNotThrow(() => parseCandidateDeckQuery({ skills: Array(20).fill('HubSpot').join(',') }));
});

test('cursor forgé est refusé avant toute interpolation PostgREST', () => {
  const cursor = (payload) => Buffer.from(JSON.stringify(payload)).toString('base64url');
  for (const payload of [
    { p: 'x', s: 50, i: uuid(1) },
    { p: 's', s: 'NaN', i: uuid(1) },
    { p: 's', s: 'Infinity', i: uuid(1) },
    { p: 's', s: 101, i: uuid(1) },
    { p: 'n', s: 0, i: uuid(1) },
    { p: 's', s: 50, i: 'id),score_adn.gte.0' },
  ]) assert.throws(() => decodeCursor(cursor(payload)), /cursor invalide/);
  const infiniteScore = Buffer.from(`{"p":"s","s":1e309,"i":"${uuid(1)}"}`).toString('base64url');
  assert.throws(() => decodeCursor(infiniteScore), /cursor invalide/);
  assert.throws(() => decodeCursor('x'.repeat(257)), /cursor invalide/);
});

test('vrai fill-loop skills atteint les positions 150 / 280 / 490 sans fausse fin', async () => {
  const matches = new Set([150, 280, 490]);
  const rows = Array.from({ length: 500 }, (_, index) => candidateAt(index + 1, 500, { skill: matches.has(index + 1) }));
  const result = await collectFlow(rows, { limit: '20', skills: 'RareSkill' });
  assert.deepEqual(result.all.map((row) => rows.indexOf(row) + 1), [150, 280, 490]);
  assert.equal(new Set(result.all.map((row) => row.id)).size, 3);
  assert.equal(result.pages[0].has_more, true);
  assert.equal(decodeCursor(result.pages[0].next_cursor).id, rows[299].id);
});

test('page vide puis partielle conservent la continuation jusqu’au match sparse', async () => {
  const rows = Array.from({ length: 700 }, (_, index) => candidateAt(index + 1, 700, { skill: index + 1 === 650 }));
  const result = await collectFlow(rows, { limit: '20', skills: 'RareSkill' });
  assert.equal(result.pages[0].page.length, 0);
  assert.equal(result.pages[0].has_more, true);
  assert.equal(result.all.length, 1);
  assert.equal(rows.indexOf(result.all[0]) + 1, 650);
  assert.equal(result.pages.at(-1).has_more, false);
});

test('le 21e match inspecté reste disponible sur la page suivante', async () => {
  const rows = Array.from({ length: 40 }, (_, index) => candidateAt(index + 1, 40, { skill: index < 21 }));
  const result = await collectFlow(rows, { limit: '20', skills: 'RareSkill' });
  assert.deepEqual(result.all.map((row) => rows.indexOf(row) + 1), Array.from({ length: 21 }, (_, index) => index + 1));
  assert.equal(new Set(result.all.map((row) => row.id)).size, 21);
});

test('fill-loop gère égalités, transition NULL, filtre SQL et exclusions', async () => {
  const rows = Array.from({ length: 620 }, (_, index) => candidateAt(index + 1, 620, {
    skill: [20, 310, 590, 610].includes(index + 1),
    score: index < 400 ? 75 : null,
  }));
  rows[589].sectors = ['Industrie'];
  const result = await collectFlow(rows, { limit: '2', skills: 'RareSkill', sectors: 'SaaS' }, {
    seenIds: [rows[309].id],
  });
  assert.deepEqual(result.all.map((row) => rows.indexOf(row) + 1), [20, 610]);
  assert.equal(new Set(result.all.map((row) => row.user_id)).size, result.all.length);
});

test('déduplication historique user_id est restaurée dans le flow et dans les pages frontend', async () => {
  const rows = Array.from({ length: 80 }, (_, index) => candidateAt(index + 1, 80, {
    skill: [10, 11, 40].includes(index + 1),
  }));
  rows[10].user_id = rows[9].user_id;
  const filters = parseCandidateDeckQuery({ limit: '20', skills: 'RareSkill' });
  const result = await fetchCandidateDeckRows(filters, { fetchBatch: inMemoryBatchFetcher(rows, filters) });
  assert.deepEqual(result.page.map((row) => rows.indexOf(row) + 1), [10, 40]);
  assert.equal(new Set(result.page.map((row) => row.user_id)).size, result.page.length);
});

test('volume 5000 sparse termine sans omission, doublon ou faux has_more', async () => {
  const matches = new Set([1, 777, 2499, 4990]);
  const rows = Array.from({ length: 5000 }, (_, index) => candidateAt(index + 1, 5000, { skill: matches.has(index + 1) }));
  const result = await collectFlow(rows, { limit: '20', skills: 'RareSkill' }, {}, 30);
  assert.deepEqual(result.all.map((row) => rows.indexOf(row) + 1), [...matches]);
  assert.equal(new Set(result.all.map((row) => row.id)).size, matches.size);
});

test('select deck n’utilise plus les colonnes URL fantômes (avatar/cv/motivation)', () => {
  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'candidats.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', '_spaces', 'recruteur.html'), 'utf8');
  const selectMatch = route.match(/const CANDIDATE_DECK_SELECT = \[([\s\S]*?)\]\.join/);
  assert.ok(selectMatch, 'CANDIDATE_DECK_SELECT manquant');
  const selectBody = selectMatch[1];
  for (const col of ['avatar_url', 'cv_url', 'motivation_url']) {
    assert.doesNotMatch(selectBody, new RegExp(`['"]${col}['"]`));
  }
  assert.match(selectBody, /['"]axes['"]/);
  assert.match(route, /withFreshCvUrl/);
  assert.match(route, /CANDIDATE_DECK_FORBIDDEN_COLUMNS/);
  assert.match(html, /CAND_DECK_EMPTY_PREFETCH_MAX/);
  assert.match(html, /do \{[\s\S]*fetchCandidateDeckPage\(continuation[\s\S]*\} while \(!added && CAND_DECK_HAS_MORE/);
  assert.match(html, /filtersSnapshot|cloneCandFilters/);
  assert.match(html, /seenUsers/);
});

test('CANDIDATE_DECK_SELECT ne réintroduit pas de colonnes URL inexistantes', () => {
  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'candidats.js'), 'utf8');
  const selectMatch = route.match(/const CANDIDATE_DECK_SELECT = \[([\s\S]*?)\]\.join/);
  assert.ok(selectMatch);
  const selected = [...selectMatch[1].matchAll(/['"]([a-z_]+)['"]/g)].map((m) => m[1]);
  const forbiddenMatch = route.match(/const CANDIDATE_DECK_FORBIDDEN_COLUMNS = Object\.freeze\(\[([\s\S]*?)\]\)/);
  assert.ok(forbiddenMatch, 'CANDIDATE_DECK_FORBIDDEN_COLUMNS manquant');
  const forbidden = [...forbiddenMatch[1].matchAll(/['"]([a-z_]+)['"]/g)].map((m) => m[1]);
  assert.deepEqual(forbidden.sort(), ['avatar_url', 'cv_url', 'motivation_url'].sort());
  for (const col of forbidden) {
    assert.equal(selected.includes(col), false, `colonne interdite dans SELECT: ${col}`);
  }
  assert.ok(selected.includes('axes'));
  assert.ok(selected.includes('score_adn'));
});

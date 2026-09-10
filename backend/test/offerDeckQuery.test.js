const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  parseOfferDeckQuery,
  encodeCursor,
  decodeCursor,
  offerMatchesSalaryMin,
  offerMatchesDeckFilters,
  compareOffersNewestFirst,
  paginateOfferDeck,
} = require('../utils/offerDeckQuery');

function filters(overrides = {}) {
  return parseOfferDeckQuery(overrides);
}

test('limit par défaut 20, max 50, refus non borné / abusif', () => {
  assert.equal(parseOfferDeckQuery({}).limit, DEFAULT_LIMIT);
  assert.equal(parseOfferDeckQuery({ limit: '50' }).limit, MAX_LIMIT);
  assert.throws(() => parseOfferDeckQuery({ limit: '51' }), { code: 'OFFER_DECK_LIMIT_MAX' });
  assert.throws(() => parseOfferDeckQuery({ limit: '0' }), { code: 'OFFER_DECK_LIMIT_INVALID' });
  assert.throws(() => parseOfferDeckQuery({ limit: 'all' }), { code: 'OFFER_DECK_LIMIT_INVALID' });
});

test('whitelist contract_type / remote_mode et refus nationwide', () => {
  assert.deepEqual(parseOfferDeckQuery({ contract_type: 'CDI,Freelance' }).contract_types, ['CDI', 'Freelance']);
  assert.throws(() => parseOfferDeckQuery({ contract_type: 'Stage' }), { code: 'FILTER_TAXONOMY_INVALID' });
  assert.deepEqual(parseOfferDeckQuery({ remote_mode: 'hybrid,remote' }).remote_modes, ['hybrid', 'remote']);
  assert.throws(() => parseOfferDeckQuery({ remote_mode: 'nationwide' }), { code: 'FILTER_TAXONOMY_INVALID' });
});

test('salary / date / cursor / tags validation', () => {
  assert.equal(parseOfferDeckQuery({ salary_fixed_min: '35000' }).salary_fixed_min, 35000);
  assert.throws(() => parseOfferDeckQuery({ salary_fixed_min: '-1' }), { code: 'OFFER_DECK_SALARY_INVALID' });
  assert.throws(() => parseOfferDeckQuery({ published_since: '10-01-2026' }), { code: 'OFFER_DECK_DATE_INVALID' });
  assert.equal(parseOfferDeckQuery({ published_since: '2026-01-10' }).published_since, '2026-01-10T00:00:00.000Z');
  assert.throws(() => parseOfferDeckQuery({ cursor: '%%%' }), { code: 'OFFER_DECK_CURSOR_INVALID' });
  assert.throws(() => parseOfferDeckQuery({ tags: 'UnknownTag' }), { code: 'FILTER_TAXONOMY_INVALID' });
  assert.deepEqual(parseOfferDeckQuery({ tags: 'Salesforce,HubSpot' }).tags, ['Salesforce', 'HubSpot']);
});

test('règle salary_fixed_min explicite sans parsing salaire texte', () => {
  assert.equal(offerMatchesSalaryMin({ salary_fixed_max: 40000, salary_fixed_min: 30000 }, 35000), true);
  assert.equal(offerMatchesSalaryMin({ salary_fixed_max: 34000, salary_fixed_min: 30000 }, 35000), false);
  assert.equal(offerMatchesSalaryMin({ salary_fixed_max: null, salary_fixed_min: 36000 }, 35000), true);
  assert.equal(offerMatchesSalaryMin({ salary_fixed_max: null, salary_fixed_min: 30000 }, 35000), false);
  assert.equal(offerMatchesSalaryMin({ salary_fixed_max: null, salary_fixed_min: null, salaire: '45K€' }, 35000), false);
});

test('NULL ne satisfait pas un filtre explicite ; sans filtre les legacy restent visibles', () => {
  const legacy = {
    id: '1',
    statut: 'active',
    contract_type: null,
    remote_mode: null,
    tags: [],
    salary_fixed_min: null,
    salary_fixed_max: null,
    created_at: null,
    job_type: null,
    sector: null,
  };
  assert.equal(offerMatchesDeckFilters(legacy, filters({})), true);
  assert.equal(offerMatchesDeckFilters(legacy, filters({ remote_mode: 'remote' })), false);
  assert.equal(offerMatchesDeckFilters(legacy, filters({ contract_type: 'CDI' })), false);
  assert.equal(offerMatchesDeckFilters(legacy, filters({ published_since: '2026-01-01' })), false);
  assert.equal(offerMatchesDeckFilters(legacy, filters({ salary_fixed_min: '30000' })), false);
  assert.equal(offerMatchesDeckFilters({
    ...legacy,
    remote_mode: 'remote',
    contract_type: 'CDI',
    tags: ['Salesforce'],
  }, filters({ remote_mode: 'remote', contract_type: 'CDI', tags: 'HubSpot,Salesforce' })), true);
});

test('AND entre familles et OR intra-famille (contract / tags)', () => {
  const offer = {
    id: 'o1',
    statut: 'active',
    contract_type: 'Freelance',
    remote_mode: 'hybrid',
    tags: ['HubSpot'],
    salary_fixed_min: 40000,
    salary_fixed_max: null,
    created_at: '2026-02-01T00:00:00.000Z',
    job_type: 'ae',
    sector: 'saas',
  };
  assert.equal(offerMatchesDeckFilters(offer, filters({
    contract_type: 'CDI,Freelance',
    remote_mode: 'hybrid',
    tags: 'Salesforce,HubSpot',
    salary_fixed_min: '35000',
  })), true);
  assert.equal(offerMatchesDeckFilters(offer, filters({
    contract_type: 'CDI',
    remote_mode: 'hybrid',
  })), false);
});

test('pagination cursor stable : pas de doublon, tri dates identiques, created_at NULL en fin', () => {
  const rows = [
    { id: 'b', statut: 'active', created_at: '2026-03-01T10:00:00.000Z' },
    { id: 'a', statut: 'active', created_at: '2026-03-01T10:00:00.000Z' },
    { id: 'c', statut: 'active', created_at: '2026-02-01T10:00:00.000Z' },
    { id: 'n2', statut: 'active', created_at: null },
    { id: 'n1', statut: 'active', created_at: null },
    { id: 'seen', statut: 'active', created_at: '2026-04-01T10:00:00.000Z' },
    { id: 'paused', statut: 'paused', created_at: '2026-05-01T10:00:00.000Z' },
  ];
  const page1 = paginateOfferDeck(rows, filters({ limit: '2' }), { seenIds: ['seen'] });
  assert.deepEqual(page1.offers.map((o) => o.id), ['b', 'a']);
  assert.equal(page1.has_more, true);
  assert.ok(page1.next_cursor);

  const page2 = paginateOfferDeck(rows, filters({ limit: '2', cursor: page1.next_cursor }), { seenIds: ['seen'] });
  assert.deepEqual(page2.offers.map((o) => o.id), ['c', 'n2']);
  const page3 = paginateOfferDeck(rows, filters({ limit: '2', cursor: page2.next_cursor }), { seenIds: ['seen'] });
  assert.deepEqual(page3.offers.map((o) => o.id), ['n1']);
  assert.equal(page3.has_more, false);
  assert.equal(page3.next_cursor, null);

  const allIds = [...page1.offers, ...page2.offers, ...page3.offers].map((o) => o.id);
  assert.equal(new Set(allIds).size, allIds.length);
  assert.ok(!allIds.includes('seen'));
  assert.ok(!allIds.includes('paused'));

  const sorted = [...rows].filter((o) => (o.statut == null ? 'active' : o.statut) === 'active')
    .sort(compareOffersNewestFirst)
    .map((o) => o.id);
  assert.deepEqual(sorted.slice(0, 3), ['seen', 'b', 'a']);
});

test('encode/decode cursor round-trip', () => {
  const cursor = encodeCursor({ id: 'uuid-1', created_at: '2026-01-01T00:00:00.000Z' });
  assert.deepEqual(decodeCursor(cursor), { id: 'uuid-1', created_at: '2026-01-01T00:00:00.000Z' });
  assert.deepEqual(decodeCursor(encodeCursor({ id: 'uuid-2', created_at: null })), { id: 'uuid-2', created_at: null });
});

test('smoke volume : 120 offres paginées sans doublon ni omission hors exclusions', () => {
  const rows = Array.from({ length: 120 }, (_, index) => ({
    id: `id-${String(index).padStart(3, '0')}`,
    statut: 'active',
    created_at: index % 5 === 0 ? null : new Date(Date.UTC(2026, 0, 1 + (index % 28))).toISOString(),
    contract_type: index % 2 ? 'CDI' : 'Freelance',
    remote_mode: 'remote',
    tags: ['Closing'],
  }));
  const seen = ['id-010', 'id-020'];
  const collected = [];
  let cursor = null;
  for (let guard = 0; guard < 20; guard += 1) {
    const page = paginateOfferDeck(rows, filters({ limit: '20', cursor: cursor || undefined }), { seenIds: seen });
    collected.push(...page.offers.map((o) => o.id));
    if (!page.has_more) break;
    cursor = page.next_cursor;
  }
  assert.equal(new Set(collected).size, collected.length);
  assert.equal(collected.length, 118);
  assert.ok(!collected.includes('id-010'));
});

test('route deck : pagination avant enrichissement, pas de deep ADN / abonnement', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'offres.js'), 'utf8');
  assert.match(source, /parseOfferDeckQuery/);
  assert.match(source, /limit\(filters\.limit \+ 1\)/);
  assert.match(source, /attachRecruiterLogos\(page\)/);
  assert.match(source, /has_more/);
  assert.match(source, /next_cursor/);
  assert.doesNotMatch(source, /deep_adn|adn-approfondi|bilans_carriere|getCandidatePlan|carriere_coaching/i);
  const idxFilter = source.indexOf('applySupabaseDeckFilters');
  const idxEnrich = source.indexOf('attachRecruiterLogos(page)');
  assert.ok(idxFilter >= 0 && idxEnrich > idxFilter);
});

test('frontend consomme offers[] paginé sans exiger l’ancien tableau brut seul', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', '_spaces', 'candidat.html'), 'utf8');
  assert.match(html, /page\.offers/);
  assert.match(html, /page\.has_more/);
  assert.match(html, /page\.next_cursor/);
  assert.match(html, /Array\.isArray\(page\)/);
});

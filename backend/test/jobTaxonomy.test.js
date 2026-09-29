const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const taxonomy = require('../utils/yannisTaxonomies');
const { createJobTaxonomy, deepFreezeDescriptors, JobTaxonomyError } = require('../utils/jobTaxonomy');
const { FILES } = require('../scripts/sync-job-taxonomy');
const { normalizeCandidateProfileStructuredFields } = require('../utils/candidateProfileWrite');
const { normalizeOfferStructuredFields } = require('../utils/offerWrite');
const { parseOfferDeckQuery, offerMatchesDeckFilters } = require('../utils/offerDeckQuery');
const { parseCandidateDeckQuery, candidateMatchesDeckFilters } = require('../utils/candidateDeckQuery');
const historical = [
  ['sdr', 'SDR / BDR'], ['bizdev', 'Business Developer'], ['ae', 'Account Executive'],
  ['terrain', 'Commercial terrain'], ['kam', 'Key Account Manager'], ['manager', 'Manager commercial'],
];
// Registre complet après le Lot 4 (6 historiques + 9 familles de la liste Yannis).
const LOT4_IDS = [
  'sdr', 'bizdev', 'ae', 'sedentaire', 'terrain', 'technico_commercial', 'charge_affaires', 'avant_vente',
  'kam', 'account_manager', 'customer_success', 'partenariats', 'conseiller_vente', 'manager', 'direction_commerciale',
];
const HISTORICAL_IDS = historical.map(([id]) => id);
const html = file => fs.readFileSync(path.resolve(__dirname, '../..', file), 'utf8');
const decodeHtml = value => value.replace(/&(amp|lt|gt|quot|#39);/g, (_all, name) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[name]));
const withJobs = (...extra) => [...taxonomy.JOB_TYPE_DESCRIPTORS, ...extra];

test('six historical ADN IDs and persisted labels unchanged, same relative order in the Lot 4 registry', () => {
  assert.deepEqual(taxonomy.activeJobTypes().map(job => job.id), LOT4_IDS);
  assert.deepEqual(taxonomy.JOB_TYPE_DESCRIPTORS.map(job => job.id), LOT4_IDS);
  const pairs = taxonomy.activeJobTypes().map(job => [job.id, job.label]);
  assert.deepEqual(pairs.filter(([id]) => HISTORICAL_IDS.includes(id)), historical);
  assert.deepEqual(taxonomy.TARGET_JOB_TYPES, pairs.map(([, label]) => label));
  for (const [id, label] of historical) {
    assert.equal(taxonomy.isJobTypeId(id), true);
    assert.equal(taxonomy.jobTypeById(id).label, label);
    assert.equal(taxonomy.jobTypeLabel(id), label);
    assert.equal(taxonomy.jobTypeLabel(label), label);
    assert.equal(taxonomy.resolveStoredJobType(id), taxonomy.resolveStoredJobType(label));
    // An ID typed in a label column is never rewritten, except when it is also one of
    // its OWN job's aliases from the Yannis list ('SDR' for sdr): then only to its own label.
    const ownAlias = taxonomy.jobTypeById(id).aliases.some(alias => alias.toLowerCase() === id);
    assert.equal(taxonomy.canonicalizeTargetJobType(id), ownAlias ? label : null, id);
    assert.equal(taxonomy.canonicalizeTargetJobType(label), label);
  }
  assert.deepEqual(HISTORICAL_IDS.filter(id => taxonomy.canonicalizeTargetJobType(id) !== null), ['sdr']);
});

test('only trim/case variants and unambiguous Yannis-list aliases resolve; ambiguous titles never mapped', () => {
  for (const [, label] of historical) {
    assert.equal(taxonomy.canonicalizeTargetJobType('  ' + label.toLowerCase() + '  '), label);
  }
  // Intitulés génériques ou multi-familles : jamais rattachés (même présents dans la liste).
  for (const unknown of ['', 'unknown', 'Business Dev', 'Closer', 'Sales', 'Sales Executive', 'Commercial',
    'Ingénieur commercial', 'Business Partner', 'Chef de rayon', 'Sales Operations Manager']) {
    assert.equal(taxonomy.resolveStoredJobType(unknown), null, unknown);
  }
  assert.equal(taxonomy.jobTypeById(' SDR '), null);
});

test('all job helpers refuse nonstrings without invoking coercion', () => {
  const hostile = { toString() { assert.fail('must not coerce'); }, [Symbol.toPrimitive]() { assert.fail('must not coerce'); } };
  for (const value of [null, undefined, {}, [], ['Account Executive'], true, false, 123, new String('sdr'), hostile]) {
    assert.equal(taxonomy.isJobTypeId(value), false);
    for (const helper of ['jobTypeById', 'resolveJobTypeLabel', 'resolveStoredJobType', 'jobTypeLabel', 'canonicalizeTargetJobType']) {
      assert.equal(taxonomy[helper](value), null, helper);
    }
  }
});

test('registry and descriptors cannot be mutated through public helpers', () => {
  assert.ok(Object.isFrozen(taxonomy.JOB_TYPES));
  assert.ok(Object.isFrozen(taxonomy.JOB_TYPE_DESCRIPTORS));
  for (const job of taxonomy.JOB_TYPES) {
    assert.ok(Object.isFrozen(job)); assert.ok(Object.isFrozen(job.aliases));
  }
  const copy = taxonomy.activeJobTypes(); copy.pop();
  assert.equal(taxonomy.activeJobTypes().length, LOT4_IDS.length);
});

test('JOB_TYPE_DESCRIPTORS is deeply immutable: helpers and generator cannot be altered', () => {
  const { sync } = require('../scripts/sync-job-taxonomy');
  const before = JSON.parse(JSON.stringify(taxonomy.JOB_TYPE_DESCRIPTORS));
  const injected = 'Fixture injected alias';
  const [sdr] = taxonomy.JOB_TYPE_DESCRIPTORS;
  assert.ok(Object.isFrozen(sdr));
  assert.equal(Reflect.set(sdr, 'label', 'HACK'), false);
  assert.equal(Reflect.set(sdr, 'active', false), false);
  assert.equal(Reflect.set(sdr, 'aliases', [injected]), false); // cannot replace the alias array
  assert.equal(Reflect.deleteProperty(sdr, 'id'), false);
  assert.equal(Reflect.set(taxonomy.JOB_TYPE_DESCRIPTORS, 0, { id: 'x', label: 'X' }), false);
  assert.throws(() => taxonomy.JOB_TYPE_DESCRIPTORS.push({ id: 'x', label: 'X' }), TypeError);
  for (const descriptor of taxonomy.JOB_TYPE_DESCRIPTORS) {
    assert.throws(() => descriptor.aliases.push(injected), TypeError);
    assert.equal(Reflect.set(descriptor.aliases, 0, injected), false);
  }
  for (const job of taxonomy.JOB_TYPES) {
    assert.throws(() => job.aliases.push(injected), TypeError);
    assert.equal(Reflect.set(job, 'label', 'HACK'), false);
  }
  // Alias arrays of any deep-frozen descriptor list are frozen too.
  const fixture = deepFreezeDescriptors([{ id: 'x', label: 'X', aliases: ['Y'] }]);
  assert.throws(() => fixture[0].aliases.push('Z'), TypeError);
  assert.equal(Reflect.set(fixture[0].aliases, 0, 'Z'), false);
  assert.equal(Reflect.deleteProperty(fixture[0].aliases, 0), false);
  assert.deepEqual(fixture[0].aliases, ['Y']);
  // Registry, helpers and generator are unchanged after every attempt.
  assert.deepEqual(JSON.parse(JSON.stringify(taxonomy.JOB_TYPE_DESCRIPTORS)), before);
  assert.equal(taxonomy.jobTypeLabel('sdr'), 'SDR / BDR');
  assert.equal(taxonomy.resolveStoredJobType(injected), null);
  assert.deepEqual(sync(), { changed: [] });
});

test('inactive jobs: historical reads resolve, new writes never canonicalize, never remap', () => {
  // Synthetic fixture only: no additional profession is added to the actual registry.
  const t = createJobTaxonomy(withJobs({ id: 'fixture_retired', label: 'Fixture retired', active: false, aliases: ['Fixture old'] }));
  assert.equal(t.activeJobTypes().length, LOT4_IDS.length);
  assert.equal(t.TARGET_JOB_TYPES.includes('Fixture retired'), false);
  // Read side: stored ID or label/alias stays readable with its own label.
  assert.equal(t.resolveStoredJobType('Fixture old').id, 'fixture_retired');
  assert.equal(t.resolveStoredJobType('fixture_retired').id, 'fixture_retired');
  assert.equal(t.jobTypeLabel(' fixture RETIRED '), 'Fixture retired');
  assert.equal(t.jobTypeById('fixture_retired').active, false);
  // Write side: not a new choice, so not canonicalized (writers keep the raw text).
  assert.equal(t.canonicalizeTargetJobType('Fixture retired'), null);
  assert.equal(t.canonicalizeTargetJobType('fixture old'), null);
  for (const [, label] of historical) assert.equal(t.canonicalizeTargetJobType(label), label);
});

test('profile writes retain arrays, canonical labels and unknown historical text', () => {
  const values = [...historical.map(([, label]) => label.toLowerCase()), 'Legacy custom role', 'ae'];
  const written = normalizeCandidateProfileStructuredFields({ target_job_types: values });
  assert.deepEqual(written.target_job_types, [...historical.map(([, label]) => label), 'Legacy custom role', 'ae']);
  assert.deepEqual(normalizeCandidateProfileStructuredFields({}), {});
});

test('offer writes and both decks preserve existing label-based contracts', () => {
  for (const [, label] of historical) {
    const offer = normalizeOfferStructuredFields({ type: 'CDI', job_type: label.toLowerCase() });
    assert.equal(offer.job_type, label);
    assert.equal(offerMatchesDeckFilters(offer, parseOfferDeckQuery({ job_type: label })), true);
    assert.equal(candidateMatchesDeckFilters({ target_job_types: [label, 'Legacy custom role'] }, parseCandidateDeckQuery({ target_job_types: label })), true);
  }
  assert.equal(normalizeOfferStructuredFields({ type: 'CDI', job_type: 'Legacy custom role' }).job_type, 'Legacy custom role');
});

test('generated ADN buttons, question modules and recruiter chips: registry order, historical six unchanged', () => {
  const registry = taxonomy.JOB_TYPE_DESCRIPTORS.map(job => [job.id, job.label]);
  const source = html(FILES[0]);
  const buttons = source.match(/id="job-type-opts">([\s\S]*?)<\/div>/)[1];
  const parsed = [...buttons.matchAll(/<button type="button" class="opt" aria-pressed="false" data-job-id="([^"]+)" onclick="toggleTargetJob\('([^']+)',this\)"><span class="ot">([^<]+)</g)];
  assert.ok(parsed.every(m => m[1] === m[2]), 'data-job-id = handler id');
  const generated = parsed.map(m => [m[2], decodeHtml(m[3])]);
  assert.deepEqual(generated, registry);
  assert.deepEqual(generated.filter(([id]) => HISTORICAL_IDS.includes(id)), historical);
  const questionsStart = source.indexOf('const PROFILE_QUESTIONS = {');
  const questionsEnd = source.indexOf('let TEST_JOB_TYPE', questionsStart);
  const questions = vm.runInNewContext(source.slice(questionsStart, questionsEnd) + '\nPROFILE_QUESTIONS');
  assert.deepEqual(Object.keys(questions), LOT4_IDS);
  for (const [id, label] of registry) {
    assert.equal(questions[id].label, label);
    assert.ok(questions[id].q1.options.length >= 3);
    assert.ok(questions[id].q2.options.length >= 3);
  }
  const chips = html(FILES[1]).match(/id="filt-job-types">([\s\S]*?)<\/div>/)[1];
  assert.deepEqual([...chips.matchAll(/data-filter-value="([^"]+)"/g)].map(m => decodeHtml(m[1])), registry.map(([, label]) => label));
});

test('invalid registries fail at construction with a JobTaxonomyError', () => {
  assert.throws(() => createJobTaxonomy([]), JobTaxonomyError);
  assert.throws(() => createJobTaxonomy([{ id: 'x', label: 'X', active: false }]), /at least one active/);
  assert.throws(() => createJobTaxonomy(withJobs({ id: 'x', label: 'X', extra: 1 })), /unknown key "extra"/);
  assert.throws(() => createJobTaxonomy(withJobs({ id: 'Bad-ID', label: 'X' })), /id must match/);
  assert.throws(() => createJobTaxonomy(withJobs({ id: 'x', label: 'X', active: 'yes' })), /active must be a boolean/);
  assert.throws(() => createJobTaxonomy(withJobs({ id: 'x', label: 'X', aliases: 'Y' })), /aliases must be an array/);
});

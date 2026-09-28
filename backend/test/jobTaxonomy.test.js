const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const taxonomy = require('../utils/yannisTaxonomies');
const { FILES, render, sync } = require('../scripts/sync-job-taxonomy');
const { normalizeCandidateProfileStructuredFields } = require('../utils/candidateProfileWrite');
const { normalizeOfferStructuredFields } = require('../utils/offerWrite');
const { parseOfferDeckQuery, offerMatchesDeckFilters } = require('../utils/offerDeckQuery');
const { parseCandidateDeckQuery, candidateMatchesDeckFilters } = require('../utils/candidateDeckQuery');
const historical = [
  ['sdr', 'SDR / BDR'], ['bizdev', 'Business Developer'], ['ae', 'Account Executive'],
  ['terrain', 'Commercial terrain'], ['kam', 'Key Account Manager'], ['manager', 'Manager commercial'],
];
const html = file => fs.readFileSync(path.resolve(__dirname, '../..', file), 'utf8');

test('six historical ADN IDs, persisted labels and ordering stay identical', () => {
  assert.deepEqual(taxonomy.activeJobTypes().map(job => [job.id, job.label]), historical);
  assert.deepEqual(taxonomy.TARGET_JOB_TYPES, historical.map(([, label]) => label));
  for (const [id, label] of historical) {
    assert.equal(taxonomy.isJobTypeId(id), true);
    assert.equal(taxonomy.jobTypeById(id).label, label);
    assert.equal(taxonomy.jobTypeLabel(id), label);
    assert.equal(taxonomy.jobTypeLabel(label), label);
    assert.equal(taxonomy.resolveStoredJobType(id), taxonomy.resolveStoredJobType(label));
    assert.equal(taxonomy.canonicalizeTargetJobType(id), null); // never rewrite IDs into label columns
    assert.equal(taxonomy.canonicalizeTargetJobType(label), label);
  }
});

test('only established trim/case variants resolve; no invented semantic aliases', () => {
  for (const [, label] of historical) {
    assert.equal(taxonomy.canonicalizeTargetJobType('  ' + label.toLowerCase() + '  '), label);
  }
  for (const unknown of ['', 'unknown', 'BDR', 'Business Dev', 'Closer', 'Sales', 'Head of Sales', 'Sales Engineer']) {
    assert.equal(taxonomy.resolveStoredJobType(unknown), null);
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
  for (const job of taxonomy.JOB_TYPES) {
    assert.ok(Object.isFrozen(job)); assert.ok(Object.isFrozen(job.aliases));
  }
  const copy = taxonomy.activeJobTypes(); copy.pop();
  assert.equal(taxonomy.activeJobTypes().length, 6);
});

test('inactive descriptors and explicit aliases remain readable without appearing in active UI lists', () => {
  // Synthetic fixture only: no additional profession is added to the actual registry.
  const source = fs.readFileSync(path.join(__dirname, '../utils/yannisTaxonomies.js'), 'utf8');
  const fixture = source.replace("const JOB_TYPES = Object.freeze([", "const JOB_TYPES = Object.freeze([{ id: 'fixture_retired', label: 'Fixture retired', active: false, aliases: ['Fixture old'] },");
  const sandbox = { module: { exports: {} } };
  vm.runInNewContext(fixture, sandbox);
  const t = sandbox.module.exports;
  assert.equal(t.activeJobTypes().length, 6);
  assert.equal(t.TARGET_JOB_TYPES.includes('Fixture retired'), false);
  assert.equal(t.resolveStoredJobType('Fixture old').id, 'fixture_retired');
  assert.equal(t.jobTypeById('fixture_retired').active, false);
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

test('checked-in frontend consumers match generation and generation is idempotent', () => {
  sync();
  for (const file of FILES) {
    const current = html(file);
    assert.equal(render(file, current), current);
    assert.equal(render(file, current.replace(/\r\n/g, '\n')), current.replace(/\r\n/g, '\n'));
    if (file === FILES[0]) {
      const escapedLabel = current.replace("label: 'SDR / BDR'", "label: 'Fixture d\\'exemple'");
      assert.equal(render(file, escapedLabel), current);
    }
    const drift = current.replace('>SDR / BDR</', '>wrong label</');
    // First candidate occurrence is intentionally a separate legacy prefs list.
    if (file === FILES[1]) assert.equal(render(file, drift), current);
  }
});

test('generated ADN button payloads, profile choices and question labels remain historical', () => {
  const source = html(FILES[0]);
  const buttons = source.match(/id="job-type-opts">([\s\S]*?)<\/div>/)[1];
  assert.deepEqual([...buttons.matchAll(/selectJobType\('([^']+)',this\).*?class="ot">([^<]+)</g)].map(m => [m[1], m[2]]), historical);
  const questionsStart = source.indexOf('const PROFILE_QUESTIONS = {');
  const questionsEnd = source.indexOf('let TEST_JOB_TYPE', questionsStart);
  const questions = vm.runInNewContext(source.slice(questionsStart, questionsEnd) + '\nPROFILE_QUESTIONS');
  assert.deepEqual(Object.keys(questions), historical.map(([id]) => id));
  for (const [id, label] of historical) {
    assert.equal(questions[id].label, label);
    assert.ok(questions[id].q1.options.length >= 3);
    assert.ok(questions[id].q2.options.length >= 3);
  }
});

test('generator fails closed on missing or duplicated consumer anchors', () => {
  const source = html(FILES[0]);
  assert.throws(() => render(FILES[0], source.replace('id="job-type-opts"', 'id="missing"')), /anchor/);
  assert.throws(() => render(FILES[0], source.replace("  sdr: {", '  missing: {')), /anchor/);
  assert.throws(() => render(FILES[1], html(FILES[1]) + html(FILES[1])), /anchor/);
});

// Adversarial tests for scripts/sync-job-taxonomy.js. Every write test runs on
// temporary copies of the consumer HTML files, never on the repository.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { JOB_TYPE_DESCRIPTORS } = require('../utils/yannisTaxonomies');
const { createJobTaxonomy, JobTaxonomyError } = require('../utils/jobTaxonomy');
const { ADN_PROFILE_QUESTION_MODULES, validateAdnModules } = require('../utils/adnProfileQuestions');
const { FILES, render, sync } = require('../scripts/sync-job-taxonomy');

const REPO = path.resolve(__dirname, '../..');
const [CANDIDATE, RECRUITER] = FILES;
const HISTORICAL_IDS = ['sdr', 'bizdev', 'ae', 'terrain', 'kam', 'manager'];
const CANDIDATE_DRIFT = ['<span class="ot">SDR / BDR</span>', '<span class="ot">stale label</span>'];
const RECRUITER_DRIFT = ['>SDR / BDR</button>', '>stale label</button>'];
// Métier fictif (le technico-commercial est devenu un vrai métier au Lot 4).
const FUTURE_JOB = Object.freeze({ id: 'fixture_future_job', label: 'Métier futur (fixture)', active: true });
const COMPLETE_MODULE = Object.freeze({
  q1: { text: 'Part de votre temps en démonstrations techniques :', options: ['Moins de 25 %', '25 à 50 %', 'Plus de 50 %'] },
  q2: { text: 'Face à une objection technique pointue :', options: ['Je réponds seul', "J'implique un expert", 'Je reporte la réponse'] },
});
// The index stores LF, Windows checkouts may get CRLF: every EOL-sensitive test
// runs on both, independently of how the repository was checked out.
const EOLS = Object.freeze([['LF', '\n'], ['CRLF', '\r\n']]);
const withEol = (source, eol) => (eol ? source.replace(/\r\n/g, '\n').replace(/\n/g, eol) : source);
const historicalFile = (file, eol) => withEol(fs.readFileSync(path.join(REPO, file), 'utf8'), eol);

function tempRoot(t, eol) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'job-taxonomy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const file of FILES) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), historicalFile(file, eol), 'utf8');
  }
  return root;
}
const bytes = (root, file) => fs.readFileSync(path.join(root, file));
const text = (root, file) => fs.readFileSync(path.join(root, file), 'utf8');
// Anchors are written with \n and adapted to the line endings of `source`.
function replaceOnce(source, from, to) {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  [from, to] = [withEol(from, eol), withEol(to, eol)];
  assert.equal(source.split(from).length - 1, 1, `fixture anchor must be unique: ${JSON.stringify(from)}`);
  return source.replace(from, () => to);
}
function mutate(root, file, from, to) {
  fs.writeFileSync(path.join(root, file), replaceOnce(text(root, file), from, to), 'utf8');
}
/** Both files need regeneration, then one error is injected: nothing may be written. */
function assertZeroWrite(t, { eol, breakFile, from, to, edit, options = {}, error }) {
  const root = tempRoot(t, eol);
  mutate(root, CANDIDATE, ...CANDIDATE_DRIFT);
  mutate(root, RECRUITER, ...RECRUITER_DRIFT);
  if (breakFile && edit) fs.writeFileSync(path.join(root, breakFile), edit(text(root, breakFile)), 'utf8');
  else if (breakFile) mutate(root, breakFile, from, to);
  const before = FILES.map(file => bytes(root, file));
  assert.throws(() => sync({ write: true, root, ...options }), error);
  FILES.forEach((file, i) => assert.ok(bytes(root, file).equals(before[i]), `${file} must stay byte-for-byte identical`));
  assert.deepEqual(fs.readdirSync(path.join(root, 'frontend/_spaces')).filter(name => name.endsWith('.tmp')), []);
}
const withJobs = (...extra) => [...JOB_TYPE_DESCRIPTORS, ...extra];
const withModules = extra => ({ ...ADN_PROFILE_QUESTION_MODULES, ...extra });
// Text outside the generated zones (markers included) must never change.
function outsideZones(source) {
  return source.replace(/(JOB_TAXONOMY:(\w+):START[^\n]*\n)[\s\S]*?(\n[^\n]*JOB_TAXONOMY:\2:END)/g, '$1<zone>$3');
}
function evalConst(source, name) {
  const start = source.indexOf(`const ${name} = `);
  const end = source.indexOf('\n', source.indexOf('\n}', start) + 1);
  const expression = source.slice(start, end).replace(/;\s*$/, '');
  return JSON.parse(JSON.stringify(vm.runInNewContext(`${expression};\n${name}`, { YANNIS_SKILLS: [] })));
}
const decode = value => value.replace(/&(amp|lt|gt|quot|#39);/g, (_all, n) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[n]));
function generatedChoices(root) {
  const candidate = text(root, CANDIDATE).replace(/\r\n/g, '\n');
  const recruiter = text(root, RECRUITER).replace(/\r\n/g, '\n');
  const buttons = candidate.match(/id="job-type-opts">([\s\S]*?)\n\s*<\/div>/)[1];
  const chips = recruiter.match(/id="filt-job-types">([\s\S]*?)\n\s*<\/div>/)[1];
  return {
    buttons: [...buttons.matchAll(/toggleTargetJob\('([^']+)',this\)"><span class="ot">([^<]*)</g)].map(m => [m[1], decode(m[2])]),
    chips: [...chips.matchAll(/data-filter-value="([^"]*)"[^>]*>([^<]*)</g)].map(m => [decode(m[1]), decode(m[2])]),
    suggestions: evalConst(candidate, 'PROFILE_PREF_SUGGESTIONS').target_job_types,
    questions: evalConst(candidate, 'PROFILE_QUESTIONS'),
  };
}

test('checked-in HTML is synchronized and generation is idempotent on repository files', () => {
  assert.deepEqual(sync(), { changed: [] });
  for (const file of FILES) {
    const current = historicalFile(file);
    assert.equal(render(file, current), current);
    for (const [, eol] of EOLS) assert.equal(render(file, withEol(current, eol)), withEol(current, eol));
  }
});

for (const [format, eol] of EOLS) {
  test(`A. [${format}] re-indented closing tags cannot make a zone overflow into adjacent HTML`, t => {
    const root = tempRoot(t, eol);
    const marker = '<!-- JOB_TAXONOMY:CANDIDATE_ADN_JOB_BUTTONS:END -->\n      </div>';
    // Original repro: shifting the closing </div> by one space used to swallow the adjacent
    // Continue button (bn-job) and the following steps.
    for (const closing of ['     </div>', '       </div>', '</div>', '\t</div>']) {
      const reindented = replaceOnce(historicalFile(CANDIDATE, eol), marker, marker.replace('      </div>', closing));
      const source = replaceOnce(reindented, ...CANDIDATE_DRIFT);
      fs.writeFileSync(path.join(root, CANDIDATE), source, 'utf8');
      assert.deepEqual(sync({ write: true, root }).changed, [CANDIDATE]);
      const output = text(root, CANDIDATE);
      assert.equal(outsideZones(output), outsideZones(source));
      assert.match(output, /id="bn-job" onclick="continueFromTargetJobs\(\)" disabled>Continuer/);
      assert.match(output, /<div id="ts-primary" style="display:none">/);
      assert.match(output, /selectHuntFarm\('full',this\)/);
      assert.equal(output, reindented, 'only the zone is regenerated, original line endings kept');
    }
  });

  test(`B-F. [${format}] absent, duplicated or inverted markers fail with zero write`, t => {
    const start = '        <!-- JOB_TAXONOMY:CANDIDATE_ADN_JOB_BUTTONS:START -->\n';
    const end = '        <!-- JOB_TAXONOMY:CANDIDATE_ADN_JOB_BUTTONS:END -->\n';
    const cases = {
      'B START absent': [start, ''],
      'C END absent': [end, ''],
      'D START duplicated': [start, start + start],
      'E END duplicated': [end, end + end],
      'marker not alone on its line': [start, '        <b></b><!-- JOB_TAXONOMY:CANDIDATE_ADN_JOB_BUTTONS:START -->\n'],
      'unknown marker': [start, start + '<!-- JOB_TAXONOMY:TYPO_ZONE:START -->\n'],
    };
    for (const [name, [from, to]] of Object.entries(cases)) {
      assertZeroWrite(t, { eol, breakFile: CANDIDATE, from, to, error: /Fix: restore exactly one START and one END marker/ });
      assert.throws(() => render(CANDIDATE, replaceOnce(historicalFile(CANDIDATE, eol), from, to)), JobTaxonomyError, name);
    }
    // F: END before START (the two marker lines swapped).
    const swap = source => replaceOnce(replaceOnce(replaceOnce(source, start, '<<S>>\n'), end, start), '<<S>>\n', end);
    assertZeroWrite(t, { eol, breakFile: CANDIDATE, edit: swap, error: /END \(line \d+\) precedes its START/ });
    assert.throws(() => render(CANDIDATE, swap(historicalFile(CANDIDATE, eol))), /precedes its START/);
    // A duplicated END in the JS region is also refused.
    const jsEnd = '// JOB_TAXONOMY:CANDIDATE_ADN_QUESTIONS:END\n';
    assertZeroWrite(t, { eol, breakFile: CANDIDATE, from: jsEnd, to: jsEnd + jsEnd, error: /found 2 times/ });
  });

  test(`G. [${format}] an error in candidat.html leaves recruteur.html untouched`, t => {
    assertZeroWrite(t, {
      eol, breakFile: CANDIDATE, from: '// JOB_TAXONOMY:CANDIDATE_PROFILE_SUGGESTIONS:END\n', to: '', error: /found 0 times/,
    });
  });

  test(`H. [${format}] an error in recruteur.html after candidat.html was generated in memory: zero write`, t => {
    assertZeroWrite(t, {
      eol, breakFile: RECRUITER, from: '        <!-- JOB_TAXONOMY:RECRUITER_FILTER_CHIPS:END -->\n', to: '', error: /recruteur\.html: marker/,
    });
  });

  test(`H2. [${format}] a filesystem failure while committing rolls back already renamed files`, t => {
    const root = tempRoot(t, eol);
    mutate(root, CANDIDATE, ...CANDIDATE_DRIFT);
    mutate(root, RECRUITER, ...RECRUITER_DRIFT);
    const before = FILES.map(file => bytes(root, file));
    let renames = 0;
    const fsImpl = { ...fs, renameSync(from, to) { if (++renames === 2) throw new Error('disk full'); return fs.renameSync(from, to); } };
    assert.throws(() => sync({ write: true, root, fsImpl }), /disk full/);
    FILES.forEach((file, i) => assert.ok(bytes(root, file).equals(before[i]), file));
    assert.deepEqual(fs.readdirSync(path.join(root, 'frontend/_spaces')).filter(name => name.endsWith('.tmp')), []);
  });

  test(`Q. [${format}] sync twice: second run changes nothing, line endings preserved, check then passes`, t => {
    const root = tempRoot(t, eol);
    mutate(root, CANDIDATE, ...CANDIDATE_DRIFT);
    mutate(root, RECRUITER, ...RECRUITER_DRIFT);
    assert.deepEqual(sync({ write: true, root }).changed, FILES);
    const first = FILES.map(file => bytes(root, file));
    assert.deepEqual(sync({ write: true, root }).changed, []);
    FILES.forEach((file, i) => {
      assert.ok(bytes(root, file).equals(first[i]));
      assert.equal(text(root, file), historicalFile(file, eol), `${file} regenerated to the checked-in content in ${format}`);
    });
    assert.deepEqual(sync({ root }), { changed: [] });
  });
}

test('I-K. ADN modules must match the renderProfileQuestion contract', t => {
  const descriptors = withJobs(FUTURE_JOB);
  const invalid = {
    'I label-only module': { label: 'Métier futur (fixture)' },
    'missing q2': { q1: COMPLETE_MODULE.q1 },
    'module label is generated, not declared': { label: 'Métier futur (fixture)', ...COMPLETE_MODULE },
    'J q1 without text': { ...COMPLETE_MODULE, q1: { options: COMPLETE_MODULE.q1.options } },
    'J q1 blank text': { ...COMPLETE_MODULE, q1: { text: '   ', options: COMPLETE_MODULE.q1.options } },
    'J q2 text not a string': { ...COMPLETE_MODULE, q2: { text: 42, options: COMPLETE_MODULE.q2.options } },
    'J text with newline': { ...COMPLETE_MODULE, q1: { text: 'a\nb', options: COMPLETE_MODULE.q1.options } },
    'K options missing': { ...COMPLETE_MODULE, q1: { text: 'Question ?' } },
    'K options empty': { ...COMPLETE_MODULE, q1: { text: 'Question ?', options: [] } },
    'K single option': { ...COMPLETE_MODULE, q1: { text: 'Question ?', options: ['Oui'] } },
    'K options not an array': { ...COMPLETE_MODULE, q1: { text: 'Question ?', options: 'Oui,Non' } },
    'K undefined option': { ...COMPLETE_MODULE, q1: { text: 'Question ?', options: ['Oui', undefined] } },
    'K empty option': { ...COMPLETE_MODULE, q1: { text: 'Question ?', options: ['Oui', ''] } },
    'K duplicate option': { ...COMPLETE_MODULE, q1: { text: 'Question ?', options: ['Oui', ' oui'.trim().toUpperCase()] } },
    'unknown question key': { ...COMPLETE_MODULE, q3: COMPLETE_MODULE.q1 },
    'module is not an object': 'Métier futur (fixture)',
    'question is null': { ...COMPLETE_MODULE, q1: null },
  };
  for (const [name, module] of Object.entries(invalid)) {
    assertZeroWrite(t, { options: { descriptors, modules: withModules({ fixture_future_job: module }) }, error: /invalid job taxonomy: ADN module "fixture_future_job"/ });
    assert.throws(() => render(CANDIDATE, historicalFile(CANDIDATE), { descriptors, modules: withModules({ fixture_future_job: module }) }), JobTaxonomyError, name);
  }
  // Sparse options: rejected by the contract itself, before any rendering.
  const holes = ['Oui', 'Non', 'Peut-être'];
  delete holes[1];
  for (const options of [holes, new Array(3), ['Oui', , 'Non']]) { // eslint-disable-line no-sparse-arrays
    assert.throws(() => validateAdnModules(createJobTaxonomy(descriptors).JOB_TYPES, withModules({ fixture_future_job: { ...COMPLETE_MODULE, q1: { text: 'Question ?', options } } })),
      /fixture_future_job"\.q1\.options\[\d\]: sparse array \(hole\) is not allowed/);
    assertZeroWrite(t, { options: { descriptors, modules: withModules({ fixture_future_job: { ...COMPLETE_MODULE, q1: { text: 'Question ?', options } } }) }, error: /sparse array \(hole\) is not allowed/ });
  }
  // Historical modules are subject to the same contract.
  const { sdr, ...withoutSdr } = ADN_PROFILE_QUESTION_MODULES;
  assert.ok(sdr);
  assertZeroWrite(t, { options: { modules: withoutSdr }, error: /ADN module "sdr" is missing/ });
  assertZeroWrite(t, { options: { modules: withModules({ typo: COMPLETE_MODULE }) }, error: /"typo" does not match any JOB_TYPES id/ });
});

test('L-N. ID, label and alias collisions are refused before any generation', t => {
  const collisions = {
    'L duplicate id': [{ id: 'ae', label: 'Autre métier' }, /duplicate job id "ae"/],
    'M duplicate label': [{ id: 'x', label: 'Account Executive' }, /label "Account Executive" of "x" collides with label of "ae"/],
    'M label equal after normalization': [{ id: 'x', label: 'account EXECUTIVE' }, /collides with label of "ae"/],
    'M label equal to another id': [{ id: 'x', label: 'KAM' }, /collides with the id of "kam"/],
    'N alias equal to another label': [{ id: 'x', label: 'X', aliases: ['key account manager'] }, /alias "key account manager" of "x" collides with label of "kam"/],
    'N alias equal to another id': [{ id: 'x', label: 'X', aliases: ['Terrain'] }, /collides with the id of "terrain"/],
    'N alias duplicated in the same job': [{ id: 'x', label: 'X', aliases: ['Y', ' y'.trim()] }, /duplicates its own alias/],
    'N alias equal to its own label': [{ id: 'x', label: 'X', aliases: ['x '.trim().toUpperCase()] }, /duplicates its own label/],
  };
  for (const [name, [descriptor, error]] of Object.entries(collisions)) {
    assert.throws(() => createJobTaxonomy(withJobs(descriptor)), error, name);
    const modules = withModules({ x: COMPLETE_MODULE });
    assertZeroWrite(t, { options: { descriptors: withJobs(descriptor), modules: descriptor.id === 'x' ? modules : undefined }, error: /invalid job taxonomy/ });
  }
  // Alias shared by two other jobs: ambiguous resolution.
  assert.throws(() => createJobTaxonomy(withJobs({ id: 'x', label: 'X', aliases: ['Closer'] }, { id: 'y', label: 'Y', aliases: ['closer'] })),
    /alias "closer" of "y" collides with alias of "x"/);
  // Inactive jobs take part in collision checks: their stored values must stay unambiguous.
  assert.throws(() => createJobTaxonomy(withJobs({ id: 'x', label: 'Business developer', active: false })), /collides with label of "bizdev"/);
});

test('O. unsupported labels are refused (line breaks, controls, blanks, size, type)', t => {
  const cr = String.fromCharCode(13);
  const lineSeparator = String.fromCharCode(0x2028);
  const bad = ['Technico\ncommercial', 'Technico' + cr + 'commercial', 'Technico' + lineSeparator + 'commercial', 'Tech\tnico',
    '', '   ', ' Technico', 'Technico ', 'x'.repeat(81), 42, null, undefined];
  for (const label of bad) {
    assert.throws(() => createJobTaxonomy(withJobs({ id: 'fixture_future_job', label })), JobTaxonomyError, JSON.stringify(label));
    assert.throws(() => createJobTaxonomy(withJobs({ id: 'fixture_future_job', label: 'Métier futur (fixture)', aliases: [label] })), JobTaxonomyError);
  }
  assertZeroWrite(t, {
    options: { descriptors: withJobs({ ...FUTURE_JOB, label: 'Technico\ncommercial' }), modules: withModules({ fixture_future_job: COMPLETE_MODULE }) },
    error: /line breaks \(CR\/LF\) are not allowed/,
  });
  assert.doesNotThrow(() => createJobTaxonomy(withJobs({ id: 'y', label: 'y'.repeat(80) })));
});

test('P. special characters are escaped and restored exactly in HTML and JS', t => {
  const labels = [
    `L'équipe "Grands comptes" & <Export> \\ </script><!--`,
    `Chef d'équipe`,
    `Ingénieur "avant-vente"`,
    `A&B <b>x</b> \\n </SCRIPT >`,
  ];
  const descriptors = withJobs(...labels.map((label, i) => ({ id: `special_${i}`, label })));
  const modules = withModules(Object.fromEntries(labels.map((label, i) => [`special_${i}`, {
    q1: { text: `${label} ?`, options: [label, `${label} (bis)`] },
    q2: COMPLETE_MODULE.q2,
  }])));
  const root = tempRoot(t);
  const scriptCloses = FILES.map(file => (text(root, file).match(/<\/script/gi) || []).length);
  sync({ write: true, root, descriptors, modules });
  FILES.forEach((file, i) => assert.equal((text(root, file).match(/<\/script/gi) || []).length, scriptCloses[i], `${file}: no injected </script`));
  const expectedLabels = [...JOB_TYPE_DESCRIPTORS.map(job => job.label), ...labels];
  const choices = generatedChoices(root);
  assert.deepEqual(choices.buttons.map(([, label]) => label), expectedLabels);
  assert.deepEqual(choices.chips, expectedLabels.map(label => [label, label]));
  assert.deepEqual(choices.suggestions, expectedLabels);
  labels.forEach((label, i) => {
    assert.equal(choices.questions[`special_${i}`].label, label);
    assert.equal(choices.questions[`special_${i}`].q1.text, `${label} ?`);
    assert.deepEqual(choices.questions[`special_${i}`].q1.options, [label, `${label} (bis)`]);
  });
  // Every inline script still compiles, and re-running is a no-op.
  for (const file of FILES) {
    for (const match of text(root, file).matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(match[1]);
  }
  assert.deepEqual(sync({ write: true, root, descriptors, modules }).changed, []);
});

test('check mode detects drift and names the exact fix without writing', t => {
  const root = tempRoot(t);
  mutate(root, RECRUITER, ...RECRUITER_DRIFT);
  const before = bytes(root, RECRUITER);
  assert.throws(() => sync({ root }), /recruteur\.html out of date with the job taxonomy .*npm --prefix backend run taxonomy:sync/);
  assert.ok(bytes(root, RECRUITER).equals(before));
  // A registry change without sync is detected the same way.
  const descriptors = withJobs(FUTURE_JOB);
  assert.throws(() => sync({ root: tempRoot(t), descriptors, modules: withModules({ fixture_future_job: COMPLETE_MODULE }) }),
    /candidat\.html, frontend\/_spaces\/recruteur\.html out of date/);
});

test('CLI check exits 0 on the repository and prints a clear status', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, '../scripts/sync-job-taxonomy.js')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Job taxonomy HTML is synchronized/);
});

test('future job simulation: fixture_future_job (fixture/temp only)', t => {
  const descriptors = withJobs(FUTURE_JOB);
  // CAS 1: no ADN module.
  assertZeroWrite(t, { options: { descriptors }, error: /ADN module "fixture_future_job" is missing/ });
  // CAS 2: label-only module.
  assertZeroWrite(t, { options: { descriptors, modules: withModules({ fixture_future_job: { label: 'Métier futur (fixture)' } }) }, error: /q1 is missing/ });
  // CAS 3: structurally complete module -> generation in a temporary copy only.
  const modules = withModules({ fixture_future_job: COMPLETE_MODULE });
  const root = tempRoot(t);
  assert.deepEqual(sync({ write: true, root, descriptors, modules }).changed, FILES);
  const choices = generatedChoices(root);
  const labels = [...JOB_TYPE_DESCRIPTORS.map(job => job.label), 'Métier futur (fixture)'];
  assert.deepEqual(choices.buttons, [...JOB_TYPE_DESCRIPTORS.map(job => [job.id, job.label]), ['fixture_future_job', 'Métier futur (fixture)']]);
  assert.deepEqual(choices.chips.map(([value]) => value), labels);
  assert.deepEqual(choices.suggestions, labels);
  assert.deepEqual(Object.keys(choices.questions), [...JOB_TYPE_DESCRIPTORS.map(job => job.id), 'fixture_future_job']);
  assert.deepEqual(choices.questions.fixture_future_job, { label: 'Métier futur (fixture)', ...COMPLETE_MODULE });
  for (const id of JOB_TYPE_DESCRIPTORS.map(job => job.id)) {
    assert.deepEqual(choices.questions[id], JSON.parse(JSON.stringify({ label: JOB_TYPE_DESCRIPTORS.find(job => job.id === id).label, ...ADN_PROFILE_QUESTION_MODULES[id] })));
  }
  // Storage formats are unchanged: ADN poste stores the ID, profile/offer columns store the label.
  const fixture = createJobTaxonomy(descriptors);
  assert.equal(fixture.jobTypeById('fixture_future_job').label, 'Métier futur (fixture)');
  assert.equal(fixture.canonicalizeTargetJobType(' métier FUTUR (fixture) '), 'Métier futur (fixture)');
  assert.equal(fixture.canonicalizeTargetJobType('fixture_future_job'), null);
  assert.deepEqual(fixture.TARGET_JOB_TYPES, labels);
  for (const job of JOB_TYPE_DESCRIPTORS) assert.equal(fixture.jobTypeById(job.id).label, job.label);
  // The real registry and checked-in HTML are untouched by the simulation.
  assert.equal(JOB_TYPE_DESCRIPTORS.length, 15);
  assert.deepEqual(JOB_TYPE_DESCRIPTORS.map(job => job.id).filter(id => HISTORICAL_IDS.includes(id)), HISTORICAL_IDS);
  assert.deepEqual(sync(), { changed: [] });
});

test('inactive jobs are not generated as new choices and need no ADN module', t => {
  const descriptors = withJobs({ id: 'fixture_retired', label: 'Fixture retired', active: false });
  const root = tempRoot(t);
  assert.deepEqual(sync({ write: true, root, descriptors }).changed, []);
  const choices = generatedChoices(root);
  assert.equal(choices.buttons.length, JOB_TYPE_DESCRIPTORS.length);
  assert.equal(choices.suggestions.includes('Fixture retired'), false);
});

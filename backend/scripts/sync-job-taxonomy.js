// Checked-in HTML generation: no browser request, runtime import or UI change.
//
// Boundaries are ONLY explicit marker comments, e.g.
//   <!-- JOB_TAXONOMY:CANDIDATE_ADN_JOB_BUTTONS:START --> ... <!-- ...:END -->
//   // JOB_TAXONOMY:CANDIDATE_ADN_QUESTIONS:START ... // ...:END
// Each marker must appear exactly once, alone on its line, START before END,
// zones never nest. Everything strictly between the two marker lines is
// regenerated; nothing outside them is ever touched.
//
// Transactional: read every file, validate the taxonomy and ADN modules, render
// and validate every output in memory; only then write (temp file + rename,
// rollback on failure). Any validation error => zero file modified.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { isDeepStrictEqual } = require('node:util');
const { JOB_TYPE_DESCRIPTORS } = require('../utils/yannisTaxonomies');
const { createJobTaxonomy, JobTaxonomyError, JOB_TYPE_ID_PATTERN } = require('../utils/jobTaxonomy');
const { ADN_PROFILE_QUESTION_MODULES, ADN_QUESTION_KEYS, validateAdnModules } = require('../utils/adnProfileQuestions');

const ROOT = path.resolve(__dirname, '../..');
const CANDIDATE_FILE = 'frontend/_spaces/candidat.html';
const RECRUITER_FILE = 'frontend/_spaces/recruteur.html';
const FILES = Object.freeze([CANDIDATE_FILE, RECRUITER_FILE]);
const SYNC_HINT = 'run "npm --prefix backend run taxonomy:sync" and commit the regenerated HTML';
const MARKER_TOKEN = /JOB_TAXONOMY:([A-Za-z0-9_]*):([A-Za-z]*)/g;

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function decodeHtml(text) {
  return text.replace(/&(amp|lt|gt|quot|#39);/g, (_all, name) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[name]));
}
// JS string literal safe inside an inline <script>: `<` is escaped so that
// "</script" or "<!--" can never appear; line terminators are escaped too.
// Quote choice mirrors the historical source (single, double if apostrophe).
function quoteJs(text) {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = quote;
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (char === '\\' || char === quote) out += '\\' + char;
    else if (char === '<' || code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029) {
      out += '\\u' + code.toString(16).padStart(4, '0');
    } else out += char;
  }
  return out + quote;
}

const renderAdnButtons = ({ jobs }) => jobs.map(job =>
  `<button class="opt" onclick="selectJobType('${job.id}',this)"><span class="ot">${escapeHtml(job.label)}</span></button>`);
const renderProfileSuggestions = ({ jobs }) => [jobs.map(job => quoteJs(job.label)).join(', ') + ','];
const renderQuestion = question =>
  `{ text: ${quoteJs(question.text)}, options: [${question.options.map(quoteJs).join(', ')}] }`;
const renderAdnQuestions = ({ jobs, modules }) => [
  'const PROFILE_QUESTIONS = {',
  ...jobs.flatMap(job => [
    `  ${job.id}: {`,
    `    label: ${quoteJs(job.label)},`,
    ...ADN_QUESTION_KEYS.map(key => `    ${key}: ${renderQuestion(modules[job.id][key])},`),
    '  },',
  ]),
  '};',
];
const renderRecruiterChips = ({ jobs }) => jobs.map(job =>
  `<button type="button" class="form-chip" data-filter-value="${escapeHtml(job.label)}" onclick="toggleCandFilterChip(this)">${escapeHtml(job.label)}</button>`);

// Post-render validation: the generated text must decode back to exactly the
// expected data (no escaping loss, no syntax break).
function parseButtons(content, pattern) {
  const lines = content.split('\n').filter(line => line.trim());
  return lines.map(line => {
    const match = line.trim().match(pattern);
    if (!match) throw new JobTaxonomyError(`generated line is not a well-formed button: ${line.trim()}`);
    return match.slice(1).map(decodeHtml);
  });
}
const expectLabels = (actual, jobs, zone) => {
  if (!isDeepStrictEqual(actual, jobs.map(job => job.label))) throw new JobTaxonomyError(`${zone}: generated labels do not round-trip`);
};
function assertNoScriptBreak(content, zone) {
  if (/<\/script|<!--/i.test(content)) throw new JobTaxonomyError(`${zone}: generated JS contains "</script" or "<!--"`);
}

const ZONES = Object.freeze({
  [CANDIDATE_FILE]: Object.freeze([
    {
      name: 'CANDIDATE_ADN_JOB_BUTTONS',
      syntax: 'html',
      render: renderAdnButtons,
      verify(content, { jobs }) {
        const parsed = parseButtons(content, /^<button class="opt" onclick="selectJobType\('([a-z][a-z0-9_]*)',this\)"><span class="ot">([^<>]*)<\/span><\/button>$/);
        if (!isDeepStrictEqual(parsed, jobs.map(job => [job.id, job.label]))) throw new JobTaxonomyError('CANDIDATE_ADN_JOB_BUTTONS: generated IDs/labels do not round-trip');
      },
    },
    {
      name: 'CANDIDATE_PROFILE_SUGGESTIONS',
      syntax: 'js',
      render: renderProfileSuggestions,
      verify(content, { jobs }) {
        assertNoScriptBreak(content, 'CANDIDATE_PROFILE_SUGGESTIONS');
        // JSON round-trip drops the vm realm's prototypes before comparison.
        expectLabels(JSON.parse(JSON.stringify(vm.runInNewContext(`[\n${content}\n]`))), jobs, 'CANDIDATE_PROFILE_SUGGESTIONS');
      },
    },
    {
      name: 'CANDIDATE_ADN_QUESTIONS',
      syntax: 'js',
      render: renderAdnQuestions,
      verify(content, { jobs, modules }) {
        assertNoScriptBreak(content, 'CANDIDATE_ADN_QUESTIONS');
        const actual = vm.runInNewContext(`${content}\nPROFILE_QUESTIONS`);
        const expected = Object.fromEntries(jobs.map(job => [job.id, {
          label: job.label,
          ...Object.fromEntries(ADN_QUESTION_KEYS.map(key => [key, { text: modules[job.id][key].text, options: [...modules[job.id][key].options] }])),
        }]));
        if (!isDeepStrictEqual(JSON.parse(JSON.stringify(actual)), expected)) throw new JobTaxonomyError('CANDIDATE_ADN_QUESTIONS: generated modules do not round-trip');
      },
    },
  ]),
  [RECRUITER_FILE]: Object.freeze([
    {
      name: 'RECRUITER_FILTER_CHIPS',
      syntax: 'html',
      render: renderRecruiterChips,
      verify(content, { jobs }) {
        const parsed = parseButtons(content, /^<button type="button" class="form-chip" data-filter-value="([^<>"]*)" onclick="toggleCandFilterChip\(this\)">([^<>]*)<\/button>$/);
        if (!parsed.every(([value, text]) => value === text)) throw new JobTaxonomyError('RECRUITER_FILTER_CHIPS: value/text mismatch');
        expectLabels(parsed.map(([value]) => value), jobs, 'RECRUITER_FILTER_CHIPS');
      },
    },
  ]),
});

function markerLine(syntax, name, kind) {
  return syntax === 'html' ? `<!-- JOB_TAXONOMY:${name}:${kind} -->` : `// JOB_TAXONOMY:${name}:${kind}`;
}
function markerError(file, message) {
  return new JobTaxonomyError(`${file}: ${message}. Fix: restore exactly one START and one END marker line per zone ` +
    '(see backend/JOB_TAXONOMY.md); nothing was written');
}

/** Locate every zone of `file` in LF text; throws on any marker ambiguity. */
function locateZones(file, text, zones) {
  const known = new Map(zones.map(zone => [zone.name, zone]));
  const counts = new Map();
  for (const match of text.matchAll(MARKER_TOKEN)) {
    const [, name, kind] = match;
    if (!known.has(name) || (kind !== 'START' && kind !== 'END')) throw markerError(file, `unknown marker "${match[0]}"`);
    const key = `${name}:${kind}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const lines = text.split('\n');
  const findLine = (zone, kind) => {
    const count = counts.get(`${zone.name}:${kind}`) || 0;
    if (count !== 1) throw markerError(file, `marker JOB_TAXONOMY:${zone.name}:${kind} found ${count} times (expected exactly 1)`);
    const expected = markerLine(zone.syntax, zone.name, kind);
    const index = lines.findIndex(line => line.includes(`JOB_TAXONOMY:${zone.name}:${kind}`));
    if (lines[index].trim() !== expected) throw markerError(file, `marker line ${index + 1} must be exactly "${expected}" alone on its line`);
    return index;
  };
  const located = zones.map(zone => {
    const start = findLine(zone, 'START');
    const end = findLine(zone, 'END');
    if (end <= start) throw markerError(file, `JOB_TAXONOMY:${zone.name}:END (line ${end + 1}) precedes its START (line ${start + 1})`);
    return { zone, start, end, indent: lines[start].match(/^[ \t]*/)[0] };
  }).sort((a, b) => a.start - b.start);
  for (let i = 1; i < located.length; i += 1) {
    if (located[i].start < located[i - 1].end) throw markerError(file, `zones ${located[i - 1].zone.name} and ${located[i].zone.name} overlap`);
  }
  return { lines, located };
}

function splitNewlines(file, input) {
  const crlf = (input.match(/\r\n/g) || []).length;
  const lf = (input.match(/\n/g) || []).length;
  if (/\r(?!\n)/.test(input) || (crlf && crlf !== lf)) throw new JobTaxonomyError(`${file}: mixed line endings; normalize the file before running taxonomy:sync`);
  return { newline: crlf ? '\r\n' : '\n', text: input.replace(/\r\n/g, '\n') };
}

function renderText(file, text, context) {
  const zones = ZONES[file];
  if (!zones) throw new JobTaxonomyError(`Unknown taxonomy consumer ${file}`);
  const { lines, located } = locateZones(file, text, zones);
  const out = [];
  let cursor = 0;
  for (const { zone, start, end, indent } of located) {
    out.push(...lines.slice(cursor, start + 1));
    out.push(...zone.render(context).map(line => indent + line));
    cursor = end;
  }
  out.push(...lines.slice(cursor));
  return out.join('\n');
}

function verifyOutput(file, text, context) {
  const { lines, located } = locateZones(file, text, ZONES[file]);
  for (const { zone, start, end } of located) {
    const content = lines.slice(start + 1, end).map(line => line.trim()).join('\n');
    try {
      zone.verify(content, context);
    } catch (error) {
      if (error instanceof JobTaxonomyError) throw new JobTaxonomyError(`${file}: ${error.message}`);
      throw new JobTaxonomyError(`${file}: generated ${zone.name} is invalid (${error.message})`);
    }
  }
  if (renderText(file, text, context) !== text) throw new JobTaxonomyError(`${file}: generation is not idempotent`);
  // Every inline script of the output must still compile.
  const scripts = /<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of text.matchAll(scripts)) {
    try { new vm.Script(match[1]); } catch (error) {
      throw new JobTaxonomyError(`${file}: generated output breaks an inline script (${error.message})`);
    }
  }
}

/** Validates taxonomy + ADN modules and returns the render context. */
function buildContext({ descriptors = JOB_TYPE_DESCRIPTORS, modules = ADN_PROFILE_QUESTION_MODULES } = {}) {
  let taxonomy;
  try {
    taxonomy = createJobTaxonomy(descriptors);
    validateAdnModules(taxonomy.JOB_TYPES, modules);
  } catch (error) {
    if (!(error instanceof JobTaxonomyError)) throw error;
    throw new JobTaxonomyError(`invalid job taxonomy: ${error.message}. Fix JOB_TYPE_DESCRIPTORS in backend/utils/yannisTaxonomies.js ` +
      'or the modules in backend/utils/adnProfileQuestions.js; nothing was written');
  }
  const jobs = taxonomy.activeJobTypes();
  // Defense in depth: IDs are interpolated into onclick attributes and object keys.
  for (const job of jobs) if (!JOB_TYPE_ID_PATTERN.test(job.id)) throw new JobTaxonomyError(`Unsafe job ID ${job.id}`);
  return { jobs, modules };
}

/** Pure: expected content of one consumer file (throws on any invalid input). */
function render(file, input, options) {
  const context = buildContext(options);
  const { newline, text } = splitNewlines(file, input);
  const output = renderText(file, text, context);
  verifyOutput(file, output, context);
  return output.replace(/\n/g, newline);
}

function commitAll(changes, fsImpl) {
  const suffix = `.taxonomy-${process.pid}-${Date.now()}.tmp`;
  const staged = [];
  try {
    for (const change of changes) {
      const tmp = change.filename + suffix;
      fsImpl.writeFileSync(tmp, change.expected, { encoding: 'utf8', flag: 'wx' });
      staged.push(tmp);
    }
  } catch (error) {
    for (const tmp of staged) { try { fsImpl.unlinkSync(tmp); } catch { /* best effort */ } }
    throw error;
  }
  const committed = [];
  try {
    changes.forEach((change, i) => {
      fsImpl.renameSync(staged[i], change.filename);
      committed.push(change);
    });
  } catch (error) {
    for (const change of committed) fsImpl.writeFileSync(change.filename, change.current, 'utf8');
    for (const tmp of staged.slice(committed.length)) { try { fsImpl.unlinkSync(tmp); } catch { /* best effort */ } }
    throw error;
  }
}

/**
 * check (default): throws if any consumer differs from generation.
 * write: regenerates all consumers atomically. Returns { changed: [file...] }.
 */
function sync({ write = false, root = ROOT, fsImpl = fs, ...options } = {}) {
  const inputs = FILES.map(file => {
    const filename = path.join(root, file);
    return { file, filename, current: fsImpl.readFileSync(filename, 'utf8') };
  });
  const context = buildContext(options);
  const changes = inputs.map(input => {
    const { newline, text } = splitNewlines(input.file, input.current);
    const output = renderText(input.file, text, context);
    verifyOutput(input.file, output, context);
    return { ...input, expected: output.replace(/\n/g, newline) };
  }).filter(change => change.expected !== change.current);
  if (changes.length && !write) {
    throw new JobTaxonomyError(`${changes.map(change => change.file).join(', ')} out of date with the job taxonomy ` +
      `(JOB_TYPES or ADN modules changed, or generated zones were edited by hand): ${SYNC_HINT}`);
  }
  if (changes.length) commitAll(changes, fsImpl);
  return { changed: changes.map(change => change.file) };
}

function main(argv = process.argv) {
  const write = argv.includes('--write');
  try {
    const { changed } = sync({ write });
    console.log(changed.length ? `Job taxonomy HTML regenerated: ${changed.join(', ')}` : 'Job taxonomy HTML is synchronized');
  } catch (error) {
    console.error(`taxonomy:${write ? 'sync' : 'check'} failed: ${error.message}`);
    if (!(error instanceof JobTaxonomyError)) console.error(error.stack);
    process.exitCode = 1;
  }
}

if (require.main === module) main();
module.exports = { FILES, ZONES, SYNC_HINT, escapeHtml, quoteJs, render, sync, main };

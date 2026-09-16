const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const jsonBodyParser = require('../middleware/jsonBodyParser');
const apiErrorHandler = require('../middleware/apiErrorHandler');

const html = fs.readFileSync(path.join(__dirname, '../../frontend/_spaces/candidat.html'), 'utf8');
function sourceBetween(start, end) {
  const first = html.indexOf(start);
  const last = html.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `${start} not found`);
  return html.slice(first, last);
}

async function withServer(fn) {
  const app = express();
  app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
  app.use(jsonBodyParser);
  app.post('/api/stripe/webhook', (req, res) => res.json({ raw: Buffer.isBuffer(req.body) }));
  app.post('/api/assistant/cv-analyses', (req, res) => res.json({ reached: true, chars: req.body.source_text.length }));
  app.post('/api/assistant/conversations', (req, res) => res.json({ reached: true, hasCv: Object.hasOwn(req.body, 'cv_text') }));
  app.post('/api/other', (_req, res) => res.json({ reached: true }));
  app.use(apiErrorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try { await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('CV multibyte >100 KiB reaches assistant route; other routes retain default limit', async () => {
  const body = JSON.stringify({ source_text: '界'.repeat(30000), offer_text: '界'.repeat(20000) });
  assert.ok(Buffer.byteLength(body) > 100 * 1024);
  assert.ok(Buffer.byteLength(body) < jsonBodyParser.ASSISTANT_JSON_LIMIT_BYTES);
  await withServer(async base => {
    const accepted = await fetch(base + '/api/assistant/cv-analyses', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { reached: true, chars: 30000 });
    const standard = await fetch(base + '/api/other', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal(standard.status, 413);
    assert.match((await standard.json()).error, /volumineux/i);
    const coach = await fetch(base + '/api/assistant/conversations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ use_cv: true, cv_text: '界'.repeat(30000), offer_text: '界'.repeat(20000) }) });
    assert.equal(coach.status, 200);
    assert.deepEqual(await coach.json(), { reached: true, hasCv: true });
  });
});

test('assistant oversized JSON returns 413 JSON; Stripe webhook remains raw', async () => {
  await withServer(async base => {
    const oversized = JSON.stringify({ source_text: 'x'.repeat(jsonBodyParser.ASSISTANT_JSON_LIMIT_BYTES) });
    const originalError = console.error;
    console.error = () => {};
    try {
      const rejected = await fetch(base + '/api/assistant/cv-analyses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: oversized });
      assert.equal(rejected.status, 413);
      assert.match((await rejected.json()).error, /volumineux/i);
    } finally { console.error = originalError; }
    const stripe = await fetch(base + '/api/stripe/webhook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"sample":true}' });
    assert.deepEqual(await stripe.json(), { raw: true });
  });
});

test('Coach omits even a huge CV when unchecked, includes bounded CV when checked', () => {
  const fields = {
    'coach-use-cv': { checked: false },
    'coach-use-profile': { checked: true },
    'coach-offer-text': { value: 'Offre fictive' },
    'cv-source-text': { value: 'x'.repeat(400000) },
  };
  const sandbox = { document: { getElementById: id => fields[id] } };
  vm.runInNewContext(`${sourceBetween('function coachConversationPayload(', 'async function createCoachConversation()')}\nthis.build = coachConversationPayload;`, sandbox);
  let payload = sandbox.build('interview');
  assert.equal(payload.use_cv, false);
  assert.equal(Object.hasOwn(payload, 'cv_text'), false);
  assert.equal(payload.use_profile, true);
  assert.equal(payload.offer_text, 'Offre fictive');
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) < 100 * 1024);
  fields['coach-use-cv'].checked = true;
  assert.throws(() => sandbox.build('interview'), /30 000/);
  fields['cv-source-text'].value = 'x'.repeat(30000);
  payload = sandbox.build('interview');
  assert.equal(payload.cv_text.length, 30000);
});

test('Coach creation sends the bounded payload and preserves profile/offer settings', async () => {
  const fields = {
    'coach-use-cv': { checked: false },
    'coach-use-profile': { checked: true },
    'coach-offer-text': { value: 'Offre fictive' },
    'cv-source-text': { value: 'x'.repeat(400000) },
  };
  const sent = [];
  const sandbox = {
    COACH_MODE: 'interview', AI_AVAILABLE: true, COACH_ALLOWED: true,
    COACH_OPENERS: { interview: 'Bonjour' },
    document: { getElementById: id => fields[id] },
    setBtn: () => {}, setFeedback: () => {},
    api: async (_method, _path, body) => { sent.push(body); return { id: 'fiction', messages: [] }; },
    showCoachConversation: () => {}, sendCoachContent: async () => {}, refreshCoachHistory: async () => {},
  };
  vm.runInNewContext(`${sourceBetween('function coachConversationPayload(', 'function showCoachConversation(')}\nthis.create = createCoachConversation;`, sandbox);
  await sandbox.create();
  assert.equal(sent.length, 1);
  assert.equal(Object.hasOwn(sent[0], 'cv_text'), false);
  assert.equal(sent[0].use_profile, true);
  assert.equal(sent[0].offer_text, 'Offre fictive');
});

test('Coach restart omits CV when unchecked and sends it when checked', async () => {
  const fields = {
    'coach-use-cv': { checked: false }, 'coach-use-profile': { checked: false },
    'coach-offer-text': { value: '' }, 'cv-source-text': { value: 'x'.repeat(30000) },
    'coach-messages': { innerHTML: '' },
  };
  const sent = [];
  const sandbox = {
    COACH_MODE: 'pitch', COACH_MODE_LABELS: { pitch: 'Pitch' },
    COACH_OPENERS: { pitch: 'Bonjour' }, AI_AVAILABLE: true, COACH_ALLOWED: true,
    ACTIVE_CONVERSATION_ID: 'old', document: { getElementById: id => fields[id] },
    api: async (method, route, body) => {
      if (method === 'POST') { sent.push({ route, body }); return { id: 'new', messages: [] }; }
      return {};
    },
    setBtn: () => {}, toast: () => {}, showCoachSetup: () => {},
    showCoachConversation: () => {}, sendCoachContent: async () => {}, refreshCoachHistory: async () => {},
  };
  vm.runInNewContext(`${sourceBetween('function coachConversationPayload(', 'async function createCoachConversation()')}\n${sourceBetween('async function restartCoachConversation()', '// ------------------------------------------------------------')}\nthis.restart = restartCoachConversation;`, sandbox);
  await sandbox.restart();
  assert.equal(sent[0].route, '/assistant/conversations');
  assert.equal(Object.hasOwn(sent[0].body, 'cv_text'), false);
  assert.equal(sent[0].body.use_profile, false);
  fields['coach-use-cv'].checked = true;
  await sandbox.restart();
  assert.equal(sent[1].body.cv_text.length, 30000);
});

test('ADN failures leave a final DOM state, distinguish business, network, server and local errors', async () => {
  const status = { textContent: '' };
  const notices = [];
  const heading = { textContent: 'Analyse en cours' };
  const description = { textContent: 'Calcul en cours' };
  const bar = { style: { display: '' } };
  const panel = { style: { display: 'block' }, querySelector: selector => ({ h3: heading, p: description, '.ana-bar': bar })[selector] };
  const elements = {
    as: status, 'ana-block': panel, 'res-block': { style: { display: 'none' } },
    'test-sl': { textContent: 'Analyse en cours' },
    'test-st': { textContent: 'Calcul de votre ADN Commercial' },
    'test-pf': { style: { display: '', width: '100%' } },
  };
  let failure = null;
  let calls = 0;
  const sandbox = {
    ADN: {}, TEST_JOB_TYPE: 'test', PROFILE_QUESTIONS: {}, TEST_HUNT_FARM: '', TEST_PROFILE_ANSWERS: {},
    document: { getElementById: id => elements[id] }, toast: value => notices.push(value),
    api: async () => { calls += 1; if (failure) throw failure; return {}; },
    renderResult: () => { throw new Error('local render error'); },
  };
  vm.runInNewContext(`${sourceBetween('async function submitToAPI()', 'function resultAxisColor(')}\nthis.submit = submitToAPI;`, sandbox);
  failure = Object.assign(new Error('Prochaine évaluation disponible le 09/03/2027'), { error: 'RETAKE_TOO_SOON', status: 403, next_eligible_at: '2027-03-09T12:41:19.018Z' });
  await sandbox.submit();
  assert.match(status.textContent, /09\/03\/2027/);
  assert.doesNotMatch(notices.at(-1), /connexion/i);
  assert.equal(heading.textContent, 'Résultat indisponible');
  assert.equal(elements['test-sl'].textContent, 'Évaluation indisponible');
  assert.equal(elements['test-st'].textContent, 'Résultat indisponible');
  assert.equal(bar.style.display, 'none');
  assert.equal(elements['test-pf'].style.display, 'none');
  assert.equal(panel.style.display, 'block');
  assert.equal(elements['res-block'].style.display, 'none');
  assert.equal(calls, 1);
  failure = Object.assign(new TypeError('Failed to fetch'), { code: 'NETWORK_ERROR' });
  await sandbox.submit();
  assert.match(status.textContent, /connexion/i);
  failure = Object.assign(new Error('server'), { status: 500 });
  await sandbox.submit();
  assert.doesNotMatch(status.textContent, /connexion/i);
  failure = Object.assign(new Error('invalid JSON'), { code: 'RESPONSE_UNREADABLE', status: 200 });
  await sandbox.submit();
  assert.doesNotMatch(status.textContent, /connexion/i);
  failure = null;
  await sandbox.submit();
  assert.match(status.textContent, /pas pu être terminée/);
  assert.doesNotMatch(status.textContent, /connexion/i);
  assert.equal(calls, 5);
});

test('api marks only a rejected fetch TypeError as a network error', async () => {
  const sandbox = {
    API: 'https://example.invalid', TOKEN: '',
    fetch: async () => { throw new TypeError('Failed to fetch'); },
  };
  vm.runInNewContext(`${sourceBetween('async function api(method, path, body, allowRefresh = true, fetchOpts = null)', 'async function apiUp(')}\nthis.callApi = api;`, sandbox);
  await assert.rejects(sandbox.callApi('POST', '/ai/score-adn', {}), error => error.code === 'NETWORK_ERROR');
  const cyclic = {}; cyclic.self = cyclic;
  await assert.rejects(sandbox.callApi('POST', '/ai/score-adn', cyclic), error => error.code !== 'NETWORK_ERROR');
  sandbox.fetch = async () => ({ status: 500, ok: false, text: async () => '{"error":"SERVER_ERROR"}' });
  await assert.rejects(sandbox.callApi('POST', '/ai/score-adn', {}), error => error.code !== 'NETWORK_ERROR' && error.status === 500);
});

test('CV programmatic text length is checked before assistant request', async () => {
  const fields = {
    'cv-source-text': { value: 'x'.repeat(30001) },
    'cv-offer-text': { value: '' },
  };
  const feedback = [];
  const sandbox = {
    CV_ALLOWED: true, CV_ANALYSING: false,
    document: { getElementById: id => fields[id] },
    setFeedback: (...args) => feedback.push(args),
    api: () => assert.fail('oversized CV sent'),
  };
  vm.runInNewContext(`${sourceBetween('async function analyseCVWithAI()', 'async function saveImprovedCV()')}\nthis.analyse = analyseCVWithAI;`, sandbox);
  await sandbox.analyse();
  assert.match(feedback[0][1], /30 000/);
});

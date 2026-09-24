const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '../../frontend/_spaces/candidat.html'), 'utf8');
function section(start, end) { return html.slice(html.indexOf(start), html.indexOf(end, html.indexOf(start))); }
function harness() {
  const elements = new Map();
  const node = id => {
    if (!elements.has(id)) elements.set(id, { value: '', disabled: false, hidden: true, scrolls: 0, scrollIntoView() { this.scrolls++; }, setAttribute() {} });
    return elements.get(id);
  };
  let deadline;
  let clears = 0;
  const feedback = [];
  const context = {
    API: 'https://example.invalid', TOKEN: 'test', FormData, AbortController,
    CV_ALLOWED: true, CV_ANALYSING: false, AI_AVAILABLE: true,
    document: { getElementById: node },
    setTimeout: fn => { deadline = fn; return 1; }, clearTimeout: () => { clears++; },
    setFeedback: (id, message, error) => feedback.push({ id, message, error }),
    setBtn: (id, loading) => { node(id).disabled = loading; },
    startCvWaiting: () => { node('cv-waiting').hidden = false; },
    stopCvWaiting: () => { node('cv-waiting').hidden = true; },
    syncCvJourney: () => {}, renderCVAnalysis: () => {}, refreshAccessToken: async () => false,
  };
  vm.createContext(context);
  vm.runInContext(section('const CV_REQUEST_TIMEOUT_MS', 'async function loadCVTool()') + '\n' + section('async function analyseCVWithAI()', 'async function saveImprovedCV()'), context);
  node('cv-source-text').value = 'Expérience commerciale et prospection. '.repeat(10);
  return { context, node, feedback, timeout: () => deadline(), clears: () => clears };
}
const response = (status, raw) => ({ status, ok: status < 400, text: async () => raw });
test('CV transport distinguishes HTTP, malformed JSON, fetch/body rejection and local serialization errors', async () => {
  const { context: c, clears } = harness();
  for (const status of [401, 403, 413, 429, 500, 503]) {
    c.fetch = async () => response(status, '<html>bad gateway</html>');
    await assert.rejects(c.cvRequest('POST', '/cv', {}), e => e.status === status && e.code !== 'NETWORK_ERROR');
  }
  for (const raw of ['{bad', 'null', '"text"', '']) {
    c.fetch = async () => response(200, raw);
    await assert.rejects(c.cvRequest('POST', '/cv', {}), { code: 'RESPONSE_UNREADABLE' });
  }
  c.fetch = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(c.cvRequest('POST', '/cv', {}), { code: 'NETWORK_ERROR' });
  c.fetch = async () => ({ text: async () => { throw new TypeError('body lost'); } });
  await assert.rejects(c.cvRequest('POST', '/cv', {}), { code: 'NETWORK_ERROR' });
  const circular = {}; circular.self = circular;
  await assert.rejects(c.cvRequest('POST', '/cv', circular), e => e.name === 'TypeError' && !e.code);
  assert.equal(clears(), 13);
});
test('75s deadline aborts fetch, including a stuck auth refresh, with no automatic duplicate request', async () => {
  const h = harness(); let signal; let calls = 0;
  h.context.fetch = async (_url, options) => { signal = options.signal; calls++; return new Promise(() => {}); };
  const pending = h.context.cvRequest('POST', '/cv', {});
  h.timeout();
  await assert.rejects(pending, { code: 'CV_REQUEST_TIMEOUT' });
  assert.equal(signal.aborted, true); assert.equal(calls, 1); assert.equal(h.clears(), 1);
  h.context.fetch = async () => response(401, '{}');
  h.context.refreshAccessToken = async () => new Promise(() => {});
  const refreshPending = h.context.cvRequest('POST', '/cv', {});
  await new Promise(resolve => setImmediate(resolve));
  h.timeout();
  await assert.rejects(refreshPending, { code: 'CV_REQUEST_TIMEOUT' });
  assert.match(section('const CV_REQUEST_TIMEOUT_MS', 'let CV_IMPORTING'), /75000/);
});
test('blocking CV/offer lengths stop before network and scroll the actionable error into view', async () => {
  const h = harness(); h.context.fetch = () => assert.fail('must not fetch');
  for (const length of [0, 199, 30001]) {
    h.node('cv-source-text').value = 'a'.repeat(length);
    await h.context.analyseCVWithAI();
    assert.equal(h.feedback.at(-1).error, true);
    if (length > 30000) assert.match(h.feedback.at(-1).message, /30001.*30 000/);
  }
  h.node('cv-source-text').value = 'a'.repeat(200);
  h.node('cv-offer-text').value = 'a'.repeat(20001);
  await h.context.analyseCVWithAI();
  assert.match(h.feedback.at(-1).message, /20 000.*Réduisez/);
  assert.equal(h.node('cv-analysis-feedback').scrolls, 4);
  assert.doesNotMatch(html, /id="cv-source-text"[^>]*maxlength/);
});
test('analysis restores loading after all errors, preserves text, distinguishes local render failure', async () => {
  const h = harness(); const c = h.context; const original = h.node('cv-source-text').value;
  for (const error of [Object.assign(new Error(), { name: 'AbortError' }), Object.assign(new TypeError(), { code: 'NETWORK_ERROR' }), { status: 413 }, { status: 429 }, { code: 'AI_TIMEOUT' }, { code: 'AI_STORAGE_UNAVAILABLE' }, { code: 'RESPONSE_UNREADABLE' }]) {
    c.cvRequest = async () => { throw error; };
    await c.analyseCVWithAI();
    assert.equal(c.CV_ANALYSING, false); assert.equal(h.node('cv-analyse-btn').disabled, false);
    assert.equal(h.node('cv-waiting').hidden, true); assert.equal(h.node('cv-source-text').value, original);
    assert.equal(h.feedback.at(-1).error, true);
  }
  c.cvRequest = async () => ({ id: 'analysis', analysis: {} });
  c.renderCVAnalysis = () => { throw new TypeError('local render failure'); };
  await c.analyseCVWithAI();
  assert.doesNotMatch(h.feedback.at(-1).message, /connexion|réseau/i);
  assert.equal(c.CV_ANALYSING, false);
  c.cvRequest = async () => ({ id: 'analysis' });
  await c.analyseCVWithAI();
  assert.match(h.feedback.at(-1).message, /illisible|incomplète/);
});
test('double submit is ignored; successful request sends exact editable text and clears spinner', async () => {
  const h = harness(); let release; const sent = [];
  h.context.cvRequest = async (_method, _path, payload) => { sent.push(payload); return new Promise(resolve => { release = resolve; }); };
  const first = h.context.analyseCVWithAI();
  await h.context.analyseCVWithAI(); assert.equal(sent.length, 1);
  assert.equal(sent[0].source_text, h.node('cv-source-text').value.trim());
  release({ id: 'analysis', analysis: {} }); await first;
  assert.equal(h.node('cv-analyse-btn').disabled, false); assert.equal(h.node('cv-waiting').hidden, true);
});
test('quota and subscription errors lock analysis and never expose technical backend messages', async () => {
  for (const error of [{ status: 429, code: 'AI_QUOTA_EXCEEDED' }, { status: 403, code: 'AI_ACCESS_DENIED' }]) {
    const h = harness(); h.context.cvRequest = async () => { throw { ...error, message: 'Anthropic Claude tokens Supabase stack trace' }; };
    await h.context.analyseCVWithAI();
    assert.equal(h.context.CV_ALLOWED, false); assert.equal(h.node('cv-analyse-btn').disabled, true);
    assert.doesNotMatch(h.feedback.at(-1).message, /Anthropic|Claude|tokens|Supabase|stack/);
    assert.match(h.feedback.at(-1).message, /formules|renouvellement/);
  }
});
test('scan preserves prepared text; oversized extraction remains editable without truncation', () => {
  const h = harness(); const original = h.node('cv-source-text').value;
  h.context.showCvExtraction('', 'scan.pdf');
  assert.equal(h.node('cv-source-text').value, original);
  assert.match(h.feedback.at(-1).message, /scanné|images/);
  h.context.showCvExtraction('Only a heading', 'short.pdf');
  assert.equal(h.node('cv-source-text').value, original);
  h.context.showCvExtraction('x'.repeat(31000), 'long.pdf');
  assert.equal(h.node('cv-source-text').value.length, 31000);
  assert.match(h.feedback.at(-1).message, /31000.*30 000/);
});

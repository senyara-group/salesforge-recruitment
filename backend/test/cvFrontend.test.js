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
  const timers = [];
  const feedback = [];
  const storage = new Map();
  const context = {
    USER: { id: 'user-a' }, crypto: require('node:crypto').webcrypto, TextEncoder,
    sessionStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    API: 'https://example.invalid', TOKEN: 'test', FormData, AbortController,
    CV_ALLOWED: true, CV_ANALYSING: false, AI_AVAILABLE: true,
    document: { getElementById: node },
    setTimeout: (fn, delay) => { deadline = fn; timers.push({ fn, delay }); return timers.length; }, clearTimeout: () => { clears++; },
    setFeedback: (id, message, error) => feedback.push({ id, message, error }),
    setBtn: (id, loading) => { node(id).disabled = loading; },
    startCvWaiting: () => { node('cv-waiting').hidden = false; },
    stopCvWaiting: () => { node('cv-waiting').hidden = true; },
    syncCvJourney: () => {}, renderCVAnalysis: () => {}, refreshAccessToken: async () => false,
  };
  vm.createContext(context);
  vm.runInContext(section('const CV_REQUEST_TIMEOUT_MS', 'async function loadCVTool()') + '\n' + section('async function analyseCVWithAI()', 'async function saveImprovedCV()'), context);
  node('cv-source-text').value = 'Expérience commerciale et prospection. '.repeat(10);
  return { context, node, feedback, timeout: () => deadline(), clears: () => clears, timers: () => timers.filter(t => t.delay !== 75000) };
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
    c.cvRequest = async () => { throw error; }; // failed preflight must never POST
    await c.analyseCVWithAI();
    assert.equal(c.CV_ANALYSING, false); assert.equal(h.node('cv-analyse-btn').disabled, false);
    assert.equal(h.node('cv-waiting').hidden, true); assert.equal(h.node('cv-source-text').value, original);
    assert.equal(h.feedback.at(-1).error, true);
  }
  c.cvRequest = async method => method === 'GET' ? [] : ({ id: 'analysis', analysis: {} });
  c.renderCVAnalysis = () => { throw new TypeError('local render failure'); };
  await c.analyseCVWithAI();
  assert.doesNotMatch(h.feedback.at(-1).message, /connexion|réseau/i);
  assert.equal(c.CV_ANALYSING, false);
  c.cvRequest = async method => method === 'GET' ? [] : ({ id: 'analysis' });
  await c.analyseCVWithAI();
  assert.match(h.feedback.at(-1).message, /confirmée/);
});
test('double submit is ignored; successful request sends exact editable text and clears spinner', async () => {
  const h = harness(); let release; const sent = [];
  h.context.cvRequest = async (method, _path, payload) => { if (method === 'GET') return []; sent.push(payload); return new Promise(resolve => { release = resolve; }); };
  const first = h.context.analyseCVWithAI();
  await h.context.analyseCVWithAI();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.length, 1);
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

// Serveur simulé : route chaque requête par méthode + chemin et compte les POST.
function cvServer(h, { history = [], inProgress = false, post } = {}) {
  const state = { history, inProgress, posts: 0, gets: [] };
  h.context.cvRequest = async (method, path) => {
    if (method === 'POST') { state.posts++; return post(state); }
    assert.equal(method, 'GET');
    state.gets.push(path);
    if (path === '/assistant/cv-analyses/status') return { in_progress: state.inProgress };
    if (path === '/assistant/cv-analyses') return state.history;
    assert.fail('unexpected ' + path);
  };
  return state;
}
const expectedFingerprint = h => require('../utils/cvRequestFingerprint').cvRequestFingerprint({ source_text: h.node('cv-source-text').value });
const settle = () => new Promise(resolve => setImmediate(resolve));

test('uncertain POST survives reload, reconciles only a new matching result and never posts twice', async () => {
  const h = harness(); const c = h.context;
  const server = cvServer(h, { history: [{ id: 'old' }], inProgress: true, post: () => { throw { code: 'CV_REQUEST_TIMEOUT' }; } });
  await c.analyseCVWithAI();
  assert.equal(server.posts, 1);
  assert.equal(h.node('cv-analyse-btn').disabled, true);
  assert.equal(h.node('cv-waiting').hidden, true);
  const pending = c.cvPending();
  assert.doesNotMatch(JSON.stringify(pending), /commerciale|prospection/);
  const expected = expectedFingerprint(h);
  assert.equal(pending.fingerprint, expected);
  assert.ok(Number.isFinite(pending.settledAt));
  const reloaded = harness();
  reloaded.context.sessionStorage = c.sessionStorage;
  reloaded.context.updateCvRecovery();
  assert.equal(reloaded.node('cv-analyse-btn').disabled, true);
  await c.analyseCVWithAI(); assert.equal(server.posts, 1);
  let rendered;
  c.renderCVAnalysis = row => { rendered = row; };
  server.history = [
    { id: 'old', request_fingerprint: expected, analysis: {} },
    { id: 'other', request_fingerprint: 'f'.repeat(64), analysis: {} },
  ];
  await c.recoverCvAnalysis();
  assert.equal(rendered, undefined); assert.ok(c.cvPending());
  server.history = [{ id: 'new', request_fingerprint: expected, analysis: {} }];
  await c.recoverCvAnalysis();
  assert.equal(rendered.id, 'new'); assert.equal(c.cvPending(), null); assert.equal(server.posts, 1);
});

test('failed verification never unlocks a new analysis; only a confirmed absence does', async () => {
  const h = harness(); const c = h.context;
  const pending = { fingerprint: 'a'.repeat(64), previousIds: [], startedAt: Date.now() - 180001, settledAt: Date.now() - 100000 };
  c.sessionStorage.setItem(c.cvPendingKey(), JSON.stringify(pending));
  for (const failure of [{ code: 'NETWORK_ERROR' }, { status: 500 }]) {
    c.cvRequest = async () => { throw failure; };
    await c.recoverCvAnalysis(); assert.ok(c.cvPending());
    assert.equal(h.node('cv-analyse-btn').disabled, true);
  }
  for (const unreadable of [[], {}, { in_progress: 'false' }, null]) {
    c.cvRequest = async (_method, path) => path.endsWith('/status') ? unreadable : [];
    await c.recoverCvAnalysis(); assert.ok(c.cvPending());
  }
  const server = cvServer(h, { history: [], inProgress: false });
  await c.recoverCvAnalysis();
  assert.equal(c.cvPending(), null);
  assert.equal(h.node('cv-analyse-btn').disabled, false);
  assert.match(h.feedback.at(-1).message, /n’a pas abouti.*relancer/);
  assert.equal(server.posts, 0);
});

test('CV A/K : analyse normale réussie, une seule requête POST, aucun suivi résiduel', async () => {
  const h = harness(); const c = h.context; let rendered;
  c.renderCVAnalysis = row => { rendered = row; };
  const server = cvServer(h, { post: () => ({ id: 'fresh', analysis: { score: { global: 70 } } }) });
  await c.analyseCVWithAI();
  assert.equal(server.posts, 1); assert.equal(rendered.id, 'fresh');
  assert.equal(c.cvPending(), null);
  assert.equal(h.node('cv-analyse-btn').disabled, false);
  assert.deepEqual(server.gets, ['/assistant/cv-analyses']);
  assert.equal(h.timers().length, 0, 'aucune vérification automatique après un succès');
});

test('CV B/C/D : analyse lente au-delà de 75 s, suivie automatiquement puis récupérée sans nouvelle consommation', async () => {
  const h = harness(); const c = h.context; let rendered;
  c.renderCVAnalysis = row => { rendered = row; };
  const server = cvServer(h, { inProgress: true, post: () => { throw { code: 'CV_REQUEST_TIMEOUT' }; } });
  await c.analyseCVWithAI();
  assert.equal(server.posts, 1);
  assert.match(h.feedback.at(-1).message, /vérifions automatiquement/);
  const first = h.timers().at(-1);
  assert.equal(first.delay, 5000);
  first.fn(); await settle(); await settle();
  assert.match(h.feedback.at(-1).message, /toujours en cours/);
  assert.ok(c.cvPending());
  assert.equal(h.node('cv-analyse-btn').disabled, true);
  const second = h.timers().at(-1);
  assert.equal(second.delay, 10000);
  server.inProgress = false;
  server.history = [{ id: 'slow', request_fingerprint: expectedFingerprint(h), analysis: {} }];
  second.fn(); await settle(); await settle();
  assert.equal(rendered.id, 'slow');
  assert.equal(c.cvPending(), null);
  assert.equal(server.posts, 1, 'la vérification ne relance jamais l’analyse');
  assert.equal(server.gets.filter(p => p === '/assistant/cv-analyses/status').length, 2);
  assert.match(h.feedback.at(-1).message, /récupérée.*Aucune nouvelle analyse/);
});

test('CV E/I : échec serveur déterministe (timeout IA, réponse IA malformée) libère immédiatement la relance', async () => {
  for (const [status, code] of [[504, 'AI_TIMEOUT'], [502, 'AI_INVALID_RESPONSE']]) {
    const h = harness(); const c = h.context;
    let posts = 0;
    c.fetch = async (_url, options) => {
      if (options.method === 'POST') { posts++; return response(status, JSON.stringify({ code, cv_analysis_state: 'failed' })); }
      return response(200, '[]');
    };
    await c.analyseCVWithAI();
    assert.equal(posts, 1);
    assert.equal(c.cvPending(), null, code + ' ne doit pas laisser un état ambigu');
    assert.equal(h.node('cv-analyse-btn').disabled, false);
    assert.equal(h.node('cv-recovery').hidden, true);
    assert.match(h.feedback.at(-1).message, /ni décompté.*relancer/);
    assert.doesNotMatch(h.feedback.at(-1).message, /historique|confirmée/);
    await c.analyseCVWithAI();
    assert.equal(posts, 2, 'relance propre possible');
  }
});

test('CV : un 5xx de proxy sans état serveur (ou état unknown) reste en vérification, jamais relancé', async () => {
  for (const body of ['<html>bad gateway</html>', JSON.stringify({ code: 'AI_STORAGE_UNAVAILABLE', cv_analysis_state: 'unknown' })]) {
    const h = harness(); const c = h.context; let posts = 0;
    c.fetch = async (_url, options) => {
      if (options.method === 'POST') { posts++; return response(502, body); }
      return response(200, '[]');
    };
    await c.analyseCVWithAI(); await c.analyseCVWithAI();
    assert.equal(posts, 1);
    assert.ok(c.cvPending());
    assert.equal(h.node('cv-recovery').hidden, false);
  }
});

test('CV F : double clic sur Vérifier ne déclenche qu’une vérification', async () => {
  const h = harness(); const c = h.context; let release;
  c.sessionStorage.setItem(c.cvPendingKey(), JSON.stringify({ fingerprint: 'a'.repeat(64), previousIds: [], startedAt: Date.now() - 90000, settledAt: Date.now() - 10000 }));
  let statusCalls = 0;
  c.cvRequest = async (method, path) => {
    assert.equal(method, 'GET');
    if (path.endsWith('/status')) { statusCalls++; return new Promise(resolve => { release = resolve; }); }
    return [];
  };
  const first = c.recoverCvAnalysis();
  await c.recoverCvAnalysis();
  while (!release) await settle();
  release({ in_progress: true }); await first;
  assert.equal(statusCalls, 1);
});

test('CV G : après un timeout, aucune relance tant que l’analyse peut encore aboutir ; relance propre une fois l’échec confirmé', async () => {
  const h = harness(); const c = h.context;
  const server = cvServer(h, { inProgress: true, post: s => { if (s.posts === 1) throw { code: 'CV_REQUEST_TIMEOUT' }; return { id: 'second', analysis: {} }; } });
  await c.analyseCVWithAI();
  await c.analyseCVWithAI();
  assert.equal(server.posts, 1);
  await c.recoverCvAnalysis();
  await c.analyseCVWithAI();
  assert.equal(server.posts, 1, 'toujours en cours côté serveur : pas de seconde analyse');
  // Juste après l'échec réseau, l'absence de réservation n'est pas encore probante.
  server.inProgress = false;
  const marker = c.cvPending();
  c.sessionStorage.setItem(c.cvPendingKey(), JSON.stringify({ ...marker, settledAt: Date.now() }));
  await c.recoverCvAnalysis();
  assert.ok(c.cvPending());
  c.sessionStorage.setItem(c.cvPendingKey(), JSON.stringify({ ...marker, settledAt: Date.now() - 6000 }));
  await c.recoverCvAnalysis();
  assert.equal(c.cvPending(), null);
  await c.analyseCVWithAI();
  assert.equal(server.posts, 2);
  assert.equal(c.cvPending(), null);
});

test('CV H : après rechargement, la même analyse est retrouvée (GET seulement)', async () => {
  const h = harness();
  cvServer(h, { inProgress: true, post: () => { throw { code: 'NETWORK_ERROR' }; } });
  await h.context.analyseCVWithAI();
  const reloaded = harness(); let rendered;
  reloaded.context.sessionStorage = h.context.sessionStorage;
  reloaded.context.renderCVAnalysis = row => { rendered = row; };
  const server = cvServer(reloaded, { inProgress: false, history: [{ id: 'after-reload', request_fingerprint: expectedFingerprint(h), analysis: {} }] });
  await reloaded.context.recoverCvAnalysis();
  assert.equal(rendered.id, 'after-reload');
  assert.equal(server.posts, 0);
  assert.equal(reloaded.context.cvPending(), null);
});

test('CV : la vérification automatique s’arrête une fois toute réservation serveur expirée', async () => {
  const h = harness(); const c = h.context;
  c.sessionStorage.setItem(c.cvPendingKey(), JSON.stringify({ fingerprint: 'a'.repeat(64), previousIds: [], startedAt: Date.now() - 250000, settledAt: Date.now() - 170000 }));
  cvServer(h, { inProgress: true });
  const before = h.timers().length;
  await c.recoverCvAnalysis();
  assert.equal(h.timers().length, before);
  assert.ok(c.cvPending(), 'le bouton Vérifier reste disponible manuellement');
  assert.doesNotMatch(html, /allowCvRetry|cv-retry|risque de double consommation/);
});

test('ambiguous POST errors stay locked; definitive rejections release the local marker', async () => {
  for (const error of [{ code: 'NETWORK_ERROR' }, { code: 'RESPONSE_UNREADABLE' }, { code: 'AI_STORAGE_UNAVAILABLE', status: 503 }, { name: 'AbortError' }, { status: 500 }, { status: 400 }, { status: 413 }, { status: 429 }]) {
    const h = harness();
    h.context.cvRequest = async method => { if (method === 'GET') return []; throw error; };
    await h.context.analyseCVWithAI();
    const locked = ![400, 413, 429].includes(error.status);
    assert.equal(Boolean(h.context.cvPending()), locked);
    assert.equal(h.node('cv-analyse-btn').disabled, locked);
    assert.equal(h.node('cv-waiting').hidden, true);
  }
});

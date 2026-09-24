const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../../frontend/_spaces/candidat.html'), 'utf8');
const candidatsRoute = fs.readFileSync(path.join(__dirname, '../routes/candidats.js'), 'utf8');
const aiRoute = fs.readFileSync(path.join(__dirname, '../routes/ai.js'), 'utf8');

function sourceBetween(start, end) {
  const first = html.indexOf(start);
  const last = html.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `${start} not found`);
  return html.slice(first, last);
}

function el(overrides = {}) {
  return {
    hidden: true,
    textContent: '',
    style: { display: '', width: '' },
    checked: false,
    disabled: false,
    innerHTML: '',
    classList: { add() {}, remove() {}, toggle() {} },
    querySelector() { return null; },
    ...overrides,
  };
}

function buildGateSandbox(apiImpl) {
  const feedback = {};
  const elements = {
    'adn-consent-gate': el({ hidden: false }),
    'adn-eligibility-gate': el(),
    'adn-test-sticky': el(),
    'adn-test-body': el(),
    'adn-consent-feedback': el(),
    'adn-consent-checkbox': el({ checked: false }),
    'adn-consent-btn': el(),
    'adn-eligibility-title': el({ textContent: 'Préparation du test' }),
    'adn-eligibility-copy': el({ textContent: 'Vérification de votre éligibilité…' }),
    'adn-eligibility-feedback': el(),
    'adn-eligibility-retry': el({ hidden: true }),
  };
  const calls = [];
  const sandbox = {
    ADN_GATE_SEQ: 0,
    document: { getElementById: id => elements[id] || null },
    setFeedback(id, message, error = false) { feedback[id] = { message, error }; },
    setBtn() {},
    api: async (method, route, body) => {
      calls.push({ method, route, body });
      return apiImpl(method, route, body, calls.length);
    },
    elements,
    feedback,
    calls,
  };
  const gateSource = sourceBetween('let ADN_GATE_SEQ = 0;', 'function submitADN()');
  vm.runInNewContext(
    `${gateSource}\nthis.loadAdnConsent = loadAdnConsent;\nthis.saveAdnConsent = saveAdnConsent;\nthis.showAdnQuestionnaire = showAdnQuestionnaire;`,
    sandbox,
  );
  return sandbox;
}

test('HTML expose le gate d’éligibilité avant le questionnaire ADN', () => {
  assert.match(html, /id="adn-eligibility-gate"/);
  assert.match(html, /id="adn-eligibility-retry"/);
  assert.match(html, /Votre ADN Commercial est déjà à jour/);
  assert.match(html, /\/candidats\/evaluations/);
  const consentIdx = html.indexOf('id="adn-consent-gate"');
  const eligibilityIdx = html.indexOf('id="adn-eligibility-gate"');
  const stickyIdx = html.indexOf('id="adn-test-sticky"');
  assert.ok(consentIdx < eligibilityIdx && eligibilityIdx < stickyIdx);
});

test('GET /candidats/evaluations est auth-only ; historique masqué hors Coaching', () => {
  assert.match(candidatsRoute, /router\.get\('\/evaluations',\s*authMiddleware,\s*async/);
  assert.doesNotMatch(
    candidatsRoute.slice(candidatsRoute.indexOf("router.get('/evaluations'"), candidatsRoute.indexOf("router.get('/export-pdf'")),
    /requireCandidatePlan/,
  );
  assert.match(candidatsRoute, /peut_repasser/);
  assert.match(candidatsRoute, /next_eligible_at/);
  assert.match(candidatsRoute, /getCandidatePlan/);
  assert.match(candidatsRoute, /historyAllowed \? data : \[\]/);
});

test('1. première évaluation → peut commencer', async () => {
  const sandbox = buildGateSandbox(async (method, route) => {
    if (route === '/candidats/consentement/test_adn') return { accepte: true };
    if (route === '/candidats/evaluations') {
      return { evaluations: [], next_eligible_at: null, peut_repasser: true };
    }
    throw new Error(`unexpected ${method} ${route}`);
  });
  await sandbox.loadAdnConsent();
  assert.equal(sandbox.elements['adn-test-body'].hidden, false);
  assert.equal(sandbox.elements['adn-test-sticky'].hidden, false);
  assert.equal(sandbox.elements['adn-eligibility-gate'].hidden, true);
  assert.equal(sandbox.elements['adn-consent-gate'].hidden, true);
  assert.deepEqual(sandbox.calls.map(c => c.route), [
    '/candidats/consentement/test_adn',
    '/candidats/evaluations',
  ]);
});

test('2. peut_repasser=true → peut commencer', async () => {
  const sandbox = buildGateSandbox(async (_m, route) => {
    if (route.includes('consentement')) return { accepte: true };
    return {
      evaluations: [{ score: 80, created_at: '2024-01-01T00:00:00.000Z' }],
      next_eligible_at: '2024-07-01T00:00:00.000Z',
      peut_repasser: true,
    };
  });
  await sandbox.loadAdnConsent();
  assert.equal(sandbox.elements['adn-test-body'].hidden, false);
  assert.equal(sandbox.elements['adn-eligibility-gate'].hidden, true);
});

test('3. peut_repasser=false + next_eligible_at → bloqué avec date FR', async () => {
  const sandbox = buildGateSandbox(async (_m, route) => {
    if (route.includes('consentement')) return { accepte: true };
    return {
      evaluations: [{ score: 80, created_at: '2026-03-09T12:00:00.000Z' }],
      next_eligible_at: '2026-09-05T12:00:00.000Z',
      peut_repasser: false,
    };
  });
  await sandbox.loadAdnConsent();
  assert.equal(sandbox.elements['adn-test-body'].hidden, true);
  assert.equal(sandbox.elements['adn-test-sticky'].hidden, true);
  assert.equal(sandbox.elements['adn-eligibility-gate'].hidden, false);
  assert.match(sandbox.elements['adn-eligibility-title'].textContent, /déjà à jour/);
  const expected = new Date('2026-09-05T12:00:00.000Z').toLocaleDateString('fr-FR');
  assert.match(sandbox.elements['adn-eligibility-copy'].textContent, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(sandbox.elements['adn-eligibility-retry'].hidden, true);
});

test('4. peut_repasser=false sans date → bloqué + message générique', async () => {
  const sandbox = buildGateSandbox(async (_m, route) => {
    if (route.includes('consentement')) return { accepte: true };
    return { evaluations: [{}], next_eligible_at: null, peut_repasser: false };
  });
  await sandbox.loadAdnConsent();
  assert.equal(sandbox.elements['adn-test-body'].hidden, true);
  assert.match(sandbox.elements['adn-eligibility-copy'].textContent, /délai de repassage/);
  assert.doesNotMatch(sandbox.elements['adn-eligibility-copy'].textContent, /\d{2}\/\d{2}\/\d{4}/);
});

test('5. erreur endpoint → fail-safe, questionnaire non démarrable, Réessayer', async () => {
  let fail = true;
  const sandbox = buildGateSandbox(async (_m, route) => {
    if (route.includes('consentement')) return { accepte: true };
    if (fail) {
      const err = Object.assign(new TypeError('Failed to fetch'), { code: 'NETWORK_ERROR' });
      throw err;
    }
    return { evaluations: [], next_eligible_at: null, peut_repasser: true };
  });
  await sandbox.loadAdnConsent();
  assert.equal(sandbox.elements['adn-test-body'].hidden, true);
  assert.equal(sandbox.elements['adn-eligibility-gate'].hidden, false);
  assert.match(sandbox.elements['adn-eligibility-copy'].textContent, /connexion/i);
  assert.equal(sandbox.elements['adn-eligibility-retry'].hidden, false);
  assert.equal(sandbox.feedback['adn-eligibility-feedback']?.error, true);

  fail = false;
  await sandbox.loadAdnConsent();
  assert.equal(sandbox.elements['adn-test-body'].hidden, false);
});

test('5b. erreur auth/serveur distinguées du réseau', async () => {
  const auth = buildGateSandbox(async (_m, route) => {
    if (route.includes('consentement')) return { accepte: true };
    throw Object.assign(new Error('Unauthorized'), { status: 401 });
  });
  await auth.loadAdnConsent();
  assert.match(auth.elements['adn-eligibility-copy'].textContent, /session|droits/i);
  assert.doesNotMatch(auth.elements['adn-eligibility-copy'].textContent, /connexion/i);

  const server = buildGateSandbox(async (_m, route) => {
    if (route.includes('consentement')) return { accepte: true };
    throw Object.assign(new Error('boom'), { status: 500 });
  });
  await server.loadAdnConsent();
  assert.match(server.elements['adn-eligibility-copy'].textContent, /Impossible de vérifier/);
  assert.doesNotMatch(server.elements['adn-eligibility-copy'].textContent, /connexion/i);
});

test('6. consentement nécessaire → flow actuel préservé', async () => {
  const sandbox = buildGateSandbox(async (_m, route) => {
    if (route.includes('consentement')) return { accepte: false };
    throw new Error('evaluations must not be called before consent');
  });
  await sandbox.loadAdnConsent();
  assert.equal(sandbox.elements['adn-consent-gate'].hidden, false);
  assert.equal(sandbox.elements['adn-test-body'].hidden, true);
  assert.equal(sandbox.elements['adn-eligibility-gate'].hidden, true);
  assert.match(sandbox.feedback['adn-consent-feedback'].message, /accord est nécessaire/);
  assert.equal(sandbox.calls.length, 1);
});

test('6. gate frontend : cooldown avec evaluations[] vide (réponse freemium)', async () => {
  const sandbox = buildGateSandbox(async (_m, route) => {
    if (route.includes('consentement')) return { accepte: true };
    return {
      evaluations: [],
      next_eligible_at: '2027-01-15T00:00:00.000Z',
      peut_repasser: false,
    };
  });
  await sandbox.loadAdnConsent();
  assert.equal(sandbox.elements['adn-test-body'].hidden, true);
  assert.match(sandbox.elements['adn-eligibility-title'].textContent, /déjà à jour/);
  const expected = new Date('2027-01-15T00:00:00.000Z').toLocaleDateString('fr-FR');
  assert.match(sandbox.elements['adn-eligibility-copy'].textContent, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('7. ADN approfondi terminé + principal non éligible → principal reste bloqué', async () => {
  const gateSource = sourceBetween('let ADN_GATE_SEQ = 0;', 'function submitADN()');
  assert.doesNotMatch(gateSource, /DEEP_ADN|adn-approfondi|deepAdn|loadDeepAdn|deep_adn/i);
  assert.match(gateSource, /\/candidats\/evaluations/);

  const sandbox = buildGateSandbox(async (_m, route) => {
    if (route.includes('consentement')) return { accepte: true };
    // Deep completed n’apparaît nulle part : seule la réponse evaluations compte.
    return {
      evaluations: [{ score: 72 }],
      next_eligible_at: '2027-01-15T00:00:00.000Z',
      peut_repasser: false,
      // bruit volontaire — ne doit pas influencer
      deep_completed: true,
    };
  });
  await sandbox.loadAdnConsent();
  assert.equal(sandbox.elements['adn-test-body'].hidden, true);
  assert.match(sandbox.elements['adn-eligibility-title'].textContent, /déjà à jour/);
});

test('8. backend RETAKE_TOO_SOON final → comportement récent inchangé', async () => {
  const submitSource = sourceBetween('async function submitToAPI()', 'function resultAxisColor(');
  assert.match(submitSource, /RETAKE_TOO_SOON/);
  assert.match(submitSource, /Résultat indisponible/);
  assert.match(submitSource, /NETWORK_ERROR/);
  assert.match(aiRoute, /RETAKE_TOO_SOON/);
  assert.match(aiRoute, /RETAKE_COOLDOWN_MS/);
});

test('9. reset #as Démarrage… et #af 0% inchangé', async () => {
  const submitAdn = sourceBetween('function submitADN()', 'async function runAnalysis()');
  assert.match(submitAdn, /textContent = 'Démarrage…'/);
  assert.match(submitAdn, /style\.width = '0%'/);

  const heading = { textContent: '' };
  const description = { textContent: '' };
  const bar = { style: { display: '' } };
  const elements = {
    ts10: { style: { display: 'none' } },
    'ana-block': { style: { display: 'block' }, querySelector: selector => ({ h3: heading, p: description, '.ana-bar': bar })[selector] },
    'res-block': { style: { display: 'none' } },
    'test-pf': { style: { display: '', width: '' } },
    'test-sl': { textContent: '' }, 'test-st': { textContent: '' },
    as: { textContent: '' }, af: { style: { width: '0%' } },
  };
  const sandbox = {
    document: { getElementById: id => elements[id] },
    window: { scrollTo: () => {} }, hideAllTestSteps: () => {},
    runAnalysis: () => {},
  };
  vm.runInNewContext(`${sourceBetween('function submitADN()', 'async function runAnalysis()')}\nthis.start = submitADN;`, sandbox);
  sandbox.start();
  assert.equal(elements.as.textContent, 'Démarrage…');
  assert.equal(elements.af.style.width, '0%');
});

test('chargement : questionnaire masqué tant que l’éligibilité n’est pas connue', async () => {
  let resolveEvals;
  const sandbox = buildGateSandbox(async (_m, route) => {
    if (route.includes('consentement')) return { accepte: true };
    return new Promise(resolve => { resolveEvals = resolve; });
  });
  const pending = sandbox.loadAdnConsent();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sandbox.elements['adn-test-body'].hidden, true);
  assert.equal(sandbox.elements['adn-eligibility-gate'].hidden, false);
  assert.match(sandbox.elements['adn-eligibility-copy'].textContent, /Vérification/);
  resolveEvals({ evaluations: [], next_eligible_at: null, peut_repasser: true });
  await pending;
  assert.equal(sandbox.elements['adn-test-body'].hidden, false);
});

test('gate principal n’appelle jamais deep ADN', async () => {
  const sandbox = buildGateSandbox(async (_m, route) => {
    if (route.includes('consentement')) return { accepte: true };
    if (route.includes('evaluations')) return { peut_repasser: true, next_eligible_at: null, evaluations: [] };
    throw new Error(`unexpected route ${route}`);
  });
  await sandbox.loadAdnConsent();
  assert.equal(sandbox.calls.every(c => !/adn-approfondi|deep/i.test(c.route)), true);
});

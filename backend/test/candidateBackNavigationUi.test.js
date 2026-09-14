const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Hotfix mobile pré-démo : Yannis signalait pouvoir rester coincé dans
// l'Optimiseur CV / le Coach commercial sur Safari mobile sans moyen de revenir
// en arrière dans l'app. Ces tests sont statiques (comme les autres *Ui.test.js
// du repo) : ils vérifient le câblage source plutôt que d'exécuter le JS dans un
// DOM, ce qui suffit à protéger contre une régression de câblage/suppression.

const html = fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', '_spaces', 'candidat.html'),
  'utf8',
);
const css = fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', 'app-professional.css'),
  'utf8',
);

// Isole le contenu d'une page ("<div id="p-X" class="page">...") jusqu'au début
// de la page suivante, pour ne jamais vérifier le mauvais bloc par débordement.
function pageBlock(pageId) {
  const marker = `<div id="${pageId}" class="page">`;
  const start = html.indexOf(marker);
  assert.notEqual(start, -1, `${pageId} introuvable`);
  const nextStart = html.indexOf('<div id="p-', start + marker.length);
  return html.slice(start, nextStart === -1 ? html.length : nextStart);
}

test('pile de navigation interne : déclarée et alimentée uniquement lors d’une navigation app', () => {
  assert.match(html, /let NAV_STACK\s*=\s*\[\]/);
  const goIndex = html.indexOf('function go(p, options = {}) {');
  assert.notEqual(goIndex, -1, 'go() introuvable');
  const goBody = html.slice(goIndex, goIndex + 900);
  // Le repro à éviter : un window.history.back() naïf risquerait de sortir de la
  // SPA (login, autre site). go() doit rester la seule voie de navigation.
  assert.doesNotMatch(goBody, /window\.history\.back\(\)/);
  assert.match(goBody, /NAV_STACK\.push\(current\)/);
  // La pile ne doit pas se corrompre lors d'un retour navigateur natif (popstate
  // rejoue go(..., { history: false })) : le push doit être conditionné.
  assert.match(goBody, /options\.history !== false/);
});

test('goBack() : priorité à la page connue, repli sur l’accueil sinon', () => {
  const fnIndex = html.indexOf('function goBack()');
  assert.notEqual(fnIndex, -1, 'goBack() introuvable');
  const body = html.slice(fnIndex, fnIndex + 350);
  assert.match(body, /NAV_STACK\.pop\(\)/);
  // Priorité 1 : la page précédente si elle est connue (dans APP_PAGES) ;
  // priorité 2 (repli) : 'home'. Un refresh direct sur la sous-page vide
  // NAV_STACK (état JS réinitialisé), ce qui doit retomber sur ce repli.
  assert.match(body, /APP_PAGES\.includes\(previous\)/);
  // history:false obligatoire : sinon go() re-pousse la page quittée et crée une boucle.
  assert.match(
    body,
    /go\(APP_PAGES\.includes\(previous\) \? previous : 'home',\s*\{\s*history:\s*false\s*\}\)/,
  );
});

function extractFunctionSource(source, fnName) {
  // Ancre sur "function name(" pour éviter go ↔ goBack / goToPricing.
  // Puis ignore le corps des paramètres (ex. options = {}) avant le { du body.
  const sig = source.indexOf(`function ${fnName}(`);
  assert.notEqual(sig, -1, `${fnName} introuvable`);
  let i = sig + `function ${fnName}`.length;
  assert.equal(source[i], '(', `${fnName}: '(' attendu`);
  let parenDepth = 0;
  let bodyOpen = -1;
  for (; i < source.length; i += 1) {
    const c = source[i];
    if (c === '(') parenDepth += 1;
    else if (c === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) {
        bodyOpen = source.indexOf('{', i + 1);
        break;
      }
    }
  }
  assert.ok(bodyOpen > sig, `${fnName}: corps introuvable`);
  let depth = 0;
  let end = -1;
  for (i = bodyOpen; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  assert.ok(end > bodyOpen, `${fnName} non bornée`);
  return source.slice(sig, end);
}

test('NAV_STACK comportemental : home→cv→coach puis retours sans boucle', () => {
  // Exécute go/goBack réels (extrait du HTML) dans un DOM minimal pour garantir
  // qu'un retour n'alimente plus la pile (bug : oscillation cv↔coach).
  const vm = require('node:vm');
  const pages = {};
  for (const id of ['home', 'cv', 'coach', 'swipe', 'coaching']) {
    pages[`p-${id}`] = { id: `p-${id}`, classList: { on: id === 'home', add(c) { if (c === 'on') this.on = true; }, remove(c) { if (c === 'on') this.on = false; }, contains(c) { return c === 'on' && this.on; } } };
  }
  const topbar = { style: { display: 'flex' } };
  const bnav = { style: { display: 'flex' } };
  const noop = () => {};
  const sandbox = {
    APP_PAGES: ['home', 'swipe', 'coaching', 'candidatures', 'test', 'adn-deep', 'messages', 'profile', 'cv', 'coach', 'account', 'pricing'],
    NAV_STACK: [],
    USER: { id: 'u-test' },
    localStorage: { store: Object.create(null), setItem(k, v) { this.store[k] = String(v); }, getItem(k) { return this.store[k] ?? null; } },
    window: { scrollTo: noop },
    document: {
      querySelector(sel) {
        if (sel === '.page.on') return Object.values(pages).find((p) => p.classList.contains('on')) || null;
        return null;
      },
      querySelectorAll(sel) {
        if (sel === '.page') return Object.values(pages);
        if (sel === '.bn') return [];
        return [];
      },
      getElementById(id) {
        if (id === 'topbar') return topbar;
        if (id === 'bnav') return bnav;
        if (pages[id]) return pages[id];
        return null;
      },
    },
    saveLastPage: noop,
    syncPageHistory: noop,
    refreshMessageBadge: noop,
    loadHome: noop,
    loadOffres: noop,
    loadCandidatures: noop,
    loadAdnConsent: noop,
    loadDeepAdn: noop,
    loadMessages: noop,
    loadProfile: noop,
    loadCVTool: noop,
    loadCoach: noop,
    loadCoaching: noop,
    renderPlans: noop,
    normalizePage(page) { return page === 'matchs' ? 'messages' : page; },
  };

  const code = [
    extractFunctionSource(html, 'normalizePage'),
    'let NAV_STACK = [];',
    extractFunctionSource(html, 'goBack'),
    extractFunctionSource(html, 'go'),
    'this.NAV_STACK = NAV_STACK; this.go = go; this.goBack = goBack;',
  ].join('\n');
  vm.runInNewContext(code, sandbox);

  const currentPage = () => sandbox.document.querySelector('.page.on')?.id?.replace('p-', '');

  sandbox.go('home', { history: false });
  assert.equal(currentPage(), 'home');
  assert.deepEqual([...sandbox.NAV_STACK], []);

  sandbox.go('cv');
  assert.equal(currentPage(), 'cv');
  assert.deepEqual([...sandbox.NAV_STACK], ['home']);

  sandbox.go('coach');
  assert.equal(currentPage(), 'coach');
  assert.deepEqual([...sandbox.NAV_STACK], ['home', 'cv']);

  sandbox.goBack();
  assert.equal(currentPage(), 'cv');
  assert.deepEqual([...sandbox.NAV_STACK], ['home']);

  sandbox.goBack();
  assert.equal(currentPage(), 'home');
  assert.deepEqual([...sandbox.NAV_STACK], []);

  sandbox.goBack();
  assert.equal(currentPage(), 'home');
  assert.deepEqual([...sandbox.NAV_STACK], []);

  // Accès direct CV (pile vide) → retour home, sans croissance.
  sandbox.NAV_STACK.length = 0;
  sandbox.go('cv', { history: false });
  assert.equal(currentPage(), 'cv');
  assert.deepEqual([...sandbox.NAV_STACK], []);
  sandbox.goBack();
  assert.equal(currentPage(), 'home');
  assert.deepEqual([...sandbox.NAV_STACK], []);

  // home → cv → back → home, pile stable.
  sandbox.go('home', { history: false });
  sandbox.NAV_STACK.length = 0;
  sandbox.go('cv');
  assert.deepEqual([...sandbox.NAV_STACK], ['home']);
  sandbox.goBack();
  assert.equal(currentPage(), 'home');
  assert.deepEqual([...sandbox.NAV_STACK], []);
});

test('Optimiseur CV : bouton retour présent, tactile, relié à goBack()', () => {
  const block = pageBlock('p-cv');
  assert.match(block, /class="page-back-btn"[^>]*onclick="goBack\(\)"/);
  assert.match(block, /class="page-back-btn"[^>]*aria-label="Retour"/);
});

test('Coach commercial : bouton retour présent, tactile, relié à goBack()', () => {
  const block = pageBlock('p-coach');
  assert.match(block, /class="page-back-btn"[^>]*onclick="goBack\(\)"/);
  assert.match(block, /class="page-back-btn"[^>]*aria-label="Retour"/);
});

test('pages principales (bottom nav) : pas de flèche retour ajoutée mécaniquement', () => {
  for (const pageId of ['p-home', 'p-swipe', 'p-messages', 'p-profile']) {
    const block = pageBlock(pageId);
    assert.doesNotMatch(block, /page-back-btn/, `${pageId} ne devrait pas avoir de bouton retour`);
  }
});

test('CSS : bouton retour dimensionné pour un usage tactile (>= 44px)', () => {
  const start = css.indexOf('.page-back-btn {');
  assert.notEqual(start, -1, 'règle .page-back-btn introuvable dans app-professional.css');
  const rule = css.slice(start, start + 400);
  assert.match(rule, /width:\s*44px/);
  assert.match(rule, /height:\s*44px/);
});

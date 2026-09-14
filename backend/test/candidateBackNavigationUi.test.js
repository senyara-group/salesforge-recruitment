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
  const body = html.slice(fnIndex, fnIndex + 200);
  assert.match(body, /NAV_STACK\.pop\(\)/);
  // Priorité 1 : la page précédente si elle est connue (dans APP_PAGES) ;
  // priorité 2 (repli) : 'home'. Un refresh direct sur la sous-page vide
  // NAV_STACK (état JS réinitialisé), ce qui doit retomber sur ce repli.
  assert.match(body, /APP_PAGES\.includes\(previous\)/);
  assert.match(body, /go\(APP_PAGES\.includes\(previous\) \? previous : 'home'\)/);
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

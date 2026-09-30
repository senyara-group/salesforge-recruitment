// Lot 7.1 : stabilité mobile de la navigation basse candidat et largeur du Coach.
// Node n'a pas de moteur de mise en page : ces tests verrouillent les déclarations
// CSS dont la mesure réelle (navigateur, 390×844 / 430×932 / 1280×900) a montré
// qu'elles causaient le débordement ou fragilisaient la barre fixe.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const candidateHtml = fs.readFileSync(path.join(ROOT, 'frontend/_spaces/candidat.html'), 'utf8');
const sharedCss = fs.readFileSync(path.join(ROOT, 'frontend/app-professional.css'), 'utf8').replace(/\r\n/g, '\n');
const candidateCss = candidateHtml.slice(candidateHtml.indexOf('<style>'), candidateHtml.indexOf('</style>'));

// Déclarations d'une règle dont le sélecteur est exactement `selector`, dans un bloc donné.
function rule(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`(?:^|[}\\n])\\s*${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `règle absente : ${selector}`);
  return match[1];
}
function mediaBlock(css, query) {
  const start = css.indexOf(`@media ${query}`);
  assert.ok(start >= 0, query);
  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}' && --depth === 0) return css.slice(start, i + 1);
  }
  throw new Error(query);
}
const mobile = mediaBlock(sharedCss, '(max-width: 719px)');

test('navigation basse : centrée sans transform sur la barre fixe, desktop ancré à gauche', () => {
  const nav = rule(candidateCss, '.bnav');
  assert.match(nav, /position:fixed/);
  assert.match(nav, /bottom:0/);
  assert.doesNotMatch(nav, /transform/, 'la barre fixe ne doit pas porter son propre transform');
  assert.match(nav, /left:0;right:0;margin:0 auto/);
  assert.match(nav, /max-width:430px/);
  // Sidebar desktop : sans right:auto + margin:0, left/right:0 + margin:auto la centreraient.
  const desktop = mediaBlock(sharedCss, '(min-width: 1024px)');
  const desktopNav = rule(desktop, '.bnav');
  assert.match(desktopNav, /left: 0 !important;/);
  assert.match(desktopNav, /right: auto;/);
  assert.match(desktopNav, /margin: 0;/);
});

test('navigation basse : aucune transition de propriété de mise en page, zone tactile et safe-area', () => {
  const item = rule(candidateCss, '.bn');
  const transition = item.match(/transition:([^;]*)/)[1];
  assert.doesNotMatch(transition, /^\s*(all\s*)?\.?\d/, 'transition « all » implicite interdite');
  assert.deepEqual(transition.split(',').map((part) => part.trim().split(/\s+/)[0]).sort(), ['background-color', 'color']);
  assert.match(rule(sharedCss, '.bn'), /min-height: 46px/);
  assert.match(rule(candidateCss, '.bnav'), /padding:6px 0 max\(8px,env\(safe-area-inset-bottom\)\)/);
});

test('Coach L/M/P : colonne contrainte, enfants rétrécissables, actions et zone de saisie dans la largeur', () => {
  const conversation = rule(sharedCss, '.coach-conversation');
  assert.match(conversation, /display: grid/);
  assert.match(conversation, /grid-template-columns: minmax\(0, 1fr\)/, 'une piste implicite auto s’élargit au contenu insécable');
  assert.match(rule(sharedCss, '.coach-conversation > *, .coach-conversation-head > div'), /min-width: 0/);
  assert.match(rule(sharedCss, '.coach-conversation-head h2'), /overflow-wrap: anywhere/);
  assert.match(rule(sharedCss, '.coach-composer textarea'), /min-width: 0/);
  assert.match(rule(mobile, '.coach-conversation-head'), /flex-wrap: wrap/);
  assert.match(rule(mobile, '.coach-head-actions .btn'), /min-height: 44px/);
});

test('Coach N/O/R : messages utilisateur et Coach reviennent à la ligne, y compris URL/mot très long', () => {
  const bubble = rule(sharedCss, '.coach-message p, .coach-bubble');
  assert.match(bubble, /white-space: pre-wrap/);
  assert.match(bubble, /overflow-wrap: anywhere/);
  // Aucune règle ultérieure ne rétablit un retour à la ligne impossible sur les bulles.
  for (const match of sharedCss.matchAll(/\.coach-(?:bubble|message)[^{]*\{([^}]*)\}/g)) {
    assert.doesNotMatch(match[1], /white-space:\s*nowrap|overflow-wrap:\s*normal|word-break:\s*keep-all/);
  }
});

test('Coach : hauteur mobile indépendante de la barre d’adresse (svh), sans masquage global du débordement', () => {
  assert.match(rule(mobile, '.coach-conversation'), /height: calc\(100svh - 156px\)/);
  assert.doesNotMatch(rule(mobile, '.coach-conversation'), /dvh/);
  // Le correctif ne repose pas sur un overflow-x:hidden du document.
  assert.doesNotMatch(sharedCss + candidateCss, /(?:^|[\s,}])(?:html|body)[^{]*\{[^}]*overflow-x:\s*hidden/);
});

test('Coach Q/V : tous les modes partagent la même structure de conversation', () => {
  const conversation = candidateHtml.slice(candidateHtml.indexOf('<div id="coach-conversation"'), candidateHtml.indexOf('</form>', candidateHtml.indexOf('<div id="coach-conversation"')));
  for (const id of ['coach-messages', 'coach-input', 'coach-send-btn', 'coach-change-mode-btn', 'coach-restart-btn']) assert.match(conversation, new RegExp(`id="${id}"`));
  // Un seul conteneur de conversation, réutilisé par Entretien, Objections (commerciales/recrutement) et Pitch.
  assert.equal(candidateHtml.split('id="coach-conversation"').length, 2);
  assert.match(candidateHtml, /function appendCoachMessage\(message\)[\s\S]*?content\.className = 'coach-bubble'/);
});

// Lot 7.2 : cause racine du débordement observé sur téléphone réel. La preuve de mise en
// page est `npm run test:layout` (Chrome réel, émulation mobile, historique Coach rempli) ;
// ce test verrouille les déclarations structurelles qu'elle a validées.
test('Coach 7.2 : colonne racine contrainte (historique rempli) et barre d’outils non compressible', () => {
  const layout = rule(sharedCss, '.coach-layout');
  assert.match(layout, /display: grid/);
  assert.match(layout, /grid-template-columns: minmax\(0, 1fr\)/, 'piste implicite auto : la liste d’historique élargissait tout le Coach');
  assert.match(rule(sharedCss, '.coach-layout > *'), /min-width: 0/);
  const toolbar = rule(sharedCss, '.cv-toolbar');
  assert.match(toolbar, /flex: 0 0 auto/);
  assert.match(toolbar, /max-width: 100%/);
  // La liste d’historique reste un défilement horizontal interne sur mobile.
  assert.match(rule(mobile, '.coach-history-list'), /display: flex; overflow-x: auto/);
});

// Lot 7.1 : stabilité mobile de la navigation basse candidat et largeur du Coach.
// Node n'a pas de moteur de mise en page : ces tests verrouillent les déclarations
// CSS dont la mesure réelle (navigateur, 390×844 / 430×932 / 1280×900) a montré
// qu'elles causaient le débordement ou fragilisaient la barre fixe.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const ds = require('./helpers/designSystemCss');
const candidateHtml = fs.readFileSync(path.join(ROOT, 'frontend/_spaces/candidat.html'), 'utf8');
const recruiterHtml = fs.readFileSync(path.join(ROOT, 'frontend/_spaces/recruteur.html'), 'utf8');
const shellHtml = fs.readFileSync(path.join(ROOT, 'frontend/swipsales_app.html'), 'utf8').replace(/\r\n/g, '\n');
// Les deux espaces chargent le même design system (tokens, composants, blocs métier).
const spaceCss = ds.spaceCss();
const accessCss = ds.read('access');

// Déclarations effectives d'une règle dont le sélecteur est exactement `selector`.
function rule(css, selector) {
  const decls = ds.rule(css, selector);
  assert.ok(decls, `règle absente : ${selector}`);
  return decls;
}
const mobile = ds.media(spaceCss, '(max-width:719px)');

test('les deux espaces et le shell chargent le design system, sans style local', () => {
  for (const html of [candidateHtml, recruiterHtml]) {
    assert.match(html, /href="\.\.\/design-system\/tokens\.css">\s*<link rel="stylesheet" href="\.\.\/design-system\/components\.css">\s*<link rel="stylesheet" href="\.\.\/design-system\/features\.css">/);
    assert.doesNotMatch(html, /<style[\s>]/);
  }
  assert.match(shellHtml, /href="design-system\/access\.css"/);
  assert.doesNotMatch(shellHtml, /<style[\s>]/);
});

test('navigation basse : fixée en bas sans transform, desktop ancré à gauche', () => {
  const nav = rule(ds.media(spaceCss), '.bnav');
  assert.match(nav, /position:fixed/);
  assert.match(nav, /bottom:0/);
  assert.match(nav, /left:0/);
  assert.match(nav, /right:0/);
  assert.doesNotMatch(nav, /transform|margin/, 'la barre fixe ne doit porter ni transform ni centrage par marge');
  // Barre latérale : ancrée à gauche (right:auto), jamais centrée.
  const desktopNav = rule(ds.media(spaceCss, '(min-width:1024px)'), '.bnav');
  assert.match(desktopNav, /top:0/);
  assert.match(desktopNav, /right:auto/);
  assert.doesNotMatch(desktopNav, /margin|transform/);
});

test('navigation basse : aucune transition de propriété de mise en page, zone tactile et safe-area', () => {
  const item = rule(ds.media(spaceCss), '.bn');
  const transition = (item.match(/transition:([^;]*)/) || [])[1];
  if (transition) {
    assert.doesNotMatch(transition, /^\s*(all\s*)?\.?\d/, 'transition « all » implicite interdite');
    for (const part of transition.split(',')) assert.match(part.trim().split(/\s+/)[0], /^(background-color|color)$/);
  }
  assert.match(item, /min-height:46px/);
  assert.match(rule(ds.media(spaceCss), '.bnav'), /padding:[^;]*env\(safe-area-inset-bottom\)/);
});

// Tremblement de la barre basse : la cause racine est l'iframe du shell. La barre est
// position:fixed DANS l'iframe, donc fixée au bas de l'iframe et non de l'écran.
test('navigation basse : l’iframe du shell ne suit ni la barre d’adresse ni le rebond du document', () => {
  assert.match(shellHtml, /<iframe id="app-frame"/);
  const frame = rule(accessCss, '#app-frame');
  assert.match(frame, /position:fixed/);
  assert.match(frame, /inset:0/);
  assert.match(frame, /width:100%/);
  assert.match(frame, /height:100%/);
  assert.doesNotMatch(frame, /[dsl]?vh/, 'une hauteur en unités de viewport redimensionne l’iframe avec la barre d’adresse');
  assert.match(rule(accessCss, 'html:has(> body:not(.auth))'), /overscroll-behavior:none/);
});

test('navigation basse recruteur : même barre que le candidat (composant partagé)', () => {
  // La barre est un composant unique : aucune règle .bnav propre au recruteur.
  assert.match(recruiterHtml, /<nav class="bnav" id="bnav"/);
  assert.match(candidateHtml, /<nav class="bnav" id="bnav"/);
  assert.equal(ds.blocks(ds.read('features')).filter((b) => /(^|[\s,])\.bnav([\s,{]|$)/.test(b.prelude)).length, 0);
});

test('swipe : aucun écouteur touchmove non passif global (bloquerait chaque défilement)', () => {
  for (const html of [candidateHtml, recruiterHtml]) {
    assert.doesNotMatch(html, /window\.addEventListener\('touchmove'/);
    assert.match(html, /card\.addEventListener\('touchmove',m,\{passive:false\}\)/);
  }
});

test('Coach L/M/P : colonne contrainte, enfants rétrécissables, actions et zone de saisie dans la largeur', () => {
  const conversation = rule(ds.media(spaceCss), '.coach-conversation');
  assert.match(conversation, /display:grid/);
  assert.match(conversation, /grid-template-columns:minmax\(0,1fr\)/, 'une piste implicite auto s’élargit au contenu insécable');
  assert.match(rule(ds.media(spaceCss), '.coach-conversation>*,.coach-conversation-head>div'), /min-width:0/);
  assert.match(rule(ds.media(spaceCss), '.coach-conversation-head h2'), /overflow-wrap:anywhere/);
  assert.match(rule(ds.media(spaceCss), '.coach-composer textarea'), /min-width:0/);
  assert.match(rule(mobile, '.coach-conversation-head'), /flex-wrap:wrap/);
  assert.match(rule(mobile, '.coach-head-actions .btn'), /min-height:44px/);
});

test('Coach N/O/R : messages utilisateur et Coach reviennent à la ligne, y compris URL/mot très long', () => {
  const bubble = rule(ds.media(spaceCss), '.coach-message p,.coach-bubble');
  assert.match(bubble, /white-space:pre-wrap/);
  assert.match(bubble, /overflow-wrap:anywhere/);
  // Aucune règle ultérieure ne rétablit un retour à la ligne impossible sur les bulles.
  for (const match of spaceCss.matchAll(/\.coach-(?:bubble|message)[^{]*\{([^}]*)\}/g)) {
    assert.doesNotMatch(match[1], /white-space:\s*nowrap|overflow-wrap:\s*normal|word-break:\s*keep-all/);
  }
});

test('Coach : hauteur mobile indépendante de la barre d’adresse (svh), sans masquage global du débordement', () => {
  assert.match(rule(mobile, '.coach-conversation'), /height:calc\(100svh - 156px\)/);
  assert.doesNotMatch(rule(mobile, '.coach-conversation'), /dvh/);
  // Le correctif ne repose pas sur un overflow-x:hidden du document.
  assert.doesNotMatch(spaceCss, /(?:^|[\s,}])(?:html|body)[^{]*\{[^}]*overflow-x:\s*hidden/);
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
  const layout = rule(ds.media(spaceCss), '.coach-layout');
  assert.match(layout, /display:grid/);
  assert.match(layout, /grid-template-columns:minmax\(0,1fr\)/, 'piste implicite auto : la liste d’historique élargissait tout le Coach');
  assert.match(rule(ds.media(spaceCss), '.coach-layout>*'), /min-width:0/);
  const toolbar = rule(ds.media(spaceCss), '.cv-toolbar');
  assert.match(toolbar, /flex:0 0 auto/);
  assert.match(toolbar, /max-width:100%/);
  // La liste d’historique reste un défilement horizontal interne sur mobile.
  assert.match(rule(mobile, '.coach-history-list'), /display:flex;overflow-x:auto/);
});

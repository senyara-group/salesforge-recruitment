// Pipeline Kanban V2 : couche visuelle seulement. Isolation CSS (aucune règle hors du
// Pipeline), marquage des cibles de dépôt dérivé des transitions de la carte, moteur
// (writer, transitions, expected_statut) intact. Rendu réel : check-recruiter-kanban-v2-layout.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { applicationMoves } = require('../utils/pipelineSummary');

const ROOT = path.resolve(__dirname, '../..');
const html = fs.readFileSync(path.join(ROOT, 'frontend/_spaces/recruteur.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'frontend/recruiter-pipeline.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function extract(signature) {
  const start = html.indexOf(signature);
  assert.ok(start >= 0, signature);
  let depth = 0;
  for (let i = html.indexOf('{', start); i < html.length; i += 1) {
    if (html[i] === '{') depth += 1;
    if (html[i] === '}' && --depth === 0) return html.slice(start, i + 1);
  }
  throw new Error(signature);
}

test('CSS V2 : chaque sélecteur est limité au Pipeline et la feuille est chargée en dernier', () => {
  const selectors = [];
  const body = css.replace(/@media[^{]*\{/g, '');
  for (const match of body.matchAll(/([^{}]+)\{[^{}]*\}/g)) selectors.push(...match[1].split(',').map((s) => s.trim()).filter(Boolean));
  assert.ok(selectors.length > 40);
  assert.deepEqual(selectors.filter((s) => !s.startsWith('#p-pipeline')), []);
  assert.doesNotMatch(css, /:root|(^|[\s,}])(html|body)\b/);
  assert.match(html, /recruiter-desktop\.css">\s*<link rel="stylesheet" href="\.\.\/recruiter-pipeline\.css">/);
});

test('cibles de dépôt : marquées depuis les transitions de la carte, source neutre, nettoyées au dragend', () => {
  const card = { id: '7', statut: 'envoyee', moves: applicationMoves('envoyee') };
  const allowed = new Set(card.moves.map((m) => m.stage));
  const make = (stage) => ({ dataset: { stage }, classes: new Set(), classList: null });
  const cols = ['nouveau', 'vu', 'contacte', 'entretien', 'offre', 'termine'].map(make);
  const board = make('board');
  const ghost = make('card');
  for (const el of [...cols, board, ghost]) el.classList = { add: (...c) => c.forEach((x) => el.classes.add(x)), remove: (...c) => c.forEach((x) => el.classes.delete(x)), contains: (c) => el.classes.has(c) };
  const sandbox = {
    PIPELINE: { nouveau: [card], vu: [], contacte: [], entretien: [], offre: [], termine: [] }, PIPELINE_CARDS: { 7: card }, PIPE_DRAG_ID: '7',
    RecruiterKanban: require('../../frontend/recruiter-kanban.js'),
    requestAnimationFrame: (fn) => fn(),
    document: {
      getElementById: (id) => (id === 'pipe-cols' ? board : null),
      querySelectorAll: (selector) => (selector === '#pipe-cols .pipe-col' ? cols : [...cols, board, ghost].filter((el) => [...el.classes].some((c) => selector.includes('.' + c)))),
    },
  };
  vm.runInNewContext(`${extract('function pipelineMarkDropTargets(id, cardEl)')}\n${extract('function pipelineDragEnd()')}\nthis.mark = pipelineMarkDropTargets; this.end = pipelineDragEnd;`, sandbox);
  sandbox.mark('7', ghost);
  assert.ok(board.classes.has('is-dragging-board'));
  assert.ok(ghost.classes.has('is-ghost'));
  for (const col of cols) {
    const expected = col.dataset.stage === 'nouveau' ? 'is-source' : allowed.has(col.dataset.stage) ? 'can-drop' : 'no-drop';
    assert.deepEqual([...col.classes], [expected], col.dataset.stage);
  }
  sandbox.end();
  assert.deepEqual([...cols, board, ghost].flatMap((el) => [...el.classes]), []);
});

test('moteur inchangé : dépôt, transitions, rollback et expected_statut restent ceux du lot validé', () => {
  const drop = extract('function pipelineDrop(event, stage)');
  assert.match(drop, /choices.length === 1 && stage !== 'termine'/);
  assert.match(extract('function pipelineDragOver(event, stage)'), /card\?\.moves\?\.some\(move => move\.stage === stage\)/);
  assert.match(html, /request: \(id, statut, expected_statut\) => api\('PUT', '\/candidatures\/' \+ encodeURIComponent\(id\) \+ '\/status', \{ statut, expected_statut \}\)/);
  // Rendu : mêmes crochets que les tests et le moteur utilisent.
  const render = extract('function renderPipeline()');
  assert.match(render, /class="pipe-col" data-stage="\$\{stage\.key\}" ondragover="pipelineDragOver\(event,'\$\{stage\.key\}'\)"/);
  assert.match(render, /<select class="pipe-move" data-move-id="\$\{id\}"/);
  assert.match(render, /PIPELINE_COUNTS\?\.\[stage\.key\] \?\? cards\.length/);
});

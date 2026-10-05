const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Kanban = require('../../frontend/recruiter-kanban');
const { applicationMoves } = require('../utils/pipelineSummary');
const { TRANSITIONS } = require('../utils/applicationWorkflow');
const { emptyPipelineStages, stageForStatut, comparePipelineNewestFirst } = require('../utils/pipelineQuery');
const html = fs.readFileSync(path.join(__dirname, '../../frontend/_spaces/recruteur.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../../frontend/recruiter-dashboard.css'), 'utf8');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function card(id, statut = 'envoyee', created_at = '2026-10-01T00:00:00Z') {
  return { id, statut, created_at, moves: applicationMoves(statut), name: 'Candidat', tags: [] };
}
function fixture(cards) {
  let state = emptyPipelineStages();
  cards.forEach(c => { state = Kanban.put(state, stageForStatut(c.statut), c); });
  let counts = Object.fromEntries(Object.entries(state).map(([key, rows]) => [key, rows.length]));
  const calls = [];
  const writer = Kanban.createWriter({
    getState: () => state, setState: value => { state = value; },
    getCounts: () => counts, setCounts: value => { counts = value; }, changed() {},
    request(id, status, expected) { const d = deferred(); calls.push({ id, status, expected, ...d }); return d.promise; },
  });
  return { writer, calls, get state() { return state; }, get counts() { return counts; },
    succeed(index) { const call = calls[index]; call.resolve({ statut: call.status, moves: applicationMoves(call.status) }); } };
}

test('H — chaque destination vient des transitions réelles, sans retour arrière ni statut inventé', () => {
  for (const [status, values] of Object.entries(TRANSITIONS)) {
    assert.deepEqual(applicationMoves(status).map(m => m.statut), [...values]);
    for (const move of applicationMoves(status)) assert.equal(move.stage, stageForStatut(move.statut));
  }
  assert.deepEqual(applicationMoves('archivé'), []);
  assert.deepEqual(applicationMoves('qualifié'), []);
  assert.deepEqual(applicationMoves('offre').map(m => m.statut), ['embauche', 'refusee']);
});
test('I/J/O — nouveau → consulté → contacté, statut et compteurs optimistes puis confirmés', async () => {
  const f = fixture([card('a')]);
  const first = f.writer.move('a', 'vu'); await tick();
  assert.equal(f.state.nouveau.length, 0); assert.equal(f.state.vu.length, 1);
  assert.equal(f.counts.nouveau, 0); assert.equal(f.counts.vu, 1);
  assert.equal(f.calls[0].expected, 'envoyee');
  f.succeed(0); await first;
  const second = f.writer.move('a', 'contacte'); await tick();
  assert.equal(f.calls[1].expected, 'vu'); f.succeed(1); await second;
  assert.equal(f.state.contacte[0].statut, 'contacte');
  assert.equal(f.counts.vu, 0); assert.equal(f.counts.contacte, 1);
});
test('L/M/N — erreur : restauration exacte de la carte, ordre et compteurs, sans perte ni doublon', async () => {
  const f = fixture([card('c'), card('a'), card('b')]);
  const before = structuredClone(f.state), counts = { ...f.counts };
  const move = f.writer.move('b', 'contacte');
  const rejected = assert.rejects(move, /offline/);
  await tick(); f.calls[0].reject(new Error('offline')); await rejected;
  assert.deepEqual(f.state, before); assert.deepEqual(f.counts, counts);
  assert.equal(Object.values(f.state).flat().length, 3);
});
test('P — déplacements rapides de la même carte sérialisés par verrou, un seul appel en vol', async () => {
  const f = fixture([card('a')]);
  const first = f.writer.move('a', 'vu');
  assert.equal(f.writer.move('a', 'contacte'), first);
  await tick(); assert.equal(f.calls.length, 1); f.succeed(0); await first;
  assert.equal(f.writer.pending.size, 0);
  const next = f.writer.move('a', 'contacte'); await tick(); f.succeed(1); await next;
  assert.equal(f.state.contacte[0].statut, 'contacte');
});
test('Q — réponse B puis erreur A : rollback A ne défait jamais B', async () => {
  const f = fixture([card('a'), card('b')]);
  const a = f.writer.move('a', 'vu'), b = f.writer.move('b', 'contacte');
  const rejected = assert.rejects(a, /refus/);
  await tick(); f.succeed(1); await b;
  f.calls[0].reject(new Error('refus')); await rejected;
  assert.deepEqual(f.state.nouveau.map(c => c.id), ['a']);
  assert.deepEqual(f.state.contacte.map(c => c.id), ['b']);
  assert.equal(f.counts.nouveau, 1); assert.equal(f.counts.contacte, 1); assert.equal(f.counts.vu, 0);
});
test('Q/R — refresh attend toutes les écritures, même terminées hors ordre', async () => {
  const f = fixture([card('a'), card('b')]);
  const a = f.writer.move('a', 'vu'), b = f.writer.move('b', 'contacte');
  let refreshed = false;
  const idle = f.writer.idle().then(() => { refreshed = true; });
  await tick(); f.succeed(1); await b; assert.equal(refreshed, false);
  f.succeed(0); await a; await idle; assert.equal(refreshed, true);
});
test('M/N/R — pages fusionnées globalement par candidature, même après changement de colonne', () => {
  let state = emptyPipelineStages(); state.nouveau = [card('a'), card('b')];
  state = Kanban.merge(state, { contacte: [card('a', 'contacte'), card('a', 'contacte')] });
  assert.deepEqual(state.nouveau.map(c => c.id), ['b']);
  assert.deepEqual(state.contacte.map(c => c.id), ['a']);
  assert.equal(Object.values(state).flat().length, 2);
});
test('ordre déterministe identique au curseur backend, dates nulles en dernier', () => {
  const cards = [card('a', 'vu', null), card('b'), card('c'), card('d', 'vu', '2026-09-01')];
  assert.deepEqual([...cards].sort(Kanban.compare), [...cards].sort(comparePipelineNewestFirst));
});
test('statut Réponse reçue : même colonne, compteurs inchangés', async () => {
  const f = fixture([card('a', 'contacte')]); const move = f.writer.move('a', 'repondu');
  await tick(); assert.equal(f.counts.contacte, 1); f.succeed(0); await move;
  assert.equal(f.state.contacte[0].statut, 'repondu');
});
test('transition interdite : aucune mutation ni appel réseau', async () => {
  const f = fixture([card('a')]); const before = structuredClone(f.state);
  await assert.rejects(f.writer.move('a', 'embauche'), /Transition/);
  assert.deepEqual(f.state, before); assert.equal(f.calls.length, 0);
});

function functionSource(name, next) {
  const start = html.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name);
  return html.slice(start, html.indexOf('\nfunction ' + next + '(', start));
}
test('C/D/E — vrai rendu dashboard avec zéro et 12001 candidatures, aucune division par zéro', () => {
  for (const total of [0, 12001]) {
    const nodes = {};
    const context = vm.createContext({ document: { getElementById(id) { return nodes[id] ||= {}; } },
      PIPE_STAGES: [{ key: 'nouveau', label: 'Nouveaux' }, { key: 'termine', label: 'Terminées' }] });
    vm.runInContext(functionSource('renderDashStats', 'renderDashRecentOffers'), context);
    context.stats = { recues: total, recues_new: 7, pipeline: total, offres: 3, chauds: 4, stages: { nouveau: total, termine: 0 } };
    vm.runInContext('renderDashStats(stats)', context);
    assert.equal(nodes['kpi-recues'].textContent, total || '0');
    assert.equal(nodes['kpi-offres'].textContent, 3);
    assert.match(nodes['kpi-recues-t'].textContent, /7 derniers jours/);
    assert.match(nodes['dash-stages'].innerHTML, new RegExp('<strong>' + total + '</strong>'));
    assert.doesNotMatch(nodes['dash-stages'].innerHTML, /NaN|Infinity/);
  }
});
test('A/B/F/G — CSS scoped : scroll naturel, largeur bornée, mobile empilé et desktop sans double padding', () => {
  assert.match(html, /app-professional.css[\s\S]*recruiter-dashboard.css/);
  assert.match(css, /max-width: 1360px/);
  assert.match(css, /#p-dashboard \.dash-shell \{ padding: 0; \}/);
  assert.match(css, /scrollbar-width: auto/);
  assert.match(css, /#p-dashboard \.dash-bottom \{ grid-template-columns: minmax\(0, 1fr\)/);
  assert.doesNotMatch(css, /(?:html|body|#p-dashboard)[^{]*\{[^}]*(?:overflow-y:\s*hidden|height:\s*100(?:d?vh|%))/);
  assert.match(css, /#p-pipeline \.pipe-cols \{ display: flex; overflow-x: auto/);
  assert.match(css, /#p-dashboard \.dash-stages \{[^}]*repeat\(6, minmax\(0, 1fr\)\)/);
});
test('S/T — alternative native clavier/tactile, drag réservé au pointeur fin desktop', () => {
  assert.match(html, /<select class="pipe-move"[^>]*aria-label=/);
  assert.match(html, /onchange="movePipelineCard/);
  assert.match(html, /\(min-width:1024px\) and \(pointer:fine\)/);
  assert.match(html, /<button type="button" class="pipe-open"/);
  assert.match(html, /id="pipeline-feedback" role="status" aria-live="polite"/);
  assert.match(css, /\.pipe-move \{[^}]*min-height: 44px/);
  assert.doesNotMatch(css, /touch-action:\s*none/);
});
test('dépôt terminal : choix explicite du résultat, aucun recrutement/refus arbitraire', () => {
  const start = html.indexOf('function pipelineDrop('), end = html.indexOf('function openSnapshotCV(', start);
  const block = html.slice(start, end);
  assert.match(block, /choices.length === 1 && stage !== 'termine'/);
  assert.match(block, /choices.map\(choice => choice.label\)/);
  assert.match(block, /\.focus\(/);
});

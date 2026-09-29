// Lot 6 — composant commun d'autocomplétion de communes (frontend/commune-autocomplete.js).
// Faux DOM minimal + timers et fetch contrôlables : on teste le vrai composant.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Autocomplete = require('../../frontend/commune-autocomplete.js');
const { parseLocationQuery, locationTextMatches } = require('../utils/locationFilter');

const FRONTEND = path.resolve(__dirname, '../../frontend');
const read = (file) => fs.readFileSync(path.join(FRONTEND, file), 'utf8').replace(/\r\n/g, '\n');

// ------------------------------------------------------------------ faux DOM
class FakeElement {
  constructor(doc, tag, id = '') {
    this.ownerDocument = doc;
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.attributes = {};
    this.classes = new Set();
    this.childNodes = [];
    this.listeners = {};
    this.textContent = '';
    this.value = '';
    this.hidden = false;
    const el = this;
    this.classList = {
      add: (c) => el.classes.add(c), remove: (c) => el.classes.delete(c), contains: (c) => el.classes.has(c),
      toggle: (c, on) => { if (on === undefined ? !el.classes.has(c) : on) el.classes.add(c); else el.classes.delete(c); },
    };
  }
  set className(value) { this.classes = new Set(String(value).split(/\s+/).filter(Boolean)); }
  get className() { return [...this.classes].join(' '); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null; }
  removeAttribute(name) { delete this.attributes[name]; }
  appendChild(child) { child.parentNode = this; this.childNodes.push(child); if (child.id) this.ownerDocument.byId[child.id] = child; return child; }
  removeChild(child) { this.childNodes = this.childNodes.filter((c) => c !== child); delete this.ownerDocument.byId[child.id]; return child; }
  get firstChild() { return this.childNodes[0] || null; }
  contains(node) { return node === this || this.childNodes.some((child) => child.contains(node)); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); }
  dispatch(type, extra = {}) {
    const event = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
    (this.listeners[type] || []).forEach((fn) => fn(event));
    return event;
  }
  scrollIntoView() { this.scrolled = (this.scrolled || 0) + 1; }
}
function makeDoc() {
  const doc = { byId: {}, listeners: {} };
  doc.getElementById = (id) => doc.byId[id] || null;
  doc.createElement = (tag) => new FakeElement(doc, tag);
  doc.addEventListener = (type, fn) => { (doc.listeners[type] ||= []).push(fn); };
  doc.removeEventListener = (type, fn) => { doc.listeners[type] = (doc.listeners[type] || []).filter((f) => f !== fn); };
  doc.dispatch = (type, target) => (doc.listeners[type] || []).forEach((fn) => fn({ type, target }));
  doc.add = (tag, id) => { const el = new FakeElement(doc, tag, id); doc.byId[id] = el; return el; };
  return doc;
}
function makeTimers() {
  let queue = [];
  let id = 0;
  return {
    setTimeoutImpl: (fn, ms) => { id += 1; queue.push({ id, fn, ms }); return id; },
    clearTimeoutImpl: (handle) => { queue = queue.filter((t) => t.id !== handle); },
    pending: () => queue.length,
    flush: () => { const current = queue; queue = []; current.forEach((t) => t.fn()); },
  };
}
function makeFetch() {
  const calls = [];
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    calls.push({ url, init, resolve: (data, ok = true) => resolve({ ok, status: ok ? 200 : 503, json: async () => data }), reject });
  });
  return { calls, fetchImpl };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

function setup(options = {}) {
  const doc = makeDoc();
  const input = doc.add('input', 'city');
  doc.add('div', 'city-list');
  const status = doc.add('div', 'city-status');
  status.hidden = true;
  const timers = makeTimers();
  const net = makeFetch();
  const selected = [];
  const widget = Autocomplete.attach(input, {
    doc, listId: 'city-list', statusId: 'city-status', fetchImpl: net.fetchImpl,
    setTimeoutImpl: timers.setTimeoutImpl, clearTimeoutImpl: timers.clearTimeoutImpl,
    onSelect: (item) => selected.push(item), ...options,
  });
  const list = doc.getElementById('city-list');
  const type = (value) => { input.value = value; input.dispatch('input'); };
  const key = (k) => input.dispatch('keydown', { key: k });
  // fetch part dans une microtâche : on laisse la boucle tourner après le debounce.
  const flush = async () => { timers.flush(); await tick(); };
  return { doc, input, list, status, timers, net, widget, selected, type, key, flush };
}
const labels = (list) => list.childNodes.map((node) => node.textContent);

const COMMUNES = [
  { nom: 'Saint-Étienne', codeDepartement: '42' },
  { nom: "L'Haÿ-les-Roses", codeDepartement: '94' },
  { nom: "Villeneuve-d'Ascq", codeDepartement: '59' },
  { nom: 'Saint-Denis', codeDepartement: '93' },
  { nom: 'Saint-Denis', codeDepartement: '974' },
  { nom: 'Saint-Denis', codeDepartement: '974' }, // doublon exact : ignoré
  { nom: '', codeDepartement: '01' }, null, { nom: 42 },
];

test('ARIA combobox/listbox posé à l’attache ; aucune requête avant 2 caractères', () => {
  const { input, list, status, type, timers, net } = setup();
  assert.equal(input.getAttribute('role'), 'combobox');
  assert.equal(input.getAttribute('aria-autocomplete'), 'list');
  assert.equal(input.getAttribute('aria-expanded'), 'false');
  assert.equal(input.getAttribute('aria-controls'), 'city-list');
  assert.equal(list.getAttribute('role'), 'listbox');
  assert.equal(status.getAttribute('aria-live'), 'polite');
  type('L');
  timers.flush();
  assert.equal(net.calls.length, 0);
});

test('D/E/F/G. accents, tirets, apostrophes, noms composés, homonymes : libellé lisible, valeur = nom', async () => {
  assert.deepEqual(Autocomplete.communeSuggestions(COMMUNES), [
    { label: 'Saint-Étienne (42)', value: 'Saint-Étienne' },
    { label: "L'Haÿ-les-Roses (94)", value: "L'Haÿ-les-Roses" },
    { label: "Villeneuve-d'Ascq (59)", value: "Villeneuve-d'Ascq" },
    { label: 'Saint-Denis (93)', value: 'Saint-Denis' },
    { label: 'Saint-Denis (974)', value: 'Saint-Denis' },
  ]);
  assert.equal(Autocomplete.buildUrl("L'Haÿ les"), 'https://geo.api.gouv.fr/communes?nom=L\'Ha%C3%BF%20les&fields=nom%2CcodeDepartement&boost=population&limit=8'.replace('%2C', ','));
  const { type, net, list, input, flush } = setup();
  type('saint');
  await flush();
  net.calls[0].resolve(COMMUNES);
  await tick();
  assert.deepEqual(labels(list), ['Saint-Étienne (42)', "L'Haÿ-les-Roses (94)", "Villeneuve-d'Ascq (59)", 'Saint-Denis (93)', 'Saint-Denis (974)']);
  assert.equal(input.getAttribute('aria-expanded'), 'true');
  // La valeur choisie reste compatible avec le moteur de filtre tolérant (et l'historique).
  assert.equal(locationTextMatches('Saint Etienne', parseLocationQuery('Saint-Étienne')), true);
  assert.equal(locationTextMatches("Villeneuve d'Ascq (59)", parseLocationQuery("Villeneuve-d'Ascq")), true);
});

test('K/L. clavier ↑ ↓ Entrée Échap et sélection souris', async () => {
  const { type, key, timers, net, list, input, selected, flush } = setup();
  type('sai');
  await flush();
  net.calls[0].resolve(COMMUNES);
  await tick();
  key('ArrowDown');
  assert.equal(input.getAttribute('aria-activedescendant'), 'city-list-opt-0');
  assert.equal(list.childNodes[0].getAttribute('aria-selected'), 'true');
  key('ArrowDown');
  key('ArrowUp');
  key('ArrowUp'); // boucle vers la fin
  assert.equal(input.getAttribute('aria-activedescendant'), 'city-list-opt-4');
  key('ArrowDown'); // retour au début
  const enter = input.dispatch('keydown', { key: 'Enter' });
  assert.equal(enter.defaultPrevented, true);
  assert.equal(input.value, 'Saint-Étienne');
  assert.deepEqual(selected.map((item) => item.value), ['Saint-Étienne']);
  assert.equal(input.getAttribute('aria-expanded'), 'false');
  // Échap ferme sans modifier la saisie.
  type('sai');
  timers.flush();
  assert.equal(net.calls.length, 1); // requête identique : servie par le cache
  assert.equal(list.classList.contains('on'), true);
  key('Escape');
  assert.equal(list.classList.contains('on'), false);
  assert.equal(input.value, 'sai');
  // Entrée sans option active : ne sélectionne rien (le formulaire garde la saisie).
  const plainEnter = input.dispatch('keydown', { key: 'Enter' });
  assert.equal(plainEnter.defaultPrevented, false);
  // Souris : mousedown sur une option.
  type('sai');
  timers.flush();
  const option = list.childNodes[2];
  const down = option.dispatch('mousedown');
  assert.equal(down.defaultPrevented, true); // le champ garde le focus
  assert.equal(input.value, "Villeneuve-d'Ascq");
});

test('H/I. aucune suggestion et erreur API : message discret, saisie libre conservée, rien ne casse', async () => {
  const empty = setup();
  empty.type('zzzz');
  empty.timers.flush();
  assert.equal(empty.status.textContent, Autocomplete.STATUS.loading);
  await tick();
  empty.net.calls[0].resolve([]);
  await tick();
  assert.equal(empty.status.textContent, Autocomplete.STATUS.empty);
  assert.equal(empty.status.hidden, false);
  assert.equal(empty.list.classList.contains('on'), false);
  assert.equal(empty.input.value, 'zzzz');

  const failing = setup();
  failing.type('lyon');
  await failing.flush();
  failing.net.calls[0].reject(new TypeError('Failed to fetch'));
  await tick();
  assert.equal(failing.status.textContent, Autocomplete.STATUS.error);
  assert.equal(failing.input.value, 'lyon');

  const http = setup();
  http.type('lyon');
  await http.flush();
  http.net.calls[0].resolve({ error: 'x' }, false);
  await tick();
  assert.equal(http.status.textContent, Autocomplete.STATUS.error);
});

test('J. réponse obsolète arrivée en retard : ignorée, requête précédente annulée, debounce', async () => {
  const { type, timers, net, list, flush } = setup();
  type('Ly');
  type('Lyo'); // même fenêtre de debounce : une seule requête planifiée
  assert.equal(timers.pending(), 1);
  await flush();
  type('Lyon');
  await flush();
  assert.equal(net.calls.length, 2);
  assert.match(net.calls[0].url, /nom=Lyo&/);
  assert.equal(net.calls[0].init.signal.aborted, true); // la plus ancienne est annulée
  net.calls[1].resolve([{ nom: 'Lyon', codeDepartement: '69' }]);
  await tick();
  net.calls[0].resolve([{ nom: 'Lyons-la-Forêt', codeDepartement: '27' }]);
  await tick();
  assert.deepEqual(labels(list), ['Lyon (69)']);
});

test('M. effacement : liste fermée, statut vidé, aucune requête ; clic extérieur ferme', async () => {
  const { type, timers, net, list, status, input, doc, flush } = setup();
  type('lil');
  await flush();
  net.calls[0].resolve([{ nom: 'Lille', codeDepartement: '59' }]);
  await tick();
  assert.equal(list.classList.contains('on'), true);
  doc.dispatch('mousedown', list.childNodes[0]); // clic dans la liste : reste ouverte
  assert.equal(list.classList.contains('on'), true);
  doc.dispatch('mousedown', doc.createElement('div'));
  assert.equal(list.classList.contains('on'), false);
  type('');
  assert.equal(timers.pending(), 0);
  assert.equal(net.calls.length, 1);
  assert.equal(status.hidden, true);
  assert.equal(input.getAttribute('aria-expanded'), 'false');
});

test('N. valeur historique libre : jamais réécrite sans sélection explicite', async () => {
  const { type, net, input, selected, flush } = setup();
  type('Lille (59)');
  await flush();
  net.calls[0].resolve([{ nom: 'Lille', codeDepartement: '59' }]);
  await tick();
  input.dispatch('keydown', { key: 'Tab' });
  assert.equal(input.value, 'Lille (59)');
  assert.deepEqual(selected, []);
  // Le filtre tolérant retrouve toujours les formats historiques.
  for (const stored of ['Lille', 'Lille (59)', 'LILLE']) assert.equal(locationTextMatches(stored, parseLocationQuery('Lille')), true);
});

test('A/B/C. une seule implémentation branchée sur les 4 champs (offre, profil, Opportunités, Sourcing)', () => {
  const candidat = read('_spaces/candidat.html');
  const recruteur = read('_spaces/recruteur.html');
  for (const html of [candidat, recruteur]) {
    assert.match(html, /<script src="\.\.\/commune-autocomplete\.js"><\/script>\n<script>/);
    assert.doesNotMatch(html, /function (searchVilles|fetchVilles|pickVille)\b|geo\.api\.gouv\.fr\/communes/);
  }
  assert.match(candidat, /attach\(document\.getElementById\('edit-ville'\), \{ listId: 'edit-ville-list', statusId: 'edit-ville-status' \}\)/);
  assert.match(candidat, /attach\(document\.getElementById\('filt-location'\), \{ listId: 'filt-location-list', statusId: 'filt-location-status', revealList: true \}\)/);
  assert.match(recruteur, /attach\(document\.getElementById\('of-lieu'\), \{/);
  assert.match(recruteur, /attach\(document\.getElementById\('filt-cand-location'\), \{/);
  // Repli sans le script : les pages restent utilisables (garde window.SwipCommuneAutocomplete).
  assert.match(candidat, /if \(window\.SwipCommuneAutocomplete\) \{/);
  assert.match(recruteur, /if \(window\.SwipCommuneAutocomplete\) \{/);
  const url = fs.readFileSync(path.join(FRONTEND, 'commune-autocomplete.js'), 'utf8').match(/https:\/\/[^'"]+/g);
  assert.deepEqual(url, ['https://geo.api.gouv.fr/communes']); // une seule API, déjà utilisée auparavant
});

test('C. lieu d’offre : Remote / France entière, sélection obligatoire conservée (LIEU_SELECTIONNE)', () => {
  const recruteur = read('_spaces/recruteur.html');
  const start = recruteur.indexOf('const OFFER_LOCATION_SPECIAL');
  const end = recruteur.indexOf('\n}\n', recruteur.indexOf('} else {', start)) + 3;
  const captured = [];
  const sandbox = {
    window: {}, LIEU_SELECTIONNE: false,
    document: { getElementById: (id) => ({ id, addEventListener() {} }) },
  };
  sandbox.window.SwipCommuneAutocomplete = { MIN_CHARS: 2, attach: (input, options) => captured.push([input.id, options]) };
  sandbox.SwipCommuneAutocomplete = sandbox.window.SwipCommuneAutocomplete;
  vm.runInNewContext(`${recruteur.slice(start, end)}\nthis.getSelected = () => LIEU_SELECTIONNE;`.replace('let LIEU', 'var LIEU'), sandbox);
  const [id, offer] = captured[0];
  assert.equal(id, 'of-lieu');
  assert.equal(offer.openOnFocus, true);
  assert.deepEqual(Array.from(offer.extraItems(''), (item) => item.value), ['Remote / Télétravail', 'France entière']);
  assert.deepEqual(Array.from(offer.extraItems('télétravail'), (item) => item.value), ['Remote / Télétravail', 'France entière']);
  assert.equal(offer.extraItems('Lyon').length, 0);
  assert.equal(offer.shouldFetch('Lyon'), true);
  assert.equal(offer.shouldFetch('L'), false);
  assert.equal(offer.shouldFetch('remote'), false);
  // LIEU_SELECTIONNE est une variable du script de page (let) : on vérifie les callbacks.
  assert.match(offer.onInput.toString(), /LIEU_SELECTIONNE = false/);
  assert.match(offer.onSelect.toString(), /LIEU_SELECTIONNE = true/);
  assert.equal(captured[1][0], 'filt-cand-location');
  assert.equal(captured[1][1].revealList, true);
  assert.equal(captured[1][1].onSelect, undefined); // filtre : saisie libre acceptée
});

test('T/U. mobile : liste en flux dans les feuilles de filtres (non rognée), cibles 44 px, statut discret', () => {
  // Validé aussi en navigateur réel (Chrome headless, 390/430/desktop) : voir backend/FILTERS_AUDIT.md.
  for (const [file, field] of [['_spaces/candidat.html', 'filt-location'], ['_spaces/recruteur.html', 'filt-cand-location']]) {
    const html = read(file);
    assert.match(html, /\.autocomplete-list\.is-inline\{position:static;[^}]*max-height:264px;scroll-margin-bottom:104px\}/, file);
    assert.match(html, /\.autocomplete-item\{min-height:44px;/, file);
    assert.match(html, /\.autocomplete-status\[hidden\]\{display:none\}/, file);
    assert.match(html, new RegExp(`<div class="autocomplete-list is-inline" id="${field}-list"></div>`), file);
    assert.match(html, new RegExp(`<div class="autocomplete-status" id="${field}-status" hidden></div>`), file);
  }
});

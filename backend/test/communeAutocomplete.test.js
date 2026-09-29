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
  focus() { this.ownerDocument.activeElement = this; }
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
  assert.match(candidat, /attach\(document\.getElementById\('filt-location'\), \{\n    listId: 'filt-location-list', statusId: 'filt-location-status', revealList: true,\n    context: document\.getElementById\('filters-ov'\),\n  \}\)/);
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

// ------------------------------------------------------------------ correctif final Lot 6
const FREE_TEXT_WORDING = /tel quel|librement|saisie libre|texte saisi|sera utilisé|accept/i;

function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `signature introuvable: ${signature}`);
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('fin introuvable');
}

/** Vrai bloc d'attache de la page recruteur + vrai postOffre, branchés sur le vrai composant. */
function offerPage() {
  const recruteur = read('_spaces/recruteur.html');
  const doc = makeDoc();
  for (const [tag, id] of [['input', 'of-lieu'], ['div', 'of-lieu-list'], ['div', 'of-lieu-status'],
    ['input', 'filt-cand-location'], ['div', 'filt-cand-location-list'], ['div', 'filt-cand-location-status'], ['div', 'comp-filter-ov']]) doc.add(tag, id);
  const timers = makeTimers();
  const net = makeFetch();
  const stubs = {
    'of-titre': { value: 'AE Lille' }, 'of-salaire': { value: '45000 €' }, 'of-desc': { value: '' },
    'of-job-type': { value: 'Account Executive' }, 'of-sector': { value: '' }, 'of-auto': { checked: false },
  };
  const errors = [];
  const apiCalls = [];
  const captured = [];
  const component = {
    ...Autocomplete,
    attach: (input, opts) => {
      captured.push([input.id, opts]);
      return Autocomplete.attach(input, { ...opts, doc, fetchImpl: net.fetchImpl, setTimeoutImpl: timers.setTimeoutImpl, clearTimeoutImpl: timers.clearTimeoutImpl });
    },
  };
  const sandbox = {
    window: { SwipCommuneAutocomplete: component }, SwipCommuneAutocomplete: component,
    document: { getElementById: (id) => doc.byId[id] || stubs[id] || null },
    OF_TYPE: 'CDI', OF_REMOTE: '', OF_TAGS: [], EDITING_OFFER_ID: '', EDITING_OFFER_STATUS: 'active',
    showErr: (id, message) => errors.push(message), isValidSalaire: () => true, parseOptionalSalaryInput: () => null,
    setBtn() {}, toast() {}, go() {}, initNotifications() {},
    api: async (method, url, body) => { apiCalls.push({ method, url, lieu: body.lieu }); return {}; },
  };
  const start = recruteur.indexOf('const OFFER_LOCATION_SPECIAL');
  const end = recruteur.indexOf('\n}\n', recruteur.indexOf('} else {', start)) + 3;
  vm.runInNewContext([
    'let LIEU_SELECTIONNE = false;',
    extractFunction(recruteur, 'async function postOffre()'),
    recruteur.slice(start, end),
    'this.h = { postOffre, selected: () => LIEU_SELECTIONNE };',
  ].join('\n'), sandbox);
  const input = doc.byId['of-lieu'];
  const list = doc.byId['of-lieu-list'];
  const type = (value) => { input.focus(); input.value = value; input.dispatch('input'); };
  const pick = (label) => {
    const option = list.childNodes.find((node) => node.textContent === label);
    assert.ok(option, `option introuvable : ${label} (${labels(list).join(' | ')})`);
    option.dispatch('mousedown');
  };
  const submit = async (editingId = '') => {
    sandbox.EDITING_OFFER_ID = editingId;
    errors.length = 0;
    apiCalls.length = 0;
    await sandbox.h.postOffre();
    return { error: errors[0] || '', sent: apiCalls[0] ? apiCalls[0].lieu : null };
  };
  const flush = async () => { timers.flush(); await tick(); };
  return { doc, input, list, status: doc.byId['of-lieu-status'], net, flush, type, pick, submit, captured, apiCalls, h: sandbox.h };
}

test('A/B. #of-lieu : messages propres à la sélection obligatoire (aucun résultat, erreur API)', async () => {
  const page = offerPage();
  page.type('Zzzz');
  await page.flush();
  page.net.calls[0].resolve([]);
  await tick();
  assert.equal(page.status.textContent, 'Aucune commune trouvée. Choisissez une suggestion, ou utilisez Remote / Télétravail ou France entière.');
  assert.doesNotMatch(page.status.textContent, FREE_TEXT_WORDING);
  assert.equal((await page.submit()).error, 'Sélectionnez une localisation dans la liste proposée');

  page.type('Qwerty');
  await page.flush();
  page.net.calls[1].reject(new TypeError('Failed to fetch'));
  await tick();
  assert.equal(page.status.textContent, 'Suggestions indisponibles. Réessayez dans un instant.');
  assert.doesNotMatch(page.status.textContent, FREE_TEXT_WORDING);

  page.type('Http');
  await page.flush();
  page.net.calls[2].resolve({}, false);
  await tick();
  assert.equal(page.status.textContent, 'Suggestions indisponibles. Réessayez dans un instant.');
  // Les messages par défaut (saisie libre) restent ceux des autres instances.
  assert.equal(page.captured[1][0], 'filt-cand-location');
  assert.equal(page.captured[1][1].statusMessages, undefined);
});

test('C. filtres et profil : saisie libre conservée, message « tel quel » inchangé', async () => {
  const candidat = read('_spaces/candidat.html');
  const recruteur = read('_spaces/recruteur.html');
  assert.doesNotMatch(candidat, /statusMessages/);
  assert.equal((recruteur.match(/statusMessages/g) || []).length, 1); // uniquement #of-lieu
  const { type, flush, net, status, input, list } = setup();
  type('Tombouctou-sur-Loire');
  await flush();
  net.calls[0].resolve([]);
  await tick();
  assert.equal(status.textContent, Autocomplete.STATUS.empty);
  assert.match(status.textContent, /tel quel/);
  assert.equal(input.value, 'Tombouctou-sur-Loire');
  assert.equal(list.classList.contains('on'), false);
});

test('D. Échap pendant la recherche : la réponse tardive ne rouvre pas la liste', async () => {
  const { type, key, flush, net, list, input, status, timers } = setup();
  input.focus();
  type('Lille');
  await flush();
  assert.equal(status.textContent, Autocomplete.STATUS.loading);
  const escape = input.dispatch('keydown', { key: 'Escape' });
  assert.equal(escape.defaultPrevented, false); // liste pas encore ouverte : Échap reste disponible pour la page
  assert.equal(net.calls[0].init.signal.aborted, true);
  assert.equal(status.hidden, true);
  net.calls[0].resolve([{ nom: 'Lille', codeDepartement: '59' }]);
  await tick();
  assert.equal(list.classList.contains('on'), false);
  assert.equal(input.getAttribute('aria-expanded'), 'false');
  // Échap pendant le debounce : aucune requête ne part.
  type('Lyon');
  key('Escape');
  assert.equal(timers.pending(), 0);
  await flush();
  assert.equal(net.calls.length, 1);
  // Nouvelle interaction : tout refonctionne.
  type('Lill');
  await flush();
  net.calls[1].resolve([{ nom: 'Lille', codeDepartement: '59' }]);
  await tick();
  assert.equal(list.classList.contains('on'), true);
  assert.equal(input.getAttribute('aria-expanded'), 'true');
  // Clic extérieur pendant une recherche : même garantie.
  type('Paris');
  await flush();
  input.ownerDocument.dispatch('mousedown', input.ownerDocument.createElement('div'));
  net.calls[2].resolve([{ nom: 'Paris', codeDepartement: '75' }]);
  await tick();
  assert.equal(list.classList.contains('on'), false);
});

test('E/F. fermeture du contexte (feuille de filtres) pendant la recherche, puis réouverture sans suggestion périmée', async () => {
  const observers = [];
  class FakeObserver {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(target, init) { this.target = target; this.init = init; }
    disconnect() { this.disconnected = true; }
  }
  const sheetDoc = makeDoc();
  const sheet = sheetDoc.add('div', 'sheet');
  sheet.classList.add('on');
  const fire = () => observers.forEach((o) => o.callback([]));
  const { input, list, status, type, flush, net, key } = setup({ context: sheet, MutationObserverImpl: FakeObserver });
  assert.equal(observers.length, 1);
  assert.equal(observers[0].target, sheet);
  assert.deepEqual(observers[0].init, { attributes: true, attributeFilter: ['class'] });
  input.focus();
  type('Saint');
  await flush();
  net.calls[0].resolve(COMMUNES);
  await tick();
  assert.equal(list.classList.contains('on'), true);
  key('ArrowDown');
  assert.ok(input.getAttribute('aria-activedescendant'));
  // Deuxième recherche en vol, puis la feuille se ferme (fond, Appliquer, Réinitialiser…).
  type('Sainte');
  await flush();
  sheet.classList.remove('on');
  fire();
  assert.equal(list.classList.contains('on'), false);
  assert.equal(input.getAttribute('aria-expanded'), 'false');
  assert.equal(input.getAttribute('aria-activedescendant'), null);
  assert.equal(list.childNodes.length, 0);
  assert.equal(status.hidden, true);
  assert.equal(net.calls[1].init.signal.aborted, true);
  net.calls[1].resolve([{ nom: 'Sainte-Maxime', codeDepartement: '83' }]);
  await tick();
  assert.equal(list.classList.contains('on'), false);
  assert.equal(list.childNodes.length, 0);
  // Réouverture : la page remet le champ à la valeur appliquée (ici vide) ; aucune liste périmée.
  sheet.classList.add('on');
  fire();
  input.value = '';
  key('ArrowDown');
  assert.equal(list.classList.contains('on'), false);
  assert.equal(list.childNodes.length, 0);
  type('Saint');
  await flush(); // requête identique : servie par le cache, liste de nouveau fonctionnelle
  assert.equal(list.classList.contains('on'), true);
  // Une réponse arrivée alors que le champ n'a plus le focus n'ouvre rien.
  type('Lyo');
  await flush();
  input.ownerDocument.activeElement = input.ownerDocument.createElement('button');
  net.calls[2].resolve([{ nom: 'Lyon', codeDepartement: '69' }]);
  await tick();
  assert.equal(labels(list).includes('Lyon (69)'), false);
});

test('G/H. défilement remis en haut à chaque rendu ; ↑ ↓ intacts', async () => {
  const { input, list, type, flush, net, key } = setup();
  input.focus();
  type('Saint');
  await flush();
  net.calls[0].resolve(COMMUNES);
  await tick();
  list.scrollTop = 90; // l'utilisateur descend dans la liste
  key('Escape');
  type('Sain');
  await flush();
  net.calls[1].resolve(COMMUNES);
  await tick();
  assert.equal(list.scrollTop, 0);
  // Réouverture au clavier de la même liste : on repart aussi du haut.
  list.scrollTop = 90;
  key('Escape');
  key('ArrowDown');
  assert.equal(list.scrollTop, 0);
  assert.equal(input.getAttribute('aria-activedescendant'), 'city-list-opt-0');
  key('ArrowDown');
  assert.equal(input.getAttribute('aria-activedescendant'), 'city-list-opt-1');
  key('ArrowUp');
  key('ArrowUp');
  assert.equal(input.getAttribute('aria-activedescendant'), 'city-list-opt-4'); // bouclage
  assert.ok(list.childNodes[4].scrolled >= 1); // l'option active reste visible
});

test('I/J/K/L. #of-lieu (vrai postOffre) : Lille → Paris tapé refusé ; Paris choisi, Remote, France entière acceptés', async () => {
  const page = offerPage();
  page.type('Lille');
  await page.flush();
  page.net.calls[0].resolve([{ nom: 'Lille', codeDepartement: '59' }]);
  await tick();
  page.pick('Lille (59)');
  assert.equal(page.h.selected(), true);
  // I : Paris tapé à la main, sans sélection.
  page.type('Paris');
  assert.equal(page.h.selected(), false);
  assert.deepEqual(await page.submit(), { error: 'Sélectionnez une localisation dans la liste proposée', sent: null });
  assert.deepEqual(await page.submit('offer-123'), { error: 'Sélectionnez une localisation dans la liste proposée', sent: null });
  assert.equal(page.apiCalls.length, 0);
  // J : Paris sélectionnée.
  await page.flush();
  page.net.calls[1].resolve([{ nom: 'Paris', codeDepartement: '75' }]);
  await tick();
  page.pick('Paris (75)');
  assert.deepEqual(await page.submit(), { error: '', sent: 'Paris' });
  assert.deepEqual(await page.submit('offer-123'), { error: '', sent: 'Paris' });
  assert.equal(page.apiCalls[0].method, 'PUT');
  assert.equal(page.apiCalls[0].url, '/offres/offer-123');
  // K : Remote.
  page.type('remote');
  await page.flush();
  assert.equal(page.net.calls.length, 2); // pas d'appel API pour Remote
  page.pick('Remote / Télétravail');
  assert.deepEqual(await page.submit(), { error: '', sent: 'Remote / Télétravail' });
  // L : France entière (proposée sur champ vide).
  page.type('');
  page.pick('France entière');
  assert.deepEqual(await page.submit(), { error: '', sent: 'France entière' });
  // Échap pendant une recherche sur #of-lieu : pas de réouverture, sélection toujours exigée.
  page.type('Lyon');
  await page.flush();
  page.input.dispatch('keydown', { key: 'Escape' });
  page.net.calls[2].resolve([{ nom: 'Lyon', codeDepartement: '69' }]);
  await tick();
  assert.equal(page.list.classList.contains('on'), false);
  assert.equal((await page.submit()).error, 'Sélectionnez une localisation dans la liste proposée');
});

// Fluidité de l'espace recruteur : appels évités ou parallélisés, mesurés avec
// scripts/measure-recruiter-journeys.js. Les fonctions sont extraites de la vraie
// page et exécutées en VM ; la route deck passe par le vrai handler Express.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createDeckHarness } = require('./helpers/deckHarness');

const html = fs.readFileSync(path.join(__dirname, '../../frontend/_spaces/recruteur.html'), 'utf8');
const stats = fs.readFileSync(path.join(__dirname, '../routes/recruteurs.js'), 'utf8');

function extract(source, signature, end = '}') {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `introuvable : ${signature}`);
  if (end !== '}') return source.slice(start, source.indexOf(end, start) + end.length);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(signature);
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve; let reject;
  const promise = new Promise((ok, ko) => { resolve = ok; reject = ko; });
  return { promise, resolve, reject };
}

test('api : les GET identiques simultanés partagent une requête, sans cache après réponse', async () => {
  const calls = [];
  const sandbox = {
    API: 'http://api', TOKEN: 't', Map, JSON,
    fetch: (url, opts) => { const d = deferred(); calls.push({ url, opts, d }); return d.promise; },
    refreshAccessToken: async () => null, toast() {}, go() {},
  };
  vm.runInNewContext([
    extract(html, 'const API_GET_IN_FLIGHT = new Map();', ';'),
    extract(html, 'function api(method, path, body, allowRefresh = true, fetchOpts = null)'),
    extract(html, 'async function apiRequest(method, path, body, allowRefresh = true, fetchOpts = null)'),
    'this.api = api;',
  ].join('\n'), sandbox);
  const answer = (call, data) => call.d.resolve({ status: 200, ok: true, json: async () => data });

  const first = sandbox.api('GET', '/offres/mine');
  const second = sandbox.api('GET', '/offres/mine');
  await flush();
  assert.equal(calls.length, 1, 'une seule requête pour deux lectures simultanées');
  answer(calls[0], [{ id: 'o1' }]);
  assert.deepEqual(await first, [{ id: 'o1' }]);
  assert.equal(await second, await first);

  const later = sandbox.api('GET', '/offres/mine');
  await flush();
  assert.equal(calls.length, 2, 'aucune réponse conservée : une lecture ultérieure repart au serveur');
  answer(calls[1], []);
  await later;

  // Abortable reads and writes always keep their own request.
  const signal = {};
  sandbox.api('GET', '/offres/mine', null, true, { signal });
  sandbox.api('GET', '/offres/mine', null, true, { signal });
  sandbox.api('POST', '/offres', { titre: 'A' });
  sandbox.api('POST', '/offres', { titre: 'A' });
  await flush();
  assert.equal(calls.length, 6);
  assert.equal(calls[2].opts.signal, signal);
});

test('badge Messages : au plus une lecture des fils par 30 s en navigation, forcée en temps réel', async () => {
  const reads = [];
  const sandbox = { USER: { id: 'u' }, Date, badge: null,
    api: async (method, url) => { reads.push(url); if (sandbox.fail) throw new Error('réseau'); return [{ ur: true }, { ur: false }]; },
    setMessageBadges: (n) => { sandbox.badge = n; } };
  vm.runInNewContext([
    extract(html, 'const MESSAGE_BADGE_MAX_AGE', ';'),
    'let MESSAGE_BADGE_AT = 0;',
    extract(html, 'async function refreshMessageBadge(force = false)'),
    'this.refresh = refreshMessageBadge; this.age = (ms) => { MESSAGE_BADGE_AT -= ms; };',
  ].join('\n'), sandbox);

  await sandbox.refresh();
  await sandbox.refresh();
  await sandbox.refresh();
  assert.deepEqual(reads, ['/messages/threads'], 'trois changements de page rapprochés : une seule lecture');
  assert.equal(sandbox.badge, 1);
  await sandbox.refresh(true);
  assert.equal(reads.length, 2, 'un nouveau message temps réel force la lecture');
  sandbox.age(30001);
  await sandbox.refresh();
  assert.equal(reads.length, 3, 'après 30 s la navigation relit les fils');
  sandbox.fail = true; sandbox.age(30001);
  await sandbox.refresh();
  sandbox.fail = false;
  await sandbox.refresh();
  assert.equal(reads.length, 5, 'un échec ne bloque pas la lecture suivante');
  assert.match(html, /if \(ui && p !== 'messages'\) refreshMessageBadge\(\);/);
  assert.match(html, /refreshMessageBadge\(true\);/);
  assert.match(html, /THREADS = await api\('GET', '\/messages\/threads'\);\s*MESSAGE_BADGE_AT = Date\.now\(\);/);
});

function offersSandbox() {
  const list = { innerHTML: '' };
  const sandbox = { JSON, Array, Map, renders: [], toasts: [], pending: [],
    document: { getElementById: () => list },
    renderOffers: (offers) => { sandbox.renders.push(offers); list.innerHTML = 'cards'; },
    toast: (text) => sandbox.toasts.push(text),
    api: () => { const d = deferred(); sandbox.pending.push(d); return d.promise; } };
  vm.runInNewContext([
    'const API_GET_IN_FLIGHT = new Map();',
    html.slice(html.indexOf('let OFFERS_SNAPSHOT = null;'), html.indexOf('async function loadOffers()')),
    extract(html, 'async function loadOffers()'),
    'this.h = { loadOffers, rememberOffers, forgetOffers };',
  ].join('\n'), sandbox);
  return { sandbox, list };
}

test('Offres : liste déjà chargée affichée immédiatement, toujours revalidée, redessinée seulement si elle change', async () => {
  const { sandbox, list } = offersSandbox();
  const first = sandbox.h.loadOffers();
  assert.match(list.innerHTML, /spinner/, 'premier affichage sans donnée : chargement');
  sandbox.pending[0].resolve([{ id: 'o1', statut: 'active' }]);
  await first;
  assert.equal(sandbox.renders.length, 1);

  const again = sandbox.h.loadOffers();
  assert.equal(sandbox.renders.length, 2, 'retour sur Offres : liste affichée sans attendre le serveur');
  assert.equal(sandbox.pending.length, 2, 'et relue quand même');
  sandbox.pending[1].resolve([{ id: 'o1', statut: 'active' }]);
  await again;
  assert.equal(sandbox.renders.length, 2, 'réponse identique : pas de second rendu');

  const changed = sandbox.h.loadOffers();
  sandbox.pending[2].resolve([{ id: 'o1', statut: 'closed' }]);
  await changed;
  assert.deepEqual(sandbox.renders.at(-1), [{ id: 'o1', statut: 'closed' }], 'réponse différente : liste redessinée');

  const failing = sandbox.h.loadOffers();
  sandbox.pending[3].reject(new Error('réseau'));
  await failing;
  assert.equal(list.innerHTML, 'cards', 'échec de revalidation : la liste reste visible');
  assert.equal(sandbox.toasts.length, 1);

  sandbox.h.forgetOffers();
  const afterWrite = sandbox.h.loadOffers();
  assert.match(list.innerHTML, /spinner/, 'après une écriture : jamais d’ancienne liste');
  sandbox.pending[4].resolve([]);
  await afterWrite;
});

test('Offres : une réponse dépassée ne remplace pas la plus récente ; écritures et autres pages alimentent la liste', async () => {
  const { sandbox } = offersSandbox();
  const slow = sandbox.h.loadOffers();
  const fast = sandbox.h.loadOffers();
  sandbox.pending[1].resolve([{ id: 'new' }]);
  await fast;
  sandbox.pending[0].resolve([{ id: 'old' }]);
  await slow;
  assert.deepEqual(sandbox.renders.at(-1), [{ id: 'new' }]);

  for (const write of [/api\('DELETE', '\/offres\/' \+ encodeURIComponent\(id\)\);\s*forgetOffers\(\);/,
    /api\('PATCH', '\/offres\/' \+ encodeURIComponent\(id\) \+ '\/status', \{ statut \}\);\s*forgetOffers\(\);/,
    /else await api\('POST', '\/offres', payload\);\s*forgetOffers\(\);/]) assert.match(html, write);
  assert.match(html, /renderDashRecentOffers\(offers \|\| \[\]\);\s*rememberOffers\(offers, offersEpoch\);/);
  assert.match(html, /if \(!offersError\) \{\s*rememberOffers\(offers, offersEpoch\);/);
});

test('Pipeline : compteurs, cartes et offres demandés ensemble, chacun avec sa propre erreur', async () => {
  const requested = [];
  const pending = {};
  const element = () => ({ innerHTML: '' });
  const els = { 'pipe-cols': element(), 'pipeline-offers-list': element() };
  const sandbox = { requested, AbortController, Object, JSON,
    PIPE_WRITER: { idle: async () => {} }, PIPE_VIEW_PENDING: null,
    document: { getElementById: (id) => els[id] || element() },
    pipelineStateHtml: (title) => title, emptyPipelineState: () => ({}), syncPipelineLoadMore() {},
    renderPipelineOffers: (offers) => { sandbox.offers = offers; }, mergePipelinePage: (page) => { sandbox.page = page; },
    renderPipeline() { sandbox.rendered = true; }, rememberOffers() {},
    api: (method, url) => { requested.push(url); pending[url] = deferred(); return pending[url].promise; },
    fetchPipelinePage: () => { requested.push('pipeline'); pending.pipeline = deferred(); return pending.pipeline.promise; } };
  vm.runInNewContext([
    'let PIPELINE_LOAD_GEN = 0, PIPELINE_ABORT = null, PIPELINE = null, PIPELINE_CARDS = {}, PIPELINE_COUNTS = null, PIPELINE_CURSOR = null, PIPELINE_HAS_MORE = false, PIPELINE_LOADING = false, PIPE_RECONCILE = false, OFFERS_EPOCH = 0;',
    extract(html, 'async function loadPipeline()'),
    'this.load = loadPipeline; this.counts = () => PIPELINE_COUNTS;',
  ].join('\n'), sandbox);

  const loading = sandbox.load();
  await flush();
  assert.deepEqual(requested.sort(), ['/offres/mine', '/recruteurs/stats', 'pipeline'],
    'les trois requêtes partent avant toute réponse (auparavant : l’une après l’autre)');
  // Offers answer first, stats fail: cards and offers are still rendered.
  pending['/offres/mine'].resolve([{ id: 'o1' }]);
  pending.pipeline.resolve({ nouveau: [] });
  pending['/recruteurs/stats'].reject(new Error('stats indisponibles'));
  await loading;
  assert.deepEqual(sandbox.offers, [{ id: 'o1' }]);
  assert.deepEqual(sandbox.page, { nouveau: [] });
  assert.equal(sandbox.rendered, true);
  assert.equal(sandbox.counts(), null);
});

test('démarrage : contrôle d’abonnement et plan courant en parallèle, stats réutilisées une fois', () => {
  const boot = html.slice(html.indexOf('if (TOKEN && USER) {\n  // The plan check'), html.indexOf("window.addEventListener('popstate'"));
  assert.match(boot, /Promise\.all\(\[\s*api\('GET', '\/recruteurs\/stats\?t=' \+ Date\.now\(\)\)/);
  assert.match(boot, /loadCurrentPlan\(\),\s*\]\)/);
  assert.match(boot, /\.finally\(\(\) => \{\s*go\(startParam \|\| getLastPage\(\)\);\s*initNotifications\(\);/);

  const sandbox = { Date };
  vm.runInNewContext(`let BOOT_STATS = null;\n${extract(html, 'function takeBootStats()')}\nthis.take = takeBootStats; this.set = (v) => { BOOT_STATS = v; };`, sandbox);
  sandbox.set({ stats: { recues: 3 }, at: Date.now() });
  assert.deepEqual(sandbox.take(), { recues: 3 });
  assert.equal(sandbox.take(), null, 'consommées une seule fois');
  sandbox.set({ stats: { recues: 3 }, at: Date.now() - 11000 });
  assert.equal(sandbox.take(), null, 'trop anciennes : relues');
  assert.match(html, /takeBootStats\(\) \|\| api\('GET', '\/recruteurs\/stats'\)/);
});

test('/recruteurs/stats : URL du logo demandée en parallèle des compteurs', () => {
  const route = stats.slice(stats.indexOf("router.get('/stats'"), stats.indexOf("router.get('/questions'"));
  assert.match(route, /await Promise\.all\(\[\s*pipelineSummary\(supabase, recruteur\.id\),\s*withFreshRecruiterAvatarUrl\(recruteur\),\s*\]\)/);
});

test('/candidats/deck : rôle et fiche recruteur lus une seule fois, exclusions inchangées', async () => {
  const { db, queryLog, get } = createDeckHarness();
  const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  db.recruteurs[0].matching = { meta: { swiped_candidate_ids: [uuid(1)] } };
  db.offres = [{ id: 'o1', recruteur_id: 'rec-1' }];
  db.matchs = [{ offre_id: 'o1', candidat_id: uuid(2) }];
  db.candidats = [1, 2, 3, 4].map((n) => ({ id: uuid(n), user_id: `person-${n}`, axes: { closing: 70, meta: {} }, score_adn: 80 - n }));
  db.candidats.push({ id: uuid(5), user_id: 'person-2', axes: { closing: 70, meta: {} }, score_adn: 60 }); // même personne que le match

  const response = await get('/candidats/deck?limit=20', 'user-rec');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.candidates.map((c) => c.id), [uuid(3), uuid(4)], 'déjà vus, matchés et même personne exclus');
  assert.deepEqual(queryLog.filter(([op, column, value]) => op === 'eq' && column === 'id' && value === 'user-rec'), [],
    'plus de relecture du rôle dans users');
});

// Review f11ed48 (P2) : lecture après écriture sur Offres. Faux serveur dont chaque GET
// lit l'état au moment où il part et répond quand le test le décide ; vraies fonctions
// api/apiRequest, cache Offres, loadOffers, setOfferStatus, deleteOffer, loadDashboard.
function offersRaceSandbox() {
  const server = { offers: [{ id: 'o1', statut: 'active' }] };
  const gets = [];
  const list = { innerHTML: '' };
  const json = (data) => ({ status: 200, ok: true, json: async () => data });
  const sandbox = { API: '', TOKEN: 't', Map, JSON, Array, Date, USER: { id: 'u', prenom: 'Camille', entreprise: 'Équipe' },
    confirm: () => true, toast() {}, go() {}, refreshAccessToken: async () => null, loadPipeline() {},
    document: { getElementById: (id) => (id === 'offers-list' ? list : { textContent: '', innerHTML: '', style: {}, classList: { contains: () => false } }) },
    renderOffers: (offers) => { list.innerHTML = `offres:${JSON.stringify(offers)}`; },
    PIPE_WRITER: { idle: async () => {} }, PIPE_VIEW_PENDING: null, isGreetingPrenom: () => true, takeBootStats: () => null,
    renderDashLogo() {}, renderDashStats() {}, renderRecues() {}, renderDashRecentOffers() {}, syncBnavPlan() {},
    fetch: (url, opts) => {
      if (opts.method === 'PATCH') { server.offers = server.offers.map((o) => ({ ...o, statut: JSON.parse(opts.body).statut })); return Promise.resolve(json({})); }
      if (opts.method === 'DELETE') { server.offers = []; return Promise.resolve(json({})); }
      if (opts.method === 'PUT') { server.offers = server.offers.map((o) => ({ ...o, ...JSON.parse(opts.body) })); return Promise.resolve(json({})); }
      if (url !== '/offres/mine') return Promise.resolve(json(url.includes('stats') ? { plan_label: '' } : []));
      const read = JSON.parse(JSON.stringify(server.offers)); // état lu au départ de la requête
      const d = deferred();
      gets.push({ respond: () => d.resolve(json(read)), fail: () => d.reject(new Error('réseau')), read });
      return d.promise;
    } };
  vm.runInNewContext([
    extract(html, 'const API_GET_IN_FLIGHT = new Map();', ';'),
    extract(html, 'function api(method, path, body, allowRefresh = true, fetchOpts = null)'),
    extract(html, 'async function apiRequest(method, path, body, allowRefresh = true, fetchOpts = null)'),
    html.slice(html.indexOf('let OFFERS_SNAPSHOT = null;'), html.indexOf('async function loadOffers()')),
    extract(html, 'async function loadOffers()'),
    extract(html, 'async function deleteOffer(id)'),
    extract(html, 'async function setOfferStatus(id, statut)'),
    'let DASHBOARD_GEN = 0;',
    extract(html, 'async function loadDashboard()'),
    'this.h = { api, loadOffers, deleteOffer, setOfferStatus, forgetOffers, loadDashboard, snapshot: () => OFFERS_SNAPSHOT && OFFERS_SNAPSHOT.offers };',
  ].join('\n'), sandbox);
  return { sandbox, server, gets, list };
}
const settleAll = async () => { for (let i = 0; i < 5; i += 1) await flush(); };
const MUTATIONS = {
  // Même séquence que postOffre : écriture PUT réussie, puis forgetOffers, puis relecture.
  modification: async (h) => { await h.api('PUT', '/offres/o1', { titre: 'Nouveau titre' }); h.forgetOffers(); h.loadOffers(); },
  'clôture': (h) => h.setOfferStatus('o1', 'closed'),
  suppression: (h) => h.deleteOffer('o1'),
};
const ORDERS = {
  'ancienne avant nouvelle': ([old, fresh]) => { old.respond(); fresh.respond(); },
  'ancienne APRÈS nouvelle': ([old, fresh]) => { fresh.respond(); old.respond(); },
  'ancienne en erreur': ([old, fresh]) => { old.fail(); fresh.respond(); },
  'nouvelle en erreur': ([old, fresh]) => { fresh.fail(); old.respond(); },
};

for (const [mutationName, mutate] of Object.entries(MUTATIONS)) {
  for (const [orderName, play] of Object.entries(ORDERS)) {
    test(`Offres : ${mutationName} pendant la revalidation, ${orderName} → jamais l’état d’avant l’écriture`, async () => {
      const { sandbox, server, gets, list } = offersRaceSandbox();
      const first = sandbox.h.loadOffers(); gets[0].respond(); await first; // liste déjà vue
      const before = list.innerHTML;

      sandbox.h.loadOffers(); // retour sur Offres : liste en cache + revalidation (ANCIEN GET)
      await flush();
      assert.equal(gets.length, 2);
      await mutate(sandbox.h);
      await settleAll();
      assert.equal(gets.length, 3, 'une nouvelle lecture serveur part après l’écriture');
      assert.notDeepEqual(gets[2].read, gets[1].read, 'le nouveau GET lit l’état écrit');
      play([gets[1], gets[2]]);
      await settleAll();

      const after = `offres:${JSON.stringify(server.offers)}`;
      assert.notEqual(list.innerHTML, before, 'l’ancien état n’est jamais réaffiché');
      if (orderName === 'nouvelle en erreur') {
        assert.match(list.innerHTML, /Impossible de charger vos offres/, 'erreur visible, pas l’ancienne liste');
        assert.equal(sandbox.h.snapshot(), null, 'aucune liste antérieure gardée en cache');
      } else {
        assert.equal(list.innerHTML, after, 'UI = état écrit');
        assert.deepEqual(JSON.parse(JSON.stringify(sandbox.h.snapshot())), server.offers);
      }
      // Visite suivante : affichage immédiat jamais antérieur à l'écriture, puis relecture.
      sandbox.h.loadOffers();
      await flush();
      assert.ok(list.innerHTML === after || /spinner/.test(list.innerHTML), list.innerHTML);
    });
  }
}

test('Offres : un GET Activité parti avant l’écriture ne remet pas l’ancienne liste en cache', async () => {
  const { sandbox, server, gets, list } = offersRaceSandbox();
  const first = sandbox.h.loadOffers(); gets[0].respond(); await first;
  const dashboard = sandbox.h.loadDashboard(); // Activité : GET parti avant l'écriture
  await settleAll();
  sandbox.h.loadOffers(); // retour Offres : rejoint ce GET (lecture normale dédupliquée)
  await flush();
  assert.equal(gets.length, 2, 'lecture normale : déduplication conservée');
  await sandbox.h.setOfferStatus('o1', 'closed');
  await settleAll();
  assert.equal(gets.length, 3);
  gets[2].respond(); await settleAll();
  gets[1].respond(); await dashboard; await settleAll(); // réponse Activité tardive, d'avant l'écriture
  assert.equal(list.innerHTML, `offres:${JSON.stringify(server.offers)}`);
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.h.snapshot())), server.offers, 'le cache reste l’état écrit');
  sandbox.h.loadOffers();
  assert.equal(list.innerHTML, `offres:${JSON.stringify(server.offers)}`, 'visite suivante : aucun état obsolète affiché');
});

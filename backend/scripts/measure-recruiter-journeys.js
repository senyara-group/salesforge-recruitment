#!/usr/bin/env node
// Mesure locale des parcours recruteur, de bout en bout : vrai frontend (Chrome/Edge
// headless via le harnais de mise en page du dépôt) + vraies routes Express, avec un
// faux Supabase en mémoire qui ajoute une latence FIXE à chaque aller-retour
// (auth.getUser, requête PostgREST, URL signée). Aucun appel réseau externe.
//
// Ce que la mesure dit : nombre et ordre des appels HTTP par parcours, allers-retours
// Supabase par endpoint (total et profondeur séquentielle), volume JSON, temps jusqu'au
// contenu utile sous la latence simulée. Ce qu'elle ne dit pas : les temps de prod
// (vraie base, vrai réseau, vraie volumétrie) — ils restent à mesurer en production.
//
// Usage : node scripts/measure-recruiter-journeys.js [--rtt 40] [--root <frontend>] [--json]
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { AsyncLocalStorage } = require('node:async_hooks');

const args = process.argv.slice(2);
const argValue = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const RTT = Number(argValue('--rtt', 40));
const FRONTEND = path.resolve(argValue('--root', path.join(__dirname, '../../frontend')));
const PORT = 3000; // le frontend appelle http://localhost:3000/api en local

// ---------------------------------------------------------------- faux Supabase
const USER_ID = 'u-rec';
const iso = (minutes) => new Date(Date.UTC(2026, 9, 1, 9, 0) + minutes * 60000).toISOString();
const offres = Array.from({ length: 12 }, (_, i) => ({
  id: `o${i}`, recruteur_id: 'r1', titre: `Business Developer SaaS ${i + 1}`, statut: i < 9 ? 'active' : 'closed', type: 'CDI', contract_type: 'CDI',
  lieu: 'Lyon', salaire: '45-55k€', description: 'Développement d’un portefeuille de comptes B2B. '.repeat(12), tags: ['Prospection', 'Closing'],
  job_type: 'business_developer', sector: 'saas', created_at: iso(-i * 600), recruteurs: { user_id: USER_ID, entreprise: 'Équipe' },
}));
const candidat = (i) => ({ id: `c${i}`, user_id: `uc${i}`, prenom: 'Camille', nom: 'Exemple', titre: 'Account Executive', localisation: 'Lyon',
  score_global: 80, competences: { vente: ['Prospection', 'Closing'] }, pitch_text: 'Commercial terrain orienté résultats. '.repeat(4), anonymise: true });
const candidatures = Array.from({ length: 40 }, (_, i) => ({ id: `a${i}`, offre_id: `o${i % 12}`, candidat_id: `c${i}`, statut: ['envoyee', 'vu', 'contacte', 'entretien', 'offre'][i % 5],
  created_at: iso(-i * 90), score: 82, candidats: candidat(i), offres: offres[i % 12] }));
const matchs = Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, offre_id: `o${i % 12}`, candidat_id: `c${i}`, created_at: iso(-i * 120),
  candidats: candidat(i), offres: { titre: offres[i % 12].titre, recruteurs: { user_id: USER_ID, entreprise: 'Équipe' } } }));
const messages = Array.from({ length: 400 }, (_, i) => ({ id: `msg${i}`, match_id: `m${i % 20}`, sender_id: i % 2 ? USER_ID : `uc${i % 20}`, receiver_id: i % 2 ? `uc${i % 20}` : USER_ID,
  contenu: 'Bonjour, merci pour votre retour, êtes-vous disponible jeudi pour un échange ? '.repeat(2), lu: i % 7 !== 0, created_at: iso(-i * 15) }));
const TABLES = {
  users: [{ id: USER_ID, role: 'recruteur', email: 'recruteur@example.invalid', prenom: 'Camille' }],
  abonnements: [{ user_id: USER_ID, plan: 'pro', statut: 'actif', created_at: iso(-10000) }],
  recruteurs: [{ id: 'r1', user_id: USER_ID, entreprise: 'Équipe', plan: 'pro', avatar_meta: { avatar_path: 'r1/logo.png' } }],
  offres, candidatures, matchs, messages, candidats: Array.from({ length: 30 }, (_, i) => candidat(i)), swipes: [], swipes_recruteur: [],
};
const requestContext = new AsyncLocalStorage();
const delay = () => new Promise((resolve) => setTimeout(resolve, RTT));
// Un aller-retour : compté pour la requête HTTP en cours ; la profondeur séquentielle est
// le nombre maximal d'allers-retours enchaînés (chacun démarre après la fin du précédent).
async function roundTrip(kind, table, result) {
  const ctx = requestContext.getStore();
  const started = Date.now();
  await delay();
  if (ctx) {
    ctx.trips.push({ kind, table, start: started - ctx.t0, end: Date.now() - ctx.t0 });
  }
  return result;
}
function query(table) {
  // Pagination réaliste : limit/range, exclusion « not in », et fin de liste dès qu'un
  // curseur keyset (lt / or) est appliqué au deck (petite base : une seule page).
  const state = { table, head: false, count: false, single: false, write: null, limit: Infinity, offset: 0, exclude: [], include: [], cursor: false };
  const resolve = () => {
    let rows = (TABLES[table] || []).filter((row) => !state.exclude.some(([column, values]) => values.includes(String(row[column])))
      && state.include.every(([column, values]) => !(column in row) || values.includes(String(row[column]))));
    if (state.cursor && table === 'candidats') rows = [];
    rows = rows.slice(state.offset, state.offset + state.limit);
    if (state.write) return { data: state.single ? state.write : [state.write], error: null };
    if (state.head) return { data: null, count: rows.length, error: null };
    if (state.single) return { data: rows[0] || null, error: null };
    return { data: rows, count: state.count ? rows.length : null, error: null };
  };
  const proxy = new Proxy({}, {
    get(_target, prop) {
      if (prop === 'then') return (ok, ko) => roundTrip('db', table, resolve()).then(ok, ko);
      if (prop === 'select') return (_cols, opts = {}) => { state.head = Boolean(opts.head); state.count = Boolean(opts.count); return proxy; };
      if (prop === 'single' || prop === 'maybeSingle') return () => { state.single = true; return proxy; };
      if (prop === 'in') return (column, values) => { state.include.push([column, (values || []).map(String)]); return proxy; };
      if (prop === 'limit') return (n) => { state.limit = n; return proxy; };
      if (prop === 'range') return (from, to) => { state.offset = from; state.limit = to - from + 1; return proxy; };
      if (prop === 'not') return (column, op, list) => { if (op === 'in') state.exclude.push([column, String(list).slice(1, -1).split(',')]); return proxy; };
      if (prop === 'lt' || prop === 'or') return () => { state.cursor = true; return proxy; };
      if (prop === 'insert' || prop === 'upsert' || prop === 'update') return (values) => { state.write = Array.isArray(values) ? values[0] : values; return proxy; };
      return () => proxy; // eq, in, or, order, range, limit, gte, not, filter, delete…
    },
  });
  return proxy;
}
const fakeClient = {
  from: query,
  rpc: (name) => query(`rpc:${name}`),
  storage: { from: () => ({ createSignedUrl: () => roundTrip('storage', 'signedUrl', { data: { signedUrl: 'https://example.invalid/logo.png' }, error: null }) }) },
  auth: { getUser: () => roundTrip('auth', 'getUser', { data: { user: { id: USER_ID, email: 'recruteur@example.invalid' } }, error: null }) },
  channel: () => ({ on() { return this; }, subscribe() { return this; }, unsubscribe() {} }),
};
Object.assign(process.env, { SUPABASE_URL: 'https://example.invalid', SUPABASE_SERVICE_KEY: 'local', SUPABASE_ANON_KEY: 'local' });
const supabaseJs = require.resolve('@supabase/supabase-js');
require.cache[supabaseJs] = { id: supabaseJs, filename: supabaseJs, loaded: true, exports: { createClient: () => fakeClient } };

// ---------------------------------------------------------------- serveur local
function startServer() {
  const express = require('express');
  const app = express();
  app.disable('etag');
  app.use(require('../middleware/jsonBodyParser'));
  const serverLog = [];
  app.use('/api', (req, res, next) => {
    const ctx = { path: req.originalUrl.replace(/\?.*$/, ''), t0: Date.now(), trips: [] };
    res.on('finish', () => {
      // Profondeur : allers-retours qui ne chevauchent aucun aller-retour précédent.
      let depth = 0; let lastEnd = -1;
      for (const trip of [...ctx.trips].sort((a, b) => a.start - b.start)) if (trip.start >= lastEnd) { depth += 1; lastEnd = trip.end; } else lastEnd = Math.max(lastEnd, trip.end);
      serverLog.push({ path: ctx.path, trips: ctx.trips.length, depth, ms: Date.now() - ctx.t0, byKind: ctx.trips.reduce((acc, t) => { acc[t.kind] = (acc[t.kind] || 0) + 1; return acc; }, {}) });
    });
    requestContext.run(ctx, next);
  });
  app.use((req, res, next) => { res.set('Access-Control-Allow-Origin', '*'); res.set('Access-Control-Allow-Headers', '*'); res.set('Access-Control-Allow-Methods', '*'); if (req.method === 'OPTIONS') return res.sendStatus(204); next(); });
  app.use(express.static(FRONTEND));
  app.get('/api/config', (_req, res) => res.json({}));
  for (const [mount, file] of [['recruteurs', 'recruteurs'], ['offres', 'offres'], ['candidats', 'candidats'], ['candidatures', 'candidatures'], ['messages', 'messages'], ['abonnements', 'abonnements'], ['matchs', 'matchs']]) {
    app.use(`/api/${mount}`, require(`../routes/${file}`));
  }
  app.use(require('../middleware/apiErrorHandler'));
  return new Promise((resolve) => { const server = app.listen(PORT, '127.0.0.1', () => resolve({ server, serverLog })); });
}

// ---------------------------------------------------------------- parcours navigateur
const JOURNEYS = [
  // [nom, action, contenu utile]
  ['Ouverture espace (Activité)', null, `document.getElementById('kpi-recues').textContent.trim() !== '—' && !document.querySelector('#dash-recent-offers .spinner')`],
  ['Sourcing', `go('swipe')`, `Boolean(document.querySelector('#deck-cards .swipe-card') || !document.getElementById('deck-empty').hidden)`],
  ['Offres', `go('offres')`, `Boolean(document.querySelector('#offers-list .offer-card'))`],
  ['Pipeline', `go('pipeline')`, `Boolean(document.querySelector('#pipe-cols [data-card-id], #pipe-cols .pipe-card, #pipe-cols .pk-card')) && Boolean(document.querySelector('#pipeline-offers-list .po-card'))`],
  ['Messages', `go('messages')`, `Boolean(document.querySelector('#msgs-list .msg-th'))`],
  ['Offres (retour)', `go('offres')`, `Boolean(document.querySelector('#offers-list .offer-card'))`],
  ['Activité (retour)', `go('dashboard')`, `document.getElementById('kpi-recues').textContent.trim() !== '—' && !document.querySelector('#dash-recent-offers .spinner')`],
];

async function main() {
  const { findBrowser, launchBrowser, openPage } = require('./check-mobile-layout');
  const executable = findBrowser();
  if (!executable) throw new Error('Aucun Chrome/Edge disponible');
  const { server, serverLog } = await startServer();
  const browser = await launchBrowser(executable);
  const results = [];
  try {
    const page = await openPage(browser, 1440, 900);
    await page.send('Network.enable');
    await page.send('Network.setBlockedURLs', { urls: ['https://*'] }); // CDN externes (Sentry, polices, supabase-js)
    // Requêtes /api vues par le navigateur (taille transférée comprise).
    const pollNetwork = async () => page.evaluate(`performance.getEntriesByType('resource').filter(e => e.name.includes('/api/')).map(e => ({ name: e.name.replace(/^.*\\/api/, ''), start: Math.round(e.startTime), end: Math.round(e.responseEnd), size: e.transferSize || e.encodedBodySize || 0, body: e.decodedBodySize || 0 }))`);
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `
      localStorage.clear();
      localStorage.setItem('sf_rec_token','local-test');
      localStorage.setItem('sf_rec_user',JSON.stringify({id:'${USER_ID}',role:'recruteur',prenom:'Camille',entreprise:'Équipe'}));
      performance.setResourceTimingBufferSize(2000);
    ` });
    for (const [name, action, ready] of JOURNEYS) {
      const before = (await (action ? pollNetwork() : Promise.resolve([]))).length;
      const serverBefore = serverLog.length;
      let elapsed; let t0 = 0;
      if (!action) {
        await page.send('Page.navigate', { url: `http://localhost:${PORT}/_spaces/recruteur.html` });
        for (let i = 0; i < 400; i += 1) { await new Promise((r) => setTimeout(r, 10)); try { if (await page.evaluate(ready)) break; } catch (_) { /* chargement */ } }
        // Temps navigateur depuis le début de navigation jusqu'au contenu utile.
        elapsed = await page.evaluate('Math.round(performance.now())');
      } else {
        ({ elapsed, t0 } = await page.evaluate(`new Promise(resolve => { const t0 = performance.now(); ${action};
          const tick = () => { if (${ready}) return resolve({ elapsed: Math.round(performance.now() - t0), t0 }); if (performance.now() - t0 > 8000) return resolve({ elapsed: -1, t0 }); requestAnimationFrame(tick); }; tick(); })`));
      }
      await new Promise((r) => setTimeout(r, Math.max(400, RTT * 12))); // laisse finir les appels secondaires
      const all = await pollNetwork();
      const calls = all.slice(before);
      const server = serverLog.slice(serverBefore);
      // Fin du dernier appel HTTP du parcours (contenu définitivement à jour).
      const done = calls.length ? Math.round(Math.max(...calls.map((c) => c.end)) - t0) : 0;
      results.push({ name, ms: elapsed, done, calls: calls.map((c) => c.name.replace(/[?&]t=\d+/, '').replace(/\?$/, '')), kb: Math.round(calls.reduce((s, c) => s + c.body, 0) / 102.4) / 10,
        server: server.map((s) => ({ path: s.path, trips: s.trips, depth: s.depth })) });
    }
    await page.close();
  } finally { browser.close(); server.close(); }

  if (args.includes('--json')) { console.log(JSON.stringify({ rtt: RTT, results }, null, 2)); return; }
  console.log(`Latence simulée par aller-retour Supabase : ${RTT} ms\n`);
  for (const r of results) {
    const trips = r.server.reduce((s, x) => s + x.trips, 0);
    console.log(`${r.name.padEnd(28)} contenu utile ${String(r.ms).padStart(5)} ms | dernier appel ${String(r.done).padStart(5)} ms | ${String(r.calls.length).padStart(2)} appels HTTP | ${String(trips).padStart(3)} allers-retours Supabase | ${r.kb} Ko JSON`);
    for (const s of r.server) console.log(`    ${s.path.padEnd(34)} ${String(s.trips).padStart(3)} A/R, profondeur ${s.depth}`);
  }
}
main().catch((error) => { console.error(error); process.exit(1); });

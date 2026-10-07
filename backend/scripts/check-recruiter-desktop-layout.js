// Desktop layout of the recruiter Sourcing (side navigation, >= 1024px): what a PC
// user actually sees, at common resolutions and browser zoom / Windows scaling levels.
// Local fixtures only; reuses the repository's real Chrome/Edge layout harness.
// Geometric assertions: nothing under the fixed side navigation, deck aligned with its
// header, no large empty band, long profiles readable, compact empty state.
// Usage: node scripts/check-recruiter-desktop-layout.js [--root <frontend>]
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { findBrowser, serveFrontend, launchBrowser, openPage, MEASURE_HELPERS } = require('./check-mobile-layout');

const SIZES = [[1280, 720], [1280, 900], [1366, 768], [1440, 900], [1536, 864], [1920, 1080]];
// Browser zoom and Windows display scaling both shrink the CSS viewport.
const ZOOMS = [0.9, 1, 1.1, 1.25];

const base = {
  id: 'c1', user_id: 'u1', m: 87, name: 'Candidat anonyme', role: 'Business Developer SaaS', anon: true, rank: 'Senior',
  location: 'Lyon', initiales: 'BD', skills: ['Prospection', 'Négociation', 'Closing', 'CRM'],
  pitch_text: 'Commercial terrain avec 6 ans d’expérience en SaaS B2B, orienté résultats et relation client long terme.',
  axes: [['Closing', 78], ['Résilience', 64], ['Sales tech', 55], ['Drive', 81], ['Écoute', 70]].map(([l, v]) => ({ l, v })),
  adn_score: 74, pitch_score: 68, predict: [{ l: 'Disponibilité', v: '1 mois' }, { l: 'Salaire visé', v: '45k€' }],
};
const long = 'Responsable grands comptes internationaux, développement de partenariats stratégiques et pilotage d’équipes commerciales multi-pays. ';
const rich = { ...base, role: 'Key Account Manager Europe du Sud et Afrique francophone', pitch_text: long.repeat(4), letter_text: long.repeat(3),
  cv_url: 'https://example.invalid/cv.pdf', skills: ['Prospection', 'Négociation', 'Closing', 'CRM', 'Salesforce', 'HubSpot', 'Account management', 'Social selling', 'Cold calling', 'Grands comptes'],
  predict: [{ l: 'Disponibilité', v: 'Immédiate' }, { l: 'Salaire visé', v: '65k€ + variable' }, { l: 'Mobilité', v: 'France entière' }] };
const deck = (candidate, n) => Array.from({ length: n }, (_, i) => ({ ...candidate, id: 'c' + i, user_id: 'u' + i }));
const STATES = {
  cards: { candidates: deck(base, 5) },
  last: { candidates: deck(base, 1) },
  long: { candidates: deck(rich, 3) },
  empty: { candidates: [] },
  filteredResults: { candidates: deck(base, 2), filters: true },
  filteredEmpty: { candidates: [], filters: true },
};

const BOXES = `window.__box = s => { const el = typeof s === 'string' ? document.querySelector(s) : s; if (!el) return null; const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, w: r.width, h: r.height }; }; true`;
// The element really drawn at the centre of `selector` (null if covered by something else).
const HIT = `window.__hit = s => { const el = document.querySelector(s); if (!el) return false; const r = el.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return Boolean(top && (top === el || el.contains(top))); }; true`;

async function openSourcing(browser, server, width, height, zoom) {
  const w = Math.round(width / zoom); const h = Math.round(height / zoom);
  const page = await openPage(browser, w, h);
  await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: zoom, mobile: false });
  await page.send('Network.enable');
  await page.send('Network.setBlockedURLs', { urls: ['https://*'] });
  // Fresh storage per page: a like remembers the profile as seen and hides it afterwards.
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    localStorage.clear();
    localStorage.setItem('sf_rec_token','local-test');
    localStorage.setItem('sf_rec_user',JSON.stringify({id:'me',role:'recruteur',prenom:'Camille',entreprise:'Équipe'}));
    window.fetch = async url => new Response(JSON.stringify(String(url).includes('/abonnements/current') ? {plan:'pro',statut:'actif'} : []), {status:200,headers:{'content-type':'application/json'}});
  ` });
  await page.navigate(`http://127.0.0.1:${server.address().port}/_spaces/recruteur.html`, 'typeof go === "function" && typeof loadCandidates === "function"');
  await page.evaluate(MEASURE_HELPERS); await page.evaluate(BOXES); await page.evaluate(HIT);
  await page.evaluate(`
    USER = { id:'me', prenom:'Camille', entreprise:'Équipe' }; TOKEN = 'local-test'; HAS_PLAN = true; window.__swipes = [];
    api = async (method, url, payload) => {
      if (url.startsWith('/candidats/deck')) { window.__deckUrl = url; return { candidates: window.__deck, next_cursor: null, has_more: false }; }
      if (url.startsWith('/recruteurs/swipe')) { window.__swipes.push(payload); return {}; }
      if (url.startsWith('/recruteurs/stats')) return { recues:0, stages:{}, plan_label:'Plan Pro' };
      return [];
    };
    document.getElementById('bnav').style.display = ''; true;
  `);
  return { page, w, h };
}

async function showState(page, state) {
  await page.evaluate(`window.__deck = ${JSON.stringify(state.candidates)}; go('swipe'); new Promise(r => setTimeout(r, 200))`);
  if (state.filters) {
    await page.evaluate(`APPLIED_CAND_FILTERS = { ...APPLIED_CAND_FILTERS, ville: 'Lyon' };
      loadCandidates({ preserveFilters: true }).then(() => new Promise(r => setTimeout(r, 150)))`);
  }
}

const measure = `(() => {
  const body = document.querySelector('#deck-cards .swipe-card .cand-body');
  const card = document.querySelector('#deck-cards .swipe-card');
  let longEnd = null;
  if (body) { body.scrollTop = body.scrollHeight; const last = [...body.children].pop(); longEnd = { last: last.getBoundingClientRect().bottom, card: card.getBoundingClientRect().bottom }; body.scrollTop = 0; }
  const empty = document.getElementById('deck-empty');
  return { vw: innerWidth, vh: innerHeight, docW: document.documentElement.scrollWidth,
    outside: __layout.outside(document.getElementById('p-swipe')), nav: __box('#bnav'), hd: __box('#p-swipe .swipe-hd'),
    wrap: __box('#p-swipe .deck-wrap'), card: card && __box(card), actions: document.getElementById('deck-actions').hidden ? null : __box('#deck-actions'),
    empty: empty.hidden ? null : __box(empty), emptyTitle: empty.hidden ? null : __box('#deck-empty .deck-empty-title'),
    filtersVisible: __hit('#p-swipe .comp-filter-btn'), titleVisible: __hit('#p-swipe .page-title'),
    cardVisible: card ? __hit('#deck-cards .swipe-card .cand-body-title') : null, emptyActionVisible: empty.hidden ? null : __hit('#deck-empty .btn'),
    longEnd };
})()`;

async function main() {
  const executable = findBrowser();
  if (!executable) throw new Error('Aucun Chrome/Edge disponible');
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'swipsales-recruiter-desktop-'));
  const server = await serveFrontend();
  const browser = await launchBrowser(executable);
  const report = { artifacts, viewports: {} };
  const failures = [];
  const check = (label, fn) => { try { fn(); } catch (error) { failures.push(`${label}: ${error.message.split('\n')[0]}`); } };
  try {
    for (const [width, height] of SIZES) for (const zoom of ZOOMS) {
      const key = `${width}x${height}@${Math.round(zoom * 100)}%`;
      const { page, w, h } = await openSourcing(browser, server, width, height, zoom);
      const entry = report.viewports[key] = { css: `${w}x${h}` };
      try {
        for (const [name, state] of Object.entries(STATES)) {
          await showState(page, state);
          const m = await page.evaluate(measure);
          if (zoom === 1) { const { data } = await page.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(artifacts, `${key}-${name}.png`), Buffer.from(data, 'base64')); }
          const below = Math.round(m.vh - (m.wrap.bottom));
          entry[name] = { hd: [Math.round(m.hd.left), Math.round(m.hd.w)], wrap: [Math.round(m.wrap.left), Math.round(m.wrap.top), Math.round(m.wrap.w), Math.round(m.wrap.h)], below };
          const label = `${key} ${name}`;
          check(label + ' overflow', () => { assert.deepEqual(m.outside, []); assert.ok(m.docW <= m.vw, `scrollWidth ${m.docW}`); });
          // Side navigation: nothing of the Sourcing may sit underneath it.
          check(label + ' clear of side navigation', () => {
            assert.ok(m.hd.left >= m.nav.right - 1, `en-tête à ${Math.round(m.hd.left)}px, navigation jusqu’à ${Math.round(m.nav.right)}px`);
            assert.ok(m.wrap.left >= m.nav.right - 1, `deck à ${Math.round(m.wrap.left)}px, navigation jusqu’à ${Math.round(m.nav.right)}px`);
          });
          check(label + ' title and filters clickable', () => { assert.ok(m.titleVisible, 'titre masqué'); assert.ok(m.filtersVisible, 'bouton Filtres masqué'); });
          check(label + ' deck aligned with header', () => assert.ok(Math.abs(m.hd.left - m.wrap.left) <= 1 && Math.abs(m.hd.w - m.wrap.w) <= 1, `en-tête ${Math.round(m.hd.left)}/${Math.round(m.hd.w)} deck ${Math.round(m.wrap.left)}/${Math.round(m.wrap.w)}`));
          // Centred in the column right of the navigation (not in the whole window).
          check(label + ' centred in content column', () => assert.ok(Math.abs((m.hd.left - m.nav.right) - (m.vw - m.hd.right)) <= 2, `marges ${Math.round(m.hd.left - m.nav.right)} / ${Math.round(m.vw - m.hd.right)}`));
          check(label + ' deck right under header', () => assert.ok(m.wrap.top - m.hd.bottom <= 16, `écart ${Math.round(m.wrap.top - m.hd.bottom)}px`));
          if (m.empty) {
            check(label + ' compact empty state', () => {
              assert.ok(m.empty.h <= 340, `zone vide ${Math.round(m.empty.h)}px`);
              assert.ok(m.wrap.h <= m.empty.h + 2, `deck ${Math.round(m.wrap.h)}px pour un état vide de ${Math.round(m.empty.h)}px`);
              assert.ok(m.emptyTitle.top - m.wrap.top <= 120, `titre à ${Math.round(m.emptyTitle.top - m.wrap.top)}px du haut de la carte`);
              assert.ok(m.emptyActionVisible, 'action « Ajuster les filtres » masquée');
              assert.equal(m.actions, null);
            });
          } else {
            check(label + ' card shown', () => { assert.ok(m.card && m.cardVisible, 'carte absente ou masquée'); assert.ok(m.actions, 'actions absentes'); });
            // The deck (card + actions) is on the first screen whenever the window can hold
            // a usable card; and the window is used: no band of more than 30% of it under the deck.
            if (m.vh >= 640) check(label + ' deck within first screen', () => assert.ok(m.actions.bottom <= m.vh, `actions jusqu’à ${Math.round(m.actions.bottom)}px / ${m.vh}px`));
            check(label + ' no large empty band', () => assert.ok(below <= m.vh * 0.3, `${below}px libres sous le deck (${m.vh}px)`));
            check(label + ' end of profile readable', () => assert.ok(m.longEnd.last <= m.longEnd.card + 1, `fin du profil ${Math.round(m.longEnd.last - m.longEnd.card)}px sous la carte`));
          }
        }
        // Liking the last profile leads to the compact empty state.
        await showState(page, STATES.last);
        await page.evaluate(`document.querySelector('#deck-actions .db-like').click(); new Promise(r => setTimeout(r, 800))`);
        const after = await page.evaluate(`({ swipes: window.__swipes.length, empty: !document.getElementById('deck-empty').hidden, h: __box('#deck-empty').h })`);
        check(`${key} last like → empty state`, () => { assert.ok(after.swipes >= 1); assert.ok(after.empty, 'état vide absent'); assert.ok(after.h <= 340, `${Math.round(after.h)}px`); });
      } finally { await page.close(); }
    }
  } finally { browser.close(); server.close(); }
  fs.writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 1));
  if (failures.length) { console.error(`\n${failures.length} échec(s) :\n- ` + failures.join('\n- ')); process.exit(1); }
  console.log(`\nDesktop : Sourcing recruteur dégagé de la navigation, aligné, sans bande vide, état vide compact. Captures : ${artifacts}`);
}
main().catch(error => { console.error(error); process.exit(2); });

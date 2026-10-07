// Pipeline Kanban V2 (recruiter): what a recruiter sees on the board, measured in a
// real Chrome/Edge on desktop, tablet and phone, with local fixtures only.
// Geometry, not only overflow: lanes of a readable width, headers and counts visible,
// compact cards inside their lane, board scroll contained, next stage visible at the
// edge, drag targets marked, phone "Déplacer vers…" reachable above the navigation.
// Usage: node scripts/check-recruiter-kanban-v2-layout.js [--root <frontend>]
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { findBrowser, serveFrontend, launchBrowser, openPage, MEASURE_HELPERS } = require('./check-mobile-layout');
const { applicationMoves } = require('../utils/pipelineSummary');
const { stageForStatut } = require('../utils/pipelineQuery');

const DESKTOP = [[1280, 720], [1280, 900], [1366, 768], [1440, 900], [1536, 864], [1920, 1080]];
const SMALL = [[768, 1024], [390, 844], [430, 932]];
const STAGES = ['nouveau', 'vu', 'contacte', 'entretien', 'offre', 'termine'];
const names = ['Camille Exemple', 'Hugo Martin', 'Léa Bernard', 'Nina Robert', 'Yanis Petit', 'Sarah Durand'];
const card = (i, statut, extra = {}) => ({ id: String(i), name: names[i % 6], role: 'Account Executive', av: 'CE', bg: '#1340E0',
  tags: ['Prospection', 'Closing', 'CRM'], offre_title: 'Responsable commercial grands comptes', statut, score: 70 + i % 25, score_adn: 75,
  created_at: new Date(Date.UTC(2026, 9, 4) - i * 3600e3).toISOString(), moves: applicationMoves(statut), ...extra });
const statuses = ['envoyee', 'vu', 'contacte', 'entretien', 'offre'];
const DATA = {
  multi: [...Array.from({ length: 18 }, (_, i) => card(i + 1, statuses[i % 5])), card(30, 'embauche'), card(31, 'refusee')],
  crowded: [...Array.from({ length: 14 }, (_, i) => card(i + 1, 'envoyee')), card(20, 'vu')],
  long: [card(1, 'envoyee', { name: 'Marie-Charlotte de La Rochefoucauld-Montbazon', role: 'Responsable développement commercial grands comptes Europe du Sud et Afrique francophone',
    tags: ['Prospection téléphonique', 'Négociation complexe', 'Salesforce', 'Account management'], offre_title: 'Directeur commercial régional Auvergne-Rhône-Alpes et Bourgogne-Franche-Comté' }), card(2, 'vu')],
  empty: [],
};
const MOVES = Object.fromEntries(['envoyee', 'nouveau', 'vu', 'contacte', 'repondu', 'entretien', 'offre', 'embauche', 'refusee', 'retiree'].map(s => [s, applicationMoves(s)]));
const pageOf = (cards) => { const p = Object.fromEntries(STAGES.map(k => [k, []])); cards.forEach(c => p[stageForStatut(c.statut)].push(c)); return p; };

const MEASURE = `(() => {
  const box = e => { const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, w: b.width, h: b.height }; };
  const board = document.getElementById('pipe-cols');
  const cols = [...board.querySelectorAll('.pipe-col')].map(col => ({ stage: col.dataset.stage, box: box(col),
    hd: box(col.querySelector('.pipe-col-hd')), title: col.querySelector('.pipe-col-t').textContent.trim(),
    count: col.querySelector('.pipe-count').textContent.trim(), countBox: box(col.querySelector('.pipe-count')),
    accent: getComputedStyle(col.querySelector('.pipe-col-hd')).boxShadow, empty: Boolean(col.querySelector('.pipe-col-empty')),
    cards: [...col.querySelectorAll('.pipe-card')].map(c => ({ box: box(c), move: box(c.querySelector('.pipe-move')),
      chips: [...c.querySelectorAll('.pc-chip, .pc-tag')].map(x => ({ box: box(x), clipped: x.scrollWidth > x.clientWidth + 1 })),
      meta: box(c.querySelector('.pc-meta')) })) }));
  return { vw: document.documentElement.clientWidth, docW: document.documentElement.scrollWidth, boardBox: box(board),
    scrollW: board.scrollWidth, clientW: board.clientWidth, outside: __layout.outside(document.getElementById('p-pipeline')),
    nav: box(document.getElementById('bnav')), cols };
})()`;

async function main() {
  const executable = findBrowser();
  if (!executable) throw new Error('Aucun Chrome/Edge disponible');
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'swipsales-kanban-v2-'));
  const server = await serveFrontend();
  const browser = await launchBrowser(executable);
  const failures = [];
  const report = {};
  // A missing hook must fail the run, never hang it.
  const timeout = setTimeout(() => { console.error('Délai de validation dépassé'); process.exit(2); }, 420000);
  const check = (label, fn) => { try { fn(); } catch (error) { failures.push(`${label}: ${error.message.split('\n')[0]}`); } };
  try {
    for (const [width, height] of [...DESKTOP, ...SMALL]) {
      const key = `${width}x${height}`; const desktop = width >= 1024; const phone = width < 720;
      const page = await openPage(browser, width, height);
      try {
        await page.send('Network.enable');
        await page.send('Network.setBlockedURLs', { urls: ['https://*'] });
        await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.clear();localStorage.setItem('sf_rec_token','t');
          localStorage.setItem('sf_rec_user',JSON.stringify({id:'me',role:'recruteur',prenom:'Camille',entreprise:'Équipe'}));
          window.fetch = async url => new Response(JSON.stringify(String(url).includes('/abonnements/current') ? {plan:'pro',statut:'actif'} : []), {status:200,headers:{'content-type':'application/json'}});` });
        await page.navigate(`http://127.0.0.1:${server.address().port}/_spaces/recruteur.html`, 'typeof go === "function" && typeof RecruiterKanban !== "undefined"');
        await page.evaluate(MEASURE_HELPERS);
        await page.evaluate(`USER={id:'me',prenom:'Camille',entreprise:'Équipe'};TOKEN='t';HAS_PLAN=true;window.__moves=${JSON.stringify(MOVES)};
          api = async (method, url, payload) => {
            if (url.includes('/status')) { const id = url.split('/')[2]; const f = RecruiterKanban.find(window.testPipeline, id); const t = f.card.moves.find(m => m.statut === payload.statut);
              window.testPipeline = RecruiterKanban.put(window.testPipeline, t.stage, {...f.card, statut: payload.statut, moves: window.__moves[payload.statut]}); return { statut: payload.statut, moves: window.__moves[payload.statut] }; }
            if (url.startsWith('/recruteurs/stats')) return window.testStats;
            if (url.startsWith('/recruteurs/pipeline')) return window.testPipeline;
            if (url.startsWith('/offres/mine')) return [{ id:'offer', titre:'Account Executive', statut:'active', lieu:'Lyon', type:'CDI' }];
            return [];
          };
          document.getElementById('bnav').style.display=''; true`);
        const shot = async (name) => { const { data } = await page.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(artifacts, `${key}-${name}.png`), Buffer.from(data, 'base64')); };
        for (const [scenario, cards] of Object.entries(DATA)) {
          const p = pageOf(JSON.parse(JSON.stringify(cards)));
          const stats = { stages: Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v.length])), plan_label: 'Plan Pro' };
          await page.evaluate(`window.testPipeline=${JSON.stringify(p)};window.testStats=${JSON.stringify(stats)};go('pipeline');loadPipeline().then(()=>new Promise(r=>setTimeout(r,100)))`);
          await page.evaluate(`document.querySelector('.pipe-kanban-hd').scrollIntoView({block:'start'}); window.scrollBy(0,-70); true`);
          await shot(scenario);
          const label = `${key} ${scenario}`;
          if (scenario === 'empty') {
            const e = await page.evaluate(`({ text: document.getElementById('pipe-cols').textContent, steps: document.querySelectorAll('#pipe-cols .pipe-flow li').length,
              cols: document.querySelectorAll('#pipe-cols .pipe-col').length, h: document.querySelector('#pipe-cols > .pipe-state').getBoundingClientRect().height, vh: innerHeight })`);
            check(label + ' empty pipeline explained', () => { assert.match(e.text, /Aucune candidature reçue/); assert.equal(e.steps, 6, 'les 6 étapes'); assert.equal(e.cols, 0, 'pas de colonnes désertes'); });
            check(label + ' empty pipeline compact', () => assert.ok(e.h <= Math.max(340, e.vh * 0.5), `${Math.round(e.h)}px`));
            continue;
          }
          const m = await page.evaluate(MEASURE);
          (report[key] ||= {})[scenario] = { cols: m.cols.map(c => `${c.stage}:${Math.round(c.box.w)}x${Math.round(c.box.h)}`), cardH: m.cols.flatMap(c => c.cards).slice(0, 3).map(c => Math.round(c.box.h)) };
          check(label + ' page width', () => { assert.deepEqual(m.outside, []); assert.ok(m.docW <= m.vw, `scrollWidth ${m.docW}`); });
          check(label + ' six stages', () => assert.deepEqual(m.cols.map(c => c.stage), STAGES));
          for (const col of m.cols) {
            const cl = `${label} ${col.stage}`;
            check(cl + ' header and count visible', () => {
              assert.ok(col.hd.h >= 32 && col.title.length > 0, 'en-tête'); assert.match(col.count, /^\d+$/);
              assert.ok(col.countBox.w > 0 && col.countBox.r <= col.box.r + 0.5 && col.countBox.l >= col.box.l - 0.5, 'compteur dans la colonne');
              assert.match(col.accent, /inset/, 'accent couleur de l’étape');
            });
            check(cl + ' lane width', () => assert.ok(col.box.w >= (phone ? 260 : 240) && col.box.w <= 340, `${Math.round(col.box.w)}px`));
            for (const c of col.cards) {
              check(cl + ' card inside lane', () => assert.ok(c.box.l >= col.box.l - 0.5 && c.box.r <= col.box.r + 0.5 && c.box.t >= col.hd.b - 0.5 && c.box.b <= col.box.b + 0.5));
              check(cl + ' compact card', () => assert.ok(c.box.h <= (desktop ? 145 : 160), `${Math.round(c.box.h)}px`));
              check(cl + ' chips whole', () => { assert.ok(c.chips.every(x => !x.clipped || x.box.t >= c.meta.b - 0.5), 'puce tronquée visible'); });
              check(cl + ' move control', () => assert.ok(c.move.h >= (desktop ? 26 : 44), `menu ${Math.round(c.move.h)}px`));
            }
          }
          for (let i = 1; i < m.cols.length; i += 1) check(`${label} lanes do not overlap`, () => assert.ok(m.cols[i].box.l >= m.cols[i - 1].box.r - 0.5));
          check(label + ' board scroll contained', () => assert.ok(m.boardBox.l >= 0 && m.boardBox.r <= m.vw + 0.5));
          if (m.scrollW > m.clientW + 1) {
            // The next stage is visibly cut at the edge: other stages exist.
            check(label + ' next stage hinted', () => { const cut = m.cols.find(c => c.box.r > m.boardBox.r); assert.ok(cut && cut.box.l < m.boardBox.r - 24, 'aucune colonne partiellement visible'); });
          }
          if (desktop && scenario === 'multi') {
            const firstLane = m.cols[0].box;
            check(label + ' first lane proportion', () => assert.ok(firstLane.w <= m.vw * 0.3, `${Math.round(firstLane.w)}px / ${m.vw}`));
            check(label + ' several cards per lane above the fold', () => { const lane = m.cols[0]; assert.ok(lane.cards.filter(c => c.box.b <= height).length >= 3, 'moins de 3 cartes visibles'); });
          }
          if (desktop && scenario === 'multi') {
            const drag = await page.evaluate(`(() => { const c = document.querySelector('[data-card-id="1"]'); const dt = new DataTransfer();
              c.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
              const ok = document.querySelector('[data-stage="vu"]'); ok.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
              const bad = document.querySelector('[data-stage="offre"]'); const ev = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }); bad.dispatchEvent(ev);
              return new Promise(r => setTimeout(() => r({ ok: ok.className, bad: bad.className, badAccepted: ev.defaultPrevented, source: document.querySelector('[data-stage="nouveau"]').className,
                ghost: c.classList.contains('is-ghost'), placeholder: ok.querySelector('.pipe-col-body') ? getComputedStyle(ok.querySelector('.pipe-col-body'), '::before').content : '', badOpacity: +getComputedStyle(bad).opacity }), 250)); })()`);
            await shot('drag');
            check(label + ' drag feedback', () => {
              assert.match(drag.ok, /is-target/); assert.match(drag.ok, /can-drop/); assert.match(drag.bad, /no-drop/); assert.equal(drag.badAccepted, false);
              assert.match(drag.source, /is-source/); assert.equal(drag.ghost, true); assert.match(drag.placeholder, /Déposer ici/); assert.ok(drag.badOpacity < 0.8, 'cible interdite non estompée');
            });
            const after = await page.evaluate(`(() => { document.querySelector('[data-stage="vu"]').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
              return PIPE_WRITER.idle().then(() => ({ moved: PIPELINE.vu.some(c => c.id === '1'), left: document.querySelectorAll('#p-pipeline .is-ghost,#p-pipeline .can-drop,#p-pipeline .no-drop,#p-pipeline .is-source').length })); })()`);
            check(label + ' drop then clean board', () => { assert.equal(after.moved, true); assert.equal(after.left, 0); });
          }
          if (phone && scenario === 'multi') {
            const reach = await page.evaluate(`(() => { const s = document.querySelector('[data-move-id="2"]'); s.scrollIntoView({ block: 'end' }); window.scrollBy(0, 120);
              const b = s.getBoundingClientRect(); const nav = document.getElementById('bnav').getBoundingClientRect(); s.focus();
              return { bottom: b.bottom, top: b.top, navTop: nav.top, focused: document.activeElement === s, options: s.options.length }; })()`);
            await shot('menu');
            check(label + ' phone move menu reachable', () => { assert.ok(reach.focused); assert.ok(reach.options > 1); assert.ok(reach.bottom <= reach.navTop, `menu ${Math.round(reach.bottom)} / nav ${Math.round(reach.navTop)}`); });
          }
        }
      } finally { await page.close(); }
    }
  } finally { clearTimeout(timeout); browser.close(); server.close(); }
  fs.writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 1));
  if (failures.length) { console.error(`\n${failures.length} échec(s) :\n- ` + [...new Set(failures)].slice(0, 80).join('\n- ')); process.exit(1); }
  console.log(`\nPipeline Kanban V2 : colonnes, en-têtes, cartes compactes, drag et mobile OK. Captures : ${artifacts}`);
}
main().catch(error => { console.error(error); process.exit(2); });

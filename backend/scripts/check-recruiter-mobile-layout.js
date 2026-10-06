// Recruiter phone layout: Sourcing deck density and Messages height.
// Local fixtures only; reuses the repository's real Chrome/Edge layout harness.
// Geometric assertions (not only "no overflow"): what a phone user actually sees
// between the top bar and the fixed bottom navigation.
// Usage: node scripts/check-recruiter-mobile-layout.js [--root <frontend>]
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { findBrowser, serveFrontend, launchBrowser, openPage, MEASURE_HELPERS } = require('./check-mobile-layout');

const PHONES = [[375, 812], [390, 844], [430, 932]];
const KEYBOARD = [390, 500]; // viewport reduced as with a resizing virtual keyboard
const BNAV_GAP = 12; // minimum free space above the bottom navigation

const base = {
  id: 'c1', user_id: 'u1', m: 87, name: 'Candidat anonyme', role: 'Business Developer SaaS', anon: true, rank: 'Senior',
  adn_type: 'Chasseur', location: 'Lyon', initiales: 'BD', skills: ['Prospection', 'Négociation', 'Closing', 'CRM'], competences: {},
  pitch_text: 'Commercial terrain avec 6 ans d’expérience en SaaS B2B, orienté résultats et relation client long terme.',
  axes: [['Closing', 78], ['Résilience', 64], ['Sales tech', 55], ['Drive', 81], ['Écoute', 70]].map(([l, v]) => ({ l, v })),
  adn_score: 74, pitch_score: 68, predict: [{ l: 'Disponibilité', v: '1 mois' }, { l: 'Salaire visé', v: '45k€' }],
};
const long = 'Responsable grands comptes internationaux, développement de partenariats stratégiques et pilotage d’équipes commerciales multi-pays. ';
const CANDIDATES = {
  standard: base,
  minimal: { id: 'c2', m: 61, name: 'Candidat anonyme', anon: true, initiales: 'CA', axes: [], predict: [], skills: [] },
  manyTags: { ...base, id: 'c3', skills: ['Prospection', 'Négociation', 'Closing', 'CRM', 'Salesforce', 'HubSpot', 'Account management', 'Social selling', 'Cold calling', 'Grands comptes'] },
  longText: { ...base, id: 'c4', role: 'Key Account Manager Europe du Sud et Afrique francophone', location: 'Saint-Rémy-de-Provence', pitch_text: long.repeat(4),
    letter_text: long.repeat(3), predict: [{ l: 'Disponibilité', v: 'Immédiate après préavis' }, { l: 'Salaire visé', v: '65k€ + variable' }, { l: 'Mobilité', v: 'France entière' }] },
  noAdn: { ...base, id: 'c5', axes: [], adn_score: null },
};
const message = (i, text) => ({ sender_id: i % 2 ? 'me' : 'other', contenu: text || `Message ${i + 1} — merci pour votre retour sur le poste.`, created_at: new Date(Date.UTC(2026, 9, 1, 9, i)).toISOString(), lu: true });
const THREADS = {
  empty: [], one: [message(0)], few: Array.from({ length: 4 }, (_, i) => message(i)),
  many: Array.from({ length: 40 }, (_, i) => message(i)), long: Array.from({ length: 6 }, (_, i) => message(i, long.repeat(3))),
};

const BOXES = `window.__box = s => { const el = typeof s === 'string' ? document.querySelector(s) : s; if (!el) return null; const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, h: r.height }; }; true`;

async function main() {
  const executable = findBrowser();
  if (!executable) throw new Error('Aucun Chrome/Edge disponible');
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'swipsales-recruiter-mobile-'));
  const server = await serveFrontend();
  const browser = await launchBrowser(executable);
  const report = { artifacts, viewports: {} };
  const failures = [];
  const check = (label, fn) => { try { fn(); } catch (error) { failures.push(`${label}: ${error.message.split('\n')[0]}`); } };
  try {
    for (const [width, height] of [...PHONES, KEYBOARD]) {
      const page = await openPage(browser, width, height);
      const key = `${width}x${height}`; const entry = report.viewports[key] = { sourcing: {}, messages: {} };
      const shot = async name => { const { data } = await page.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(artifacts, `${key}-${name}.png`), Buffer.from(data, 'base64')); };
      await page.send('Network.enable');
      await page.send('Network.setBlockedURLs', { urls: ['https://*'] });
      await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `
        localStorage.setItem('sf_rec_token','local-test');
        localStorage.setItem('sf_rec_user',JSON.stringify({id:'me',role:'recruteur',prenom:'Camille',entreprise:'Équipe'}));
        window.fetch = async url => new Response(JSON.stringify(String(url).includes('/abonnements/current') ? {plan:'pro',statut:'actif'} : []), {status:200,headers:{'content-type':'application/json'}});
      ` });
      await page.navigate(`http://127.0.0.1:${server.address().port}/_spaces/recruteur.html`, 'typeof go === "function"');
      await page.evaluate(MEASURE_HELPERS);
      await page.evaluate(BOXES);
      await page.evaluate(`
        USER = { id:'me', prenom:'Camille', entreprise:'Équipe' }; TOKEN = 'local-test'; HAS_PLAN = true; window.__swipes = [];
        api = async (method, url, payload) => {
          if (url.startsWith('/messages/threads')) return [{ id:'t1', match_id:'m1', receiver_id:'u1', nom:'Camille E.', av:'CE', bg:'#1340E0', time:'09:12', context:'Account Executive' }];
          if (url.startsWith('/messages/thread/')) return window.__thread;
          if (url.startsWith('/recruteurs/swipe')) { window.__swipes.push(payload); return {}; }
          if (url.startsWith('/recruteurs/stats')) return { recues:0, stages:{}, plan_label:'Plan Pro' };
          if (url.includes('deck')) return { candidates: [], next_cursor: null, has_more: false };
          return [];
        };
        document.getElementById('bnav').style.display = ''; true;
      `);

      // ---------------- Sourcing ----------------
      await page.evaluate(`go('swipe'); new Promise(r => setTimeout(r, 250))`);
      for (const [name, candidate] of Object.entries(CANDIDATES)) {
        await page.evaluate(`CANDS = [${JSON.stringify(candidate)}]; DECK_IDX = 0; CAND_DECK_HAS_MORE = false; renderDeck(); window.scrollTo(0, 0); new Promise(r => setTimeout(r, 120))`);
        const m = await page.evaluate(`(() => {
          const card = document.querySelector('#deck-cards .swipe-card');
          const clipped = [...card.querySelectorAll('.cand-body *, .cand-identity *')].filter(el => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== 'visible' && !el.closest('.cand-fact-location, .cand-doc')).map(el => el.className);
          return { vh: innerHeight, docW: document.documentElement.scrollWidth, outside: __layout.outside(document.getElementById('p-swipe')),
            hd: __box('#p-swipe .swipe-hd'), topbar: __box('.topbar'), card: __box(card), actions: __box('#deck-actions'), bnav: __box('#bnav'), clipped,
            scrollRoom: document.documentElement.scrollHeight - innerHeight };
        })()`);
        await shot(`sourcing-${name}-top`);
        // The last element must be reachable above the navigation by natural page scroll.
        await page.evaluate('window.scrollTo(0, document.documentElement.scrollHeight); true');
        const end = await page.evaluate(`({ actions: __box('#deck-actions'), bnav: __box('#bnav') })`);
        await shot(`sourcing-${name}-bottom`);
        entry.sourcing[name] = { card: Math.round(m.card.h), header: Math.round(m.hd.h), actionsBottom: Math.round(m.actions.bottom), bnavTop: Math.round(m.bnav.top), endGap: Math.round(end.bnav.top - end.actions.bottom) };
        const label = `${key} sourcing ${name}`;
        check(label + ' overflow', () => { assert.deepEqual(m.outside, []); assert.ok(m.docW <= width, `scrollWidth ${m.docW}`); });
        check(label + ' clipped text', () => assert.deepEqual(m.clipped, []));
        check(label + ' header flush with top bar', () => assert.ok(Math.abs(m.hd.top - m.topbar.bottom) <= 1, `gap ${m.hd.top - m.topbar.bottom}px`));
        check(label + ' actions reachable above navigation', () => assert.ok(end.bnav.top - end.actions.bottom >= BNAV_GAP, `gap ${Math.round(end.bnav.top - end.actions.bottom)}px`));
        if (name === 'standard' && height !== KEYBOARD[1]) {
          // A standard profile fits without scrolling: header, card and actions above the navigation.
          check(label + ' fits first screen', () => assert.ok(m.actions.bottom <= m.bnav.top - BNAV_GAP, `actions ${Math.round(m.actions.bottom)} / nav ${Math.round(m.bnav.top)}`));
          check(label + ' compact header', () => assert.ok(m.hd.h <= 90, `header ${Math.round(m.hd.h)}px`));
        }
      }
      // Deck actions still work on the compact card.
      await page.evaluate(`CANDS = [${JSON.stringify(CANDIDATES.standard)}, ${JSON.stringify({ ...CANDIDATES.minimal, id: 'c9' })}]; DECK_IDX = 0; renderDeck(); true`);
      await page.evaluate(`document.querySelector('#deck-actions .db-like').click(); new Promise(r => setTimeout(r, 700))`);
      const swiped = await page.evaluate(`({ idx: DECK_IDX, calls: window.__swipes.length })`);
      check(`${key} sourcing like button`, () => { assert.equal(swiped.idx, 1); assert.ok(swiped.calls >= 1); });

      // ---------------- Messages ----------------
      for (const [name, thread] of Object.entries(THREADS)) {
        await page.evaluate(`window.__thread = ${JSON.stringify(thread)}; closeThread(); go('messages'); new Promise(r => setTimeout(r, 150))`);
        await page.evaluate(`openThread('t1').then(() => { document.activeElement.blur(); window.scrollTo(0, 0); return new Promise(r => setTimeout(r, 120)); })`);
        if (name === 'few') await page.evaluate(`document.getElementById('chat-input').value = 'Bonjour, êtes-vous disponible jeudi ?'; true`);
        const m = await page.evaluate(`(() => {
          const body = document.getElementById('chat-body'); const bubbles = body.querySelectorAll('.bubble');
          const last = bubbles[bubbles.length - 1];
          const lastRect = last ? { top: last.getBoundingClientRect().top, bottom: last.getBoundingClientRect().bottom } : null;
          return { vh: innerHeight, doc: document.documentElement.scrollHeight, docW: document.documentElement.scrollWidth,
            outside: __layout.outside(document.getElementById('p-messages')), head: __box('.chat-head'), body: __box(body),
            compose: __box('.chat-compose'), bnav: __box('#bnav'), last: lastRect,
            scroll: { top: body.scrollTop, height: body.scrollHeight, client: body.clientHeight } };
        })()`);
        await shot(`messages-${name}`);
        entry.messages[name] = { body: Math.round(m.body.h), composeBottom: Math.round(m.compose.bottom), bnavTop: Math.round(m.bnav.top), doc: m.doc, vh: m.vh,
          lastBottom: m.last && Math.round(m.last.bottom), composeTop: Math.round(m.compose.top), scrolled: m.scroll };
        const label = `${key} messages ${name}`;
        check(label + ' overflow', () => { assert.deepEqual(m.outside, []); assert.ok(m.docW <= width); });
        check(label + ' composer above navigation', () => assert.ok(m.compose.bottom <= m.bnav.top + 1, `composer ${Math.round(m.compose.bottom)} / nav ${Math.round(m.bnav.top)}`));
        check(label + ' composer below messages', () => assert.ok(m.compose.top >= m.body.bottom - 1, `composer top ${Math.round(m.compose.top)} / messages bottom ${Math.round(m.body.bottom)}`));
        // End of the last message visible between the conversation header and the composer
        // (a single message taller than the zone is legitimately read by scrolling up).
        if (m.last) check(label + ' last message visible above composer', () => assert.ok(m.last.bottom <= m.compose.top + 1 && m.last.bottom >= m.head.bottom + 20, `last ${Math.round(m.last.top)}-${Math.round(m.last.bottom)} / composer ${Math.round(m.compose.top)}`));
        if (height !== KEYBOARD[1]) {
          // Full-height messenger: no page scroll, no empty band between composer and navigation.
          check(label + ' fills height', () => { assert.ok(m.doc <= m.vh + 1, `document ${m.doc} / viewport ${m.vh}`); assert.ok(m.bnav.top - m.compose.bottom <= 16, `empty band ${Math.round(m.bnav.top - m.compose.bottom)}px`); });
        } else {
          // Reduced viewport: the thread keeps a usable height and the composer stays reachable.
          await page.evaluate('window.scrollTo(0, document.documentElement.scrollHeight); true');
          const k = await page.evaluate(`({ compose: __box('.chat-compose'), bnav: __box('#bnav'), body: __box('#chat-body') })`);
          check(label + ' keyboard composer reachable', () => assert.ok(k.compose.bottom <= k.bnav.top + 1));
          check(label + ' keyboard messages usable', () => assert.ok(k.body.h >= 150, `messages ${Math.round(k.body.h)}px`));
          await shot(`messages-${name}-keyboard-end`);
        }
        if (name === 'many' || name === 'long') check(label + ' messages scroll internally to the end', () => {
          assert.ok(m.scroll.height > m.scroll.client, 'zone non défilable');
          assert.ok(m.scroll.height - m.scroll.client - m.scroll.top <= 2, `pas en bas (${m.scroll.top}/${m.scroll.height - m.scroll.client})`);
        });
      }
      await page.evaluate(`closeThread(); new Promise(r => setTimeout(r, 80))`);
      const list = await page.evaluate(`({ open: document.getElementById('p-messages').classList.contains('thread-open'), heading: __box('#p-messages .page-heading'), list: __box('#msgs-list') })`);
      await shot('messages-list');
      check(`${key} messages back to list`, () => { assert.equal(list.open, false); assert.ok(list.heading.h > 0 && list.list.h > 0); });
      await page.close();
    }
  } finally { browser.close(); server.close(); }
  fs.writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 1));
  if (failures.length) { console.error(`\n${failures.length} échec(s) :\n- ` + failures.join('\n- ')); process.exit(1); }
  console.log(`\nRecruteur mobile : Sourcing compact et Messages pleine hauteur OK. Captures : ${artifacts}`);
}
main().catch(error => { console.error(error); process.exit(2); });

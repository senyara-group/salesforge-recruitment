// XSS attack probe in a real Chrome/Edge: feeds hostile values through the real
// rendering functions of the recruiter and candidate spaces, the app shell and the
// sign-up page, then checks that nothing executed and that legitimate text (quotes,
// ampersands, angle brackets, accents) is shown verbatim. Local fixtures only.
// Usage: node scripts/check-xss-sinks.js [--root <frontend>]
const assert = require('node:assert/strict');
const { findBrowser, serveFrontend, launchBrowser, openPage } = require('./check-mobile-layout');

const hit = (tag) => `<img src=x onerror="__xss('${tag}')"><svg onload="__xss('${tag}-svg')"></svg>`;
const ATTR = (tag) => `x" onmouseover="__xss('${tag}-attr')" data-x="`;
const LEGIT = 'L\'Oréal & Fils <SAS> "Grands comptes"';
// Records every payload that ran; also sticks to the window for later reads.
const RECORDER = `window.__hits = []; window.__xss = (tag) => window.__hits.push(tag);`;

function storage(role) {
  return role === 'recruteur'
    ? "localStorage.setItem('sf_rec_token','t');localStorage.setItem('sf_rec_user',JSON.stringify({id:'me',role:'recruteur',prenom:'Camille',entreprise:'Équipe'}));"
    : "localStorage.setItem('sf_token','t');localStorage.setItem('sf_user',JSON.stringify({id:'me',role:'candidat',prenom:'Camille',nom:'Exemple'}));";
}

async function open(browser, server, file, role, extra = '') {
  const page = await openPage(browser, 1280, 900);
  await page.send('Network.enable');
  await page.send('Network.setBlockedURLs', { urls: ['https://*'] });
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `${RECORDER}
    localStorage.clear(); ${role ? storage(role) : ''}
    window.supabase = { createClient: (url) => { window.__sbUrl = url; return { channel() { return { on() { return this; }, subscribe() { return this; } }; } }; } };
    window.fetch = async url => new Response(JSON.stringify(String(url).includes('/abonnements/current') ? {plan:'pro',statut:'actif'} : []), {status:200,headers:{'content-type':'application/json'}});
    ${extra}` });
  await page.navigate(`http://127.0.0.1:${server.address().port}/${file}`, 'document.readyState === "complete"');
  return page;
}
const settle = (page, ms = 300) => page.evaluate(`new Promise(r => setTimeout(() => r(true), ${ms}))`);

async function main() {
  const executable = findBrowser();
  if (!executable) throw new Error('Aucun Chrome/Edge disponible');
  const server = await serveFrontend();
  const thirdParty = await serveFrontend(); // another port = another origin
  const browser = await launchBrowser(executable);
  const failures = [];
  const results = {};
  const check = (label, fn) => { try { fn(); results[label] = 'ok'; } catch (error) { results[label] = 'FAIL'; failures.push(`${label}: ${error.message.split('\n')[0]}`); } };
  const timeout = setTimeout(() => { console.error('Délai dépassé'); process.exit(2); }, 240000);
  try {
    // ---------------- Recruiter space ----------------
    let page = await open(browser, server, '_spaces/recruteur.html', 'recruteur');
    await page.evaluate('typeof openPipelineCandidate === "function"');
    const rec = await page.evaluate(`(async () => {
      HAS_PLAN = true; USER = { id:'me', entreprise:'Équipe' };
      api = async () => ({});
      const out = {};
      // 1. Pipeline overlay: candidate tags (from the candidate profile).
      const c = { id:'a1', name:'Camille', role:'AE', av:'CE', bg:'#1340E0', score:80, offre_title:'Offre', statut:'envoyee', moves:[],
        tags:[${JSON.stringify(hit('pipeline-tag'))}, ${JSON.stringify(LEGIT)}],
        axes_full:[{ l:${JSON.stringify(hit('adn-label'))}, v:${JSON.stringify(hit('adn-value'))} }, { l:${JSON.stringify(LEGIT)}, v:72 }] };
      PIPELINE_CARDS = { a1: c };
      openPipelineCandidate('a1');
      out.tags = document.getElementById('cov-tags').textContent;
      // 2. Full ADN profile: labels and values.
      toggleFullProfile(c);
      out.adn = document.getElementById('cov-full-profile').textContent;
      out.adnWidth = document.querySelector('#cov-full-profile .cadn-f')?.getAttribute('style') || '';
      // 3. Match overlay: candidate first name (free text on the candidate profile).
      showMatch({ name:${JSON.stringify(hit('match-name') + LEGIT)}, initiales:'CE', m:91 }, {});
      out.match = document.getElementById('ov-sub').textContent;
      // 4. Received applications (Activité): initials / colours / names.
      renderRecues([{ id:'r1', av:${JSON.stringify(hit('recue-av'))}, bg:${JSON.stringify(ATTR('recue-bg'))}, name:${JSON.stringify(LEGIT)}, titre:'AE', score:80, tags:[] }]);
      out.recues = document.getElementById('cands-recues').textContent;
      // 5. Candidate documents on the Sourcing card: URL in an attribute.
      const docs = document.createElement('div');
      docs.innerHTML = candDocs({ cv_url: "https://example.invalid/a'onmouseover='__xss(\\"doc-attr\\")'.pdf", cv_file_name: ${JSON.stringify(LEGIT)}, motivation_url: 'javascript:__xss("doc-js")', motivation_file_name: 'Lettre' });
      document.body.appendChild(docs);
      out.docHandlers = [...docs.querySelectorAll('*')].flatMap(el => el.getAttributeNames().filter(n => n.startsWith('on') && n !== 'onclick')).length;
      docs.querySelectorAll('button').forEach(b => { b.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });
      out.docLabel = docs.textContent;
      const opened = []; window.open = (url) => { opened.push(url); return null; };
      docs.querySelectorAll('button').forEach(b => b.click());
      out.opened = opened;
      await new Promise(r => setTimeout(r, 300));
      out.attrInjected = document.querySelectorAll('[onmouseover]').length;
      return out;
    })()`);
    await settle(page);
    const recHits = await page.evaluate('window.__hits');
    results.executedRecruiter = recHits;
    check('recruteur: aucun payload exécuté', () => assert.deepEqual(recHits, []));
    check('recruteur: aucun attribut injecté', () => assert.equal(rec.attrInjected, 0));
    check('recruteur: tags pipeline affichés comme texte', () => { assert.ok(rec.tags.includes('<img src=x onerror=')); assert.ok(rec.tags.includes(LEGIT)); });
    check('recruteur: libellés ADN affichés comme texte', () => { assert.ok(rec.adn.includes('<img src=x onerror=')); assert.ok(rec.adn.includes(LEGIT)); });
    check('recruteur: valeur ADN non numérique neutralisée', () => assert.doesNotMatch(rec.adnWidth, /onerror|<|"/));
    check('recruteur: prénom du match affiché comme texte', () => { assert.ok(rec.match.includes('<img src=x onerror=')); assert.ok(rec.match.includes(LEGIT)); });
    check('recruteur: candidatures reçues sûres', () => assert.ok(rec.recues.includes(LEGIT)));
    check('recruteur: documents candidat — URL non exécutable, libellé intact', () => {
      assert.equal(rec.docHandlers, 0); assert.ok(rec.docLabel.includes(LEGIT));
      assert.ok(rec.opened.every(url => /^https:/.test(url)), JSON.stringify(rec.opened));
    });
    await page.close();

    // ---------------- Candidate space ----------------
    page = await open(browser, server, '_spaces/candidat.html', 'candidat');
    const cand = await page.evaluate(`(async () => {
      api = async () => ({});
      const out = {};
      const row = { id:'c1', co:${JSON.stringify(hit('cand-co'))}, bg:${JSON.stringify(ATTR('cand-bg'))}, title:${JSON.stringify(hit('cand-title') + LEGIT)},
        sub:${JSON.stringify(hit('cand-sub'))}, statut:'envoyee', sl:${JSON.stringify(hit('cand-sl'))}, date:${JSON.stringify(hit('cand-date'))}, can_withdraw:false };
      // 6. Applications list and home: offer title / company (written by the recruiter).
      renderCands([row]); out.cands = document.getElementById('cands-list').textContent;
      renderHomeCands([row]); out.home = document.getElementById('home-cands').textContent;
      // 7. Match overlay: company, offer title and the recruiter's preparation questions.
      showMatch({ co:${JSON.stringify(hit('match-co'))}, titre:${JSON.stringify(hit('match-titre') + LEGIT)}, cc:'#1340E0', ci:'EQ', m:88, type:'CDI', lieuDisplay:'Lyon' },
        { questions:[${JSON.stringify(hit('prep-question'))}, ${JSON.stringify(LEGIT)}] });
      out.match = document.getElementById('ov-sub').textContent + document.getElementById('ov-prep-qs').textContent;
      // 8. Own ADN rows shown back on the profile.
      const adnHost = document.createElement('div'); adnHost.innerHTML = adn({ [${JSON.stringify(hit('own-adn'))}]: 70 }); document.body.appendChild(adnHost);
      out.adn = adnHost.textContent;
      await new Promise(r => setTimeout(r, 300));
      out.attrInjected = document.querySelectorAll('[onmouseover]').length;
      return out;
    })()`);
    await settle(page);
    const candHits = await page.evaluate('window.__hits');
    results.executedCandidate = candHits;
    check('candidat: aucun payload exécuté', () => assert.deepEqual(candHits, []));
    check('candidat: aucun attribut injecté', () => assert.equal(cand.attrInjected, 0));
    check('candidat: candidatures — offre et entreprise en texte', () => { assert.ok(cand.cands.includes('<img src=x onerror=')); assert.ok(cand.cands.includes(LEGIT)); });
    check('candidat: accueil — candidatures en texte', () => assert.ok(cand.home.includes(LEGIT)));
    check('candidat: overlay de match et questions en texte', () => { assert.ok(cand.match.includes('<img src=x onerror=')); assert.ok(cand.match.includes(LEGIT)); });
    check('candidat: ADN personnel en texte', () => assert.ok(cand.adn.includes('<img src=x onerror=')));

    // 9. Supabase config message accepted only from the embedding shell.
    const env = await page.evaluate(`(() => { window.__sbUrl = null;
      window.dispatchEvent(new MessageEvent('message', { data:{ type:'env', SUPABASE_URL:'https://evil.example', SUPABASE_ANON_KEY:'k' }, origin:'https://evil.example', source:null }));
      return window.__sbUrl; })()`);
    check('candidat: configuration Supabase refusée depuis une origine tierce', () => assert.equal(env, null));
    await page.close();
    page = await open(browser, server, '_spaces/recruteur.html', 'recruteur');
    const envRec = await page.evaluate(`(() => { window.__sbUrl = null;
      window.dispatchEvent(new MessageEvent('message', { data:{ type:'env', SUPABASE_URL:'https://evil.example', SUPABASE_ANON_KEY:'k' }, origin:'https://evil.example', source:null }));
      return window.__sbUrl; })()`);
    check('recruteur: configuration Supabase refusée depuis une origine tierce', () => assert.equal(envRec, null));
    await page.close();
    // 9b. Legitimate path kept: a same-origin parent (the shell) configures the embedded space.
    page = await open(browser, server, 'swipsales_legal.html', 'candidat');
    const envLegit = await page.evaluate(`new Promise(resolve => {
      const f = document.createElement('iframe'); f.src = '_spaces/candidat.html';
      f.onload = () => { f.contentWindow.postMessage({ type:'env', SUPABASE_URL:'https://project.supabase.co', SUPABASE_ANON_KEY:'k' }, location.origin);
        setTimeout(() => resolve(f.contentWindow.__sbUrl), 300); };
      document.body.appendChild(f); })`);
    check('candidat: configuration Supabase acceptée depuis le shell (même origine)', () => assert.equal(envLegit, 'https://project.supabase.co'));
    await page.close();

    // ---------------- App shell: stripe_redirect ----------------
    // 10a. Forged event from a foreign origin with a javascript: URL.
    page = await open(browser, server, 'swipsales_app.html', null);
    await page.evaluate(`window.dispatchEvent(new MessageEvent('message', { data:{ type:'stripe_redirect', url:'javascript:void(__xss("stripe-forged"))' }, origin:'https://evil.example', source:null })); true`);
    await settle(page, 500);
    const forged = await page.evaluate('window.__hits || []');
    check('shell: redirection Stripe forgée (origine tierce) ignorée', () => assert.deepEqual(forged, []));
    await page.close();
    // 10b. Real cross-origin frame (other port) posting to the shell.
    page = await open(browser, server, 'swipsales_app.html', null, `
      if (window.top !== window && location.port === '${thirdParty.address().port}') {
        addEventListener('load', () => parent.postMessage({ type:'stripe_redirect', url:'javascript:void(__xss("stripe-frame"))' }, '*'));
      }`);
    await page.evaluate(`(() => { const f = document.createElement('iframe'); f.src = 'http://127.0.0.1:${thirdParty.address().port}/swipsales_legal.html'; document.body.appendChild(f); return true; })()`);
    await settle(page, 1500);
    const framed = await page.evaluate('window.__hits || []');
    results.executedShellFrame = framed;
    check('shell: message d’un cadre tiers ignoré', () => assert.deepEqual(framed, []));
    // 10c. The legitimate path still works: same-origin app frame, Stripe Checkout URL.
    const legit = await page.evaluate(`(() => { const nav = []; if (typeof stripeNavigate !== 'undefined') stripeNavigate = (url) => nav.push(url);
      return typeof handleStripeRedirectMessage === 'function'
        ? [handleStripeRedirectMessage({ origin: location.origin, source: document.getElementById('app-frame').contentWindow, data:{ type:'stripe_redirect', url:'https://checkout.stripe.com/c/pay/cs_test_123' } }),
           handleStripeRedirectMessage({ origin: location.origin, source: document.getElementById('app-frame').contentWindow, data:{ type:'stripe_redirect', url:'https://evil.example/phish' } }),
           handleStripeRedirectMessage({ origin: location.origin, source: document.getElementById('app-frame').contentWindow, data:{ type:'stripe_redirect', url:'javascript:alert(1)' } })]
        : 'absent'; })()`);
    check('shell: redirection Stripe légitime acceptée, autres URL refusées', () => assert.deepEqual(legit, [true, false, false]));
    await page.close();

    // ---------------- Sign-up page message ----------------
    page = await open(browser, server, 'swipsales_start.html', null);
    const start = await page.evaluate(`(async () => { showMessage(${JSON.stringify(hit('start-msg') + LEGIT)}); await new Promise(r => setTimeout(r, 300));
      const m = document.getElementById('message') || document.querySelector('.msg'); return { text: m.textContent, hits: window.__hits };
    })()`);
    check('inscription: message serveur affiché comme texte', () => { assert.deepEqual(start.hits, []); assert.ok(start.text.includes(LEGIT)); });
    const accountExists = await page.evaluate(`(() => { showMessage('User already registered'); const m = document.getElementById('message') || document.querySelector('.msg'); return m.querySelector('a')?.getAttribute('href'); })()`);
    check('inscription: lien « Se connecter » conservé', () => assert.equal(accountExists, 'swipsales_app.html?login=1'));
    await page.close();
  } finally { clearTimeout(timeout); browser.close(); server.close(); thirdParty.close(); }
  console.log(JSON.stringify(results, null, 1));
  if (failures.length) { console.error(`\n${failures.length} échec(s) :\n- ` + failures.join('\n- ')); process.exit(1); }
  console.log('\nXSS : aucun payload exécuté, textes légitimes intacts, postMessage filtré.');
}
main().catch(error => { console.error(error); process.exit(2); });

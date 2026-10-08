// XSS hardening: the real rendering / messaging functions are extracted from the
// pages and called with hostile values. Execution itself is proven in a real browser
// by scripts/check-xss-sinks.js; here we lock the produced markup / nodes and the
// postMessage filters so `npm test` catches a regression without a browser.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (file) => fs.readFileSync(path.join(__dirname, '../../frontend', file), 'utf8').replace(/\r\n/g, '\n');
const recruteur = read('_spaces/recruteur.html');
const candidat = read('_spaces/candidat.html');
const app = read('swipsales_app.html');
const start = read('swipsales_start.html');
const PAYLOAD = '<img src=x onerror=alert(1)><svg onload=alert(2)>';
const ATTR = 'x" onmouseover="alert(3)';
const LEGIT = 'L\'Oréal & Fils <SAS> "Grands comptes"';

function extract(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `introuvable : ${signature}`);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(signature);
}
// Markup is safe when no hostile tag survives as markup and no value closes its
// attribute to add an event handler (escaped quotes are &quot;, never a raw ").
function assertInert(html) {
  assert.doesNotMatch(html, /<img|<svg|"\s*on(error|load|mouseover)=/i, html);
}
// Minimal DOM: nodes built with createElement/textContent, never parsed HTML.
function fakeDocument() {
  const byId = {};
  const node = (tag = 'div') => ({ tag, className: '', textContent: '', children: [], innerHTML: '', style: {}, classList: { add() {}, remove() {} },
    replaceChildren(...kids) { this.children = kids; this.textContent = kids.map((k) => (typeof k === 'string' ? k : k.textContent)).join(''); } });
  return { byId, createElement: (tag) => node(tag), getElementById: (id) => (byId[id] ||= node()) };
}

test('candidat : candidatures et accueil — offre/entreprise du recruteur rendues en texte', () => {
  const doc = fakeDocument();
  const sandbox = { document: doc, cChip: () => 'chip-b' };
  vm.runInNewContext(`${extract(candidat, 'function esc(')}\n${extract(candidat, 'function renderHomeCands(c)')}\n${extract(candidat, 'function renderCands(c)')}\nthis.h = { renderHomeCands, renderCands };`, sandbox);
  const row = { id: 'c1', co: PAYLOAD, bg: ATTR, title: PAYLOAD + LEGIT, sub: PAYLOAD, statut: 'envoyee', sl: PAYLOAD, date: PAYLOAD, can_withdraw: true };
  sandbox.h.renderCands([row]); sandbox.h.renderHomeCands([row]);
  for (const id of ['cands-list', 'home-cands']) {
    assertInert(doc.byId[id].innerHTML);
    assert.match(doc.byId[id].innerHTML, /L&#39;Oréal &amp; Fils &lt;SAS&gt; &quot;Grands comptes&quot;/);
  }
});

test('candidat : overlay de match — entreprise, titre et questions du recruteur en nœuds texte', () => {
  const doc = fakeDocument();
  const sandbox = { document: doc, USER: { prenom: 'C', nom: 'E' } };
  vm.runInNewContext(`${extract(candidat, 'function showMatch(o, r)')}\nthis.showMatch = showMatch;`, sandbox);
  sandbox.showMatch({ co: PAYLOAD, titre: PAYLOAD + LEGIT, cc: '#1340E0', ci: 'EQ', m: 88, type: 'CDI', lieuDisplay: 'Lyon' }, { questions: [PAYLOAD, LEGIT] });
  const sub = doc.byId['ov-sub']; const qs = doc.byId['ov-prep-qs'];
  assert.equal(sub.innerHTML, '', 'aucun HTML injecté');
  assert.equal(sub.children[1].tag, 'strong');
  assert.equal(sub.children[1].textContent, PAYLOAD);
  assert.ok(sub.textContent.endsWith(LEGIT));
  assert.equal(qs.innerHTML, '');
  assert.deepEqual(qs.children.map((q) => q.textContent), [`"${PAYLOAD}"`, `"${LEGIT}"`]);
});

test('recruteur : overlay de match — prénom du candidat en nœud texte', () => {
  const doc = fakeDocument();
  const sandbox = { document: doc, USER: { entreprise: 'Équipe' }, companyInitials: () => 'EQ' };
  vm.runInNewContext(`${extract(recruteur, 'function showMatch(cand, r)')}\nthis.showMatch = showMatch;`, sandbox);
  sandbox.showMatch({ name: PAYLOAD + LEGIT, initiales: 'CE', m: '91" onload="x' }, {});
  const sub = doc.byId['ov-sub'];
  assert.equal(sub.innerHTML, '');
  assert.equal(sub.children[1].textContent, PAYLOAD + LEGIT);
  assert.equal(sub.children[2], ' · Score 0%', 'score non numérique neutralisé');
});

test('recruteur : profil ADN complet — libellé échappé, valeur réduite à un score 0–100', () => {
  const doc = fakeDocument();
  const sandbox = { document: doc };
  vm.runInNewContext(`${extract(recruteur, 'function esc(')}\n${extract(recruteur, 'function toggleFullProfile(c)')}\nthis.toggle = toggleFullProfile;`, sandbox);
  doc.getElementById('cov-full-profile').style.display = 'none';
  sandbox.toggle({ axes_full: [{ l: PAYLOAD, v: PAYLOAD }, { l: LEGIT, v: 72.4 }, { l: 'Drive', v: 140 }] });
  const html = doc.byId['cov-full-profile'].innerHTML;
  assertInert(html);
  assert.match(html, /width:0%/); assert.match(html, /width:72%/); assert.match(html, /width:100%/);
});

test('recruteur : documents candidat — URL en donnée, https uniquement, jamais dans du JavaScript', () => {
  const sandbox = { URL, window: { open: (...args) => sandbox.opened.push(args) }, opened: [] };
  vm.runInNewContext(`${extract(recruteur, 'function esc(')}\n${extract(recruteur, 'function candDocs(c)')}\n${extract(recruteur, 'function isHttpsUrl(value)')}\n${extract(recruteur, 'function openCandidateDoc(button)')}\nthis.h = { candDocs, openCandidateDoc };`, sandbox);
  const html = sandbox.h.candDocs({ cv_url: "https://x.invalid/a'onmouseover='alert(1)'.pdf", cv_file_name: LEGIT, motivation_url: 'javascript:alert(1)', motivation_file_name: 'Lettre' });
  assert.doesNotMatch(html, /javascript:/);
  assert.doesNotMatch(html, /window\.open\(/, 'aucune URL dans un gestionnaire inline');
  assert.match(html, /data-url="https:\/\/x\.invalid\/a&#39;onmouseover=&#39;alert\(1\)&#39;\.pdf"/);
  assert.match(html, /L&#39;Oréal &amp; Fils/);
  sandbox.h.openCandidateDoc({ dataset: { url: 'javascript:alert(1)' } });
  sandbox.h.openCandidateDoc({ dataset: { url: 'https://x.invalid/cv.pdf' } });
  assert.deepEqual(sandbox.opened, [['https://x.invalid/cv.pdf', '_blank', 'noopener']]);
});

test('postMessage : config Supabase acceptée seulement du parent de même origine', () => {
  for (const page of [candidat, recruteur]) {
    const start = page.indexOf("window.addEventListener('message', (e) => {");
    const listener = page.slice(start, page.indexOf('\n});', start) + 4);
    const parent = {}; const created = [];
    const sandbox = { location: { origin: 'https://app.swipsales.fr' }, supabase: { createClient: (url) => { created.push(url); return {}; } },
      window: { parent, addEventListener: (type, fn) => { sandbox.fn = fn; } } };
    vm.runInNewContext(`let supabaseClient = null;\n${listener}`, sandbox);
    const data = { type: 'env', SUPABASE_URL: 'https://evil.example', SUPABASE_ANON_KEY: 'k' };
    sandbox.fn({ origin: 'https://evil.example', source: parent, data });
    sandbox.fn({ origin: 'https://app.swipsales.fr', source: {}, data });
    assert.deepEqual(created, [], 'origine ou fenêtre étrangère refusée');
    sandbox.fn({ origin: 'https://app.swipsales.fr', source: parent, data: { ...data, SUPABASE_URL: 'https://project.supabase.co' } });
    assert.deepEqual(created, ['https://project.supabase.co']);
  }
  for (const page of [candidat, recruteur]) assert.match(page, /postMessage\(\{ type: 'stripe_redirect', url \}, location\.origin\)/);
  assert.match(app, /SUPABASE_ANON_KEY: env\.SUPABASE_ANON_KEY\n\s*\}, window\.location\.origin\);/);
});

test('shell : redirection Stripe — cadre applicatif de même origine et Stripe Checkout uniquement', () => {
  const frame = { contentWindow: {} }; const navigated = [];
  const sandbox = { frame, URL, window: { location: { origin: 'https://app.swipsales.fr' }, addEventListener() {} } };
  const start = app.indexOf("const STRIPE_CHECKOUT_ORIGIN");
  vm.runInNewContext(`${app.slice(start, app.indexOf('window.addEventListener(\'message\', handleStripeRedirectMessage);', start))}
    stripeNavigate = (url) => navigated.push(url); this.handle = handleStripeRedirectMessage;`, Object.assign(sandbox, { navigated }));
  const ok = 'https://checkout.stripe.com/c/pay/cs_test_123';
  const msg = (url, origin = 'https://app.swipsales.fr', source = frame.contentWindow) => ({ origin, source, data: { type: 'stripe_redirect', url } });
  assert.equal(sandbox.handle(msg('javascript:alert(document.domain)', 'https://evil.example', null)), false);
  assert.equal(sandbox.handle(msg(ok, 'https://evil.example', null)), false, 'origine tierce');
  assert.equal(sandbox.handle(msg(ok, 'https://app.swipsales.fr', {})), false, 'autre fenêtre de même origine');
  for (const url of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'https://evil.example/pay', 'http://checkout.stripe.com/c/pay', 'https://checkout.stripe.com.evil.example/x']) {
    assert.equal(sandbox.handle(msg(url)), false, url);
  }
  assert.equal(sandbox.handle(msg(ok)), true);
  assert.deepEqual(navigated, [ok]);
});

test('inscription : messages serveur en texte, seul le lien « Se connecter » reste du HTML', () => {
  const message = { className: '', innerHTML: '', textContent: '' };
  const sandbox = { message };
  const helpers = start.slice(start.indexOf('function frError(text)'), start.indexOf('function showConfirmMail'));
  vm.runInNewContext(`${helpers}\nthis.show = showMessage;`, sandbox);
  sandbox.show(PAYLOAD + LEGIT);
  assert.equal(message.textContent, PAYLOAD + LEGIT);
  sandbox.show('User already registered');
  assert.match(message.innerHTML, /<a href="swipsales_app\.html\?login=1"/);
});

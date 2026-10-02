// Lot 7.3 — cohérence abonnement → affichage → plan actif → périodicité → checkout.
// Aucun appel Stripe réel : le SDK et Supabase sont remplacés par des doublures.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');

const FRONTEND = path.join(__dirname, '../../frontend');
// Le dépôt est extrait en CRLF sous Windows (core.autocrlf) : on normalise.
const readText = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const candidateHtml = readText(path.join(FRONTEND, '_spaces/candidat.html'));
const sharedCss = readText(path.join(FRONTEND, 'app-professional.css'));

// ------------------------------------------------------------------
// Harnais frontend : exécute la vraie section PRICING de candidat.html
// ------------------------------------------------------------------
const SECTION_RULE = '// ------------------------------------------------------------\n';
function pricingSource() {
  const start = candidateHtml.indexOf(`${SECTION_RULE}// PRICING`);
  const end = candidateHtml.indexOf(`${SECTION_RULE}// INIT`, start);
  assert.ok(start >= 0 && end > start, 'section PRICING introuvable');
  const escStart = candidateHtml.indexOf('function esc(');
  const escEnd = candidateHtml.indexOf('\n}\n', escStart) + 3;
  return `${candidateHtml.slice(escStart, escEnd)}\n${candidateHtml.slice(start, end)}`;
}

function pricingHarness(abonnement) {
  const elements = {
    'plans-row': { innerHTML: '' },
    'pricing-plan-note': { hidden: true, textContent: '' },
  };
  const calls = [];
  const toasts = [];
  const sandbox = {
    TOKEN: 'token', BILLING: 'month', CURRENT_PLAN: 'freemium', CURRENT_PLAN_LOADED: false, CURRENT_PLAN_PERIOD: null,
    document: {
      getElementById: (id) => elements[id] || null,
      querySelectorAll: () => [],
    },
    window: {}, location: { href: '' },
    toast: (message) => toasts.push(message),
    api: async (method, route, body) => {
      calls.push({ method, route, body });
      if (route.startsWith('/abonnements/current')) return abonnement;
      if (route === '/stripe/create-checkout') return { url: 'https://checkout.invalid/session' };
      throw new Error(`route inattendue ${route}`);
    },
  };
  sandbox.window.parent = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(pricingSource(), sandbox);
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  return {
    sandbox, elements, calls, toasts,
    async render(billing) {
      sandbox.BILLING = billing;
      sandbox.renderPlans();
      await flush(); await flush();
      return parseCards(elements['plans-row'].innerHTML);
    },
    async toggle(billing) {
      sandbox.setBill({ classList: { add() {}, remove() {} } }, billing);
      await flush();
      return elements['plans-row'].innerHTML;
    },
    async click(card) {
      vm.runInContext(card.onclick, sandbox);
      await flush(); await flush();
    },
  };
}

function textOf(fragment, className) {
  const match = fragment.match(new RegExp(`class="${className}(?: [^"]*)?"[^>]*>([^<]*)<`));
  return match ? match[1] : null;
}

function parseCards(html) {
  return html.split(/<div class="plan-card/).slice(1).map((fragment) => {
    const button = fragment.match(/<button class="pc-btn"([^>]*)>([^<]*)<\/button>/);
    const onclick = button?.[1].match(/onclick="([^"]*)"/)?.[1] || '';
    return {
      classes: fragment.slice(0, fragment.indexOf('"')).trim().split(/\s+/).filter(Boolean),
      html: fragment,
      name: textOf(fragment, 'pc-n'),
      price: textOf(fragment, 'pc-p'),
      unit: textOf(fragment, 'pc-u'),
      old: textOf(fragment, 'pc-old'),
      hint: textOf(fragment, 'pc-h'),
      badge: textOf(fragment, 'active-plan-badge'),
      features: [...fragment.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => m[1].replace(/<svg[\s\S]*?<\/svg>/, '').replace(/<[^>]+>/g, '').trim()),
      checkmarks: (fragment.match(/<svg/g) || []).length,
      buttonLabel: button?.[2] ?? null,
      disabled: /\sdisabled/.test(button?.[1] || ''),
      onclick: onclick.replace(/&#39;/g, "'").replace(/&quot;/g, '"'),
    };
  });
}

const STATES = {
  freemium: { plan: 'freemium', statut: 'actif', periode: 'month' },
  carriereMonth: { plan: 'carriere', statut: 'actif', periode: 'month' },
  carriereYear: { plan: 'carriere', statut: 'actif', periode: 'year' },
  coachingMonth: { plan: 'carriere_coaching', statut: 'actif', periode: 'month' },
  coachingYear: { plan: 'carriere_coaching', statut: 'actif', periode: 'year' },
  expired: { plan: 'carriere', statut: 'inactif', periode: 'month' },
  legacyPremium: { plan: 'premium', statut: 'actif', periode: 'month' },
  legacyPlatine: { plan: 'platine', statut: 'actif', periode: 'year' },
  unknown: { plan: 'internal_experiment_42', statut: 'actif', periode: null },
  recruiterSlug: { plan: 'solo', statut: 'actif', periode: 'month' },
  upperCase: { plan: 'CARRIERE_COACHING', statut: 'actif', periode: 'month' },
  empty: { plan: '', statut: '', periode: '' },
  missing: null,
};

function assertRenderContract(cards, label) {
  assert.equal(cards.length, 3, `${label}: trois formules attendues`);
  for (const card of cards) {
    const where = `${label} / ${card.name}`;
    assert.doesNotMatch(card.html, /undefined|null|NaN/, `${where}: valeur brute affichée`);
    assert.ok(card.name && card.name.trim(), `${where}: carte sans nom`);
    assert.ok(card.price && card.price.trim(), `${where}: carte sans prix`);
    assert.ok(card.price === 'Gratuit' || /^\d+€$/.test(card.price), `${where}: prix illisible ${card.price}`);
    assert.ok(card.features.length > 0, `${where}: aucun avantage`);
    assert.ok(card.features.every((feature) => feature.length > 0), `${where}: coche sans texte`);
    assert.equal(card.checkmarks, card.features.length, `${where}: coche orpheline`);
    if (card.old) assert.match(card.price, /^\d+€$/, `${where}: ancien prix barré sans prix actuel`);
    if (card.badge) {
      assert.match(card.badge, /^Offre active/, `${where}: badge inattendu`);
      assert.ok(card.name, `${where}: badge actif sur une carte anonyme`);
    }
    assert.ok(card.buttonLabel && card.buttonLabel.trim(), `${where}: CTA vide`);
  }
}

for (const [stateName, abonnement] of Object.entries(STATES)) {
  for (const billing of ['month', 'year']) {
    test(`contrat de rendu — ${stateName} / ${billing} (G, H, I, J, K, L, Q)`, async () => {
      const harness = pricingHarness(abonnement);
      const cards = await harness.render(billing);
      assertRenderContract(cards, `${stateName}/${billing}`);
      assert.ok(cards.filter((card) => card.badge).length <= 1, 'au plus une offre active');
    });
  }
}

test('A/B — compte gratuit : carte gratuite active, CTA identiques en Mensuel et Annuel', async () => {
  const harness = pricingHarness(STATES.freemium);
  for (const billing of ['month', 'year']) {
    const [free, carriere, coaching] = await harness.render(billing);
    assert.equal(free.badge, 'Offre active');
    assert.equal(free.buttonLabel, 'Offre active');
    assert.equal(free.disabled, true);
    assert.equal(carriere.buttonLabel, 'Passer à Carrière', `${billing}: le toggle ne change pas le CTA`);
    assert.equal(coaching.buttonLabel, 'Passer à Carrière Coaching', `${billing}: le toggle ne change pas le CTA`);
    assert.equal(carriere.disabled, false);
    assert.equal(coaching.disabled, false);
  }
});

for (const [stateName, plan, period, periodLabel] of [
  ['carriereMonth', 'Carrière', 'month', 'mensuelle'],
  ['carriereYear', 'Carrière', 'year', 'annuelle'],
  ['coachingMonth', 'Carrière Coaching', 'month', 'mensuelle'],
  ['coachingYear', 'Carrière Coaching', 'year', 'annuelle'],
]) {
  test(`C/D/E/O/P — ${plan} actif (${period}) : même carte active dans les deux onglets`, async () => {
    const harness = pricingHarness(STATES[stateName]);
    for (const billing of ['month', 'year']) {
      const cards = await harness.render(billing);
      const active = cards.filter((card) => card.badge);
      assert.equal(active.length, 1, `${billing}: une seule offre active`);
      assert.equal(active[0].name, plan, `${billing}: le niveau actif ne dépend pas du toggle`);
      assert.equal(active[0].badge, `Offre active · ${periodLabel}`, `${billing}: périodicité réelle affichée`);
      assert.equal(active[0].buttonLabel, 'Offre active');
      assert.equal(active[0].disabled, true);
      const free = cards.find((card) => card.name === 'Compte candidat');
      assert.equal(free.buttonLabel, 'Inclus dans votre formule');
      assert.equal(free.disabled, true);
      const other = cards.find((card) => !card.badge && card.name !== 'Compte candidat');
      assert.equal(other.buttonLabel, 'Changer de formule', `${billing}: pas de nouveau checkout pour un abonné`);
      assert.doesNotMatch(other.onclick, /selectPlan/);
    }
  });
}

test('F/Q — plan historique ou inconnu : aucune carte active, bandeau neutre, pas de faux « Freemium »', async () => {
  for (const stateName of ['legacyPremium', 'legacyPlatine', 'unknown', 'recruiterSlug']) {
    const harness = pricingHarness(STATES[stateName]);
    for (const billing of ['month', 'year']) {
      const cards = await harness.render(billing);
      assert.equal(cards.filter((card) => card.badge).length, 0, `${stateName}/${billing}: aucune carte active`);
      assert.equal(harness.elements['pricing-plan-note'].hidden, false, `${stateName}: bandeau attendu`);
      assert.match(harness.elements['pricing-plan-note'].textContent, /n’est plus proposée/);
      assert.doesNotMatch(harness.elements['pricing-plan-note'].textContent, new RegExp(STATES[stateName].plan));
      const free = cards.find((card) => card.name === 'Compte candidat');
      assert.equal(free.buttonLabel, 'Inclus dans votre formule');
      assert.equal(free.disabled, true);
    }
  }
  const freeHarness = pricingHarness(STATES.freemium);
  await freeHarness.render('month');
  assert.equal(freeHarness.elements['pricing-plan-note'].hidden, true, 'pas de bandeau pour un compte gratuit');
});

test('abonnement expiré, vide ou absent : traité comme compte gratuit', async () => {
  for (const stateName of ['expired', 'empty', 'missing']) {
    const cards = await pricingHarness(STATES[stateName]).render('month');
    assert.equal(cards[0].badge, 'Offre active', stateName);
    assert.equal(cards[1].buttonLabel, 'Passer à Carrière', stateName);
  }
});

test('casse différente du slug : la carte active est reconnue', async () => {
  const cards = await pricingHarness(STATES.upperCase).render('year');
  assert.equal(cards.find((card) => card.badge)?.name, 'Carrière Coaching');
});

test('M — Mensuel → Annuel → Mensuel restitue le rendu initial', async () => {
  for (const abonnement of [STATES.freemium, STATES.carriereMonth, STATES.coachingYear, STATES.legacyPremium]) {
    const harness = pricingHarness(abonnement);
    await harness.render('month');
    const initial = harness.elements['plans-row'].innerHTML;
    const annual = await harness.toggle('year');
    assert.notEqual(annual, initial);
    assert.equal(await harness.toggle('month'), initial);
  }
});

test('N — calculs annuels cohérents et alignés sur le catalogue de checkout serveur', async () => {
  const { CHECKOUT_CATALOG } = require('../utils/subscriptionCatalog');
  const monthly = await pricingHarness(STATES.freemium).render('month');
  const annual = await pricingHarness(STATES.freemium).render('year');
  for (const [index, slug] of [[1, 'carriere'], [2, 'carriere_coaching']]) {
    const month = Number(monthly[index].price.replace('€', ''));
    const year = Number(annual[index].price.replace('€', ''));
    assert.equal(monthly[index].hint, 'Sans engagement');
    assert.equal(monthly[index].old, null, 'pas de prix barré en mensuel');
    assert.equal(annual[index].old, `${month}€`, 'le prix barré annuel est la mensualité');
    const [, billed, savings] = annual[index].hint.match(/^Facturé (\d+) €\/an · Économie (\d+) €$/);
    assert.equal(Number(billed), year * 12, `${slug}: facturé = mensualité annuelle × 12`);
    assert.equal(Number(savings), month * 12 - year * 12, `${slug}: économie = écart sur 12 mois`);
    assert.equal(CHECKOUT_CATALOG.cand[slug].monthlyCents, month * 100, `${slug}: mensuel aligné serveur`);
    assert.equal(CHECKOUT_CATALOG.cand[slug].annualMonthlyCents, year * 100, `${slug}: annuel aligné serveur`);
  }
  assert.match(candidateHtml, new RegExp(`Carrière dès ${annual[1].price.replace('€', '')} €/mois en annuel`), 'accroche d’en-tête alignée');
});

test('R (UI) — un CTA de souscription n’envoie que plan + périodicité, jamais de Price ID', async () => {
  for (const billing of ['month', 'year']) {
    const harness = pricingHarness(STATES.freemium);
    const cards = await harness.render(billing);
    await harness.click(cards[2]);
    const checkout = harness.calls.find((call) => call.route === '/stripe/create-checkout');
    // Objet créé dans le contexte vm : on compare sa forme sérialisée.
    assert.deepEqual(JSON.parse(JSON.stringify(checkout.body)), { plan: 'carriere_coaching', billing, type: 'cand' });
  }
});

test('R (UI) — « Changer de formule » n’ouvre aucun checkout et explique la marche à suivre', async () => {
  const harness = pricingHarness(STATES.carriereMonth);
  const cards = await harness.render('month');
  await harness.click(cards[2]);
  assert.equal(harness.calls.some((call) => call.route === '/stripe/create-checkout'), false);
  assert.equal(harness.elements['pricing-plan-note'].hidden, false);
  assert.match(harness.elements['pricing-plan-note'].textContent, /résiliez/);
});

// ------------------------------------------------------------------
// Cascade CSS : la carte sombre doit rester lisible avec le CSS partagé
// ------------------------------------------------------------------
function cssRules(source, order) {
  const rules = [];
  const flat = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = re.exec(flat))) {
    const selectorText = match[1].replace(/@media[^{]*$/, '').trim();
    if (!selectorText || selectorText.startsWith('@')) continue;
    for (const selector of selectorText.split(',').map((part) => part.trim()).filter(Boolean)) {
      for (const decl of match[2].split(';')) {
        const index = decl.indexOf(':');
        if (index < 0) continue;
        const property = decl.slice(0, index).trim();
        const raw = decl.slice(index + 1).trim();
        rules.push({ selector, property, value: raw.replace(/\s*!important$/, ''), important: /!important$/.test(raw), order: order + rules.length });
      }
    }
  }
  return rules;
}

const candidateStyle = candidateHtml.slice(candidateHtml.indexOf('<style>') + 7, candidateHtml.indexOf('</style>'));
assert.ok(candidateHtml.indexOf('</style>') < candidateHtml.indexOf('app-professional.css'), 'le CSS partagé est chargé après le style local');
const ALL_RULES = [...cssRules(candidateStyle, 0), ...cssRules(sharedCss, 1e6)];

// Ne retient que les sélecteurs dont on sait évaluer la correspondance pour une
// carte de #p-pricing : [#p-pricing ]?.plan-card(.classe)* sans pseudo-classe.
function matchesCard(selector, classes) {
  const parts = selector.split(/\s+/);
  const last = parts.pop();
  if (!/^\.plan-card(\.[\w-]+)*$/.test(last)) return null;
  if (parts.length > 1 || (parts.length === 1 && parts[0] !== '#p-pricing')) return null;
  const needed = last.split('.').filter(Boolean);
  if (!needed.every((name) => classes.includes(name))) return null;
  return [parts.length, needed.length];
}

function compareKeys(a, b) {
  const index = a.findIndex((value, i) => value !== b[i]);
  return index < 0 ? 0 : a[index] - b[index];
}

function winning(classes, properties) {
  let best = null;
  for (const rule of ALL_RULES) {
    if (!properties.includes(rule.property)) continue;
    const specificity = matchesCard(rule.selector, classes);
    if (!specificity) continue;
    const key = [rule.important ? 1 : 0, ...specificity, rule.order];
    if (!best || compareKeys(key, best.key) > 0) best = { key, rule };
  }
  return best?.rule || null;
}

const ROOT_TOKENS = Object.fromEntries([...sharedCss.slice(0, sharedCss.indexOf('}')).matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
function resolveColor(value) {
  const token = value.match(/var\((--[\w-]+)\)/);
  const color = token ? ROOT_TOKENS[token[1]] : value;
  const hex = color.match(/#([0-9a-f]{6}|[0-9a-f]{3})\b/i)?.[1];
  assert.ok(hex, `couleur non résolue: ${value}`);
  const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}
function contrast(a, b) {
  const lum = (rgb) => rgb.map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; })
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  const [high, low] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}
function borderColor(rule) {
  return rule.property === 'border' ? rule.value.split(/\s+/).find((part) => part.startsWith('var(') || part.startsWith('#')) : rule.value;
}

for (const classes of [['plan-card', 'dk'], ['plan-card', 'dk', 'active-plan'], ['plan-card'], ['plan-card', 'pop'], ['plan-card', 'active-plan']]) {
  test(`cascade CSS — texte lisible sur .${classes.join('.')} dans #p-pricing`, () => {
    const background = winning(classes, ['background', 'background-color']);
    const color = winning(classes, ['color']);
    const textColor = color ? resolveColor(color.value) : resolveColor('var(--ink)');
    const ratio = contrast(resolveColor(background.value), textColor);
    assert.ok(ratio >= 4.5, `contraste ${ratio.toFixed(2)} (fond ${background.selector} / texte ${color?.selector || 'hérité'})`);
  });
}

test('cascade CSS — la carte active et la carte mise en avant restent identifiables', () => {
  const active = winning(['plan-card', 'active-plan'], ['border', 'border-color']);
  assert.equal(borderColor(active), 'var(--g)', `bordure active écrasée par ${active.selector}`);
  const activeDark = winning(['plan-card', 'dk', 'active-plan'], ['border', 'border-color']);
  assert.equal(borderColor(activeDark), 'var(--g)', `bordure active (carte sombre) écrasée par ${activeDark.selector}`);
  const pop = winning(['plan-card', 'pop'], ['border', 'border-color']);
  assert.equal(borderColor(pop), 'var(--b)', `bordure « populaire » écrasée par ${pop.selector}`);
});

// ------------------------------------------------------------------
// Route POST /stripe/create-checkout — Stripe et Supabase simulés
// ------------------------------------------------------------------
Object.assign(process.env, {
  SUPABASE_URL: process.env.SUPABASE_URL || 'https://example.supabase.co',
  SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY || 'test-service-key',
  STRIPE_PRICE_CANDIDAT_PREMIUM_MONTH: 'price_cand_carriere_month',
  STRIPE_PRICE_CANDIDAT_PREMIUM_YEAR: 'price_cand_carriere_year',
  STRIPE_PRICE_CANDIDAT_PLATINE_MONTH: 'price_cand_coaching_month',
  STRIPE_PRICE_CANDIDAT_PLATINE_YEAR: 'price_cand_coaching_year',
  STRIPE_PRICE_RECRUTEUR_SOLO_MONTH: 'price_rec_solo_month',
  STRIPE_PRICE_RECRUTEUR_PRO_YEAR: 'price_rec_pro_year',
});

const db = { users: [], abonnements: [] };
class Query {
  constructor(table) { this.table = table; this.filters = []; }
  select() { return this; }
  eq(column, value) { this.filters.push([column, value]); return this; }
  order() { return this; }
  limit() { return this; }
  async maybeSingle() { return this.run(true); }
  then(resolve, reject) { return Promise.resolve(this.run(false)).then(resolve, reject); }
  run(single) {
    const rows = (db[this.table] || []).filter((row) => this.filters.every(([key, value]) => row[key] === value));
    return { data: single ? rows[0] || null : rows, error: null };
  }
}
const sessions = [];
const fakeStripe = {
  checkout: { sessions: { create: async (payload) => { sessions.push(payload); return { url: 'https://checkout.invalid/session' }; } } },
};
function mockModule(request, exports) {
  const filename = require.resolve(request);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
mockModule('stripe', () => fakeStripe);
mockModule('../supabase', { from: (table) => new Query(table) });
mockModule('../middleware/auth', (req, _res, next) => { req.user = { id: req.get('x-test-user') }; next(); });
mockModule('../utils/brevoEvents', { trackBrevoEvent: async () => {} });
const realProfiles = require('../utils/profiles');
mockModule('../utils/profiles', { ...realProfiles, getUserEmail: async () => null });
const stripeRouter = require('../routes/stripe');

async function withServer(run) {
  const app = express();
  app.use(express.json());
  app.use('/api/stripe', stripeRouter);
  const server = app.listen(0);
  try {
    await run(`http://127.0.0.1:${server.address().port}/api/stripe`);
  } finally {
    server.close();
  }
}

function seed({ role, abonnement }) {
  db.users = [{ id: 'user-1', role }];
  db.abonnements = abonnement ? [{ user_id: 'user-1', ...abonnement }] : [];
  sessions.length = 0;
}

async function checkout(base, body) {
  const response = await fetch(`${base}/create-checkout`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-user': 'user-1' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test('R — le serveur choisit le Price ID candidat selon plan + périodicité', async () => {
  await withServer(async (base) => {
    for (const [plan, billing, expected] of [
      ['carriere', 'month', 'price_cand_carriere_month'],
      ['carriere', 'year', 'price_cand_carriere_year'],
      ['carriere_coaching', 'month', 'price_cand_coaching_month'],
      ['carriere_coaching', 'year', 'price_cand_coaching_year'],
    ]) {
      seed({ role: 'candidat', abonnement: STATES.freemium });
      const result = await checkout(base, { plan, billing, type: 'cand' });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(sessions.length, 1);
      assert.deepEqual(sessions[0].line_items, [{ price: expected, quantity: 1 }]);
      assert.equal(sessions[0].metadata.plan, plan);
      assert.equal(sessions[0].metadata.type, 'cand');
      assert.equal(sessions[0].metadata.period, billing);
      assert.equal(sessions[0].metadata.userId, 'user-1');
      assert.deepEqual(sessions[0].subscription_data.metadata, sessions[0].metadata);
    }
  });
});

test('R — P1 : un Price ID fourni par le client est refusé', async () => {
  await withServer(async (base) => {
    seed({ role: 'candidat', abonnement: STATES.freemium });
    const result = await checkout(base, { plan: 'carriere_coaching', billing: 'month', type: 'cand', priceId: 'price_cand_carriere_month' });
    assert.equal(result.status, 400);
    assert.equal(sessions.length, 0, 'aucune session Stripe ne doit être créée');
  });
});

test('R — P1 : un candidat ne peut pas souscrire une formule recruteur (et inversement)', async () => {
  await withServer(async (base) => {
    seed({ role: 'candidat', abonnement: STATES.freemium });
    assert.equal((await checkout(base, { plan: 'solo', billing: 'month', type: 'rec' })).status, 403);
    assert.equal((await checkout(base, { plan: 'solo', billing: 'month' })).status, 400, 'plan recruteur hors catalogue candidat');
    seed({ role: 'recruteur', abonnement: null });
    assert.equal((await checkout(base, { plan: 'carriere', billing: 'month', type: 'cand' })).status, 403);
    seed({ role: null, abonnement: null });
    assert.equal((await checkout(base, { plan: 'carriere', billing: 'month', type: 'cand' })).status, 403);
    assert.equal(sessions.length, 0);
  });
});

test('R — formule inconnue, historique ou périodicité invalide : refus sans appel Stripe', async () => {
  await withServer(async (base) => {
    for (const body of [
      { plan: 'gold', billing: 'month', type: 'cand' },
      { plan: 'premium', billing: 'year', type: 'cand' },
      { plan: 'freemium', billing: 'month', type: 'cand' },
      { plan: '', billing: 'month', type: 'cand' },
      { plan: 'carriere', billing: 'weekly', type: 'cand' },
      { plan: '__proto__', billing: 'month', type: 'cand' },
    ]) {
      seed({ role: 'candidat', abonnement: STATES.freemium });
      const result = await checkout(base, body);
      assert.equal(result.status, 400, JSON.stringify(body));
    }
    assert.equal(sessions.length, 0);
  });
});

test('R — un abonné payant actif ne peut pas ouvrir un second abonnement (double facturation)', async () => {
  await withServer(async (base) => {
    for (const abonnement of [STATES.carriereMonth, STATES.coachingYear, STATES.legacyPremium]) {
      seed({ role: 'candidat', abonnement });
      const result = await checkout(base, { plan: 'carriere_coaching', billing: 'year', type: 'cand' });
      assert.equal(result.status, 409);
      assert.equal(result.body.code, 'SUBSCRIPTION_ALREADY_ACTIVE');
      assert.match(result.body.error, /résiliez/);
      // L'espace recruteur reconnaît ce message pour l'afficher tel quel.
      assert.match(result.body.error, /^Un abonnement est déjà actif/);
      assert.ok(readText(path.join(FRONTEND, '_spaces/recruteur.html')).includes('/^Un abonnement est déjà actif/'));
    }
    for (const abonnement of [STATES.expired, null]) {
      seed({ role: 'candidat', abonnement });
      assert.equal((await checkout(base, { plan: 'carriere', billing: 'month', type: 'cand' })).status, 200);
    }
  });
});

test('R — sans Price ID configuré, le repli facture exactement le tarif affiché', async () => {
  const saved = process.env.STRIPE_PRICE_CANDIDAT_PREMIUM_YEAR;
  delete process.env.STRIPE_PRICE_CANDIDAT_PREMIUM_YEAR;
  try {
    await withServer(async (base) => {
      seed({ role: 'candidat', abonnement: STATES.freemium });
      const result = await checkout(base, { plan: 'carriere', billing: 'year', type: 'cand' });
      assert.equal(result.status, 200);
      const { price_data: priceData } = sessions[0].line_items[0];
      assert.deepEqual(priceData.recurring, { interval: 'year' });
      assert.equal(priceData.unit_amount, 18000, '15 € × 12 = 180 €/an');
    });
  } finally {
    process.env.STRIPE_PRICE_CANDIDAT_PREMIUM_YEAR = saved;
  }
});

test('R (recruteur) — formules recruteur inchangées pour un compte recruteur', async () => {
  await withServer(async (base) => {
    seed({ role: 'recruteur', abonnement: null });
    const result = await checkout(base, { plan: 'pro', billing: 'year', type: 'rec' });
    assert.equal(result.status, 200);
    assert.deepEqual(sessions[0].line_items, [{ price: 'price_rec_pro_year', quantity: 1 }]);
    assert.equal(sessions[0].metadata.type, 'rec');
  });
});

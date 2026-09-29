// Lot 4 — extension de la taxonomie métiers depuis la liste de Yannis
// (test/fixtures/yannis-job-titles.json = copie brute du document).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const taxonomy = require('../utils/yannisTaxonomies');
const { normalizeJobTypeToken } = require('../utils/jobTaxonomy');
const { ADN_PROFILE_QUESTION_MODULES, validateAdnModules } = require('../utils/adnProfileQuestions');
const { LEGACY_PREFS_POSTE_BY_JOB } = require('../utils/adnJobProfile');
const { FILES, sync, render } = require('../scripts/sync-job-taxonomy');
const { normalizeCandidateProfileStructuredFields } = require('../utils/candidateProfileWrite');
const { normalizeOfferStructuredFields } = require('../utils/offerWrite');

const ROOT = path.resolve(__dirname, '../..');
const DOC = require('./fixtures/yannis-job-titles.json');
const RAW_TITLES = DOC.sections.flatMap((section) => section.items);
const DISTINCT_TITLES = [...new Set(RAW_TITLES)];
const HISTORICAL = [['sdr', 'SDR / BDR'], ['bizdev', 'Business Developer'], ['ae', 'Account Executive'],
  ['terrain', 'Commercial terrain'], ['kam', 'Key Account Manager'], ['manager', 'Manager commercial']];
const NEW_JOBS = [
  ['sedentaire', 'Commercial sédentaire / Inside Sales'],
  ['technico_commercial', 'Technico-commercial'],
  ['charge_affaires', "Chargé d'affaires / Ingénieur d'affaires"],
  ['avant_vente', 'Avant-vente / Sales Engineer'],
  ['account_manager', 'Account Manager'],
  ['customer_success', 'Customer Success Manager'],
  ['partenariats', 'Partenariats / Channel'],
  ['conseiller_vente', 'Conseiller de vente / Vendeur'],
  ['direction_commerciale', 'Directeur commercial / Head of Sales'],
];

// Intitulés du document volontairement NON rattachés, avec le motif (voir JOB_TAXONOMY.md).
const EXCLUDED = {
  'Générique ou ambigu (plusieurs métiers possibles)': [
    'Commercial', 'Commercial B2B', 'Commercial B2C', 'Conseiller commercial', 'Conseiller clientèle', 'Chargé de clientèle',
    'Sales Representative', 'Sales Executive', 'Sales Consultant', 'Sales Specialist', 'Sales Associate', 'Sales Advisor',
    'Business Executive', 'Closer', 'Sales Closer', 'Commercial outbound', 'Commercial inbound', 'Growth Sales',
    'Acquisition Manager', "Chargé d'acquisition", 'Lead Generation Manager', 'Business Partner', 'Responsable secteur',
    'Responsable régional',
  ],
  'Rattachement contesté entre deux familles': [
    'Ingénieur commercial', 'Outbound Sales Representative', 'Enterprise Sales Manager', 'Enterprise Account Manager',
    'Account Director', 'Client Partner', 'Directeur grands comptes', 'Customer Engineer', 'Technical Account Manager (TAM)',
    'Technical Account Manager', 'Architecte solutions', 'Solution Architect',
  ],
  'Export / international : décision produit à prendre': [
    'Commercial export', 'International Sales Manager', 'Export Sales Manager', 'Export Manager', 'Export Director',
  ],
  "Appels d'offres / contrats (fonction support)": [
    'Responsable de contrats', 'Contract Manager', 'Bid Manager', 'Tender Manager', "Responsable appels d'offres",
    "Chargé d'appels d'offres",
  ],
  'Support commercial / ADV (hors vente)': [
    'Assistant commercial', 'Assistant commercial export', 'Assistant ADV', 'Assistant administration des ventes',
    'Assistant ventes', 'Secrétaire commercial', 'Chargé ADV', 'Gestionnaire ADV', 'Responsable ADV', 'Sales Assistant',
    'Sales Support', 'Sales Coordinator', 'Sales Administrator', 'Customer Operations Specialist',
  ],
  'Sales Ops / RevOps / pilotage (hors vente)': [
    'Sales Operations Specialist', 'Sales Operations Manager', 'Sales Operations Analyst', 'Commercial Operations Manager',
    'Revenue Operations Manager (RevOps)', 'Revenue Operations Manager', 'Revenue Operations Analyst',
    'Sales Performance Manager', 'Sales Enablement Manager', 'Sales Effectiveness Manager', 'Commercial Excellence Manager',
    'Pricing Manager', 'Revenue Manager', 'Sales Analyst', 'Business Analyst Sales', 'CRM Manager', 'CRM Specialist',
  ],
  'Retail : management de magasin, merchandising, trade marketing': [
    'Responsable de magasin', 'Directeur de magasin', 'Chef de rayon', 'Manager de rayon', 'Animateur commercial',
    'Promoteur des ventes', 'Merchandiser', 'Responsable merchandising', 'Chef de secteur', 'Category Manager',
    'Trade Marketing Manager',
  ],
};
const EXCLUDED_TITLES = Object.values(EXCLUDED).flat();

test('document : 258 intitulés bruts, 47 doublons exacts, 211 distincts', () => {
  assert.equal(DOC.sections.length, 15);
  assert.equal(RAW_TITLES.length, 258);
  assert.equal(DISTINCT_TITLES.length, 211);
  assert.equal(RAW_TITLES.length - DISTINCT_TITLES.length, 47);
});

test('chaque intitulé du document est résolu vers UN métier ou exclu avec un motif — rien n’est oublié', () => {
  assert.equal(new Set(EXCLUDED_TITLES).size, EXCLUDED_TITLES.length, 'aucun doublon dans les exclusions');
  const resolved = DISTINCT_TITLES.filter((title) => taxonomy.resolveJobTypeLabel(title));
  const unresolved = DISTINCT_TITLES.filter((title) => !taxonomy.resolveJobTypeLabel(title));
  assert.deepEqual([...unresolved].sort(), [...EXCLUDED_TITLES].sort());
  assert.equal(resolved.length, 122);
  assert.equal(unresolved.length, 89);
  for (const title of EXCLUDED_TITLES) assert.ok(DISTINCT_TITLES.includes(title), `${title} provient du document`);
});

test('aliases prouvés : chaque alias est un intitulé exact du document ; labels et aliases uniques', () => {
  const tokens = new Map();
  for (const job of taxonomy.JOB_TYPES) {
    for (const alias of job.aliases) assert.ok(DISTINCT_TITLES.includes(alias), `${job.id}: « ${alias} » absent du document`);
    for (const text of [job.label, ...job.aliases]) {
      const token = normalizeJobTypeToken(text);
      assert.equal(tokens.has(token), false, `doublon normalisé : ${text}`);
      tokens.set(token, job.id);
    }
  }
  const ids = taxonomy.JOB_TYPES.map((job) => job.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(taxonomy.JOB_TYPES.reduce((n, job) => n + job.aliases.length, 0), 115);
});

test('6 métiers historiques inchangés ; 9 nouveaux IDs stables, actifs, dans un ordre cohérent', () => {
  const pairs = taxonomy.JOB_TYPES.map((job) => [job.id, job.label]);
  assert.deepEqual(pairs.filter(([id]) => HISTORICAL.some(([h]) => h === id)), HISTORICAL);
  assert.deepEqual(pairs.filter(([id]) => NEW_JOBS.some(([n]) => n === id)), NEW_JOBS);
  assert.equal(pairs.length, 15);
  assert.ok(taxonomy.JOB_TYPES.every((job) => job.active));
  for (const [id] of NEW_JOBS) assert.match(id, /^[a-z][a-z0-9_]*$/);
});

test('résolution des aliases : exemples de la liste vers le bon métier, jamais d’équivalence douteuse', () => {
  const expected = {
    BDR: 'sdr', 'Sales Development Representative (SDR)': 'sdr', 'Téléprospecteur': 'sdr',
    'Business Development Manager (BDM)': 'bizdev', 'International Business Developer': 'bizdev',
    'Enterprise Account Executive': 'ae', 'Account Executive (AE)': 'ae',
    'Inside Sales': 'sedentaire', 'Télévendeur': 'sedentaire', 'Commercial sédentaire': 'sedentaire',
    VRP: 'terrain', 'Délégué commercial terrain': 'terrain',
    'Ingénieur technico-commercial': 'technico_commercial', 'Technico-commercial itinérant': 'technico_commercial',
    "Chargé d'affaires": 'charge_affaires', "Ingénieur d'affaires IT": 'charge_affaires',
    'Sales Engineer': 'avant_vente', 'Pre-Sales Consultant': 'avant_vente', 'Consultant avant-vente': 'avant_vente',
    'Key Account Manager (KAM)': 'kam', 'Commercial grands comptes': 'kam',
    'Senior Account Manager': 'account_manager', 'Chargé de comptes': 'account_manager',
    'Customer Success Manager (CSM)': 'customer_success', 'Channel Manager': 'partenariats', 'Head of Partnerships': 'partenariats',
    Vendeur: 'conseiller_vente', 'Vendeur conseil': 'conseiller_vente',
    'Sales Manager': 'manager', 'Area Sales Manager': 'manager', 'Sales Development Manager': 'manager',
    'Head of Sales': 'direction_commerciale', 'VP Sales': 'direction_commerciale', CRO: 'direction_commerciale',
    'Chief Revenue Officer (CRO)': 'direction_commerciale',
  };
  for (const [title, id] of Object.entries(expected)) {
    assert.equal(taxonomy.resolveJobTypeLabel(title)?.id, id, title);
    assert.equal(taxonomy.resolveJobTypeLabel(`  ${title.toUpperCase()}  `)?.id, id, `${title} (casse/espaces)`);
  }
});

test('écritures : alias certain → label canonique, intitulé ambigu ou legacy conservé tel quel', () => {
  const profile = normalizeCandidateProfileStructuredFields({
    target_job_types: ['bdr', 'Head of Sales', 'Closer', 'Ingénieur commercial', 'Sales Executive', 'Legacy custom role'],
  });
  assert.deepEqual(profile.target_job_types, ['SDR / BDR', 'Directeur commercial / Head of Sales', 'Closer',
    'Ingénieur commercial', 'Sales Executive', 'Legacy custom role']);
  assert.equal(normalizeOfferStructuredFields({ type: 'CDI', job_type: 'sales engineer' }).job_type, 'Avant-vente / Sales Engineer');
  assert.equal(normalizeOfferStructuredFields({ type: 'CDI', job_type: 'Commercial B2B' }).job_type, 'Commercial B2B');
  for (const [, label] of HISTORICAL) assert.equal(taxonomy.canonicalizeTargetJobType(label), label);
});

test('modules ADN : q1/q2 complets pour chaque nouveau métier, contrat respecté, pas de copier-coller', () => {
  validateAdnModules(taxonomy.JOB_TYPES, ADN_PROFILE_QUESTION_MODULES);
  for (const [id] of NEW_JOBS) {
    const module = ADN_PROFILE_QUESTION_MODULES[id];
    assert.deepEqual(Object.keys(module), ['q1', 'q2'], id);
    for (const key of ['q1', 'q2']) assert.ok(module[key].options.length >= 3, `${id}.${key}`);
  }
  const texts = Object.values(ADN_PROFILE_QUESTION_MODULES).flatMap((module) => [module.q1.text, module.q2.text]);
  assert.equal(new Set(texts).size, texts.length, 'aucune question dupliquée entre métiers');
  assert.equal(Object.keys(ADN_PROFILE_QUESTION_MODULES).length, 15);
});

test('choix générés : ADN multi-postes, poste principal, profil candidat, filtres recruteur (aucune liste manuelle)', () => {
  const candidate = fs.readFileSync(path.join(ROOT, FILES[0]), 'utf8');
  const recruiter = fs.readFileSync(path.join(ROOT, FILES[1]), 'utf8');
  const decode = (v) => v.replace(/&(amp|lt|gt|quot|#39);/g, (_a, n) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[n]));
  const zone = (html, name) => html.slice(html.indexOf(`JOB_TAXONOMY:${name}:START`), html.indexOf(`JOB_TAXONOMY:${name}:END`));
  const all = taxonomy.JOB_TYPES.map((job) => [job.id, job.label]);
  const buttons = [...zone(candidate, 'CANDIDATE_ADN_JOB_BUTTONS').matchAll(/data-job-id="([^"]+)"[^>]*><span class="ot">([^<]*)</g)].map((m) => [m[1], decode(m[2])]);
  assert.deepEqual(buttons, all);
  const questions = vm.runInNewContext(zone(candidate, 'CANDIDATE_ADN_QUESTIONS').replace(/^[^\n]*\n/, '') + '\nPROFILE_QUESTIONS');
  assert.deepEqual(Object.keys(questions), all.map(([id]) => id)); // alimente aussi le choix du poste principal
  const suggestions = vm.runInNewContext(`[${zone(candidate, 'CANDIDATE_PROFILE_SUGGESTIONS').replace(/^[^\n]*\n/, '').replace(/\n[^\n]*$/, '')}]`);
  assert.deepEqual([...suggestions], taxonomy.TARGET_JOB_TYPES);
  const chips = [...zone(recruiter, 'RECRUITER_FILTER_CHIPS').matchAll(/data-filter-value="([^"]*)"/g)].map((m) => decode(m[1]));
  assert.deepEqual(chips, taxonomy.TARGET_JOB_TYPES);
  // Hors zones générées, aucun nouveau label n'est écrit à la main.
  for (const [, label] of NEW_JOBS) {
    const escaped = label.replace(/'/g, '&#39;');
    const outside = candidate.split(/JOB_TAXONOMY:[A-Z_]+:START[\s\S]*?JOB_TAXONOMY:[A-Z_]+:END/).join('');
    assert.equal(outside.includes(label) || outside.includes(escaped), false, label);
  }
});

test('aucun nouveau métier dans prefs.poste ; S3 inchangé (bouton historique seulement pour sdr / ae)', () => {
  const candidate = fs.readFileSync(path.join(ROOT, FILES[0]), 'utf8');
  assert.doesNotMatch(candidate, /tg\(this,'poste'/);
  assert.match(candidate, /prefs: \{ contrat:\[\], mode:\[\], secteur:\[\], remun:'', taille:\[\] \}/);
  assert.deepEqual({ ...LEGACY_PREFS_POSTE_BY_JOB }, { sdr: 'sdr', ae: 'ae' });
});

test('taxonomy:check vert et double génération idempotente', () => {
  assert.deepEqual(sync(), { changed: [] });
  for (const file of FILES) {
    const current = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const once = render(file, current);
    assert.equal(once, current);
    assert.equal(render(file, once), once);
  }
});

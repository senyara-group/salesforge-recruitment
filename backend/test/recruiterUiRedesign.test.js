const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', '_spaces', 'recruteur.html'),
  'utf8'
);

test('recruiter UI redesign : shell + IDs critiques conservés', () => {
  for (const id of [
    'topbar', 'bnav', 'nav-dashboard', 'nav-swipe', 'nav-pipeline', 'nav-offres', 'nav-messages', 'nav-settings',
    'dash-title', 'dash-hello', 'dash-logo', 'dash-co-name', 'dash-co-plan', 'photo-nudge', 'avatar-file-prof',
    'kpi-recues', 'kpi-recues-t', 'kpi-chauds', 'kpi-chauds-t', 'kpi-pipeline', 'kpi-offres',
    'cands-recues', 'dash-recent-offers', 'bnav-plan', 'bnav-plan-label', 'bnav-plan-meta',
    'deck-count', 'deck-area', 'deck-cards', 'deck-empty', 'deck-actions', 'comp-filter-badge', 'comp-filter-ov',
    'pipeline-offers-list', 'pipe-cols', 'pipeline-load-more', 'pipeline-load-more-btn', 'pipeline-end',
    'offers-list', 'msgs-list', 'chat-panel', 'chat-input',
    'account-email-display', 'subscription-status-display', 'cancel-subscription-btn',
    'settings-entreprise-display',
    'filt-score-adn', 'filt-job-types', 'filt-sales-style', 'filt-years-min', 'filt-contracts',
    'filt-sectors', 'comp-filter-accordion', 'filt-tools', 'filt-methodologies', 'filt-availability', 'filt-customer-types',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /logo-tag/);
  assert.match(html, /Recruteur/);
  assert.doesNotMatch(html, /Rechercher un candidat, une offre/);
  assert.doesNotMatch(html, /placeholder="Rechercher/);
});

test('recruiter UI redesign : dashboard structure mockup-compatible', () => {
  assert.match(html, /dash-hero-card/);
  assert.match(html, /Trouvez vos futurs talents/);
  assert.match(html, /Attirez les meilleurs profils/);
  assert.match(html, /Actions rapides/);
  assert.match(html, /Mes offres récentes/);
  assert.match(html, /Candidatures récentes/);
  assert.match(html, /En réponse \/ entretien/);
  assert.match(html, /function renderDashRecentOffers/);
  assert.match(html, /function syncBnavPlan/);
  assert.match(html, /dash-mid/);
  assert.match(html, /dash-bottom/);
  assert.match(html, /dash-action-item is-primary/);
  assert.match(html, /\.dash-mid\{grid-template-columns:minmax\(240px,\.9fr\) minmax\(0,1\.3fr\)/);
  assert.match(html, /\.dash-bottom\{grid-template-columns:1fr 1fr/);
  assert.doesNotMatch(html, /Score \+85/);
});

test('recruiter UI polish #2 : sourcing = squelette candidat (deck-wrap)', () => {
  assert.match(html, /class="deck-wrap"/);
  assert.match(html, /class="filter-row cand-filter-bar"/);
  assert.match(html, /class="fp fp-filters/);
  assert.match(html, /id="deck-actions"/);
  assert.match(html, /Tous les profils ont été consultés/);
  assert.match(html, /openCandFilterModal\(\)">Ajuster les filtres/);
  assert.match(html, /aria-label="Passer"/);
  assert.match(html, /aria-label="Like"/);
  assert.match(html, /aria-label="Super like"/);
  assert.match(html, /actions\.hidden = isEmpty/);
  assert.match(html, /empty\.hidden = !isEmpty/);
  assert.match(html, /area\.classList\.toggle\('is-empty', isEmpty\)/);
  assert.match(html, /\.deck-actions\[hidden\]\{display:none !important\}/);
  assert.match(html, /#p-swipe\.page\.on\{display:flex !important;flex-direction:column/);
  assert.match(html, /max-width:1200px/);
  assert.match(html, /max-width:1180px/);
});

test('recruiter UI polish #2 : filtres IDs + bottom sheet conservés', () => {
  assert.match(html, /id="comp-filter-ov"/);
  assert.match(html, /class="bottom-sheet filters-sheet"/);
  assert.match(html, /resetCandFiltersPanel\(\)">Réinitialiser/);
  assert.match(html, /applyCandFiltersFromPanel\(\)">Appliquer/);
  assert.match(html, /badge\.hidden = !count/);
  assert.match(html, /resetQuick\.hidden = !count/);
});

test('recruiter UI polish #2 : pipeline workspace + empty surface', () => {
  assert.match(html, /Suivez vos recrutements/);
  assert.match(html, /pipe-offers-context/);
  assert.match(html, /pipe-kanban-wrap/);
  assert.match(html, /surface: true/);
  assert.match(html, /is-surface/);
  assert.match(html, /Aucune candidature reçue/);
  assert.match(html, /Sourcer des candidats/);
  assert.match(html, /id="pipeline-offers-list"/);
  assert.match(html, /id="pipe-cols"/);
  assert.match(html, /id="pipeline-load-more"/);
  assert.match(html, /id="pipeline-load-more-btn"/);
  assert.match(html, /id="pipeline-end"/);
});

test('recruiter UI redesign : Hardening #1 et #2 intactes', () => {
  assert.match(html, /async function doSwipe/);
  assert.match(html, /CAND_DECK_LOAD_GEN/);
  assert.match(html, /CAND_DECK_ABORT/);
  assert.match(html, /PIPELINE_LOAD_GEN/);
  assert.match(html, /PIPELINE_ABORT/);
  assert.match(html, /AbortController/);
  assert.match(html, /loadMorePipeline/);
  const loadStart = html.indexOf('async function loadPipeline');
  const loadEnd = html.indexOf('async function loadMorePipeline', loadStart);
  const loadBlock = html.slice(loadStart, loadEnd);
  assert.match(loadBlock, /offersError/);
  assert.match(loadBlock, /pipelineError/);
  assert.doesNotMatch(loadBlock, /Promise\.all\(\[\s*api\('GET', '\/recruteurs\/pipeline'/);
});

test('recruiter UI polish #2 : settings / abonnement parité candidat', () => {
  assert.match(html, /<h2 class="sf">Connexion<\/h2>/);
  assert.match(html, /<h2 class="sf">Abonnement<\/h2>/);
  assert.match(html, /Voir les formules/);
  assert.match(html, /account-logout/);
  assert.match(html, /Se déconnecter/);
  assert.match(html, /Entreprise/);
  assert.match(html, /account-section/);
  assert.match(html, /account-layout/);
  assert.match(html, /RECRUITER_PLAN_LABELS/);
  assert.match(html, /Plan Enterprise/);
  assert.doesNotMatch(html, /settings-logout/);
  assert.doesNotMatch(html, /Abonnement candidat/);
});

test('recruiter UI polish #2 : offres cartes (pas bande fine desktop)', () => {
  assert.match(html, /#p-offres \.offers-list\{display:grid;grid-template-columns:repeat\(auto-fit,minmax\(min\(100%,480px\),1fr\)\)/);
  assert.match(html, /Voir candidatures/);
  assert.match(html, /function renderOffers/);
});

test('recruiter predemo : topbar sans Bonjour doublon', () => {
  assert.match(html, /\.topbar-greet\{display:none !important\}/);
  assert.match(html, /greetEl\.hidden = true/);
  assert.doesNotMatch(html, /greetEl\.innerHTML = name \? `Bonjour/);
  assert.match(html, /Bonjour \$\{name\} 👋/);
  assert.match(html, /Bonjour 👋/);
});

test('recruiter predemo : logo sans placeholder ??', () => {
  assert.match(html, /function companyInitials/);
  assert.match(html, /LOGO_PLACEHOLDER_SVG/);
  assert.match(html, /Logo non renseigné/);
  assert.doesNotMatch(html, /entreprise\|\|'??'/);
  assert.doesNotMatch(html, /entreprise\|\|'\?\?'/);
});

test('recruiter predemo : pipeline empty pleine largeur', () => {
  assert.match(html, /\.pipe-cols:has\(> \.pipe-state\)/);
  assert.match(html, /display:block/);
  assert.match(html, /surface: true/);
  assert.match(html, /Aucune candidature reçue/);
});

test('recruiter sourcing card polish : structure identité + handlers swipe', () => {
  assert.match(html, /class="cand-top cand-identity/);
  assert.match(html, /cand-identity-inner/);
  assert.match(html, /cand-body-hd/);
  assert.match(html, /cand-mid/);
  assert.match(html, /Pitch \/ Synthèse/);
  assert.match(html, /Analyse du profil disponible/);
  assert.match(html, /Profil synchronisé avec les recruteurs/);
  assert.match(html, /function isTechnicalDeckCopy/);
  assert.match(html, /function deckSynthesisCopy/);
  assert.match(html, /onclick="swipe\('pass'\)"/);
  assert.match(html, /onclick="swipe\('like'\)"/);
  assert.match(html, /onclick="swipe\('super'\)"/);
  assert.match(html, /async function doSwipe/);
  assert.match(html, /function attachDrag/);
  assert.match(html, /closest\('\.cand-top'\)/);
  assert.doesNotMatch(html, /Score calculé depuis les réponses du test ADN/);
  assert.doesNotMatch(html, /enregistré dans Supabase/);
  assert.match(html, /supabase\|score calcul/);
  assert.match(html, /#p-swipe \.swipe-card\{[\s\S]*?flex-direction:row/);
  assert.match(html, /#p-swipe \.cand-top\.cand-identity\{[\s\S]*?width:28%/);
  assert.match(html, /@media \(max-width:719px\)\{[\s\S]*?#p-swipe \.cand-mid\{grid-template-columns:1fr\}/);
});

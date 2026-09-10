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
    'deck-count', 'deck-area', 'deck-cards', 'deck-empty', 'comp-filter-badge', 'comp-filter-ov',
    'pipeline-offers-list', 'pipe-cols', 'pipeline-load-more', 'pipeline-load-more-btn', 'pipeline-end',
    'offers-list', 'msgs-list', 'chat-panel', 'chat-input',
    'account-email-display', 'subscription-status-display', 'cancel-subscription-btn',
    'settings-entreprise-display',
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
  assert.doesNotMatch(html, /Score \+85/);
});

test('recruiter UI redesign : sourcing empty + a11y swipe buttons', () => {
  assert.match(html, /Tous les profils ont été consultés/);
  assert.match(html, /openCandFilterModal\(\)">Ajuster les filtres/);
  assert.match(html, /aria-label="Passer"/);
  assert.match(html, /aria-label="Like"/);
  assert.match(html, /aria-label="Super like"/);
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

test('recruiter UI redesign : settings sections sans faux champs backend', () => {
  assert.match(html, /Mon compte/);
  assert.match(html, /Mon abonnement/);
  assert.match(html, /Entreprise/);
  assert.match(html, /settings-logout/);
  assert.match(html, /doLogout\(\)/);
});

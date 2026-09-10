const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  CONTRACT_TYPES,
  REMOTE_MODES,
  OFFER_TAG_VOCABULARY,
  PENDING_TAXONOMIES,
  STABLE_TAXONOMIES,
  canonicalizeContractType,
  inferRemoteModeFromLieu,
  assertAllowedValue,
  assertAllowedList,
  matchesFilterFamilies,
  familyMatchesAny,
} = require('../utils/filterTaxonomies');

const migrationPath = path.join(__dirname, '..', 'filter_foundation_migration.sql');
const sql = fs.readFileSync(migrationPath, 'utf8');
const candidateHtml = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', '_spaces', 'candidat.html'), 'utf8');

test('migration filtres est additive et ne détruit rien', () => {
  assert.doesNotMatch(sql, /drop table|truncate|delete from|drop column/i);
  assert.doesNotMatch(sql, /(?:update|insert into|from|join)\s+public\.(?:deep_adn\w*|bilans_carriere|ai_cv_analyses)\b/i);
  assert.doesNotMatch(sql, /update\s+public\.candidats\s+set\s+score_adn/i);
  assert.doesNotMatch(sql, /set\s+years_experience\s*=/i);
});

test('migration ajoute les colonnes offres et candidats nullable', () => {
  for (const column of [
    'job_type', 'remote_mode', 'salary_fixed_min', 'salary_fixed_max', 'has_variable', 'variable_note',
    'sales_styles', 'sector', 'customer_types', 'experience_min', 'experience_max',
    'city_code', 'latitude', 'longitude', 'created_at',
  ]) {
    assert.match(sql, new RegExp(`alter table public\\.offres add column if not exists ${column}`, 'i'));
  }
  for (const column of [
    'target_job_types', 'sales_style', 'years_experience', 'city_code', 'latitude', 'longitude',
    'mobility_km', 'desired_contracts', 'sectors', 'customer_types', 'tools', 'methodologies', 'availability',
  ]) {
    assert.match(sql, new RegExp(`alter table public\\.candidats add column if not exists ${column}`, 'i'));
  }
  assert.match(sql, /alter table public\.offres alter column created_at set default now\(\)/i);
  assert.match(sql, /update public\.offres\s+set created_at = now\(\)\s+where created_at is null/i);
});

test('migration conserve les champs legacy et n’écrase pas recruteurs.secteur vers offres.sector', () => {
  assert.doesNotMatch(sql, /offres\.sector\s*=\s*.*recruteurs/i);
  assert.doesNotMatch(sql, /set\s+sector\s*=\s*.*from\s+public\.recruteurs/i);
  assert.match(sql, /Canonicalisation type de contrat/);
});

test('index attendus présents sans contrainte enum irréversible sur taxonomies pending', () => {
  for (const indexName of [
    'offres_statut_created_at_idx',
    'offres_type_idx',
    'offres_remote_mode_idx',
    'offres_salary_fixed_min_idx',
    'offres_sales_styles_gin_idx',
    'offres_tags_gin_idx',
    'candidats_score_adn_idx',
    'candidats_desired_contracts_gin_idx',
    'candidats_tools_gin_idx',
    'candidats_methodologies_gin_idx',
  ]) {
    assert.match(sql, new RegExp(`create index if not exists ${indexName}`, 'i'));
  }
  assert.doesNotMatch(sql, /check\s*\(\s*job_type/i);
  assert.doesNotMatch(sql, /check\s*\(\s*sales_style/i);
  assert.doesNotMatch(sql, /check\s*\(\s*availability/i);
  assert.doesNotMatch(sql, /check\s*\(\s*customer_types/i);
});

test('backfills migration restent déterministes (remote + contrat casse)', () => {
  assert.match(sql, /set remote_mode = 'remote'/i);
  assert.match(sql, /set remote_mode = 'nationwide'/i);
  assert.match(sql, /set type = 'CDI'/i);
  assert.doesNotMatch(sql, /description/i);
});

test('taxonomies stables et pending sont exposées côté backend', () => {
  assert.deepEqual(CONTRACT_TYPES, ['CDI', 'Alternance', 'Mission', 'Freelance']);
  assert.deepEqual(REMOTE_MODES, ['remote', 'nationwide', 'onsite', 'hybrid']);
  assert.equal(OFFER_TAG_VOCABULARY.length, 7);
  assert.equal(STABLE_TAXONOMIES.contract_type.pendingYannis, false);
  assert.equal(STABLE_TAXONOMIES.remote_mode.pendingYannis, false);
  for (const key of ['job_type', 'sales_style', 'customer_types', 'availability', 'sectors']) {
    assert.equal(PENDING_TAXONOMIES[key].pendingYannis, true);
    assert.ok(PENDING_TAXONOMIES[key].values.length >= 3);
  }
});

test('validation taxonomies et règle OR intra-famille / AND inter-familles', () => {
  assert.equal(canonicalizeContractType('cdi'), 'CDI');
  assert.equal(canonicalizeContractType('Stage'), null);
  assert.equal(inferRemoteModeFromLieu('Remote / Télétravail'), 'remote');
  assert.equal(inferRemoteModeFromLieu('France entière'), 'nationwide');
  assert.equal(inferRemoteModeFromLieu('Lyon'), 'onsite');
  assert.equal(assertAllowedValue('CDI', CONTRACT_TYPES, 'contrat'), 'CDI');
  assert.throws(() => assertAllowedValue('Stage', CONTRACT_TYPES, 'contrat'), { code: 'FILTER_TAXONOMY_INVALID' });
  assert.deepEqual(assertAllowedList(['Mission', 'Freelance'], CONTRACT_TYPES, 'contrat'), ['Mission', 'Freelance']);

  const contractOk = familyMatchesAny(['CDI', 'Freelance'], ['Freelance']);
  const sectorOk = familyMatchesAny(['saas', 'industrie'], ['industrie']);
  const experienceOk = 5 >= 3;
  assert.equal(matchesFilterFamilies([contractOk, sectorOk, experienceOk]), true);
  assert.equal(matchesFilterFamilies([contractOk, familyMatchesAny(['saas'], ['industrie']), experienceOk]), false);
});

test('garde-fous : deep ADN / bilan / CV IA hors fondation sourcing', () => {
  for (const file of [
    'utils/filterTaxonomies.js',
    'filter_foundation_migration.sql',
    'routes/candidats.js',
    'routes/recruteurs.js',
    'routes/offres.js',
    'utils/applicationWorkflow.js',
  ]) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.doesNotMatch(source, /deep_adn_assessments|deep_adn_answers/i, `${file} ne doit pas lier le sourcing au deep ADN`);
  }
  assert.doesNotMatch(sql, /bilans_carriere/i);
  assert.doesNotMatch(sql, /from\s+public\.ai_cv_analyses/i);
  assert.doesNotMatch(sql, /set\s+years_experience\s*=/i);
});

test('score_adn court reste la source scoring et n’est pas recalculé par la migration', () => {
  const candidatsRoute = fs.readFileSync(path.join(__dirname, '..', 'routes', 'candidats.js'), 'utf8');
  assert.match(candidatsRoute, /score_adn/);
  assert.match(candidatsRoute, /\.order\('score_adn'/);
  assert.doesNotMatch(sql, /score_adn\s*=/);
});

test('bug tags vides : une offre sans tags ne reçoit plus les 7 tags automatiques', () => {
  assert.doesNotMatch(
    candidateHtml,
    /rawTags\.length \? rawTags : \['Closing', 'Cold Calling', 'SaaS', 'Outbound', 'HubSpot', 'Salesforce', 'Négociation'\]/,
  );
  assert.match(candidateHtml, /Une offre sans tags ne doit pas prétendre posséder les 7 compétences/);
  assert.match(candidateHtml, /const offerTags = rawTags;/);
  assert.match(candidateHtml, /tagsDisplay: rawTags/);

  const start = candidateHtml.indexOf('function normOffre(o, mySkills = [])');
  assert.ok(start >= 0);
  let depth = 0;
  let end = -1;
  for (let i = start; i < candidateHtml.length; i += 1) {
    const ch = candidateHtml[i];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  assert.ok(end > start);
  const sandbox = {
    initials: () => 'AC',
    asAxesList: () => [],
    computeCompat: (offerTags) => ({
      score: (offerTags || []).length ? 10 : 0,
      matched: new Set(),
    }),
  };
  vm.runInNewContext(`${candidateHtml.slice(start, end)}\nthis.normOffre = normOffre;`, sandbox);
  const empty = sandbox.normOffre({ id: '1', titre: 'Test', tags: [] }, []);
  assert.deepEqual(empty.tags, []);
  assert.deepEqual(empty.tagsDisplay, []);
  assert.equal(empty.m, 0);
  const kept = sandbox.normOffre({ id: '2', tags: ['Closing', 'SaaS'] }, []);
  assert.deepEqual(kept.tags, ['Closing', 'SaaS']);
});

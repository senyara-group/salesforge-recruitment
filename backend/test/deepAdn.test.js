const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  QUESTIONS, BLOCKS, QUESTIONNAIRE_VERSION, SCORING_VERSION,
  createPresentation, publicQuestionnaire, scoreAnswers, validateAnswer, normalizeBlockScore,
} = require('../utils/deepAdnQuestionnaire');

function answersForWeight(weight) {
  return QUESTIONS.map((question) => ({
    question_id: question.id,
    option_id: question.options.find((option) => option.weight === weight)?.id || question.options[0].id,
  }));
}

test('référentiel Yannis possède 48 situations stables en 6 blocs de 8', () => {
  assert.equal(QUESTIONS.length, 48);
  assert.equal(BLOCKS.length, 6);
  for (const block of BLOCKS) assert.equal(QUESTIONS.filter((question) => question.blockId === block.id).length, 8);
  assert.equal(new Set(QUESTIONS.map((question) => question.id)).size, 48);
  assert.equal(QUESTIONNAIRE_VERSION, 'yannis-48-v1');
  assert.equal(SCORING_VERSION, 'blocks-linear-v1');
});

test('API publique ne contient jamais les pondérations', () => {
  const payload = publicQuestionnaire(createPresentation(() => 0));
  assert.equal(JSON.stringify(payload).includes('weight'), false);
  assert.equal(JSON.stringify(payload).includes('pondération'), false);
  assert.deepEqual(Object.keys(payload.blocks[0].questions[0].options[0]).sort(), ['id', 'text']);
});

test('scores de chaque bloc restent bornés entre 0 et 100', () => {
  for (const weight of [1, 2, 3, 4]) {
    const result = scoreAnswers(answersForWeight(weight), createPresentation(() => 0));
    for (const block of result.blocks) assert.ok(block.score >= 0 && block.score <= 100);
  }
  assert.ok(scoreAnswers(answersForWeight(1)).blocks.every((block) => block.score === 0));
  assert.ok(scoreAnswers(answersForWeight(4)).blocks.every((block) => block.score === 100));
});

test('normalisation des blocs place exactement minimum, milieu et maximum à 0, 50 et 100', () => {
  assert.equal(normalizeBlockScore(8), 0);
  assert.equal(normalizeBlockScore(20), 50);
  assert.equal(normalizeBlockScore(32), 100);
});

test('randomisation change l’ordre mais jamais le scoring', () => {
  const first = createPresentation(() => 0);
  const last = createPresentation((max) => max - 1);
  assert.notDeepEqual(first[0].option_ids, last[0].option_ids);
  const answers = answersForWeight(3);
  assert.deepEqual(scoreAnswers(answers, first).blocks, scoreAnswers(answers, last).blocks);
});

test('option inconnue, doublon et finalisation incomplète sont refusés', () => {
  assert.throws(() => validateAnswer('B1_S01', 'inconnue'), { code: 'UNKNOWN_OPTION' });
  const duplicate = answersForWeight(2); duplicate[1] = { ...duplicate[0] };
  assert.throws(() => scoreAnswers(duplicate), { code: 'DUPLICATE_ANSWER' });
  assert.throws(() => scoreAnswers(answersForWeight(2).slice(0, 47)), { code: 'INCOMPLETE_ASSESSMENT' });
});

test('incohérences déterministes détectent première option affichée et maximum uniforme', () => {
  const presentation = createPresentation(() => 0);
  const alwaysFirst = presentation.map((item) => ({ question_id: item.question_id, option_id: item.option_ids[0] }));
  assert.ok(scoreAnswers(alwaysFirst, presentation).consistency.flags.includes('always_first_displayed_option'));
  assert.ok(scoreAnswers(answersForWeight(4), presentation).consistency.flags.includes('all_blocks_maximum'));
});

test('migration est additive, RLS propriétaire et anon révoqué', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'deep_adn_migration.sql'), 'utf8');
  assert.match(sql, /create table if not exists public\.deep_adn_assessments/i);
  assert.match(sql, /create table if not exists public\.deep_adn_answers/i);
  assert.match(sql, /auth\.uid\(\) = user_id/g);
  assert.match(sql, /foreign key \(assessment_id, user_id\)[\s\S]*references public\.deep_adn_assessments\(id, user_id\)/i);
  assert.match(sql, /revoke all on public\.deep_adn_assessments from anon/i);
  assert.match(sql, /revoke all on public\.deep_adn_answers from anon/i);
  assert.doesNotMatch(sql, /drop table|truncate|delete from|alter table public\.candidats|update public\.candidats/i);
});

test('ADN approfondi reste absent du matching, deck et contrat recruteur', () => {
  for (const file of ['routes/candidats.js', 'routes/recruteurs.js', 'routes/offres.js', 'utils/applicationWorkflow.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.doesNotMatch(source, /deep_adn/i, `${file} ne doit pas consommer l’ADN approfondi`);
  }
  const legacyMigration = fs.readFileSync(path.join(__dirname, '..', 'supabase_evaluations_adn.sql'), 'utf8');
  assert.doesNotMatch(legacyMigration, /deep_adn/i);
});

test('routes approfondies ne modifient jamais score_adn ou axes candidat', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'deepAdn.js'), 'utf8');
  assert.doesNotMatch(source, /score_adn|\.from\(['"]candidats['"]\)|\baxes\b/i);
  assert.match(source, /\.eq\('id', req\.params\.id\)\.eq\('user_id', req\.user\.id\)/);
  assert.match(source, /questionnaire_version/);
  assert.match(source, /scoring_version/);
});

test('interface candidat consomme uniquement le contrat public approfondi', () => {
  const candidate = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', '_spaces', 'candidat.html'), 'utf8');
  const recruiter = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', '_spaces', 'recruteur.html'), 'utf8');
  assert.match(candidate, /\/adn-approfondi\/current/);
  assert.match(candidate, /question\.options\.map/);
  assert.doesNotMatch(candidate, /deep.{0,20}(weight|pondération)/i);
  assert.doesNotMatch(recruiter, /adn-approfondi|deep_adn/i);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { FACT_STATUS, MAX_DATE_RANGES, buildCvFacts } = require('../utils/cvFacts');

const NOW = new Date('2025-07-01T00:00:00Z');

test('calcule une durée sans double compter les périodes continues', () => {
  const facts = buildCvFacts({ sourceText: 'EXPÉRIENCES PROFESSIONNELLES\n2016–2017 Support\n2017–2022 Développeur\n2022–2023 Lead\ndepuis 2023 Freelance', now: NOW });
  assert.deepEqual(facts.inferred.timeline.approximate_years, { min: 9, max: 10 });
  assert.equal(facts.inferred.timeline.merged_periods.length, 1);
});

test('ne double compte pas deux expériences qui se chevauchent', () => {
  const facts = buildCvFacts({ sourceText: 'EXPÉRIENCES\n2018-2022 Mission A\n2020-2024 Mission B', now: NOW });
  assert.deepEqual(facts.inferred.timeline.approximate_years, { min: 6, max: 6 });
  assert.equal(facts.inferred.timeline.overlaps_detected, 1);
});

test('écarte les dates de formation quand une section expérience est identifiable', () => {
  const facts = buildCvFacts({ sourceText: 'EXPÉRIENCES\n2020-2024 Développeur\nFORMATION\n2010-2015 Diplôme', now: NOW });
  assert.deepEqual(facts.inferred.timeline.approximate_years, { min: 4, max: 4 });
  assert.equal(facts.confirmed.date_ranges.length, 1);
});

test('reconnaît les headings dont les lettres sont espacées par extraction', () => {
  const facts = buildCvFacts({ sourceText: 'E X P É R I E N C E S\n2020-2024 Développeur React Native\nF O R M A T I O N\n2013 à 2016 Diplôme\nC O M P É T E N C E S\nRailway\nS T A C K  T E C H N I Q U E\nDocker', now: NOW });
  assert.deepEqual(facts.confirmed.date_ranges.map((item) => item.value), ['2020-2024']);
  assert.equal(facts.confirmed.technologies.find((item) => item.name === 'React Native').evidence, 'experience');
  assert.equal(facts.confirmed.technologies.find((item) => item.name === 'Railway').evidence, 'skills_list_only');
});

test('CV réel : exclut la formation, conserve les preuves et détecte la chronologie inverse', () => {
  const sourceText = `E X P É R I E N C E S
DEPUIS 2023
CL NOVALYS
DÉVELOPPEUR WEB & MOBILE INDÉPENDANT
React / Next.js / Node.js / Supabase / PostgreSQL

2022 - 2023
IBM CIC
DÉVELOPPEUR MOBILE REACT NATIVE
React Native / AWS

2017 - 2022
ALTIMANCE
DÉVELOPPEUR INTÉGRATEUR
React / Node.js / AWS / Azure

2016 - 2017
EBOS
TECHNICIEN HELP DESK

F O R M A T I O N
ACTIF CNT (2013 à 2016)

C O M P É T E N C E S
Railway
Docker`;
  const facts = buildCvFacts({ sourceText, now: NOW });
  assert.deepEqual(facts.confirmed.date_ranges.map((item) => item.value), ['DEPUIS 2023', '2022 - 2023', '2017 - 2022', '2016 - 2017']);
  assert.equal(facts.inferred.timeline.merged_periods[0].start_year, 2016);
  assert.equal(facts.inferred.timeline.document_order, 'descending');
  assert.equal(facts.confirmed.technologies.find((item) => item.name === 'React Native').evidence, 'experience');
  assert.equal(facts.confirmed.technologies.find((item) => item.name === 'AWS').evidence, 'experience');
  assert.equal(facts.confirmed.technologies.find((item) => item.name === 'Railway').evidence, 'skills_list_only');
});

test('infère prudemment une progression support vers développement', () => {
  const facts = buildCvFacts({ sourceText: 'EXPÉRIENCES\n2016-2018 Help Desk\n2019-2022 Développeur web', now: NOW });
  assert.ok(facts.inferred.strengths.some((fact) => fact.type === 'career_progression' && fact.status === FACT_STATUS.INFERRED));
});

test('distingue technologie corroborée en expérience et technologie seulement listée', () => {
  const facts = buildCvFacts({ sourceText: 'EXPÉRIENCES\n2021-2024 Application React Native\nCOMPÉTENCES\nReact Native, Railway', now: NOW });
  assert.equal(facts.confirmed.technologies.find((item) => item.name === 'React Native').evidence, 'experience');
  assert.equal(facts.confirmed.technologies.find((item) => item.name === 'Railway').evidence, 'skills_list_only');
});

test('place en vérification une technologie cible absente du CV', () => {
  const facts = buildCvFacts({ sourceText: 'EXPÉRIENCES\n2021-2024 Développeur React', offerText: 'Déploiement Kubernetes', now: NOW });
  assert.equal(facts.verify.technologies.find((item) => item.name === 'Kubernetes').status, FACT_STATUS.VERIFY);
});

test('conserve une expérience A2 déclarée même sans date dans le CV', () => {
  const facts = buildCvFacts({ sourceText: 'Développeur web', experienceYears: 5, now: NOW });
  assert.deepEqual(facts.declared.experience_years, { status: FACT_STATUS.DECLARED, value: 5 });
});

test('signale sans arbitrer une contradiction entre expérience déclarée et chronologie', () => {
  const facts = buildCvFacts({ sourceText: 'EXPÉRIENCES\n2010-2024 Développeur', experienceYears: 5, now: NOW });
  assert.equal(facts.declared.experience_years.value, 5);
  assert.equal(facts.verify.experience_years.status, FACT_STATUS.VERIFY);
});

test('un CV pauvre ne produit ni chronologie ni expertise inventée', () => {
  const facts = buildCvFacts({ sourceText: 'Profil motivé et polyvalent.', targetRole: 'Développeur', now: NOW });
  assert.equal(facts.inferred.timeline, null);
  assert.deepEqual(facts.confirmed.technologies, []);
  assert.deepEqual(facts.inferred.strengths, []);
  assert.equal(facts.missing.rule.status, FACT_STATUS.MISSING);
});

test('borne les faits chronologiques injectés au prompt', () => {
  const sourceText = Array.from({ length: 60 }, (_, index) => `${1960 + index}-${1961 + index} Mission`).join('\n');
  const facts = buildCvFacts({ sourceText, now: NOW });
  assert.equal(facts.confirmed.date_ranges.length, MAX_DATE_RANGES);
});

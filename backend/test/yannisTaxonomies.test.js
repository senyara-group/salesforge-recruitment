const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  CANDIDATE_SKILLS,
  TOOLS,
  METHODOLOGIES,
  canonicalizeCandidateSkill,
  resolveCanonicalSkill,
  normalizeSkill,
  flattenCompetencesMeta,
  resolveCandidateSkills,
} = require('../utils/yannisTaxonomies');
const { normalizeCandidateProfileStructuredFields } = require('../utils/candidateProfileWrite');
const { QUESTIONS } = require('../utils/deepAdnQuestionnaire');
const { candidateMatchesSkills } = require('../utils/candidateDeckQuery');

const B3_S17_PROMPT =
  'Fin de rendez-vous. Le client a été positif, il a posé des questions sur le déploiement. Il dit : c’est très intéressant, je vais en parler en interne.';

test('B3_S17 : libellé exact Yannis ; IDs/options/poids inchangés', () => {
  const q = QUESTIONS.find((item) => item.id === 'B3_S17');
  assert.ok(q);
  assert.equal(q.prompt, B3_S17_PROMPT);
  assert.equal(q.options.length, 4);
  assert.deepEqual(q.options.map((o) => o.weight), [4, 3, 2, 1]);
  assert.equal(QUESTIONS.length, 48);
});

test('skills Yannis distinctes de tools et methodologies', () => {
  assert.deepEqual([...CANDIDATE_SKILLS], [
    'Closing', 'Cold calling', 'Prospection terrain', 'Négociation', 'Gestion de portefeuille', 'Social selling',
  ]);
  for (const skill of CANDIDATE_SKILLS) {
    assert.equal(TOOLS.includes(skill), false, `skill chevauche tool: ${skill}`);
    assert.equal(METHODOLOGIES.includes(skill), false, `skill chevauche méthodo: ${skill}`);
  }
});

test('canonicalize / resolveCanonicalSkill : alias legacy + unknown drop', () => {
  assert.equal(normalizeSkill('Cold-Calling'), 'cold calling');
  assert.equal(resolveCanonicalSkill('cold calling'), 'Cold calling');
  assert.equal(resolveCanonicalSkill('cold-calling'), 'Cold calling');
  assert.equal(resolveCanonicalSkill('Négociation commerciale'), 'Négociation');
  assert.equal(resolveCanonicalSkill('Développement de portefeuille'), 'Gestion de portefeuille');
  assert.equal(canonicalizeCandidateSkill('Unknown'), null);
  const out = normalizeCandidateProfileStructuredFields({
    skills: ['Closing', 'Closing', 'cold-calling', 'FooBar', 'HubSpot'],
  });
  assert.deepEqual(out.skills, ['Closing', 'Cold calling']);
});

test('resolveCandidateSkills : colonne dédiée prioritaire, sinon axes.meta.competences + aliases', () => {
  assert.deepEqual(
    resolveCandidateSkills({ skills: ['Closing', ' Closing ', 'Closing'] }),
    ['Closing'],
  );
  assert.deepEqual(
    resolveCandidateSkills({
      skills: ['Closing'],
      axes: { meta: { competences: { Vente: ['Négociation'] } } },
    }),
    ['Closing'],
  );
  assert.deepEqual(
    resolveCandidateSkills({
      skills: [],
      axes: { meta: { competences: { Vente: ['Closing'], Soft: ['Écoute'] } } },
    }),
    ['Closing', 'Écoute'],
  );
  assert.deepEqual(
    resolveCandidateSkills({
      axes: { meta: { competences: { Vente: ['Closing'], Soft: ['Écoute'] } } },
    }),
    ['Closing', 'Écoute'],
  );
  assert.deepEqual(
    resolveCandidateSkills({
      axes: {
        meta: {
          competences: {
            Négociation: ['Négociation commerciale'],
            Prospection: ['cold-calling'],
            Portefeuille: ['Développement de portefeuille'],
          },
        },
      },
    }),
    ['Négociation', 'Cold calling', 'Gestion de portefeuille'],
  );
  assert.deepEqual(flattenCompetencesMeta({ A: ['x'], B: ['y', 'x'] }), ['x', 'y', 'x']);
});

test('filtre deck : match sur skills dédiées ou legacy flat + aliases', () => {
  assert.equal(
    candidateMatchesSkills({ skills: ['Closing'] }, ['Closing']),
    true,
  );
  assert.equal(
    candidateMatchesSkills({
      axes: { meta: { competences: { Vente: ['Social selling'] } } },
    }, ['Social selling']),
    true,
  );
  assert.equal(
    candidateMatchesSkills({
      axes: { meta: { competences: { Négociation: ['Négociation commerciale'] } } },
    }, ['Négociation']),
    true,
  );
  assert.equal(
    candidateMatchesSkills({
      axes: { meta: { competences: { Prospection: ['cold-calling'] } } },
    }, ['Cold calling']),
    true,
  );
  assert.equal(
    candidateMatchesSkills({
      axes: { meta: { competences: { Portefeuille: ['Développement de portefeuille'] } } },
    }, ['Gestion de portefeuille']),
    true,
  );
  assert.equal(
    candidateMatchesSkills({ skills: ['Closing'] }, ['Cold calling']),
    false,
  );
});

test('filtre recruteur : canonicalisation des deux côtés (casse / accents / tirets / aliases)', () => {
  const withNego = { skills: ['Négociation'] };
  const legacyNego = { axes: { meta: { competences: { X: ['Négociation commerciale'] } } } };
  const legacyCold = { axes: { meta: { competences: { P: ['cold-calling'] } } } };
  const legacyPortfolio = { axes: { meta: { competences: { P: ['Développement de portefeuille'] } } } };

  for (const filter of ['Négociation', 'négociation', 'NEGOCIATION', 'negociation', 'négociation-commerciale', 'Négociation commerciale']) {
    assert.equal(candidateMatchesSkills(withNego, [filter]), true, `filtre ${filter} vs skills[]`);
    assert.equal(candidateMatchesSkills(legacyNego, [filter]), true, `filtre ${filter} vs legacy`);
  }
  for (const filter of ['cold-calling', 'Cold Calling', 'COLD CALLING', 'Cold calling']) {
    assert.equal(candidateMatchesSkills(legacyCold, [filter]), true, `filtre ${filter}`);
  }
  for (const filter of ['Développement de portefeuille', 'developpement-de-portefeuille', 'Gestion de portefeuille']) {
    assert.equal(candidateMatchesSkills(legacyPortfolio, [filter]), true, `filtre ${filter}`);
  }
  assert.equal(
    candidateMatchesSkills(withNego, ['Closing', 'NEGOCIATION']),
    true,
    'OR multi-filtres mixte canonique / non canonique',
  );
  assert.equal(candidateMatchesSkills(withNego, ['CompétenceInconnueXYZ']), false);
  assert.equal(candidateMatchesSkills(withNego, ['Closing']), false);
});

test('filtre skills : valeur inconnue jamais matchable (même identique côté candidat)', () => {
  const unknown = 'CompétenceInconnueXYZ';
  assert.equal(
    candidateMatchesSkills({ skills: [unknown] }, [unknown]),
    false,
    'dedicated unknown identique',
  );
  assert.equal(
    candidateMatchesSkills({
      axes: { meta: { competences: { Divers: [unknown] } } },
    }, [unknown]),
    false,
    'legacy unknown identique',
  );
  assert.equal(
    candidateMatchesSkills({ skills: ['Négociation'] }, ['Négociation', unknown]),
    true,
    'canonical + unknown ⇒ MATCH via canonical',
  );
  assert.equal(
    candidateMatchesSkills({ skills: ['Négociation'] }, [unknown, 'AutreInconnue']),
    false,
    'uniquement unknown ⇒ 0 match (≠ absence de filtre)',
  );
  assert.equal(
    candidateMatchesSkills({ skills: ['Négociation'] }, []),
    true,
    'liste vide = pas de filtre skills',
  );
});

test('migration skills additive sans backfill destructif', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'candidats_skills_migration.sql'), 'utf8');
  assert.match(sql, /add column if not exists skills text\[\]/i);
  assert.match(sql, /using gin \(skills\)/i);
  assert.doesNotMatch(sql, /drop column|truncate|delete from/i);
  assert.doesNotMatch(sql, /update\s+public\.candidats/i);
  assert.doesNotMatch(sql, /score_adn|deep_adn/i);
});

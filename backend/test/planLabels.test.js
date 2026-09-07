const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { candidatePlanLabel, isKnownCandidatePlan } = require('../utils/planLabels');

test('les slugs candidat ont un libellé commercial', () => {
  assert.equal(candidatePlanLabel('freemium'), 'Compte candidat');
  assert.equal(candidatePlanLabel('carriere'), 'Carrière');
  assert.equal(candidatePlanLabel('carriere_coaching'), 'Carrière Coaching');
});

test('un plan inconnu ne révèle pas son slug', () => {
  assert.equal(candidatePlanLabel('internal_experiment_42'), 'Abonnement candidat');
  assert.equal(isKnownCandidatePlan('internal_experiment_42'), false);
});

test('l’interface abonnement n’affiche pas directement le slug reçu', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../frontend/_spaces/candidat.html'), 'utf8');
  assert.doesNotMatch(html, /statusEl\.textContent\s*=\s*`Plan \$\{plan\}/);
  assert.match(html, /a\?\.plan_label \|\| 'Abonnement candidat'/);
});

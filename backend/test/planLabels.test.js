const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { candidatePlanLabel, isKnownCandidatePlan, recruiterPlanLabel, isKnownRecruiterPlan, subscriptionPlanLabel } = require('../utils/planLabels');

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

test('les slugs recruteur ont un libellé commercial (jamais Abonnement candidat)', () => {
  assert.equal(recruiterPlanLabel('enterprise'), 'Plan Enterprise');
  assert.equal(recruiterPlanLabel('solo'), 'Plan Entrepreneur');
  assert.equal(recruiterPlanLabel('starter'), 'Plan Starter');
  assert.equal(recruiterPlanLabel('pro'), 'Plan Pro');
  assert.equal(isKnownRecruiterPlan('enterprise'), true);
  assert.equal(subscriptionPlanLabel('enterprise'), 'Plan Enterprise');
  assert.equal(subscriptionPlanLabel('carriere'), 'Carrière');
  assert.doesNotMatch(subscriptionPlanLabel('enterprise'), /candidat/i);
  assert.doesNotMatch(recruiterPlanLabel('unknown_recruiter_plan'), /candidat/i);
});

test('GET /abonnements/current utilise subscriptionPlanLabel (rôle-aware via slug)', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'abonnements.js'), 'utf8');
  assert.match(source, /subscriptionPlanLabel/);
  assert.doesNotMatch(source, /plan_label:\s*candidatePlanLabel/);
});

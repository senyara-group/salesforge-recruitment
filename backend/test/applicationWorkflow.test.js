const test = require('node:test');
const assert = require('node:assert/strict');
const { assertTransition, canWithdraw, buildCandidateSnapshot } = require('../utils/applicationWorkflow');

test('le pipeline accepte uniquement les transitions explicites', () => {
  assert.doesNotThrow(() => assertTransition('envoyee', 'vu'));
  assert.doesNotThrow(() => assertTransition('entretien', 'offre'));
  assert.throws(() => assertTransition('envoyee', 'embauche'), (error) => error.status === 409);
  assert.throws(() => assertTransition('refusee', 'contacte'));
});

test('une candidature peut être retirée uniquement avant contact', () => {
  assert.equal(canWithdraw('envoyee'), true);
  assert.equal(canWithdraw('vu'), true);
  assert.equal(canWithdraw('contacte'), false);
  assert.equal(canWithdraw('entretien'), false);
});

test('le snapshot ne contient que les informations professionnelles prévues', () => {
  const snapshot = buildCandidateSnapshot({ prenom: 'Ada', nom: 'L', titre: 'AE', score_adn: 80, axes: { meta: { ville: 'Lyon' } } }, {});
  assert.equal(snapshot.profile.titre, 'AE');
  assert.equal(snapshot.profile.ville, 'Lyon');
  assert.equal(snapshot.cv, null);
  assert.equal(Object.hasOwn(snapshot.profile, 'email'), false);
});

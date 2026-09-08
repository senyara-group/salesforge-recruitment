const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_COACH_HISTORY_MAX_CHARS,
  coachHistoryMaxChars,
  selectCoachHistory,
} = require('../utils/coachContext');

test('historique Coach conserve la fenêtre récente sans dépasser la borne', () => {
  const newestFirst = [
    { role: 'user', content: 'courant' },
    { role: 'assistant', content: 'récent-1234' },
    { role: 'user', content: 'ancien-1234' },
  ];

  assert.deepEqual(selectCoachHistory(newestFirst, 18), [
    { role: 'assistant', content: 'récent-1234' },
    { role: 'user', content: 'courant' },
  ]);
});

test('historique Coach ne tronque jamais le message utilisateur courant', () => {
  const current = 'x'.repeat(5000);
  assert.deepEqual(selectCoachHistory([
    { role: 'user', content: current },
    { role: 'assistant', content: 'ancien' },
  ], 4000), [{ role: 'user', content: current }]);
});

test('message courant est conservé même en cas d’ordre identique en base', () => {
  assert.deepEqual(selectCoachHistory([
    { role: 'assistant', content: 'réponse au tour précédent' },
    { role: 'user', content: 'message courant' },
    { role: 'user', content: 'ancien message' },
  ], 16, 'message courant'), [{ role: 'user', content: 'message courant' }]);
});

test('borne Coach est centralisée et rejette une configuration trop basse', () => {
  const previous = process.env.AI_COACH_HISTORY_MAX_CHARS;
  process.env.AI_COACH_HISTORY_MAX_CHARS = '12000';
  assert.equal(coachHistoryMaxChars(), 12000);
  process.env.AI_COACH_HISTORY_MAX_CHARS = '100';
  assert.equal(coachHistoryMaxChars(), DEFAULT_COACH_HISTORY_MAX_CHARS);
  if (previous === undefined) delete process.env.AI_COACH_HISTORY_MAX_CHARS;
  else process.env.AI_COACH_HISTORY_MAX_CHARS = previous;
});

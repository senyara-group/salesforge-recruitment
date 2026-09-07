const test = require('node:test');
const assert = require('node:assert/strict');
const { finalizeCvReplacement } = require('../utils/cvReplacement');

test('le remplacement supprime l’ancien CV seulement après la mise à jour du profil', async () => {
  const events = ['upload:new'];
  const profile = await finalizeCvReplacement({
    updateProfile: async () => { events.push('profile:update'); return { id: 'candidate-a' }; },
    removeFile: async (file) => { events.push(`remove:${file.path}`); },
    newFile: { bucket: 'cvs', path: 'user-a/new.pdf' },
    previousFile: { bucket: 'cvs', path: 'user-a/old.pdf' },
  });
  assert.deepEqual(profile, { id: 'candidate-a' });
  assert.deepEqual(events, ['upload:new', 'profile:update', 'remove:user-a/old.pdf']);
});

test('un échec profil nettoie le nouveau CV et conserve l’ancien', async () => {
  const events = ['upload:new'];
  await assert.rejects(() => finalizeCvReplacement({
    updateProfile: async () => { events.push('profile:update'); throw new Error('db failed'); },
    removeFile: async (file) => { events.push(`remove:${file.path}`); },
    newFile: { bucket: 'cvs', path: 'user-a/new.pdf' },
    previousFile: { bucket: 'cvs', path: 'user-a/old.pdf' },
  }), /db failed/);
  assert.deepEqual(events, ['upload:new', 'profile:update', 'remove:user-a/new.pdf']);
  assert.equal(events.includes('remove:user-a/old.pdf'), false);
});

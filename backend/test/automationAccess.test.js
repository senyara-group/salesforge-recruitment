const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const path = require('node:path');
const backend = path.resolve(__dirname, '..');
const calls = [];
let candidateExists = true;
let expired = false;
let storedActivity = null;
const fakeDb = {
  from(table) {
    const query = { select: () => query, eq: (key, value) => { calls.push({ table, key, value }); return query; },
      upsert: async (row) => { calls.push({ table, upsert: row }); storedActivity = row.last_active_at; return {}; },
      maybeSingle: async () => ({ data: table === 'automation_activity' ? storedActivity && { last_active_at: storedActivity }
        : table === 'candidats' ? candidateExists ? { id: 'c1' } : null
          : { id: 'o1', statut: 'active', expires_at: expired ? '2020-01-01T00:00:00Z' : null } }) };
    return query;
  },
  rpc: async (name, args) => { calls.push({ name, args }); return {}; },
};
function mock(file, exports) {
  const filename = require.resolve(path.join(backend, file));
  require.cache[filename] = { filename, id: filename, loaded: true, exports };
}
mock('supabase', fakeDb);
mock('middleware/auth', (req, res, next) => {
  if (!req.headers.authorization) return res.sendStatus(401);
  req.user = { id: 'authenticated-owner' }; next();
});
const app = express(); app.use(express.json()); app.use('/automation', require('../routes/automation'));
app.use((_error, _req, res, _next) => res.sendStatus(500));

test('tracking verifies session, candidate role and offer availability; client cannot pick recipient', async () => {
  const server = app.listen(0);
  const url = `http://127.0.0.1:${server.address().port}/automation/offers/11111111-1111-4111-8111-111111111111/viewed`;
  const send = (authorized = true) => fetch(url, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(authorized ? { Authorization: 'Bearer test' } : {}) },
    body: JSON.stringify({ user_id: 'victim', email: 'victim@example.test', score: 100 }) });
  try {
    process.env.BREVO_OUTBOX_ENABLED = 'true';
    assert.equal((await send(false)).status, 401);
    assert.equal((await send()).status, 204);
    const call = calls.find((c) => c.name === 'record_offer_interaction');
    assert.deepEqual(call.args, { p_user_id: 'authenticated-owner', p_offre_id: '11111111-1111-4111-8111-111111111111', p_kind: 'viewed' });
    calls.length = 0; candidateExists = false;
    assert.equal((await send()).status, 403);
    assert.ok(!calls.some((c) => c.name));
    candidateExists = true; expired = true;
    assert.equal((await send()).status, 404);
    assert.ok(!calls.some((c) => c.name));
    process.env.BREVO_OUTBOX_ENABLED = 'false';
    assert.equal((await send()).status, 503);
  } finally { delete process.env.BREVO_OUTBOX_ENABLED; await new Promise((resolve) => server.close(resolve)); }
});

test('activity pings are stored for the session owner at most once per hour', async () => {
  const server = app.listen(0);
  const ping = () => fetch(`http://127.0.0.1:${server.address().port}/automation/activity`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' }, body: JSON.stringify({ user_id: 'victim' }) });
  try {
    process.env.BREVO_OUTBOX_ENABLED = 'true';
    calls.length = 0; storedActivity = null;
    assert.equal((await ping()).status, 204);
    assert.equal((await ping()).status, 204);
    const writes = calls.filter((c) => c.upsert);
    assert.equal(writes.length, 1, 'second ping within the hour does not queue another contact update');
    assert.equal(writes[0].upsert.user_id, 'authenticated-owner');
    storedActivity = new Date(Date.now() - 2 * 3600000).toISOString();
    assert.equal((await ping()).status, 204);
    assert.equal(calls.filter((c) => c.upsert).length, 2, 'a return after a pause is recorded');
  } finally { delete process.env.BREVO_OUTBOX_ENABLED; await new Promise((resolve) => server.close(resolve)); }
});

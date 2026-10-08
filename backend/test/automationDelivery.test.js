const test = require('node:test');
const assert = require('node:assert/strict');
const { prepareDelivery } = require('../utils/automationDelivery');
const now = Date.parse('2026-10-08T12:00:00Z');
function fixture() {
  const tables = { automation_preferences: [{ user_id: 'u1', marketing_enabled: true }],
    candidats: [{ id: 'c1', user_id: 'u1', prenom: 'Own', axes: { closing: 92 } }],
    offres: [{ id: 'o1', recruteur_id: 'r1', statut: 'active' }],
    recruteurs: [{ id: 'r1', user_id: 'u2', matching: { closing: 100 } }],
    candidatures: [], abonnements: [], automation_activity: [], matchs: [], messages: [] };
  const db = { auth: { admin: { getUserById: async () => ({ data: { user: { user_metadata: {} } } }) } },
    from(table) {
      let rows = tables[table] || []; const ordering = [];
      const query = { select: () => query, eq: (key, value) => { rows = rows.filter((r) => r[key] === value); return query; },
        order: (key) => { ordering.push(key); return query; }, limit: (n) => { rows = rows.slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, n); return query; },
        maybeSingle: async () => ({ data: rows[0] || null }), then: (resolve) => resolve({ data: rows }) };
      return query;
    } };
  return { tables, db };
}
test('delivery rechecks opt-out, completed profile, submitted application and returned user', async () => {
  let f = fixture(); f.tables.automation_preferences[0].marketing_enabled = false;
  assert.equal((await prepareDelivery(f.db, { user_id: 'u1', event_name: 'profile_incomplete', properties: {} }, now)).allowed, false);
  f = fixture(); Object.assign(f.tables.candidats[0], { prenom: 'A', nom: 'B', score_adn: 90, skills: ['sales'],
    axes: { meta: { avatar_path: 'a', ville: 'Paris', cv_path: 'c', motivation_path: 'm' } } });
  assert.equal((await prepareDelivery(f.db, { user_id: 'u1', event_name: 'profile_incomplete', properties: {} }, now)).allowed, false);
  f = fixture(); f.tables.candidatures.push({ candidat_id: 'c1', offre_id: 'o1', lettre_type: 'candidate_like' });
  assert.equal((await prepareDelivery(f.db, { user_id: 'u1', event_name: 'application_abandoned', properties: { offre_id: 'o1' } }, now)).allowed, false);
  f = fixture(); f.tables.automation_activity.push({ user_id: 'u1', last_active_at: new Date(now - 1000).toISOString() });
  assert.equal((await prepareDelivery(f.db, { user_id: 'u1', event_name: 'user_inactive', properties: { days: 7 } }, now)).allowed, false);
});
test('late closed recommendations are removed before emitting the event', async () => {
  const f = fixture(); f.tables.offres[0].statut = 'closed';
  const result = await prepareDelivery(f.db, { user_id: 'u1', event_name: 'weekly_recommendations', properties: { nb: 1, offres: [{ offre_id: 'o1', score: 92 }] } }, now);
  assert.equal(result.allowed, false);
});
test('recruiter emails reveal only the submitted snapshot, never live passive identity', async () => {
  const f = fixture();
  f.tables.candidats[0].nom = 'PRIVATE LIVE';
  f.tables.candidatures.push({ candidat_id: 'c1', offre_id: 'o1', lettre_type: 'candidate_like', snapshot: { profile: { prenom: 'Submitted', nom: 'Snapshot' } } });
  const row = { user_id: 'u2', event_name: 'application_received', properties: { offre_id: 'o1', candidat_id: 'c1' } };
  const result = await prepareDelivery(f.db, row, now);
  assert.equal(result.properties.candidat, 'Submitted Snapshot');
  assert.ok(!JSON.stringify(result.properties).includes('PRIVATE LIVE'));
  f.tables.candidatures[0].lettre_type = 'recruteur_like';
  assert.equal((await prepareDelivery(f.db, row, now)).properties.candidat, 'Candidat anonyme');
});

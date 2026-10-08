const test = require('node:test');
const assert = require('node:assert/strict');
const { prepareDelivery } = require('../utils/automationDelivery');
const now = Date.parse('2026-10-08T12:00:00Z');
function fixture() {
  const tables = { users: [{ id: 'u1', role: 'candidat' }, { id: 'u2', role: 'recruteur' }], automation_preferences: [{ user_id: 'u1', marketing_enabled: true }],
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
test('contact role comes from the account, and passed or swiped offers cancel view reminders', async () => {
  let f = fixture(); f.tables.candidats = [];
  const result = await prepareDelivery(f.db, { user_id: 'u1', event_name: 'signup_completed', properties: {} }, now);
  assert.equal(result.contact.ROLE, 'CANDIDAT', 'a candidate without profile row is not labelled recruiter');
  f = fixture(); f.tables.candidats[0].swipes_meta = { passed_offer_ids: ['o1'] };
  assert.equal((await prepareDelivery(f.db, { user_id: 'u1', event_name: 'offer_viewed_without_application', properties: { offre_id: 'o1' } }, now)).allowed, false);
  f = fixture(); f.tables.users = [];
  assert.equal((await prepareDelivery(f.db, { user_id: 'u1', event_name: 'message_received', properties: {} }, now)).reason, 'recipient removed');
});
test('unanswered recruiter messages survive the application that created the match, with offer context', async () => {
  const f = fixture();
  Object.assign(f.tables.recruteurs[0], { entreprise: 'Acme' }); Object.assign(f.tables.offres[0], { titre: 'Account Executive' });
  f.tables.matchs.push({ id: 'm1', candidat_id: 'c1', offre_id: 'o1' });
  f.tables.candidatures.push({ candidat_id: 'c1', offre_id: 'o1', lettre_type: 'candidate_like', statut: 'vu' });
  f.tables.messages.push({ id: 'msg1', match_id: 'm1', created_at: '2026-10-05T10:00:00Z' });
  const row = { user_id: 'u1', event_name: 'recruiter_message_unanswered', properties: { conversation_id: 'm1', message_id: 'msg1' } };
  const result = await prepareDelivery(f.db, row, now);
  assert.equal(result.allowed, true, result.reason);
  assert.deepEqual([result.properties.poste, result.properties.entreprise], ['Account Executive', 'Acme']);
  f.tables.candidatures[0].statut = 'refusee';
  assert.equal((await prepareDelivery(f.db, row, now)).reason, 'application closed');
});
test('application_abandoned is rechecked at send time with the same definition', async () => {
  const send = async (mutate) => {
    const f = fixture(); mutate(f);
    return (await prepareDelivery(f.db, { user_id: 'u1', event_name: 'application_abandoned', properties: { offre_id: 'o1' } }, now)).allowed;
  };
  assert.equal(await send((f) => { f.tables.candidats[0].swipes_meta = { liked_offer_ids: ['o1'] }; }), true, 'failed send after the like');
  assert.equal(await send(() => {}), true, 'interrupted send');
  assert.equal(await send((f) => { f.tables.candidatures.push({ candidat_id: 'c1', offre_id: 'o1', lettre_type: 'candidate_like', statut: 'envoyee' }); }), false, 'sent');
  assert.equal(await send((f) => { f.tables.candidatures.push({ candidat_id: 'c1', offre_id: 'o1', lettre_type: 'prioritaire', statut: 'retiree' }); }), false, 'withdrawn');
  assert.equal(await send((f) => {
    f.tables.candidatures.push({ candidat_id: 'c1', offre_id: 'o1', lettre_type: 'recruteur_like', statut: 'nouveau' });
    f.tables.candidats[0].swipes_meta = { liked_offer_ids: ['o1'] };
  }), false, 'historical recruiter row + like');
  assert.equal(await send((f) => { f.tables.candidats[0].swipes_meta = { passed_offer_ids: ['o1'] }; }), false, 'passed');
});

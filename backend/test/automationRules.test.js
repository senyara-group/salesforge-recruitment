const test = require('node:test');
const assert = require('node:assert/strict');
const { DAY, profileCompletion, recommendationScore, buildScheduledEvents } = require('../utils/automationRules');
const now = Date.parse('2026-10-08T12:00:00Z');
const date = (days) => new Date(now - days * DAY).toISOString();
function fixture() {
  return { candidates: [{ id: 'c1', user_id: 'u1', created_at: date(3), axes: { resultat: { axes: [{ l: 'Closing', v: 92 }] } } }],
    recruiters: [{ id: 'r1', user_id: 'u2', entreprise: 'Company', matching: { closing: 100 } }],
    offers: [{ id: 'o1', recruteur_id: 'r1', titre: 'Poste', created_at: date(1), statut: 'active', expires_at: new Date(now + 2 * DAY).toISOString() }],
    preferences: [{ user_id: 'u1', marketing_enabled: true }, { user_id: 'u2', marketing_enabled: true }],
    applications: [], activities: [{ user_id: 'u1', last_active_at: date(15) }],
    interactions: [{ user_id: 'u1', offre_id: 'o1', viewed_at: date(2), saved_at: date(2) }], messages: [], matches: [] };
}
test('compatibility requires measurable criteria and honors declared job/sector/contract choices', () => {
  assert.equal(recommendationScore({ axes: {} }, {}, { matching: { closing: 100 } }), null);
  assert.equal(recommendationScore({ axes: { closing: 92 } }, {}, { matching: {} }), null);
  assert.equal(recommendationScore({ axes: { closing: 92 }, desired_contracts: ['CDI'] }, { type: 'CDD' }, { matching: { closing: 100 } }), null);
  assert.equal(recommendationScore(fixture().candidates[0], {}, fixture().recruiters[0]), 92);
});
test('completion uses the seven visible checklist items', () => {
  assert.equal(profileCompletion({}), 0);
  assert.equal(profileCompletion({ prenom: 'A', nom: 'B', score_adn: 90, skills: ['sales'], axes: { meta: { avatar_path: 'a', ville: 'Paris', cv_path: 'c', motivation_path: 'm' } } }), 100);
});
test('scheduled events carry real scores, deterministic keys and no passive identity', () => {
  const data = fixture(); data.candidates[0].prenom = 'PRIVATE'; data.candidates[0].nom = 'IDENTITY';
  const events = buildScheduledEvents(data, now, now - 20 * DAY);
  assert.ok(events.some((e) => e.event_name === 'compatible_offer_found' && e.properties.score === 92));
  assert.ok(events.some((e) => e.event_name === 'user_inactive' && e.properties.days === 14 && e.properties.nb === 1));
  assert.ok(events.some((e) => e.event_name === 'offer_viewed_without_application'));
  assert.ok(events.some((e) => e.event_name === 'saved_offer_expiring'));
  const recruiter = events.filter((e) => e.user_id === 'u2');
  assert.ok(recruiter.some((e) => e.event_name === 'compatible_candidates_found'));
  assert.ok(!JSON.stringify(recruiter).includes('PRIVATE'));
  assert.deepEqual(events, buildScheduledEvents(data, now, now - 20 * DAY));
});
test('closed, expired, applied, declined and opted-out offers/users cannot receive reminders', () => {
  for (const mutation of [
    (s) => { s.offers[0].statut = 'closed'; },
    (s) => { s.offers[0].expires_at = date(1); },
    (s) => { s.applications.push({ candidat_id: 'c1', offre_id: 'o1', lettre_type: 'candidate_like' }); },
    (s) => { s.interactions[0].dismissed_at = date(1); s.candidates[0].swipes_meta = { passed_offer_ids: ['o1'] }; },
  ]) {
    const data = fixture(); mutation(data);
    const events = buildScheduledEvents(data, now, now - 20 * DAY);
    assert.ok(!events.some((e) => ['offer_viewed_without_application', 'application_abandoned', 'saved_offer_expiring'].includes(e.event_name)));
  }
  const data = fixture(); data.preferences = [];
  assert.deepEqual(buildScheduledEvents(data, now, now - 20 * DAY), []);
});
test('abandoned attempts replace view reminders and successful applications cancel them', () => {
  const data = fixture(); data.interactions[0].application_started_at = date(2);
  const events = buildScheduledEvents(data, now, now - 20 * DAY);
  assert.ok(events.some((e) => e.event_name === 'application_abandoned'));
  assert.ok(!events.some((e) => e.event_name === 'offer_viewed_without_application'));
});
test('reply and terminal applications suppress unanswered recruiter messages', () => {
  const data = fixture(); data.matches = [{ id: 'm1', candidat_id: 'c1', offre_id: 'o1' }];
  data.messages = [{ id: 'msg1', match_id: 'm1', sender_id: 'u2', receiver_id: 'u1', created_at: date(3) }];
  assert.ok(buildScheduledEvents(data, now, now - 20 * DAY).some((e) => e.event_name === 'recruiter_message_unanswered'));
  data.messages.push({ id: 'msg2', match_id: 'm1', sender_id: 'u1', receiver_id: 'u2', created_at: date(1) });
  assert.ok(!buildScheduledEvents(data, now, now - 20 * DAY).some((e) => e.event_name === 'recruiter_message_unanswered'));
});
test('reminders respect signup grace, the 48h new-offer window, installation date and completed swipes', () => {
  let data = fixture(); data.candidates[0].created_at = new Date(now - 3600000).toISOString();
  assert.ok(!buildScheduledEvents(data, now, now - 20 * DAY).some((e) => e.event_name === 'profile_incomplete'));
  data = fixture();
  assert.ok(buildScheduledEvents(data, now, now - 20 * DAY).some((e) => e.event_name === 'profile_incomplete'));
  data.offers[0].created_at = date(5);
  const late = buildScheduledEvents(data, now, now - 20 * DAY);
  assert.ok(!late.some((e) => e.event_name === 'compatible_offer_found'), 'an opt-in does not replay old offers one by one');
  assert.ok(late.some((e) => e.event_name === 'weekly_recommendations'), 'older offers still feed the weekly digest');
  data = fixture(); data.interactions[0].application_started_at = date(2);
  data.candidates[0].swipes_meta = { liked_offer_ids: ['o1'] };
  assert.ok(!buildScheduledEvents(data, now, now - 20 * DAY).some((e) => e.event_name === 'application_abandoned'));
  data = fixture(); data.matches = [{ id: 'm1', candidat_id: 'c1', offre_id: 'o1' }];
  data.messages = [{ id: 'msg1', match_id: 'm1', sender_id: 'u2', receiver_id: 'u1', created_at: date(3) }];
  assert.ok(!buildScheduledEvents(data, now, now - 1 * DAY).some((e) => e.event_name === 'recruiter_message_unanswered'),
    'messages sent before installation are not historical reminders');
});
test('inactivity sends only the highest reached milestone once per inactivity period', () => {
  const data = fixture(); data.activities = [{ user_id: 'u1', last_active_at: date(40) }];
  const inactive = buildScheduledEvents(data, now, now - 60 * DAY).filter((e) => e.event_name === 'user_inactive');
  assert.deepEqual(inactive.map((e) => e.properties.days), [30]);
});

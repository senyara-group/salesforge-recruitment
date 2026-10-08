const { buildScheduledEvents } = require('./automationRules');

async function readAll(db, table, fields) {
  const rows = [];
  for (let offset = 0; ; offset += 500) {
    let query = db.from(table).select(fields).order(['automation_preferences', 'automation_activity', 'offer_interactions'].includes(table) ? 'user_id' : 'id');
    if (table === 'offer_interactions') query = query.order('offre_id');
    const result = await query.range(offset, offset + 499);
    if (result.error) throw result.error;
    rows.push(...result.data);
    if (result.data.length < 500) return rows;
  }
}

async function runScheduler(db, now = Date.now()) {
  const expired = await db.from('offres').update({ statut: 'closed' }).eq('statut', 'active').lte('expires_at', new Date(now).toISOString());
  if (expired.error) throw expired.error;
  const installed = await db.from('automation_installation').select('started_at').eq('id', 1).single();
  if (installed.error) throw installed.error;
  const specs = {
    candidates: ['candidats', 'id,user_id,created_at,automation_changed_at,prenom,nom,score_adn,axes,skills,target_job_types,sectors,desired_contracts,swipes_meta'],
    recruiters: ['recruteurs', 'id,user_id,entreprise,matching'],
    offers: ['offres', 'id,recruteur_id,titre,statut,expires_at,created_at,job_type,sector,contract_type,type'],
    preferences: ['automation_preferences', 'user_id,marketing_enabled'],
    activities: ['automation_activity', 'user_id,last_active_at'],
    applications: ['candidatures', 'id,candidat_id,offre_id,lettre_type,statut'],
    interactions: ['offer_interactions', 'user_id,offre_id,viewed_at,application_started_at,saved_at,dismissed_at'],
    messages: ['messages', 'id,match_id,sender_id,receiver_id,created_at'],
    matches: ['matchs', 'id,candidat_id,offre_id'],
  };
  const entries = await Promise.all(Object.entries(specs).map(async ([name, spec]) => [name, await readAll(db, ...spec)]));
  const events = buildScheduledEvents(Object.fromEntries(entries), now, Date.parse(installed.data.started_at));
  for (const event of events.filter((e) => e.event_name === 'compatible_candidates_found')) {
    for (let offset = 0; offset < event.properties.candidats.length; offset += 100) {
      const result = await db.rpc('enqueue_candidate_discoveries', {
        p_offre_id: event.properties.offre_id, p_candidates: event.properties.candidats.slice(offset, offset + 100),
      });
      if (result.error) throw result.error;
    }
  }
  const regular = events.filter((e) => e.event_name !== 'compatible_candidates_found');
  for (let offset = 0; offset < regular.length; offset += 100) {
    const { error } = await db.from('brevo_outbox').upsert(regular.slice(offset, offset + 100), { onConflict: 'dedupe_key', ignoreDuplicates: true });
    if (error) throw error;
  }
  return { scheduled: events.length };
}
module.exports = { readAll, runScheduler };

const { DAY, profileCompletion, isOpenOffer, recommendationScore } = require('./automationRules');
const MARKETING_EVENTS = new Set(['profile_incomplete', 'compatible_offer_found', 'offer_viewed_without_application',
  'application_abandoned', 'weekly_recommendations', 'user_inactive', 'compatible_candidates_found',
  'offer_expiring', 'saved_offer_expiring', 'recruiter_message_unanswered']);
// Reminders about an offer itself: dropped once the offer closes, or the candidate applied,
// swiped or dismissed it. A conversation reminder is not one (its candidate usually applied).
const OFFER_REMINDERS = new Set(['compatible_offer_found', 'offer_viewed_without_application', 'application_abandoned',
  'offer_expiring', 'saved_offer_expiring', 'compatible_candidates_found']);

async function single(query) {
  const result = await query.maybeSingle();
  if (result.error) throw result.error;
  return result.data;
}

async function prepareDelivery(db, row, now) {
  const account = row.user_id
    ? await single(db.from('users').select('id,role').eq('id', row.user_id))
    : row.email ? await single(db.from('users').select('id,role').eq('email', row.email)) : null;
  const userId = account?.id;
  if (!userId) return { allowed: false, reason: 'recipient removed' };
  const preference = await single(db.from('automation_preferences').select('marketing_enabled').eq('user_id', userId));
  const contact = { ...row.contact_properties, AUTOMATION_MARKETING_ALLOWED: preference?.marketing_enabled === true };
  const properties = { ...row.properties };
  if (MARKETING_EVENTS.has(row.event_name) && preference?.marketing_enabled !== true) return { allowed: false, reason: 'marketing disabled' };
  const activityState = await single(db.from('automation_activity').select('last_active_at').eq('user_id', userId));
  if (activityState) contact.DERNIERE_ACTIVITE = activityState.last_active_at;
  const candidate = await single(db.from('candidats').select('id,prenom,nom,axes,score_adn,skills,target_job_types,sectors,desired_contracts,swipes_meta').eq('user_id', userId));
  if (candidate) {
    contact.PRENOM = candidate.prenom || '';
    contact.NOM = candidate.nom || '';
    contact.PROFIL_COMPLETION = profileCompletion(candidate);
    contact.SCORE_ADN = candidate.score_adn ?? 0;
    contact.TEST_ADN_TERMINE = candidate.score_adn != null;
    properties.prenom = candidate.prenom || '';
    if (row.event_name === 'profile_updated' || row.event_name === 'profile_incomplete') properties.completion = contact.PROFIL_COMPLETION;
    if (row.event_name === 'profile_incomplete' && contact.PROFIL_COMPLETION === 100) return { allowed: false, reason: 'profile complete' };
  } else {
    const identity = await db.auth.admin.getUserById(userId);
    if (identity.error) throw identity.error;
    const metadata = identity.data?.user?.user_metadata || {};
    if (metadata.prenom) {
      properties.prenom = metadata.prenom;
      contact.PRENOM = metadata.prenom;
    }
    if (metadata.nom) {
      contact.NOM = metadata.nom;
    }
  }
  // users.role is the account role even before the candidate/recruiter row exists.
  contact.ROLE = account.role ? (String(account.role).startsWith('recruteur') ? 'RECRUTEUR' : 'CANDIDAT')
    : candidate ? 'CANDIDAT' : 'RECRUTEUR';
  if (row.event_name === 'offer_published') contact.OFFRE_PUBLIEE = true;
  const subscription = await single(db.from('abonnements').select('plan,statut,periode,resiliation_programmee,date_fin').eq('user_id', userId));
  if (subscription) {
    const plans = { freemium: 'GRATUIT', carriere: 'CARRIERE', carriere_coaching: 'COACHING', solo: 'ENTREPRENEUR', starter: 'STARTER', pro: 'PRO', enterprise: 'ENTERPRISE' };
    contact.PLAN = plans[subscription.plan] || String(subscription.plan || '').toUpperCase();
    contact.FACTURATION = subscription.periode === 'year' ? 'ANNUEL' : 'MENSUEL';
    contact.STATUT_ABO = subscription.resiliation_programmee ? 'RESILIATION_PROGRAMMEE'
      : subscription.plan === 'freemium' ? 'AUCUN' : subscription.statut === 'actif' ? 'ACTIF' : 'IMPAYE';
    // Legacy attributes remain available during the transition.
    contact.ABONNEMENT_PLAN = subscription.plan;
    contact.ABONNEMENT_STATUT = subscription.statut;
    contact.ABONNEMENT_DATE_FIN = subscription.date_fin || '';
  }
  if (properties.conversation_id && !properties.offre_id) {
    const match = await single(db.from('matchs').select('offre_id,candidat_id').eq('id', properties.conversation_id));
    if (match) { properties.offre_id = match.offre_id; properties.candidat_id = match.candidat_id; }
  }
  if (properties.application_id) {
    const application = await single(db.from('candidatures').select('candidat_id').eq('id', properties.application_id));
    if (application) properties.candidat_id = application.candidat_id;
  }
  if (properties.offre_id && (!MARKETING_EVENTS.has(row.event_name) || row.event_name === 'recruiter_message_unanswered')) {
    const offer = await single(db.from('offres').select('id,titre,recruteur_id,job_type,sector,contract_type,type').eq('id', properties.offre_id));
    if (offer) {
      const recruiter = await single(db.from('recruteurs').select('user_id,entreprise,matching').eq('id', offer.recruteur_id));
      properties.poste = offer.titre;
      properties.entreprise = recruiter?.entreprise || '';
      if (properties.candidat_id) {
        const profile = await single(db.from('candidats').select('id,axes,target_job_types,sectors,desired_contracts').eq('id', properties.candidat_id));
        if (profile) {
          const score = recommendationScore(profile, offer, recruiter);
          if (score != null) properties.score = score;
          if (recruiter?.user_id === userId) {
            // Only the voluntarily submitted immutable snapshot can reveal identity.
            const application = await single(db.from('candidatures').select('snapshot,lettre_type').eq('candidat_id', profile.id).eq('offre_id', offer.id));
            properties.candidat = application && application.lettre_type !== 'recruteur_like'
              ? [application.snapshot?.profile?.prenom, application.snapshot?.profile?.nom].filter(Boolean).join(' ') || 'Un candidat' : 'Candidat anonyme';
          }
        }
      }
    }
  }
  if (OFFER_REMINDERS.has(row.event_name) && properties.offre_id) {
    const offer = await single(db.from('offres').select('id,statut,expires_at,recruteur_id,job_type,sector,contract_type,type').eq('id', properties.offre_id));
    if (!offer || !isOpenOffer(offer, now)) return { allowed: false, reason: 'offer unavailable' };
    if (['offer_expiring', 'saved_offer_expiring'].includes(row.event_name) && offer.expires_at !== properties.date_fin) return { allowed: false, reason: 'expiration changed' };
    if (candidate) {
      if (row.event_name === 'compatible_offer_found') {
        const recruiter = await single(db.from('recruteurs').select('matching').eq('id', offer.recruteur_id));
        const score = recommendationScore(candidate, offer, recruiter);
        if (score == null || score < 70) return { allowed: false, reason: 'compatibility changed' };
        properties.score = score;
      }
      const application = await single(db.from('candidatures').select('id,lettre_type').eq('candidat_id', candidate.id).eq('offre_id', properties.offre_id));
      if (application && application.lettre_type !== 'recruteur_like') return { allowed: false, reason: 'already applied' };
      const choices = candidate.swipes_meta || {};
      // Same rule as the scheduler: a like counts only with an existing (recruiter-side) row.
      if (application && (choices.liked_offer_ids || []).map(String).includes(String(properties.offre_id))) return { allowed: false, reason: 'already applied' };
      if ((choices.passed_offer_ids || []).map(String).includes(String(properties.offre_id))) return { allowed: false, reason: 'offer dismissed' };
      const interaction = await single(db.from('offer_interactions').select('dismissed_at,saved_at').eq('user_id', userId).eq('offre_id', properties.offre_id));
      if (interaction?.dismissed_at || (row.event_name === 'saved_offer_expiring' && !interaction?.saved_at)) return { allowed: false, reason: 'offer dismissed' };
    }
  }
  if (row.event_name === 'user_inactive') {
    const activity = activityState;
    if (!activity || now - Date.parse(activity.last_active_at) < properties.days * DAY) return { allowed: false, reason: 'user returned' };
  }
  if (candidate && Array.isArray(properties.offres)) {
    const available = [];
    for (const item of properties.offres) {
      const offer = await single(db.from('offres').select('id,titre,statut,expires_at,recruteur_id,created_at,job_type,sector,contract_type,type').eq('id', item.offre_id));
      if (!offer || !isOpenOffer(offer, now) || (candidate.swipes_meta?.passed_offer_ids || []).includes(offer.id)) continue;
      if (row.event_name === 'user_inactive' && Date.parse(offer.created_at) <= Date.parse(activityState.last_active_at)) continue;
      const application = await single(db.from('candidatures').select('id,lettre_type').eq('candidat_id', candidate.id).eq('offre_id', offer.id));
      if (application && application.lettre_type !== 'recruteur_like') continue;
      const recruiter = await single(db.from('recruteurs').select('matching,entreprise').eq('id', offer.recruteur_id));
      const score = recommendationScore(candidate, offer, recruiter);
      if (score != null && score >= 70) available.push({ offre_id: offer.id, poste: offer.titre, entreprise: recruiter?.entreprise || '', score });
    }
    properties.offres = available;
    properties.nb = available.length;
    if (row.event_name === 'weekly_recommendations' && !available.length) return { allowed: false, reason: 'no current recommendations' };
  }
  if (row.event_name === 'compatible_candidates_found') {
    const offer = await single(db.from('offres').select('id,recruteur_id,job_type,sector,contract_type,type').eq('id', properties.offre_id));
    const recruiter = offer && await single(db.from('recruteurs').select('user_id,matching').eq('id', offer.recruteur_id));
    if (recruiter?.user_id !== userId) return { allowed: false, reason: 'offer ownership changed' };
    const current = [];
    const ids = (properties.candidats || []).map((item) => item.candidat_id);
    if (!ids.length) return { allowed: false, reason: 'no candidates' };
    const profiles = await db.from('candidats').select('id,axes,target_job_types,sectors,desired_contracts').in('id', ids);
    if (profiles.error) throw profiles.error;
    const applications = await db.from('candidatures').select('candidat_id,lettre_type').eq('offre_id', offer.id).in('candidat_id', ids);
    if (applications.error) throw applications.error;
    const applied = new Set((applications.data || []).filter((a) => a.lettre_type !== 'recruteur_like').map((a) => a.candidat_id));
    for (const profile of profiles.data || []) {
      if (applied.has(profile.id)) continue;
      const score = recommendationScore(profile, offer, recruiter);
      if (score != null && score >= 70) current.push({ candidat_id: profile.id, score });
    }
    if (!current.length) return { allowed: false, reason: 'compatibility changed' };
    properties.candidats = current.slice(0, 20); properties.nb = current.length;
  }
  if (row.event_name === 'recruiter_message_unanswered') {
    const match = await single(db.from('matchs').select('candidat_id,offre_id').eq('id', properties.conversation_id));
    if (!match) return { allowed: false, reason: 'conversation removed' };
    const application = await single(db.from('candidatures').select('statut').eq('candidat_id', match.candidat_id).eq('offre_id', match.offre_id));
    if (application && ['refusee', 'retiree', 'embauche'].includes(application.statut)) return { allowed: false, reason: 'application closed' };
    const result = await db.from('messages').select('id').eq('match_id', properties.conversation_id)
      .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(1);
    if (result.error) throw result.error;
    if (result.data?.[0]?.id !== properties.message_id) return { allowed: false, reason: 'conversation advanced' };
  }
  return { allowed: true, contact, properties };
}

function templateFor(eventName, properties = {}) {
  const mapping = JSON.parse(process.env.BREVO_TRANSACTIONAL_TEMPLATES || '{}');
  const allowed = new Set(['application_submitted', 'application_status_changed', 'message_received',
    'application_received', 'payment_succeeded', 'payment_failed', 'subscription_started',
    'subscription_cancel_scheduled', 'subscription_ended', 'subscription_reactivated', 'plan_changed']);
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) throw new Error('Invalid transactional template configuration');
  for (const [key, value] of Object.entries(mapping)) {
    const [event, status, extra] = key.split(':');
    const validStatus = status === undefined || (event === 'application_status_changed'
      && ['envoyee', 'nouveau', 'vu', 'contacte', 'repondu', 'entretien', 'offre', 'embauche', 'refusee', 'retiree'].includes(status));
    if (!allowed.has(event) || !validStatus || extra !== undefined || !Number.isInteger(value) || value < 1) throw new Error('Invalid transactional template configuration');
  }
  const id = mapping[`${eventName}:${properties.statut || ''}`] ?? mapping[eventName];
  if (id === undefined) return null;
  return id;
}
module.exports = { MARKETING_EVENTS, prepareDelivery, templateFor };

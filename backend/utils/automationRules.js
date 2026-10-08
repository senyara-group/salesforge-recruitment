const { CONTRIBUTING_MATCHING_KEYS, findAxisValue, sanitizeMatchingWeight, compatibilityScore } = require('./recruiterMatching');
const identity = require('./jobSectorFilter');
const DAY = 86400000;
// Every reminder delay lives here, and only here. Brevo workflows must not add their own
// wait on these events: they arrive once the delay has elapsed.
const DELAYS = Object.freeze({
  signupGrace: DAY, // profile_incomplete: not before one day after signup
  reminderPeriod: 7 * DAY, // profile_incomplete, weekly_recommendations: once per week
  newOfferWindow: 2 * DAY, // compatible_offer_found: offers published less than 48h ago
  viewedReminder: DAY, // offer_viewed_without_application
  abandonedReminder: DAY, // application_abandoned
  unansweredMessage: 2 * DAY, // recruiter_message_unanswered
  messageLookback: 7 * DAY, // only recent conversations are scanned
  expiringWindow: 3 * DAY, // offer_expiring, saved_offer_expiring
  inactivityDays: Object.freeze([30, 14, 7]), // user_inactive milestones, highest first
});
const NEW_OFFER_WINDOW = DELAYS.newOfferWindow;
const MESSAGE_LOOKBACK = DELAYS.messageLookback;

function profileCompletion(profile) {
  const meta = profile.axes?.meta || {};
  const present = (v) => Boolean(String(v || '').trim());
  const checks = [present(meta.avatar_path), present(profile.prenom) && present(profile.nom), present(meta.ville),
    present(meta.cv_path) || present(meta.cv_file_name), present(meta.motivation_path) || present(meta.motivation_file_name),
    Boolean(profile.score_adn), (profile.skills || []).filter(Boolean).length > 0
      || Object.values(meta.competences || {}).flat().filter(Boolean).length > 0];
  return Math.round(checks.filter(Boolean).length / checks.length * 100);
}

function isOpenOffer(offer, now) {
  return (!offer.statut || offer.statut === 'active') && (!offer.expires_at || Date.parse(offer.expires_at) > now);
}

function recommendationScore(candidate, offer, recruiter) {
  if (candidate.target_job_types?.length && !identity.matches(offer.job_type, candidate.target_job_types, 'job')) return null;
  if (candidate.sectors?.length && !identity.matches(offer.sector, candidate.sectors, 'sector')) return null;
  if (candidate.desired_contracts?.length && !candidate.desired_contracts.includes(offer.contract_type || offer.type)) return null;
  const axes = candidate.axes?.resultat?.axes || candidate.axes || {};
  const matching = recruiter?.matching || {};
  // Do not use the historical 70% fallback as evidence of compatibility.
  const measurable = CONTRIBUTING_MATCHING_KEYS.some((key) => {
    const weight = sanitizeMatchingWeight(matching[key]);
    return weight != null && weight > 0 && findAxisValue(axes, key) != null;
  });
  return measurable ? compatibilityScore(axes, matching) : null;
}

function buildScheduledEvents(snapshot, now, installedAt) {
  const events = [];
  const opted = new Set(snapshot.preferences.filter((p) => p.marketing_enabled).map((p) => p.user_id));
  const recruiters = new Map(snapshot.recruiters.map((r) => [r.id, r]));
  const candidates = new Map(snapshot.candidates.map((c) => [c.user_id, c]));
  const activities = new Map(snapshot.activities.map((a) => [a.user_id, Date.parse(a.last_active_at)]));
  const offers = snapshot.offers.filter((o) => isOpenOffer(o, now));
  const offerMap = new Map(offers.map((o) => [o.id, o]));
  const applied = new Set(snapshot.applications.filter((a) => a.lettre_type !== 'recruteur_like').map((a) => `${a.candidat_id}:${a.offre_id}`));
  // A recorded right swipe is a completed attempt, even when no candidature row was
  // created (e.g. an older recruiter-side row already existed for this pair).
  for (const candidate of snapshot.candidates) {
    for (const id of candidate.swipes_meta?.liked_offer_ids || []) applied.add(`${candidate.id}:${id}`);
  }
  const week = Math.floor((now - installedAt) / DELAYS.reminderPeriod);
  const enqueue = (user, name, properties, key) => {
    if (opted.has(user)) events.push({ user_id: user, event_name: name, properties, dedupe_key: key });
  };
  for (const candidate of snapshot.candidates) {
    const completion = profileCompletion(candidate);
    // Leave a day after signup before the first "complete your profile" reminder.
    if (completion < 100 && now - Date.parse(candidate.created_at) >= DELAYS.signupGrace) enqueue(candidate.user_id, 'profile_incomplete', { completion }, `profile_incomplete:${candidate.id}:${week}`);
    const ranked = offers.filter((o) => !applied.has(`${candidate.id}:${o.id}`)
      && !(candidate.swipes_meta?.passed_offer_ids || []).includes(o.id)).map((o) => ({
        offre_id: o.id, poste: o.titre, entreprise: recruiters.get(o.recruteur_id)?.entreprise || '',
        score: recommendationScore(candidate, o, recruiters.get(o.recruteur_id)), created_at: o.created_at,
      })).filter((o) => o.score != null && o.score >= 70).sort((a, b) => b.score - a.score || a.offre_id.localeCompare(b.offre_id));
    for (const item of ranked) {
      // "New" offer: published after installation and within the last 48 hours, so an
      // opt-in or a long scheduler pause never turns into one event per old offer.
      const created = Date.parse(item.created_at);
      if (created >= installedAt && now - created <= NEW_OFFER_WINDOW) enqueue(candidate.user_id, 'compatible_offer_found', item,
        `compatible_offer:${candidate.id}:${item.offre_id}`);
    }
    if (ranked.length && week > 0) enqueue(candidate.user_id, 'weekly_recommendations',
      { nb: ranked.length, offres: ranked.slice(0, 5) }, `weekly_recommendations:${candidate.id}:${week}`);
    const lastActive = activities.get(candidate.user_id);
    if (Number.isFinite(lastActive)) {
      const inactive = Math.floor((now - lastActive) / DAY);
      const milestone = DELAYS.inactivityDays.find((days) => inactive >= days);
      if (milestone) {
        const fresh = ranked.filter((o) => Date.parse(o.created_at) > lastActive);
        enqueue(candidate.user_id, 'user_inactive', { days: milestone, nb: fresh.length, offres: fresh.slice(0, 5) },
          `inactive:${candidate.id}:${new Date(lastActive).toISOString()}:${milestone}`);
      }
    }
  }
  for (const offer of offers) {
    const recruiter = recruiters.get(offer.recruteur_id);
    if (!recruiter) continue;
    const fresh = snapshot.candidates.filter((c) => (Date.parse(c.created_at) >= installedAt || Date.parse(c.automation_changed_at) >= installedAt)
      && !applied.has(`${c.id}:${offer.id}`)).map((c) => ({
        candidat_id: c.id, score: recommendationScore(c, offer, recruiter), created_at: c.created_at,
      })).filter((c) => c.score != null && c.score >= 70);
    // IDs + scores only: passive sourcing never receives candidate identity.
    if (fresh.length) enqueue(recruiter.user_id, 'compatible_candidates_found',
      { offre_id: offer.id, poste: offer.titre, nb: fresh.length, candidats: fresh.map((c) => ({ candidat_id: c.candidat_id, score: c.score })) },
      `compatible_candidates:${offer.id}`);
    if (offer.expires_at && Date.parse(offer.expires_at) - now <= DELAYS.expiringWindow) enqueue(recruiter.user_id, 'offer_expiring',
      { offre_id: offer.id, poste: offer.titre, date_fin: offer.expires_at, role: 'RECRUTEUR' }, `offer_expiring:rec:${offer.id}:${offer.expires_at}`);
  }
  for (const interaction of snapshot.interactions) {
    const candidate = candidates.get(interaction.user_id);
    const offer = offerMap.get(interaction.offre_id);
    if (!candidate || !offer || interaction.dismissed_at || applied.has(`${candidate.id}:${offer.id}`)) continue;
    const payload = { offre_id: offer.id, poste: offer.titre, entreprise: recruiters.get(offer.recruteur_id)?.entreprise || '' };
    if (interaction.application_started_at && now - Date.parse(interaction.application_started_at) >= DELAYS.abandonedReminder) {
      enqueue(candidate.user_id, 'application_abandoned', payload, `application_abandoned:${candidate.id}:${offer.id}:${interaction.application_started_at}`);
    } else if (interaction.viewed_at && !interaction.application_started_at && now - Date.parse(interaction.viewed_at) >= DELAYS.viewedReminder) {
      enqueue(candidate.user_id, 'offer_viewed_without_application', payload, `offer_viewed:${candidate.id}:${offer.id}:${interaction.viewed_at}`);
    }
    if (interaction.saved_at && offer.expires_at && Date.parse(offer.expires_at) - now <= DELAYS.expiringWindow) enqueue(candidate.user_id,
      'saved_offer_expiring', { ...payload, date_fin: offer.expires_at }, `saved_expiring:${candidate.id}:${offer.id}:${offer.expires_at}`);
  }
  const latest = new Map();
  for (const message of snapshot.messages) {
    const previous = latest.get(message.match_id);
    if (!previous || Date.parse(message.created_at) > Date.parse(previous.created_at)) latest.set(message.match_id, message);
  }
  const recruiterUsers = new Set(snapshot.recruiters.map((r) => r.user_id));
  const matches = new Map((snapshot.matches || []).map((m) => [m.id, m]));
  for (const message of latest.values()) {
    const sentAt = Date.parse(message.created_at);
    if (!recruiterUsers.has(message.sender_id) || !candidates.has(message.receiver_id) || now - sentAt < DELAYS.unansweredMessage
      || sentAt < installedAt) continue;
    const match = matches.get(message.match_id);
    if (!match || snapshot.applications.some((a) => a.candidat_id === match.candidat_id && a.offre_id === match.offre_id
      && ['refusee', 'retiree', 'embauche'].includes(a.statut))) continue;
    enqueue(message.receiver_id, 'recruiter_message_unanswered', { conversation_id: message.match_id, message_id: message.id }, `unanswered:${message.id}`);
  }
  return events;
}
module.exports = { DAY, DELAYS, NEW_OFFER_WINDOW, MESSAGE_LOOKBACK, profileCompletion, isOpenOffer, recommendationScore, buildScheduledEvents };

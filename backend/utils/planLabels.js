const CANDIDATE_PLAN_LABELS = Object.freeze({
  freemium: 'Compte candidat',
  carriere: 'Carrière',
  carriere_coaching: 'Carrière Coaching',
});

function candidatePlanLabel(plan) {
  const slug = String(plan || 'freemium').trim().toLowerCase();
  return CANDIDATE_PLAN_LABELS[slug] || 'Abonnement candidat';
}

function isKnownCandidatePlan(plan) {
  return Object.hasOwn(CANDIDATE_PLAN_LABELS, String(plan || 'freemium').trim().toLowerCase());
}

module.exports = { CANDIDATE_PLAN_LABELS, candidatePlanLabel, isKnownCandidatePlan };

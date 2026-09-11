const CANDIDATE_PLAN_LABELS = Object.freeze({
  freemium: 'Compte candidat',
  carriere: 'Carrière',
  carriere_coaching: 'Carrière Coaching',
});

const RECRUITER_PLAN_LABELS = Object.freeze({
  solo: 'Plan Entrepreneur',
  starter: 'Plan Starter',
  pro: 'Plan Pro',
  enterprise: 'Plan Enterprise',
});

function candidatePlanLabel(plan) {
  const slug = String(plan || 'freemium').trim().toLowerCase();
  return CANDIDATE_PLAN_LABELS[slug] || 'Abonnement candidat';
}

function isKnownCandidatePlan(plan) {
  return Object.hasOwn(CANDIDATE_PLAN_LABELS, String(plan || 'freemium').trim().toLowerCase());
}

function recruiterPlanLabel(plan) {
  const slug = String(plan || '').trim().toLowerCase();
  return RECRUITER_PLAN_LABELS[slug] || 'Abonnement recruteur';
}

function isKnownRecruiterPlan(plan) {
  return Object.hasOwn(RECRUITER_PLAN_LABELS, String(plan || '').trim().toLowerCase());
}

/** Libellé commercial selon le slug d’abonnement (recruteur vs candidat). */
function subscriptionPlanLabel(plan) {
  if (isKnownRecruiterPlan(plan)) return recruiterPlanLabel(plan);
  return candidatePlanLabel(plan);
}

module.exports = {
  CANDIDATE_PLAN_LABELS,
  RECRUITER_PLAN_LABELS,
  candidatePlanLabel,
  isKnownCandidatePlan,
  recruiterPlanLabel,
  isKnownRecruiterPlan,
  subscriptionPlanLabel,
};

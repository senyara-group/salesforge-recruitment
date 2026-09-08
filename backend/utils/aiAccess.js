const supabase = require('../supabase');

function configuredPlans(feature) {
  const key = feature === 'cv' ? 'AI_CV_ACCESS_PLANS' : 'AI_COACH_ACCESS_PLANS';
  const raw = String(process.env[key] || '*').trim().toLowerCase();
  return raw === '*' ? null : new Set(raw.split(',').map((plan) => plan.trim()).filter(Boolean));
}

function isAiPlanAllowed(plan, feature) {
  const plans = configuredPlans(feature);
  return !plans || plans.has(String(plan || 'freemium').toLowerCase());
}

async function getAiPlan(userId) {
  const { data, error } = await supabase.from('abonnements').select('plan, statut').eq('user_id', userId).maybeSingle();
  if (error) throw error;
  return data?.statut === 'actif' ? String(data.plan || 'freemium').toLowerCase() : 'freemium';
}

async function assertAiAccess(userId, feature) {
  const plans = configuredPlans(feature);
  const plan = await getAiPlan(userId);
  if (!plans) return { allowed: true, policy: 'all', plan };
  if (!isAiPlanAllowed(plan, feature)) {
    const accessError = new Error('Cette fonctionnalite n’est pas incluse dans votre acces actuel');
    accessError.status = 403;
    accessError.code = 'AI_ACCESS_DENIED';
    throw accessError;
  }
  return { allowed: true, policy: [...plans], plan };
}

module.exports = { configuredPlans, isAiPlanAllowed, assertAiAccess, getAiPlan };

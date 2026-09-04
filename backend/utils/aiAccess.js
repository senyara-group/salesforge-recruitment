const supabase = require('../supabase');

function configuredPlans(feature) {
  const key = feature === 'cv' ? 'AI_CV_ACCESS_PLANS' : 'AI_COACH_ACCESS_PLANS';
  const raw = String(process.env[key] || '*').trim().toLowerCase();
  return raw === '*' ? null : new Set(raw.split(',').map((plan) => plan.trim()).filter(Boolean));
}

async function assertAiAccess(userId, feature) {
  const plans = configuredPlans(feature);
  if (!plans) return { allowed: true, policy: 'all' };
  const { data, error } = await supabase.from('abonnements').select('plan, statut').eq('user_id', userId).maybeSingle();
  if (error) throw error;
  const plan = data?.statut === 'actif' ? String(data.plan || 'freemium').toLowerCase() : 'freemium';
  if (!plans.has(plan)) {
    const accessError = new Error('Cette fonctionnalite n’est pas incluse dans votre acces actuel');
    accessError.status = 403;
    accessError.code = 'AI_ACCESS_DENIED';
    throw accessError;
  }
  return { allowed: true, policy: [...plans], plan };
}

module.exports = { configuredPlans, assertAiAccess };

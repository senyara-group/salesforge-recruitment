const supabase = require('../supabase');
const { aiConfiguration } = require('./aiProvider');

const DEFAULT_QUOTAS = Object.freeze({
  freemium: { cv: 0, coach: 0 },
  carriere: { cv: 30, coach: 0 },
  carriere_coaching: { cv: 50, coach: 100 },
});

function configuredQuota(plan, feature) {
  const key = `AI_QUOTA_${String(plan).toUpperCase()}_${feature.toUpperCase()}`;
  const fallback = DEFAULT_QUOTAS[plan]?.[feature] || 0;
  const value = Number(process.env[key] ?? fallback);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function calendarPeriod(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

function estimatedCostEur(meta = {}) {
  const inputPerMillion = Number(process.env.AI_INPUT_USD_PER_MTOK || 3);
  const outputPerMillion = Number(process.env.AI_OUTPUT_USD_PER_MTOK || 15);
  const usdToEur = Number(process.env.AI_USD_TO_EUR || 0.92);
  return (((Number(meta.input_tokens || 0) * inputPerMillion) + (Number(meta.output_tokens || 0) * outputPerMillion)) / 1e6) * usdToEur;
}

function quotaError(feature, plan, usage, period) {
  const error = new Error('Quota mensuel épuisé');
  error.status = 429; error.code = 'AI_QUOTA_EXCEEDED';
  error.details = { feature, quota: usage.quota, used: usage.used, remaining: 0, reset_at: period.end, period_end: period.end,
    can_upgrade: plan === 'carriere', can_buy_credits: plan === 'carriere_coaching' };
  return error;
}

async function usageFor(userId, plan, client = supabase, now = new Date()) {
  const period = calendarPeriod(now);
  const { data, error } = await client.from('ai_monthly_usage').select('cv_used,coach_used,extra_cv_credits,extra_coach_credits')
    .eq('user_id', userId).eq('period_start', period.start).maybeSingle();
  if (error) throw error;
  const result = {};
  for (const feature of ['cv', 'coach']) {
    const baseQuota = configuredQuota(plan, feature);
    const extraCredits = Number(data?.[`extra_${feature}_credits`] || 0);
    const quota = baseQuota + extraCredits;
    const used = Number(data?.[`${feature}_used`] || 0);
    result[feature] = {
      quota,
      used,
      remaining: Math.max(0, quota - used),
      extra_credits: extraCredits,
    };
  }
  return {
    ...result,
    reset_at: period.end,
    period_end: period.end,
  };
}

async function reserveUsage(userId, plan, feature, client = supabase, now = new Date()) {
  const period = calendarPeriod(now);
  const usage = (await usageFor(userId, plan, client, now))[feature];
  const { data, error } = await client.rpc('reserve_ai_usage', { p_user_id:userId, p_feature:feature,
    p_period_start:period.start, p_period_end:period.end, p_base_limit:configuredQuota(plan, feature) });
  if (error) throw error;
  if (!data) throw quotaError(feature, plan, usage, period);
  return { id:data, feature, plan, period };
}

async function releaseUsage(reservation, client = supabase) {
  if (!reservation?.id) return;
  try {
    const { error } = await client.rpc('release_ai_usage', { p_reservation_id: reservation.id });
    if (error) console.warn('[ai-usage] reservation release failed', { feature: reservation.feature });
  } catch (_error) {
    console.warn('[ai-usage] reservation release failed', { feature: reservation.feature });
  }
}

async function finalizeUsage(reservation, meta, resourceType, resourceId, client = supabase) {
  const args = { p_reservation_id:reservation.id,
    p_model:aiConfiguration().model, p_input_tokens:meta?.input_tokens ?? null,
    p_output_tokens:meta?.output_tokens ?? null, p_estimated_cost_eur:estimatedCostEur(meta),
    p_resource_type:resourceType, p_resource_id:resourceId };
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { error, data } = await client.rpc('finalize_ai_usage', args);
    if (!error) {
      if (!data) throw new Error('Réservation IA expirée avant finalisation');
      return;
    }
    lastError = error;
  }
  throw lastError;
}

module.exports = { DEFAULT_QUOTAS, configuredQuota, calendarPeriod, estimatedCostEur, usageFor, reserveUsage, releaseUsage, finalizeUsage };

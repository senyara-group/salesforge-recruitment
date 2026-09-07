const SCHEMA_ERROR = /(schema cache|relation .* does not exist|could not find the table|pgrst205)/i;

function quotaDetails(details = {}) {
  return {
    feature: details.feature,
    quota: details.quota,
    used: details.used,
    remaining: details.remaining,
    reset_at: details.reset_at,
    period_end: details.period_end,
    can_upgrade: Boolean(details.can_upgrade),
    can_buy_credits: Boolean(details.can_buy_credits),
  };
}

function publicAiError(error = {}) {
  const technicalMessage = String(error.message || error.details || 'Unknown AI error');
  const code = String(error.code || 'AI_REQUEST_FAILED');

  if (SCHEMA_ERROR.test(`${code} ${technicalMessage}`)) {
    return {
      status: 503,
      code: 'AI_STORAGE_UNAVAILABLE',
      message: 'Cette fonctionnalité est temporairement indisponible. Réessayez dans quelques instants.',
    };
  }
  if (code === 'AI_NOT_CONFIGURED') {
    return { status: 503, code, message: 'L’assistant est momentanément indisponible.' };
  }
  if (['AI_QUOTA_REACHED', 'AI_QUOTA_EXCEEDED'].includes(code)) {
    return { status: 429, code: 'AI_QUOTA_EXCEEDED', message: 'Votre quota mensuel a été atteint.', details: quotaDetails(error.details) };
  }
  if (['AI_PROVIDER_ERROR', 'AI_INVALID_RESPONSE', 'AI_TIMEOUT'].includes(code)) {
    return { status: Number(error.status) || 502, code, message: 'La réponse n’a pas pu être générée. Vous pouvez réessayer.' };
  }
  if (code === 'AI_ACCESS_DENIED') {
    return { status: 403, code, message: 'Cette fonctionnalité n’est pas incluse dans votre abonnement.' };
  }
  if (Number(error.status) === 404) {
    return { status: 404, code: 'AI_NOT_FOUND', message: 'La ressource demandée est introuvable.' };
  }
  if (Number(error.status) === 400) {
    return { status: 400, code: 'AI_INVALID_REQUEST', message: technicalMessage };
  }
  return { status: 500, code: 'AI_REQUEST_FAILED', message: 'Cette fonctionnalité est temporairement indisponible. Réessayez dans quelques instants.' };
}

module.exports = { publicAiError };

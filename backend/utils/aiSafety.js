const AI_SAFETY_FALLBACK = 'Je suis un outil d’entraînement et d’optimisation. Pour découvrir des offres, rendez-vous dans l’espace Offres de SwipSales.';

const RULES = [
  ['connection', /\b(?:mise|mettre) en relation\b|\b(?:te|vous) présenter à (?:un|une|l[’'])\s*(?:recruteur|entreprise)/i],
  ['offer_recommendation', /\b(?:je (?:te|vous) recommande|voici|j[’']ai trouvé)\s+(?:cette |une |des |l[’'])?offres?\b|\bpostulez?\s+(?:chez|auprès de)\b/i],
  ['platform_company', /\b(?:entreprise|recruteur)\s+(?:inscrit|inscrite|présent|présente)\s+sur\s+SwipSales\b/i],
  ['job_search', /\bje (?:vais|peux) (?:chercher|trouver) (?:un poste|des offres?)\b/i],
  ['candidate_comparison', /\b(?:meilleur|moins bon|mieux classé)\s+que\s+(?:les |d[’'])?autres candidats\b|\bcomparé aux autres candidats\b/i],
  ['numeric_rating', /\b(?:note|score)\s*(?:de\s*)?\d+(?:[.,]\d+)?\s*\/\s*(?:10|20|100)\b/i],
];

function inspectAssistantOutput(value) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value || {});
  for (const [type, pattern] of RULES) {
    if (pattern.test(serialized)) return { safe: false, incidentType: type };
  }
  return { safe: true, incidentType: null };
}

module.exports = { AI_SAFETY_FALLBACK, inspectAssistantOutput };

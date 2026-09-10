/**
 * Matching recruteur V1 : seuls les axes ADN courts réellement produits
 * peuvent contribuer au score d'affichage.
 */

const CONTRIBUTING_MATCHING_KEYS = Object.freeze([
  'closing',
  'resilience',
  'salestech',
  'drive',
  'ecoute',
]);

const LEGACY_IGNORED_MATCHING_KEYS = Object.freeze(['cycle', 'saas', 'outbound']);

function normalizeAxisKey(value = '') {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function axisEntries(candidateAxes) {
  if (Array.isArray(candidateAxes)) {
    return candidateAxes.map((item) => [item?.l, item?.v]);
  }
  if (!candidateAxes || typeof candidateAxes !== 'object') return [];
  return Object.entries(candidateAxes);
}

function findAxisValue(candidateAxes, criterion) {
  const wanted = normalizeAxisKey(criterion);
  const found = axisEntries(candidateAxes).find(([label]) => {
    const axis = normalizeAxisKey(label);
    return axis === wanted || axis.includes(wanted) || wanted.includes(axis);
  });
  if (!found || !Number.isFinite(Number(found[1]))) return null;
  return Number(found[1]);
}

function hasContributingMatching(matching = {}) {
  return Object.entries(matching || {}).some(
    ([key, weight]) => CONTRIBUTING_MATCHING_KEYS.includes(key) && Number(weight) > 0
  );
}

function compatibilityScore(candidateAxes = {}, matching = {}) {
  const entries = Object.entries(matching || {})
    .filter(([key, weight]) => CONTRIBUTING_MATCHING_KEYS.includes(key) && Number(weight) > 0);

  let total = 0;
  let weightTotal = 0;
  for (const [key, weight] of entries) {
    const value = findAxisValue(candidateAxes, key);
    if (value == null) continue;
    total += value * Number(weight);
    weightTotal += Number(weight);
  }

  if (weightTotal) return Math.round(total / weightTotal);
  const fallback = findAxisValue(candidateAxes, 'score') ?? findAxisValue(candidateAxes, 'closing');
  return fallback ?? 70;
}

module.exports = {
  CONTRIBUTING_MATCHING_KEYS,
  LEGACY_IGNORED_MATCHING_KEYS,
  normalizeAxisKey,
  findAxisValue,
  hasContributingMatching,
  compatibilityScore,
};

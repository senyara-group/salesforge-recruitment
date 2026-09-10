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

/** Poids valide uniquement : fini et dans [0, 100]. Sinon null (ignoré). */
function sanitizeMatchingWeight(weight) {
  const n = Number(weight);
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return n;
}

/** Valeur d’axe finie, clampée dans [0, 100]. Non fini → null. */
function clampAxisValue(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

function findAxisValue(candidateAxes, criterion) {
  const wanted = normalizeAxisKey(criterion);
  const found = axisEntries(candidateAxes).find(([label]) => {
    const axis = normalizeAxisKey(label);
    return axis === wanted || axis.includes(wanted) || wanted.includes(axis);
  });
  if (!found) return null;
  return clampAxisValue(found[1]);
}

function hasContributingMatching(matching = {}) {
  return Object.entries(matching || {}).some(([key, weight]) => {
    if (!CONTRIBUTING_MATCHING_KEYS.includes(key)) return false;
    const w = sanitizeMatchingWeight(weight);
    return w != null && w > 0;
  });
}

function finalizeScore(raw) {
  if (!Number.isFinite(raw)) return 70;
  return Math.round(Math.min(100, Math.max(0, raw)));
}

function compatibilityScore(candidateAxes = {}, matching = {}) {
  let total = 0;
  let weightTotal = 0;

  for (const [key, rawWeight] of Object.entries(matching || {})) {
    if (!CONTRIBUTING_MATCHING_KEYS.includes(key)) continue;
    const weight = sanitizeMatchingWeight(rawWeight);
    if (weight == null || weight <= 0) continue;

    const value = findAxisValue(candidateAxes, key);
    if (value == null) continue;

    total += value * weight;
    weightTotal += weight;
  }

  if (weightTotal > 0) {
    return finalizeScore(total / weightTotal);
  }

  // Aucun critère contributeur utilisable : pas de constante 50 inventée par axe.
  // Fallback display historique (score/closing), toujours fini et borné.
  const fallback = findAxisValue(candidateAxes, 'score') ?? findAxisValue(candidateAxes, 'closing');
  return finalizeScore(fallback ?? 70);
}

module.exports = {
  CONTRIBUTING_MATCHING_KEYS,
  LEGACY_IGNORED_MATCHING_KEYS,
  normalizeAxisKey,
  findAxisValue,
  sanitizeMatchingWeight,
  clampAxisValue,
  hasContributingMatching,
  compatibilityScore,
};

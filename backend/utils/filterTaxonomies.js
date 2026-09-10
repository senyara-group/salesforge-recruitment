/**
 * Taxonomies filtres — primitives backend (PR A).
 * Pas encore branchées aux routes deck ; validation centralisée pour les PR suivantes.
 *
 * Les listes marquées pendingYannis restent extensibles (pas de CHECK DB fermé).
 */

const CONTRACT_TYPES = Object.freeze(['CDI', 'Alternance', 'Mission', 'Freelance']);

/** Aligné sur l’UI création d’offre (Remote / France entière / ville onsite). */
const REMOTE_MODES = Object.freeze(['remote', 'nationwide', 'onsite', 'hybrid']);

/** Tags offre historiques (liste fermée UI actuelle). */
const OFFER_TAG_VOCABULARY = Object.freeze([
  'Closing',
  'Cold Calling',
  'SaaS',
  'Outbound',
  'HubSpot',
  'Salesforce',
  'Négociation',
]);

/**
 * Propositions provisoires — validation produit Yannis requise avant enum DB.
 * Contenu indicatif pour tests / futures UI, pas une vérité métier figée.
 */
const PENDING_TAXONOMIES = Object.freeze({
  job_type: Object.freeze({
    pendingYannis: true,
    values: Object.freeze([
      'sdr_bdr',
      'account_executive',
      'closer',
      'sales',
      'head_of_sales',
      'sales_engineer',
      'customer_success',
      'other',
    ]),
  }),
  sales_style: Object.freeze({
    pendingYannis: true,
    /** Aligné partiellement sur ADN court job_profile.style */
    values: Object.freeze(['hunter', 'farmer', 'full']),
  }),
  customer_types: Object.freeze({
    pendingYannis: true,
    values: Object.freeze(['b2b', 'b2c', 'pme', 'eti', 'grand_compte', 'startup', 'public']),
  }),
  availability: Object.freeze({
    pendingYannis: true,
    values: Object.freeze(['immediate', 'within_1_month', 'within_3_months', 'open']),
  }),
  sectors: Object.freeze({
    pendingYannis: true,
    values: Object.freeze([
      'saas',
      'fintech',
      'cyber',
      'hrtech',
      'ecommerce',
      'industrie',
      'autre',
    ]),
  }),
});

const STABLE_TAXONOMIES = Object.freeze({
  contract_type: Object.freeze({ pendingYannis: false, values: CONTRACT_TYPES }),
  remote_mode: Object.freeze({ pendingYannis: false, values: REMOTE_MODES }),
  offer_tags: Object.freeze({ pendingYannis: false, values: OFFER_TAG_VOCABULARY }),
});

function normalizeToken(value) {
  return String(value || '').trim();
}

function isAllowedValue(value, allowed, { allowEmpty = false } = {}) {
  const token = normalizeToken(value);
  if (!token) return Boolean(allowEmpty);
  return allowed.includes(token);
}

function assertAllowedValue(value, allowed, label) {
  const token = normalizeToken(value);
  if (!token) {
    const error = new Error(`${label} requis`);
    error.code = 'FILTER_TAXONOMY_REQUIRED';
    error.status = 400;
    throw error;
  }
  if (!allowed.includes(token)) {
    const error = new Error(`${label} invalide: ${token}`);
    error.code = 'FILTER_TAXONOMY_INVALID';
    error.status = 400;
    throw error;
  }
  return token;
}

function assertAllowedList(values, allowed, label) {
  if (values == null) return [];
  if (!Array.isArray(values)) {
    const error = new Error(`${label} doit être un tableau`);
    error.code = 'FILTER_TAXONOMY_INVALID';
    error.status = 400;
    throw error;
  }
  return values.map((value) => assertAllowedValue(value, allowed, label));
}

function canonicalizeContractType(value) {
  const token = normalizeToken(value);
  if (!token) return null;
  const found = CONTRACT_TYPES.find((item) => item.toLowerCase() === token.toLowerCase());
  return found || null;
}

function inferRemoteModeFromLieu(lieu) {
  const text = normalizeToken(lieu).toLowerCase();
  if (!text) return null;
  if (text.includes('remote')) return 'remote';
  if (text.includes('france enti')) return 'nationwide';
  return 'onsite';
}

/**
 * Règle produit future : OR dans une famille, AND entre familles.
 * Exposée ici pour tests / documentation ; non branchée aux decks.
 */
function matchesFilterFamilies(itemMatchers) {
  if (!Array.isArray(itemMatchers) || !itemMatchers.length) return true;
  return itemMatchers.every(Boolean);
}

function familyMatchesAny(selected, candidateValues) {
  if (!selected || !selected.length) return true;
  const pool = new Set((candidateValues || []).map(normalizeToken).filter(Boolean));
  return selected.some((value) => pool.has(normalizeToken(value)));
}

module.exports = {
  CONTRACT_TYPES,
  REMOTE_MODES,
  OFFER_TAG_VOCABULARY,
  PENDING_TAXONOMIES,
  STABLE_TAXONOMIES,
  normalizeToken,
  isAllowedValue,
  assertAllowedValue,
  assertAllowedList,
  canonicalizeContractType,
  inferRemoteModeFromLieu,
  matchesFilterFamilies,
  familyMatchesAny,
};

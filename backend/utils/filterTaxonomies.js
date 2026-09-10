/**
 * Taxonomies filtres — primitives backend (PR A).
 * Pas encore branchées aux routes deck ; validation centralisée pour les PR suivantes.
 *
 * Stables (UI actuelle) : contract_type, remote_mode, offer tags.
 * Pending Yannis : job_type, sales_style, customer_types, availability, sectors —
 * pas de valeurs fermées enforceables (ne bloquent pas un choix produit futur).
 */

const CONTRACT_TYPES = Object.freeze(['CDI', 'Alternance', 'Mission', 'Freelance']);

/** Mode de travail uniquement — pas de couverture géo (France entière ≠ remote_mode). */
const REMOTE_MODES = Object.freeze(['onsite', 'hybrid', 'remote']);

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
 * Concepts en attente de validation produit.
 * Aucune liste de valeurs fermée : enforceable=false.
 */
const PENDING_TAXONOMIES = Object.freeze({
  job_type: Object.freeze({
    pendingYannis: true,
    enforceable: false,
    values: null,
    note: 'Liste métier à confirmer par Yannis — ne pas enforce comme enum.',
  }),
  sales_style: Object.freeze({
    pendingYannis: true,
    enforceable: false,
    values: null,
    note: 'hunter/farmer/full existent dans l’ADN court mais la liste finale reste à valider.',
  }),
  customer_types: Object.freeze({
    pendingYannis: true,
    enforceable: false,
    values: null,
    note: 'Taxonomie clientèle absente du produit actuel.',
  }),
  availability: Object.freeze({
    pendingYannis: true,
    enforceable: false,
    values: null,
    note: 'Disponibilité profil non modélisée aujourd’hui.',
  }),
  sectors: Object.freeze({
    pendingYannis: true,
    enforceable: false,
    values: null,
    note: 'Secteurs fragmentés (prefs ADN / compétences / recruteur) — liste à unifier.',
  }),
});

const STABLE_TAXONOMIES = Object.freeze({
  contract_type: Object.freeze({ pendingYannis: false, enforceable: true, values: CONTRACT_TYPES }),
  remote_mode: Object.freeze({ pendingYannis: false, enforceable: true, values: REMOTE_MODES }),
  offer_tags: Object.freeze({ pendingYannis: false, enforceable: true, values: OFFER_TAG_VOCABULARY }),
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

/** Canonicalise une valeur contrat connue ; sinon null (n’altère pas le legacy). */
function canonicalizeContractType(value) {
  const token = normalizeToken(value);
  if (!token) return null;
  const found = CONTRACT_TYPES.find((item) => item.toLowerCase() === token.toLowerCase());
  return found || null;
}

/**
 * Infère remote_mode depuis lieu uniquement si déterministe.
 * France entière / couverture nationale → null (chantier géo ultérieur).
 * Ville générique → null (onsite n’est pas déduit sans confirmation).
 */
function inferRemoteModeFromLieu(lieu) {
  const text = normalizeToken(lieu).toLowerCase();
  if (!text) return null;
  if (text.includes('remote')) return 'remote';
  if (text.includes('hybride') || text.includes('hybrid')) return 'hybrid';
  if (text.includes('france enti')) return null;
  return null;
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

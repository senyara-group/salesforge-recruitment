/**
 * Taxonomies filtres — primitives backend.
 * Listes métier Yannis V1 : voir yannisTaxonomies.js (pas d’enum DB dur).
 *
 * Stables enforceables offres : contract_type, remote_mode, offer tags.
 * Profil / filtres candidat : listes Yannis en app (skills, tools, …) sans contrainte SQL.
 */

const {
  CONTRACT_TYPES,
  CANDIDATE_SKILLS,
  TARGET_JOB_TYPES,
  SECTORS,
  CUSTOMER_TYPES,
  TOOLS,
  METHODOLOGIES,
  SALES_STYLE_OPTIONS,
  AVAILABILITY_OPTIONS,
  REMOTE_MODE_OPTIONS,
  VARIABLE_SHARES,
  VARIABLE_SHARE_OPTIONS,
} = require('./yannisTaxonomies');

/** Mode de travail uniquement — pas de couverture géo (France entière ≠ remote_mode). */
const REMOTE_MODES = Object.freeze(REMOTE_MODE_OPTIONS.map((item) => item.value));

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
 * Familles Yannis V1 — valeurs documentées, enforceable=false en DB
 * (validation / normalisation applicative uniquement).
 */
const YANNIS_TAXONOMIES = Object.freeze({
  skills: Object.freeze({ pendingYannis: false, enforceable: false, values: CANDIDATE_SKILLS }),
  target_job_types: Object.freeze({ pendingYannis: false, enforceable: false, values: TARGET_JOB_TYPES }),
  sales_style: Object.freeze({
    pendingYannis: false,
    enforceable: false,
    values: SALES_STYLE_OPTIONS.map((item) => item.value),
  }),
  customer_types: Object.freeze({ pendingYannis: false, enforceable: false, values: CUSTOMER_TYPES }),
  availability: Object.freeze({
    pendingYannis: false,
    enforceable: false,
    values: AVAILABILITY_OPTIONS.map((item) => item.value),
  }),
  sectors: Object.freeze({ pendingYannis: false, enforceable: false, values: SECTORS }),
  tools: Object.freeze({ pendingYannis: false, enforceable: false, values: TOOLS }),
  methodologies: Object.freeze({ pendingYannis: false, enforceable: false, values: METHODOLOGIES }),
  variable_share: Object.freeze({ pendingYannis: false, enforceable: false, values: VARIABLE_SHARES }),
});

/** @deprecated alias — les listes Yannis sont dans YANNIS_TAXONOMIES. */
const PENDING_TAXONOMIES = YANNIS_TAXONOMIES;

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
  return [...new Set(values.map((value) => assertAllowedValue(value, allowed, label)))];
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
  YANNIS_TAXONOMIES,
  STABLE_TAXONOMIES,
  CANDIDATE_SKILLS,
  TARGET_JOB_TYPES,
  SECTORS,
  CUSTOMER_TYPES,
  TOOLS,
  METHODOLOGIES,
  VARIABLE_SHARES,
  VARIABLE_SHARE_OPTIONS,
  normalizeToken,
  isAllowedValue,
  assertAllowedValue,
  assertAllowedList,
  canonicalizeContractType,
  inferRemoteModeFromLieu,
  matchesFilterFamilies,
  familyMatchesAny,
};

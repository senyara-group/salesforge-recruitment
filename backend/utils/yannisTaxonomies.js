const { createJobTaxonomy, deepFreezeDescriptors } = require('./jobTaxonomy');

/**
 * Taxonomies Yannis V1 (document SwipSales_Test_ADN_situations).
 * Source de vérité applicative — pas d’enum DB dur (legacy toléré).
 */

function normalizeToken(value) {
  return String(value || '').trim();
}

/** Clé de comparaison skills : trim, casse, accents, tirets/espaces. */
function normalizeSkill(value) {
  return normalizeToken(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[-_/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Compétences déclaratives candidat (≠ axes ADN court). */
const CANDIDATE_SKILLS = Object.freeze([
  'Closing',
  'Cold calling',
  'Prospection terrain',
  'Négociation',
  'Gestion de portefeuille',
  'Social selling',
]);

// IDs are the existing ADN job_profile.poste / candidats.type_poste codes.
// Structured profile/offer fields persist labels, NOT these IDs.
// Validated at load (IDs, labels, aliases, collisions): see utils/jobTaxonomy.js.
// Lot 4 : 9 familles ajoutées depuis la liste de Yannis (JOB_TAXONOMY.md). Les 6 IDs et
// labels historiques sont inchangés et gardent leur ordre relatif. Les aliases sont
// uniquement des intitulés de cette liste sans ambiguïté ; les intitulés génériques
// (Commercial, Sales Executive, Closer…) restent volontairement non résolus.
const JOB_TYPE_DESCRIPTORS = deepFreezeDescriptors([
  {
    id: 'sdr',
    label: 'SDR / BDR',
    aliases: ['SDR', 'BDR', 'Sales Development Representative (SDR)', 'Business Development Representative (BDR)',
      'Prospecteur commercial', 'Chargé de prospection', 'Téléprospecteur', 'Appointment Setter',
      'Lead Generation Specialist'],
  },
  {
    id: 'bizdev',
    label: 'Business Developer',
    aliases: ['Business Development Manager (BDM)', 'Business Development Executive', 'Business Developer International',
      'International Business Developer', 'International Business Development Manager'],
  },
  {
    id: 'ae',
    label: 'Account Executive',
    aliases: ['Account Executive (AE)', 'Junior Account Executive', 'Senior Account Executive',
      'Enterprise Account Executive', 'Strategic Account Executive'],
  },
  {
    id: 'sedentaire',
    label: 'Commercial sédentaire / Inside Sales',
    aliases: ['Commercial sédentaire', 'Inside Sales', 'Télévendeur'],
  },
  {
    id: 'terrain',
    label: 'Commercial terrain',
    aliases: ['Délégué commercial', 'Délégué commercial terrain', 'Attaché commercial', 'Représentant commercial',
      'VRP', 'Agent commercial'],
  },
  {
    id: 'technico_commercial',
    label: 'Technico-commercial',
    aliases: ['Attaché technico-commercial', 'Ingénieur technico-commercial', 'Technico-commercial sédentaire',
      'Technico-commercial itinérant', 'Technical Sales'],
  },
  {
    id: 'charge_affaires',
    label: "Chargé d'affaires / Ingénieur d'affaires",
    aliases: ["Chargé d'affaires", "Chargé d'affaires commercial", "Chargé d'affaires B2B", "Chargé d'affaires industrie",
      "Chargé d'affaires IT", "Chargé d'affaires international", "Responsable d'affaires", "Ingénieur d'affaires",
      "Ingénieur d'affaires IT"],
  },
  {
    id: 'avant_vente',
    label: 'Avant-vente / Sales Engineer',
    aliases: ['Sales Engineer', 'Sales Engineer IT', 'Solutions Engineer', 'Solutions Consultant', 'Solution Consultant',
      'Sales Solutions Consultant', 'Pre-Sales Consultant', 'Consultant avant-vente', 'Ingénieur avant-vente',
      'Responsable avant-vente', 'Avant-vente IT'],
  },
  {
    id: 'kam',
    label: 'Key Account Manager',
    aliases: ['Key Account Manager (KAM)', 'Global Account Manager', 'Strategic Account Manager', 'Commercial grands comptes',
      'Responsable grands comptes', 'International Key Account Manager'],
  },
  {
    id: 'account_manager',
    label: 'Account Manager',
    aliases: ['Junior Account Manager', 'Senior Account Manager', 'Customer Account Manager', 'International Account Manager',
      'Responsable portefeuille clients', 'Responsable comptes clients', 'Responsable de compte', 'Chargé de comptes'],
  },
  {
    id: 'customer_success',
    label: 'Customer Success Manager',
    aliases: ['Customer Success Manager (CSM)', 'Client Success Manager', 'Customer Success Executive',
      'Customer Success Specialist'],
  },
  {
    id: 'partenariats',
    label: 'Partenariats / Channel',
    aliases: ['Partnership Manager', 'Partner Manager', 'Channel Manager', 'Channel Sales Manager', 'Channel Account Manager',
      'Strategic Partnerships Manager', 'Business Partnership Manager', 'Alliances Manager', 'Alliance Manager',
      'Partner Development Manager', 'Head of Partnerships', 'Partnership Director', 'Directeur des partenariats',
      'VP Partnerships'],
  },
  {
    id: 'conseiller_vente',
    label: 'Conseiller de vente / Vendeur',
    aliases: ['Conseiller de vente', 'Vendeur', 'Vendeur conseil'],
  },
  {
    id: 'manager',
    label: 'Manager commercial',
    // 'Sales Manager' et 'Responsable commercial' volontairement absents : souvent un
    // commercial senior sans équipe, trop ambigus pour être convertis en 'Manager commercial'.
    aliases: ['Team Leader Sales', 'Sales Team Leader', 'Sales Supervisor',
      'Responsable des ventes', 'Responsable régional des ventes', 'Area Sales Manager', 'Regional Sales Manager',
      'National Sales Manager', 'Sales Development Manager'],
  },
  {
    id: 'direction_commerciale',
    label: 'Directeur commercial / Head of Sales',
    aliases: ['Directeur commercial', 'Directeur des ventes', 'Directeur commercial international', 'Sales Director',
      'Head of Sales', 'VP Sales', 'Chief Sales Officer (CSO)', 'Chief Sales Officer', 'Chief Revenue Officer (CRO)',
      'Chief Revenue Officer', 'CRO', 'Chief Commercial Officer (CCO)', 'Business Development Director',
      'Directeur Business Development', 'Head of Business Development', 'VP Business Development'],
  },
]);
const jobTaxonomy = createJobTaxonomy(JOB_TYPE_DESCRIPTORS);
const {
  JOB_TYPES,
  TARGET_JOB_TYPES,
  activeJobTypes,
  jobTypeById,
  isJobTypeId,
  resolveJobTypeLabel,
  resolveStoredJobType,
  jobTypeLabel,
  canonicalizeTargetJobType,
} = jobTaxonomy;

const CONTRACT_TYPES = Object.freeze(['CDI', 'Alternance', 'Mission', 'Freelance']);

/** Labels UI remote ; valeurs SQL historiques onsite|hybrid|remote. */
const REMOTE_MODE_OPTIONS = Object.freeze([
  { value: 'onsite', label: 'Sur site' },
  { value: 'hybrid', label: 'Hybride' },
  { value: 'remote', label: 'Complet' },
]);

const SECTORS = Object.freeze([
  'SaaS et Tech',
  'Industrie',
  'BTP',
  'Immobilier',
  'Assurance et Banque',
  'Retail',
  'Services B2B',
  'Télécom',
  'Santé',
  'Automobile',
]);

const CUSTOMER_TYPES = Object.freeze([
  'PME',
  'ETI',
  'Grands comptes',
  'Particuliers',
]);

const TOOLS = Object.freeze([
  'Salesforce',
  'HubSpot',
  'Pipedrive',
  'Sales Navigator',
  'Lemlist',
  'Apollo',
]);

const METHODOLOGIES = Object.freeze([
  'BANT',
  'MEDDIC',
  'SPIN',
  'Challenger',
  'Solution Selling',
  'Inbound',
]);

const AVAILABILITY_OPTIONS = Object.freeze([
  { value: 'immediate', label: 'Immédiate' },
  { value: '1_month', label: 'Sous 1 mois' },
  { value: '3_months', label: 'Sous 3 mois' },
]);

/** Valeurs SQL historiques ; labels Yannis. */
const SALES_STYLE_OPTIONS = Object.freeze([
  { value: 'hunter', label: 'Chasseur' },
  { value: 'farmer', label: 'Éleveur' },
  { value: 'full', label: 'Cycle complet' },
]);

/** Part de variable offre — labels Yannis ; valeurs SQL. */
const VARIABLE_SHARE_OPTIONS = Object.freeze([
  { value: 'low', label: 'Faible' },
  { value: 'balanced', label: 'Équilibrée' },
  { value: 'majority', label: 'Majoritaire' },
]);

const VARIABLE_SHARES = Object.freeze(VARIABLE_SHARE_OPTIONS.map((item) => item.value));

/** Alias affichage FR / typos stables → valeur SQL. */
const LEGACY_VARIABLE_SHARE_ALIASES = Object.freeze({
  faible: 'low',
  low: 'low',
  'équilibrée': 'balanced',
  equilibree: 'balanced',
  balanced: 'balanced',
  majoritaire: 'majority',
  majority: 'majority',
});

/** Compétences offre = même liste fermée que candidat.skills. */
const OFFER_SKILLS = CANDIDATE_SKILLS;

/**
 * Alias legacy déterministes → label canonique.
 * Uniquement des équivalences exactes / orthographiques stables.
 */
const LEGACY_SKILL_ALIASES = Object.freeze({
  closing: 'Closing',
  'cold calling': 'Cold calling',
  'cold-calling': 'Cold calling',
  'prospection terrain': 'Prospection terrain',
  négociation: 'Négociation',
  negociation: 'Négociation',
  'négociation commerciale': 'Négociation',
  'gestion de portefeuille': 'Gestion de portefeuille',
  'développement de portefeuille': 'Gestion de portefeuille',
  'social selling': 'Social selling',
});

const LEGACY_TOOL_ALIASES = Object.freeze({
  'linkedin sales navigator': 'Sales Navigator',
  'sales navigator': 'Sales Navigator',
});

const LEGACY_METHODOLOGY_ALIASES = Object.freeze({
  'spin selling': 'SPIN',
  spin: 'SPIN',
  'challenger sale': 'Challenger',
  challenger: 'Challenger',
  'inbound sales': 'Inbound',
  inbound: 'Inbound',
});

const LEGACY_SECTOR_ALIASES = Object.freeze({
  'saas / tech': 'SaaS et Tech',
  'saas et tech': 'SaaS et Tech',
  'assurance / banque': 'Assurance et Banque',
  'assurance et banque': 'Assurance et Banque',
});

const LEGACY_CUSTOMER_ALIASES = Object.freeze({
  'grand compte': 'Grands comptes',
  'grands comptes': 'Grands comptes',
  b2c: 'Particuliers',
  particuliers: 'Particuliers',
});

function canonicalizeFromList(value, allowed, aliases = {}) {
  const token = normalizeToken(value);
  if (!token) return null;
  const exact = allowed.find((item) => item === token);
  if (exact) return exact;
  const lower = token.toLowerCase();
  const fromAlias = aliases[lower];
  if (fromAlias && allowed.includes(fromAlias)) return fromAlias;
  const ci = allowed.find((item) => item.toLowerCase() === lower);
  return ci || null;
}

const NORMALIZED_SKILL_LOOKUP = (() => {
  const map = new Map();
  for (const skill of CANDIDATE_SKILLS) {
    map.set(normalizeSkill(skill), skill);
  }
  for (const [alias, canonical] of Object.entries(LEGACY_SKILL_ALIASES)) {
    if (CANDIDATE_SKILLS.includes(canonical)) {
      map.set(normalizeSkill(alias), canonical);
    }
  }
  return map;
})();

/**
 * Trim + casse + accents + tirets → valeur canonique Yannis si connue, sinon null.
 */
function resolveCanonicalSkill(value) {
  const token = normalizeToken(value);
  if (!token) return null;
  const fromList = canonicalizeFromList(token, CANDIDATE_SKILLS, LEGACY_SKILL_ALIASES);
  if (fromList) return fromList;
  return NORMALIZED_SKILL_LOOKUP.get(normalizeSkill(token)) || null;
}

function canonicalizeCandidateSkill(value) {
  return resolveCanonicalSkill(value);
}

function canonicalizeVariableShare(value) {
  return canonicalizeFromList(value, VARIABLE_SHARES, LEGACY_VARIABLE_SHARE_ALIASES);
}

function canonicalizeSalesStyle(value) {
  const allowed = SALES_STYLE_OPTIONS.map((item) => item.value);
  const token = normalizeToken(value);
  if (!token) return null;
  const byValue = canonicalizeFromList(token, allowed);
  if (byValue) return byValue;
  const byLabel = SALES_STYLE_OPTIONS.find((item) => item.label.toLowerCase() === token.toLowerCase());
  return byLabel ? byLabel.value : null;
}

function canonicalizeCustomerType(value) {
  return canonicalizeFromList(value, CUSTOMER_TYPES, LEGACY_CUSTOMER_ALIASES);
}

function canonicalizeSector(value) {
  return canonicalizeFromList(value, SECTORS, LEGACY_SECTOR_ALIASES);
}

function flattenCompetencesMeta(metaCompetences) {
  if (!metaCompetences || typeof metaCompetences !== 'object' || Array.isArray(metaCompetences)) {
    return [];
  }
  return Object.values(metaCompetences)
    .flat()
    .map((item) => normalizeToken(item))
    .filter(Boolean);
}

function projectSkillLabels(labels) {
  return [...new Set(
    labels
      .map((item) => resolveCanonicalSkill(item) || normalizeToken(item))
      .filter(Boolean),
  )];
}

/**
 * Lecture skills dédiées prioritaire, sinon fallback axes.meta.competences (flat).
 * Fallback : aliases → canonique Yannis quand connu (filtre recruteur).
 */
function resolveCandidateSkills(candidate = {}) {
  const dedicated = Array.isArray(candidate.skills)
    ? [...new Set(candidate.skills.map((item) => normalizeToken(item)).filter(Boolean))]
    : [];
  if (dedicated.length) return projectSkillLabels(dedicated);
  return projectSkillLabels(flattenCompetencesMeta(candidate.axes?.meta?.competences));
}

module.exports = {
  normalizeToken,
  normalizeSkill,
  CANDIDATE_SKILLS,
  OFFER_SKILLS,
  TARGET_JOB_TYPES,
  JOB_TYPE_DESCRIPTORS,
  JOB_TYPES,
  activeJobTypes,
  jobTypeById,
  isJobTypeId,
  resolveJobTypeLabel,
  resolveStoredJobType,
  jobTypeLabel,
  CONTRACT_TYPES,
  REMOTE_MODE_OPTIONS,
  SECTORS,
  CUSTOMER_TYPES,
  TOOLS,
  METHODOLOGIES,
  AVAILABILITY_OPTIONS,
  SALES_STYLE_OPTIONS,
  VARIABLE_SHARE_OPTIONS,
  VARIABLE_SHARES,
  LEGACY_SKILL_ALIASES,
  LEGACY_TOOL_ALIASES,
  LEGACY_METHODOLOGY_ALIASES,
  LEGACY_SECTOR_ALIASES,
  LEGACY_CUSTOMER_ALIASES,
  LEGACY_VARIABLE_SHARE_ALIASES,
  canonicalizeFromList,
  canonicalizeCandidateSkill,
  resolveCanonicalSkill,
  canonicalizeVariableShare,
  canonicalizeSalesStyle,
  canonicalizeCustomerType,
  canonicalizeSector,
  canonicalizeTargetJobType,
  flattenCompetencesMeta,
  resolveCandidateSkills,
};

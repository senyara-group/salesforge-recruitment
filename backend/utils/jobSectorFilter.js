/**
 * Lot 7 — métiers / secteurs : READ OLD / WRITE CLEAN.
 *
 * - Écriture : canonicalizeTargetJobType / canonicalizeSector (inchangés) ; inconnu conservé.
 * - Lecture/filtre : seuls les libellés et aliases DÉCLARÉS dans yannisTaxonomies sont
 *   équivalents. Règle de comparaison unique de la taxonomie : trim + casse
 *   (normalizeJobTypeToken). Pas d'accents repliés, pas d'ID ADN, pas de sous-chaîne,
 *   aucune proximité sémantique.
 * - Métier demandé par son libellé canonique seul → famille déclarée (libellé + aliases).
 *   Métier demandé via un alias → libellé + cet alias uniquement (jamais les aliases
 *   frères : « Sales Engineer » ne retrouve pas « Solutions Engineer »). Le parser
 *   d'offres représente une saisie d'alias par [libellé, alias] (keepAliasRaw) : même
 *   règle.
 * - Secteur : les aliases secteur sont des renommages stricts → famille complète.
 */
const {
  JOB_TYPES,
  SECTORS,
  LEGACY_SECTOR_ALIASES,
  canonicalizeTargetJobType,
  canonicalizeSector,
} = require('./yannisTaxonomies');
const { normalizeJobTypeToken } = require('./jobTaxonomy');

const key = (value) => (typeof value === 'string' ? normalizeJobTypeToken(value) : '');

const REGISTRIES = Object.freeze({
  // Familles inactives incluses : les valeurs historiques restent lisibles.
  job: JOB_TYPES.map((job) => ({ label: job.label, aliases: [...job.aliases] })),
  sector: SECTORS.map((label) => ({
    label,
    aliases: Object.keys(LEGACY_SECTOR_ALIASES)
      .filter((alias) => LEGACY_SECTOR_ALIASES[alias] === label && key(alias) !== key(label)),
  })),
});

// Chaque jeton normalisé appartient à une seule famille (jobTaxonomy le valide déjà pour
// les métiers ; même garantie ici pour les secteurs).
for (const [kind, registry] of Object.entries(REGISTRIES)) {
  const owners = new Map();
  for (const item of registry) {
    for (const token of [item.label, ...item.aliases]) {
      const owner = owners.get(key(token));
      if (owner && owner !== item.label) throw new Error(`Ambiguous ${kind} taxonomy token: ${token}`);
      owners.set(key(token), item.label);
    }
  }
}

function family(value, kind) {
  const k = key(value);
  if (!k) return null;
  return REGISTRIES[kind].find((item) => key(item.label) === k || item.aliases.some((alias) => key(alias) === k)) || null;
}

/** Jetons (textes exacts, comparés en trim + casse) retrouvés par une liste de filtre. */
function filterTokens(values, kind) {
  const tokens = [];
  const add = (token) => { if (!tokens.some((t) => key(t) === key(token))) tokens.push(token.trim()); };
  for (const value of values) {
    if (!key(value)) continue;
    const item = family(value, kind);
    if (!item) { add(value); continue; }
    const suppliedAliases = kind === 'job'
      ? values.filter((other) => family(other, kind) === item && key(other) !== key(item.label))
      : [];
    add(item.label);
    (suppliedAliases.length ? suppliedAliases : item.aliases).forEach(add);
  }
  return tokens;
}

// Littéral : métacaractères échappés ; lettres non ASCII en classe explicite ([éÉ]) car
// la casse hors ASCII de ~* dépend de la locale PostgreSQL (même choix que locationFilter).
function escapeRegex(text) {
  return [...text].map((char) => {
    if (/[\\^$.*+?()[\]{}|]/.test(char)) return `\\${char}`;
    const lower = char.toLowerCase();
    const upper = char.toUpperCase();
    if (char.charCodeAt(0) > 127 && lower !== upper && lower.length === 1 && upper.length === 1) {
      return `[${lower}${upper}]`;
    }
    return char;
  }).join('');
}

/**
 * Motif ancré pour PostgREST `imatch` (~*, insensible à la casse ASCII) : égalité exacte
 * d'un jeton, espaces de bord tolérés (= trim). Même motif en JS avec le drapeau `i`.
 */
function exactPattern(values, kind) {
  return `^\\s*(${filterTokens(values, kind).map(escapeRegex).join('|')})\\s*$`;
}

function matches(value, values, kind) {
  if (!values.length) return true;
  if (typeof value !== 'string' || !filterTokens(values, kind).length) return false;
  return new RegExp(exactPattern(values, kind), 'i').test(value);
}

function overlaps(values, selected, kind) {
  if (!selected.length) return true;
  return Array.isArray(values) && values.some((value) => matches(value, selected, kind));
}

const CANONICALIZE = Object.freeze({ job: canonicalizeTargetJobType, sector: canonicalizeSector });

/**
 * Lecture du profil : même résultat que l'écriture (parseOptionalStringList) —
 * connu → canonique, inconnu conservé tel quel (trim), doublons retirés. Rien d'autre
 * n'est supprimé : une valeur inconnue reste affichée et retirable par l'utilisateur.
 */
function canonicalList(values, kind) {
  if (!Array.isArray(values)) return [];
  const out = [];
  for (const item of values) {
    const token = String(item || '').trim();
    if (!token) continue;
    const next = CANONICALIZE[kind](token) || token;
    if (!out.includes(next)) out.push(next);
  }
  return out;
}

module.exports = { filterTokens, exactPattern, matches, overlaps, canonicalList };

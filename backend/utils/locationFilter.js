/**
 * Filtre localisation texte (Lot 2) : offres.lieu / candidats.axes.meta.ville.
 *
 * Aucune géolocalisation : pas de coordonnées fiables en base (city_code /
 * latitude / longitude existent mais ne sont alimentées par aucun écran), donc
 * pas de rayon ni de distance. Voir LOCATION.md.
 *
 * Correspondance : la saisie est découpée en mots (lettres/chiffres) ; la valeur
 * stockée doit contenir ces mots dans le même ordre, en mots entiers, séparés
 * par n'importe quels séparateurs (espace, tiret, apostrophe, parenthèse…).
 * Insensible à la casse et aux accents, SANS modifier la valeur stockée :
 * l'insensibilité est portée par le motif (classes [eéèêë…]), identique en JS
 * et en PostgreSQL (opérateur PostgREST `match`, regex POSIX ARE).
 *   "saint etienne" ⇒ "Saint-Étienne", "Saint Étienne (42)"
 *   "lyon"          ⇒ "Lyon", "Lyon 3e", "Lyon / Remote" ; PAS "Lyonnais"
 * Aucune équivalence géographique (Paris ≠ Île-de-France, Lille ≠ 59).
 */

const LOCATION_QUERY_MAX_LENGTH = 80;
const LOCATION_MAX_TOKENS = 6;
const LOCATION_DISPLAY_MAX_LENGTH = 120;

// Variantes accentuées par lettre de base (minuscules + majuscules). Le motif
// n'utilise que des classes explicites : aucun backslash, aucune dépendance à
// la locale PostgreSQL pour la casse.
const LETTER_VARIANTS = Object.freeze({
  a: 'aàâäáãåAÀÂÄÁÃÅ',
  c: 'cçCÇ',
  e: 'eéèêëEÉÈÊË',
  i: 'iîïíìIÎÏÍÌ',
  n: 'nñNÑ',
  o: 'oôöóòõOÔÖÓÒÕ',
  u: 'uùûüúUÙÛÜÚ',
  y: 'yÿýYŸÝ',
});
const EXTRA_WORD_CHARS = 'œŒæÆ';
const WORD_CHARS = 'a-zA-Z0-9' + Object.values(LETTER_VARIANTS).join('').replace(/[a-zA-Z]/g, '') + EXTRA_WORD_CHARS;
const NON_WORD = `[^${WORD_CHARS}]`;

function httpError(message, code, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

/** Espaces normalisés pour affichage ; '' pour tout ce qui n'est pas une chaîne. */
function readLocationText(value, maxLength = LOCATION_DISPLAY_MAX_LENGTH) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? text.slice(0, maxLength).trim() : text;
}

/** Repli accents/casse de la SAISIE uniquement (jamais de la donnée stockée). */
function foldLocationInput(text) {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/œ/g, 'oe')
    .replace(/æ/g, 'ae');
}

function charClass(char) {
  if (LETTER_VARIANTS[char]) return `[${LETTER_VARIANTS[char]}]`;
  if (/[a-z]/.test(char)) return `[${char}${char.toUpperCase()}]`;
  return char; // chiffre
}

function buildLocationPattern(tokens) {
  const body = tokens.map((token) => [...token].map(charClass).join('')).join(`${NON_WORD}+`);
  return `(^|${NON_WORD})${body}(${NON_WORD}|$)`;
}

/**
 * Paramètre de requête → null (pas de filtre) ou { value, tokens, pattern }.
 * Refus explicite (400 LOCATION_FILTER_INVALID) des types inattendus
 * (tableau via ?location=a&location=b, objet) et des caractères hors contrat.
 */
function parseLocationQuery(raw, { label = 'location' } = {}) {
  if (raw == null) return null;
  if (typeof raw !== 'string') {
    throw httpError(`${label} invalide`, 'LOCATION_FILTER_INVALID');
  }
  const value = raw.replace(/\s+/g, ' ').trim();
  if (!value) return null;
  if (value.length > LOCATION_QUERY_MAX_LENGTH) {
    throw httpError(`${label} trop long (${LOCATION_QUERY_MAX_LENGTH} caractères max)`, 'LOCATION_FILTER_INVALID');
  }
  const folded = foldLocationInput(value);
  if (!/^[a-z0-9 '’.\-()/]+$/.test(folded)) {
    throw httpError(`${label} invalide : lettres, chiffres, espaces, tirets et apostrophes uniquement`, 'LOCATION_FILTER_INVALID');
  }
  const tokens = folded.split(/[^a-z0-9]+/).filter(Boolean);
  if (!tokens.length || tokens.length > LOCATION_MAX_TOKENS) {
    throw httpError(`${label} invalide`, 'LOCATION_FILTER_INVALID');
  }
  return Object.freeze({ value, tokens: Object.freeze(tokens), pattern: buildLocationPattern(tokens) });
}

/** Même sémantique que le filtre SQL ; false pour toute valeur non-chaîne. */
function locationTextMatches(stored, location) {
  if (!location) return true;
  if (typeof stored !== 'string') return false;
  return new RegExp(location.pattern).test(stored);
}

module.exports = {
  LOCATION_QUERY_MAX_LENGTH,
  LOCATION_MAX_TOKENS,
  readLocationText,
  foldLocationInput,
  buildLocationPattern,
  parseLocationQuery,
  locationTextMatches,
};

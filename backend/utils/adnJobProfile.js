/**
 * ADN principal — profil métier (Lot 3, multi-postes).
 *
 * Formats de `reponses.job_profile` acceptés par POST /ai/score-adn :
 * - historique (mono-poste) : { poste, poste_label, style, reponses: { q1, q2 } }
 *   (+ `prefs.poste` : anciens boutons « Type de poste » de l'étape 9) ;
 * - multi-postes : le même objet + `postes`, tableau des IDs visés (taxonomie,
 *   métiers actifs, sans doublon, ordre canonique), qui contient `poste` = poste
 *   principal. Les boutons `prefs.poste` ne sont plus envoyés.
 *
 * Score (S3, sans refonte) : le score historique dépend de la longueur de
 * JSON.stringify(reponses). Pour qu'il ne dépende ni du nombre de postes
 * secondaires ni de la suppression des anciens boutons, il est calculé sur une
 * reconstitution au format historique mono-poste (voir buildLegacyScoringPayload).
 */
const { JOB_TYPES, jobTypeById } = require('./yannisTaxonomies');

// Anciens boutons `prefs.poste` dont le libellé était IDENTIQUE à un métier de la
// taxonomie (« SDR / BDR », « Account Executive »). Les autres boutons (Closer,
// Sales, Head of Sales, Sales Engineer) n'avaient aucun équivalent métier.
const LEGACY_PREFS_POSTE_BY_JOB = Object.freeze({ sdr: 'sdr', ae: 'ae' });

function httpError(message, code) {
  const error = new Error(message);
  error.status = 400;
  error.code = code;
  return error;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Retourne { format: 'legacy' | 'multi', primary, postes } ou lève une erreur 400.
 * Le format historique garde son contrat tolérant (valeur inconnue conservée),
 * seul un `poste` non textuel est refusé.
 */
function parseAdnJobProfile(reponses) {
  const profile = isPlainObject(reponses) && isPlainObject(reponses.job_profile) ? reponses.job_profile : null;
  if (!profile || !Object.prototype.hasOwnProperty.call(profile, 'postes')) {
    const poste = profile ? profile.poste : undefined;
    if (poste != null && typeof poste !== 'string') {
      throw httpError('job_profile.poste invalide', 'ADN_JOB_PROFILE_INVALID');
    }
    return { format: 'legacy', primary: poste || null, postes: poste ? [poste] : [] };
  }

  const { postes, poste } = profile;
  if (!Array.isArray(postes) || postes.length === 0) {
    throw httpError('Sélectionnez au moins un poste', 'ADN_JOB_PROFILE_INVALID');
  }
  const seen = new Set();
  for (const id of postes) {
    if (typeof id !== 'string') throw httpError('job_profile.postes invalide', 'ADN_JOB_PROFILE_INVALID');
    const job = jobTypeById(id);
    // Nouvelle écriture : uniquement les métiers actifs (politique taxonomie).
    if (!job || !job.active) throw httpError(`Poste inconnu : ${id.slice(0, 40)}`, 'ADN_JOB_PROFILE_INVALID');
    if (seen.has(id)) throw httpError('job_profile.postes contient un doublon', 'ADN_JOB_PROFILE_INVALID');
    seen.add(id);
  }
  if (typeof poste !== 'string' || !seen.has(poste)) {
    throw httpError('Le poste principal doit faire partie des postes sélectionnés', 'ADN_JOB_PROFILE_INVALID');
  }
  // Ordre canonique de la taxonomie, indépendamment de l'ordre reçu.
  const canonical = JOB_TYPES.filter((job) => seen.has(job.id)).map((job) => job.id);
  return { format: 'multi', primary: poste, postes: canonical };
}

/** Copie de `reponses` à stocker : `postes` en ordre canonique (format multi uniquement). */
function normalizeAdnReponses(reponses, parsed) {
  if (parsed.format !== 'multi') return reponses;
  return { ...reponses, job_profile: { ...reponses.job_profile, postes: [...parsed.postes] } };
}

/**
 * Représentation utilisée UNIQUEMENT pour la longueur du score.
 * - historique : `reponses` inchangé (score strictement identique à avant) ;
 * - multi : forme mono-poste historique équivalente —
 *   job_profile = { poste, poste_label, style, reponses } (sans `postes`) ;
 *   prefs.poste = bouton historique au libellé identique au poste principal,
 *   sinon [] (les autres anciens boutons n'avaient pas d'équivalent métier).
 * Les postes secondaires n'y figurent jamais : leur nombre ne change pas le score.
 */
function buildLegacyScoringPayload(reponses, parsed) {
  if (parsed.format !== 'multi') return reponses;
  const { poste, poste_label, style, reponses: answers } = reponses.job_profile;
  const legacyPoste = LEGACY_PREFS_POSTE_BY_JOB[parsed.primary];
  const prefs = isPlainObject(reponses.prefs) ? reponses.prefs : {};
  const { poste: _ignored, ...otherPrefs } = prefs;
  return {
    ...reponses,
    prefs: { poste: legacyPoste ? [legacyPoste] : [], ...otherPrefs },
    job_profile: { poste, poste_label, style, reponses: answers },
  };
}

module.exports = {
  LEGACY_PREFS_POSTE_BY_JOB,
  parseAdnJobProfile,
  normalizeAdnReponses,
  buildLegacyScoringPayload,
};

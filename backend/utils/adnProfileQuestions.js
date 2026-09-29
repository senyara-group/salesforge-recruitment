/**
 * ADN job-specific questions (source of the generated PROFILE_QUESTIONS block in
 * frontend/_spaces/candidat.html). Content is unchanged from the historical
 * inline object; module labels are NOT stored here: they come from JOB_TYPES.
 *
 * Structural contract, derived from the current candidat.html flow:
 * - selectJobType(id) -> bn-huntfarm -> renderProfileQuestion(1) -> bn-profileq1
 *   -> renderProfileQuestion(2) -> submitADN(): q1 AND q2 are always rendered.
 * - renderProfileQuestion reads q.text (textContent) and q.options.map(esc).
 * - selectProfileAnswer stores the option's textContent: options must be
 *   distinct non-empty strings, otherwise answers are indistinguishable.
 * - submitToAPI sends PROFILE_QUESTIONS[id].label as poste_label (string).
 */
const { JobTaxonomyError, isPlainObject, assertSafeText, normalizeJobTypeToken } = require('./jobTaxonomy');

const ADN_QUESTION_KEYS = Object.freeze(['q1', 'q2']);
const ADN_QUESTION_TEXT_MAX_LENGTH = 200;
const ADN_OPTION_MAX_LENGTH = 120;
const ADN_MIN_OPTIONS = 2;
const ADN_MAX_OPTIONS = 8;

const ADN_PROFILE_QUESTION_MODULES = deepFreeze({
  sdr: {
    q1: { text: "Combien d'appels de prospection par jour ?", options: ['Moins de 20', '20 à 50', '50 à 80', 'Plus de 80'] },
    q2: { text: 'Face à un barrage secrétaire, votre réflexe :', options: ['Je rappelle plus tard', 'Je demande le nom du décideur', "Je donne une raison précise et j'assume", "J'envoie un email à la place"] },
  },
  bizdev: {
    q1: { text: 'Montant moyen des contrats signés :', options: ['Moins de 5K€', '5 à 20K€', '20 à 50K€', 'Plus de 50K€'] },
    q2: { text: 'Vous gérez le cycle de vente :', options: ['De la prospection au closing', 'À partir du rendez-vous qualifié', 'Uniquement le closing'] },
  },
  ae: {
    q1: { text: 'Votre plus gros contrat signé :', options: ['Moins de 20K€', '20 à 50K€', '50 à 150K€', 'Plus de 150K€'] },
    q2: { text: 'Comment gérez-vous un deal qui stagne depuis 3 semaines ?', options: ["J'attends que le client revienne", 'Je relance avec du contenu à valeur', "J'envoie un mail de rupture", 'Je remonte au niveau supérieur'] },
  },
  terrain: {
    q1: { text: 'Combien de visites clients par semaine ?', options: ['Moins de 5', '5 à 15', '15 à 25', 'Plus de 25'] },
    q2: { text: 'Votre secteur géographique idéal :', options: ['Local (moins de 50 km)', 'Régional', 'National avec découchés'] },
  },
  kam: {
    q1: { text: 'Combien de comptes gérez-vous simultanément ?', options: ['Moins de 5', '5 à 15', '15 à 30', 'Plus de 30'] },
    q2: { text: 'Face à un client mécontent qui menace de partir :', options: ['Je fais un geste commercial', "Je comprends d'abord le problème de fond", 'Je remonte à ma direction'] },
  },
  manager: {
    q1: { text: 'Combien de commerciaux avez-vous encadrés ?', options: ['Aucun encore', '1 à 3', '4 à 10', 'Plus de 10'] },
    q2: { text: 'Face à un commercial en sous-performance :', options: ['Je fixe un plan de redressement chiffré', 'Je fais du terrain avec lui', "Je cherche à comprendre ce qui bloque avant d'agir"] },
  },
  // Lot 4 — familles ajoutées (liste Yannis). Une question de volume/périmètre, une situation.
  sedentaire: {
    q1: { text: 'Combien de conversations commerciales à distance (téléphone, visio) menez-vous par jour ?', options: ['Moins de 15', '15 à 30', '30 à 60', 'Plus de 60'] },
    q2: { text: "En fin d'appel, le client hésite à signer :", options: ['Je le rappelle la semaine prochaine', 'Je reformule son besoin et adapte mon offre', "Je conclus avec une offre valable aujourd'hui", "Je lui envoie une documentation par e-mail"] },
  },
  technico_commercial: {
    q1: { text: "Quelle part de votre temps consacrez-vous à l'étude technique des besoins (cahier des charges, dimensionnement, chiffrage) ?", options: ['Moins de 20 %', '20 à 40 %', '40 à 60 %', 'Plus de 60 %'] },
    q2: { text: 'Le client exige une caractéristique que votre produit ne couvre pas :', options: ["J'étudie une adaptation avec le bureau d'études", 'Je recentre sur les points où le produit est supérieur', 'Je le dis franchement et propose une alternative', "J'accepte et je verrai avec la production ensuite"] },
  },
  charge_affaires: {
    q1: { text: "Montant moyen des affaires que vous pilotez, de l'offre à la livraison :", options: ['Moins de 50K€', '50 à 200K€', '200K€ à 1M€', 'Plus de 1M€'] },
    q2: { text: 'En cours de projet, une dérive des coûts menace votre marge :', options: ["J'absorbe l'écart pour préserver la relation", 'Je négocie un avenant chiffré avec le client', "J'arbitre avec l'équipe projet pour rattraper la marge", 'Je remonte à ma direction pour décision'] },
  },
  avant_vente: {
    q1: { text: 'Combien de démonstrations ou ateliers techniques animez-vous par mois ?', options: ['Moins de 5', '5 à 15', '15 à 30', 'Plus de 30'] },
    q2: { text: 'En démonstration, le prospect pointe une fonctionnalité manquante qu’il juge critique :', options: ["Je promets qu'elle arrive bientôt", 'Je creuse le besoin réel derrière la demande', 'Je montre un contournement crédible', 'Je le note et laisse le commercial gérer'] },
  },
  account_manager: {
    q1: { text: 'Combien de clients compte votre portefeuille ?', options: ['Moins de 20', '20 à 50', '50 à 150', 'Plus de 150'] },
    q2: { text: 'Quelle part de votre chiffre vient des ventes additionnelles (upsell, cross-sell) ?', options: ['Moins de 20 %', '20 à 40 %', '40 à 60 %', 'Plus de 60 %'] },
  },
  customer_success: {
    q1: { text: 'Sur quel indicateur êtes-vous principalement évalué ?', options: ['Rétention / churn', 'Adoption du produit', 'Expansion du portefeuille', 'Satisfaction client (NPS, CSAT)'] },
    q2: { text: 'Un client clé utilise peu le produit trois mois avant son renouvellement :', options: ['J’attends la date de renouvellement pour en parler', 'Je lance un plan d’adoption avec ses équipes', 'Je propose une remise pour sécuriser le renouvellement', 'Je remonte l’alerte au commercial du compte'] },
  },
  partenariats: {
    q1: { text: 'Quelle part de vos revenus passe par des partenaires ou distributeurs ?', options: ['Moins de 25 %', '25 à 50 %', '50 à 75 %', 'Plus de 75 %'] },
    q2: { text: 'Un partenaire signé génère très peu de ventes :', options: ['Je le laisse avancer à son rythme', "Je co-construis un plan d'affaires avec objectifs", "Je forme et j'accompagne ses équipes commerciales", 'Je réduis ses avantages au profit des partenaires actifs'] },
  },
  conseiller_vente: {
    q1: { text: 'Combien de clients conseillez-vous en moyenne par jour ?', options: ['Moins de 10', '10 à 30', '30 à 60', 'Plus de 60'] },
    q2: { text: 'Un client hésite longuement entre deux produits :', options: ['Je le laisse réfléchir tranquillement', 'Je le questionne sur son usage pour l’aider à trancher', 'Je mets en avant le produit le plus cher', "Je lui propose un avantage s'il achète aujourd'hui"] },
  },
  direction_commerciale: {
    q1: { text: 'Quel chiffre d’affaires annuel pilotez-vous ?', options: ['Moins de 5M€', '5 à 20M€', '20 à 100M€', 'Plus de 100M€'] },
    q2: { text: 'À mi-année, vos résultats sont en retard de 15 % sur l’objectif :', options: ['Je renforce le suivi individuel des commerciaux', 'Je revois le mix cibles, canaux et offres', 'Je recrute pour augmenter la capacité', "J'ajuste les objectifs avec la direction générale"] },
  },
});

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function validateQuestion(question, where) {
  if (!isPlainObject(question)) throw new JobTaxonomyError(`${where}: question is missing or not an object`);
  for (const key of Object.keys(question)) {
    if (key !== 'text' && key !== 'options') throw new JobTaxonomyError(`${where}: unknown key "${key}"`);
  }
  assertSafeText(question.text, `${where}.text`, ADN_QUESTION_TEXT_MAX_LENGTH);
  const { options } = question;
  if (!Array.isArray(options)) throw new JobTaxonomyError(`${where}.options: must be an array`);
  // A hole would be skipped by options.map() in renderProfileQuestion: refuse it explicitly.
  for (let i = 0; i < options.length; i += 1) {
    if (!Object.prototype.hasOwnProperty.call(options, i)) throw new JobTaxonomyError(`${where}.options[${i}]: sparse array (hole) is not allowed`);
  }
  if (options.length < ADN_MIN_OPTIONS || options.length > ADN_MAX_OPTIONS) {
    throw new JobTaxonomyError(`${where}.options: expected ${ADN_MIN_OPTIONS}-${ADN_MAX_OPTIONS} options, got ${options.length}`);
  }
  const seen = new Set();
  options.forEach((option, i) => {
    assertSafeText(option, `${where}.options[${i}]`, ADN_OPTION_MAX_LENGTH);
    const token = normalizeJobTypeToken(option);
    if (seen.has(token)) throw new JobTaxonomyError(`${where}.options[${i}]: duplicate option "${option}"`);
    seen.add(token);
  });
}

/**
 * Every active job is an ADN choice (a generated selectJobType button), so each
 * one requires a complete module. Modules for unknown IDs are rejected (typos);
 * modules of inactive jobs are validated but not generated.
 */
function validateAdnModules(jobTypes, modules) {
  if (!isPlainObject(modules)) throw new JobTaxonomyError('ADN modules must be a plain object keyed by job id');
  const ids = new Set(jobTypes.map(job => job.id));
  for (const id of Object.keys(modules)) {
    if (!ids.has(id)) throw new JobTaxonomyError(`ADN module "${id}" does not match any JOB_TYPES id`);
  }
  for (const job of jobTypes) {
    const module = Object.prototype.hasOwnProperty.call(modules, job.id) ? modules[job.id] : undefined;
    const where = `ADN module "${job.id}"`;
    if (module === undefined) {
      if (job.active) throw new JobTaxonomyError(`${where} is missing: every active job needs q1 and q2 in utils/adnProfileQuestions.js`);
      continue;
    }
    if (!isPlainObject(module)) throw new JobTaxonomyError(`${where}: must be a plain object`);
    for (const key of ADN_QUESTION_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(module, key)) throw new JobTaxonomyError(`${where}: ${key} is missing (renderProfileQuestion always renders q1 and q2)`);
    }
    for (const key of Object.keys(module)) {
      if (key === 'label') throw new JobTaxonomyError(`${where}: label must not be set here, it is generated from JOB_TYPES`);
      if (!ADN_QUESTION_KEYS.includes(key)) throw new JobTaxonomyError(`${where}: unknown key "${key}"`);
    }
    for (const key of ADN_QUESTION_KEYS) validateQuestion(module[key], `${where}.${key}`);
  }
}

module.exports = {
  ADN_PROFILE_QUESTION_MODULES,
  ADN_QUESTION_KEYS,
  validateAdnModules,
};

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

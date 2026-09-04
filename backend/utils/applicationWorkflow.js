const STATUS_LABELS = {
  envoyee: 'Candidature envoyée', nouveau: 'À examiner', vu: 'Profil consulté',
  contacte: 'Contacté', repondu: 'Réponse reçue', entretien: 'Entretien',
  offre: 'Proposition envoyée', embauche: 'Recruté', refusee: 'Non retenu', retiree: 'Retirée',
};

const TRANSITIONS = {
  envoyee: new Set(['vu', 'contacte', 'refusee']),
  nouveau: new Set(['vu', 'contacte', 'refusee']),
  vu: new Set(['contacte', 'refusee']),
  contacte: new Set(['repondu', 'entretien', 'refusee']),
  repondu: new Set(['entretien', 'refusee']),
  entretien: new Set(['offre', 'refusee']),
  offre: new Set(['embauche', 'refusee']),
  embauche: new Set([]), refusee: new Set([]), retiree: new Set([]),
};

function assertTransition(from, to) {
  if (!STATUS_LABELS[to] || !TRANSITIONS[from]?.has(to)) {
    const error = new Error(`Transition de ${STATUS_LABELS[from] || from} vers ${STATUS_LABELS[to] || to} impossible`);
    error.status = 409;
    error.code = 'INVALID_APPLICATION_TRANSITION';
    throw error;
  }
}

function canWithdraw(status) {
  return ['envoyee', 'nouveau', 'vu'].includes(String(status || 'envoyee'));
}

function buildCandidateSnapshot(candidate = {}, meta = {}) {
  return {
    submitted_at: new Date().toISOString(),
    profile: {
      prenom: candidate.prenom || '', nom: candidate.nom || '', titre: candidate.titre || '',
      score_adn: candidate.score_adn || null, axes: candidate.axes?.resultat || null,
      competences: candidate.axes?.meta?.competences || {}, ville: candidate.axes?.meta?.ville || '',
    },
    cv: meta.cv_snapshot_path ? {
      bucket: meta.cv_bucket || 'candidate-cvs', path: meta.cv_snapshot_path,
      file_name: meta.cv_file_name || 'CV',
    } : null,
  };
}

module.exports = { STATUS_LABELS, TRANSITIONS, assertTransition, canWithdraw, buildCandidateSnapshot };
